import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserLiveRecorder,
  DictationError,
  DictationPipeline,
} from "../dist/index.js";

function audio(sequence) {
  return {
    data: new Blob([`audio-${sequence}`], { type: "audio/wav" }),
    filename: `window-${sequence}.wav`,
    durationMs: 3_000,
  };
}

test("transcribes queued live windows in order and emits cumulative partials", async () => {
  let active = 0;
  let maximumActive = 0;
  let cleanupCalls = 0;
  const prompts = [];
  const events = [];
  const pipeline = new DictationPipeline({
    apiKey: "test",
    retry: { maxAttempts: 1 },
    fetch: async (url, init) => {
      if (String(url).endsWith("/audio/transcriptions")) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        prompts.push(init.body.get("prompt"));
        const sequence = Number(init.body.get("file").name.match(/(\d+)/)?.[1] ?? 0);
        await new Promise((resolve) => setTimeout(resolve, 3));
        active -= 1;
        return Response.json({ text: ["Hello", "this is", "live speech"][sequence], segments: [] });
      }
      cleanupCalls += 1;
      return Response.json({ choices: [{ message: { content: "Hello, this is live speech." } }] });
    },
  });
  const session = pipeline.startLiveConversation({
    language: "en",
    prompt: "Product name: AcmeCloud",
    cleanup: { mode: "dictation" },
    onEvent: (event) => events.push(event),
  });
  const partials = await Promise.all([session.push(audio(0)), session.push(audio(1)), session.push(audio(2))]);
  const result = await session.finish();

  assert.equal(maximumActive, 1);
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(partials.map((partial) => partial.transcript), [
    "Hello",
    "Hello this is",
    "Hello this is live speech",
  ]);
  assert.equal(result.rawTranscript, "Hello this is live speech");
  assert.equal(result.text, "Hello, this is live speech.");
  assert.equal(prompts[0], "Product name: AcmeCloud");
  assert.ok(prompts[1].includes("Previous transcript: Hello"));
  assert.ok(prompts[2].includes("Previous transcript: Hello this is"));
  assert.equal(events.filter((event) => event.type === "live.partial").length, 3);
  assert.equal(events.at(-1).type, "live.completed");
});

test("live transcription is raw by default and cleanup remains opt-in", async () => {
  let cleanupCalls = 0;
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async (url) => {
      if (String(url).endsWith("/audio/transcriptions")) {
        return Response.json({ text: "um exact raw wording", segments: [] });
      }
      cleanupCalls += 1;
      return Response.json({ choices: [{ message: { content: "cleaned" } }] });
    },
  });
  const session = pipeline.startLiveConversation();
  await session.push(audio(0));
  const result = await session.finish();
  assert.equal(result.text, "um exact raw wording");
  assert.equal(cleanupCalls, 0);
});

test("a rejected live cleanup window restores the exact canonical raw transcript", async () => {
  const raw = "Important exact wording 123 must remain intact across every cleanup window without separators.";
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async (url) => String(url).endsWith("/audio/transcriptions")
      ? Response.json({ text: raw, segments: [] })
      : Response.json({ choices: [{ message: { content: "Tiny." } }] }),
  });
  const session = pipeline.startLiveConversation({
    cleanup: { mode: "verbatim", maxDeletionRatio: 0.05 },
    cleanupWindowChars: 35,
  });
  await session.push(audio(0));
  const result = await session.finish();
  assert.equal(result.cleanupRejected, true);
  assert.equal(result.text, raw);
  assert.equal(result.rawTranscript, raw);
  assert.ok(result.cleanupWindows.length >= 2);
  assert.ok(result.cleanupWindows.some((window) => !window.accepted && window.guard?.diff.removed.length));
  for (const window of result.cleanupWindows) {
    assert.ok(raw.slice(window.startChar, window.endChar).length > 0);
    assert.equal(raw.slice(window.startChar, window.endChar).trim(), raw.slice(window.startChar, window.endChar));
  }
});

test("a hard live cleanup failure emits live.failed before finish rejects", async () => {
  const events = [];
  const pipeline = new DictationPipeline({
    apiKey: "test",
    cleanupFallbackModel: false,
    retry: { maxAttempts: 1 },
    fetch: async (url) => String(url).endsWith("/audio/transcriptions")
      ? Response.json({ text: "raw transcript", segments: [] })
      : new Response("cleanup unavailable", { status: 503 }),
  });
  const session = pipeline.startLiveConversation({
    cleanup: { mode: "dictation" },
    onEvent: (event) => events.push(event),
  });
  await session.push(audio(0));
  await assert.rejects(
    session.finish(),
    (error) => error instanceof DictationError && error.status === 503,
  );
  assert.equal(events.filter((event) => event.type === "live.failed").length, 1);
  assert.equal(events.at(-1).type, "live.failed");
});

