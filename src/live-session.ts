import { DictationError } from "./errors.js";
import {
  DEFAULT_LIVE_CLEANUP_WINDOW_CHARS,
  DEFAULT_LIVE_MAX_PENDING_BYTES,
  DEFAULT_LIVE_MAX_PENDING_WINDOWS,
} from "./defaults.js";
import type { GroqClient } from "./groq-client.js";
import type {
  AudioInput,
  CleanupConfig,
  CleanupWindowResult,
  DictationContext,
  DictationOptions,
  TranscriptionConfig,
} from "./types.js";

const DEFAULT_PROMPT_TAIL_CHARS = 700;

export interface LiveConversationOptions extends DictationOptions {
  /** Transcript tail carried into the next Whisper request. Defaults to 700 characters. */
  promptTailChars?: number;
  /** Maximum accepted audio windows that have not settled. Defaults to 4. */
  maxPendingChunks?: number;
  /** Maximum accepted encoded audio bytes that have not settled. Defaults to 32 MiB. */
  maxPendingBytes?: number;
  /** Maximum characters sent through one explicitly enabled cleanup request. */
  cleanupWindowChars?: number;
  onEvent?: (event: LiveConversationEvent) => void;
}

export interface LiveConversationChunk {
  sequence: number;
  text: string;
  transcript: string;
  model: string;
  durationMs: number;
  overlapBeforeMs: number;
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
  cleanupWindows: readonly CleanupWindowResult[];
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
  | { type: "live.backpressure"; pendingChunks: number; pendingBytes: number }
  | { type: "live.partial"; chunk: LiveConversationChunk }
  | { type: "live.cleanup.started" }
  | { type: "live.cleanup.window"; window: CleanupWindowResult }
  | { type: "live.completed"; result: LiveConversationResult }
  | { type: "live.canceled"; reason: string; code: "LIVE_SESSION_ABORTED" }
  | { type: "live.failed"; error: string; code?: string };

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
  private pendingChunks = 0;
  private pendingBytes = 0;
  private closed = false;
  private completed = false;
  private failed: unknown;
  private failureEmitted = false;

  constructor(
    private readonly groq: GroqClient,
    private readonly options: LiveConversationOptions = {},
  ) {
    positiveLimit(options.maxPendingChunks, DEFAULT_LIVE_MAX_PENDING_WINDOWS, "maxPendingChunks");
    positiveLimit(options.maxPendingBytes, DEFAULT_LIVE_MAX_PENDING_BYTES, "maxPendingBytes");
    cleanupWindowLimit(options.cleanupWindowChars);
    this.contextPromise = resolveContext(options.context);
    options.signal?.addEventListener("abort", () => this.abort(options.signal?.reason), { once: true });
    this.emit({ type: "live.started" });
  }

  /** Queue one self-contained audio window. Calls are processed in capture order. */
  async push(audio: AudioInput): Promise<LiveConversationChunk> {
    if (this.closed) {
      return Promise.reject(new DictationError("The live conversation is already closed.", {
        code: "LIVE_SESSION_CLOSED",
      }));
    }
    const maxPendingChunks = positiveLimit(
      this.options.maxPendingChunks,
      DEFAULT_LIVE_MAX_PENDING_WINDOWS,
      "maxPendingChunks",
    );
    const maxPendingBytes = positiveLimit(
      this.options.maxPendingBytes,
      DEFAULT_LIVE_MAX_PENDING_BYTES,
      "maxPendingBytes",
    );
    if (this.pendingChunks >= maxPendingChunks || this.pendingBytes + audio.data.size > maxPendingBytes) {
      this.emit({
        type: "live.backpressure",
        pendingChunks: this.pendingChunks,
        pendingBytes: this.pendingBytes,
      });
      return Promise.reject(new DictationError("The live transcription queue is full.", {
        code: "LIVE_BACKPRESSURE_LIMIT",
        details: {
          pendingChunks: this.pendingChunks,
          pendingBytes: this.pendingBytes,
          maxPendingChunks,
          maxPendingBytes,
        },
      }));
    }
    const sequence = this.sequence++;
    this.pendingChunks += 1;
    this.pendingBytes += audio.data.size;
    const work = this.queue.then(() => this.transcribe(sequence, audio));
    const tracked = work.finally(() => {
      this.pendingChunks -= 1;
      this.pendingBytes -= audio.data.size;
    });
    this.queue = tracked.then(() => undefined, (error) => {
      this.failed ??= error;
    });
    return tracked;
  }

