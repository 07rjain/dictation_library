import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DictationError,
  DictationPipeline,
  MemoryJobStore,
  SileroVadWavAudioProcessor,
  VadWavAudioProcessor,
  WavAudioProcessor,
  inspectAudio,
  routeAudio,
  stitchChunks,
  stitchChunksDetailed,
} from "../dist/index.js";

const wavBytes = await readFile(new URL("../test.wav", import.meta.url));
const wavAudio = {
  data: new Blob([wavBytes], { type: "audio/wav" }),
  filename: "test.wav",
};

test("inspects and codec-safely segments PCM WAV audio", async () => {
  const metadata = await inspectAudio(wavAudio);
  assert.equal(metadata.sampleRate, 48_000);
  assert.equal(metadata.channels, 1);
  assert.ok(metadata.durationMs > 2_400 && metadata.durationMs < 2_500);

  const chunks = await new WavAudioProcessor().segment(wavAudio, {
    targetChunkMs: 1_000,
    overlapMs: 200,
  });
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((chunk) => chunk.startMs), [0, 800, 1_600]);
  for (const chunk of chunks) {
    const header = Buffer.from(await chunk.audio.data.slice(0, 12).arrayBuffer()).toString("ascii");
    assert.equal(header.slice(0, 4), "RIFF");
    assert.equal(header.slice(8, 12), "WAVE");
  }
});

test("large WAV segmentation and durable SHA-256 avoid whole-Blob arrayBuffer", async () => {
  class StreamOnlyBlob extends Blob {
    async arrayBuffer() { throw new Error("whole blob buffering is forbidden"); }
  }
  const payload = new Uint8Array(5 * 1024 * 1024);
  for (let index = 0; index < payload.length; index += 65_537) payload[index] = index % 251;
  const wav = createWavWithPayload(payload);
  const streamOnly = {
    data: new StreamOnlyBlob([wav], { type: "audio/wav" }),
    filename: "large-stream-only.wav",
  };
  const chunks = await new WavAudioProcessor().segment(streamOnly, {
    targetChunkMs: 20_000,
    overlapMs: 0,
  });
  assert.ok(chunks.length > 1);

  const processor = {
    name: "stream-identity-test",
    async inspect(input) {
      return { sizeBytes: input.data.size, mimeType: "audio/test", filename: "large.test", durationMs: 1_000 };
    },
    supports() { return true; },
    async segment(input) {
      return [{ index: 0, startMs: 0, endMs: 1_000, overlapBeforeMs: 0, audio: input }];
    },
  };
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => Response.json({ text: "streamed", segments: [] }),
  });
  const job = pipeline.createJob(streamOnly, { processor, cleanup: { mode: "none" } });
  await job.result();
  const manifest = await job.inspect();
  const expected = createHash("sha256").update(Buffer.from(wav)).digest("hex");
  assert.equal(manifest.source.fingerprint, `sha256:${expected}`);
});

test("runs a bounded long job, emits progress, and stitches overlap", async () => {
  let active = 0;
  let maximumActive = 0;
  const fetch = async (_url, init) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const filename = init.body.get("file").name;
    const index = Number(filename.match(/(\d+)/)?.[1] ?? 0);
    const responses = [
      { text: "Hello shared", segments: [{ text: "Hello shared", start: 0, end: 1 }] },
      { text: "shared this is", segments: [{ text: "shared", start: 0, end: 0.1 }, { text: "this is", start: 0.2, end: 1 }] },
      { text: "is a live test", segments: [{ text: "is", start: 0, end: 0.1 }, { text: "a live test", start: 0.2, end: 0.8 }] },
    ];
    active -= 1;
    return Response.json(responses[index]);
  };
  const pipeline = new DictationPipeline({ apiKey: "test", fetch, retry: { maxAttempts: 1 } });
  const job = pipeline.createJob(wavAudio, {
    targetChunkMs: 1_000,
    overlapMs: 200,
    concurrency: 2,
  });
  const eventsPromise = collect(job.events());
  const result = await job.result();
  const events = await eventsPromise;

  assert.equal(result.rawTranscript, "Hello shared this is a live test");
  assert.equal(result.text, result.rawTranscript);
  assert.equal(result.chunks.length, 3);
  assert.equal(result.chunks[1].segments[0].start, 0.8);
  assert.equal(result.chunks[2].segments[0].start, 1.6);
  assert.ok(maximumActive <= 2);
  assert.equal(events.filter((event) => event.type === "chunk.completed").length, 3);
  assert.equal(events.at(-1).type, "job.completed");
});

