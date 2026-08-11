import { DictationError } from "./errors.js";
import { assertDirectUploadSize, inspectAudio } from "./audio.js";
import {
  DEFAULT_CLEANUP_MAX_DELETION_RATIO,
  DEFAULT_CLEANUP_MAX_EXPANSION_RATIO,
  DEFAULT_DICTATION_MAX_DELETION_RATIO,
  DEFAULT_DICTATION_MAX_EXPANSION_RATIO,
  DEFAULT_CLEANUP_FALLBACK_MODEL,
  DEFAULT_CLEANUP_MODEL,
  DEFAULT_CLEANUP_TEMPERATURE,
  DEFAULT_DIRECT_UPLOAD_MAX_BYTES,
  DEFAULT_EMPTY_RESPONSE_TOKEN,
  DEFAULT_FILTER_HALLUCINATIONS,
  DEFAULT_GROQ_BASE_URL,
  DEFAULT_HALLUCINATION_NO_SPEECH_THRESHOLD,
  DEFAULT_HALLUCINATION_PHRASES,
  DEFAULT_INCLUDE_REASONING,
  DEFAULT_MAX_COMPLETION_TOKENS,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_ATTEMPTS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STRIP_THINK_TAGS,
  DEFAULT_TRANSCRIPTION_MODEL,
  DEFAULT_TRANSCRIPTION_RESPONSE_FORMAT,
  DEFAULT_TRANSCRIPTION_TEMPERATURE,
  DEFAULT_VERBATIM_MAX_DELETION_RATIO,
  DEFAULT_VERBATIM_MAX_EXPANSION_RATIO,
  DEFAULT_TIMEOUT_MAXIMUM_MS,
  DEFAULT_TIMEOUT_MINIMUM_MS,
  DEFAULT_TIMEOUT_PER_AUDIO_SECOND_MS,
  DEFAULT_TIMEOUT_PER_MIB_MS,
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
  TimeoutPolicy,
  RetryConfig,
  ProviderAttemptEvent,
  CleanupGuardReport,
  CleanupMode,
  RateLimitSnapshot,
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
  private readonly timeoutPolicy: Required<TimeoutPolicy>;
  private readonly retryConfig: Required<RetryConfig>;
  private readonly directUploadMaxBytes: number;
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
    this.timeoutPolicy = {
      minimumMs: options.timeoutPolicy?.minimumMs ?? this.timeoutMs ?? DEFAULT_TIMEOUT_MINIMUM_MS,
      maximumMs: options.timeoutPolicy?.maximumMs ?? Math.max(this.timeoutMs, DEFAULT_TIMEOUT_MAXIMUM_MS),
      perAudioSecondMs: options.timeoutPolicy?.perAudioSecondMs ?? DEFAULT_TIMEOUT_PER_AUDIO_SECOND_MS,
      perMiBMs: options.timeoutPolicy?.perMiBMs ?? DEFAULT_TIMEOUT_PER_MIB_MS,
    };
    this.retryConfig = {
      maxAttempts: options.retry?.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
      baseDelayMs: options.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
      maxDelayMs: options.retry?.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
    };
    this.directUploadMaxBytes = options.directUploadMaxBytes ?? DEFAULT_DIRECT_UPLOAD_MAX_BYTES;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.transcriptionConfig = options.transcription ?? {};
    this.cleanupConfig = options.cleanup ?? {};
  }

  async transcribe(audio: AudioInput, options: TranscriptionOptions = {}): Promise<TranscriptionResult> {
    const metadata = await inspectAudio(audio);
    assertDirectUploadSize(metadata, this.directUploadMaxBytes);
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
    for (const granularity of requestOptions.timestampGranularities ?? []) {
      form.append("timestamp_granularities[]", granularity);
    }

    const response = await this.request(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }, {
      ...(metadata.durationMs !== undefined ? { audioDurationMs: metadata.durationMs } : {}),
      audioSizeBytes: metadata.sizeBytes,
      ...(options.onProviderAttempt ? { onProviderAttempt: options.onProviderAttempt } : {}),
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

  /** Transcribe an HTTPS object-storage URL without attaching the audio to the request. */
  async transcribeUrl(url: string, options: TranscriptionOptions = {}): Promise<TranscriptionResult> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (cause) {
      throw new DictationError("Audio URL is invalid.", { code: "INVALID_AUDIO_URL", cause });
    }
    if (parsed.protocol !== "https:") {
      throw new DictationError("Audio URL must use HTTPS.", { code: "INSECURE_AUDIO_URL" });
    }
    const requestOptions: TranscriptionConfig = { ...this.transcriptionConfig, ...options };
    const form = new FormData();
    const model = options.model ?? this.transcriptionModel;
    const responseFormat = requestOptions.responseFormat ?? DEFAULT_TRANSCRIPTION_RESPONSE_FORMAT;
    form.append("url", parsed.toString());
    form.append("model", model);
    form.append("response_format", responseFormat);
    form.append("temperature", String(requestOptions.temperature ?? DEFAULT_TRANSCRIPTION_TEMPERATURE));
    if (requestOptions.language?.trim()) form.append("language", requestOptions.language.trim());
    if (requestOptions.prompt?.trim()) form.append("prompt", requestOptions.prompt.trim());
    for (const granularity of requestOptions.timestampGranularities ?? []) {
      form.append("timestamp_granularities[]", granularity);
    }
    const response = await this.request(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }, {
      ...(options.audioDurationMs !== undefined ? { audioDurationMs: options.audioDurationMs } : {}),
      ...(options.onProviderAttempt ? { onProviderAttempt: options.onProviderAttempt } : {}),
    });
    return parseTranscriptionResponse(response, responseFormat, model, requestOptions);
  }

  async cleanup(transcript: string, options: CleanupOptions = {}): Promise<CleanupResult> {
    const requestOptions: CleanupOptions = { ...this.cleanupConfig, ...options };
    const trimmed = transcript.trim();
    const primary = requestOptions.model ?? this.cleanupModel;
    if (!trimmed) return { text: "", model: primary, usedFallback: false };
    if (requestOptions.mode === "none") return { text: trimmed, model: "none", usedFallback: false };

    try {
      const output = await this.runCleanup(trimmed, primary, requestOptions);
      const guarded = guardCleanup(trimmed, output, requestOptions);
      return { text: guarded.text, model: primary, usedFallback: false, rejected: guarded.rejected, guard: guarded.guard };
    } catch (error) {
      const fallback = requestOptions.fallbackModel === undefined
        ? this.cleanupFallbackModel
        : requestOptions.fallbackModel;
      if (!fallback || fallback === primary || !isFallbackEligible(error)) throw error;
      const output = await this.runCleanup(trimmed, fallback, requestOptions);
      const guarded = guardCleanup(trimmed, output, requestOptions);
      return { text: guarded.text, model: fallback, usedFallback: true, rejected: guarded.rejected, guard: guarded.guard };
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
    }, { retry: false });
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

  private async request(
    url: string,
    init: RequestInit,
    metadata: {
      audioDurationMs?: number;
      audioSizeBytes?: number;
      retry?: boolean;
      onProviderAttempt?: (event: ProviderAttemptEvent) => void;
    } = {},
  ): Promise<Response> {
    const timeoutMs = this.requestTimeoutMs(metadata);
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt += 1) {
      emitProviderAttempt(metadata.onProviderAttempt, { attempt, outcome: "started" });
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => timeoutController.abort(new Error("Request timed out")), timeoutMs);
      const signal = combineSignals(init.signal, timeoutController.signal);
      try {
        const response = await this.fetchImpl(url, { ...init, signal });
        const rateLimit = parseRateLimitHeaders(response.headers);
        if (response.ok) {
          emitProviderAttempt(metadata.onProviderAttempt, { attempt, outcome: "succeeded", ...(rateLimit ? { rateLimit } : {}) });
          return response;
        }
        const details = await response.text().catch(() => "");
        const error = new DictationError(`Groq request failed with HTTP ${response.status}.`, {
          code: response.status === 429 ? "RATE_LIMITED" : "GROQ_REQUEST_FAILED",
          status: response.status,
          details,
        });
        if (metadata.retry === false || !isRetryableStatus(response.status) || attempt === this.retryConfig.maxAttempts) {
          emitProviderAttempt(metadata.onProviderAttempt, { attempt, outcome: "failed", status: response.status, ...(rateLimit ? { rateLimit } : {}) });
          throw error;
        }
        lastError = error;
        const retryAfter = response.headers.get("retry-after");
        const retryAfterMs = retryDelayMs(retryAfter, attempt, this.retryConfig);
        emitProviderAttempt(metadata.onProviderAttempt, {
          attempt,
          outcome: "retrying",
          status: response.status,
          retryAfterMs,
          providerDirectedDelay: retryAfter !== null,
          ...(rateLimit ? { rateLimit } : {}),
        });
        await delay(retryAfterMs, init.signal);
      } catch (error) {
        if (init.signal?.aborted) throw error;
        const timedOut = timeoutController.signal.aborted;
        const normalized = error instanceof DictationError
          ? error
          : new DictationError(timedOut ? "Groq request timed out." : "Groq request failed.", {
            code: timedOut ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
            cause: error,
          });
        if (!(error instanceof DictationError && error.status !== undefined)) {
          emitProviderAttempt(metadata.onProviderAttempt, {
            attempt,
            outcome: timedOut || normalized.code === "NETWORK_ERROR" ? "unknown" : "failed",
            ...(normalized.status !== undefined ? { status: normalized.status } : {}),
          });
        }
        if (metadata.retry === false || !isRetryableError(normalized) || attempt === this.retryConfig.maxAttempts) throw normalized;
        lastError = normalized;
        await delay(retryDelayMs(null, attempt, this.retryConfig), init.signal);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  private requestTimeoutMs(metadata: { audioDurationMs?: number; audioSizeBytes?: number }): number {
    const durationExtra = metadata.audioDurationMs === undefined
      ? 0
      : (metadata.audioDurationMs / 1000) * this.timeoutPolicy.perAudioSecondMs;
    const sizeExtra = metadata.audioSizeBytes === undefined
      ? 0
      : (metadata.audioSizeBytes / (1024 * 1024)) * this.timeoutPolicy.perMiBMs;
    const base = Math.max(this.timeoutPolicy.minimumMs, this.timeoutMs);
    const adaptiveExtra = metadata.audioDurationMs === undefined ? sizeExtra : durationExtra;
    return Math.min(this.timeoutPolicy.maximumMs, base + adaptiveExtra);
  }
}