test("aborting a live session cancels in-flight provider work and emits one canceled terminal event", async () => {
  const events = [];
  let providerSignal;
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const pipeline = new DictationPipeline({
    apiKey: "test",
    retry: { maxAttempts: 1 },
    fetch: async (_url, init) => {
      providerSignal = init.signal;
      requestStarted();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    },
  });
  const session = pipeline.startLiveConversation({ onEvent: (event) => events.push(event) });
  const pushed = session.push(audio(0));
  await started;
  session.abort(new Error("page hidden"));

  await assert.rejects(
    pushed,
    (error) => error instanceof DictationError && error.code === "LIVE_SESSION_ABORTED",
  );
  await assert.rejects(
    session.finish(),
    (error) => error instanceof DictationError && error.code === "LIVE_SESSION_ABORTED",
  );
  assert.equal(providerSignal.aborted, true);
  assert.deepEqual(events.filter((event) => event.type === "live.canceled").map((event) => event.code), [
    "LIVE_SESSION_ABORTED",
  ]);
  assert.equal(events.filter((event) => event.type === "live.failed").length, 0);
});

test("deduplicates declared word overlap but conservatively retains unspaced-script boundaries", async () => {
  const responses = ["hello shared words", "shared words continue", "今天世界朋友", "世界朋友再见"];
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => Response.json({ text: responses.shift(), segments: [] }),
  });
  const words = pipeline.startLiveConversation();
  await words.push(audio(0));
  await words.push({ ...audio(1), overlapBeforeMs: 500 });
  assert.equal((await words.finish()).text, "hello shared words continue");

  const cjk = pipeline.startLiveConversation();
  await cjk.push(audio(2));
  await cjk.push({ ...audio(3), overlapBeforeMs: 500 });
  assert.equal((await cjk.finish()).text, "今天世界朋友世界朋友再见");
});

test("does not erase coincidental one- or two-character CJK boundary matches", async () => {
  const responses = ["今天雨", "雨后晴", "今天下雨", "下雨以后"];
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => Response.json({ text: responses.shift(), segments: [] }),
  });
  const session = pipeline.startLiveConversation();
  await session.push(audio(0));
  await session.push({ ...audio(1), overlapBeforeMs: 500 });
  assert.equal((await session.finish()).text, "今天雨雨后晴");

  const twoCharacters = pipeline.startLiveConversation();
  await twoCharacters.push(audio(2));
  await twoCharacters.push({ ...audio(3), overlapBeforeMs: 500 });
  assert.equal((await twoCharacters.finish()).text, "今天下雨下雨以后");
});

test("enforces finite live queue limits and reports backpressure", async () => {
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => {
      await gate;
      return Response.json({ text: "window", segments: [] });
    },
  });
  const session = pipeline.startLiveConversation({ maxPendingChunks: 1, onEvent: (event) => events.push(event) });
  const first = session.push(audio(0));
  await assert.rejects(
    session.push(audio(1)),
    (error) => error instanceof DictationError && error.code === "LIVE_BACKPRESSURE_LIMIT",
  );
  assert.ok(events.some((event) => event.type === "live.backpressure"));
  release();
  await first;
  await session.finish();

  assert.throws(
    () => pipeline.startLiveConversation({ maxPendingChunks: Number.NaN }),
    (error) => error instanceof DictationError && error.code === "INVALID_LIVE_BACKPRESSURE",
  );
  assert.throws(
    () => pipeline.startLiveConversation({ cleanupWindowChars: Number.NaN }),
    (error) => error instanceof DictationError && error.code === "INVALID_LIVE_CLEANUP_WINDOW",
  );
});

test("supports raw live transcripts and rejects pushes after finish", async () => {
  let calls = 0;
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => {
      calls += 1;
      return Response.json({ text: "raw window", segments: [] });
    },
  });
  const session = pipeline.startLiveConversation({ cleanup: { mode: "none" } });
  await session.push(audio(0));
  const result = await session.finish();
  assert.equal(result.text, "raw window");
  assert.equal(result.cleanupModel, undefined);
  assert.equal(calls, 1);
  await assert.rejects(
    session.push(audio(1)),
    (error) => error instanceof DictationError && error.code === "LIVE_SESSION_CLOSED",
  );
});

