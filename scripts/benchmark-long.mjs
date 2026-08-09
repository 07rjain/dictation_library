import { performance } from "node:perf_hooks";
import { DictationPipeline, WavAudioProcessor, inspectAudio } from "../dist/index.js";

const CASES = [
  ["90 seconds", 90, 16_000],
  ["10 minutes / 16 kHz", 10 * 60, 16_000],
  ["10 minutes / 48 kHz / >25 MiB", 10 * 60, 48_000],
  ["30 minutes / >25 MiB", 30 * 60, 16_000],
  ["60 minutes / >100 MiB", 60 * 60, 16_000],
];

const rows = [];
for (const [label, seconds, sampleRate] of CASES) {
  const audio = makeSilentWav(seconds, sampleRate);
  const inspectionStarted = performance.now();
  const metadata = await inspectAudio(audio);
  const inspectionMs = performance.now() - inspectionStarted;
  const processor = new WavAudioProcessor();
  const segmentationStarted = performance.now();
  const chunks = await processor.segment(audio, {
    targetChunkMs: 10 * 60_000,
    overlapMs: 10_000,
    maxChunkBytes: 19 * 1024 * 1024,
  });
  const segmentationMs = performance.now() - segmentationStarted;

  let providerCalls = 0;
  const pipeline = new DictationPipeline({
    apiKey: "benchmark",
    retry: { maxAttempts: 1 },
    fetch: async (_url, init) => {
      providerCalls += 1;
      const index = Number(init.body.get("file").name.match(/(\d+)/)?.[1] ?? 0);
      return Response.json({ text: `benchmark chunk ${index}`, segments: [] });
    },
  });
  const orchestrationStarted = performance.now();
  const result = await pipeline.dictateLong(audio, {
    mode: "offline",
    targetChunkMs: 10 * 60_000,
    overlapMs: 10_000,
    concurrency: 3,
    accuracyMode: "independent",
  });
  const orchestrationMs = performance.now() - orchestrationStarted;
  rows.push({
    label,
    sizeMiB: +(metadata.sizeBytes / 1024 / 1024).toFixed(2),
    fingerprinted: Boolean(metadata.fingerprint),
    chunks: chunks.length,
    largestChunkMiB: +Math.max(...chunks.map((chunk) => chunk.audio.data.size / 1024 / 1024)).toFixed(2),
    inspectionMs: +inspectionMs.toFixed(1),
    segmentationMs: +segmentationMs.toFixed(1),
    orchestrationMs: +orchestrationMs.toFixed(1),
    providerCalls,
    completedChunks: result.chunks.length,
  });
}

console.table(rows);
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));

function makeSilentWav(seconds, sampleRate) {
  const dataBytes = seconds * sampleRate * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  writeAscii(bytes, 8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataBytes, true);
  return { data: new Blob([buffer], { type: "audio/wav" }), filename: `benchmark-${seconds}s.wav`, durationMs: seconds * 1000 };
}

function writeAscii(bytes, offset, value) {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
}
