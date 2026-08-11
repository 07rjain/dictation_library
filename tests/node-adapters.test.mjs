import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    assert.equal((await stat(join(directory, `${manifest.jobId}.json`))).mode & 0o777, 0o600);
    await assert.rejects(new FileJobStore(directory).load("../escape"), /Invalid job identifier/);
    await new FileJobStore(directory).delete(manifest.jobId);
    assert.equal(await new FileJobStore(directory).load(manifest.jobId), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FileJobStore provides expiring cross-instance worker leases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dictation-lease-test-"));
  try {
    const first = new FileJobStore(directory);
    const second = new FileJobStore(directory);
    assert.equal(await first.acquireLease("leased_job", "worker-a", 50), true);
    assert.equal(await second.acquireLease("leased_job", "worker-b", 50), false);
    assert.equal(await first.renewLease("leased_job", "worker-a", 100), true);
    await first.releaseLease("leased_job", "worker-a");
    assert.equal(await second.acquireLease("leased_job", "worker-b", 50), true);
    await second.releaseLease("leased_job", "worker-b");

    const contenders = Array.from({ length: 8 }, (_, index) =>
      new FileJobStore(directory).acquireLease("contended_job", `worker-${index}`, 1_000)
    );
    const outcomes = await Promise.all(contenders);
    assert.equal(outcomes.filter(Boolean).length, 1);
    const winner = outcomes.findIndex(Boolean);
    await new FileJobStore(directory).releaseLease("contended_job", `worker-${winner}`);

    assert.equal(await first.acquireLease("expired_job", "worker-old", 5), true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await second.acquireLease("expired_job", "worker-new", 50), true);
    await second.releaseLease("expired_job", "worker-new");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FileJobStore stale-guard recovery cannot grant the same lease twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dictation-stale-guard-test-"));
  try {
    for (let round = 0; round < 30; round += 1) {
      const jobId = `stale_${round}`;
      await writeFile(join(directory, `${jobId}.lease.guard`), JSON.stringify({
        token: `crashed-${round}`,
        expiresAt: Date.now() - 1,
      }));
      const outcomes = await Promise.all(Array.from({ length: 16 }, (_, index) =>
        new FileJobStore(directory).acquireLease(jobId, `worker-${index}`, 1_000)
      ));
      assert.equal(outcomes.filter(Boolean).length, 1, `round ${round} had multiple owners`);
      const winner = outcomes.findIndex(Boolean);
      await new FileJobStore(directory).releaseLease(jobId, `worker-${winner}`);
    }
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

test("FfmpegAudioProcessor streams input instead of calling whole-Blob arrayBuffer", async (t) => {
  class StreamOnlyBlob extends Blob {
    async arrayBuffer() { throw new Error("whole blob buffering is forbidden"); }
  }
  const processor = new FfmpegAudioProcessor({ output: "flac" });
  const streamOnly = {
    data: new StreamOnlyBlob([wavBytes], { type: "audio/wav" }),
    filename: "stream-only.wav",
    durationMs: 2_450,
  };
  try {
    const chunks = await processor.segment(streamOnly, { targetChunkMs: 10_000, overlapMs: 0 });
    assert.equal(chunks.length, 1);
  } catch (error) {
    if (error?.code === "AUDIO_PROCESSING_FAILED" && /not installed/.test(error.message)) {
      t.skip("FFmpeg is not installed");
      return;
    }
    throw error;
  }
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
