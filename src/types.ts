export type TranscriptionModel = "whisper-large-v3-turbo" | "whisper-large-v3" | (string & {});
export type CleanupModel = "openai/gpt-oss-20b" | "qwen/qwen3.6-27b" | (string & {});

export interface AudioInput {
  data: Blob;
  filename?: string;
}

export interface DictationContext {
  /** Human-readable description of the destination, such as "Slack reply to Alex". */
  activity?: string;
  appName?: string;
  fieldType?: "chat" | "email" | "document" | "code" | "search" | "other";
  selectedText?: string;
}

export type ContextProvider = () => DictationContext | Promise<DictationContext>;

export interface TranscriptionOptions {
  model?: TranscriptionModel;
  /** ISO-639-1 language code. Supplying it can improve latency and accuracy. */
  language?: string;
  /** Up to 224 tokens of vocabulary/spelling guidance for Whisper. */
  prompt?: string;
  signal?: AbortSignal;
}

export interface CleanupOptions {
  model?: CleanupModel;
  fallbackModel?: CleanupModel | false;
  context?: DictationContext;
  vocabulary?: readonly string[];
  outputLanguage?: string;
  preserveExactWording?: boolean;
  signal?: AbortSignal;
}

export interface DictationOptions {
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
}

export type PipelineEvent =
  | { type: "session.started" }
  | { type: "transcription.started" }
  | { type: "transcription.completed"; durationMs: number; text: string }
  | { type: "cleanup.started" }
  | { type: "cleanup.completed"; durationMs: number; text: string; model: string }
  | { type: "pipeline.completed"; result: DictationResult };

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DictationClientOptions {
  apiKey: string;
  baseUrl?: string;
  transcriptionModel?: TranscriptionModel;
  cleanupModel?: CleanupModel;
  cleanupFallbackModel?: CleanupModel | false;
  timeoutMs?: number;
  fetch?: FetchLike;
  onEvent?: (event: PipelineEvent) => void;
  /** Required for direct browser usage. Never enable this with a shared production key. */
  dangerouslyAllowBrowser?: boolean;
}

export interface BrowserRecorderOptions {
  mediaStreamConstraints?: MediaStreamConstraints;
  mimeTypes?: readonly string[];
  audioBitsPerSecond?: number;
  timesliceMs?: number;
}

export interface BrowserRecording {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  filename: string;
}
