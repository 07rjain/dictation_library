import { DictationError } from "../errors.js";
import { DEFAULT_LONG_CHUNK_MAX_BYTES } from "../defaults.js";
import type { GroqClient } from "../groq-client.js";
import type {
  CleanupResult,
  ContextProvider,
  DictationContext,
  TranscriptionOptions,
} from "../types.js";
import { MemoryJobStore } from "./store.js";
import { stitchChunks } from "./stitcher.js";
import type {
  AudioChunk,
  AudioProcessor,
  JobStore,
  LongChunkRecord,
  LongChunkResult,
  LongDictationJob,
  LongDictationOptions,
  LongDictationResult,
  LongJobEvent,
  LongJobManifest,
} from "./types.js";
import { WavAudioProcessor } from "./wav-processor.js";

const DEFAULT_INTERACTIVE_CHUNK_MS = 60_000;
const DEFAULT_OFFLINE_CHUNK_MS = 10 * 60_000;
const DEFAULT_INTERACTIVE_OVERLAP_MS = 2_000;
const DEFAULT_OFFLINE_OVERLAP_MS = 10_000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_CLEANUP_WINDOW_CHARS = 12_000;
const DEFAULT_AMBIGUITY_LOGPROB = -0.8;
const DEFAULT_PROMPT_TAIL_CHARS = 700;