test("persists successful chunks and resumes only failed chunks", async () => {
  let allowMiddle = false;
  const calls = new Map();
  const fetch = async (_url, init) => {
    const filename = init.body.get("file").name;
    const index = Number(filename.match(/(\d+)/)?.[1] ?? 0);
    calls.set(index, (calls.get(index) ?? 0) + 1);
    if (index === 1 && !allowMiddle) return new Response("temporary", { status: 500 });
    return Response.json({ text: `chunk ${index}`, segments: [] });
  };
  const pipeline = new DictationPipeline({ apiKey: "test", fetch, retry: { maxAttempts: 1 } });
  const first = pipeline.createJob(wavAudio, {
    targetChunkMs: 1_000,
    overlapMs: 200,
    concurrency: 2,
  });
  await assert.rejects(first.result(), (error) => {
    assert.ok(error instanceof DictationError);
    assert.equal(error.code, "CHUNK_TRANSCRIPTION_FAILED");
    assert.equal(error.details.completedChunks.length, 2);
    assert.ok(error.details.partialTranscript.includes("chunk 0"));
    return true;
  });
  const partial = await first.inspect();
  assert.equal(partial.status, "partial");
  assert.deepEqual(partial.chunks.map((chunk) => chunk.status), ["completed", "failed", "completed"]);

  allowMiddle = true;
  const resumed = pipeline.resumeJob(first.id, wavAudio, {
    targetChunkMs: 1_000,
    overlapMs: 200,
  });
  const result = await resumed.result();
  assert.equal(result.chunks.length, 3);
  assert.equal(calls.get(0), 1);
  assert.equal(calls.get(1), 2);
  assert.equal(calls.get(2), 1);
});

test("reuses a completed job only when the original audio source matches", async () => {
  let calls = 0;
  const pipeline = new DictationPipeline({
    apiKey: "test",
    retry: { maxAttempts: 1 },
    fetch: async () => {
      calls += 1;
      return Response.json({ text: `chunk ${calls}`, segments: [] });
    },
  });
  const first = pipeline.createJob(wavAudio, {
    jobId: "completed_source_check",
    targetChunkMs: 1_000,
    overlapMs: 200,
  });
  const original = await first.result();
  const callsAfterCompletion = calls;
  const cached = await pipeline.resumeJob(first.id, wavAudio, {
    targetChunkMs: 1_000,
    overlapMs: 200,
  }).result();
  assert.deepEqual(cached, original);
  assert.equal(calls, callsAfterCompletion);

  const changedAudio = {
    data: new Blob([wavBytes, new Uint8Array([0])], { type: "audio/wav" }),
    filename: "changed.wav",
  };
  await assert.rejects(
    pipeline.resumeJob(first.id, changedAudio).result(),
    (error) => error instanceof DictationError && error.code === "JOB_SOURCE_MISMATCH",
  );
  assert.equal(calls, callsAfterCompletion);
});

test("resumes a legacy 0.3.x manifest and upgrades its source identity in place", async () => {
  const store = new MemoryJobStore();
  let providerCalls = 0;
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => {
      providerCalls += 1;
      return Response.json({ text: "legacy-compatible", segments: [] });
    },
  });
  const options = {
    jobId: "legacy-fingerprint-migration",
    store,
    targetChunkMs: 10_000,
    cleanup: { mode: "none" },
  };
  const original = await pipeline.createJob(wavAudio, options).result();
  const callsAfterCompletion = providerCalls;
  const legacyFingerprint = (await inspectAudio(wavAudio)).fingerprint;
  assert.ok(legacyFingerprint && !legacyFingerprint.startsWith("sha256:"));
  const legacyManifest = await store.load(options.jobId);
  legacyManifest.source = { ...legacyManifest.source, fingerprint: legacyFingerprint };
  delete legacyManifest.configurationKey;
  delete legacyManifest.source.legacyFingerprint;
  legacyManifest.result = {
    ...legacyManifest.result,
    source: { ...legacyManifest.result.source, fingerprint: legacyFingerprint },
  };
  delete legacyManifest.result.stitching;
  delete legacyManifest.result.source.legacyFingerprint;
  await store.save(legacyManifest);

  await assert.rejects(
    pipeline.createJob(wavAudio, options).result(),
    (error) => error instanceof DictationError && error.code === "JOB_LEGACY_MIGRATION_REQUIRED",
  );
  const resumed = await pipeline.createJob(wavAudio, {
    ...options,
    migrateLegacyManifest: true,
  }).result();
  assert.deepEqual(resumed, original);
  assert.equal(providerCalls, callsAfterCompletion);
  const upgraded = await store.load(options.jobId);
  assert.ok(upgraded.source.fingerprint.startsWith("sha256:"));
  assert.equal(upgraded.source.legacyFingerprint, legacyFingerprint);
  assert.ok(upgraded.result.source.fingerprint.startsWith("sha256:"));
  assert.equal(upgraded.result.source.legacyFingerprint, legacyFingerprint);
  assert.ok(Array.isArray(upgraded.result.stitching));
});

test("long jobs fail explicitly when Web Crypto SHA-256 is unavailable", async () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  let providerCalls = 0;
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    const pipeline = new DictationPipeline({
      apiKey: "test",
      fetch: async () => {
        providerCalls += 1;
        return Response.json({ text: "must not run", segments: [] });
      },
    });
    await assert.rejects(
      pipeline.createJob(wavAudio).result(),
      (error) => error instanceof DictationError && error.code === "DURABLE_IDENTITY_UNAVAILABLE",
    );
    assert.equal(providerCalls, 0);
  } finally {
    if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
    else delete globalThis.crypto;
  }
});