test("validates browser live-window configuration without requesting a microphone", () => {
  assert.throws(
    () => new BrowserLiveRecorder({ windowMs: 500, onWindow() {} }),
    (error) => error instanceof DictationError && error.code === "INVALID_LIVE_WINDOW",
  );
  assert.throws(
    () => new BrowserLiveRecorder({ overlapMs: Number.NaN, onWindow() {} }),
    (error) => error instanceof DictationError && error.code === "INVALID_LIVE_OVERLAP",
  );
});

test("BrowserLiveRecorder flushes a self-contained final window before stopping tracks", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  let trackStopped = false;
  class FakeMediaRecorder extends EventTarget {
    static isTypeSupported(type) { return type === "audio/webm;codecs=opus"; }
    state = "inactive";
    mimeType;
    constructor(_stream, options) {
      super();
      this.mimeType = options.mimeType;
    }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      const data = new Blob(["self-contained-window"], { type: this.mimeType });
      const available = new Event("dataavailable");
      Object.defineProperty(available, "data", { value: data });
      this.dispatchEvent(available);
      queueMicrotask(() => this.dispatchEvent(new Event("stop")));
    }
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { async getUserMedia() {
      return { getTracks: () => [{ stop() { trackStopped = true; } }] };
    } } },
  });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeMediaRecorder });
  try {
    const windows = [];
    const recorder = new BrowserLiveRecorder({
      windowMs: 1_000,
      async onWindow(window, sequence) { windows.push([window, sequence]); },
    });
    await recorder.start();
    const summary = await recorder.stop();
    assert.equal(summary.windowCount, 1);
    assert.equal(windows.length, 1);
    assert.equal(windows[0][1], 0);
    assert.equal(await windows[0][0].data.text(), "self-contained-window");
    assert.equal(windows[0][0].filename, "live.webm");
    assert.equal(trackStopped, true);
  } finally {
    restoreGlobal("navigator", originalNavigator);
    restoreGlobal("MediaRecorder", originalMediaRecorder);
  }
});

test("BrowserLiveRecorder drains an accepted window before reporting a public recorder error", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  let latestRecorder;
  class FakeMediaRecorder extends EventTarget {
    static isTypeSupported() { return true; }
    state = "inactive";
    mimeType = "audio/webm";
    constructor() {
      super();
      latestRecorder = this;
    }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      const available = new Event("dataavailable");
      Object.defineProperty(available, "data", { value: new Blob(["preserved"], { type: this.mimeType }) });
      this.dispatchEvent(available);
      queueMicrotask(() => this.dispatchEvent(new Event("stop")));
    }
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } } },
  });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeMediaRecorder });
  try {
    const order = [];
    let releaseWindow;
    let releaseError;
    let markWindowStarted;
    const windowStarted = new Promise((resolve) => { markWindowStarted = resolve; });
    const windowGate = new Promise((resolve) => { releaseWindow = resolve; });
    const errorGate = new Promise((resolve) => { releaseError = resolve; });
    const recorder = new BrowserLiveRecorder({
      windowMs: 1_000,
      async onWindow() {
        markWindowStarted();
        await windowGate;
        order.push("window");
      },
      async onError() {
        order.push("error-started");
        await errorGate;
        order.push("error");
      },
    });
    await recorder.start();
    // Simulate a browser completing a playable window before surfacing a recorder failure.
    latestRecorder.stop();
    await windowStarted;
    latestRecorder.dispatchEvent(new Event("error"));
    assert.equal(recorder.isRecording, true);
    await assert.rejects(
      recorder.start(),
      (error) => error instanceof DictationError && error.code === "ALREADY_RECORDING",
    );
    const stopping = recorder.stop();
    let stopSettled = false;
    void stopping.catch(() => { stopSettled = true; });
    assert.deepEqual(order, []);
    releaseWindow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(order, ["window", "error-started"]);
    assert.equal(stopSettled, false);
    releaseError();
    await assert.rejects(
      stopping,
      (error) => error instanceof DictationError && error.code === "RECORDING_FAILED",
    );
    assert.equal(recorder.isRecording, false);
    assert.deepEqual(order, ["window", "error-started", "error"]);
  } finally {
    restoreGlobal("navigator", originalNavigator);
    restoreGlobal("MediaRecorder", originalMediaRecorder);
  }
});

