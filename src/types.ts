export type TranscriptionModel = "whisper-large-v3-turbo" | "whisper-large-v3" | (string & {});
export type CleanupModel = "openai/gpt-oss-20b" | "qwen/qwen3.6-27b" | (string & {});
export type TranscriptionResponseFormat = "verbose_json" | "json" | "text" | "srt" | "vtt" | (string & {});

export interface CleanupMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type CleanupMessageBuilder = (
  transcript: string,
  context: DictationContext,
  options: CleanupConfig,
) => readonly CleanupMessage[];

export interface AudioInput {
  data: Blob;
  filename?: string;
  /** Known duration, when supplied by the recorder or upload metadata. */
  durationMs?: number;
}

export type CleanupMode = "dictation" | "verbatim" | "none" | "summary";

export interface AudioMetadata {
  sizeBytes: number;
  mimeType: string;
  filename: string;
  durationMs?: number;
  sampleRate?: number;
  channels?: number;
  codec?: string;
  /** SHA-256 over size plus bounded head/tail bytes, used to reject mismatched resumes. */
  fingerprint?: string;
}

export interface DictationContext {
  /** Human-readable description of the destination, such as "Slack reply to Alex". */
  activity?: string;
  appName?: string;
  fieldType?: "chat" | "email" | "document" | "code" | "search" | "other";
  selectedText?: string;
}

export type ContextProvider = () => DictationContext | Promise<DictationContext>;

export interface TranscriptionConfig {
  /** ISO-639-1 language code. Supplying it can improve latency and accuracy. */
  language?: string;
  /** Up to 224 tokens of vocabulary/spelling guidance for Whisper. */
  prompt?: string;
  temperature?: number;
  responseFormat?: TranscriptionResponseFormat;
  /** Exact phrases filtered when Whisper also reports likely silence. Use [] to disable the phrase list. */
  hallucinationPhrases?: readonly string[];
  hallucinationNoSpeechThreshold?: number;
  filterHallucinations?: boolean;
  timestampGranularities?: readonly ("segment" | "word")[];
}

export interface TranscriptionOptions extends TranscriptionConfig {
  model?: TranscriptionModel;
  signal?: AbortSignal;
}

export interface CleanupConfig {
  /** Cleanup product. Existing short dictation defaults to `dictation`. */
  mode?: CleanupMode;
  vocabulary?: readonly string[];
  outputLanguage?: string;
  preserveExactWording?: boolean;
  /** Replaces the built-in cleanup system prompt. */
  systemPrompt?: string;
  /** Replaces the built-in cleanup message construction entirely. */
  messageBuilder?: CleanupMessageBuilder;
  temperature?: number;
  maxCompletionTokens?: number;
  /** Set false to omit reasoning_effort. Defaults to low for GPT-OSS models. */
  reasoningEffort?: string | false;
  includeReasoning?: boolean;
  /** Set false to disable conversion of the sentinel response to an empty string. */
  emptyResponseToken?: string | false;
  stripThinkTags?: boolean;
  /** Reject cleanup when it removes more than this fraction of words. */
  maxDeletionRatio?: number;
  /** Reject cleanup when output expands beyond this multiple. */
  maxExpansionRatio?: number;
  /** Reject cleanup that changes numbers, URLs, email addresses, or digit-bearing identifiers. */
  preserveProtectedTerms?: boolean;
}

export interface CleanupOptions extends CleanupConfig {
  model?: CleanupModel;
  fallbackModel?: CleanupModel | false;
  context?: DictationContext;
  signal?: AbortSignal;
}

export interface DictationOptions {
  /** Per-dictation transcription overrides. Flat legacy options below take precedence. */
  transcription?: TranscriptionConfig;
  /** Per-dictation cleanup overrides. Flat legacy options below take precedence. */
  cleanup?: CleanupConfig;
  transcriptionModel?: TranscriptionModel;
  cleanupModel?: CleanupModel;
  fallbackModel?: CleanupModel | false;
  language?: string;
  prompt?: string;
  vocabulary?: readonly string[];
  outputLanguage?: string;
  preserveExactWording?: boolean;
  signal?: AbortSignal;
  context?: DictationContext | ContextProvider | Promise<DictationContext>;
}

