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

test("removes temporary storage after provider failure and supports explicit retention", async () => {
  const deleted = [];
  const storage = {
    async put(key, audio) { return { key, sizeBytes: audio.data.size }; },
    async createSignedUrl(key) { return `https://storage.example/${key}`; },
    async delete(key) { deleted.push(key); },
  };
  const failing = new DictationPipeline({
    apiKey: "test",
    retry: { maxAttempts: 1 },
    fetch: async () => new Response("provider failure", { status: 500 }),
  });
  await assert.rejects(
    failing.transcribeStored(
      { data: new Blob(["audio"]), filename: "failure.flac" },
      storage,
      { key: "temporary/failure.flac" },
    ),
    (error) => error instanceof DictationError && error.code === "GROQ_REQUEST_FAILED",
  );
  assert.deepEqual(deleted, ["temporary/failure.flac"]);

  const retained = new DictationPipeline({
    apiKey: "test",
    fetch: async () => Response.json({ text: "retained", segments: [] }),
  });
  await retained.transcribeStored(
    { data: new Blob(["audio"]), filename: "retained.flac" },
    storage,
    { key: "retained/audio.flac", deleteAfter: false },
  );
  assert.deepEqual(deleted, ["temporary/failure.flac"]);
});

test("rejects non-HTTPS transcription URLs before contacting Groq", async () => {
  let calls = 0;
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => { calls += 1; return Response.json({ text: "unexpected" }); },
  });
  await assert.rejects(
    pipeline.transcribeUrl("http://storage.example/audio.wav"),
    (error) => error instanceof DictationError && error.code === "INSECURE_AUDIO_URL",
  );
  assert.equal(calls, 0);
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

test("polls, reads results, cancels, and deletes all Batch artifacts", async () => {
  let polls = 0;
  const deleted = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === "/openai/v1/batches/batch_1" && !init.method) {
      polls += 1;
      return Response.json(polls === 1
        ? { id: "batch_1", status: "in_progress", input_file_id: "input_1" }
        : {
            id: "batch_1", status: "completed", input_file_id: "input_1",
            output_file_id: "output_1", error_file_id: "error_1",
          });
    }
    if (path === "/openai/v1/files/output_1/content") {
      return new Response([
        JSON.stringify({ custom_id: "part-0", response: { status_code: 200 } }),
        JSON.stringify({ custom_id: "part-1", error: { message: "failed" } }),
        "",
      ].join("\n"));
    }
    if (path === "/openai/v1/batches/batch_1/cancel" && init.method === "POST") {
      return Response.json({ id: "batch_1", status: "cancelling", input_file_id: "input_1" });
    }
    if (path.startsWith("/openai/v1/files/") && init.method === "DELETE") {
      deleted.push(path.split("/").at(-1));
      return Response.json({ deleted: true });
    }
    throw new Error(`Unexpected request ${path}`);
  };
  const client = new GroqBatchClient({ apiKey: "test", fetch });
  const batch = await client.wait("batch_1", { pollIntervalMs: 0 });
  const lines = await client.results(batch);
  const cancelled = await client.cancel("batch_1");
  await client.deleteArtifacts(batch);

  assert.equal(polls, 2);
  assert.deepEqual(lines.map((line) => line.custom_id), ["part-0", "part-1"]);
  assert.equal(cancelled.status, "cancelling");
  assert.deepEqual(deleted.sort(), ["error_1", "input_1", "output_1"]);
});

test("cleans up an uploaded Batch input file when job creation fails", async () => {
  let deleted = false;
  const fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/files") && init.method === "POST") return Response.json({ id: "orphan_input" });
    if (path.endsWith("/batches")) return new Response("unavailable", { status: 503 });
    if (path.endsWith("/files/orphan_input") && init.method === "DELETE") {
      deleted = true;
      return Response.json({ deleted: true });
    }
    throw new Error(`Unexpected request ${path}`);
  };
  const client = new GroqBatchClient({ apiKey: "test", fetch });
  await assert.rejects(
    client.submitAudio([{ id: "one", url: "https://storage.example/one.flac" }]),
    (error) => error instanceof DictationError && error.code === "GROQ_BATCH_REQUEST_FAILED",
  );
  assert.equal(deleted, true);
});

test("validates Batch inputs and incomplete results locally", async () => {
  let calls = 0;
  const client = new GroqBatchClient({
    apiKey: "test",
    fetch: async () => { calls += 1; return Response.json({}); },
  });
  await assert.rejects(client.submitAudio([]), (error) => error.code === "EMPTY_BATCH");
  await assert.rejects(
    client.submitAudio([
      { id: "duplicate", url: "https://storage.example/a.flac" },
      { id: "duplicate", url: "https://storage.example/b.flac" },
    ]),
    (error) => error.code === "INVALID_BATCH_ID",
  );
  await assert.rejects(
    client.submitAudio([{ id: "insecure", url: "http://storage.example/a.flac" }]),
    (error) => error.code === "INVALID_AUDIO_URL",
  );
  await assert.rejects(
    client.results({ id: "pending", status: "in_progress", input_file_id: "input" }),
    (error) => error.code === "BATCH_NOT_COMPLETE",
  );
  assert.equal(calls, 0);
});

test("standalone Batch client rejects an empty API key", () => {
  assert.throws(
    () => new GroqBatchClient({ apiKey: " " }),
    (error) => error instanceof DictationError && error.code === "MISSING_API_KEY",
  );
});
