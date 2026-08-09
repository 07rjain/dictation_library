import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CLEANUP_SYSTEM_PROMPT,
  DEFAULT_HALLUCINATION_PHRASES,
  DictationPipeline,
  GroqClient,
} from "../dist/index.js";

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

test("preserves all request defaults when custom configuration is omitted", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/audio/transcriptions")) {
      return Response.json({ text: "hello", segments: [{ no_speech_prob: 0 }] });
    }
    return Response.json({ choices: [{ message: { content: "Hello." } }] });
  };
  const pipeline = new DictationPipeline({ apiKey: "test", fetch });
  await pipeline.dictate(audio);

  const transcriptionForm = calls[0].init.body;
  assert.equal(transcriptionForm.get("model"), "whisper-large-v3-turbo");
  assert.equal(transcriptionForm.get("response_format"), "verbose_json");
  assert.equal(transcriptionForm.get("temperature"), "0");

  const cleanupBody = JSON.parse(calls[1].init.body);
  assert.equal(cleanupBody.model, "openai/gpt-oss-20b");
  assert.equal(cleanupBody.temperature, 0);
  assert.equal(cleanupBody.max_completion_tokens, 4096);
  assert.equal(cleanupBody.reasoning_effort, "low");
  assert.equal(cleanupBody.include_reasoning, false);
  assert.equal(cleanupBody.messages[0].content, DEFAULT_CLEANUP_SYSTEM_PROMPT);
  assert.ok(DEFAULT_HALLUCINATION_PHRASES.includes("thank you"));
});

test("supports constructor-level transcription and hallucination overrides", async () => {
  let requestForm;
  const fetch = async (_url, init) => {
    requestForm = init.body;
    return Response.json({
      text: "Custom ghost phrase.",
      segments: [{ no_speech_prob: 0.7 }],
    });
  };
  const client = new GroqClient({
    apiKey: "test",
    fetch,
    transcription: {
      language: "fr",
      prompt: "Produit Exemple",
      temperature: 0.25,
      responseFormat: "verbose_json",
      hallucinationPhrases: ["custom ghost phrase"],
      hallucinationNoSpeechThreshold: 0.6,
    },
  });
  const result = await client.transcribe(audio);

  assert.equal(result.text, "");
  assert.equal(result.filteredAsSilence, true);
  assert.equal(requestForm.get("language"), "fr");
  assert.equal(requestForm.get("prompt"), "Produit Exemple");
  assert.equal(requestForm.get("temperature"), "0.25");
});

test("supports non-JSON transcription response formats", async () => {
  const fetch = async () => new Response("Plain transcript");
  const client = new GroqClient({
    apiKey: "test",
    fetch,
    transcription: { responseFormat: "text" },
  });
  const result = await client.transcribe(audio);

  assert.equal(result.text, "Plain transcript");
  assert.deepEqual(result.segments, []);
});

test("supports cleanup request and system prompt overrides", async () => {
  let requestBody;
  const fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return Response.json({ choices: [{ message: { content: "NONE" } }] });
  };
  const client = new GroqClient({
    apiKey: "test",
    fetch,
    cleanup: {
      systemPrompt: "CUSTOM CLEANUP SYSTEM",
      temperature: 0.3,
      maxCompletionTokens: 321,
      reasoningEffort: "medium",
      includeReasoning: true,
      emptyResponseToken: "NONE",
    },
  });
  const result = await client.cleanup("hello there");

  assert.equal(result.text, "");
  assert.equal(requestBody.messages[0].content, "CUSTOM CLEANUP SYSTEM");
  assert.equal(requestBody.temperature, 0.3);
  assert.equal(requestBody.max_completion_tokens, 321);
  assert.equal(requestBody.reasoning_effort, "medium");
  assert.equal(requestBody.include_reasoning, true);
});

test("supports per-dictation nested overrides without changing legacy options", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/audio/transcriptions")) {
      return Response.json({ text: "Thank you.", segments: [{ no_speech_prob: 0.9 }] });
    }
    return Response.json({ choices: [{ message: { content: "Thank you." } }] });
  };
  const pipeline = new DictationPipeline({ apiKey: "test", fetch });
  const result = await pipeline.dictate(audio, {
    transcription: { filterHallucinations: false, temperature: 0.4 },
    cleanup: {
      messageBuilder: (transcript) => [
        { role: "system", content: "ONE-OFF SYSTEM" },
        { role: "user", content: transcript },
      ],
      reasoningEffort: false,
    },
  });

  assert.equal(result.filteredAsSilence, false);
  assert.equal(calls[0].init.body.get("temperature"), "0.4");
  const cleanupBody = JSON.parse(calls[1].init.body);
  assert.equal(cleanupBody.messages[0].content, "ONE-OFF SYSTEM");
  assert.equal("reasoning_effort" in cleanupBody, false);
});

test("retries retryable transcription failures without replaying cleanup", async () => {
  let calls = 0;
  const client = new GroqClient({
    apiKey: "test",
    retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Response("temporary", { status: 503 });
      return Response.json({ text: "Recovered", segments: [] });
    },
  });
  const result = await client.transcribe(audio);
  assert.equal(result.text, "Recovered");
  assert.equal(calls, 2);
});

test("adaptive timeout produces a stable REQUEST_TIMEOUT error", async () => {
  const client = new GroqClient({
    apiKey: "test",
    timeoutMs: 2,
    timeoutPolicy: { minimumMs: 2, maximumMs: 10, perAudioSecondMs: 0, perMiBMs: 0 },
    retry: { maxAttempts: 1 },
    fetch: async (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  });
  await assert.rejects(
    client.transcribe(audio),
    (error) => error instanceof Error && error.code === "REQUEST_TIMEOUT",
  );
});
