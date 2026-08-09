import { GroqClient } from "./groq-client.js";
import type {
  AudioInput,
  CleanupOptions,
  DictationClientOptions,
  DictationContext,
  DictationOptions,
  DictationResult,
  ContextProvider,
  PipelineEvent,
  TranscriptionOptions,
} from "./types.js";

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
  private readonly onEvent: ((event: PipelineEvent) => void) | undefined;

  constructor(options: DictationClientOptions) {
    this.groq = new GroqClient(options);
    this.onEvent = options.onEvent;
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

  async cleanup(transcript: string, options: CleanupOptions = {}) {
    return this.groq.cleanup(transcript, options);
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
    };
    this.emit({ type: "pipeline.completed", result });
    return result;
  }

  private emit(event: PipelineEvent): void {
    this.onEvent?.(event);
  }
}

async function resolveContext(
  source?: DictationContext | ContextProvider | Promise<DictationContext>,
): Promise<DictationContext> {
  if (!source) return {};
  return typeof source === "function" ? source() : source;
}
