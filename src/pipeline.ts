import { GroqClient } from "./groq-client.js";
import { GroqBatchClient } from "./batch.js";
import { LongJob } from "./long/job.js";
import { MemoryJobStore } from "./long/store.js";
import { routeAudio } from "./router.js";
import { LiveConversationSession } from "./live-session.js";
import { DictationError } from "./errors.js";
import type { LiveConversationOptions } from "./live-session.js";
import type {
  AudioInput,
  AudioMetadata,
  CleanupOptions,
  DictationClientOptions,
  DictationContext,
  DictationOptions,
  DictationResult,
  ContextProvider,
  PipelineEvent,
  ObjectStorage,
  StorageTranscriptionOptions,
  StorageTranscriptionResult,
  StorageEvent,
  CleanupGuardReport,
  TranscriptionOptions,
} from "./types.js";
import type {
  AutoDictationOptions,
  JobStore,
  LongDictationJob,
  LongDictationOptions,
  LongDictationResult,
} from "./long/types.js";

export class DictationSession {
  private readonly contextStartedAt = performance.now();
  private readonly contextPromise: Promise<DictationContext>;

  constructor(
    private readonly pipeline: DictationPipeline,
    context?: DictationContext | ContextProvider | Promise<DictationContext>,
  ) {
    this.contextPromise = resolveContext(context);
  }

  async finish(audio: AudioInput, options: Omit<DictationOptions, "context"> = {}): Promise<DictationResult> {
    return this.pipeline.runSession(audio, options, this.contextPromise, this.contextStartedAt);
  }
}

export class DictationPipeline {
  readonly groq: GroqClient;
  readonly batches: GroqBatchClient;
  private readonly onEvent: ((event: PipelineEvent) => void) | undefined;
  private readonly longJobStore: JobStore;

  constructor(options: DictationClientOptions) {
    this.groq = new GroqClient(options);
    this.batches = new GroqBatchClient(options);
    this.onEvent = options.onEvent;
    this.longJobStore = new MemoryJobStore();
  }

  /** Start this when recording starts so context collection overlaps the user's speech. */
  startSession(context?: DictationContext | ContextProvider | Promise<DictationContext>): DictationSession {
    this.emit({ type: "session.started" });
    return new DictationSession(this, context);
  }

  /** Convenience API when no recording-time overlap is needed. */
  async dictate(audio: AudioInput, options: DictationOptions = {}): Promise<DictationResult> {
    const { context, ...rest } = options;
    return this.startSession(context).finish(audio, rest);
  }

  async transcribe(audio: AudioInput, options: TranscriptionOptions = {}) {
    return this.groq.transcribe(audio, options);
  }

  async transcribeUrl(url: string, options: TranscriptionOptions = {}) {
    return this.groq.transcribeUrl(url, options);
  }

