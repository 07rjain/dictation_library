import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { DictationPipeline } from "../dist/index.js";

const apiKey = process.env.GROQ_API_KEY?.trim();
const audioPath = process.argv[2];

if (!apiKey) {
  console.error("Set GROQ_API_KEY in the environment. Do not commit it to a file.");
  process.exit(1);
}
const mimeTypes = new Map([
  [".wav", "audio/wav"],
  [".webm", "audio/webm"],
  [".ogg", "audio/ogg"],
  [".mp3", "audio/mpeg"],
  [".m4a", "audio/mp4"],
]);

let audio;
let verifyKnownFixture = false;
if (audioPath) {
  const absolutePath = resolve(audioPath);
  const bytes = await readFile(absolutePath);
  const mimeType = mimeTypes.get(extname(absolutePath).toLowerCase()) ?? "application/octet-stream";
  audio = { data: new Blob([bytes], { type: mimeType }), filename: basename(absolutePath) };
  verifyKnownFixture = basename(absolutePath) === "test.wav";
} else {
  audio = {
    data: new Blob([createToneWav()], { type: "audio/wav" }),
    filename: "generated-live-smoke.wav",
  };
}

const pipeline = new DictationPipeline({
  apiKey,
});

if (audioPath) {
  const session = pipeline.startLiveConversation({
    language: "en",
    // Live sessions intentionally return raw text by default. This fixture asserts cleanup,
    // so opt into the dictation cleanup mode explicitly.
    cleanup: { mode: "dictation" },
    context: { appName: "Live smoke test", fieldType: "document" },
  });
  const partial = await session.push(audio);
  const result = await session.finish();
  if (verifyKnownFixture) assertExpectedFixture(result.rawTranscript, result.text);
  console.log(JSON.stringify({
    mode: "near-live-window",
    fixture: audioPath,
    partialTranscript: partial.transcript,
    rawTranscript: result.rawTranscript,
    cleanedText: result.text,
    transcriptionModel: result.transcriptionModel,
    cleanupModel: result.cleanupModel,
    usedCleanupFallback: result.usedCleanupFallback,
    timings: Object.fromEntries(
      Object.entries(result.timings).map(([key, value]) => [key, Math.round(value)]),
    ),
  }, null, 2));
} else {
  const transcriptionStartedAt = performance.now();
  const transcription = await pipeline.transcribe(audio, { language: "en" });
  const transcriptionMs = performance.now() - transcriptionStartedAt;
  const cleanupStartedAt = performance.now();
  const cleanup = await pipeline.cleanup("hello um this is the groq dictation kit live smoke test", {
    context: { appName: "Live smoke test", fieldType: "document" },
  });
  const cleanupMs = performance.now() - cleanupStartedAt;

  if (!cleanup.text) throw new Error("Live cleanup returned empty text.");

  console.log(JSON.stringify({
    transcription: {
      text: transcription.text,
      model: transcription.model,
      filteredAsSilence: transcription.filteredAsSilence,
    },
    cleanup: {
      text: cleanup.text,
      model: cleanup.model,
      usedFallback: cleanup.usedFallback,
    },
    timings: {
      transcriptionMs: Math.round(transcriptionMs),
      cleanupMs: Math.round(cleanupMs),
      totalMs: Math.round(transcriptionMs + cleanupMs),
    },
  }, null, 2));
}

function assertExpectedFixture(rawTranscript, cleanedText) {
  const raw = normalize(rawTranscript);
  const cleaned = normalize(cleanedText);
  for (const [label, value] of [["raw transcript", raw], ["cleaned text", cleaned]]) {
    if (!value.includes("hello") || !value.includes("live test")) {
      throw new Error(`Live fixture ${label} did not contain the expected phrase.`);
    }
  }
  if (/\bum\b/.test(cleaned)) {
    throw new Error("Live cleanup did not remove the expected filler word.");
  }
}

function normalize(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function createToneWav(durationSeconds = 0.75, sampleRate = 16_000) {
  const sampleCount = Math.round(durationSeconds * sampleRate);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, sampleCount * 2, true);
  for (let index = 0; index < sampleCount; index += 1) {
    const fade = Math.min(1, index / 400, (sampleCount - index) / 400);
    const sample = Math.sin(2 * Math.PI * 440 * index / sampleRate) * 0.08 * fade;
    view.setInt16(44 + index * 2, Math.round(sample * 32767), true);
  }
  return buffer;
}
