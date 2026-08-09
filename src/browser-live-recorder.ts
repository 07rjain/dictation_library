import { DictationError } from "./errors.js";
import {
  DEFAULT_BROWSER_AUDIO_BITS_PER_SECOND,
  DEFAULT_BROWSER_MEDIA_STREAM_CONSTRAINTS,
  DEFAULT_BROWSER_MIME_TYPES,
} from "./defaults.js";
import type { AudioInput } from "./types.js";

export interface BrowserLiveRecorderOptions {
  /** Length of each independently playable recording window. Defaults to 10 seconds. */
  windowMs?: number;
  mediaStreamConstraints?: MediaStreamConstraints;
  mimeTypes?: readonly string[];
  audioBitsPerSecond?: number;
  onWindow: (audio: AudioInput, sequence: number) => void | Promise<void>;
}

export interface BrowserLiveRecordingSummary {
  durationMs: number;
  windowCount: number;
}

/** Restarts MediaRecorder per window so every emitted Blob can be uploaded independently. */
export class BrowserLiveRecorder {
  private stream: MediaStream | undefined;
  private recorder: MediaRecorder | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private handlerChain: Promise<void> = Promise.resolve();
  private handlerError: unknown;
  private startedAt = 0;
  private sequence = 0;
  private active = false;
  private stopping: Promise<BrowserLiveRecordingSummary> | undefined;
  private resolveStop: ((summary: BrowserLiveRecordingSummary) => void) | undefined;
  private rejectStop: ((error: unknown) => void) | undefined;

  constructor(private readonly options: BrowserLiveRecorderOptions) {
    if (options.windowMs !== undefined && options.windowMs < 1_000) {
      throw new DictationError("Live recording windows must be at least one second.", {
        code: "INVALID_LIVE_WINDOW",
      });
    }
  }

  get isRecording(): boolean {
    return this.active;
  }

  async start(): Promise<void> {
    if (this.active) {
      throw new DictationError("Live recording is already active.", { code: "ALREADY_RECORDING" });
    }
    if (!globalThis.navigator?.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw new DictationError("This browser does not support microphone recording.", {
        code: "RECORDING_UNSUPPORTED",
      });
    }
    this.stream = await navigator.mediaDevices.getUserMedia(
      this.options.mediaStreamConstraints ?? DEFAULT_BROWSER_MEDIA_STREAM_CONSTRAINTS,
    );
    this.sequence = 0;
    this.handlerError = undefined;
    this.handlerChain = Promise.resolve();
    this.startedAt = performance.now();
    this.active = true;
    this.startWindow();
  }

  stop(): Promise<BrowserLiveRecordingSummary> {
    if (!this.active || !this.recorder) {
      return Promise.reject(new DictationError("No live recording is active.", { code: "NOT_RECORDING" }));
    }
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.stopping = new Promise((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
    });
    if (this.recorder.state !== "inactive") this.recorder.stop();
    return this.stopping;
  }

  cancel(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.recorder?.state !== "inactive") this.recorder?.stop();
    this.release();
  }

  private startWindow(): void {
    const chunks: Blob[] = [];
    const windowStartedAt = performance.now();
    const mimeType = chooseMimeType(this.options.mimeTypes ?? DEFAULT_BROWSER_MIME_TYPES);
    const recorder = new MediaRecorder(this.stream!, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: this.options.audioBitsPerSecond ?? DEFAULT_BROWSER_AUDIO_BITS_PER_SECOND,
    });
    this.recorder = recorder;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener("error", () => this.fail(new DictationError(
      "Browser live recording failed.", { code: "RECORDING_FAILED" },
    )), { once: true });
    recorder.addEventListener("stop", () => {
      const type = recorder.mimeType || chunks[0]?.type || "audio/webm";
      const blob = new Blob(chunks, { type });
      if (blob.size > 0) {
        const sequence = this.sequence++;
        const audio = {
          data: blob,
          filename: filenameForMime(type),
          durationMs: performance.now() - windowStartedAt,
        };
        this.handlerChain = this.handlerChain
          .then(() => this.options.onWindow(audio, sequence))
          .catch((error) => { this.handlerError ??= error; });
      }
      if (this.active) {
        this.startWindow();
      } else {
        void this.completeStop();
      }
    }, { once: true });
    recorder.start();
    this.timer = setTimeout(() => recorder.stop(), this.options.windowMs ?? 10_000);
  }

  private async completeStop(): Promise<void> {
    await this.handlerChain;
    const error = this.handlerError;
    const summary = { durationMs: performance.now() - this.startedAt, windowCount: this.sequence };
    this.release();
    if (error) {
      this.rejectStop?.(new DictationError("A live recording window handler failed.", {
        code: "RECORDING_SINK_FAILED",
        cause: error,
      }));
    } else {
      this.resolveStop?.(summary);
    }
  }

  private fail(error: unknown): void {
    this.active = false;
    this.release();
    this.rejectStop?.(error);
  }

  private release(): void {
    if (this.timer) clearTimeout(this.timer);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.timer = undefined;
    this.stream = undefined;
    this.recorder = undefined;
  }
}

function chooseMimeType(candidates: readonly string[]): string | undefined {
  return candidates.find((mime) => MediaRecorder.isTypeSupported(mime));
}

function filenameForMime(mimeType: string): string {
  if (mimeType.includes("ogg")) return "live.ogg";
  if (mimeType.includes("mp4")) return "live.m4a";
  return "live.webm";
}
