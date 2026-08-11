import { GroqBatchClient } from "../dist/index.js";

const apiKey = process.env.GROQ_API_KEY?.trim();
const audioUrl = process.env.GROQ_BATCH_AUDIO_URL?.trim();
if (!apiKey) throw new Error("GROQ_API_KEY is required.");
if (!audioUrl) throw new Error("GROQ_BATCH_AUDIO_URL must be a public or signed HTTPS audio URL.");

const client = new GroqBatchClient({ apiKey });
const startedAt = performance.now();
const result = await client.runAudio([
  { id: "live-audio-smoke", url: audioUrl, language: "en" },
], {
  experimental: true,
  completionWindow: "24h",
  pollIntervalMs: 5_000,
  timeoutMs: 15 * 60_000,
  deleteArtifacts: true,
  metadata: { test: "groq-dictation-kit-live-audio" },
});
const line = result.lines.find((candidate) => candidate.custom_id === "live-audio-smoke");
if (!line || line.error !== undefined || (line.response?.status_code ?? 500) >= 400) {
  throw new Error(`Audio Batch smoke test failed: ${JSON.stringify(line)}`);
}
console.log(JSON.stringify({
  batchId: result.batch.id,
  status: result.batch.status,
  requestCounts: result.batch.request_counts,
  elapsedMs: +(performance.now() - startedAt).toFixed(1),
  artifactsDeleted: true,
}, null, 2));