export class LongJob implements LongDictationJob {
  readonly id: string;
  private readonly processor: AudioProcessor;
  private readonly store: JobStore;
  private readonly controller = new AbortController();
  private readonly stream = new JobEventStream();
  private readonly contextStartedAt = performance.now();
  private readonly contextPromise: Promise<DictationContext>;
  private execution: Promise<LongDictationResult> | undefined;
  private manifest: LongJobManifest | undefined;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly groq: GroqClient,
    private readonly audio: { data: Blob; filename?: string; durationMs?: number },
    private readonly options: LongDictationOptions,
    defaultStore?: JobStore,
  ) {
    this.id = options.jobId ?? createJobId();
    this.processor = options.processor ?? new WavAudioProcessor();
    this.store = options.store ?? defaultStore ?? new MemoryJobStore();
    this.contextPromise = resolveContext(options.context);
    options.signal?.addEventListener("abort", () => this.abort(options.signal?.reason), { once: true });
  }

  result(): Promise<LongDictationResult> {
    return this.ensureStarted();
  }

  events(): AsyncIterable<LongJobEvent> {
    void this.ensureStarted().catch(() => undefined);
    return this.stream;
  }

  async inspect(): Promise<LongJobManifest> {
    const manifest = this.manifest ?? await this.store.load(this.id);
    if (!manifest) {
      throw new DictationError(`Long dictation job ${this.id} was not found.`, { code: "JOB_NOT_FOUND" });
    }
    return structuredClone(manifest);
  }

  abort(reason: unknown = new Error("Job aborted")): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  private ensureStarted(): Promise<LongDictationResult> {
    this.execution ??= this.execute();
    return this.execution;
  }

  private async execute(): Promise<LongDictationResult> {
    const totalStartedAt = performance.now();
    try {
      const existing = await this.store.load(this.id);
      if (existing?.status === "completed" && existing.result) {
        assertSourceMatches(existing, await this.processor.inspect(this.audio));
        this.manifest = existing;
        this.stream.emit({ type: "job.completed", jobId: this.id, result: existing.result });
        this.stream.close();
        return existing.result;
      }

      const chunks = await this.prepareChunks();
      this.manifest = existing
        ? validateAndResumeManifest(existing, chunks, await this.processor.inspect(this.audio))
        : await this.createManifest(chunks);
      this.manifest.status = "processing";
      await this.persist();

      const alreadyCompleted = this.manifest.chunks.filter((chunk) => chunk.status === "completed").length;
      if (existing) {
        this.stream.emit({ type: "job.resumed", jobId: this.id, completedChunks: alreadyCompleted });
      } else {
        this.stream.emit({ type: "job.started", jobId: this.id, chunkCount: chunks.length });
      }

      const transcriptionStartedAt = performance.now();
      const requestedConcurrency = clampConcurrency(this.options.concurrency ?? DEFAULT_CONCURRENCY);
      const concurrency = this.options.accuracyMode === "sequential" ? 1 : requestedConcurrency;
      const pacer = new RequestPacer(this.options.requestsPerMinute);
      await runBounded(chunks, concurrency, async (chunk) => {
        const record = this.manifest!.chunks[chunk.index];
        if (!record || record.status === "completed") return;
        if (this.controller.signal.aborted) throw this.controller.signal.reason;
        record.status = "processing";
        record.attempts += 1;
        delete record.error;
        await this.persist();
        this.stream.emit({ type: "chunk.started", jobId: this.id, index: chunk.index, attempt: record.attempts });
        const startedAt = performance.now();
        try {
          await pacer.wait(this.controller.signal);
          const previous = this.manifest!.chunks[chunk.index - 1]?.result?.text;
          record.result = await this.groq.transcribe(
            chunk.audio,
            this.transcriptionOptions(this.options.accuracyMode === "sequential" ? previous : undefined),
          );
          record.durationMs = performance.now() - startedAt;
          record.status = "completed";
          await this.persist();
          this.stream.emit({
            type: "chunk.completed",
            jobId: this.id,
            index: chunk.index,
            durationMs: record.durationMs,
            text: record.result.text,
          });
        } catch (error) {
          record.status = "failed";
          record.durationMs = performance.now() - startedAt;
          record.error = serializeError(error);
          await this.persist();
          this.stream.emit({ type: "chunk.failed", jobId: this.id, index: chunk.index, error: record.error.message });
          if (this.options.continueOnError === false) throw error;
        } finally {
          this.emitProgress();
        }
      });
      if (this.options.accuracyMode === "retry-ambiguous" || this.options.accuracyMode === undefined) {
        await this.retryAmbiguousBoundaries(chunks);
      }
      const transcriptionMs = performance.now() - transcriptionStartedAt;

      const failed = this.manifest.chunks.filter((chunk) => chunk.status !== "completed");
      if (failed.length > 0) {
        this.manifest.status = this.manifest.chunks.some((chunk) => chunk.status === "completed") ? "partial" : "failed";
        await this.persist();
        const completed = toChunkResults(this.manifest.chunks.filter((chunk) => chunk.status === "completed"));
        throw new DictationError(`${failed.length} audio chunk${failed.length === 1 ? "" : "s"} failed. Resume the job to retry only failed chunks.`, {
          code: "CHUNK_TRANSCRIPTION_FAILED",
          details: {
            jobId: this.id,
            failed: failed.map((chunk) => chunk.index),
            completedChunks: completed,
            partialTranscript: stitchChunks(completed),
          },
        });
      }

      this.stream.emit({ type: "stitching.started", jobId: this.id });
      const chunkResults = toChunkResults(this.manifest.chunks);
      const rawTranscript = stitchChunks(chunkResults);
      const context = await this.contextPromise;
      const contextMs = performance.now() - this.contextStartedAt;
      const cleanupStartedAt = performance.now();
      const cleanup = await this.cleanup(rawTranscript, context);
      const cleanupMs = performance.now() - cleanupStartedAt;
      const result: LongDictationResult = {
        jobId: this.id,
        text: cleanup.text,
        rawTranscript,
        transcriptionModel: chunkResults[0]?.model ?? this.groq.transcriptionModel,
        ...(cleanup.model !== "none" ? { cleanupModel: cleanup.model } : {}),
        cleanupRejected: cleanup.rejected,
        usedCleanupFallback: cleanup.usedFallback,
        filteredAsSilence: this.manifest.chunks.every((chunk) => chunk.result?.filteredAsSilence),
        context,
        timings: {
          contextMs,
          transcriptionMs,
          cleanupMs,
          totalMs: performance.now() - totalStartedAt,
        },
        chunks: chunkResults,
        source: this.manifest.source,
      };
      this.manifest.status = "completed";
      this.manifest.result = result;
      await this.persist();
      this.stream.emit({ type: "job.completed", jobId: this.id, result });
      this.stream.close();
      return result;
    } catch (error) {
      if (this.manifest && this.manifest.status !== "partial") {
        this.manifest.status = this.controller.signal.aborted ? "aborted" : "failed";
        await this.persist().catch(() => undefined);
      }
      const normalized = normalizeJobError(error, this.id, this.controller.signal.aborted);
      this.stream.emit({ type: "job.failed", jobId: this.id, error: normalized.message });
      this.stream.close();
      throw normalized;
    }
  }

  private async prepareChunks(): Promise<readonly AudioChunk[]> {
    const mode = this.options.mode ?? "interactive";
    return this.processor.segment(this.audio, {
      targetChunkMs: this.options.targetChunkMs ?? (
        mode === "interactive" ? DEFAULT_INTERACTIVE_CHUNK_MS : DEFAULT_OFFLINE_CHUNK_MS
      ),
      overlapMs: this.options.overlapMs ?? (
        mode === "interactive" ? DEFAULT_INTERACTIVE_OVERLAP_MS : DEFAULT_OFFLINE_OVERLAP_MS
      ),
      maxChunkBytes: this.options.maxChunkBytes ?? DEFAULT_LONG_CHUNK_MAX_BYTES,
      signal: this.controller.signal,
    });
  }

  private async createManifest(chunks: readonly AudioChunk[]): Promise<LongJobManifest> {
    const source = await this.processor.inspect(this.audio);
    const now = new Date().toISOString();
    return {
      version: 1,
      jobId: this.id,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      mode: this.options.mode ?? "interactive",
      source,
      processor: this.processor.name,
      targetChunkMs: this.options.targetChunkMs ?? (
        this.options.mode === "offline" ? DEFAULT_OFFLINE_CHUNK_MS : DEFAULT_INTERACTIVE_CHUNK_MS
      ),
      overlapMs: this.options.overlapMs ?? (
        this.options.mode === "offline" ? DEFAULT_OFFLINE_OVERLAP_MS : DEFAULT_INTERACTIVE_OVERLAP_MS
      ),
      concurrency: clampConcurrency(this.options.concurrency ?? DEFAULT_CONCURRENCY),
      chunks: chunks.map((chunk) => ({
        index: chunk.index,
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        overlapBeforeMs: chunk.overlapBeforeMs,
        status: "pending",
        attempts: 0,
      })),
    };
  }

  private transcriptionOptions(priorText?: string): TranscriptionOptions {
    const prompt = buildContextPrompt(
      this.options.prompt ?? this.options.transcription?.prompt,
      priorText,
      this.options.promptTailChars ?? DEFAULT_PROMPT_TAIL_CHARS,
    );
    return {
      ...this.options.transcription,
      responseFormat: "verbose_json",
      ...(this.options.transcriptionModel !== undefined ? { model: this.options.transcriptionModel } : {}),
      ...(this.options.language !== undefined ? { language: this.options.language } : {}),
      ...(prompt ? { prompt } : {}),
      signal: this.controller.signal,
    };
  }

  private async retryAmbiguousBoundaries(chunks: readonly AudioChunk[]): Promise<void> {
    for (let index = 1; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const record = this.manifest!.chunks[index];
      if (!chunk || !record?.result || !isAmbiguous(record.result, this.options.ambiguityLogProbabilityThreshold)) {
        continue;
      }
      const previous = this.manifest!.chunks[index - 1]?.result?.text;
      if (!previous) continue;
      this.stream.emit({ type: "chunk.retrying", jobId: this.id, index, reason: "low boundary confidence" });
      record.attempts += 1;
      const original = record.result;
      try {
        const candidate = await this.groq.transcribe(chunk.audio, this.transcriptionOptions(previous));
        record.alternatives ??= [];
        record.alternatives.push(original, candidate);
        if (transcriptionQuality(candidate) > transcriptionQuality(original)) record.result = candidate;
        await this.persist();
      } catch {
        // The independent successful result remains canonical when an optional accuracy retry fails.
      }
    }
  }

  private async cleanup(transcript: string, context: DictationContext): Promise<CleanupOutcome> {
    const mode = this.options.cleanup?.mode ?? "none";
    if (!transcript || mode === "none") {
      return { text: transcript, model: "none", usedFallback: false, rejected: false };
    }
    this.stream.emit({ type: "cleanup.started", jobId: this.id });
    const windows = splitCleanupWindows(transcript, DEFAULT_CLEANUP_WINDOW_CHARS);
    const outputs: string[] = [];
    let model = "none";
    let usedFallback = false;
    let rejected = false;
    for (const window of windows) {
      const result = await this.groq.cleanup(window, {
        ...this.options.cleanup,
        mode,
        context,
        ...(this.options.cleanupModel !== undefined ? { model: this.options.cleanupModel } : {}),
        ...(this.options.fallbackModel !== undefined ? { fallbackModel: this.options.fallbackModel } : {}),
        ...(this.options.vocabulary !== undefined ? { vocabulary: this.options.vocabulary } : {}),
        ...(this.options.outputLanguage !== undefined ? { outputLanguage: this.options.outputLanguage } : {}),
        ...(this.options.preserveExactWording !== undefined
          ? { preserveExactWording: this.options.preserveExactWording }
          : {}),
        signal: this.controller.signal,
      });
      outputs.push(result.text);
      model = result.model;
      usedFallback ||= result.usedFallback;
      rejected ||= Boolean(result.rejected);
    }
    return { text: outputs.join("\n\n").trim(), model, usedFallback, rejected };
  }

  private emitProgress(): void {
    const chunks = this.manifest!.chunks;
    this.stream.emit({
      type: "job.progress",
      jobId: this.id,
      completed: chunks.filter((chunk) => chunk.status === "completed").length,
      failed: chunks.filter((chunk) => chunk.status === "failed").length,
      total: chunks.length,
    });
  }

  private persist(): Promise<void> {
    const manifest = this.manifest!;
    manifest.updatedAt = new Date().toISOString();
    this.saveChain = this.saveChain.then(() => this.store.save(manifest));
    return this.saveChain;
  }
}

