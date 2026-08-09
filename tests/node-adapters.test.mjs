import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FfmpegAudioProcessor, FileJobStore } from "../dist/node.js";
import { DictationPipeline } from "../dist/index.js";

const wavBytes = await readFile(new URL("../test.wav", import.meta.url));
const wavAudio = { data: new Blob([wavBytes], { type: "audio/wav" }), filename: "test.wav" };

test("FileJobStore persists manifests across instances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dictation-store-test-"));
  try {
    const manifest = {
      version: 1,
      jobId: "job_safe_1",
      status: "partial",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      mode: "interactive",
      source: { sizeBytes: 12, mimeType: "audio/wav", filename: "test.wav" },
      processor: "test",
      targetChunkMs: 60_000,
      overlapMs: 2_000,
      concurrency: 2,
      chunks: [],
    };
    await new FileJobStore(directory).save(manifest);
    assert.deepEqual(await new FileJobStore(directory).load(manifest.jobId), manifest);
    await new FileJobStore(directory).delete(manifest.jobId);
    assert.equal(await new FileJobStore(directory).load(manifest.jobId), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FfmpegAudioProcessor normalizes to compact 16 kHz mono FLAC chunks", async (t) => {
  const processor = new FfmpegAudioProcessor({ output: "flac" });
  let chunks;
  try {
    chunks = await processor.segment(wavAudio, { targetChunkMs: 1_000, overlapMs: 200 });
  } catch (error) {
    if (error?.code === "AUDIO_PROCESSING_FAILED" && /not installed/.test(error.message)) {
      t.skip("FFmpeg is not installed");
      return;
    }
    throw error;
  }
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.audio.data.type === "audio/flac"));
  assert.ok(chunks.every((chunk) => chunk.audio.data.size < wavAudio.data.size));
});

test("a new pipeline instance resumes a durable partial job without replaying completed chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dictation-resume-test-"));
  const store = new FileJobStore(directory);
  const calls = new Map();
  let recover = false;
  const fetch = async (_url, init) => {
    const index = Number(init.body.get("file").name.match(/(\d+)/)?.[1] ?? 0);
    calls.set(index, (calls.get(index) ?? 0) + 1);
    if (index === 1 && !recover) return new Response("temporary", { status: 500 });
    return Response.json({ text: `chunk ${index}`, segments: [] });
  };
  try {
    const firstPipeline = new DictationPipeline({ apiKey: "test", fetch, retry: { maxAttempts: 1 } });
    const first = firstPipeline.createJob(wavAudio, {
      jobId: "durable_restart",
      store,
      targetChunkMs: 1_000,
      overlapMs: 200,
    });
    await assert.rejects(first.result());

    recover = true;
    const secondPipeline = new DictationPipeline({ apiKey: "test", fetch, retry: { maxAttempts: 1 } });
    const resumed = secondPipeline.resumeJob("durable_restart", wavAudio, {
      store,
      targetChunkMs: 1_000,
      overlapMs: 200,
    });
    await resumed.result();
    assert.deepEqual([...calls.entries()].sort(), [[0, 1], [1, 2], [2, 1]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
