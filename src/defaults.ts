import type { CleanupModel, TranscriptionModel } from "./types.js";

export const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModel = "whisper-large-v3-turbo";
export const DEFAULT_CLEANUP_MODEL: CleanupModel = "openai/gpt-oss-20b";
export const DEFAULT_CLEANUP_FALLBACK_MODEL: CleanupModel = "qwen/qwen3.6-27b";
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

export const DEFAULT_TRANSCRIPTION_TEMPERATURE = 0;
export const DEFAULT_TRANSCRIPTION_RESPONSE_FORMAT = "verbose_json";
export const DEFAULT_FILTER_HALLUCINATIONS = true;
export const DEFAULT_HALLUCINATION_NO_SPEECH_THRESHOLD = 0.1;
export const DEFAULT_HALLUCINATION_PHRASES = Object.freeze([
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
] as const);

export const DEFAULT_CLEANUP_TEMPERATURE = 0;
export const DEFAULT_MAX_COMPLETION_TOKENS = 4096;
export const DEFAULT_REASONING_EFFORT = "low";
export const DEFAULT_INCLUDE_REASONING = false;
export const DEFAULT_EMPTY_RESPONSE_TOKEN = "EMPTY";
export const DEFAULT_STRIP_THINK_TAGS = true;

export const DEFAULT_BROWSER_MEDIA_STREAM_CONSTRAINTS: MediaStreamConstraints = Object.freeze({
  audio: Object.freeze({
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  }),
});
export const DEFAULT_BROWSER_MIME_TYPES = Object.freeze([
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const);
export const DEFAULT_BROWSER_AUDIO_BITS_PER_SECOND = 64_000;
export const DEFAULT_BROWSER_TIMESLICE_MS = 250;
