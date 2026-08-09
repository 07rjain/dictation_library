# Dictation Kit Core

A reusable TypeScript pipeline for fast browser dictation with Groq. It separates browser microphone capture from server-side transcription and cleanup so the same library can support multiple applications without shipping a shared Groq key to users.

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
import { DictationPipeline } from "@dictation-kit/core";

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
