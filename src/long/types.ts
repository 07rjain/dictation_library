import type {
  AudioInput,
  AudioMetadata,
  CleanupConfig,
  DictationContext,
  DictationOptions,
  PipelineTimings,
  TranscriptionResult,
  TranscriptionSegment,
} from "../types.js";

export type LongJobMode = "interactive" | "offline";
export type LongJobStatus = "pending" | "processing" | "completed" | "partial" | "failed" | "aborted";
export type LongChunkStatus = "pending" | "processing" | "completed" | "failed";

export interface AudioChunk {
  index: number;
  startMs: number;
  endMs: number;
  overlapBeforeMs: number;
  audio: AudioInput;
}

export interface AudioSegmentationOptions {
  targetChunkMs: number;
  overlapMs: number;
  maxChunkBytes?: number;
  signal?: AbortSignal;
}

export interface AudioProcessor {
  readonly name: string;
  inspect(audio: AudioInput): Promise<AudioMetadata>;
  segment(audio: AudioInput, options: AudioSegmentationOptions): Promise<readonly AudioChunk[]>;
}

export interface LongChunkRecord {
  index: number;
  startMs: number;
  endMs: number;
  overlapBeforeMs: number;
  status: LongChunkStatus;
  attempts: number;
  result?: TranscriptionResult;
  alternatives?: TranscriptionResult[];
  error?: { code: string; message: string; status?: number };
  durationMs?: number;
}

export interface LongJobManifest {
  version: 1;
  jobId: string;
  status: LongJobStatus;
  createdAt: string;
  updatedAt: string;
  mode: LongJobMode;
  source: AudioMetadata;
  processor: string;
  targetChunkMs: number;
  overlapMs: number;
  concurrency: number;
  chunks: LongChunkRecord[];
  result?: LongDictationResult;
}

export interface JobStore {
  load(jobId: string): Promise<LongJobManifest | undefined>;
  save(manifest: LongJobManifest): Promise<void>;
  delete?(jobId: string): Promise<void>;
}

export interface LongDictationOptions extends Omit<DictationOptions, "cleanup"> {
  mode?: LongJobMode;
  targetChunkMs?: number;
  overlapMs?: number;
  maxChunkBytes?: number;
  concurrency?: number;
  /** Optional provider-account pacing. Example: 18 for a 20 RPM free-tier allowance. */
  requestsPerMinute?: number | false;
  processor?: AudioProcessor;
  store?: JobStore;
  jobId?: string;
  /** Long-form defaults to no generative cleanup. */
  cleanup?: CleanupConfig;
  /** Continue independent chunks after a chunk failure. Defaults to true. */
  continueOnError?: boolean;
  /** Independent is fastest; retry-ambiguous adds context only to low-confidence boundaries. */
  accuracyMode?: "independent" | "retry-ambiguous" | "sequential";
  ambiguityLogProbabilityThreshold?: number;
  promptTailChars?: number;
}

export interface AutoDictationOptions extends LongDictationOptions {
  forceLong?: boolean;
}

export interface LongChunkResult {
  index: number;
  startMs: number;
  endMs: number;
  overlapBeforeMs: number;
  text: string;
  segments: readonly TranscriptionSegment[];
  model: string;
  durationMs: number;
}

export interface LongDictationResult {
  jobId: string;
  text: string;
  rawTranscript: string;
  transcriptionModel: string;
  cleanupModel?: string;
  cleanupRejected: boolean;
  usedCleanupFallback: boolean;
  filteredAsSilence: boolean;
  context: DictationContext;
  timings: PipelineTimings;
  chunks: readonly LongChunkResult[];
  source: AudioMetadata;
}

export type LongJobEvent =
  | { type: "job.started"; jobId: string; chunkCount: number }
  | { type: "job.resumed"; jobId: string; completedChunks: number }
  | { type: "chunk.started"; jobId: string; index: number; attempt: number }
  | { type: "chunk.completed"; jobId: string; index: number; durationMs: number; text: string }
  | { type: "chunk.failed"; jobId: string; index: number; error: string }
  | { type: "chunk.retrying"; jobId: string; index: number; reason: string }
  | { type: "job.progress"; jobId: string; completed: number; failed: number; total: number }
  | { type: "stitching.started"; jobId: string }
  | { type: "cleanup.started"; jobId: string }
  | { type: "job.completed"; jobId: string; result: LongDictationResult }
  | { type: "job.failed"; jobId: string; error: string };

export interface LongDictationJob {
  readonly id: string;
  result(): Promise<LongDictationResult>;
  events(): AsyncIterable<LongJobEvent>;
  inspect(): Promise<LongJobManifest>;
  abort(reason?: unknown): void;
}