  /** Upload audio privately, transcribe through a short-lived URL, then remove it by default. */
  async transcribeStored(
    audio: AudioInput,
    storage: ObjectStorage,
    options: StorageTranscriptionOptions = {},
  ): Promise<StorageTranscriptionResult> {
    const { key, signedUrlExpiresInSeconds, deleteAfter, uploadResumeToken, onStorageEvent, ...transcription } = options;
    const storageKey = key ?? `dictation/${createStorageId()}/${safeStorageFilename(audio.filename)}`;
    emitStorage(onStorageEvent, {
      type: "storage.upload.started",
      key: storageKey,
      totalBytes: audio.data.size,
      ...(uploadResumeToken ? { resumeToken: uploadResumeToken } : {}),
    });
    const stored = await storage.put(storageKey, audio, {
      ...(transcription.signal ? { signal: transcription.signal } : {}),
      ...(uploadResumeToken ? { resumeToken: uploadResumeToken } : {}),
      onProgress: (progress) => emitStorage(onStorageEvent, {
        type: "storage.upload.progress",
        key: storageKey,
        ...progress,
      }),
    });
    emitStorage(onStorageEvent, { type: "storage.upload.completed", key: stored.key, stored });
    let result: Awaited<ReturnType<GroqClient["transcribeUrl"]>> | undefined;
    let primaryError: unknown;
    try {
      const url = await storage.createSignedUrl(stored.key, signedUrlExpiresInSeconds ?? 900);
      emitStorage(onStorageEvent, { type: "storage.transcription.started", key: stored.key });
      result = await this.groq.transcribeUrl(url, {
        ...transcription,
        ...(stored.durationMs !== undefined ? { audioDurationMs: stored.durationMs } : {}),
      });
      emitStorage(onStorageEvent, { type: "storage.transcription.completed", key: stored.key });
    } catch (error) {
      primaryError = error;
    }
    let deleted = false;
    if (deleteAfter !== false && storage.delete) {
      try {
        emitStorage(onStorageEvent, {
          type: "storage.deletion.started",
          key: stored.key,
          ...(stored.version ? { version: stored.version } : {}),
        });
        await storage.delete(stored.key, {
          ...(stored.version ? { version: stored.version } : {}),
          ...(transcription.signal ? { signal: transcription.signal } : {}),
        });
        deleted = true;
        emitStorage(onStorageEvent, {
          type: "storage.deletion.completed",
          key: stored.key,
          ...(stored.version ? { version: stored.version } : {}),
        });
      } catch (cause) {
        emitStorage(onStorageEvent, {
          type: "storage.deletion.failed",
          key: stored.key,
          ...(stored.version ? { version: stored.version } : {}),
          error: cause instanceof Error ? cause.message : String(cause),
        });
        throw new DictationError("Temporary object-storage audio could not be deleted.", {
          code: "STORAGE_DELETE_FAILED",
          details: {
            storageKey: stored.key,
            storageVersion: stored.version,
            providerRequestFailed: primaryError !== undefined,
            ...(result ? { transcriptionResult: result } : {}),
            ...(primaryError !== undefined ? { providerError: summarizeError(primaryError) } : {}),
          },
          cause,
        });
      }
    }
    if (primaryError !== undefined) throw primaryError;
    return {
      ...result!,
      storageKey: stored.key,
      ...(stored.version ? { storageVersion: stored.version } : {}),
      ...(stored.checksum ? { storageChecksum: stored.checksum } : {}),
      ...(stored.resumeToken ? { uploadResumeToken: stored.resumeToken } : {}),
      deleted,
    };
  }

  async cleanup(transcript: string, options: CleanupOptions = {}) {
    return this.groq.cleanup(transcript, options);
  }

  /** Start near-live transcription for independently playable microphone windows. */
  startLiveConversation(options: LiveConversationOptions = {}): LiveConversationSession {
    return new LiveConversationSession(this.groq, options);
  }

  /** Create a resumable, observable job for long audio. Existing dictate() behavior is unchanged. */
  createJob(audio: AudioInput, options: LongDictationOptions = {}): LongDictationJob {
    return this.createLongJob(audio, options);
  }

  /** Convenience API for long audio. Defaults to chunked transcription with raw output. */
  dictateLong(audio: AudioInput, options: LongDictationOptions = {}): Promise<LongDictationResult> {
    return this.createJob(audio, options).result();
  }

  /** Automatically retain the fast direct path or select a supported long-audio processor. */
  async dictateAuto(
    audio: AudioInput,
    options: AutoDictationOptions = {},
  ): Promise<DictationResult | LongDictationResult> {
    // Custom processors may discover duration/codec information that generic Blob inspection
    // cannot (notably FFprobe-backed WebM/MP4 inputs), so their metadata is authoritative.
    const sourceMetadata = options.processor ? await options.processor.inspect(audio) : undefined;
    const decision = await routeAudio(audio, {
      ...(options.forceLong !== undefined ? { forceLong: options.forceLong } : {}),
      ...(sourceMetadata ? { sourceMetadata } : {}),
    });
    if (decision.kind === "direct") {
      return this.dictate(audio, toShortOptions(options));
    }
    return this.createLongJob(audio, options, decision.metadata).result();
  }

  /** Resume an interrupted job and reuse all successfully persisted chunks. */
  resumeJob(jobId: string, audio: AudioInput, options: LongDictationOptions = {}): LongDictationJob {
    return this.createJob(audio, { ...options, jobId });
  }

  private createLongJob(
    audio: AudioInput,
    options: LongDictationOptions,
    sourceMetadata?: AudioMetadata,
  ): LongDictationJob {
    return new LongJob(this.groq, audio, options, this.longJobStore, sourceMetadata);
  }

