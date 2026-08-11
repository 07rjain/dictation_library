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
  assert.equal(result.deleted, true);
  assert.deepEqual(operations, [
    ["put", "jobs/a/private.flac"],
    ["sign", "jobs/a/private.flac", 60],
    ["delete", "jobs/a/private.flac"],
  ]);
});

test("stored transcription reports resumable upload progress and deletion lifecycle", async () => {
  const events = [];
  let deletion;
  const storage = {
    async put(key, audio, options) {
      assert.equal(options.resumeToken, "resume-1");
      options.onProgress({ loadedBytes: audio.data.size, totalBytes: audio.data.size, resumedBytes: 2 });
      return {
        key,
        sizeBytes: audio.data.size,
        contentType: audio.data.type,
        checksum: "sha256:abc",
        resumeToken: "resume-2",
        resumedBytes: 2,
        version: "v2",
      };
    },
    async createSignedUrl() { return "https://storage.example/resumable.wav"; },
    async delete(key, options) { deletion = { key, options }; },
  };
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => Response.json({ text: "stored", segments: [] }),
  });
  const result = await pipeline.transcribeStored(
    { data: new Blob(["audio"], { type: "audio/wav" }), filename: "audio.wav" },
    storage,
    { uploadResumeToken: "resume-1", onStorageEvent: (event) => events.push(event) },
  );
  assert.equal(result.storageChecksum, "sha256:abc");
  assert.equal(result.uploadResumeToken, "resume-2");
  assert.deepEqual(deletion, { key: result.storageKey, options: { version: "v2" } });
  assert.deepEqual(events.map((event) => event.type), [
    "storage.upload.started",
    "storage.upload.progress",
    "storage.upload.completed",
    "storage.transcription.started",
    "storage.transcription.completed",
    "storage.deletion.started",
    "storage.deletion.completed",
  ]);
  assert.equal(events.at(-1).version, "v2");
});

test("object-storage deletion failures are auditable without hiding provider outcome state", async () => {
  const storage = {
    async put() {
      return { key: "temporary/failure.wav", sizeBytes: 5, contentType: "audio/wav", version: "v1" };
    },
    async createSignedUrl() { return "https://storage.example/failure.wav"; },
    async delete() { throw new Error("retention policy denied deletion"); },
  };
  const pipeline = new DictationPipeline({
    apiKey: "test",
    fetch: async () => Response.json({ text: "transcribed", segments: [] }),
  });
  await assert.rejects(
    pipeline.transcribeStored({ data: new Blob(["audio"]), filename: "failure.wav" }, storage),
    (error) => error instanceof DictationError && error.code === "STORAGE_DELETE_FAILED" &&
      error.details.storageVersion === "v1" && error.details.providerRequestFailed === false &&
      error.details.transcriptionResult.text === "transcribed",
  );
});

test("storage cleanup errors preserve the original provider failure", async () => {
  const storage = {
    async put() { return { key: "temporary/double-failure.wav", sizeBytes: 5, contentType: "audio/wav" }; },
    async createSignedUrl() { return "https://storage.example/double-failure.wav"; },
    async delete() { throw new Error("delete failed"); },
  };
  const pipeline = new DictationPipeline({
    apiKey: "test",
    retry: { maxAttempts: 1 },
    fetch: async () => new Response("provider failed", { status: 503 }),
  });
  await assert.rejects(
    pipeline.transcribeStored({ data: new Blob(["audio"]), filename: "double-failure.wav" }, storage),
    (error) => error instanceof DictationError && error.code === "STORAGE_DELETE_FAILED" &&
      error.details.providerRequestFailed === true &&
      error.details.providerError.code === "GROQ_REQUEST_FAILED" &&
      error.details.providerError.status === 503,
  );
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
  ], { experimental: true });
  const line = JSON.parse(jsonl.trim());
  assert.equal(batch.id, "batch_1");
  assert.equal(line.url, "/v1/audio/transcriptions");
  assert.equal(line.body.url, "https://storage.example/chunk-0.flac");
  assert.equal(line.body.model, "whisper-large-v3-turbo");
  assert.equal(batchBody.endpoint, "/v1/audio/transcriptions");
  assert.equal(batchBody.completion_window, "24h");
});

test("Batch remains feature-gated without explicit experimental acknowledgement", async () => {
  const client = new GroqBatchClient({
    apiKey: "test",
    fetch: async () => { throw new Error("must not contact provider"); },
  });
  await assert.rejects(
    client.submitAudio([{ id: "one", url: "https://storage.example/one.flac" }]),
    (error) => error instanceof DictationError && error.code === "BATCH_EXPERIMENTAL_DISABLED",
  );
});