  /** Wait for queued windows, then optionally run explicitly enabled guarded cleanup. */
  async finish(): Promise<LiveConversationResult> {
    if (this.closed) {
      throw new DictationError("The live conversation is already closed.", { code: "LIVE_SESSION_CLOSED" });
    }
    this.closed = true;
    await this.queue;
    if (this.controller.signal.aborted) throw this.abortedError();
    if (this.failed) {
      const error = normalizeError(this.failed, "A live transcription window failed.");
      this.emitFailure(error);
      throw error;
    }

    const rawTranscript = this.chunks.at(-1)?.transcript ?? "";
    const context = await this.contextPromise;
    const contextMs = performance.now() - this.contextStartedAt;
    let text = rawTranscript;
    let cleanupModel: string | undefined;
    let usedCleanupFallback = false;
    let cleanupRejected = false;
    let cleanupMs = 0;
    const cleanupWindows: CleanupWindowResult[] = [];
    const cleanupMode = this.cleanupMode();
    if (rawTranscript && cleanupMode !== "none") {
      this.emit({ type: "live.cleanup.started" });
      const cleanupStartedAt = performance.now();
      try {
        const windows = splitCleanupWindows(
          rawTranscript,
          cleanupWindowLimit(this.options.cleanupWindowChars),
        );
        const outputs: string[] = [];
        let searchFrom = 0;
        for (const [index, window] of windows.entries()) {
          const cleanup = await this.groq.cleanup(window, this.cleanupOptions(context, cleanupMode));
          outputs.push(cleanup.text);
          cleanupModel = cleanup.model;
          usedCleanupFallback ||= cleanup.usedFallback;
          cleanupRejected ||= Boolean(cleanup.rejected);
          const locatedAt = rawTranscript.indexOf(window, searchFrom);
          const startChar = locatedAt >= 0 ? locatedAt : searchFrom;
          const windowResult: CleanupWindowResult = {
            index,
            startChar,
            endChar: startChar + window.length,
            model: cleanup.model,
            usedFallback: cleanup.usedFallback,
            accepted: !cleanup.rejected,
            ...(cleanup.guard ? { guard: cleanup.guard } : {}),
          };
          cleanupWindows.push(windowResult);
          this.emit({ type: "live.cleanup.window", window: windowResult });
          searchFrom = startChar + window.length;
        }
        cleanupMs = performance.now() - cleanupStartedAt;
        // Never create a mixed-trust result from partly accepted cleanup windows.
        text = cleanupRejected ? rawTranscript : outputs.join("\n\n").trim();
      } catch (error) {
        const failure = this.controller.signal.aborted
          ? this.abortedError()
          : normalizeError(error, "Live cleanup failed.");
        this.emitFailure(failure);
        throw failure;
      }
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
      cleanupWindows,
      timings: {
        contextMs,
        transcriptionMs: this.transcriptionMs,
        cleanupMs,
        totalMs: performance.now() - this.startedAt,
      },
    };
    this.completed = true;
    this.emit({ type: "live.completed", result });
    return result;
  }

