import {
  DEFAULT_GROQ_BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_ATTEMPTS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  DEFAULT_TRANSCRIPTION_MODEL,
} from "./defaults.js";
import { DictationError } from "./errors.js";
import type {
  DictationClientOptions,
  FetchLike,
  RetryConfig,
  TranscriptionModel,
  TranscriptionResponseFormat,
} from "./types.js";

export type BatchCompletionWindow = "24h" | "48h" | "72h" | "4d" | "5d" | "6d" | "7d";

export interface BatchAudioRequest {
  id: string;
  url: string;
  language?: string;
  prompt?: string;
}

export interface SubmitAudioBatchOptions {
  /** Required acknowledgement while Groq audio Batch remains experimental in this package. */
  experimental?: true;
  model?: TranscriptionModel;
  responseFormat?: TranscriptionResponseFormat;
  timestampGranularities?: readonly ("segment" | "word")[];
  temperature?: number;
  completionWindow?: BatchCompletionWindow;
  metadata?: Record<string, string>;
}

export interface GroqBatch {
  id: string;
  status: string;
  input_file_id: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
  request_counts?: { total: number; completed: number; failed: number };
  created_at?: number;
  expires_at?: number;
}

export interface BatchOutputLine {
  custom_id: string;
  response?: { status_code?: number; body?: unknown };
  error?: unknown;
}

export interface BatchWaitOptions {
  pollIntervalMs?: number;
  /** Maximum time spent polling the Batch lifecycle. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BatchRequestOptions {
  signal?: AbortSignal;
}

export interface RunAudioBatchOptions extends SubmitAudioBatchOptions, BatchWaitOptions {
  deleteArtifacts?: boolean;
}

/** Groq asynchronous audio Batch client. Batch stores artifacts and is disabled in strict-ZDR mode. */
export class GroqBatchClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly zeroDataRetention: boolean;
  private readonly timeoutMs: number;
  private readonly retryConfig: Required<RetryConfig>;