test("long-job resume detects equal-sized mutations outside the old head and tail samples", async () => {
  const prefix = new Uint8Array(70_000).fill(1);
  const suffix = new Uint8Array(70_000).fill(2);
  const originalMiddle = new Uint8Array(70_000).fill(3);
  const changedMiddle = new Uint8Array(70_000).fill(4);
  const original = { data: new Blob([prefix, originalMiddle, suffix], { type: "audio/test" }), filename: "source.test" };
  const changed = { data: new Blob([prefix, changedMiddle, suffix], { type: "audio/test" }), filename: "source.test" };
  const store = new MemoryJobStore();
  const processor = {
    name: "identity-test",
    async inspect(input) {
      return { sizeBytes: input.data.size, mimeType: "audio/test", filename: "source.test", durationMs: 1_000 };
    },
    supports() { return true; },
    async segment(input) {
      return [{ index: 0, startMs: 0, endMs: 1_000, overlapBeforeMs: 0, audio: input }];
    },
  };
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => Response.json({ text: "original", segments: [] }),
  });
  await pipeline.createJob(original, {
    jobId: "full-fingerprint",
    store,
    processor,
    cleanup: { mode: "none" },
  }).result();
  await assert.rejects(
    pipeline.createJob(changed, {
      jobId: "full-fingerprint",
      store,
      processor,
      cleanup: { mode: "none" },
    }).result(),
    (error) => error instanceof DictationError && error.code === "JOB_SOURCE_MISMATCH",
  );
});

test("content-addressed configuration prevents completed chunk reuse under different prompts", async () => {
  const store = new MemoryJobStore();
  let providerCalls = 0;
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => {
      providerCalls += 1;
      return Response.json({ text: "configured", segments: [] });
    },
  });
  await pipeline.createJob(wavAudio, {
    jobId: "configuration-identity",
    store,
    prompt: "Vocabulary A",
    cleanup: { mode: "none" },
  }).result();
  const callsAfterCompletion = providerCalls;
  const manifest = await store.load("configuration-identity");
  assert.ok(manifest.configurationKey.startsWith("sha256:"));
  assert.ok(manifest.chunks.every((chunk) => chunk.requestKey?.startsWith("sha256:")));
  await assert.rejects(
    pipeline.createJob(wavAudio, {
      jobId: "configuration-identity",
      store,
      prompt: "Vocabulary B",
      cleanup: { mode: "none" },
    }).result(),
    (error) => error instanceof DictationError && error.code === "JOB_CONFIGURATION_MISMATCH",
  );
  assert.equal(providerCalls, callsAfterCompletion);
});

test("records provider attempts and unknown timeout/network outcomes separately", async () => {
  const store = new MemoryJobStore();
  const pipeline = new DictationPipeline({
    apiKey: "test",
    retry: { maxAttempts: 1 },
    fetch: async () => { throw new TypeError("connection reset after upload"); },
  });
  const job = pipeline.createJob(wavAudio, {
    jobId: "unknown-provider-outcome",
    store,
    cleanup: { mode: "none" },
  });
  await assert.rejects(job.result(), (error) => error.code === "CHUNK_TRANSCRIPTION_FAILED");
  const manifest = await store.load(job.id);
  assert.equal(manifest.chunks[0].attempts, 1);
  assert.equal(manifest.chunks[0].providerAttempts, 1);
  assert.equal(manifest.chunks[0].unknownProviderOutcomes, 1);
});

