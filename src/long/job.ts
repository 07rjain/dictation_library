import { DictationError } from "../errors.js";
import { DEFAULT_LONG_CHUNK_MAX_BYTES } from "../defaults.js";
import { fullAudioFingerprint, legacyAudioFingerprint } from "../audio.js";
import type { GroqClient } from "../groq-client.js";
import type {
  AudioMetadata,
  CleanupResult,
  CleanupWindowResult,
  ContextProvider,
  DictationContext,
  ProviderAttemptEvent,
  RateLimitSnapshot,
  TranscriptionOptions,
} from "../types.js";
import { MemoryJobStore } from "./store.js";
import { stitchChunks, stitchChunksDetailed } from "./stitcher.js";
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
  LongJobEventPayload,
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
const DEFAULT_LEASE_TTL_MS = 30_000;

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
  private inspectedMetadata: Promise<AudioMetadata> | undefined;
  private readonly leaseOwner = globalThis.crypto?.randomUUID?.() ?? `worker_${Math.random().toString(36).slice(2)}`;
  private leaseTimer: ReturnType<typeof setInterval> | undefined;
  private renewingLease = false;

  constructor(
    private readonly groq: GroqClient,
    private readonly audio: { data: Blob; filename?: string; durationMs?: number },
    private readonly options: LongDictationOptions,
    defaultStore?: JobStore,
    sourceMetadata?: AudioMetadata,
  ) {
    this.id = options.jobId ?? createJobId();
    this.processor = options.processor ?? new WavAudioProcessor();
    this.store = options.store ?? defaultStore ?? new MemoryJobStore();
    if (sourceMetadata) this.inspectedMetadata = this.addDurableSourceIdentity(sourceMetadata);
    this.contextPromise = resolveContext(options.context);
    options.signal?.addEventListener("abort", () => this.abort(options.signal?.reason), { once: true });
  }

  result(): Promise<LongDictationResult> {
    return this.ensureStarted();
  }

  events(afterCursor = 0): AsyncIterable<LongJobEvent> {
    void this.ensureStarted().catch(() => undefined);
    return this.stream.after(afterCursor);
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
      await this.startLease();
      const existing = await this.store.load(this.id);
      this.stream.seed(existing?.events ?? []);
      const source = await this.inspectSource();
      const configurationKey = await this.createConfigurationKey(source);
      if (existing?.status === "completed" && existing.result) {
        assertSourceMatches(existing, source);
        assertConfigurationMatches(existing, configurationKey, this.options.migrateLegacyManifest);
        existing.source = source;
        existing.configurationKey = configurationKey;
        existing.result = normalizeCachedResult(existing.result, source);
        this.manifest = existing;
        await this.persist();
        this.emit({ type: "job.completed", jobId: this.id, result: existing.result });
        await this.persist();
        this.stream.close();
        return existing.result;
      }

      const chunks = await this.prepareChunks();
      const requestKeys = await this.createRequestKeys(chunks, configurationKey);
      this.manifest = existing
        ? validateAndResumeManifest(
          existing,
          chunks,
          source,
          requestKeys,
          configurationKey,
          this.options.migrateLegacyManifest,
        )
        : await this.createManifest(chunks, requestKeys, configurationKey);
      this.manifest.status = "processing";

      const alreadyCompleted = this.manifest.chunks.filter((chunk) => chunk.status === "completed").length;
      if (existing) {
        this.emit({ type: "job.resumed", jobId: this.id, completedChunks: alreadyCompleted });
      } else {
        this.emit({ type: "job.started", jobId: this.id, chunkCount: chunks.length });
      }
      await this.persist();

      const transcriptionStartedAt = performance.now();
      const requestedConcurrency = clampConcurrency(this.options.concurrency ?? DEFAULT_CONCURRENCY);
      const concurrency = this.options.accuracyMode === "sequential" ? 1 : requestedConcurrency;
      const pacer = new RequestPacer(this.options.requestsPerMinute);
      const pool = new AdaptiveWorkPool(concurrency, (from, to) => {
        this.emit({
          type: "concurrency.reduced",
          jobId: this.id,
          from,
          to,
          reason: "provider rate limit",
        });
      }, (from, to) => {
        this.emit({
          type: "concurrency.increased",
          jobId: this.id,
          from,
          to,
          reason: "sustained provider success",
        });
      });
      const poolController = new AbortController();
      const poolSignal = combineAbortSignals(this.controller.signal, poolController.signal);
      await pool.run(chunks, async (chunk) => {
        const record = this.manifest!.chunks[chunk.index];
        if (!record || record.status === "completed") return;
        if (poolSignal.aborted) throw poolSignal.reason;
        record.status = "processing";
        record.attempts += 1;
        delete record.error;
        await this.persist();
        this.emit({ type: "chunk.started", jobId: this.id, index: chunk.index, attempt: record.attempts });
        await this.persist();
        const startedAt = performance.now();
        try {
          await pacer.wait(poolSignal);
          const previous = this.manifest!.chunks[chunk.index - 1]?.result?.text;
          record.result = await this.groq.transcribe(
            chunk.audio,
            this.transcriptionOptions(
              this.options.accuracyMode === "sequential" ? previous : undefined,
              (event) => this.observeProviderAttempt(record, event, pool, pacer),
              poolSignal,
            ),
          );
          record.durationMs = performance.now() - startedAt;
          record.status = "completed";
          this.emit({
            type: "chunk.completed",
            jobId: this.id,
            index: chunk.index,
            durationMs: record.durationMs,
            text: record.result.text,
          });
          await this.persist();
        } catch (error) {
          record.status = "failed";
          record.durationMs = performance.now() - startedAt;
          record.error = serializeError(error);
          this.emit({ type: "chunk.failed", jobId: this.id, index: chunk.index, error: record.error.message });
          await this.persist();
          if (this.options.continueOnError === false) throw error;
        } finally {
          this.emitProgress();
        }
      }, (error) => poolController.abort(error));
      if (this.options.accuracyMode === "retry-ambiguous" || this.options.accuracyMode === undefined) {
        await this.retryAmbiguousBoundaries(chunks);
      }
      const transcriptionMs = performance.now() - transcriptionStartedAt;

      const failed = this.manifest.chunks.filter((chunk) => chunk.status !== "completed");
      if (failed.length > 0) {
        this.manifest.status = this.manifest.chunks.some((chunk) => chunk.status === "completed") ? "partial" : "failed";
        const completed = toChunkResults(this.manifest.chunks.filter((chunk) => chunk.status === "completed"));
        const partialTranscript = stitchChunks(completed);
        this.emit({
          type: "job.partial",
          jobId: this.id,
          completed: completed.length,
          failed: failed.length,
          partialTranscript,
        });
        await this.persist();
        throw new DictationError(`${failed.length} audio chunk${failed.length === 1 ? "" : "s"} failed. Resume the job to retry only failed chunks.`, {
          code: "CHUNK_TRANSCRIPTION_FAILED",
          details: {
            jobId: this.id,
            failed: failed.map((chunk) => chunk.index),
            completedChunks: completed,
            partialTranscript,
          },
        });
      }

      this.emit({ type: "stitching.started", jobId: this.id });
      const chunkResults = toChunkResults(this.manifest.chunks);
      const stitched = stitchChunksDetailed(chunkResults);
      for (const decision of stitched.decisions) {
        this.emit({ type: "stitching.decision", jobId: this.id, decision });
      }
      const rawTranscript = stitched.text;
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
        stitching: stitched.decisions,
        cleanupWindows: cleanup.windows,
        source: this.manifest.source,
      };
      this.manifest.status = "completed";
      this.manifest.result = result;
      this.emit({ type: "job.completed", jobId: this.id, result });
      await this.persist();
      this.stream.close();
      return result;
    } catch (error) {
      if (this.manifest && this.manifest.status !== "partial") {
        this.manifest.status = this.controller.signal.aborted ? "aborted" : "failed";
      }
      const normalized = normalizeJobError(error, this.id, this.controller.signal.aborted);
      if (this.controller.signal.aborted) {
        this.emit({ type: "job.canceled", jobId: this.id, reason: normalized.message });
      } else {
        this.emit({ type: "job.failed", jobId: this.id, error: normalized.message });
      }
      if (this.manifest) await this.persist().catch(() => undefined);
      this.stream.close();
      throw normalized;
    } finally {
      await this.stopLease();
    }
  }

  private async prepareChunks(): Promise<readonly AudioChunk[]> {
    const mode = this.options.mode ?? "interactive";
    const metadata = await this.inspectSource();
    const supported = this.processor.supports
      ? await this.processor.supports(this.audio, metadata)
      : true;
    if (!supported) {
      throw new DictationError(
        `The ${this.processor.name} processor cannot handle ${metadata.mimeType || metadata.filename}. ` +
        "Supply a compatible AudioProcessor (for example FfmpegAudioProcessor from " +
        "groq-dictation-kit/node) or upload through a server route.",
        {
          code: "LONG_AUDIO_PROCESSOR_REQUIRED",
          details: {
            processor: this.processor.name,
            mimeType: metadata.mimeType,
            filename: metadata.filename,
            sizeBytes: metadata.sizeBytes,
          },
        },
      );
    }
    return this.processor.segment(this.audio, {
      targetChunkMs: this.options.targetChunkMs ?? (
        mode === "interactive" ? DEFAULT_INTERACTIVE_CHUNK_MS : DEFAULT_OFFLINE_CHUNK_MS
      ),
      overlapMs: this.options.overlapMs ?? (
        mode === "interactive" ? DEFAULT_INTERACTIVE_OVERLAP_MS : DEFAULT_OFFLINE_OVERLAP_MS
      ),
      maxChunkBytes: this.options.maxChunkBytes ?? DEFAULT_LONG_CHUNK_MAX_BYTES,
      metadata,
      signal: this.controller.signal,
    });
  }

  private async createManifest(
    chunks: readonly AudioChunk[],
    requestKeys: readonly string[],
    configurationKey: string,
  ): Promise<LongJobManifest> {
    const source = await this.inspectSource();
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
      configurationKey,
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
        requestKey: requestKeys[chunk.index]!,
        status: "pending",
        attempts: 0,
        providerAttempts: 0,
        unknownProviderOutcomes: 0,
      })),
      eventCursor: 0,
      events: [],
    };
  }

  private inspectSource(): Promise<AudioMetadata> {
    this.inspectedMetadata ??= this.processor.inspect(this.audio).then((metadata) =>
      this.addDurableSourceIdentity(metadata)
    );
    return this.inspectedMetadata;
  }

  private async addDurableSourceIdentity(metadata: AudioMetadata): Promise<AudioMetadata> {
    const [fingerprint, legacyFingerprint] = await Promise.all([
      fullAudioFingerprint(this.audio.data),
      legacyAudioFingerprint(this.audio.data),
    ]);
    if (!fingerprint) {
      throw new DictationError("Durable long-job identity requires Web Crypto SHA-256 support.", {
        code: "DURABLE_IDENTITY_UNAVAILABLE",
      });
    }
    return {
      ...metadata,
      fingerprint,
      ...(legacyFingerprint ? { legacyFingerprint } : {}),
    };
  }

  private transcriptionOptions(
    priorText?: string,
    onProviderAttempt?: (event: ProviderAttemptEvent) => void,
    signal: AbortSignal = this.controller.signal,
  ): TranscriptionOptions {
    const prompt = buildContextPrompt(
      this.options.prompt ?? this.options.transcription?.prompt,
      priorText,
      this.options.promptTailChars ?? DEFAULT_PROMPT_TAIL_CHARS,
    );
    return {
      ...this.options.transcription,
      responseFormat: "verbose_json",
      timestampGranularities: ["segment"],
      ...(this.options.transcriptionModel !== undefined ? { model: this.options.transcriptionModel } : {}),
      ...(this.options.language !== undefined ? { language: this.options.language } : {}),
      ...(prompt ? { prompt } : {}),
      signal,
      ...(onProviderAttempt ? { onProviderAttempt } : {}),
    };
  }

  private observeProviderAttempt(
    record: LongChunkRecord,
    event: ProviderAttemptEvent,
    pool?: AdaptiveWorkPool,
    pacer?: RequestPacer,
  ): void {
    if (event.outcome === "started") record.providerAttempts = (record.providerAttempts ?? 0) + 1;
    if (event.outcome === "unknown") {
      record.unknownProviderOutcomes = (record.unknownProviderOutcomes ?? 0) + 1;
    }
    if ((event.outcome === "retrying" || event.outcome === "failed") && event.status === 429 && pool) {
      pool.reduceTo(Math.max(1, Math.floor(pool.currentLimit / 2)));
    }
    if (event.outcome === "succeeded") pool?.recordSuccess();
    if (event.retryAfterMs !== undefined) pacer?.defer(event.retryAfterMs);
    if (event.rateLimit) {
      pacer?.observe(event.rateLimit);
      this.emit({
        type: "rate-limit.observed",
        jobId: this.id,
        ...(event.rateLimit.remainingRequests !== undefined
          ? { remainingRequests: event.rateLimit.remainingRequests }
          : {}),
        ...(event.rateLimit.resetRequestsMs !== undefined
          ? { resetRequestsMs: event.rateLimit.resetRequestsMs }
          : {}),
      });
    }
  }

  private async createRequestKeys(
    chunks: readonly AudioChunk[],
    configurationKey: string,
  ): Promise<readonly string[]> {
    return Promise.all(chunks.map((chunk) => hashRequestDescriptor({
      configurationKey,
      chunk: {
        index: chunk.index,
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        overlapBeforeMs: chunk.overlapBeforeMs,
      },
    })));
  }

  private async createConfigurationKey(source: AudioMetadata): Promise<string> {
    const basePrompt = this.options.prompt ?? this.options.transcription?.prompt;
    return hashRequestDescriptor({
      source: source.fingerprint,
      processor: this.processor.name,
      preprocessing: {
        targetChunkMs: this.options.targetChunkMs ?? (
          this.options.mode === "offline" ? DEFAULT_OFFLINE_CHUNK_MS : DEFAULT_INTERACTIVE_CHUNK_MS
        ),
        overlapMs: this.options.overlapMs ?? (
          this.options.mode === "offline" ? DEFAULT_OFFLINE_OVERLAP_MS : DEFAULT_INTERACTIVE_OVERLAP_MS
        ),
        maxChunkBytes: this.options.maxChunkBytes ?? DEFAULT_LONG_CHUNK_MAX_BYTES,
      },
      transcription: {
        model: this.options.transcriptionModel ?? this.groq.transcriptionModel,
        language: this.options.language ?? this.options.transcription?.language,
        prompt: basePrompt,
        temperature: this.options.transcription?.temperature,
        responseFormat: "verbose_json",
        timestampGranularities: ["segment"],
        accuracyMode: this.options.accuracyMode ?? "retry-ambiguous",
      },
    });
  }

  private async startLease(): Promise<void> {
    if (!this.store.acquireLease) return;
    const ttlMs = validateLeaseTtl(this.options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
    const acquired = await this.store.acquireLease(this.id, this.leaseOwner, ttlMs);
    if (!acquired) {
      throw new DictationError("Another worker currently owns this long dictation job.", {
        code: "JOB_LEASE_UNAVAILABLE",
        details: { jobId: this.id },
      });
    }
    if (!this.store.renewLease) return;
    this.leaseTimer = setInterval(() => {
      if (this.renewingLease) return;
      this.renewingLease = true;
      void this.store.renewLease!(this.id, this.leaseOwner, ttlMs)
        .then((renewed) => {
          if (!renewed) {
            this.abort(new DictationError("The long dictation job lease was lost.", {
              code: "JOB_LEASE_LOST",
              details: { jobId: this.id },
            }));
          }
        })
        .catch((cause) => this.abort(new DictationError("Unable to renew the long dictation job lease.", {
          code: "JOB_LEASE_LOST",
          details: { jobId: this.id },
          cause,
        })))
        .finally(() => { this.renewingLease = false; });
    }, Math.max(25, Math.floor(ttlMs / 2)));
  }

  private async stopLease(): Promise<void> {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = undefined;
    await this.store.releaseLease?.(this.id, this.leaseOwner).catch(() => undefined);
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
      this.emit({ type: "chunk.retrying", jobId: this.id, index, reason: "low boundary confidence" });
      record.attempts += 1;
      const original = record.result;
      try {
        const candidate = await this.groq.transcribe(
          chunk.audio,
          this.transcriptionOptions(previous, (event) => this.observeProviderAttempt(record, event)),
        );
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
      return { text: transcript, model: "none", usedFallback: false, rejected: false, windows: [] };
    }
    this.emit({ type: "cleanup.started", jobId: this.id });
    const windows = splitCleanupWindows(transcript, DEFAULT_CLEANUP_WINDOW_CHARS);
    const outputs: string[] = [];
    let model = "none";
    let usedFallback = false;
    let rejected = false;
    const windowResults: CleanupWindowResult[] = [];
    let searchFrom = 0;
    for (const [index, window] of windows.entries()) {
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
      const locatedAt = transcript.indexOf(window, searchFrom);
      const startChar = locatedAt >= 0 ? locatedAt : searchFrom;
      const windowResult: CleanupWindowResult = {
        index,
        startChar,
        endChar: startChar + window.length,
        model: result.model,
        usedFallback: result.usedFallback,
        accepted: !result.rejected,
        ...(result.guard ? { guard: result.guard } : {}),
      };
      windowResults.push(windowResult);
      this.emit({ type: "cleanup.window", jobId: this.id, window: windowResult });
      searchFrom = startChar + window.length;
    }
    // One rejected window invalidates the cleaned composite. Returning the canonical transcript
    // avoids mixing trusted raw sections with model-edited sections under a single result.
    return { text: rejected ? transcript : outputs.join("\n\n").trim(), model, usedFallback, rejected, windows: windowResults };
  }

  private emitProgress(): void {
    const chunks = this.manifest!.chunks;
    this.emit({
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
    // Snapshot at enqueue time so later mutations cannot leak into an earlier queued write.
    // Supplying the save callback to both branches also lets a later durability attempt recover
    // after one store.save() rejection instead of inheriting a permanently poisoned chain.
    const snapshot = structuredClone(manifest);
    const save = () => this.store.save(snapshot);
    this.saveChain = this.saveChain.then(save, save);
    return this.saveChain;
  }

  private emit(event: LongJobEventPayload): LongJobEvent {
    const durable = this.stream.emit(event);
    if (this.manifest) {
      this.manifest.events ??= [];
      this.manifest.events.push(durable);
      this.manifest.eventCursor = durable.cursor;
    }
    return durable;
  }
}

interface CleanupOutcome extends CleanupResult {
  rejected: boolean;
  windows: CleanupWindowResult[];
}

function validateAndResumeManifest(
  manifest: LongJobManifest,
  chunks: readonly AudioChunk[],
  source: AudioMetadata,
  requestKeys: readonly string[],
  configurationKey: string,
  migrateLegacyManifest = false,
): LongJobManifest {
  assertSourceMatches(manifest, source);
  assertConfigurationMatches(manifest, configurationKey, migrateLegacyManifest);
  const layoutMismatch = manifest.chunks.some((record, index) => {
    const chunk = chunks[index];
    return !chunk || record.startMs !== chunk.startMs || record.endMs !== chunk.endMs ||
      record.overlapBeforeMs !== chunk.overlapBeforeMs ||
      (record.requestKey !== undefined && record.requestKey !== requestKeys[index]);
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
    if (chunk.requestKey === undefined) chunk.requestKey = requestKeys[chunk.index]!;
    chunk.providerAttempts ??= 0;
    chunk.unknownProviderOutcomes ??= 0;
  }
  // Successful legacy validation upgrades the manifest before any resumed provider work begins.
  manifest.source = source;
  manifest.configurationKey = configurationKey;
  return manifest;
}

function assertConfigurationMatches(
  manifest: LongJobManifest,
  configurationKey: string,
  migrateLegacyManifest = false,
): void {
  if (manifest.configurationKey === undefined && !migrateLegacyManifest) {
    throw new DictationError("This legacy job manifest requires explicit identity migration.", {
      code: "JOB_LEGACY_MIGRATION_REQUIRED",
      details: { jobId: manifest.jobId },
    });
  }
  if (manifest.configurationKey !== undefined && manifest.configurationKey !== configurationKey) {
    throw new DictationError("Resume options do not match the original job configuration.", {
      code: "JOB_CONFIGURATION_MISMATCH",
      details: { jobId: manifest.jobId },
    });
  }
}

function normalizeCachedResult(result: LongDictationResult, source: AudioMetadata): LongDictationResult {
  if (Array.isArray(result.stitching)) return { ...result, source, cleanupWindows: result.cleanupWindows ?? [] };
  const stitched = stitchChunksDetailed(result.chunks ?? []);
  return {
    ...result,
    source,
    // Preserve the transcript returned by the historical job while adding auditable decisions.
    stitching: stitched.decisions,
    cleanupWindows: result.cleanupWindows ?? [],
  };
}

function assertSourceMatches(
  manifest: LongJobManifest,
  source: AudioMetadata,
): void {
  const storedFingerprint = manifest.source.fingerprint;
  const currentFingerprint = storedFingerprint?.startsWith("sha256:")
    ? source.fingerprint
    : source.legacyFingerprint;
  const fingerprintMismatch = storedFingerprint !== undefined &&
    currentFingerprint !== undefined && storedFingerprint !== currentFingerprint;
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

class AdaptiveWorkPool {
  private limit: number;
  private readonly maximumLimit: number;
  private successfulRequests = 0;

  constructor(
    initialLimit: number,
    private readonly onReduced: (from: number, to: number) => void,
    private readonly onIncreased: (from: number, to: number) => void,
  ) {
    this.limit = initialLimit;
    this.maximumLimit = initialLimit;
  }

  get currentLimit(): number {
    return this.limit;
  }

  reduceTo(next: number): void {
    this.successfulRequests = 0;
    const limited = Math.max(1, Math.min(this.limit, Math.floor(next)));
    if (limited >= this.limit) return;
    const previous = this.limit;
    this.limit = limited;
    this.onReduced(previous, limited);
  }

  recordSuccess(): void {
    if (this.limit >= this.maximumLimit) return;
    this.successfulRequests += 1;
    // Additive recovery is intentionally slower than multiplicative decrease. Four successful
    // provider calls at minimum prevent a single retry from immediately undoing rate-limit relief.
    if (this.successfulRequests < Math.max(4, this.limit * 2)) return;
    const previous = this.limit;
    this.limit = Math.min(this.maximumLimit, this.limit + 1);
    this.successfulRequests = 0;
    this.onIncreased(previous, this.limit);
  }

  run<T>(
    items: readonly T[],
    work: (item: T) => Promise<void>,
    onFatal?: (error: unknown) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let cursor = 0;
      let active = 0;
      let firstError: unknown;
      const launch = () => {
        if (firstError !== undefined && active === 0) {
          reject(firstError);
          return;
        }
        if (cursor >= items.length && active === 0) {
          resolve();
          return;
        }
        while (firstError === undefined && active < this.limit && cursor < items.length) {
          const item = items[cursor++]!;
          active += 1;
          void work(item).then(() => {
            active -= 1;
            launch();
          }, (error) => {
            active -= 1;
            if (firstError === undefined) {
              firstError = error;
              onFatal?.(error);
            }
            launch();
          });
        }
      };
      launch();
    });
  }
}

function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function clampConcurrency(value: number): number {
  return Math.max(1, Math.min(8, Math.floor(value)));
}

function validateLeaseTtl(value: number): number {
  if (!Number.isFinite(value) || value < 50) {
    throw new DictationError("Long-job leaseTtlMs must be at least 50 milliseconds.", {
      code: "INVALID_JOB_LEASE_TTL",
    });
  }
  return Math.floor(value);
}

async function hashRequestDescriptor(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new DictationError("Content-addressed chunk identities require Web Crypto SHA-256 support.", {
      code: "DURABLE_IDENTITY_UNAVAILABLE",
    });
  }
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", payload));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
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

class JobEventStream {
  private readonly history: LongJobEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private closed = false;
  private nextCursor = 1;

  seed(events: readonly LongJobEvent[]): void {
    if (this.history.length > 0 || events.length === 0) return;
    this.history.push(...events.map((event) => structuredClone(event)));
    this.nextCursor = Math.max(...events.map((event) => event.cursor), 0) + 1;
  }

  emit(event: LongJobEventPayload): LongJobEvent {
    const durable = { ...event, cursor: this.nextCursor++, at: new Date().toISOString() } as LongJobEvent;
    this.history.push(durable);
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    return durable;
  }

  close(): void {
    this.closed = true;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  after(afterCursor: number): AsyncIterable<LongJobEvent> {
    const stream = this;
    return { async *[Symbol.asyncIterator]() {
      let cursor = afterCursor;
      while (true) {
        const available = stream.history.filter((event) => event.cursor > cursor);
        for (const event of available) {
          cursor = event.cursor;
          yield event;
        }
        if (stream.history.some((event) => event.cursor > cursor)) continue;
        if (stream.closed) return;
        await new Promise<void>((resolve) => stream.waiters.add(resolve));
      }
    } };
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
  private providerBlockedUntil = 0;
  private adaptiveIntervalMs = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly requestsPerMinute: number | false | undefined) {}

  wait(signal: AbortSignal): Promise<void> {
    if (
      (this.requestsPerMinute === false || this.requestsPerMinute === undefined) &&
      this.providerBlockedUntil <= Date.now() && this.adaptiveIntervalMs <= 0
    ) return Promise.resolve();
    const configuredInterval = this.requestsPerMinute === false || this.requestsPerMinute === undefined
      ? 0
      : 60_000 / Math.max(1, this.requestsPerMinute);
    const intervalMs = Math.max(configuredInterval, this.adaptiveIntervalMs);
    const scheduled = this.chain.then(async () => {
      const delayMs = Math.max(0, this.nextStartAt - performance.now(), this.providerBlockedUntil - Date.now());
      if (delayMs > 0) await abortableDelay(delayMs, signal);
      this.nextStartAt = performance.now() + intervalMs;
    });
    this.chain = scheduled.catch(() => undefined);
    return scheduled;
  }

  defer(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
    this.providerBlockedUntil = Math.max(this.providerBlockedUntil, Date.now() + milliseconds);
  }

  observe(snapshot: RateLimitSnapshot): void {
    const remaining = snapshot.remainingRequests;
    const resetMs = snapshot.resetRequestsMs;
    if (remaining === undefined || resetMs === undefined || resetMs <= 0) return;
    if (remaining <= 0) {
      this.defer(resetMs);
      return;
    }
    // Spread the remaining requests across the provider's reset window. The interval
    // automatically relaxes as later headers report more quota or a shorter reset.
    this.adaptiveIntervalMs = Math.max(0, resetMs / remaining);
    this.nextStartAt = Math.max(this.nextStartAt, performance.now() + this.adaptiveIntervalMs);
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
