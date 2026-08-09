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

function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}
