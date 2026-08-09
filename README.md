# Groq Dictation Kit

[![npm version](https://img.shields.io/npm/v/groq-dictation-kit.svg)](https://www.npmjs.com/package/groq-dictation-kit)
[![npm downloads](https://img.shields.io/npm/dm/groq-dictation-kit.svg)](https://www.npmjs.com/package/groq-dictation-kit)
[![license](https://img.shields.io/npm/l/groq-dictation-kit.svg)](./LICENSE)

A reusable TypeScript pipeline for fast browser dictation with Groq. It separates browser microphone capture from server-side transcription and cleanup so the same library can support multiple applications without shipping a shared Groq key to users.

This is an independent open-source project and is not affiliated with or endorsed by Groq, Inc.

## Try it online

**[Open the live dictation website](https://07rjain.github.io/dictation_library/)**

The website uses the published `groq-dictation-kit` package. Bring your own Groq API key, record in the browser, and inspect the cleaned transcript and per-stage latency measurements. The key is kept only in the current browser tab and requests are sent directly to Groq; the demo has no account system, database, analytics, or backend proxy.

## Package

- npm: [`groq-dictation-kit`](https://www.npmjs.com/package/groq-dictation-kit)
- Live website: [`07rjain.github.io/dictation_library`](https://07rjain.github.io/dictation_library/)
- Source and issues: [`07rjain/dictation_library`](https://github.com/07rjain/dictation_library)
- Current release: [`v0.3.0`](https://github.com/07rjain/dictation_library/releases/tag/v0.3.0)
- Runtime: ESM with bundled TypeScript declarations; Node.js 20 or newer
- License: MIT

## Installation

```bash
npm install groq-dictation-kit
```

## Pipeline

1. `BrowserRecorder` captures a compact Opus/WebM recording.
2. `DictationPipeline` sends the audio to Groq Whisper.
3. A strict cleanup prompt removes filler and self-corrections without answering the dictated text.
4. Long recordings can use codec-aware overlapping chunks, bounded concurrency, resumable manifests, and timestamp-aware stitching.
5. The final result includes raw text, cleaned text, models used, fallbacks, and stage timings.

The speed-oriented defaults are:

- Transcription: `whisper-large-v3-turbo`
- Cleanup: `openai/gpt-oss-20b` with low reasoning
- Cleanup fallback: `qwen/qwen3.6-27b`
- Direct multipart safety limit: 20 MiB
- Adaptive request timeout: 20–180 seconds based on audio duration or size
- Long interactive chunks: 60 seconds with 2 seconds of overlap
- Long offline chunks: up to 10 minutes, automatically capped below 20 MiB

## Customize defaults safely

Every built-in request and filtering setting is now optional configuration. If a setting is omitted, the library uses the same defaults listed above, so existing integrations continue to behave exactly as before.

Set reusable defaults when constructing the pipeline:

```ts
import {
  DEFAULT_HALLUCINATION_PHRASES,
  DictationPipeline,
} from "groq-dictation-kit";

const pipeline = new DictationPipeline({
  apiKey: process.env.GROQ_API_KEY!,
  timeoutMs: 30_000,
  transcription: {
    temperature: 0.1,
    language: "en",
    hallucinationPhrases: [
      ...DEFAULT_HALLUCINATION_PHRASES,
      "custom silence phrase",
    ],
    hallucinationNoSpeechThreshold: 0.2,
  },
  cleanup: {
    systemPrompt: "Return only lightly edited dictated text.",
    temperature: 0.2,
    maxCompletionTokens: 2048,
    reasoningEffort: "low",
    includeReasoning: false,
    emptyResponseToken: "EMPTY",
  },
});
```

Override them for one dictation without changing the pipeline defaults:

```ts
const result = await pipeline.dictate(audio, {
  transcription: {
    filterHallucinations: false,
    temperature: 0.3,
  },
  cleanup: {
    systemPrompt: "Preserve every spoken word; only fix punctuation.",
    reasoningEffort: false,
  },
});
```

Advanced integrations can provide `cleanup.messageBuilder` to replace the complete system/user message array. All built-in values—including models, Groq URL, timeout, temperatures, response format, hallucination phrases and threshold, token limit, reasoning behavior, empty-response token, and browser recording defaults—are exported as `DEFAULT_*` constants.

Configuration precedence is: per-call flat compatibility options, per-call nested options, constructor defaults, then built-in defaults.

## Install and verify

```bash
npm install
npm test
```

## Run the benchmark web app

Add a Groq key to an ignored `.env` file at either `web/.env` or the repository root, then start the local app:

```bash
GROQ_API_KEY=your_key
npm run dev
```

Open `http://127.0.0.1:4173`. The interface measures browser recording duration, request parsing, Groq transcription, cleanup, server overhead, network overhead, total server time, and full browser round-trip time.

## Server usage

Keep `GROQ_API_KEY` on your server:

```ts
import { DictationPipeline } from "groq-dictation-kit";

const pipeline = new DictationPipeline({
  apiKey: process.env.GROQ_API_KEY!,
});

const result = await pipeline.dictate(
  { data: uploadedAudioBlob, filename: "dictation.webm" },
  {
    language: "en",
    context: { appName: "My app", fieldType: "chat" },
    vocabulary: ["AcmeCloud", "Rishabh"],
  },
);

console.log(result.text, result.timings);
```

## Long recordings and files over 25 MB

`dictateLong` is additive: the original `dictate` API remains unchanged. Long-form output defaults to the raw transcript so an LLM cannot silently compress a large recording.

Use `dictateAuto` when the library should inspect the input and retain the direct path for recordings no longer than 90 seconds and below 20 MiB, or select chunking otherwise:

```ts
const result = await pipeline.dictateAuto(audio, {
  processor: new FfmpegAudioProcessor(),
});
```

`routeAudio(audio, policy)` exposes the same decision without executing it. Its possible decisions are `direct`, `stored-url`, `chunked`, and `batch`; URL and Batch execution remain explicit because they require storage and retention choices.

```ts
const result = await pipeline.dictateLong(
  { data: uploadedAudioBlob, filename: "meeting.wav" },
  {
    mode: "interactive",
    concurrency: 2,
    requestsPerMinute: 18, // useful for an account with a 20 RPM allowance
    cleanup: { mode: "verbatim" },
  },
);

console.log(result.rawTranscript);
console.log(result.chunks);
```

The dependency-free built-in processor segments PCM WAV files. On a Node.js server, use FFmpeg for WebM, MP4, FLAC, stereo/high-rate WAV, and other supported inputs:

```ts
import { DictationPipeline } from "groq-dictation-kit";
import { FfmpegAudioProcessor } from "groq-dictation-kit/node";

const result = await pipeline.dictateLong(audio, {
  processor: new FfmpegAudioProcessor({ output: "flac" }),
  targetChunkMs: 60_000,
  overlapMs: 2_000,
});
```

FFmpeg converts provider-bound chunks to 16 kHz mono. FLAC minimizes upload size; WAV is available when encoding latency matters more than bandwidth.

The library never splits compressed containers at arbitrary byte offsets. Supply an `AudioProcessor` when the built-in WAV processor cannot decode the input.

## Observable and resumable jobs

```ts
const job = pipeline.createJob(audio, {
  targetChunkMs: 60_000,
  overlapMs: 2_000,
  concurrency: 2,
});

for await (const event of job.events()) {
  console.log(event.type);
}

const result = await job.result();
```

Successful chunks are persisted immediately. A failed job can retry only missing chunks:

```ts
const resumed = pipeline.resumeJob(jobId, audio, { store, processor });
const result = await resumed.result();
```

When a job is partial, `CHUNK_TRANSCRIPTION_FAILED.details` includes the completed chunks and a best-effort partial transcript. `job.inspect()` exposes the complete durable manifest. Segment timestamps returned in the final result are offset to the absolute recording timeline.

The default `MemoryJobStore` survives within one pipeline process. For restart recovery on a Node.js host:

```ts
import { FileJobStore, FfmpegAudioProcessor } from "groq-dictation-kit/node";

const store = new FileJobStore("/explicit/private/dictation-manifests");
const processor = new FfmpegAudioProcessor();

const job = pipeline.createJob(audio, { store, processor });
```

For horizontally scaled production systems, implement the exported `JobStore` interface using your database. Manifests include a bounded content fingerprint and reject mismatched resume audio.

## URL and private object-storage transcription

Groq accepts an HTTPS `url` instead of a multipart attachment:

```ts
const transcription = await pipeline.transcribeUrl(shortLivedSignedUrl, {
  language: "en",
});
```

Or implement `ObjectStorage` and let the pipeline upload, sign, transcribe, and delete the temporary object:

```ts
const transcription = await pipeline.transcribeStored(audio, storage, {
  signedUrlExpiresInSeconds: 300,
});
```

URL ingestion is not treated as unlimited. Applications should still chunk audio above the account limit or when they need progress and recovery.

## Background Batch transcription

Batch is for asynchronous workloads, not interactive dictation. It requires HTTPS audio URLs and may retain processing artifacts:

```ts
const batch = await pipeline.batches.submitAudio([
  { id: "meeting-001", url: signedAudioUrl, language: "en" },
]);

const completed = await pipeline.batches.wait(batch.id);
const lines = await pipeline.batches.results(completed);
await pipeline.batches.deleteArtifacts(completed);
```

Set `zeroDataRetention: true` on `DictationPipeline` to make Batch calls fail locally with `BATCH_DISABLED_FOR_ZDR`.

## Cleanup safety modes

- `dictation`: removes fillers and false starts; this remains the short-audio default.
- `verbatim`: preserves spoken words and repairs punctuation/casing.
- `none`: returns the canonical Whisper transcript; this is the long-audio default.
- `summary`: produces an explicitly requested summary rather than pretending it is a transcript.

For non-summary cleanup, deletion, expansion, numbers, URLs, emails, and digit-bearing identifiers are guarded. Rejected cleanup returns the original window and sets `cleanupRejected`.

Long cleanup runs in bounded windows instead of sending an entire meeting to one completion request.

## Accuracy modes

- `independent`: fastest and fully parallel.
- `retry-ambiguous`: default; independently transcribes chunks, then retries only low-confidence boundaries with a bounded tail of prior context.
- `sequential`: concurrency one with previous context for accuracy-sensitive workloads.

`VadWavAudioProcessor` can move PCM WAV boundaries toward quiet frames without removing any part of the audio timeline.

## Hide context latency while the user speaks

Start the session at the same time as microphone recording. The context provider begins immediately and overlaps the recording:

```ts
const session = pipeline.startSession(async () => {
  return { appName: "My app", fieldType: "email", activity: "Replying to a customer" };
});

await recorder.start();
// The user speaks...
const recording = await recorder.stop();
const result = await session.finish({
  data: recording.blob,
  filename: recording.filename,
});
```

## Browser security

Do not embed a shared Groq key in frontend JavaScript. The intended web application flow is:

```text
Browser microphone -> your HTTPS endpoint -> DictationPipeline -> Groq
```

For a local-only BYOK prototype, users may enter their own key and opt into direct browser use with `dangerouslyAllowBrowser: true`. That mode is deliberately noisy because browser storage, extensions, logs, and bundled code can expose the key.

The included benchmark server is a local development harness, not a production authentication layer. Before deploying it publicly, add user authentication, per-user rate limiting, request logging policies, abuse controls, and your own data-retention disclosure. Never commit `.env` files or expose a shared Groq key to frontend code.

The public BYOK demo is intended for short, ephemeral dictation. Production long-audio applications should use a server, private storage, durable manifests, and an explicit deletion policy.

## Accuracy mode

Use `whisper-large-v3` instead of the Turbo model when accuracy matters more than the lowest latency:

```ts
const pipeline = new DictationPipeline({
  apiKey: process.env.GROQ_API_KEY!,
  transcriptionModel: "whisper-large-v3",
});
```

Supplying an ISO-639-1 `language` and a short vocabulary `prompt` can also improve transcription accuracy and latency.

## Live latency check

Test a real recording without saving the key in the repository:

```bash
GROQ_API_KEY=your_key npm run test:live -- /absolute/path/to/short-audio.webm
```

The command prints provider results plus transcription, cleanup, and total timings without printing the API key.

When no audio path is supplied, the command generates a short WAV fixture and performs one real transcription plus one real cleanup request:

```bash
GROQ_API_KEY=your_key npm run test:live
```

Run the deterministic local large-file benchmark, including >25 MiB and >100 MiB inputs:

```bash
npm run benchmark:long
```

Run an explicit live long-audio benchmark:

```bash
GROQ_API_KEY=your_key npm run test:long:live -- /absolute/path/to/ten-minute-audio.flac
```

This can make many provider requests. Review the chunk count and account limits before running it. See [BENCHMARKS.md](./BENCHMARKS.md) for methodology and the latest local results.

The GitHub Actions workflow `Manual 10-minute Groq benchmark` provides the same check using the repository secret. It runs only through `workflow_dispatch` and only when its confirmation input is exactly `RUN_LONG`; ordinary pushes never trigger it.

The repository's `Live Groq smoke test` GitHub Actions workflow runs `test.wav` after every push to `main`. The fixture says “Hello, um, this is a live test,” and the workflow verifies both the raw Whisper transcript and the cleaned result, including removal of the filler word. It reads `GROQ_API_KEY` from GitHub Actions secrets and is intentionally not triggered for pull requests, so forked code cannot access the credential. Because this makes live Groq requests, each `main` push consumes a small amount of the account's quota.

## Public API

- `DictationPipeline`: complete transcription and cleanup orchestration.
- `DictationSession`: starts context collection before the recording finishes.
- `GroqClient`: lower-level transcription and cleanup operations.
- `BrowserRecorder`: microphone capture through the MediaRecorder API.
- `LongJob`: progress, partial failure, resumption, and results for chunked audio.
- `WavAudioProcessor` / `VadWavAudioProcessor`: browser-compatible PCM WAV segmentation.
- `FfmpegAudioProcessor` / `FileJobStore`: Node-only adapters from `groq-dictation-kit/node`.
- `GroqBatchClient`: asynchronous URL-based audio Batch jobs.
- `DictationError`: typed errors with stable `code` and optional HTTP `status`.

All exported TypeScript types are available from the package root.

## Contributing and security

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow and [SECURITY.md](./SECURITY.md) for responsible vulnerability reporting. Changes are tracked in [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
