import { DictationError } from "./errors.js";
import {
  DEFAULT_CLEANUP_FALLBACK_MODEL,
  DEFAULT_CLEANUP_MODEL,
  DEFAULT_CLEANUP_TEMPERATURE,
  DEFAULT_EMPTY_RESPONSE_TOKEN,
  DEFAULT_FILTER_HALLUCINATIONS,
  DEFAULT_GROQ_BASE_URL,
  DEFAULT_HALLUCINATION_NO_SPEECH_THRESHOLD,
  DEFAULT_HALLUCINATION_PHRASES,
  DEFAULT_INCLUDE_REASONING,
  DEFAULT_MAX_COMPLETION_TOKENS,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STRIP_THINK_TAGS,
  DEFAULT_TRANSCRIPTION_MODEL,
  DEFAULT_TRANSCRIPTION_RESPONSE_FORMAT,
  DEFAULT_TRANSCRIPTION_TEMPERATURE,
} from "./defaults.js";
import { buildCleanupMessages } from "./prompts.js";
import type {
  AudioInput,
  CleanupConfig,
  CleanupOptions,
  CleanupResult,
  DictationClientOptions,
  FetchLike,
  TranscriptionOptions,
  TranscriptionResult,
  TranscriptionSegment,
  TranscriptionConfig,
} from "./types.js";

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
  private readonly transcriptionConfig: TranscriptionConfig;
  private readonly cleanupConfig: CleanupConfig;

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
    this.baseUrl = (options.baseUrl ?? DEFAULT_GROQ_BASE_URL).replace(/\/+$/, "");
    this.transcriptionModel = options.transcriptionModel ?? DEFAULT_TRANSCRIPTION_MODEL;
    this.cleanupModel = options.cleanupModel ?? DEFAULT_CLEANUP_MODEL;
    this.cleanupFallbackModel = options.cleanupFallbackModel ?? DEFAULT_CLEANUP_FALLBACK_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.transcriptionConfig = options.transcription ?? {};
    this.cleanupConfig = options.cleanup ?? {};
  }

  async transcribe(audio: AudioInput, options: TranscriptionOptions = {}): Promise<TranscriptionResult> {
    const requestOptions: TranscriptionConfig = { ...this.transcriptionConfig, ...options };
    const form = new FormData();
    const filename = audio.filename ?? filenameForMime(audio.data.type);
    form.append("file", audio.data, filename);
    const model = options.model ?? this.transcriptionModel;
    const responseFormat = requestOptions.responseFormat ?? DEFAULT_TRANSCRIPTION_RESPONSE_FORMAT;
    form.append("model", model);
    form.append("response_format", responseFormat);
    form.append("temperature", String(requestOptions.temperature ?? DEFAULT_TRANSCRIPTION_TEMPERATURE));
    if (requestOptions.language?.trim()) form.append("language", requestOptions.language.trim());
    if (requestOptions.prompt?.trim()) form.append("prompt", requestOptions.prompt.trim());

    const response = await this.request(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    const json: GroqTranscriptionResponse = responseFormat === "verbose_json" || responseFormat === "json"
      ? await parseJson<GroqTranscriptionResponse>(response)
      : { text: await response.text() };
    const rawText = json.text?.trim();
    if (rawText === undefined) {
      throw new DictationError("Groq returned no transcription text.", {
        code: "INVALID_TRANSCRIPTION_RESPONSE",
        details: json,
      });
    }
    const segments = json.segments ?? [];
    const filteredAsSilence = isLikelySilenceHallucination(rawText, segments, requestOptions);
    return {
      text: filteredAsSilence ? "" : rawText,
      model,
      segments,
      filteredAsSilence,
    };
  }

  async cleanup(transcript: string, options: CleanupOptions = {}): Promise<CleanupResult> {
    const requestOptions: CleanupOptions = { ...this.cleanupConfig, ...options };
    const trimmed = transcript.trim();
    const primary = requestOptions.model ?? this.cleanupModel;
    if (!trimmed) return { text: "", model: primary, usedFallback: false };

    try {
      const text = await this.runCleanup(trimmed, primary, requestOptions);
      return { text, model: primary, usedFallback: false };
    } catch (error) {
      const fallback = requestOptions.fallbackModel === undefined
        ? this.cleanupFallbackModel
        : requestOptions.fallbackModel;
      if (!fallback || fallback === primary || !isFallbackEligible(error)) throw error;
      const text = await this.runCleanup(trimmed, fallback, requestOptions);
      return { text, model: fallback, usedFallback: true };
    }
  }

  private async runCleanup(transcript: string, model: string, options: CleanupOptions): Promise<string> {
    const promptOptions: CleanupConfig = options;
    const context = options.context ?? {};
    const messages = options.messageBuilder
      ? options.messageBuilder(transcript, context, promptOptions)
      : buildCleanupMessages(transcript, context, promptOptions);
    const body: Record<string, unknown> = {
      model,
      temperature: options.temperature ?? DEFAULT_CLEANUP_TEMPERATURE,
      messages,
      max_completion_tokens: options.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
    };
    if (model.startsWith("openai/gpt-oss-")) {
      const reasoningEffort = options.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
      if (reasoningEffort !== false) body.reasoning_effort = reasoningEffort;
      body.include_reasoning = options.includeReasoning ?? DEFAULT_INCLUDE_REASONING;
    } else {
      if (options.reasoningEffort !== undefined && options.reasoningEffort !== false) {
        body.reasoning_effort = options.reasoningEffort;
      }
      if (options.includeReasoning !== undefined) body.include_reasoning = options.includeReasoning;
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
    const emptyResponseToken = options.emptyResponseToken === undefined
      ? DEFAULT_EMPTY_RESPONSE_TOKEN
      : options.emptyResponseToken;
    if (emptyResponseToken !== false && content === emptyResponseToken) return "";
    const shouldStripThinkTags = options.stripThinkTags ?? DEFAULT_STRIP_THINK_TAGS;
    return shouldStripThinkTags ? stripThinkTags(content) : content;
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

function isLikelySilenceHallucination(
  text: string,
  segments: readonly TranscriptionSegment[],
  options: TranscriptionConfig,
): boolean {
  const shouldFilter = options.filterHallucinations ?? DEFAULT_FILTER_HALLUCINATIONS;
  if (!shouldFilter) return false;
  const phrases = new Set(
    (options.hallucinationPhrases ?? DEFAULT_HALLUCINATION_PHRASES).map(normalizePhrase),
  );
  if (!phrases.has(normalizePhrase(text))) return false;
  return (segments[0]?.no_speech_prob ?? 0) >= (
    options.hallucinationNoSpeechThreshold ?? DEFAULT_HALLUCINATION_NO_SPEECH_THRESHOLD
  );
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