test("BrowserLiveRecorder falls back to sequential windows when overlap is unsupported", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  let activeRecorders = 0;
  class SingleRecorderOnly extends EventTarget {
    static isTypeSupported() { return true; }
    state = "inactive";
    mimeType = "audio/webm";
    start() {
      if (activeRecorders > 0) throw new Error("only one recorder supported");
      activeRecorders += 1;
      this.state = "recording";
    }
    stop() {
      if (this.state === "inactive") return;
      activeRecorders -= 1;
      this.state = "inactive";
      const available = new Event("dataavailable");
      Object.defineProperty(available, "data", { value: new Blob(["window"], { type: this.mimeType }) });
      this.dispatchEvent(available);
      queueMicrotask(() => this.dispatchEvent(new Event("stop")));
    }
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } } },
  });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: SingleRecorderOnly });
  try {
    const windows = [];
    const errors = [];
    const recorder = new BrowserLiveRecorder({
      windowMs: 1_000,
      overlapMs: 500,
      onWindow: (_window, sequence) => { windows.push(sequence); },
      onError: (error) => { errors.push(error); },
    });
    await recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 1_025));
    const summary = await recorder.stop();
    assert.equal(summary.windowCount, 2);
    assert.deepEqual(windows, [0, 1]);
    assert.deepEqual(errors, []);
  } finally {
    restoreGlobal("navigator", originalNavigator);
    restoreGlobal("MediaRecorder", originalMediaRecorder);
  }
});

test("BrowserLiveRecorder clones capture tracks before creating recorder windows", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  const originalMediaStream = Object.getOwnPropertyDescriptor(globalThis, "MediaStream");
  let cloneCalls = 0;
  let clonedTrackStopped = false;
  const sourceTrack = {
    clone() {
      cloneCalls += 1;
      return { stop() { clonedTrackStopped = true; } };
    },
    stop() {},
  };
  class FakeMediaStream {
    constructor(tracks) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks; }
  }
  let recorderStream;
  class FakeMediaRecorder extends EventTarget {
    static isTypeSupported() { return true; }
    state = "inactive";
    mimeType = "audio/webm";
    constructor(stream) { super(); recorderStream = stream; }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      const available = new Event("dataavailable");
      Object.defineProperty(available, "data", { value: new Blob(["window"], { type: this.mimeType }) });
      this.dispatchEvent(available);
      queueMicrotask(() => this.dispatchEvent(new Event("stop")));
    }
  }
  const sourceStream = new FakeMediaStream([sourceTrack]);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { async getUserMedia() { return sourceStream; } } },
  });
  Object.defineProperty(globalThis, "MediaStream", { configurable: true, value: FakeMediaStream });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: FakeMediaRecorder });
  try {
    const recorder = new BrowserLiveRecorder({ windowMs: 1_000, onWindow() {} });
    await recorder.start();
    await recorder.stop();
    assert.equal(cloneCalls, 1);
    assert.notEqual(recorderStream, sourceStream);
    assert.equal(clonedTrackStopped, true);
  } finally {
    restoreGlobal("navigator", originalNavigator);
    restoreGlobal("MediaRecorder", originalMediaRecorder);
    restoreGlobal("MediaStream", originalMediaStream);
  }
});

test("BrowserLiveRecorder cancel rejects an in-flight stop", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  class SlowMediaRecorder extends EventTarget {
    static isTypeSupported() { return true; }
    state = "inactive";
    mimeType = "audio/webm";
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; }
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } } },
  });
  Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, value: SlowMediaRecorder });
  try {
    const recorder = new BrowserLiveRecorder({ windowMs: 1_000, onWindow() {} });
    await recorder.start();
    const stopping = recorder.stop();
    recorder.cancel();
    await assert.rejects(
      stopping,
      (error) => error instanceof DictationError && error.code === "LIVE_RECORDING_CANCELED",
    );
    await assert.rejects(
      recorder.stop(),
      (error) => error instanceof DictationError && error.code === "NOT_RECORDING",
    );
  } finally {
    restoreGlobal("navigator", originalNavigator);
    restoreGlobal("MediaRecorder", originalMediaRecorder);
  }
});

