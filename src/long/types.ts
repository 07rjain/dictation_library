import type {
  AudioInput,
  AudioMetadata,
  CleanupConfig,
  CleanupWindowResult,
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
  /** Reuse metadata already inspected by the job/router. */
  metadata?: AudioMetadata;
  signal?: AbortSignal;
}

export interface AudioProcessor {
  readonly name: string;
  inspect(audio: AudioInput): Promise<AudioMetadata>;
  /** Return false when this processor cannot safely segment the supplied container or codec. */
  supports?(audio: AudioInput, metadata: AudioMetadata): boolean | Promise<boolean>;
  segment(audio: AudioInput, options: AudioSegmentationOptions): Promise<readonly AudioChunk[]>;
}

export interface LongChunkRecord {
  index: number;
  startMs: number;
  endMs: number;
  overlapBeforeMs: number;
  /** Content-addressed identity of source, preprocessing, time range, and transcription options. */
  requestKey?: string;
  status: LongChunkStatus;
  /** Logical job executions of this chunk, distinct from provider HTTP attempts. */
  attempts: number;
  providerAttempts?: number;
  /** Timeouts/network failures whose provider billing/completion outcome is unknowable locally. */
  unknownProviderOutcomes?: number;
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
  /** Content-addressed identity of preprocessing and transcription configuration. */
  configurationKey?: string;
  targetChunkMs: number;
  overlapMs: number;
  concurrency: number;
  chunks: LongChunkRecord[];
  /** Last allocated durable event cursor. */
  eventCursor?: number;
  /** Durable append-only lifecycle history. Stores contain this with the manifest. */
  events?: LongJobEvent[];
  result?: LongDictationResult;
}

export interface JobStore {
  load(jobId: string): Promise<LongJobManifest | undefined>;
  save(manifest: LongJobManifest): Promise<void>;
  delete?(jobId: string): Promise<void>;
  /** Optional distributed lease primitive. Return false when another worker owns the job. */
  acquireLease?(jobId: string, owner: string, ttlMs: number): Promise<boolean>;
  renewLease?(jobId: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseLease?(jobId: string, owner: string): Promise<void>;
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
  /** Distributed store lease duration. Defaults to 30 seconds when the store implements leases. */
  leaseTtlMs?: number;
  /** Explicitly accept and upgrade pre-content-identity manifests. Defaults to false. */
  migrateLegacyManifest?: boolean;
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
  stitching: readonly StitchDecision[];
  cleanupWindows: readonly CleanupWindowResult[];
  source: AudioMetadata;
}

export interface StitchDecision {
  boundaryIndex: number;
  confidence: "high" | "low";
  method: "timestamp-ownership" | "preserved-uncertain";
  deduplicatedSegments: number;
  /** Both boundary readings are retained for audit when ownership cannot be proven. */
  alternatives?: readonly [string, string];
}

export type LongJobEventPayload =
  | { type: "job.started"; jobId: string; chunkCount: number }
  | { type: "job.resumed"; jobId: string; completedChunks: number }
  | { type: "chunk.started"; jobId: string; index: number; attempt: number }
  | { type: "chunk.completed"; jobId: string; index: number; durationMs: number; text: string }
  | { type: "chunk.failed"; jobId: string; index: number; error: string }
  | { type: "chunk.retrying"; jobId: string; index: number; reason: string }
  | { type: "concurrency.reduced"; jobId: string; from: number; to: number; reason: string }
  | { type: "concurrency.increased"; jobId: string; from: number; to: number; reason: string }
  | { type: "job.progress"; jobId: string; completed: number; failed: number; total: number }
  | { type: "job.partial"; jobId: string; completed: number; failed: number; partialTranscript: string }
  | { type: "job.canceled"; jobId: string; reason: string }
  | { type: "stitching.started"; jobId: string }
  | { type: "stitching.decision"; jobId: string; decision: StitchDecision }
  | { type: "cleanup.started"; jobId: string }
  | { type: "cleanup.window"; jobId: string; window: CleanupWindowResult }
  | { type: "rate-limit.observed"; jobId: string; remainingRequests?: number; resetRequestsMs?: number }
  | { type: "job.completed"; jobId: string; result: LongDictationResult }
  | { type: "job.failed"; jobId: string; error: string };

export type LongJobEvent = LongJobEventPayload & { cursor: number; at: string };

export interface LongDictationJob {
  readonly id: string;
  result(): Promise<LongDictationResult>;
  /** Replay durable events strictly after `afterCursor`, then continue with live events. */
  events(afterCursor?: number): AsyncIterable<LongJobEvent>;
  inspect(): Promise<LongJobManifest>;
  abort(reason?: unknown): void;
}
