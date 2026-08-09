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
- Current release: [`v0.1.0`](https://github.com/07rjain/dictation_library/releases/tag/v0.1.0)
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
4. The final result includes raw text, cleaned text, models used, fallbacks, and stage timings.

The speed-oriented defaults are:

- Transcription: `whisper-large-v3-turbo`
- Cleanup: `openai/gpt-oss-20b` with low reasoning
- Cleanup fallback: `qwen/qwen3.6-27b`
- Request timeout: 20 seconds

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

After building, test a real recording without saving the key in the repository:

```bash
GROQ_API_KEY=your_key npm run test:live -- /absolute/path/to/short-audio.webm
```

The command prints transcription, cleanup, and total pipeline timings without printing the API key.

## Public API

- `DictationPipeline`: complete transcription and cleanup orchestration.
- `DictationSession`: starts context collection before the recording finishes.
- `GroqClient`: lower-level transcription and cleanup operations.
- `BrowserRecorder`: microphone capture through the MediaRecorder API.
- `DictationError`: typed errors with stable `code` and optional HTTP `status`.

All exported TypeScript types are available from the package root.

## Contributing and security

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow and [SECURITY.md](./SECURITY.md) for responsible vulnerability reporting. Changes are tracked in [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