interface CleanupOutcome extends CleanupResult {
  rejected: boolean;
}

function validateAndResumeManifest(
  manifest: LongJobManifest,
  chunks: readonly AudioChunk[],
  source: { sizeBytes: number; fingerprint?: string },
): LongJobManifest {
  assertSourceMatches(manifest, source);
  const layoutMismatch = manifest.chunks.some((record, index) => {
    const chunk = chunks[index];
    return !chunk || record.startMs !== chunk.startMs || record.endMs !== chunk.endMs ||
      record.overlapBeforeMs !== chunk.overlapBeforeMs;
  });
  if (
    manifest.chunks.length !== chunks.length || layoutMismatch
  ) {
    throw new DictationError("Resume input does not match the original job source.", {
      code: "JOB_SOURCE_MISMATCH",
      details: { jobId: manifest.jobId },
    });
  }
  for (const chunk of manifest.chunks) {
    if (chunk.status === "processing" || chunk.status === "failed") chunk.status = "pending";
  }
  return manifest;
}

function assertSourceMatches(
  manifest: LongJobManifest,
  source: { sizeBytes: number; fingerprint?: string },
): void {
  const fingerprintMismatch = manifest.source.fingerprint !== undefined &&
    source.fingerprint !== undefined && manifest.source.fingerprint !== source.fingerprint;
  if (manifest.source.sizeBytes !== source.sizeBytes || fingerprintMismatch) {
    throw new DictationError("Resume input does not match the original job source.", {
      code: "JOB_SOURCE_MISMATCH",
      details: { jobId: manifest.jobId },
    });
  }
}