test("provider rate limits dynamically reduce future long-job concurrency", async () => {
  const events = [];
  const attempts = new Map();
  let active = 0;
  let thirdChunkActiveAtStart;
  const pipeline = new DictationPipeline({
    apiKey: "test",
    retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    fetch: async (_url, init) => {
      const index = Number(init.body.get("file").name.match(/chunk-(\d+)/)?.[1] ?? 0);
      attempts.set(index, (attempts.get(index) ?? 0) + 1);
      active += 1;
      if (index === 2) thirdChunkActiveAtStart = active;
      if (index === 0 && attempts.get(index) === 1) {
        active -= 1;
        return new Response("slow down", { status: 429, headers: { "Retry-After": "0" } });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return Response.json({ text: `chunk ${index}`, segments: [] });
    },
  });
  const job = pipeline.createJob(wavAudio, {
    targetChunkMs: 1_000,
    overlapMs: 200,
    concurrency: 2,
    cleanup: { mode: "none" },
  });
  const eventTask = (async () => { for await (const event of job.events()) events.push(event); })();
  const result = await job.result();
  await eventTask;
  assert.equal(result.chunks.length, 3);
  assert.ok(events.some((event) => event.type === "concurrency.reduced" && event.to === 1));
  assert.equal(thirdChunkActiveAtStart, 1);
  const manifest = await job.inspect();
  assert.equal(manifest.chunks.reduce((sum, chunk) => sum + chunk.providerAttempts, 0), 4);
});

test("long-job concurrency cautiously recovers after sustained provider success", async () => {
  const events = [];
  let calls = 0;
  const pipeline = new DictationPipeline({
    apiKey: "test",
    retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    fetch: async (_url, init) => {
      calls += 1;
      if (calls === 1) return new Response("slow down", { status: 429, headers: { "Retry-After": "0" } });
      const index = Number(init.body.get("file").name.match(/chunk-(\d+)/)?.[1] ?? 0);
      return Response.json({ text: `chunk ${index}`, segments: [] });
    },
  });
  const job = pipeline.createJob(makeToneWav(7_000, []), {
    targetChunkMs: 1_000,
    overlapMs: 0,
    concurrency: 2,
    cleanup: { mode: "none" },
  });
  const eventTask = (async () => { for await (const event of job.events()) events.push(event); })();
  await job.result();
  await eventTask;
  assert.ok(events.some((event) => event.type === "concurrency.reduced" && event.to === 1));
  assert.ok(events.some((event) => event.type === "concurrency.increased" && event.from === 1 && event.to === 2));
});

test("a fatal chunk failure aborts in-flight requests and prevents launching queued chunks", async () => {
  const called = [];
  let aborted = 0;
  const processor = {
    name: "fatal-pool-test",
    async inspect(input) {
      return { sizeBytes: input.data.size, mimeType: "audio/test", durationMs: 5_000 };
    },
    supports() { return true; },
    async segment(input) {
      return Array.from({ length: 5 }, (_, index) => ({
        index,
        startMs: index * 1_000,
        endMs: (index + 1) * 1_000,
        overlapBeforeMs: 0,
        audio: { ...input, filename: `chunk-${index}.wav` },
      }));
    },
  };
  const pipeline = new DictationPipeline({
    apiKey: "test",
    retry: { maxAttempts: 1 },
    fetch: async (_url, init) => {
      const index = Number(init.body.get("file").name.match(/chunk-(\d+)/)?.[1] ?? 0);
      called.push(index);
      if (index === 0) return new Response("fatal", { status: 400 });
      return new Promise((_resolve, reject) => {
        if (init.signal.aborted) {
          aborted += 1;
          reject(init.signal.reason);
          return;
        }
        init.signal.addEventListener("abort", () => {
          aborted += 1;
          reject(init.signal.reason);
        }, { once: true });
      });
    },
  });
  await assert.rejects(pipeline.dictateLong(wavAudio, {
    processor,
    concurrency: 2,
    continueOnError: false,
    cleanup: { mode: "none" },
  }), (error) => error instanceof DictationError && error.status === 400);
  assert.deepEqual(called.sort(), [0, 1]);
  assert.equal(aborted, 1);
});

test("a store lease prevents two workers from processing the same durable job", async () => {
  const store = new MemoryJobStore();
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstPipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => {
      firstStarted();
      await gate;
      return Response.json({ text: "owned", segments: [] });
    },
  });
  const secondPipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => Response.json({ text: "duplicate", segments: [] }),
  });
  const options = { jobId: "leased-job", store, cleanup: { mode: "none" } };
  const first = firstPipeline.createJob(wavAudio, options).result();
  await started;
  await assert.rejects(
    secondPipeline.createJob(wavAudio, options).result(),
    (error) => error instanceof DictationError && error.code === "JOB_LEASE_UNAVAILABLE",
  );
  releaseFirst();
  await first;
});

test("reports a missing manifest when inspecting a job that has not started", async () => {
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => { throw new Error("must not call provider"); },
  });
  const job = pipeline.createJob(wavAudio, { jobId: "not_started" });
  await assert.rejects(
    job.inspect(),
    (error) => error instanceof DictationError && error.code === "JOB_NOT_FOUND",
  );
});

test("MemoryJobStore isolates saved and loaded manifests from caller mutation", async () => {
  const store = new MemoryJobStore();
  const manifest = {
    version: 1,
    jobId: "clone_check",
    status: "pending",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    mode: "interactive",
    source: { sizeBytes: 1 },
    processor: "test",
    targetChunkMs: 1_000,
    overlapMs: 0,
    concurrency: 1,
    chunks: [],
  };
  await store.save(manifest);
  manifest.status = "failed";
  const firstLoad = await store.load("clone_check");
  assert.equal(firstLoad.status, "pending");
  firstLoad.status = "completed";
  assert.equal((await store.load("clone_check")).status, "pending");
});

