import { DictationError } from "./errors.js";
import type { GroqClient } from "./groq-client.js";
import type {
  AudioInput,
  CleanupConfig,
  DictationContext,
  DictationOptions,
  TranscriptionConfig,
} from "./types.js";

const DEFAULT_PROMPT_TAIL_CHARS = 700;

export interface LiveConversationOptions extends DictationOptions {
  /** Transcript tail carried into the next Whisper request. Defaults to 700 characters. */
  promptTailChars?: number;
  onEvent?: (event: LiveConversationEvent) => void;
}

export interface LiveConversationChunk {
  sequence: number;
  text: string;
  transcript: string;
  model: string;
  durationMs: number;
}

export interface LiveConversationResult {
  text: string;
  rawTranscript: string;
  transcriptionModel: string;
  cleanupModel?: string;
  usedCleanupFallback: boolean;
  cleanupRejected: boolean;
  filteredAsSilence: boolean;
  context: DictationContext;
  chunks: readonly LiveConversationChunk[];
  timings: {
    contextMs: number;
    transcriptionMs: number;
    cleanupMs: number;
    totalMs: number;
  };
}

export type LiveConversationEvent =
  | { type: "live.started" }
  | { type: "live.chunk.started"; sequence: number }
  | { type: "live.partial"; chunk: LiveConversationChunk }
  | { type: "live.cleanup.started" }
  | { type: "live.completed"; result: LiveConversationResult }
  | { type: "live.failed"; error: string };

/** Serial near-live transcription for independently playable microphone windows. */
export class LiveConversationSession {
  private readonly controller = new AbortController();
  private readonly startedAt = performance.now();
  private readonly contextStartedAt = performance.now();
  private readonly contextPromise: Promise<DictationContext>;
  private readonly chunks: LiveConversationChunk[] = [];
  private queue: Promise<void> = Promise.resolve();
  private sequence = 0;
  private transcriptionMs = 0;
  private closed = false;
  private failed: unknown;

  constructor(
    private readonly groq: GroqClient,
    private readonly options: LiveConversationOptions = {},
  ) {
    this.contextPromise = resolveContext(options.context);
    options.signal?.addEventListener("abort", () => this.abort(options.signal?.reason), { once: true });
    this.emit({ type: "live.started" });
  }

  /** Queue one self-contained audio window. Calls are processed in capture order. */
  push(audio: AudioInput): Promise<LiveConversationChunk> {
    if (this.closed) {
      return Promise.reject(new DictationError("The live conversation is already closed.", {
        code: "LIVE_SESSION_CLOSED",
      }));
    }
    const sequence = this.sequence++;
    const work = this.queue.then(() => this.transcribe(sequence, audio));
    this.queue = work.then(() => undefined, (error) => {
      this.failed ??= error;
    });
    return work;
  }

  /** Wait for queued windows, then run cleanup once over the complete transcript. */
  async finish(): Promise<LiveConversationResult> {
    if (this.closed) {
      throw new DictationError("The live conversation is already closed.", { code: "LIVE_SESSION_CLOSED" });
    }
    this.closed = true;
    await this.queue;
    if (this.failed) {
      const error = normalizeError(this.failed, "A live transcription window failed.");
      this.emit({ type: "live.failed", error: error.message });
      throw error;
    }
    if (this.controller.signal.aborted) {
      throw new DictationError("The live conversation was aborted.", {
        code: "LIVE_SESSION_ABORTED",
        cause: this.controller.signal.reason,
      });
    }

    const rawTranscript = this.chunks.map((chunk) => chunk.text.trim()).filter(Boolean).join(" ").trim();
    const context = await this.contextPromise;
    const contextMs = performance.now() - this.contextStartedAt;
    let text = rawTranscript;
    let cleanupModel: string | undefined;
    let usedCleanupFallback = false;
    let cleanupRejected = false;
    let cleanupMs = 0;
    if (rawTranscript && this.options.cleanup?.mode !== "none") {
      this.emit({ type: "live.cleanup.started" });
      const cleanupStartedAt = performance.now();
      const cleanup = await this.groq.cleanup(rawTranscript, this.cleanupOptions(context));
      cleanupMs = performance.now() - cleanupStartedAt;
      text = cleanup.text;
      cleanupModel = cleanup.model;
      usedCleanupFallback = cleanup.usedFallback;
      cleanupRejected = Boolean(cleanup.rejected);
    }
    const result: LiveConversationResult = {
      text,
      rawTranscript,
      transcriptionModel: this.chunks[0]?.model ?? this.groq.transcriptionModel,
      ...(cleanupModel ? { cleanupModel } : {}),
      usedCleanupFallback,
      cleanupRejected,
      filteredAsSilence: this.chunks.length > 0 && this.chunks.every((chunk) => !chunk.text),
      context,
      chunks: [...this.chunks],
      timings: {
        contextMs,
        transcriptionMs: this.transcriptionMs,
        cleanupMs,
        totalMs: performance.now() - this.startedAt,
      },
    };
    this.emit({ type: "live.completed", result });
    return result;
  }