  async runSession(
    audio: AudioInput,
    options: Omit<DictationOptions, "context">,
    contextPromise: Promise<DictationContext>,
    contextStartedAt: number,
  ): Promise<DictationResult> {
    const totalStartedAt = performance.now();
    const transcriptionStartedAt = performance.now();
    this.emit({ type: "transcription.started" });

    const transcriptionOptions: TranscriptionOptions = {
      ...options.transcription,
      ...(options.transcriptionModel !== undefined ? { model: options.transcriptionModel } : {}),
      ...(options.language !== undefined ? { language: options.language } : {}),
      ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };
    const transcription = await this.groq.transcribe(audio, transcriptionOptions);
    const transcriptionMs = performance.now() - transcriptionStartedAt;
    this.emit({
      type: "transcription.completed",
      durationMs: transcriptionMs,
      text: transcription.text,
    });

    const context = await contextPromise;
    const contextMs = performance.now() - contextStartedAt;
    let text = transcription.text;
    let cleanupModel: string | undefined;
    let usedCleanupFallback = false;
    let cleanupRejected = false;
    let cleanupGuard: CleanupGuardReport | undefined;
    let cleanupMs = 0;

    if (text) {
      this.emit({ type: "cleanup.started" });
      const cleanupStartedAt = performance.now();
      const cleanupOptions: CleanupOptions = {
        ...options.cleanup,
        context,
        ...(options.cleanupModel !== undefined ? { model: options.cleanupModel } : {}),
        ...(options.fallbackModel !== undefined ? { fallbackModel: options.fallbackModel } : {}),
        ...(options.vocabulary !== undefined ? { vocabulary: options.vocabulary } : {}),
        ...(options.outputLanguage !== undefined ? { outputLanguage: options.outputLanguage } : {}),
        ...(options.preserveExactWording !== undefined ? { preserveExactWording: options.preserveExactWording } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      };
      const cleaned = await this.groq.cleanup(text, cleanupOptions);
      cleanupMs = performance.now() - cleanupStartedAt;
      text = cleaned.text;
      cleanupModel = cleaned.model;
      usedCleanupFallback = cleaned.usedFallback;
      cleanupRejected = Boolean(cleaned.rejected);
      cleanupGuard = cleaned.guard;
      this.emit({
        type: "cleanup.completed",
        durationMs: cleanupMs,
        text,
        model: cleaned.model,
      });
    }

    const result: DictationResult = {
      text,
      rawTranscript: transcription.text,
      transcriptionModel: transcription.model,
      ...(cleanupModel !== undefined ? { cleanupModel } : {}),
      usedCleanupFallback,
      filteredAsSilence: transcription.filteredAsSilence,
      context,
      timings: {
        contextMs,
        transcriptionMs,
        cleanupMs,
        totalMs: performance.now() - totalStartedAt,
      },
      cleanupRejected,
      ...(cleanupGuard ? { cleanupGuard } : {}),
    };
    this.emit({ type: "pipeline.completed", result });
    return result;
  }

  private emit(event: PipelineEvent): void {
    this.onEvent?.(event);
  }
}

function emitStorage(listener: ((event: StorageEvent) => void) | undefined, event: StorageEvent): void {
  try {
    listener?.(event);
  } catch {
    // Storage observability must not alter the upload/transcription lifecycle.
  }
}

function summarizeError(error: unknown): { message: string; code?: string; status?: number } {
  if (!(error instanceof Error)) return { message: String(error) };
  const candidate = error as Error & { code?: unknown; status?: unknown };
  return {
    message: error.message,
    ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
    ...(typeof candidate.status === "number" ? { status: candidate.status } : {}),
  };
}

async function resolveContext(
  source?: DictationContext | ContextProvider | Promise<DictationContext>,
): Promise<DictationContext> {
  if (!source) return {};
  return typeof source === "function" ? source() : source;
}

function createStorageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function safeStorageFilename(filename?: string): string {
  const safe = (filename ?? "dictation.audio").replace(/[^A-Za-z0-9._-]/g, "_");
  return safe || "dictation.audio";
}

function toShortOptions(options: AutoDictationOptions): DictationOptions {
  return {
    ...(options.transcription !== undefined ? { transcription: options.transcription } : {}),
    ...(options.cleanup !== undefined ? { cleanup: options.cleanup } : {}),
    ...(options.transcriptionModel !== undefined ? { transcriptionModel: options.transcriptionModel } : {}),
    ...(options.cleanupModel !== undefined ? { cleanupModel: options.cleanupModel } : {}),
    ...(options.fallbackModel !== undefined ? { fallbackModel: options.fallbackModel } : {}),
    ...(options.language !== undefined ? { language: options.language } : {}),
    ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
    ...(options.vocabulary !== undefined ? { vocabulary: options.vocabulary } : {}),
    ...(options.outputLanguage !== undefined ? { outputLanguage: options.outputLanguage } : {}),
    ...(options.preserveExactWording !== undefined ? { preserveExactWording: options.preserveExactWording } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.context !== undefined ? { context: options.context } : {}),
  };
}