test("a failed manifest save does not poison the serialized persistence chain", async () => {
  class RecoveringStore extends MemoryJobStore {
    saveCalls = 0;
    async save(manifest) {
      this.saveCalls += 1;
      if (this.saveCalls === 1) throw new Error("temporary store outage");
      await super.save(manifest);
    }
  }
  const store = new RecoveringStore();
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => { throw new Error("provider must not be reached"); },
  });
  await assert.rejects(
    pipeline.createJob(wavAudio, { jobId: "recover_save_chain", store }).result(),
    (error) => error instanceof DictationError && error.code === "JOB_FAILED",
  );
  assert.equal(store.saveCalls, 2);
  assert.equal((await store.load("recover_save_chain")).status, "failed");
});

test("rejects oversized direct uploads before calling the provider", async () => {
  let called = false;
  const pipeline = new DictationPipeline({
    apiKey: "test",
    directUploadMaxBytes: 10,
    fetch: async () => {
      called = true;
      return Response.json({ text: "unexpected", segments: [] });
    },
  });
  await assert.rejects(
    pipeline.transcribe({ data: new Blob(["larger than ten bytes"], { type: "audio/webm" }) }),
    (error) => error instanceof DictationError && error.code === "AUDIO_TOO_LARGE",
  );
  assert.equal(called, false);
});

test("dictateAuto rejects an oversized non-WAV input before using the WAV processor", async () => {
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => { throw new Error("must not call provider"); },
  });
  const webm = {
    data: new Blob([new Uint8Array(64)], { type: "audio/webm" }),
    filename: "recording.webm",
  };
  await assert.rejects(
    pipeline.dictateAuto(webm, { forceLong: true }),
    (error) => error instanceof DictationError && error.code === "LONG_AUDIO_PROCESSOR_REQUIRED",
  );
});

test("explicit long jobs apply the same processor compatibility preflight", async () => {
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => { throw new Error("must not call provider"); },
  });
  const webm = {
    data: new Blob([new Uint8Array(64)], { type: "audio/webm" }),
    filename: "recording.webm",
  };
  await assert.rejects(
    pipeline.createJob(webm).result(),
    (error) => error instanceof DictationError && error.code === "LONG_AUDIO_PROCESSOR_REQUIRED",
  );
});

test("dictateAuto passes routed source metadata into the long job without another inspection", async () => {
  let inspections = 0;
  const processor = {
    name: "counting-processor",
    async inspect(input) {
      inspections += 1;
      return { sizeBytes: input.data.size, mimeType: "audio/test", filename: "input.test", durationMs: 1_000 };
    },
    supports() { return true; },
    async segment(input) {
      return [{ index: 0, startMs: 0, endMs: 1_000, overlapBeforeMs: 0, audio: input }];
    },
  };
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => Response.json({ text: "one chunk", segments: [] }),
  });
  await pipeline.dictateAuto(wavAudio, { forceLong: true, processor, cleanup: { mode: "none" } });
  assert.equal(inspections, 1);
});

test("cleanup guard preserves raw text after excessive deletion", async () => {
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => Response.json({ choices: [{ message: { content: "Tiny." } }] }),
  });
  const source = "This is a deliberately long sentence containing names numbers decisions and important details.";
  const result = await pipeline.cleanup(source, { mode: "verbatim", maxDeletionRatio: 0.1 });
  assert.equal(result.text, source);
  assert.equal(result.rejected, true);
});

test("long cleanup uses bounded windows and preserves every rejected window", async () => {
  const longText = `${"Important transcript details must remain unchanged. ".repeat(300)}END_MARKER`;
  let cleanupCalls = 0;
  const pipeline = new DictationPipeline({
    apiKey: "test",
    retry: { maxAttempts: 1 },
    fetch: async (url) => {
      if (String(url).endsWith("/audio/transcriptions")) {
        return Response.json({ text: longText, segments: [] });
      }
      cleanupCalls += 1;
      return Response.json({ choices: [{ message: { content: "Tiny." } }] });
    },
  });
  const result = await pipeline.dictateLong(wavAudio, {
    targetChunkMs: 10_000,
    overlapMs: 0,
    cleanup: { mode: "verbatim", maxDeletionRatio: 0.05 },
  });
  assert.ok(cleanupCalls >= 2);
  assert.equal(result.cleanupRejected, true);
  assert.equal(result.text, result.rawTranscript);
  assert.equal(result.text, longText);
});

test("sequential accuracy mode carries prior text and never overlaps requests", async () => {
  let active = 0;
  let maximumActive = 0;
  const prompts = [];
  const pipeline = new DictationPipeline({
    apiKey: "test",
    retry: { maxAttempts: 1 },
    fetch: async (_url, init) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      prompts.push(init.body.get("prompt"));
      const index = Number(init.body.get("file").name.match(/(\d+)/)?.[1] ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active -= 1;
      return Response.json({ text: `prior context ${index}`, segments: [] });
    },
  });
  await pipeline.dictateLong(wavAudio, {
    targetChunkMs: 1_000,
    overlapMs: 200,
    concurrency: 8,
    accuracyMode: "sequential",
  });
  assert.equal(maximumActive, 1);
  assert.equal(prompts[0], null);
  assert.ok(prompts[1].includes("prior context 0"));
  assert.ok(prompts[2].includes("prior context 1"));
});