  abort(reason: unknown = new Error("Live conversation aborted")): void {
    if (this.completed) return;
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason);
      this.emitFailure(this.abortedError());
    }
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
    let transcription;
    try {
      transcription = await this.groq.transcribe(audio, this.transcriptionOptions(prior));
    } catch (error) {
      if (this.controller.signal.aborted) throw this.abortedError();
      throw error;
    }
    const durationMs = performance.now() - startedAt;
    this.transcriptionMs += durationMs;
    const previousTranscript = this.chunks.at(-1)?.transcript ?? "";
    const overlapBeforeMs = Math.max(0, audio.overlapBeforeMs ?? 0);
    const transcript = mergeLiveWindow(previousTranscript, transcription.text, overlapBeforeMs);
    const chunk: LiveConversationChunk = {
      sequence,
      text: transcription.text,
      transcript,
      model: transcription.model,
      durationMs,
      overlapBeforeMs,
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

  private cleanupMode(): Exclude<CleanupConfig["mode"], undefined> {
    return this.options.cleanup?.mode ?? (this.options.preserveExactWording ? "verbatim" : "none");
  }

  private cleanupOptions(context: DictationContext, mode: Exclude<CleanupConfig["mode"], undefined>) {
    const nested: CleanupConfig = this.options.cleanup ?? {};
    return {
      ...nested,
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
    };
  }

  private emit(event: LiveConversationEvent): void {
    this.options.onEvent?.(event);
  }

  private abortedError(): DictationError {
    return new DictationError("The live conversation was aborted.", {
      code: "LIVE_SESSION_ABORTED",
      cause: this.controller.signal.reason,
    });
  }

  private emitFailure(error: DictationError): void {
    if (this.failureEmitted) return;
    this.failureEmitted = true;
    if (error.code === "LIVE_SESSION_ABORTED") {
      this.emit({ type: "live.canceled", reason: error.message, code: "LIVE_SESSION_ABORTED" });
    } else {
      this.emit({ type: "live.failed", error: error.message, code: error.code });
    }
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

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 1) {
    throw new DictationError(`${name} must be a positive number.`, {
      code: "INVALID_LIVE_BACKPRESSURE",
    });
  }
  return Math.floor(resolved);
}

function cleanupWindowLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_LIVE_CLEANUP_WINDOW_CHARS;
  if (!Number.isFinite(resolved) || resolved < 1) {
    throw new DictationError("cleanupWindowChars must be a positive number.", {
      code: "INVALID_LIVE_CLEANUP_WINDOW",
    });
  }
  return Math.floor(resolved);
}

function splitCleanupWindows(text: string, maximumChars: number): string[] {
  if (text.length <= maximumChars) return [text];
  const windows: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maximumChars) {
    const candidate = remaining.slice(0, maximumChars);
    const boundary = Math.max(
      candidate.lastIndexOf("\n"),
      candidate.lastIndexOf(". "),
      candidate.lastIndexOf(" "),
    );
    const end = boundary > maximumChars * 0.6 ? boundary + 1 : maximumChars;
    windows.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) windows.push(remaining);
  return windows;
}

function mergeLiveWindow(previous: string, current: string, overlapBeforeMs: number): string {
  const left = previous.trim();
  const right = current.trim();
  if (!left) return right;
  if (!right) return left;
  if (overlapBeforeMs <= 0) return `${left} ${right}`;

  const leftWords = left.split(/\s+/);
  const rightWords = right.split(/\s+/);
  const maximumWords = Math.min(
    leftWords.length,
    rightWords.length,
    12,
    Math.max(1, Math.ceil(overlapBeforeMs / 150)),
  );
  for (let count = maximumWords; count > 0; count -= 1) {
    const suffix = leftWords.slice(-count).map(normalizeWord);
    const prefix = rightWords.slice(0, count).map(normalizeWord);
    if (suffix.every((word, index) => Boolean(word) && word === prefix[index])) {
      return [...leftWords, ...rightWords.slice(count)].join(" ").trim();
    }
  }

  if (isUnspacedText(left) && isUnspacedText(right)) {
    // Without word timestamps, any character-only match can be coincidental. Retaining a
    // duplicated boundary is recoverable; deleting distinct dictated speech is not.
    return `${left}${right}`;
  }
  return `${left} ${right}`;
}

function normalizeWord(word: string): string {
  return word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function isUnspacedText(text: string): boolean {
  return !/\s/u.test(text) &&
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u.test(text);
}