test("BrowserLiveRecorder cancels a pending microphone request without activating it", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  let resolveMicrophone;
  let recorderConstructions = 0;
  let trackStops = 0;
  class PendingMediaRecorder extends EventTarget {
    static isTypeSupported() { return true; }
    constructor() {
      super();
      recorderConstructions += 1;
    }
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia() {
      return new Promise((resolve) => { resolveMicrophone = resolve; });
    } } },
  });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: PendingMediaRecorder,
  });
  try {
    const recorder = new BrowserLiveRecorder({ windowMs: 1_000, onWindow() {} });
    const starting = recorder.start();
    assert.equal(recorder.isRecording, true);
    recorder.cancel();
    assert.equal(recorder.isRecording, false);
    resolveMicrophone({ getTracks: () => [{ stop() { trackStops += 1; } }] });
    await assert.rejects(
      starting,
      (error) => error instanceof DictationError && error.code === "LIVE_RECORDING_CANCELED",
    );
    assert.equal(trackStops, 1);
    assert.equal(recorderConstructions, 0);
    assert.equal(recorder.isRecording, false);
    await assert.rejects(
      recorder.stop(),
      (error) => error instanceof DictationError && error.code === "NOT_RECORDING",
    );
  } finally {
    restoreGlobal("navigator", originalNavigator);
    restoreGlobal("MediaRecorder", originalMediaRecorder);
  }
});

test("BrowserLiveRecorder stop during pending microphone permission resolves an empty recording", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  let resolveMicrophone;
  let recorderConstructions = 0;
  let trackStops = 0;
  class PendingMediaRecorder extends EventTarget {
    static isTypeSupported() { return true; }
    constructor() {
      super();
      recorderConstructions += 1;
    }
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia() {
      return new Promise((resolve) => { resolveMicrophone = resolve; });
    } } },
  });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: PendingMediaRecorder,
  });
  try {
    const recorder = new BrowserLiveRecorder({ windowMs: 1_000, onWindow() {} });
    const starting = recorder.start();
    assert.deepEqual(await recorder.stop(), { durationMs: 0, windowCount: 0 });
    assert.equal(recorder.isRecording, false);
    resolveMicrophone({ getTracks: () => [{ stop() { trackStops += 1; } }] });
    await assert.rejects(
      starting,
      (error) => error instanceof DictationError && error.code === "LIVE_RECORDING_CANCELED",
    );
    assert.equal(trackStops, 1);
    assert.equal(recorderConstructions, 0);
  } finally {
    restoreGlobal("navigator", originalNavigator);
    restoreGlobal("MediaRecorder", originalMediaRecorder);
  }
});

test("BrowserLiveRecorder isolates a new recording from stale completion after cancel", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  const recorders = [];
  const trackStops = [];
  class GenerationMediaRecorder extends EventTarget {
    static isTypeSupported() { return true; }
    state = "inactive";
    mimeType = "audio/webm";
    index;
    constructor() {
      super();
      this.index = recorders.length;
      recorders.push(this);
    }
    start() { this.state = "recording"; }
    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      if (this.index === 0) {
        const available = new Event("dataavailable");
        Object.defineProperty(available, "data", {
          value: new Blob(["old-window"], { type: this.mimeType }),
        });
        this.dispatchEvent(available);
      }
      queueMicrotask(() => this.dispatchEvent(new Event("stop")));
    }
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { async getUserMedia() {
      const index = trackStops.length;
      trackStops.push(0);
      return { getTracks: () => [{ stop() { trackStops[index] += 1; } }] };
    } } },
  });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: GenerationMediaRecorder,
  });
  try {
    let releaseOldWindow;
    let markOldWindowStarted;
    const oldWindowStarted = new Promise((resolve) => { markOldWindowStarted = resolve; });
    const oldWindowGate = new Promise((resolve) => { releaseOldWindow = resolve; });
    const errors = [];
    const recorder = new BrowserLiveRecorder({
      windowMs: 1_000,
      async onWindow() {
        markOldWindowStarted();
        await oldWindowGate;
      },
      onError(error) { errors.push(error); },
    });

    await recorder.start();
    recorders[0].stop();
    await oldWindowStarted;
    recorders[0].dispatchEvent(new Event("error"));
    recorder.cancel();

    await recorder.start();
    const secondStop = recorder.stop();
    releaseOldWindow();
    const summary = await secondStop;

    assert.equal(summary.windowCount, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(trackStops, [1, 1]);
    assert.equal(recorder.isRecording, false);
  } finally {
    restoreGlobal("navigator", originalNavigator);
    restoreGlobal("MediaRecorder", originalMediaRecorder);
  }
});