test("stitching deduplicates only when chunks have temporal overlap", () => {
  const chunks = [
    { index: 0, startMs: 0, endMs: 1_000, overlapBeforeMs: 0, text: "yes yes", segments: [], model: "test", durationMs: 1 },
    { index: 1, startMs: 1_000, endMs: 2_000, overlapBeforeMs: 0, text: "yes again", segments: [], model: "test", durationMs: 1 },
  ];
  assert.equal(stitchChunks(chunks), "yes yes yes again");
});

test("stitching preserves both readings when overlap ownership lacks timestamps", () => {
  const chunks = [
    { index: 0, startMs: 0, endMs: 60_000, overlapBeforeMs: 0, text: "we deployed the colour service", segments: [], model: "test", durationMs: 1 },
    { index: 1, startMs: 58_000, endMs: 118_000, overlapBeforeMs: 2_000, text: "the color service successfully today", segments: [], model: "test", durationMs: 1 },
  ];
  const stitched = stitchChunksDetailed(chunks);
  assert.equal(stitched.text, "we deployed the colour service the color service successfully today");
  assert.deepEqual(stitched.decisions, [{
    boundaryIndex: 1,
    confidence: "low",
    method: "preserved-uncertain",
    deduplicatedSegments: 0,
    alternatives: ["we deployed the colour service", "the color service successfully today"],
  }]);
});

test("stitching removes only timestamp-proven overlap and records provenance", () => {
  const chunks = [
    {
      index: 0, startMs: 0, endMs: 60_000, overlapBeforeMs: 0, text: "we deployed the service",
      segments: [{ start: 55, end: 59.5, text: "we deployed the service" }], model: "test", durationMs: 1,
    },
    {
      index: 1, startMs: 58_000, endMs: 118_000, overlapBeforeMs: 2_000, text: "the service succeeded",
      segments: [
        { start: 58, end: 58.8, text: "the service" },
        { start: 59.2, end: 62, text: "succeeded" },
      ],
      model: "test", durationMs: 1,
    },
  ];
  const stitched = stitchChunksDetailed(chunks);
  assert.equal(stitched.text, "we deployed the service succeeded");
  assert.deepEqual(stitched.decisions, [{
    boundaryIndex: 1,
    confidence: "high",
    method: "timestamp-ownership",
    deduplicatedSegments: 1,
  }]);
});

test("stitching never restores a later chunk whose entire timestamped region is unowned", () => {
  const stitched = stitchChunksDetailed([
    {
      index: 0, startMs: 0, endMs: 60_000, overlapBeforeMs: 0, text: "hello",
      segments: [{ start: 0, end: 59.5, text: "hello" }], model: "test", durationMs: 1,
    },
    {
      index: 1, startMs: 58_000, endMs: 118_000, overlapBeforeMs: 2_000,
      text: "SHOULD NOT APPEAR",
      segments: [{ start: 58, end: 58.8, text: "SHOULD NOT APPEAR" }], model: "test", durationMs: 1,
    },
  ]);
  assert.equal(stitched.text, "hello");
  assert.equal(stitched.decisions[0].deduplicatedSegments, 1);
});

test("stitching applies timestamp ownership bilaterally across the overlap midpoint", () => {
  const stitched = stitchChunksDetailed([
    {
      index: 0, startMs: 0, endMs: 60_000, overlapBeforeMs: 0, text: "hello extra",
      segments: [
        { start: 0, end: 58.8, text: "hello" },
        { start: 59.2, end: 59.8, text: "extra" },
      ], model: "test", durationMs: 1,
    },
    {
      index: 1, startMs: 58_000, endMs: 118_000, overlapBeforeMs: 2_000, text: "extra world",
      segments: [
        { start: 58.4, end: 58.8, text: "extra" },
        { start: 59.2, end: 62, text: "world" },
      ], model: "test", durationMs: 1,
    },
  ]);
  assert.equal(stitched.text, "hello world");
  assert.equal(stitched.decisions[0].deduplicatedSegments, 2);
});

test("VAD-assisted WAV boundaries move to silence without deleting timeline coverage", async () => {
  const audio = makeToneWav(3_000, [[850, 1_100], [1_850, 2_100]]);
  const chunks = await new VadWavAudioProcessor({ boundarySearchMs: 300 }).segment(audio, {
    targetChunkMs: 1_000,
    overlapMs: 100,
  });
  assert.ok(chunks[0].endMs >= 850 && chunks[0].endMs <= 1_100);
  for (let index = 1; index < chunks.length; index += 1) {
    assert.equal(chunks[index].startMs, chunks[index - 1].endMs - 100);
  }
  assert.equal(chunks.at(-1).endMs, 3_000);
});

