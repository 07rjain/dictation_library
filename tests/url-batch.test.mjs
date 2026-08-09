import assert from "node:assert/strict";
import test from "node:test";
import { DictationError, DictationPipeline, GroqBatchClient } from "../dist/index.js";

test("transcribes HTTPS URLs without attaching an audio file", async () => {
  let form;
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async (_url, init) => {
      form = init.body;
      return Response.json({ text: "URL transcript", segments: [] });
    },
  });
  const result = await pipeline.transcribeUrl("https://storage.example/audio.flac");
  assert.equal(result.text, "URL transcript");
  assert.equal(form.get("url"), "https://storage.example/audio.flac");
  assert.equal(form.get("file"), null);
});

test("uploads through an ObjectStorage adapter and removes the temporary object", async () => {
  const operations = [];
  const storage = {
    async put(key, audio) {
      operations.push(["put", key]);
      return { key, sizeBytes: audio.data.size, contentType: audio.data.type };
    },
    async createSignedUrl(key, expires) {
      operations.push(["sign", key, expires]);
      return `https://storage.example/${key}?signed=1`;
    },
    async delete(key) {
      operations.push(["delete", key]);
    },
  };
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => Response.json({ text: "Stored transcript", segments: [] }),
  });
  const result = await pipeline.transcribeStored(
    { data: new Blob(["audio"], { type: "audio/flac" }), filename: "private.flac" },
    storage,
    { key: "jobs/a/private.flac", signedUrlExpiresInSeconds: 60 },
  );
  assert.equal(result.storageKey, "jobs/a/private.flac");
  assert.deepEqual(operations, [
    ["put", "jobs/a/private.flac"],
    ["sign", "jobs/a/private.flac", 60],
    ["delete", "jobs/a/private.flac"],
  ]);
});

test("submits audio Batch JSONL with URL-only transcription requests", async () => {
  let jsonl;
  let batchBody;
  const fetch = async (url, init) => {
    if (String(url).endsWith("/files") && init.method === "POST") {
      jsonl = await init.body.get("file").text();
      return Response.json({ id: "file_input" });
    }
    if (String(url).endsWith("/batches")) {
      batchBody = JSON.parse(init.body);
      return Response.json({ id: "batch_1", status: "validating", input_file_id: "file_input" });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const client = new GroqBatchClient({ apiKey: "test", fetch });
  const batch = await client.submitAudio([
    { id: "chunk-0", url: "https://storage.example/chunk-0.flac", language: "en" },
  ]);
  const line = JSON.parse(jsonl.trim());
  assert.equal(batch.id, "batch_1");
  assert.equal(line.url, "/v1/audio/transcriptions");
  assert.equal(line.body.url, "https://storage.example/chunk-0.flac");
  assert.equal(line.body.model, "whisper-large-v3-turbo");
  assert.equal(batchBody.endpoint, "/v1/audio/transcriptions");
  assert.equal(batchBody.completion_window, "24h");
});

test("refuses Batch when strict zero-data-retention mode is enabled", async () => {
  const client = new GroqBatchClient({
    apiKey: "test",
    zeroDataRetention: true,
    fetch: async () => { throw new Error("must not call provider"); },
  });
  await assert.rejects(
    client.submitAudio([{ id: "one", url: "https://storage.example/one.flac" }]),
    (error) => error instanceof DictationError && error.code === "BATCH_DISABLED_FOR_ZDR",
  );
});
