import assert from "node:assert/strict";
import test from "node:test";
import { DictationPipeline, GroqClient } from "../dist/index.js";

const audio = { data: new Blob(["fake audio"], { type: "audio/webm" }), filename: "test.webm" };

test("runs transcription and cleanup and reports timings", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/audio/transcriptions")) {
      return Response.json({ text: "hello um there", segments: [{ no_speech_prob: 0.01 }] });
    }
    return Response.json({ choices: [{ message: { content: "Hello there." } }] });
  };
  const pipeline = new DictationPipeline({ apiKey: "test", fetch });
  const session = pipeline.startSession(async () => ({ appName: "Test", fieldType: "chat" }));
  const result = await session.finish(audio);

  assert.equal(result.rawTranscript, "hello um there");
  assert.equal(result.text, "Hello there.");
  assert.equal(result.transcriptionModel, "whisper-large-v3-turbo");
  assert.equal(result.cleanupModel, "openai/gpt-oss-20b");
  assert.equal(calls.length, 2);
  assert.ok(result.timings.totalMs >= 0);
});

test("filters conservative Whisper silence hallucinations", async () => {
  const fetch = async () => Response.json({
    text: "Thank you.",
    segments: [{ no_speech_prob: 0.6 }],
  });
  const client = new GroqClient({ apiKey: "test", fetch });
  const result = await client.transcribe(audio);

  assert.equal(result.text, "");
  assert.equal(result.filteredAsSilence, true);
});

test("uses cleanup fallback on a rate limit", async () => {
  let cleanupCalls = 0;
  const fetch = async (url) => {
    if (String(url).endsWith("/audio/transcriptions")) {
      return Response.json({ text: "hi there", segments: [] });
    }
    cleanupCalls += 1;
    if (cleanupCalls === 1) return new Response("rate limited", { status: 429 });
    return Response.json({ choices: [{ message: { content: "Hi there." } }] });
  };
  const pipeline = new DictationPipeline({ apiKey: "test", fetch });
  const result = await pipeline.dictate(audio);

  assert.equal(result.text, "Hi there.");
  assert.equal(result.cleanupModel, "qwen/qwen3.6-27b");
  assert.equal(result.usedCleanupFallback, true);
});