test("Silero-compatible learned VAD evaluates only bounded boundary windows", async () => {
  const calls = [];
  const vad = {
    async *run(samples, sampleRate) {
      calls.push({ samples: samples.length, sampleRate });
      yield { start: 200, end: 400 };
    },
  };
  const audio = makeToneWav(3_000, []);
  const chunks = await new SileroVadWavAudioProcessor(vad, { boundarySearchMs: 300 }).segment(audio, {
    targetChunkMs: 1_000,
    overlapMs: 100,
  });
  assert.equal(chunks[0].endMs, 900);
  assert.equal(calls[0].sampleRate, 16_000);
  assert.ok(calls[0].samples < 16_000);
  assert.equal(chunks.at(-1).endMs, 3_000);
});

test("accuracy mode retries only low-confidence boundaries with prior context", async () => {
  const calls = new Map();
  const prompts = [];
  const fetch = async (_url, init) => {
    const filename = init.body.get("file").name;
    const index = Number(filename.match(/(\d+)/)?.[1] ?? 0);
    const count = (calls.get(index) ?? 0) + 1;
    calls.set(index, count);
    prompts.push([index, init.body.get("prompt")]);
    if (index === 1 && count === 1) {
      return Response.json({ text: "uncertain boundary", segments: [{ text: "uncertain boundary", start: 0.2, end: 0.8, avg_logprob: -1.2 }] });
    }
    const text = index === 1 ? "correct boundary" : `stable ${index}`;
    return Response.json({ text, segments: [{ text, start: 0.2, end: 0.8, avg_logprob: -0.1 }] });
  };
  const pipeline = new DictationPipeline({ apiKey: "test", fetch, retry: { maxAttempts: 1 } });
  const job = pipeline.createJob(wavAudio, {
    targetChunkMs: 1_000,
    overlapMs: 200,
    accuracyMode: "retry-ambiguous",
  });
  const result = await job.result();
  const manifest = await job.inspect();
  assert.equal(calls.get(0), 1);
  assert.equal(calls.get(1), 2);
  assert.equal(calls.get(2), 1);
  assert.ok(prompts.some(([index, prompt]) => index === 1 && prompt?.includes("stable 0")));
  assert.equal(manifest.chunks[1].alternatives.length, 2);
  assert.ok(result.rawTranscript.includes("correct boundary"));
});

test("cleanup guard preserves numbers and digit-bearing identifiers", async () => {
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => Response.json({ choices: [{ message: { content: "Deploy release to server." } }] }),
  });
  const source = "Deploy release 2.4.1 to server node-17.";
  const result = await pipeline.cleanup(source, { mode: "verbatim" });
  assert.equal(result.text, source);
  assert.equal(result.rejected, true);
});

test("cleanup guard preserves named entities and caller-stable segments with visible diffs", async () => {
  const outputs = ["Meet Alice at OpenAI tomorrow.", "The launch code changes now."];
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => Response.json({ choices: [{ message: { content: outputs.shift() } }] }),
  });
  const entity = await pipeline.cleanup("Meet Alice Johnson at OpenAI tomorrow.", {
    mode: "dictation",
    maxDeletionRatio: 1,
  });
  assert.equal(entity.rejected, true);
  assert.ok(entity.guard.reasons.includes("named-entities-changed"));
  assert.ok(entity.guard.diff.removed.includes("Johnson"));

  const stable = await pipeline.cleanup("The launch code is blue sky now.", {
    mode: "dictation",
    maxDeletionRatio: 1,
    preserveNamedEntities: false,
    stableSegments: [{ id: "launch-code", text: "blue sky" }],
  });
  assert.equal(stable.rejected, true);
  assert.deepEqual(stable.guard.changedStableSegmentIds, ["launch-code"]);
  assert.ok(stable.guard.reasons.includes("stable-segments-changed"));
});

test("named-entity guard allows cleanup to add normal capitalization", async () => {
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => Response.json({ choices: [{ message: { content: "Please email Alice tomorrow." } }] }),
  });
  const result = await pipeline.cleanup("please email alice tomorrow", { mode: "dictation" });
  assert.equal(result.rejected, false);
  assert.equal(result.text, "Please email Alice tomorrow.");
});

test("long-job events persist cursors and replay strictly after a supplied cursor", async () => {
  const store = new MemoryJobStore();
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => Response.json({ text: "durable event", segments: [] }),
  });
  const first = pipeline.createJob(wavAudio, {
    jobId: "durable-events",
    store,
    targetChunkMs: 10_000,
    cleanup: { mode: "none" },
  });
  await first.result();
  const manifest = await store.load("durable-events");
  assert.ok(manifest.events.length > 0);
  assert.equal(manifest.eventCursor, manifest.events.at(-1).cursor);
  assert.ok(manifest.events.every((event, index) => event.cursor === index + 1 && event.at));

  const cutoff = manifest.events.find((event) => event.type === "chunk.completed").cursor;
  const resumed = pipeline.resumeJob("durable-events", wavAudio, {
    store,
    targetChunkMs: 10_000,
    cleanup: { mode: "none" },
  });
  const replay = collect(resumed.events(cutoff));
  await resumed.result();
  const replayed = await replay;
  assert.ok(replayed.length > 0);
  assert.ok(replayed.every((event) => event.cursor > cutoff));
  assert.equal(replayed.at(-1).type, "job.completed");
});

