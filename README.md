# Groq Dictation Kit

[![npm version](https://img.shields.io/npm/v/groq-dictation-kit.svg)](https://www.npmjs.com/package/groq-dictation-kit)
[![npm downloads](https://img.shields.io/npm/dm/groq-dictation-kit.svg)](https://www.npmjs.com/package/groq-dictation-kit)
[![license](https://img.shields.io/npm/l/groq-dictation-kit.svg)](./LICENSE)

A reusable TypeScript pipeline for fast browser dictation with Groq. It separates browser microphone capture from server-side transcription and cleanup so the same library can support multiple applications without shipping a shared Groq key to users.

This is an independent open-source project and is not affiliated with or endorsed by Groq, Inc.

## Try it online

**[Open the live dictation website](https://07rjain.github.io/dictation_library/)**

The website uses the same `groq-dictation-kit` library, built from the current repository source during deployment. Bring your own Groq API key, record in the browser, and inspect the cleaned transcript and per-stage latency measurements. The key is kept only in the current browser tab and requests are sent directly to Groq; the demo has no account system, database, analytics, or backend proxy.

To test the current website:

1. Paste a Groq API key into **Your Groq key**. A reload intentionally clears it, so it must be entered again after refreshing.
2. Leave **Live partials** off for the original record-then-transcribe flow, or enable it for overlapping transcript updates about every ten seconds.
3. Select **Start dictating**, allow microphone access, speak, then select **Stop & transcribe** or **Stop & finish**.
4. If microphone permission was previously denied, restore it in the browser's site settings and reload the page.

The Pages deployment builds the current library source and serves content-addressed application and ESM assets from the same commit. This prevents a browser cache from combining incompatible website and library versions. The npm package link remains the latest stable registry release.

## Package

- npm: [`groq-dictation-kit`](https://www.npmjs.com/package/groq-dictation-kit)
- Live website: [`07rjain.github.io/dictation_library`](https://07rjain.github.io/dictation_library/)
- Source and issues: [`07rjain/dictation_library`](https://github.com/07rjain/dictation_library)
- Registry release: [`v0.3.0`](https://github.com/07rjain/dictation_library/releases/tag/v0.3.0); this working tree prepares `v0.4.0`
- Runtime: ESM with bundled TypeScript declarations; Node.js 20 or newer
- License: MIT

## Installation

```bash
npm install groq-dictation-kit
```

The minimal JavaScript integration remains:

```js
import { DictationPipeline } from "groq-dictation-kit";

const pipeline = new DictationPipeline({ apiKey });
const result = await pipeline.dictate(audio);
```

`audio` is an `AudioInput`: `{ data: Blob, filename?: string, durationMs?: number }`. In a browser, pass the `Blob` returned by `MediaRecorder`. In Node.js, wrap uploaded bytes with `new Blob([buffer], { type: mimeType })`. Supplying `filename` and `durationMs` improves format detection, routing, and timeout selection.

### Choose the right API

| Workload | API | Behavior |
| --- | --- | --- |
| Short interactive dictation | `pipeline.dictate(audio)` | Fast transcription plus guarded cleanup |
| Automatic short/long selection | `pipeline.dictateAuto(audio, options)` | Direct below the safety thresholds; codec-aware chunks otherwise |
| Long, observable, resumable audio | `pipeline.createJob(audio, options)` | Progress events, durable manifests, partial recovery |
| Near-live conversation | `pipeline.startLiveConversation(options)` | Ordered partial transcripts while new windows are recorded |
| Transcription without cleanup | `pipeline.transcribe(audio)` | Lower-level Whisper result |
| Private object already on HTTPS | `pipeline.transcribeUrl(url)` | Provider fetches the signed URL |
| Deferred bulk work | `pipeline.batches` | Asynchronous Batch lifecycle; not for live dictation |

Use `dictateLong` when you want the long-audio result directly without managing the job object. URL and Batch paths are explicit because storage retention and deletion are application decisions.

### Near-live conversation

[Groq speech-to-text](https://console.groq.com/docs/speech-to-text) currently accepts complete files or URLs rather than a streaming audio WebSocket. `BrowserLiveRecorder` therefore restarts `MediaRecorder` for each independently playable window while `LiveConversationSession` uploads the previous window in parallel with continued recording:

```ts
import { BrowserLiveRecorder, DictationPipeline } from "groq-dictation-kit";

const pipeline = new DictationPipeline({
  apiKey,
  dangerouslyAllowBrowser: true, // BYOK prototypes only; use your server in production
});
const session = pipeline.startLiveConversation({
  language: "en",
  cleanup: { mode: "dictation" },
  onEvent(event) {
    if (event.type === "live.partial") {
      transcriptElement.textContent = event.chunk.transcript;
    }
  },
});
let recorderError: unknown;
const recorder = new BrowserLiveRecorder({
  windowMs: 10_000,
  overlapMs: 500,
  onWindow: (audio) => session.push(audio),
  onError(error) {
    // Keep one finalization owner; stop() settles after this callback returns.
    recorderError = error;
  },
});

await recorder.start();
// The user speaks; completed windows are transcribed as recording continues.
try {
  await recorder.stop();
} catch (error) {
  // A recorder failure is reported through both onError and stop().
  if (error !== recorderError) throw error;
}
const final = await session.finish();
if (recorderError) console.warn(recorderError, final.text);
```

The default 10-second window matches Groq's minimum billed audio length. Adjacent windows share 500 ms of audio and the session removes only overlap explicitly declared by the recorder. `recorder.isRecording` remains true while terminal window delivery and `onError` are settling, so a new capture cannot start against a session that is still draining. Recorder and session backpressure protect different boundaries: the recorder bounds encoded blobs waiting for `onWindow`, while the session bounds direct `push()` callers. Both default to four pending windows and 32 MiB, with `LIVE_BACKPRESSURE_LIMIT` returned when a consumer cannot keep up. Browsers that reject simultaneous `MediaRecorder` instances automatically fall back to sequential self-contained windows.

Live output is raw by default. Enable `cleanup: { mode: "dictation" }` or `cleanup: { mode: "verbatim" }` explicitly; cleanup is split into bounded sections and any rejected section restores the complete canonical raw transcript. Smaller recording windows reduce visible latency but increase request count and may cost more. This is near-live micro-batching, not token-by-token streaming; speaker diarization is not inferred by this API.

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

## Development and verification

```bash
npm install
npm test
# Equivalent explicit CI gate:
npm run test:regression
npm run test:browser
npm run benchmark:long
npm audit --omit=dev
npm pack --dry-run
```

`npm test` builds the TypeScript package and runs the deterministic suite without contacting Groq. It covers short and near-live transcription, bounded backpressure, conservative unspaced-script boundaries, recorder cancellation/error ordering, configuration precedence, retries/timeouts, codec-safe chunking, timestamp-proven stitching, cleanup guards and windows, long-job request identity/leases/provider outcomes/resume/abort, storage deletion, Batch lifecycle/recovery, adapter permissions, and FFmpeg normalization when FFmpeg is installed.

`npm run test:browser` uses the real browser `MediaRecorder` and Web Audio decoder in Chromium, Firefox, desktop Safari/WebKit, and Chromium/Android emulation. A continuous synthetic audio source crosses a rotation boundary, and every emitted window must decode independently. GitHub Actions runs Chromium on Linux and Firefox/WebKit on macOS for every push and pull request. Playwright does not run real iOS Safari; native iOS behavior still requires device testing.

Use `npm run test:live` only when you intentionally want a real provider request. Live credentials are never required for the deterministic suite.

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
import { DictationPipeline } from "groq-dictation-kit";
import { FfmpegAudioProcessor } from "groq-dictation-kit/node";

const pipeline = new DictationPipeline({ apiKey: process.env.GROQ_API_KEY! });
const result = await pipeline.dictateAuto(audio, {
  processor: new FfmpegAudioProcessor(),
});
```

The built-in browser-compatible long-audio processor accepts PCM WAV. Compressed WebM/Opus from `BrowserRecorder` needs the Node.js FFmpeg processor (or your own `AudioProcessor`) once a chunked path is selected. All long-audio entry points check processor compatibility before segmentation and return `LONG_AUDIO_PROCESSOR_REQUIRED` with format details instead of failing later with a misleading WAV error.

`routeAudio(audio, policy)` exposes the same decision without executing it. Automatic routing selects only executable `direct` and `chunked` paths by default. Set `allowManualRoutes: true` only in planning code that understands the conceptual `stored-url` and `batch` decisions; `dictateAuto` deliberately does not pretend it can upload, refresh signed URLs, or run a Batch lifecycle for you.

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
  if (event.type === "job.progress") {
    console.log(`${event.completed}/${event.total} chunks complete`);
  }
}

const result = await job.result();
```

Successful chunks are persisted immediately. A failed job can retry only missing chunks:

```ts
const resumed = pipeline.resumeJob(jobId, audio, { store, processor });
const result = await resumed.result();
```

When a job is partial, `CHUNK_TRANSCRIPTION_FAILED.details` includes the completed chunks and a best-effort partial transcript. `job.inspect()` exposes the complete durable manifest. Segment timestamps returned in the final result are offset to the absolute recording timeline.

Reusing a job ID with different source audio fails with `JOB_SOURCE_MISMATCH`, including after the original job has completed. Changing the model, prompt, language, preprocessing, time range, or response/timestamp options fails with `JOB_CONFIGURATION_MISMATCH` instead of silently reusing stale chunks. Each chunk has a content-addressed request key; manifests separately record logical chunk attempts, provider attempts, and timeout/network outcomes whose provider billing status is unknown.

The default `MemoryJobStore` survives within one pipeline process. For restart recovery on a Node.js host:

```ts
import { FileJobStore, FfmpegAudioProcessor } from "groq-dictation-kit/node";

const store = new FileJobStore("/explicit/private/dictation-manifests");
const processor = new FfmpegAudioProcessor();

const job = pipeline.createJob(audio, { store, processor });
```

For horizontally scaled production systems, implement the exported `JobStore` interface using your database, including its expiring lease methods. `MemoryJobStore` and `FileJobStore` already prevent concurrent workers from processing the same job; the file adapter serializes lease takeover, renewal, and release across processes on one host. Long-job manifests include durable cursor-addressed lifecycle events and a full SHA-256 content identity. Large sources are hashed incrementally; WAV boundaries read only bounded slices; the Node FFmpeg adapter streams the source Blob to its private temporary file. Durable long jobs require Web Crypto availability and fail with `DURABLE_IDENTITY_UNAVAILABLE` when it is unavailable.

Pre-`0.4` manifests without a configuration identity are rejected with `JOB_LEGACY_MIGRATION_REQUIRED`. After verifying that the stored job options match, opt into a one-time migration with `migrateLegacyManifest: true`. Migration validates the legacy source fingerprint, upgrades it to full SHA-256, creates the configuration identity, and adds missing stitch provenance to cached results.

Groq `Retry-After` delays are honored without the local backoff cap. A 429 multiplicatively lowers future long-job concurrency; sustained successful requests then restore it additively up to the configured maximum. Groq quota headers are exposed on provider-attempt telemetry and dynamically pace later queued chunks across the reported reset window. Long jobs emit `concurrency.reduced`, `concurrency.increased`, and `rate-limit.observed`. Stitching requests segment timestamps and removes text only when it is proven to belong to the declared audio overlap. Uncertain lexical repetition is preserved; `result.stitching` records confidence, provenance, and alternatives for every decision.

Every long-job event has a durable `cursor` and timestamp. Resume an event consumer without replaying already handled events:

```ts
for await (const event of job.events(lastStoredCursor)) {
  lastStoredCursor = event.cursor;
  await persistEvent(event);
}
```

## URL and private object-storage transcription

These are explicit, manual integration APIs. `ObjectStorage.put()` receives an optional resume token, abort signal, and progress callback; adapters can return immutable versions, checksums, resumed byte counts, and a new resume token. `onStorageEvent` reports upload, transcription, and deletion completion/failure. The package remains provider-neutral: multipart implementation, upload-while-recording, signed-URL refresh, durable upload state, retention, and audit storage belong in the application adapter. Supplying `durationMs` enables an adaptive provider timeout.

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
  uploadResumeToken: previousResumeToken,
  onStorageEvent: (event) => persistAuditEvent(event),
});
```

URL ingestion is not treated as unlimited. Applications should still chunk audio above the account limit or when they need progress and recovery. Live verification on 2026-08-10 showed that Groq fetched a direct `raw.githubusercontent.com` WAV but rejected a GitHub URL returning HTTP 302; pass a final direct object URL, not a redirecting share page.

## Background Batch transcription

Batch is for asynchronous workloads, not interactive dictation. It requires HTTPS audio URLs and may retain processing artifacts:

```ts
const batch = await pipeline.batches.submitAudio([
  { id: "meeting-001", url: signedAudioUrl, language: "en" },
], { experimental: true });

const completed = await pipeline.batches.wait(batch.id);
const lines = await pipeline.batches.results(completed);
await pipeline.batches.deleteArtifacts(completed);
```

Audio Batch is feature-gated and every submission requires `{ experimental: true }`. `runAudio()` provides submit/wait/result/artifact-cleanup orchestration. For a failed or expired job, `recoverIncomplete()` reads any available output/error artifacts and resubmits only failed or missing `custom_id` values; if no artifact exists, every original request is unresolved. Provider submission POSTs are never automatically replayed after an unknown timeout.

The manual `test:batch:live` workflow validates the real account/API schema with one URL and deletes input, output, and error artifacts. Configure repository secrets `GROQ_API_KEY` and `GROQ_BATCH_AUDIO_URL`, then explicitly dispatch the workflow with `RUN_BATCH`.

Set `zeroDataRetention: true` on `DictationPipeline` to make Batch calls fail locally with `BATCH_DISABLED_FOR_ZDR`.

## Errors and recovery

All expected library failures use `DictationError`, with a stable `code` and optional HTTP `status`:

```ts
import { DictationError } from "groq-dictation-kit";

try {
  await pipeline.dictateAuto(audio, options);
} catch (error) {
  if (error instanceof DictationError && error.code === "CHUNK_TRANSCRIPTION_FAILED") {
    const details = error.details as { partialTranscript?: string } | undefined;
    const partial = details?.partialTranscript;
    // Persist the job ID, show the partial text, and offer resume.
  }
  throw error;
}
```

Common recovery paths:

- `AUDIO_TOO_LARGE`: use `dictateAuto`, `dictateLong`, or signed-URL ingestion.
- `AUDIO_PROCESSING_UNAVAILABLE`: supply a processor that supports the input codec; use `FfmpegAudioProcessor` on Node.js.
- `CHUNK_TRANSCRIPTION_FAILED`: preserve the job ID and resume with the same audio, store, processor, and chunk layout.
- `JOB_SOURCE_MISMATCH`: do not reuse that job ID for a different recording.
- `JOB_LEGACY_MIGRATION_REQUIRED`: verify the old job configuration, then explicitly resume once with `migrateLegacyManifest: true`.
- `DURABLE_IDENTITY_UNAVAILABLE`: run long jobs in a secure browser context or a supported Node.js runtime with Web Crypto.
- `RATE_LIMITED`: lower concurrency or set `requestsPerMinute` below the account allowance.
- `REQUEST_TIMEOUT`: retry safely; completed long-job chunks remain reusable.
- `INSECURE_AUDIO_URL`: issue a short-lived HTTPS URL.
- `BATCH_EXPERIMENTAL_DISABLED`: explicitly acknowledge the manual audio Batch API with `{ experimental: true }`.
- `BATCH_DISABLED_FOR_ZDR`: use the interactive or URL path when strict zero-data retention is required.

Retryable requests treat Groq's `Retry-After` as authoritative; both numeric-seconds and HTTP-date values are supported. When that header is absent, the library uses exponential backoff with jitter capped by `retry.maxDelayMs`—5,000 ms by default:

```ts
const pipeline = new DictationPipeline({
  apiKey,
  retry: { maxAttempts: 3, maxDelayMs: 5_000 },
});
```

Batch GET/DELETE operations use the same retry policy and a per-request timeout. Submission,
upload, and cancellation POSTs are not replayed automatically because a timed-out request can
have an unknown provider outcome. `pipeline.batches.wait(id, { timeoutMs, signal })` also supports
an overall polling deadline, and `deleteArtifacts()` reports any file IDs that could not be removed.

## Cleanup safety modes

- `dictation`: removes fillers and false starts; this remains the short-audio default.
- `verbatim`: preserves spoken words and repairs punctuation/casing.
- `none`: returns the canonical Whisper transcript; this is the long-audio default.
- `summary`: produces an explicitly requested summary rather than pretending it is a transcript.

For non-summary cleanup, mode-specific deletion/expansion limits, numbers, URLs, emails, digit-bearing identifiers, likely named entities, and caller-supplied `stableSegments` are guarded. `verbatim` is stricter than `dictation`; explicit ratio overrides remain supported. Every cleanup returns a deterministic guard ID, reasons, changed stable-segment IDs, bounded word diff, and measured ratios. Long and live results expose `cleanupWindows`, and their event streams report each accepted or rejected window. If any bounded window is rejected, the complete canonical raw transcript is returned and accepted/rejected text is never mixed.

Long cleanup runs in bounded windows instead of sending an entire meeting to one completion request.

## Accuracy modes

- `independent`: fastest and fully parallel.
- `retry-ambiguous`: default; independently transcribes chunks, then retries only low-confidence boundaries with a bounded tail of prior context.
- `sequential`: concurrency one with previous context for accuracy-sensitive workloads.

`VadWavAudioProcessor` can move PCM WAV boundaries toward quiet RMS frames without removing any part of the audio timeline. For learned speech detection, install the optional runtime with `npm install @ricky0123/vad-web`, then pass an initialized `NonRealTimeVAD` instance to `SileroVadWavAudioProcessor`; it evaluates only the bounded boundary-search window, not the complete recording:

```ts
import { NonRealTimeVAD } from "@ricky0123/vad-web";
import { SileroVadWavAudioProcessor } from "groq-dictation-kit";

const processor = new SileroVadWavAudioProcessor(await NonRealTimeVAD.new());
const result = await pipeline.dictateLong(audio, { processor });
```

The Silero package and ONNX assets remain optional and are not bundled into this provider-neutral library.

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

Provider-size, duration, raw-URL, redirect, signed-URL, range, and fetch-timeout behavior can be rechecked with the manual `Provider boundary verification` workflow or locally:

```bash
GROQ_API_KEY=your_key npm run test:boundaries:live -- --direct-25 --urls
GROQ_API_KEY=your_key npm run test:boundaries:live -- --duration
```

The optional 100 MiB URL probes upload generated silence only and are deliberately manual because they transfer hundreds of megabytes. Signed-URL expiry, range-required origins, and slow-fetch behavior require controlled URLs supplied through the workflow secrets documented in `.github/workflows/provider-boundaries.yml`.

The GitHub Actions workflow `Manual 10-minute Groq benchmark` provides the same check using the repository secret. It runs only through `workflow_dispatch` and only when its confirmation input is exactly `RUN_LONG`; ordinary pushes never trigger it.

The repository's `Live Groq smoke test` GitHub Actions workflow replays `test.wav` through `LiveConversationSession` after every push to `main`. GitHub runners have no microphone, so a committed spoken fixture is the reproducible equivalent of one captured live window. The fixture says “Hello, um, this is a live test,” and the workflow verifies the partial, raw, and cleaned results, including removal of the filler word. It reads `GROQ_API_KEY` from GitHub Actions secrets and is intentionally not triggered for pull requests, so forked code cannot access the credential. Because this makes live Groq requests, each `main` push consumes a small amount of the account's quota.

## Public API

- `DictationPipeline`: complete transcription and cleanup orchestration.
- `DictationSession`: starts context collection before the recording finishes.
- `GroqClient`: lower-level transcription and cleanup operations.
- `BrowserRecorder`: microphone capture through the MediaRecorder API.
- `BrowserLiveRecorder` / `LiveConversationSession`: independently playable microphone windows and ordered near-live partial transcripts.
- `LongJob`: progress, partial failure, resumption, and results for chunked audio.
- `WavAudioProcessor` / `VadWavAudioProcessor` / `SileroVadWavAudioProcessor`: bounded-memory PCM WAV segmentation with fixed, energy-based, or learned boundaries.
- `FfmpegAudioProcessor` / `FileJobStore`: Node-only adapters from `groq-dictation-kit/node`.
- `GroqBatchClient`: asynchronous URL-based audio Batch jobs.
- `DictationError`: typed errors with stable `code` and optional HTTP `status`.

All exported TypeScript types are available from the package root.

## Contributing and security

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow and [SECURITY.md](./SECURITY.md) for responsible vulnerability reporting. Changes are tracked in [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