function emitProviderAttempt(
  listener: ((event: ProviderAttemptEvent) => void) | undefined,
  event: ProviderAttemptEvent,
): void {
  try {
    listener?.(event);
  } catch {
    // Observability callbacks must never alter provider request behavior.
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

async function parseTranscriptionResponse(
  response: Response,
  responseFormat: string,
  model: string,
  options: TranscriptionConfig,
): Promise<TranscriptionResult> {
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
  const filteredAsSilence = isLikelySilenceHallucination(rawText, segments, options);
  return { text: filteredAsSilence ? "" : rawText, model, segments, filteredAsSilence };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isRetryableError(error: DictationError): boolean {
  return error.code === "NETWORK_ERROR" || error.code === "REQUEST_TIMEOUT" ||
    (error.status !== undefined && isRetryableStatus(error.status));
}

function retryDelayMs(header: string | null, attempt: number, config: Required<RetryConfig>): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const exponential = config.baseDelayMs * 2 ** (attempt - 1);
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.min(config.maxDelayMs, exponential * jitter);
}

function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function guardCleanup(
  transcript: string,
  cleaned: string,
  options: CleanupOptions,
): { text: string; rejected: boolean; guard: CleanupGuardReport } {
  const mode = options.mode ?? "dictation";
  const sourceWords = words(transcript);
  const outputWords = words(cleaned);
  const deletionRatio = sourceWords.length === 0 ? 0 : Math.max(0, (sourceWords.length - outputWords.length) / sourceWords.length);
  const expansionRatio = sourceWords.length === 0 ? 1 : outputWords.length / sourceWords.length;
  const thresholds = cleanupThresholds(mode, options);
  const protectedTermsChanged = options.preserveProtectedTerms !== false && !sameMultiset(
    protectedTerms(transcript),
    protectedTerms(cleaned),
  );
  const namedEntitiesChanged = options.preserveNamedEntities !== false && !containsMultiset(
    namedEntities(transcript, options.vocabulary),
    namedEntities(cleaned, options.vocabulary),
  );
  const changedStableSegmentIds = (options.stableSegments ?? [])
    .filter((segment) => segment.text.trim() && !containsNormalizedSequence(cleaned, segment.text))
    .map((segment) => segment.id);
  const reasons: CleanupGuardReport["reasons"][number][] = [];
  const defaultDictationFillerAllowance = mode === "dictation" && options.maxDeletionRatio === undefined &&
    sourceWords.length - outputWords.length <= 1;
  if (mode !== "summary" && cleaned.trim() !== "" && !defaultDictationFillerAllowance && deletionRatio > thresholds.deletion) {
    reasons.push("deletion-limit");
  }
  if (mode !== "summary" && expansionRatio > thresholds.expansion) reasons.push("expansion-limit");
  if (mode !== "summary" && cleaned.trim() !== "" && protectedTermsChanged) reasons.push("protected-terms-changed");
  if (mode !== "summary" && cleaned.trim() !== "" && namedEntitiesChanged) reasons.push("named-entities-changed");
  if (mode !== "summary" && cleaned.trim() !== "" && changedStableSegmentIds.length > 0) reasons.push("stable-segments-changed");
  const accepted = reasons.length === 0;
  const guard: CleanupGuardReport = {
    id: guardId(mode, transcript, cleaned),
    mode,
    accepted,
    reasons,
    sourceWordCount: sourceWords.length,
    outputWordCount: outputWords.length,
    deletionRatio,
    expansionRatio,
    maximumDeletionRatio: thresholds.deletion,
    maximumExpansionRatio: thresholds.expansion,
    protectedTermsChanged,
    namedEntitiesChanged,
    changedStableSegmentIds,
    diff: wordDiff(sourceWords, outputWords),
  };
  return { text: accepted ? cleaned : transcript, rejected: !accepted, guard };
}

function cleanupThresholds(mode: CleanupMode, options: CleanupOptions): { deletion: number; expansion: number } {
  if (mode === "verbatim") {
    return {
      deletion: options.maxDeletionRatio ?? DEFAULT_VERBATIM_MAX_DELETION_RATIO,
      expansion: options.maxExpansionRatio ?? DEFAULT_VERBATIM_MAX_EXPANSION_RATIO,
    };
  }
  if (mode === "dictation") {
    return {
      deletion: options.maxDeletionRatio ?? DEFAULT_DICTATION_MAX_DELETION_RATIO,
      expansion: options.maxExpansionRatio ?? DEFAULT_DICTATION_MAX_EXPANSION_RATIO,
    };
  }
  return {
    deletion: options.maxDeletionRatio ?? DEFAULT_CLEANUP_MAX_DELETION_RATIO,
    expansion: options.maxExpansionRatio ?? DEFAULT_CLEANUP_MAX_EXPANSION_RATIO,
  };
}

function words(text: string): string[] {
  return text.trim().match(/[\p{L}\p{N}_'-]+/gu) ?? [];
}

function protectedTerms(text: string): string[] {
  return text.match(/(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w.-]+\.\w+|\b[\w./:-]*\d[\w./:-]*\b/giu) ?? [];
}

function namedEntities(text: string, vocabulary: readonly string[] | undefined): string[] {
  const candidates = text.match(/(?:\b[\p{Lu}][\p{L}'’-]*\b(?:\s+\b[\p{Lu}][\p{L}'’-]*\b)*)|\b[\p{Lu}]{2,}\b/gu) ?? [];
  const sentenceInitials = new Set(
    (text.match(/(?:^|[.!?]\s+)([\p{Lu}][\p{L}'’-]*)/gu) ?? [])
      .map((value) => value.replace(/^[.!?]\s*/, "").toLocaleLowerCase()),
  );
  const normalized = candidates.flatMap((value) => {
    const parts = value.split(/\s+/);
    if (!sentenceInitials.has(parts[0]!.toLocaleLowerCase())) return [value];
    return parts.length > 1 ? [parts.slice(1).join(" ")] : [];
  });
  const vocabularyEntities = (vocabulary ?? []).filter((value) => value.trim());
  return [...normalized, ...vocabularyEntities];
}

function containsNormalizedSequence(haystack: string, needle: string): boolean {
  const source = words(haystack).map(normalizeWord).join(" ");
  const target = words(needle).map(normalizeWord).join(" ");
  return target.length > 0 && (` ${source} `).includes(` ${target} `);
}

function wordDiff(source: readonly string[], output: readonly string[]): CleanupGuardReport["diff"] {
  const removed = multisetDifference(source, output);
  const added = multisetDifference(output, source);
  const limit = 100;
  return {
    removed: removed.slice(0, limit),
    added: added.slice(0, limit),
    truncated: removed.length > limit || added.length > limit,
  };
}

function multisetDifference(left: readonly string[], right: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of right) counts.set(normalizeWord(value), (counts.get(normalizeWord(value)) ?? 0) + 1);
  return left.filter((value) => {
    const key = normalizeWord(value);
    const remaining = counts.get(key) ?? 0;
    if (remaining === 0) return true;
    counts.set(key, remaining - 1);
    return false;
  });
}

function guardId(mode: CleanupMode, source: string, output: string): string {
  let hash = 0x811c9dc5;
  for (const char of `${mode}\0${source}\0${output}`) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `cleanup-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function normalizeWord(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function parseRateLimitHeaders(headers: Headers): RateLimitSnapshot | undefined {
  const snapshot: RateLimitSnapshot = {
    observedAt: new Date().toISOString(),
    ...numberHeader(headers, "x-ratelimit-limit-requests", "limitRequests"),
    ...numberHeader(headers, "x-ratelimit-remaining-requests", "remainingRequests"),
    ...durationHeader(headers, "x-ratelimit-reset-requests", "resetRequestsMs"),
    ...numberHeader(headers, "x-ratelimit-limit-tokens", "limitTokens"),
    ...numberHeader(headers, "x-ratelimit-remaining-tokens", "remainingTokens"),
    ...durationHeader(headers, "x-ratelimit-reset-tokens", "resetTokensMs"),
  };
  return Object.keys(snapshot).length > 1 ? snapshot : undefined;
}

function numberHeader<K extends keyof RateLimitSnapshot>(headers: Headers, name: string, key: K): Partial<RateLimitSnapshot> {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return {};
  const value = Number(raw);
  return Number.isFinite(value) ? { [key]: value } as Partial<RateLimitSnapshot> : {};
}

function durationHeader<K extends keyof RateLimitSnapshot>(headers: Headers, name: string, key: K): Partial<RateLimitSnapshot> {
  const raw = headers.get(name)?.trim();
  if (!raw) return {};
  const match = raw.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
  const milliseconds = match
    ? ((Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1000)
    : Number(raw) * 1000;
  return Number.isFinite(milliseconds) ? { [key]: milliseconds } as Partial<RateLimitSnapshot> : {};
}

function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = left.map((value) => value.toLocaleLowerCase()).sort();
  const sortedRight = right.map((value) => value.toLocaleLowerCase()).sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function containsMultiset(required: readonly string[], available: readonly string[]): boolean {
  const counts = new Map<string, number>();
  for (const value of available) counts.set(normalizeWord(value), (counts.get(normalizeWord(value)) ?? 0) + 1);
  for (const value of required) {
    const key = normalizeWord(value);
    const remaining = counts.get(key) ?? 0;
    if (remaining === 0) return false;
    counts.set(key, remaining - 1);
  }
  return true;
}
