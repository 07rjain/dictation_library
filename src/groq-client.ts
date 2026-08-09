import { DictationError } from "./errors.js";
import { buildCleanupMessages } from "./prompts.js";
import type {
  AudioInput,
  CleanupOptions,
  CleanupResult,
  DictationClientOptions,
  FetchLike,
  TranscriptionOptions,
  TranscriptionResult,
  TranscriptionSegment,
} from "./types.js";

const HALLUCINATION_PHRASES = new Set([
  "thank you",
  "thank you for watching",
  "thank you very much",
  "thank you so much",
  "thanks for watching",
  "please subscribe",
  "like and subscribe",
  "subtitles by",
  "subtitles by the amara.org community",
  "you",
]);

interface GroqTranscriptionResponse {
  text?: string;
  segments?: TranscriptionSegment[];
}

interface GroqChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class GroqClient {
  readonly transcriptionModel: string;
  readonly cleanupModel: string;
  readonly cleanupFallbackModel: string | false;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: DictationClientOptions) {
    if (!options.apiKey.trim()) {
      throw new DictationError("A Groq API key is required.", { code: "MISSING_API_KEY" });
    }
    if (typeof window !== "undefined" && !options.dangerouslyAllowBrowser) {
      throw new DictationError(
        "Refusing to expose a Groq key in a browser bundle. Call the pipeline on your server, or explicitly set dangerouslyAllowBrowser for a local BYOK prototype.",
        { code: "BROWSER_API_KEY_BLOCKED" },
      );
    }
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? "https://api.groq.com/openai/v1").replace(/\/+$/, "");
    this.transcriptionModel = options.transcriptionModel ?? "whisper-large-v3-turbo";
    this.cleanupModel = options.cleanupModel ?? "openai/gpt-oss-20b";
    this.cleanupFallbackModel = options.cleanupFallbackModel ?? "qwen/qwen3.6-27b";
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async transcribe(audio: AudioInput, options: TranscriptionOptions = {}): Promise<TranscriptionResult> {
    const form = new FormData();
    const filename = audio.filename ?? filenameForMime(audio.data.type);
    form.append("file", audio.data, filename);
    const model = options.model ?? this.transcriptionModel;
    form.append("model", model);
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");
    if (options.language?.trim()) form.append("language", options.language.trim());
    if (options.prompt?.trim()) form.append("prompt", options.prompt.trim());

    const response = await this.request(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    const json = await parseJson<GroqTranscriptionResponse>(response);
    const rawText = json.text?.trim();
    if (rawText === undefined) {
      throw new DictationError("Groq returned no transcription text.", {
        code: "INVALID_TRANSCRIPTION_RESPONSE",
        details: json,
      });
    }
    const segments = json.segments ?? [];
    const filteredAsSilence = isLikelySilenceHallucination(rawText, segments);
    return {
      text: filteredAsSilence ? "" : rawText,
      model,
      segments,
      filteredAsSilence,
    };
  }

  async cleanup(transcript: string, options: CleanupOptions = {}): Promise<CleanupResult> {
    const trimmed = transcript.trim();
    const primary = options.model ?? this.cleanupModel;
    if (!trimmed) return { text: "", model: primary, usedFallback: false };

    try {
      const text = await this.runCleanup(trimmed, primary, options);
      return { text, model: primary, usedFallback: false };
    } catch (error) {
      const fallback = options.fallbackModel === undefined
        ? this.cleanupFallbackModel
        : options.fallbackModel;
      if (!fallback || fallback === primary || !isFallbackEligible(error)) throw error;
      const text = await this.runCleanup(trimmed, fallback, options);
      return { text, model: fallback, usedFallback: true };
    }
  }

  private async runCleanup(transcript: string, model: string, options: CleanupOptions): Promise<string> {
    const body: Record<string, unknown> = {
      model,
      temperature: 0,
      messages: buildCleanupMessages(transcript, options.context ?? {}, options),
      max_completion_tokens: 4096,
    };
    if (model.startsWith("openai/gpt-oss-")) {
      body.reasoning_effort = "low";
      body.include_reasoning = false;
    }
    const response = await this.request(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    const json = await parseJson<GroqChatResponse>(response);
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new DictationError("Groq returned an empty cleanup response.", {
        code: "EMPTY_CLEANUP_RESPONSE",
        details: json,
      });
    }
    return content === "EMPTY" ? "" : stripThinkTags(content);
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(new Error("Request timed out")), this.timeoutMs);
    const signal = combineSignals(init.signal, timeoutController.signal);
    try {
      const response = await this.fetchImpl(url, { ...init, signal });
      if (!response.ok) {
        const details = await response.text().catch(() => "");
        throw new DictationError(`Groq request failed with HTTP ${response.status}.`, {
          code: response.status === 429 ? "RATE_LIMITED" : "GROQ_REQUEST_FAILED",
          status: response.status,
          details,
        });
      }
      return response;
    } catch (error) {
      if (error instanceof DictationError) throw error;
      const timedOut = timeoutController.signal.aborted;
      throw new DictationError(timedOut ? "Groq request timed out." : "Groq request failed.", {
        code: timedOut ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function filenameForMime(mime: string): string {
  if (mime.includes("wav")) return "dictation.wav";
  if (mime.includes("ogg")) return "dictation.ogg";
  if (mime.includes("mp4") || mime.includes("m4a")) return "dictation.m4a";
  return "dictation.webm";
}

function normalizePhrase(text: string): string {
  return text.toLowerCase().replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
}

function isLikelySilenceHallucination(text: string, segments: readonly TranscriptionSegment[]): boolean {
  if (!HALLUCINATION_PHRASES.has(normalizePhrase(text))) return false;
  return (segments[0]?.no_speech_prob ?? 0) >= 0.1;
}

function stripThinkTags(text: string): string {
  return text.replace(/^\s*(?:<think>[\s\S]*?<\/think>\s*)+/i, "").trim();
}

function isFallbackEligible(error: unknown): boolean {
  return error instanceof DictationError && (
    error.code === "RATE_LIMITED" ||
    error.code === "EMPTY_CLEANUP_RESPONSE" ||
    (error.status !== undefined && error.status >= 500)
  );
}

function combineSignals(...signals: Array<AbortSignal | null | undefined>): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return new AbortController().signal;
  if (active.length === 1) return active[0]!;
  return AbortSignal.any(active);
}

async function parseJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch (cause) {
    throw new DictationError("Groq returned invalid JSON.", {
      code: "INVALID_JSON_RESPONSE",
      cause,
    });
  }
}