test("identifies and resubmits failed or missing Batch custom_ids", async () => {
  let uploadedJsonl = "";
  const client = new GroqBatchClient({
    apiKey: "test",
    fetch: async (url, init) => {
      if (String(url).endsWith("/files")) {
        uploadedJsonl = await init.body.get("file").text();
        return Response.json({ id: "retry_input" });
      }
      if (String(url).endsWith("/batches")) {
        return Response.json({ id: "retry_batch", status: "validating", input_file_id: "retry_input" });
      }
      throw new Error(`Unexpected request ${url}`);
    },
  });
  const original = [
    { id: "ok", url: "https://storage.example/ok.flac" },
    { id: "retry", url: "https://storage.example/retry.flac" },
    { id: "missing", url: "https://storage.example/missing.flac" },
  ];
  const lines = [
    { custom_id: "ok", response: { status_code: 200 } },
    { custom_id: "retry", error: { message: "expired URL" } },
  ];
  assert.deepEqual(client.failedRequestIds(lines), ["retry"]);
  const batch = await client.resubmitFailed(original, lines, { experimental: true });
  assert.equal(batch.id, "retry_batch");
  const retried = uploadedJsonl.trim().split("\n").map(JSON.parse);
  assert.deepEqual(retried.map((line) => line.custom_id), ["retry", "missing"]);
});

test("recovers an expired Batch by resubmitting every unresolved custom_id", async () => {
  let uploadedJsonl = "";
  const client = new GroqBatchClient({
    apiKey: "test",
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/openai/v1/files/output/content") {
        return new Response(`${JSON.stringify({ custom_id: "ok", response: { status_code: 200 } })}\n`);
      }
      if (path === "/openai/v1/files") {
        uploadedJsonl = await init.body.get("file").text();
        return Response.json({ id: "recovery_input" });
      }
      if (path === "/openai/v1/batches") {
        return Response.json({ id: "recovery_batch", status: "validating", input_file_id: "recovery_input" });
      }
      throw new Error(`Unexpected request ${url}`);
    },
  });
  const original = [
    { id: "ok", url: "https://storage.example/ok.flac" },
    { id: "missing", url: "https://storage.example/missing.flac" },
  ];
  const recovery = await client.recoverIncomplete({
    id: "expired", status: "expired", input_file_id: "input", output_file_id: "output",
  }, original, { experimental: true });
  assert.equal(recovery.id, "recovery_batch");
  assert.deepEqual(uploadedJsonl.trim().split("\n").map(JSON.parse).map((line) => line.custom_id), ["missing"]);
});

test("runAudio preserves operation and artifact-cleanup failures together", async () => {
  const client = new GroqBatchClient({
    apiKey: "test",
    retry: { maxAttempts: 1 },
    fetch: async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/openai/v1/files" && init.method === "POST") return Response.json({ id: "input" });
      if (path === "/openai/v1/batches" && init.method === "POST") {
        return Response.json({ id: "batch", status: "validating", input_file_id: "input" });
      }
      if (path === "/openai/v1/batches/batch") {
        return Response.json({ id: "batch", status: "expired", input_file_id: "input" });
      }
      if (path === "/openai/v1/files/input" && init.method === "DELETE") {
        return new Response("retained", { status: 500 });
      }
      throw new Error(`Unexpected request ${url}`);
    },
  });
  await assert.rejects(client.runAudio([
    { id: "one", url: "https://storage.example/one.flac" },
  ], { experimental: true, pollIntervalMs: 1, timeoutMs: 100 }), (error) =>
    error instanceof DictationError && error.code === "BATCH_RUN_CLEANUP_FAILED" &&
    error.details.operationError.code === "BATCH_NOT_COMPLETE" &&
    error.details.cleanupError.code === "BATCH_ARTIFACT_DELETE_FAILED"
  );
});

test("refuses Batch when strict zero-data-retention mode is enabled", async () => {
  const client = new GroqBatchClient({
    apiKey: "test",
    zeroDataRetention: true,
    fetch: async () => { throw new Error("must not call provider"); },
  });
  await assert.rejects(
    client.submitAudio([{ id: "one", url: "https://storage.example/one.flac" }], { experimental: true }),
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
      return new Response(`${JSON.stringify({ custom_id: "part-0", response: { status_code: 200 } })}\n`);
    }
    if (path === "/openai/v1/files/error_1/content") {
      return new Response(`${JSON.stringify({ custom_id: "part-1", error: { message: "failed" } })}\n`);
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
    client.submitAudio([{ id: "one", url: "https://storage.example/one.flac" }], { experimental: true }),
    (error) => error instanceof DictationError && error.code === "GROQ_BATCH_REQUEST_FAILED",
  );
  assert.equal(deleted, true);
});