  abort(reason: unknown = new Error("Live conversation aborted")): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
  }

  private async transcribe(sequence: number, audio: AudioInput): Promise<LiveConversationChunk> {
    if (this.failed) throw this.failed;
    if (this.controller.signal.aborted) {
      throw new DictationError("The live conversation was aborted.", {
        code: "LIVE_SESSION_ABORTED",
        cause: this.controller.signal.reason,
      });
    }
    this.emit({ type: "live.chunk.started", sequence });
    const startedAt = performance.now();
    const prior = this.chunks.at(-1)?.transcript;
    const transcription = await this.groq.transcribe(audio, this.transcriptionOptions(prior));
    const durationMs = performance.now() - startedAt;
    this.transcriptionMs += durationMs;
    const transcript = [...this.chunks.map((chunk) => chunk.text), transcription.text]
      .map((text) => text.trim()).filter(Boolean).join(" ").trim();
    const chunk: LiveConversationChunk = {
      sequence,
      text: transcription.text,
      transcript,
      model: transcription.model,
      durationMs,
    };
    this.chunks.push(chunk);
    this.emit({ type: "live.partial", chunk });
    return chunk;
  }

  private transcriptionOptions(prior?: string) {
    const nested: TranscriptionConfig = this.options.transcription ?? {};
    const basePrompt = this.options.prompt ?? nested.prompt;
    const tailLength = Math.max(0, this.options.promptTailChars ?? DEFAULT_PROMPT_TAIL_CHARS);
    const tail = prior?.slice(-tailLength).trim();
    const prompt = [basePrompt?.trim(), tail ? `Previous transcript: ${tail}` : undefined]
      .filter(Boolean).join("\n");
    return {
      ...nested,
      ...(this.options.transcriptionModel !== undefined ? { model: this.options.transcriptionModel } : {}),
      ...(this.options.language !== undefined ? { language: this.options.language } : {}),
      ...(prompt ? { prompt } : {}),
      signal: this.controller.signal,
    };
  }

  private cleanupOptions(context: DictationContext) {
    const nested: CleanupConfig = this.options.cleanup ?? {};
    return {
      ...nested,
      context,
      ...(this.options.cleanupModel !== undefined ? { model: this.options.cleanupModel } : {}),
      ...(this.options.fallbackModel !== undefined ? { fallbackModel: this.options.fallbackModel } : {}),
      ...(this.options.vocabulary !== undefined ? { vocabulary: this.options.vocabulary } : {}),
      ...(this.options.outputLanguage !== undefined ? { outputLanguage: this.options.outputLanguage } : {}),
      ...(this.options.preserveExactWording !== undefined
        ? { preserveExactWording: this.options.preserveExactWording }
        : {}),
      signal: this.controller.signal,
    };
  }

  private emit(event: LiveConversationEvent): void {
    this.options.onEvent?.(event);
  }
}

async function resolveContext(
  source?: LiveConversationOptions["context"],
): Promise<DictationContext> {
  if (!source) return {};
  return typeof source === "function" ? source() : source;
}

function normalizeError(error: unknown, message: string): DictationError {
  return error instanceof DictationError
    ? error
    : new DictationError(message, { code: "LIVE_CHUNK_FAILED", cause: error });
}