export interface PipelineTimings {
  contextMs: number;
  transcriptionMs: number;
  cleanupMs: number;
  totalMs: number;
}

export interface TranscriptionSegment {
  text?: string;
  start?: number;
  end?: number;
  no_speech_prob?: number;
  avg_logprob?: number;
  compression_ratio?: number;
}

export interface TranscriptionResult {
  text: string;
  model: string;
  segments: readonly TranscriptionSegment[];
  filteredAsSilence: boolean;
}

export interface CleanupResult {
  text: string;
  model: string;
  usedFallback: boolean;
  rejected?: boolean;
}

export interface DictationResult {
  text: string;
  rawTranscript: string;
  transcriptionModel: string;
  cleanupModel?: string;
  usedCleanupFallback: boolean;
  filteredAsSilence: boolean;
  context: DictationContext;
  timings: PipelineTimings;
  /** True when unsafe cleanup output was rejected and raw text was returned. */
  cleanupRejected?: boolean;
}

export type PipelineEvent =
  | { type: "session.started" }
  | { type: "transcription.started" }
  | { type: "transcription.completed"; durationMs: number; text: string }
  | { type: "cleanup.started" }
  | { type: "cleanup.completed"; durationMs: number; text: string; model: string }
  | { type: "pipeline.completed"; result: DictationResult };

export interface RetryConfig {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface TimeoutPolicy {
  /** Minimum timeout for any provider request. */
  minimumMs?: number;
  /** Maximum timeout after adapting to audio duration/size. */
  maximumMs?: number;
  /** Additional milliseconds per second of known audio. */
  perAudioSecondMs?: number;
  /** Additional milliseconds per MiB when duration is unknown. */
  perMiBMs?: number;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DictationClientOptions {
  apiKey: string;
  baseUrl?: string;
  transcriptionModel?: TranscriptionModel;
  cleanupModel?: CleanupModel;
  cleanupFallbackModel?: CleanupModel | false;
  timeoutMs?: number;
  timeoutPolicy?: TimeoutPolicy;
  retry?: RetryConfig;
  /** Conservative direct multipart limit. Larger inputs require the long-audio API. */
  directUploadMaxBytes?: number;
  /** Defaults applied to every transcription request. */
  transcription?: TranscriptionConfig;
  /** Defaults applied to every cleanup request. */
  cleanup?: CleanupConfig;
  fetch?: FetchLike;
  onEvent?: (event: PipelineEvent) => void;
  /** Required for direct browser usage. Never enable this with a shared production key. */
  dangerouslyAllowBrowser?: boolean;
  /** Prevent construction-time Batch use because Groq Batch retains artifacts. */
  zeroDataRetention?: boolean;
}

export interface BrowserRecorderOptions {
  mediaStreamConstraints?: MediaStreamConstraints;
  mimeTypes?: readonly string[];
  audioBitsPerSecond?: number;
  timesliceMs?: number;
  /** Receives MediaRecorder transport fragments as recording proceeds. Fragments are not guaranteed to be independently playable. */
  onChunk?: (chunk: Blob, sequence: number) => void | Promise<void>;
  /** Keep fragments for stop().blob in addition to streaming them. Defaults to true. */
  retainAudio?: boolean;
}

export interface BrowserRecording {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  filename: string;
  chunkCount?: number;
  retainedAudio?: boolean;
}

export interface StoredAudio {
  key: string;
  sizeBytes: number;
  contentType: string;
}

export interface ObjectStorage {
  put(key: string, audio: AudioInput): Promise<StoredAudio>;
  createSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
  delete?(key: string): Promise<void>;
}

export interface StorageTranscriptionOptions extends TranscriptionOptions {
  key?: string;
  signedUrlExpiresInSeconds?: number;
  /** Remove the temporary object after the provider request. Defaults to true. */
  deleteAfter?: boolean;
}

export interface StorageTranscriptionResult extends TranscriptionResult {
  storageKey: string;
}
