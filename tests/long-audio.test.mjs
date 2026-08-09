import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DictationError,
  DictationPipeline,
  VadWavAudioProcessor,
  WavAudioProcessor,
  inspectAudio,
  routeAudio,
  stitchChunks,
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

test("stitching deduplicates only when chunks have temporal overlap", () => {
  const chunks = [
    { index: 0, startMs: 0, endMs: 1_000, overlapBeforeMs: 0, text: "yes yes", segments: [], model: "test", durationMs: 1 },
    { index: 1, startMs: 1_000, endMs: 2_000, overlapBeforeMs: 0, text: "yes again", segments: [], model: "test", durationMs: 1 },
  ];
  assert.equal(stitchChunks(chunks), "yes yes yes again");
});

test("stitching uses fuzzy reconciliation only inside a temporal overlap", () => {
  const chunks = [
    { index: 0, startMs: 0, endMs: 60_000, overlapBeforeMs: 0, text: "we deployed the colour service", segments: [], model: "test", durationMs: 1 },
    { index: 1, startMs: 58_000, endMs: 118_000, overlapBeforeMs: 2_000, text: "the color service successfully today", segments: [], model: "test", durationMs: 1 },
  ];
  assert.equal(stitchChunks(chunks), "we deployed the colour service successfully today");
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
    { storageAvailable: true, accountTier: "free" },
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
  const pending = job.result();
  setTimeout(() => job.abort(), 5);
  await assert.rejects(pending, (error) => error instanceof DictationError && error.code === "JOB_ABORTED");
  assert.equal((await job.inspect()).status, "aborted");
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