  constructor(options: Pick<
    DictationClientOptions,
    "apiKey" | "baseUrl" | "fetch" | "dangerouslyAllowBrowser" | "timeoutMs" | "retry"
  > & {
    zeroDataRetention?: boolean;
  }) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) {
      throw new DictationError("A Groq API key is required.", { code: "MISSING_API_KEY" });
    }
    if (typeof window !== "undefined" && !options.dangerouslyAllowBrowser) {
      throw new DictationError(
        "Refusing to expose a Groq key in a browser bundle. Batch should run on a trusted server.",
        { code: "BROWSER_API_KEY_BLOCKED" },
      );
    }
    this.baseUrl = (options.baseUrl ?? DEFAULT_GROQ_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.zeroDataRetention = options.zeroDataRetention ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.retryConfig = {
      maxAttempts: options.retry?.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
      baseDelayMs: options.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
      maxDelayMs: options.retry?.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
    };
  }

  async submitAudio(
    requests: readonly BatchAudioRequest[],
    options: SubmitAudioBatchOptions = {},
  ): Promise<GroqBatch> {
    if (this.zeroDataRetention) {
      throw new DictationError("Groq Batch retains processing artifacts and is disabled when zeroDataRetention is true.", {
        code: "BATCH_DISABLED_FOR_ZDR",
      });
    }
    if (options.experimental !== true) {
      throw new DictationError("Audio Batch is experimental and requires { experimental: true }.", {
        code: "BATCH_EXPERIMENTAL_DISABLED",
      });
    }
    if (requests.length === 0) {
      throw new DictationError("At least one audio URL is required for a Batch job.", { code: "EMPTY_BATCH" });
    }
    if (requests.length > 50_000) {
      throw new DictationError("A Batch file cannot contain more than 50,000 requests.", {
        code: "BATCH_TOO_LARGE",
      });
    }
    const identifiers = new Set<string>();
    const lines = requests.map((request) => {
      if (!request.id || identifiers.has(request.id)) {
        throw new DictationError("Batch request IDs must be non-empty and unique.", { code: "INVALID_BATCH_ID" });
      }
      identifiers.add(request.id);
      assertHttps(request.url);
      return JSON.stringify({
        custom_id: request.id,
        method: "POST",
        url: "/v1/audio/transcriptions",
        body: {
          model: options.model ?? DEFAULT_TRANSCRIPTION_MODEL,
          url: request.url,
          response_format: options.responseFormat ?? "verbose_json",
          temperature: options.temperature ?? 0,
          timestamp_granularities: options.timestampGranularities ?? ["segment"],
          ...(request.language?.trim() ? { language: request.language.trim() } : {}),
          ...(request.prompt?.trim() ? { prompt: request.prompt.trim() } : {}),
        },
      });
    });
    const jsonl = `${lines.join("\n")}\n`;
    if (new Blob([jsonl]).size > 100 * 1024 * 1024) {
      throw new DictationError("Batch JSONL exceeds the conservative 100 MiB upload limit.", {
        code: "BATCH_TOO_LARGE",
      });
    }
    const inputFile = await this.uploadJsonl(jsonl);
    try {
      return await this.jsonRequest<GroqBatch>(`${this.baseUrl}/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input_file_id: inputFile.id,
          endpoint: "/v1/audio/transcriptions",
          completion_window: options.completionWindow ?? "24h",
          ...(options.metadata ? { metadata: options.metadata } : {}),
        }),
      });
    } catch (error) {
      try {
        await this.deleteFile(inputFile.id);
      } catch (cleanupError) {
        throw new DictationError("Batch creation failed and its uploaded input file could not be deleted.", {
          code: "BATCH_SUBMIT_CLEANUP_FAILED",
          details: { inputFileId: inputFile.id, submitError: serializeBatchError(error) },
          cause: cleanupError,
        });
      }
      throw error;
    }
  }

  get(batchId: string, options: BatchRequestOptions = {}): Promise<GroqBatch> {
    return this.jsonRequest(`${this.baseUrl}/batches/${encodeURIComponent(batchId)}`, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  cancel(batchId: string, options: BatchRequestOptions = {}): Promise<GroqBatch> {
    return this.jsonRequest(`${this.baseUrl}/batches/${encodeURIComponent(batchId)}/cancel`, {
      method: "POST",
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async wait(batchId: string, options: BatchWaitOptions = {}): Promise<GroqBatch> {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
      throw new DictationError("Batch wait timeout must be a non-negative finite number.", {
        code: "INVALID_BATCH_WAIT_TIMEOUT",
      });
    }
    if (options.timeoutMs === 0) throw batchWaitTimeoutError();
    const deadlineController = options.timeoutMs === undefined ? undefined : new AbortController();
    const deadlineTimer = deadlineController === undefined
      ? undefined
      : setTimeout(() => deadlineController.abort(batchWaitTimeoutError()), options.timeoutMs);
    const signal = combineSignals(options.signal, deadlineController?.signal);
    try {
      while (true) {
        if (signal.aborted) throw signal.reason;
        const batch = await this.get(batchId, { signal });
        if (["completed", "failed", "expired", "cancelled"].includes(batch.status)) return batch;
        // The same deadline signal covers both provider polling and the sleep interval, so neither
        // phase can extend the caller's overall wait budget.
        await wait(options.pollIntervalMs ?? 5_000, signal);
      }
    } catch (error) {
      if (deadlineController?.signal.aborted) throw deadlineController.signal.reason;
      throw error;
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }
  }

  async results(batch: GroqBatch, options: BatchRequestOptions = {}): Promise<readonly BatchOutputLine[]> {
    const fileIds = [batch.output_file_id, batch.error_file_id].filter((id): id is string => Boolean(id));
    if (fileIds.length === 0) {
      throw new DictationError("Batch has no result artifacts yet.", { code: "BATCH_NOT_COMPLETE" });
    }
    const contents = await Promise.all(fileIds.map(async (fileId) => {
      const response = await this.request(`${this.baseUrl}/files/${encodeURIComponent(fileId)}/content`, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return response.text();
    }));
    return contents.flatMap((text) => text.split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line) as BatchOutputLine));
  }

  failedRequestIds(lines: readonly BatchOutputLine[]): readonly string[] {
    return lines.filter((line) => line.error !== undefined ||
      (line.response?.status_code !== undefined && line.response.status_code >= 400)
    ).map((line) => line.custom_id);
  }

  unresolvedRequestIds(
    originalRequests: readonly BatchAudioRequest[],
    lines: readonly BatchOutputLine[],
  ): readonly string[] {
    const successful = new Set(lines.filter((line) => line.error === undefined &&
      line.response?.status_code !== undefined && line.response.status_code < 400
    ).map((line) => line.custom_id));
    return originalRequests.filter((request) => !successful.has(request.id)).map((request) => request.id);
  }

  async resubmitFailed(
    originalRequests: readonly BatchAudioRequest[],
    lines: readonly BatchOutputLine[],
    options: SubmitAudioBatchOptions,
  ): Promise<GroqBatch | undefined> {
    // Missing result lines are unresolved too. This matters when a Batch expires or produces a
    // partial error artifact: only custom_ids with a proven successful response are reusable.
    const failed = new Set(this.unresolvedRequestIds(originalRequests, lines));
    if (failed.size === 0) return undefined;
    const requests = originalRequests.filter((request) => failed.has(request.id));
    if (requests.length !== failed.size) {
      throw new DictationError("Cannot resubmit Batch failures without every original custom_id.", {
        code: "BATCH_RESUBMIT_INPUT_MISSING",
        details: { missingIds: [...failed].filter((id) => !requests.some((request) => request.id === id)) },
      });
    }
    return this.submitAudio(requests, options);
  }

  async recoverIncomplete(
    batch: GroqBatch,
    originalRequests: readonly BatchAudioRequest[],
    options: SubmitAudioBatchOptions,
  ): Promise<GroqBatch | undefined> {
    let lines: readonly BatchOutputLine[] = [];
    if (batch.output_file_id || batch.error_file_id) lines = await this.results(batch);
    return this.resubmitFailed(originalRequests, lines, options);
  }

  async runAudio(
    requests: readonly BatchAudioRequest[],
    options: RunAudioBatchOptions,
  ): Promise<{ batch: GroqBatch; lines: readonly BatchOutputLine[] }> {
    const { pollIntervalMs, timeoutMs, signal, deleteArtifacts = true, ...submit } = options;
    const submitted = await this.submitAudio(requests, submit);
    let completed = submitted;
    let operationError: unknown;
    try {
      completed = await this.wait(submitted.id, {
        ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(signal ? { signal } : {}),
      });
      const lines = await this.results(completed, { ...(signal ? { signal } : {}) });
      return { batch: completed, lines };
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      if (deleteArtifacts) {
        try {
          // Cleanup is intentionally not aborted with the caller's signal: once artifacts exist,
          // cancellation should not silently skip retention cleanup.
          await this.deleteArtifacts(completed);
        } catch (cleanupError) {
          if (operationError !== undefined) {
            throw new DictationError("Audio Batch failed and its artifacts could not be fully deleted.", {
              code: "BATCH_RUN_CLEANUP_FAILED",
              details: {
                batchId: completed.id,
                operationError: serializeBatchError(operationError),
                cleanupError: serializeBatchError(cleanupError),
              },
              cause: cleanupError,
            });
          }
          throw cleanupError;
        }
      }
    }
  }

  async deleteArtifacts(batch: GroqBatch, options: BatchRequestOptions = {}): Promise<void> {
    const ids = [batch.input_file_id, batch.output_file_id, batch.error_file_id]
      .filter((id): id is string => Boolean(id));
    const outcomes = await Promise.allSettled(ids.map((id) => this.deleteFile(id, options.signal)));
    const failedIds = ids.filter((_id, index) => outcomes[index]?.status === "rejected");
    if (failedIds.length > 0) {
      throw new DictationError("One or more Groq Batch artifacts could not be deleted.", {
        code: "BATCH_ARTIFACT_DELETE_FAILED",
        details: { failedFileIds: failedIds },
      });
    }
  }

  private async uploadJsonl(contents: string): Promise<{ id: string }> {
    const form = new FormData();
    form.append("purpose", "batch");
    form.append("file", new Blob([contents], { type: "application/jsonl" }), "audio-transcription-batch.jsonl");
    return this.jsonRequest(`${this.baseUrl}/files`, { method: "POST", body: form });
  }

  private async deleteFile(fileId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`${this.baseUrl}/files/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
      ...(signal ? { signal } : {}),
    });
  }

  private async jsonRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(url, init);
    try {
      return await response.json() as T;
    } catch (cause) {
      throw new DictationError("Groq Batch returned invalid JSON.", { code: "INVALID_JSON_RESPONSE", cause });
    }
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    // GET and DELETE are safe to replay. POST submission, upload, and cancellation are deliberately
    // single-attempt because an unknown outcome could otherwise create duplicate work or billing.
    const maxAttempts = method === "GET" || method === "DELETE" ? this.retryConfig.maxAttempts : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const timeoutController = new AbortController();
      const timer = setTimeout(
        () => timeoutController.abort(new Error("Batch request timed out")),
        this.timeoutMs,
      );
      const signal = combineSignals(init.signal, timeoutController.signal);
      try {
        const response = await this.fetchImpl(url, {
          ...init,
          signal,
          headers: { Authorization: `Bearer ${this.apiKey}`, ...init.headers },
        });
        if (response.ok) return response;
        const error = new DictationError(`Groq Batch request failed with HTTP ${response.status}.`, {
          code: response.status === 429 ? "RATE_LIMITED" : "GROQ_BATCH_REQUEST_FAILED",
          status: response.status,
          details: await response.text().catch(() => ""),
        });
        if (!isRetryableStatus(response.status) || attempt === maxAttempts) throw error;
        lastError = error;
        await wait(
          batchRetryDelayMs(response.headers.get("retry-after"), attempt, this.retryConfig),
          init.signal ?? undefined,
        );
      } catch (error) {
        if (init.signal?.aborted) throw error;
        const normalized = error instanceof DictationError
          ? error
          : new DictationError(
            timeoutController.signal.aborted ? "Groq Batch request timed out." : "Groq Batch request failed.",
            {
              code: timeoutController.signal.aborted ? "BATCH_REQUEST_TIMEOUT" : "BATCH_NETWORK_ERROR",
              cause: error,
            },
          );
        if (!isRetryableBatchError(normalized) || attempt === maxAttempts) throw normalized;
        lastError = normalized;
        await wait(batchRetryDelayMs(null, attempt, this.retryConfig), init.signal ?? undefined);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function isRetryableBatchError(error: DictationError): boolean {
  return error.code === "BATCH_REQUEST_TIMEOUT" || error.code === "BATCH_NETWORK_ERROR" ||
    (error.status !== undefined && isRetryableStatus(error.status));
}

function batchRetryDelayMs(header: string | null, attempt: number, config: Required<RetryConfig>): number {
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

function combineSignals(...signals: Array<AbortSignal | null | undefined>): AbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) return new AbortController().signal;
  if (active.length === 1) return active[0]!;
  return AbortSignal.any(active);
}

function batchWaitTimeoutError(): DictationError {
  return new DictationError("Timed out waiting for the Groq Batch job.", { code: "BATCH_WAIT_TIMEOUT" });
}

function serializeBatchError(error: unknown): { code?: string; message: string; status?: number } {
  if (error instanceof DictationError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

function assertHttps(value: string): void {
  try {
    if (new URL(value).protocol === "https:") return;
  } catch {
    // Normalized below.
  }
  throw new DictationError("Batch audio URLs must use HTTPS.", { code: "INVALID_AUDIO_URL" });
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
