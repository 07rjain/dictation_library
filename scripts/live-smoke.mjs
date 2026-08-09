import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { DictationPipeline } from "../dist/index.js";

const apiKey = process.env.GROQ_API_KEY?.trim();
const audioPath = process.argv[2];

if (!apiKey) {
  console.error("Set GROQ_API_KEY in the environment. Do not commit it to a file.");
  process.exit(1);
}
if (!audioPath) {
  console.error("Usage: npm run test:live -- /absolute/path/to/short-audio.webm");
  process.exit(1);
}

const absolutePath = resolve(audioPath);
const bytes = await readFile(absolutePath);
const mimeTypes = new Map([
  [".wav", "audio/wav"],
  [".webm", "audio/webm"],
  [".ogg", "audio/ogg"],
  [".mp3", "audio/mpeg"],
  [".m4a", "audio/mp4"],
]);
const mimeType = mimeTypes.get(extname(absolutePath).toLowerCase()) ?? "application/octet-stream";

const events = [];
const pipeline = new DictationPipeline({
  apiKey,
  onEvent: (event) => {
    if ("durationMs" in event) events.push({ type: event.type, durationMs: Math.round(event.durationMs) });
  },
});
const result = await pipeline.dictate(
  { data: new Blob([bytes], { type: mimeType }), filename: basename(absolutePath) },
  { context: { appName: "Live smoke test", fieldType: "document" } },
);

console.log(JSON.stringify({
  text: result.text,
  rawTranscript: result.rawTranscript,
  transcriptionModel: result.transcriptionModel,
  cleanupModel: result.cleanupModel,
  timings: Object.fromEntries(
    Object.entries(result.timings).map(([key, value]) => [key, Math.round(value)]),
  ),
  events,
}, null, 2));
