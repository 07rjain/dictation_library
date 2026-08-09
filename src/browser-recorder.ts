import { DictationError } from "./errors.js";
import {
  DEFAULT_BROWSER_AUDIO_BITS_PER_SECOND,
  DEFAULT_BROWSER_MEDIA_STREAM_CONSTRAINTS,
  DEFAULT_BROWSER_MIME_TYPES,
  DEFAULT_BROWSER_TIMESLICE_MS,
} from "./defaults.js";
import type { BrowserRecorderOptions, BrowserRecording } from "./types.js";

export class BrowserRecorder {
  private readonly options: BrowserRecorderOptions;
  private recorder: MediaRecorder | undefined;
  private stream: MediaStream | undefined;
  private chunks: Blob[] = [];
  private startedAt = 0;

  constructor(options: BrowserRecorderOptions = {}) {
    this.options = options;
  }

  get isRecording(): boolean {
    return this.recorder?.state === "recording";
  }

  async start(): Promise<void> {
    if (this.isRecording) {
      throw new DictationError("Recording is already active.", { code: "ALREADY_RECORDING" });
    }
    if (!globalThis.navigator?.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw new DictationError("This browser does not support microphone recording.", {
        code: "RECORDING_UNSUPPORTED",
      });
    }
    this.stream = await navigator.mediaDevices.getUserMedia(
      this.options.mediaStreamConstraints ?? DEFAULT_BROWSER_MEDIA_STREAM_CONSTRAINTS,
    );
    const mimeType = chooseMimeType(this.options.mimeTypes ?? DEFAULT_BROWSER_MIME_TYPES);
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: this.options.audioBitsPerSecond ?? DEFAULT_BROWSER_AUDIO_BITS_PER_SECOND,
    });
    this.recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });
    this.startedAt = performance.now();
    this.recorder.start(this.options.timesliceMs ?? DEFAULT_BROWSER_TIMESLICE_MS);
  }

  async stop(): Promise<BrowserRecording> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === "inactive") {
      throw new DictationError("No recording is active.", { code: "NOT_RECORDING" });
    }
    return new Promise<BrowserRecording>((resolve, reject) => {
      recorder.addEventListener("error", () => {
        this.release();
        reject(new DictationError("Browser audio recording failed.", { code: "RECORDING_FAILED" }));
      }, { once: true });
      recorder.addEventListener("stop", () => {
        const mimeType = recorder.mimeType || this.chunks[0]?.type || "audio/webm";
        const blob = new Blob(this.chunks, { type: mimeType });
        const durationMs = performance.now() - this.startedAt;
        const filename = mimeType.includes("ogg")
          ? "dictation.ogg"
          : mimeType.includes("mp4")
            ? "dictation.m4a"
            : "dictation.webm";
        this.release();
        resolve({ blob, mimeType, durationMs, filename });
      }, { once: true });
      recorder.stop();
    });
  }

  cancel(): void {
    if (this.recorder?.state !== "inactive") this.recorder?.stop();
    this.chunks = [];
    this.release();
  }

  private release(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.recorder = undefined;
  }
}

function chooseMimeType(candidates: readonly string[]): string | undefined {
  return candidates.find((mime) => MediaRecorder.isTypeSupported(mime));
}