test("BrowserLiveRecorder cannot settle a new recording after an old async onError", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  const recorders = [];
  const trackStops = [];
  class ErrorGenerationRecorder extends EventTarget {
    static isTypeSupported() { return true; }
    state = "inactive";
    mimeType = "audio/webm";
    constructor() {
      super();
      recorders.push(this);
    }
    start() { this.state = "recording"; }
    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      queueMicrotask(() => this.dispatchEvent(new Event("stop")));
    }
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { async getUserMedia() {
      const index = trackStops.length;
      trackStops.push(0);
      return { getTracks: () => [{ stop() { trackStops[index] += 1; } }] };
    } } },
  });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: ErrorGenerationRecorder,
  });
  try {
    let releaseOldError;
    let markOldErrorStarted;
    const oldErrorStarted = new Promise((resolve) => { markOldErrorStarted = resolve; });
    const oldErrorGate = new Promise((resolve) => { releaseOldError = resolve; });
    const recorder = new BrowserLiveRecorder({
      windowMs: 1_000,
      onWindow() {},
      async onError() {
        markOldErrorStarted();
        await oldErrorGate;
      },
    });

    await recorder.start();
    recorders[0].dispatchEvent(new Event("error"));
    await oldErrorStarted;
    recorder.cancel();

    await recorder.start();
    const secondStop = recorder.stop();
    releaseOldError();
    const summary = await secondStop;

    assert.equal(summary.windowCount, 0);
    assert.deepEqual(trackStops, [1, 1]);
    assert.equal(recorder.isRecording, false);
  } finally {
    restoreGlobal("navigator", originalNavigator);
    restoreGlobal("MediaRecorder", originalMediaRecorder);
  }
});

test("BrowserLiveRecorder cancel suppresses accepted windows that have not reached the sink", async () => {
  const restoreRecorder = installRotatingMediaRecorder();
  const delivered = [];
  let release;
  let markFirstStarted;
  const gate = new Promise((resolve) => { release = resolve; });
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const recorder = new BrowserLiveRecorder({
    windowMs: 1_000,
    overlapMs: 500,
    onWindow: async (_window, sequence) => {
      delivered.push(sequence);
      if (sequence === 0) {
        markFirstStarted();
        await gate;
      }
    },
  });
  try {
    await recorder.start();
    await firstStarted;
    const stopping = recorder.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    recorder.cancel();
    release();
    await assert.rejects(
      stopping,
      (error) => error instanceof DictationError && error.code === "LIVE_RECORDING_CANCELED",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(delivered, [0]);
  } finally {
    recorder.cancel();
    restoreRecorder();
  }
});

test("BrowserLiveRecorder enforces its encoded-byte queue bound", async () => {
  const restoreRecorder = installRotatingMediaRecorder();
  let release;
  let markFirstStarted;
  const gate = new Promise((resolve) => { release = resolve; });
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const errors = [];
  const recorder = new BrowserLiveRecorder({
    windowMs: 1_000,
    overlapMs: 500,
    maxPendingWindows: 4,
    maxPendingBytes: 12,
    onWindow: (_window, sequence) => {
      if (sequence === 0) markFirstStarted();
      return gate;
    },
    onError: (error) => { errors.push(error); },
  });
  try {
    await recorder.start();
    await firstStarted;
    const stopping = recorder.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(errors, []);
    release();
    await assert.rejects(
      stopping,
      (error) => error instanceof DictationError && error.code === "LIVE_BACKPRESSURE_LIMIT",
    );
    assert.equal(errors[0]?.code, "LIVE_BACKPRESSURE_LIMIT");
  } finally {
    recorder.cancel();
    restoreRecorder();
  }
});

function installRotatingMediaRecorder() {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalMediaRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  class RotatingMediaRecorder extends EventTarget {
    static isTypeSupported() { return true; }
    state = "inactive";
    mimeType = "audio/webm";
    start() { this.state = "recording"; }
    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      const available = new Event("dataavailable");
      Object.defineProperty(available, "data", {
        value: new Blob(["12345678"], { type: this.mimeType }),
      });
      this.dispatchEvent(available);
      queueMicrotask(() => this.dispatchEvent(new Event("stop")));
    }
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } } },
  });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: RotatingMediaRecorder,
  });
  return () => {
    restoreGlobal("navigator", originalNavigator);
    restoreGlobal("MediaRecorder", originalMediaRecorder);
  };
}

function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}
