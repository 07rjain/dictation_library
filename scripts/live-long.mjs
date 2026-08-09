import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { DictationPipeline } from "../dist/index.js";
import { FfmpegAudioProcessor } from "../dist/node.js";

const apiKey = process.env.GROQ_API_KEY?.trim();
const inputPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!apiKey) throw new Error("GROQ_API_KEY is required.");
if (!inputPath) throw new Error("Pass an audio file path: npm run test:long:live -- /path/to/audio");

const bytes = await readFile(inputPath);
const extension = extname(inputPath).toLowerCase();
const mimeType = extension === ".wav" ? "audio/wav" : extension === ".flac" ? "audio/flac" : "application/octet-stream";
const audio = { data: new Blob([bytes], { type: mimeType }), filename: basename(inputPath) };
const events = [];
const pipeline = new DictationPipeline({ apiKey });
const job = pipeline.createJob(audio, {
  mode: "interactive",
  targetChunkMs: 60_000,
  overlapMs: 2_000,
  maxChunkBytes: 19 * 1024 * 1024,
  concurrency: 2,
  accuracyMode: "independent",
  cleanup: { mode: "none" },
  processor: new FfmpegAudioProcessor({ output: "flac" }),
});
const eventsPromise = (async () => {
  for await (const event of job.events()) {
    if (event.type === "chunk.completed") {
      events.push({ type: event.type, index: event.index, durationMs: +event.durationMs.toFixed(1) });
    }
  }
})();
const result = await job.result();
await eventsPromise;

console.log(JSON.stringify({
  input: { filename: basename(inputPath), sizeBytes: bytes.length, ...result.source },
  jobId: result.jobId,
  chunkCount: result.chunks.length,
  transcriptCharacters: result.rawTranscript.length,
  transcriptPreview: result.rawTranscript.slice(0, 240),
  timings: Object.fromEntries(Object.entries(result.timings).map(([key, value]) => [key, +value.toFixed(1)])),
  chunks: events,
}, null, 2));