test("provider quota headers are surfaced and dynamically pace later queued chunks", async () => {
  const starts = [];
  const events = [];
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => {
      starts.push(performance.now());
      return Response.json({ text: `part ${starts.length}`, segments: [] }, {
        headers: {
          "x-ratelimit-limit-requests": "100",
          "x-ratelimit-remaining-requests": "2",
          "x-ratelimit-reset-requests": "0.04s",
        },
      });
    },
  });
  const job = pipeline.createJob(wavAudio, {
    targetChunkMs: 1_000,
    overlapMs: 200,
    concurrency: 1,
    accuracyMode: "independent",
    cleanup: { mode: "none" },
  });
  const collecting = collect(job.events());
  await job.result();
  events.push(...await collecting);
  assert.ok(starts[1] - starts[0] >= 15);
  assert.ok(events.some((event) => event.type === "rate-limit.observed" && event.remainingRequests === 2));
});

test("optional account pacing spaces provider request starts", async () => {
  const starts = [];
  const pipeline = new DictationPipeline({
    apiKey: "test",
    retry: { maxAttempts: 1 },
    fetch: async () => {
      starts.push(performance.now());
      return Response.json({ text: `part ${starts.length}`, segments: [] });
    },
  });
  await pipeline.dictateLong(wavAudio, {
    targetChunkMs: 1_000,
    overlapMs: 200,
    concurrency: 3,
    requestsPerMinute: 6_000,
    accuracyMode: "independent",
  });
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 7);
  assert.ok(starts[2] - starts[1] >= 7);
});

test("automatic routing keeps short audio direct and sends oversized audio to chunks", async () => {
  const direct = await routeAudio({ data: new Blob(["small"], { type: "audio/webm" }), filename: "small.webm" });
  const chunked = await routeAudio({ data: new Blob([new Uint8Array(21 * 1024 * 1024)]), filename: "large.wav" });
  const stored = await routeAudio(
    { data: new Blob([new Uint8Array(21 * 1024 * 1024)]), filename: "large.flac" },
    { storageAvailable: true, accountTier: "free", allowManualRoutes: true },
  );
  const longButCompact = await routeAudio({
    data: new Blob(["compact"], { type: "audio/flac" }),
    filename: "ten-minutes.flac",
    durationMs: 10 * 60_000,
  });
  assert.equal(direct.kind, "direct");
  assert.equal(chunked.kind, "chunked");
  assert.equal(stored.kind, "stored-url");
  assert.equal(longButCompact.kind, "chunked");

  let calls = 0;
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async (url) => {
      calls += 1;
      if (String(url).endsWith("/audio/transcriptions")) return Response.json({ text: "short", segments: [] });
      return Response.json({ choices: [{ message: { content: "Short." } }] });
    },
  });
  const result = await pipeline.dictateAuto({ data: new Blob(["small"], { type: "audio/webm" }), filename: "small.webm" });
  assert.equal(result.text, "Short.");
  assert.equal(calls, 2);
});

test("aborting a long job cancels provider work and persists aborted status", async () => {
  const pipeline = new DictationPipeline({
    apiKey: "test",
    retry: { maxAttempts: 1 },
    fetch: async (_url, init) => new Promise((resolve, reject) => {
      if (init.signal.aborted) {
        reject(init.signal.reason);
        return;
      }
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  });
  const job = pipeline.createJob(wavAudio, { targetChunkMs: 1_000, overlapMs: 200 });
  const collecting = collect(job.events());
  const pending = job.result();
  setTimeout(() => job.abort(), 5);
  await assert.rejects(pending, (error) => error instanceof DictationError && error.code === "JOB_ABORTED");
  assert.equal((await job.inspect()).status, "aborted");
  const events = await collecting;
  assert.equal(events.at(-1).type, "job.canceled");
});

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function makeToneWav(durationMs, silentRanges) {
  const sampleRate = 16_000;
  const samples = Math.round((durationMs / 1_000) * sampleRate);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  writeAscii(bytes, 8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index += 1) {
    const ms = (index / sampleRate) * 1_000;
    const silent = silentRanges.some(([start, end]) => ms >= start && ms <= end);
    const sample = silent ? 0 : Math.round(Math.sin(index / 8) * 8_000);
    view.setInt16(44 + index * 2, sample, true);
  }
  return { data: new Blob([bytes], { type: "audio/wav" }), filename: "vad.wav", durationMs };
}

function writeAscii(bytes, offset, value) {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
}

function createWavWithPayload(payload) {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  writeAscii(header, 0, "RIFF");
  view.setUint32(4, 36 + payload.length, true);
  writeAscii(header, 8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(header, 36, "data");
  view.setUint32(40, payload.length, true);
  const output = new Uint8Array(header.length + payload.length);
  output.set(header);
  output.set(payload, header.length);
  return output;
}