function toChunkResults(records: readonly LongChunkRecord[]): LongChunkResult[] {
  return records.map((record) => ({
    index: record.index,
    startMs: record.startMs,
    endMs: record.endMs,
    overlapBeforeMs: record.overlapBeforeMs,
    text: record.result!.text,
    segments: record.result!.segments.map((segment) => ({
      ...segment,
      ...(segment.start !== undefined ? { start: segment.start + record.startMs / 1000 } : {}),
      ...(segment.end !== undefined ? { end: segment.end + record.startMs / 1000 } : {}),
    })),
    model: record.result!.model,
    durationMs: record.durationMs ?? 0,
  }));
}

async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      if (item !== undefined) await work(item);
    }
  });
  await Promise.all(workers);
}

function clampConcurrency(value: number): number {
  return Math.max(1, Math.min(8, Math.floor(value)));
}

function serializeError(error: unknown): { code: string; message: string; status?: number } {
  if (error instanceof DictationError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.status !== undefined ? { status: error.status } : {}),
    };
  }
  return { code: "UNKNOWN", message: error instanceof Error ? error.message : String(error) };
}

function normalizeJobError(error: unknown, jobId: string, aborted: boolean): DictationError {
  if (error instanceof DictationError) return error;
  return new DictationError(aborted ? "Long dictation job was aborted." : "Long dictation job failed.", {
    code: aborted ? "JOB_ABORTED" : "JOB_FAILED",
    details: { jobId },
    cause: error,
  });
}

