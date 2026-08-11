import { DictationError } from "./errors.js";
import {
  DEFAULT_BROWSER_AUDIO_BITS_PER_SECOND,
  DEFAULT_BROWSER_MEDIA_STREAM_CONSTRAINTS,
  DEFAULT_BROWSER_MIME_TYPES,
  DEFAULT_LIVE_MAX_PENDING_BYTES,
  DEFAULT_LIVE_MAX_PENDING_WINDOWS,
  DEFAULT_LIVE_WINDOW_MS,
  DEFAULT_LIVE_WINDOW_OVERLAP_MS,
} from "./defaults.js";
import type { AudioInput } from "./types.js";

export interface BrowserLiveRecorderOptions {
  /** Length of each independently playable recording window. Defaults to 10 seconds. */
  windowMs?: number;
  /** Capture shared by adjacent self-contained windows. Defaults to 500 ms. */
  overlapMs?: number;
  /** Maximum windows waiting for onWindow. Defaults to 4. */
  maxPendingWindows?: number;
  /** Maximum encoded bytes waiting for onWindow. Defaults to 32 MiB. */
  maxPendingBytes?: number;
  mediaStreamConstraints?: MediaStreamConstraints;
  mimeTypes?: readonly string[];
  audioBitsPerSecond?: number;
  onWindow: (audio: AudioInput, sequence: number) => void | Promise<void>;
  /** Called after every previously accepted window settles. Async handlers are awaited. */
  onError?: (error: DictationError) => void | Promise<void>;
}

export interface BrowserLiveRecordingSummary {
  durationMs: number;
  windowCount: number;
}

interface RecorderWindow {
  generation: number;
  recorder: MediaRecorder;
  captureStream: MediaStream;
  ownsCaptureStream: boolean;
  chunks: Blob[];
  sequence: number;
  startedAt: number;
  overlapBeforeMs: number;
  discard: boolean;
  rotationTimer?: ReturnType<typeof setTimeout>;
  stopTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Records overlapping, independently initialized MediaRecorder windows.
 * Browsers that reject simultaneous MediaRecorders automatically use sequential windows.
 */
export class BrowserLiveRecorder {
  private stream: MediaStream | undefined;
  private readonly windows = new Map<MediaRecorder, RecorderWindow>();
  private handlerChain: Promise<void> = Promise.resolve();
  private handlerError: unknown;
  private terminalError: DictationError | undefined;
  private deferredErrorNotification = false;
  private startedAt = 0;
  private nextSequence = 0;
  private deliveredWindows = 0;
  private pendingWindows = 0;
  private pendingBytes = 0;
  private generation = 0;
  private starting = false;
  private active = false;
  private settling = false;
  private cancelled = false;
  private completing = false;
  private overlapSupported = true;
  private completion: Promise<void> = Promise.resolve();
  private resolveCompletion: (() => void) | undefined;
  private stopping: Promise<BrowserLiveRecordingSummary> | undefined;
  private resolveStop: ((summary: BrowserLiveRecordingSummary) => void) | undefined;
  private rejectStop: ((error: unknown) => void) | undefined;

  constructor(private readonly options: BrowserLiveRecorderOptions) {
    const windowMs = options.windowMs ?? DEFAULT_LIVE_WINDOW_MS;
    const overlapMs = options.overlapMs ?? DEFAULT_LIVE_WINDOW_OVERLAP_MS;
    if (!Number.isFinite(windowMs) || windowMs < 1_000) {
      throw new DictationError("Live recording windows must be at least one second.", {
        code: "INVALID_LIVE_WINDOW",
      });
    }
    if (!Number.isFinite(overlapMs) || overlapMs < 0 || overlapMs > windowMs / 2) {
      throw new DictationError("Live window overlap must be between zero and half the window length.", {
        code: "INVALID_LIVE_OVERLAP",
      });
    }
    const maxPendingWindows = options.maxPendingWindows ?? DEFAULT_LIVE_MAX_PENDING_WINDOWS;
    const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_LIVE_MAX_PENDING_BYTES;
    if (!Number.isFinite(maxPendingWindows) || maxPendingWindows < 1 ||
        !Number.isFinite(maxPendingBytes) || maxPendingBytes < 1) {
      throw new DictationError("Live recording queue limits must be positive.", {
        code: "INVALID_LIVE_BACKPRESSURE",
      });
    }
  }