test("retries safe Batch reads but never replays a failed submission POST", async () => {
  let getCalls = 0;
  const safeClient = new GroqBatchClient({
    apiKey: "test",
    retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    fetch: async () => {
      getCalls += 1;
      return getCalls === 1
        ? new Response("temporary", { status: 503 })
        : Response.json({ id: "batch_safe", status: "completed", input_file_id: "input" });
    },
  });
  assert.equal((await safeClient.get("batch_safe")).status, "completed");
  assert.equal(getCalls, 2);

  let createCalls = 0;
  const submitClient = new GroqBatchClient({
    apiKey: "test",
    retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    fetch: async (url, init) => {
      if (String(url).endsWith("/files") && init.method === "POST") {
        return Response.json({ id: "input_once" });
      }
      if (String(url).endsWith("/batches") && init.method === "POST") {
        createCalls += 1;
        return new Response("unknown submit outcome", { status: 503 });
      }
      if (String(url).endsWith("/files/input_once") && init.method === "DELETE") {
        return Response.json({ deleted: true });
      }
      throw new Error(`Unexpected request ${url}`);
    },
  });
  await assert.rejects(
    submitClient.submitAudio([{ id: "one", url: "https://storage.example/one.flac" }], { experimental: true }),
    (error) => error instanceof DictationError && error.code === "GROQ_BATCH_REQUEST_FAILED",
  );
  assert.equal(createCalls, 1);
});

test("Batch requests and lifecycle polling have typed timeouts", async () => {
  const requestClient = new GroqBatchClient({
    apiKey: "test",
    timeoutMs: 2,
    retry: { maxAttempts: 1 },
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  });
  await assert.rejects(
    requestClient.get("stuck"),
    (error) => error instanceof DictationError && error.code === "BATCH_REQUEST_TIMEOUT",
  );

  const pollingClient = new GroqBatchClient({
    apiKey: "test",
    timeoutMs: 1_000,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  });
  const waitStartedAt = performance.now();
  await assert.rejects(
    pollingClient.wait("pending", { pollIntervalMs: 10, timeoutMs: 5 }),
    (error) => error instanceof DictationError && error.code === "BATCH_WAIT_TIMEOUT",
  );
  assert.ok(performance.now() - waitStartedAt < 250, "overall wait deadline should abort the in-flight poll");

  let completedPolls = 0;
  const sleepingClient = new GroqBatchClient({
    apiKey: "test",
    fetch: async () => {
      completedPolls += 1;
      return Response.json({ id: "pending", status: "in_progress", input_file_id: "input" });
    },
  });
  const sleepStartedAt = performance.now();
  await assert.rejects(
    sleepingClient.wait("pending", { pollIntervalMs: 1_000, timeoutMs: 5 }),
    (error) => error instanceof DictationError && error.code === "BATCH_WAIT_TIMEOUT",
  );
  assert.equal(completedPolls, 1);
  assert.ok(performance.now() - sleepStartedAt < 250, "overall wait deadline should abort polling sleep");

  await assert.rejects(
    sleepingClient.wait("pending", { timeoutMs: -1 }),
    (error) => error instanceof DictationError && error.code === "INVALID_BATCH_WAIT_TIMEOUT",
  );
});

test("reports Batch artifact deletion failures with the affected file IDs", async () => {
  const client = new GroqBatchClient({
    apiKey: "test",
    retry: { maxAttempts: 1 },
    fetch: async (url) => String(url).includes("output_bad")
      ? new Response("cannot delete", { status: 503 })
      : Response.json({ deleted: true }),
  });
  await assert.rejects(
    client.deleteArtifacts({
      id: "batch",
      status: "completed",
      input_file_id: "input_ok",
      output_file_id: "output_bad",
    }),
    (error) => error instanceof DictationError &&
      error.code === "BATCH_ARTIFACT_DELETE_FAILED" &&
      error.details.failedFileIds[0] === "output_bad",
  );
});

test("validates Batch inputs and incomplete results locally", async () => {
  let calls = 0;
  const client = new GroqBatchClient({
    apiKey: "test",
    fetch: async () => { calls += 1; return Response.json({}); },
  });
  await assert.rejects(client.submitAudio([], { experimental: true }), (error) => error.code === "EMPTY_BATCH");
  await assert.rejects(
    client.submitAudio([
      { id: "duplicate", url: "https://storage.example/a.flac" },
      { id: "duplicate", url: "https://storage.example/b.flac" },
    ], { experimental: true }),
    (error) => error.code === "INVALID_BATCH_ID",
  );
  await assert.rejects(
    client.submitAudio([{ id: "insecure", url: "http://storage.example/a.flac" }], { experimental: true }),
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