async function resolveContext(
  source?: DictationContext | ContextProvider | Promise<DictationContext>,
): Promise<DictationContext> {
  if (!source) return {};
  return typeof source === "function" ? source() : source;
}

function createJobId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `dictation_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function splitCleanupWindows(text: string, maximumChars: number): string[] {
  if (text.length <= maximumChars) return [text];
  const windows: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maximumChars) {
    const candidate = remaining.slice(0, maximumChars);
    const sentence = Math.max(candidate.lastIndexOf(". "), candidate.lastIndexOf("? "), candidate.lastIndexOf("! "));
    const whitespace = candidate.lastIndexOf(" ");
    const split = sentence > maximumChars * 0.6 ? sentence + 1 : Math.max(1, whitespace);
    windows.push(remaining.slice(0, split).trim());
    remaining = remaining.slice(split).trim();
  }
  if (remaining) windows.push(remaining);
  return windows;
}

function isAmbiguous(result: { segments: readonly { avg_logprob?: number }[] }, threshold = DEFAULT_AMBIGUITY_LOGPROB): boolean {
  const boundary = result.segments.slice(0, 1).concat(result.segments.slice(-1));
  const scores = boundary.flatMap((segment) => segment.avg_logprob === undefined ? [] : [segment.avg_logprob]);
  return scores.length > 0 && Math.min(...scores) < threshold;
}

function transcriptionQuality(result: { segments: readonly { avg_logprob?: number }[] }): number {
  const scores = result.segments.flatMap((segment) => segment.avg_logprob === undefined ? [] : [segment.avg_logprob]);
  return scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : Number.NEGATIVE_INFINITY;
}

function buildContextPrompt(base: string | undefined, priorText: string | undefined, maximumTailChars: number): string | undefined {
  const parts = [base?.trim(), priorText?.trim().slice(-Math.max(0, maximumTailChars))].filter(Boolean);
  return parts.length ? parts.join("\n") : undefined;
}

class JobEventStream implements AsyncIterable<LongJobEvent> {
  private readonly history: LongJobEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private closed = false;

  emit(event: LongJobEvent): void {
    this.history.push(event);
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  close(): void {
    this.closed = true;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<LongJobEvent> {
    let cursor = 0;
    while (true) {
      while (cursor < this.history.length) {
        yield this.history[cursor++]!;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }
}

class RequestPacer {
  private nextStartAt = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly requestsPerMinute: number | false | undefined) {}

  wait(signal: AbortSignal): Promise<void> {
    if (this.requestsPerMinute === false || this.requestsPerMinute === undefined) return Promise.resolve();
    const intervalMs = 60_000 / Math.max(1, this.requestsPerMinute);
    const scheduled = this.chain.then(async () => {
      const delayMs = Math.max(0, this.nextStartAt - performance.now());
      if (delayMs > 0) await abortableDelay(delayMs, signal);
      this.nextStartAt = performance.now() + intervalMs;
    });
    this.chain = scheduled.catch(() => undefined);
    return scheduled;
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