  get isRecording(): boolean {
    // Remain logically active while accepted windows and terminal callbacks settle. This keeps
    // callers from starting a replacement session whose state could be consumed by the old one.
    return this.starting || this.active || this.settling;
  }

  async start(): Promise<void> {
    if (this.starting || this.active || this.settling) {
      throw new DictationError("Live recording is already active.", { code: "ALREADY_RECORDING" });
    }
    if (!globalThis.navigator?.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw new DictationError("This browser does not support microphone recording.", {
        code: "RECORDING_UNSUPPORTED",
      });
    }
    const generation = this.generation + 1;
    this.generation = generation;
    this.starting = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(
        this.options.mediaStreamConstraints ?? DEFAULT_BROWSER_MEDIA_STREAM_CONSTRAINTS,
      );
    } catch (error) {
      if (generation === this.generation) this.starting = false;
      throw error;
    }
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DictationError("Live recording was canceled.", { code: "LIVE_RECORDING_CANCELED" });
    }
    this.starting = false;
    this.stream = stream;
    this.nextSequence = 0;
    this.deliveredWindows = 0;
    this.pendingWindows = 0;
    this.pendingBytes = 0;
    this.handlerError = undefined;
    this.terminalError = undefined;
    this.deferredErrorNotification = false;
    this.handlerChain = Promise.resolve();
    this.startedAt = performance.now();
    this.cancelled = false;
    this.completing = false;
    this.settling = false;
    this.overlapSupported = true;
    this.stopping = undefined;
    this.resolveStop = undefined;
    this.rejectStop = undefined;
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
    this.active = true;
    try {
      this.startWindow(0, generation);
    } catch (error) {
      this.active = false;
      this.release(generation);
      throw normalizeRecordingError(error);
    }
  }

  stop(): Promise<BrowserLiveRecordingSummary> {
    if (this.stopping) return this.stopping;
    if (this.terminalError) {
      const error = this.terminalError;
      return this.completion.then(() => Promise.reject(error));
    }
    if (this.starting) {
      // getUserMedia cannot be portably aborted. Invalidate this generation immediately; start()
      // will stop a stream that arrives late instead of constructing a recorder from it.
      this.cancel();
      return Promise.resolve({ durationMs: 0, windowCount: 0 });
    }
    if (!this.active || this.windows.size === 0) {
      return Promise.reject(new DictationError("No live recording is active.", { code: "NOT_RECORDING" }));
    }
    this.active = false;
    this.settling = true;
    this.stopping = new Promise((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
    });
    const activeWindows = [...this.windows.values()].sort((a, b) => a.startedAt - b.startedAt);
    for (const state of activeWindows.slice(1)) state.discard = true;
    for (const state of activeWindows) this.stopWindow(state);
    return this.stopping;
  }

  cancel(): void {
    const cancellation = new DictationError("Live recording was canceled.", {
      code: "LIVE_RECORDING_CANCELED",
    });
    const generation = this.generation;
    this.starting = false;
    this.active = false;
    this.settling = false;
    this.cancelled = true;
    for (const state of this.windows.values()) {
      state.discard = true;
      this.stopWindow(state);
    }
    this.release(generation);
    this.generation += 1;
    const rejectStop = this.rejectStop;
    const resolveCompletion = this.resolveCompletion;
    this.stopping = undefined;
    this.resolveStop = undefined;
    this.rejectStop = undefined;
    this.resolveCompletion = undefined;
    this.handlerError = undefined;
    this.terminalError = undefined;
    this.deferredErrorNotification = false;
    rejectStop?.(cancellation);
    resolveCompletion?.();
  }

  private startWindow(overlapBeforeMs: number, generation: number): void {
    if (generation !== this.generation || !this.active || !this.stream) return;
    const mimeType = chooseMimeType(this.options.mimeTypes ?? DEFAULT_BROWSER_MIME_TYPES);
    const isolated = isolateRecorderStream(this.stream);
    // Two MediaRecorders must never share the same live MediaStream. If clone() is unavailable or
    // fails, switch to sequential rotation before scheduling the first overlap window.
    if (!isolated.owned) this.overlapSupported = false;
    const recorder = new MediaRecorder(isolated.stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: this.options.audioBitsPerSecond ?? DEFAULT_BROWSER_AUDIO_BITS_PER_SECOND,
    });
    const state: RecorderWindow = {
      generation,
      recorder,
      captureStream: isolated.stream,
      ownsCaptureStream: isolated.owned,
      chunks: [],
      sequence: this.nextSequence,
      startedAt: performance.now(),
      overlapBeforeMs,
      discard: false,
    };
    this.windows.set(recorder, state);
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) state.chunks.push(event.data);
    });
    recorder.addEventListener("error", () => this.fail(new DictationError(
      "Browser live recording failed.", { code: "RECORDING_FAILED" },
    ), generation), { once: true });
    recorder.addEventListener("stop", () => this.windowStopped(state), { once: true });
    try {
      recorder.start();
      this.nextSequence += 1;
    } catch (error) {
      this.windows.delete(recorder);
      if (isolated.owned) isolated.stream.getTracks().forEach((track) => track.stop());
      throw error;
    }

    const windowMs = this.options.windowMs ?? DEFAULT_LIVE_WINDOW_MS;
    const overlapMs = this.options.overlapMs ?? DEFAULT_LIVE_WINDOW_OVERLAP_MS;
    state.rotationTimer = setTimeout(() => {
      if (generation !== this.generation || !this.active) return;
      if (!this.overlapSupported || overlapMs === 0) {
        this.stopWindow(state);
        return;
      }
      try {
        this.startWindow(overlapMs, generation);
        state.stopTimer = setTimeout(() => this.stopWindow(state), overlapMs);
      } catch {
        // Safari and some embedded browsers reject two MediaRecorders on one stream. Continue
        // with sequential self-contained windows; this may introduce a tiny boundary gap.
        this.overlapSupported = false;
        this.stopWindow(state);
      }
    }, this.overlapSupported ? windowMs - overlapMs : windowMs);
  }

  private stopWindow(state: RecorderWindow): void {
    if (state.rotationTimer) clearTimeout(state.rotationTimer);
    if (state.stopTimer) clearTimeout(state.stopTimer);
    delete state.rotationTimer;
    delete state.stopTimer;
    if (state.recorder.state !== "inactive") state.recorder.stop();
  }

  private windowStopped(state: RecorderWindow): void {
    this.windows.delete(state.recorder);
    if (state.ownsCaptureStream) state.captureStream.getTracks().forEach((track) => track.stop());
    if (state.generation !== this.generation) return;
    if (!this.cancelled && !state.discard) {
      const type = state.recorder.mimeType || state.chunks[0]?.type || "audio/webm";
      const blob = new Blob(state.chunks, { type });
      if (blob.size > 0) {
        this.enqueueWindow({
          data: blob,
          filename: filenameForMime(type),
          durationMs: performance.now() - state.startedAt,
          overlapBeforeMs: state.overlapBeforeMs,
        }, state.sequence, state.generation);
      }
    }
    if (this.active && !this.overlapSupported && this.windows.size === 0) {
      try {
        this.startWindow(0, state.generation);
      } catch (error) {
        this.fail(normalizeRecordingError(error), state.generation);
      }
    } else if (!this.active && this.windows.size === 0) {
      void this.completeStop(state.generation);
    }
  }

  private enqueueWindow(audio: AudioInput, sequence: number, generation: number): void {
    if (generation !== this.generation) return;
    const maxWindows = this.options.maxPendingWindows ?? DEFAULT_LIVE_MAX_PENDING_WINDOWS;
    const maxBytes = this.options.maxPendingBytes ?? DEFAULT_LIVE_MAX_PENDING_BYTES;
    if (this.pendingWindows >= maxWindows || this.pendingBytes + audio.data.size > maxBytes) {
      this.fail(new DictationError("Live recording cannot keep up with the window handler.", {
        code: "LIVE_BACKPRESSURE_LIMIT",
        details: {
          pendingWindows: this.pendingWindows,
          pendingBytes: this.pendingBytes,
          maxPendingWindows: maxWindows,
          maxPendingBytes: maxBytes,
        },
      }), generation);
      return;
    }
    this.pendingWindows += 1;
    this.pendingBytes += audio.data.size;
    this.handlerChain = this.handlerChain
      .then(() => {
        // cancel() suppresses windows that were accepted but have not reached the sink yet.
        if (generation !== this.generation || this.cancelled) return;
        this.deliveredWindows += 1;
        return this.options.onWindow(audio, sequence);
      })
      .catch((error) => {
        if (generation !== this.generation) return;
        this.handlerError ??= error;
        this.fail(new DictationError("A live recording window handler failed.", {
          code: "RECORDING_SINK_FAILED",
          cause: error,
        }), generation);
      })
      .finally(() => {
        if (generation !== this.generation) return;
        this.pendingWindows -= 1;
        this.pendingBytes -= audio.data.size;
      });
  }

  private async completeStop(generation: number): Promise<void> {
    if (generation !== this.generation || this.completing || this.cancelled) return;
    this.completing = true;
    const handlerChain = this.handlerChain;
    await handlerChain;
    if (generation !== this.generation) return;
    const error = this.terminalError ?? this.handlerError;
    const summary = { durationMs: performance.now() - this.startedAt, windowCount: this.deliveredWindows };
    this.release(generation);
    if (this.deferredErrorNotification && this.terminalError) {
      this.deferredErrorNotification = false;
      try {
        await this.options.onError?.(this.terminalError);
      } catch {
        // A consumer error callback must not leave stop() permanently unsettled.
      }
    }
    if (generation !== this.generation) return;
    if (error) this.rejectStop?.(error);
    else this.resolveStop?.(summary);
    this.settling = false;
    this.resolveCompletion?.();
  }

  private fail(error: DictationError, generation: number): void {
    if (generation !== this.generation || this.terminalError) return;
    this.terminalError = error;
    this.active = false;
    this.settling = true;
    // Notify only after all previously accepted onWindow work has settled. Consumers such as
    // LiveConversationSession can then finish without closing ahead of an accepted window.
    this.deferredErrorNotification = true;
    for (const state of this.windows.values()) {
      state.discard = true;
      this.stopWindow(state);
    }
    if (this.windows.size === 0) void this.completeStop(generation);
  }

  private release(generation: number): void {
    if (generation !== this.generation) return;
    for (const state of this.windows.values()) {
      if (state.rotationTimer) clearTimeout(state.rotationTimer);
      if (state.stopTimer) clearTimeout(state.stopTimer);
      if (state.ownsCaptureStream) state.captureStream.getTracks().forEach((track) => track.stop());
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.windows.clear();
    this.stream = undefined;
  }
}

function isolateRecorderStream(source: MediaStream): { stream: MediaStream; owned: boolean } {
  const tracks = typeof source.getAudioTracks === "function" ? source.getAudioTracks() : source.getTracks();
  if (
    typeof MediaStream === "undefined" || tracks.length === 0 ||
    tracks.some((track) => typeof track.clone !== "function")
  ) return { stream: source, owned: false };
  try {
    return { stream: new MediaStream(tracks.map((track) => track.clone())), owned: true };
  } catch {
    return { stream: source, owned: false };
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

function normalizeRecordingError(error: unknown): DictationError {
  return error instanceof DictationError
    ? error
    : new DictationError("Browser live recording failed to start.", {
      code: "RECORDING_FAILED",
      cause: error,
    });
}
