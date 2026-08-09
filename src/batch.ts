import { DEFAULT_GROQ_BASE_URL, DEFAULT_TRANSCRIPTION_MODEL } from "./defaults.js";
import { DictationError } from "./errors.js";
import type {
  DictationClientOptions,
  FetchLike,
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
  signal?: AbortSignal;
}

/** Groq asynchronous audio Batch client. Batch stores artifacts and is disabled in strict-ZDR mode. */
export class GroqBatchClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly zeroDataRetention: boolean;

  constructor(options: Pick<DictationClientOptions, "apiKey" | "baseUrl" | "fetch"> & {
    zeroDataRetention?: boolean;
  }) {
    this.apiKey = options.apiKey.trim();
    this.baseUrl = (options.baseUrl ?? DEFAULT_GROQ_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.zeroDataRetention = options.zeroDataRetention ?? false;
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
      await this.deleteFile(inputFile.id).catch(() => undefined);
      throw error;
    }
  }

  get(batchId: string): Promise<GroqBatch> {
    return this.jsonRequest(`${this.baseUrl}/batches/${encodeURIComponent(batchId)}`);
  }

  cancel(batchId: string): Promise<GroqBatch> {
    return this.jsonRequest(`${this.baseUrl}/batches/${encodeURIComponent(batchId)}/cancel`, { method: "POST" });
  }

  async wait(batchId: string, options: BatchWaitOptions = {}): Promise<GroqBatch> {
    while (true) {
      if (options.signal?.aborted) throw options.signal.reason;
      const batch = await this.get(batchId);
      if (["completed", "failed", "expired", "cancelled"].includes(batch.status)) return batch;
      await wait(options.pollIntervalMs ?? 5_000, options.signal);
    }
  }

  async results(batch: GroqBatch): Promise<readonly BatchOutputLine[]> {
    if (!batch.output_file_id) {
      throw new DictationError("Batch has no output file yet.", { code: "BATCH_NOT_COMPLETE" });
    }
    const response = await this.request(`${this.baseUrl}/files/${encodeURIComponent(batch.output_file_id)}/content`);
    const text = await response.text();
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as BatchOutputLine);
  }

  async deleteArtifacts(batch: GroqBatch): Promise<void> {
    const ids = [batch.input_file_id, batch.output_file_id, batch.error_file_id]
      .filter((id): id is string => Boolean(id));
    await Promise.all(ids.map((id) => this.deleteFile(id).catch(() => undefined)));
  }

  private async uploadJsonl(contents: string): Promise<{ id: string }> {
    const form = new FormData();
    form.append("purpose", "batch");
    form.append("file", new Blob([contents], { type: "application/jsonl" }), "audio-transcription-batch.jsonl");
    return this.jsonRequest(`${this.baseUrl}/files`, { method: "POST", body: form });
  }

  private async deleteFile(fileId: string): Promise<void> {
    await this.request(`${this.baseUrl}/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
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
    const response = await this.fetchImpl(url, {
      ...init,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...init.headers },
    });
    if (!response.ok) {
      throw new DictationError(`Groq Batch request failed with HTTP ${response.status}.`, {
        code: response.status === 429 ? "RATE_LIMITED" : "GROQ_BATCH_REQUEST_FAILED",
        status: response.status,
        details: await response.text().catch(() => ""),
      });
    }
    return response;
  }
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
