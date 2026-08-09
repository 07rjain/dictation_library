# Changelog

All notable changes to this project will be documented here. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Near-live conversation sessions with ordered partial transcripts, prior-window prompt context, final guarded cleanup, and independently playable browser recording windows.
- Deterministic live-session coverage plus a secret-backed GitHub Actions smoke test that replays `test.wav` through the live API.
- An opt-in near-live mode in the GitHub Pages BYOK demo, built directly from the current library source during deployment.

### Fixed

- Completed resumable jobs now verify the supplied audio source before returning a cached result.
- GitHub Pages now deploys commit-addressed app and library modules, preventing stale mixed-version assets from leaving controls unresponsive.
- The demo now reports missing keys, unsupported recording APIs, microphone startup, and busy states directly beside the record control.

### Testing

- Expanded deterministic coverage for completed-job reuse, manifest isolation, cleanup windowing, sequential context, temporary-storage cleanup, Batch lifecycle and validation, and file-store safety.
- Added an explicit `test:regression` GitHub Actions gate on every push and pull request for Node.js 20 and 22.

## [0.3.0] - 2026-08-09

### Added

- Resumable long-audio jobs with bounded concurrency, progress events, partial results, and per-chunk persistence.
- Codec-safe PCM WAV segmentation, optional VAD-assisted boundaries, and Node.js FFmpeg normalization through the `groq-dictation-kit/node` export.
- Absolute recording timestamps and timestamp-aware overlap stitching with fuzzy lexical fallback limited to actual overlap regions.
- Durable `FileJobStore`, portable `JobStore`, `AudioProcessor`, and `ObjectStorage` adapters.
- HTTPS URL transcription, temporary private-storage transcription, and asynchronous Groq audio Batch support.
- Long-form cleanup modes, bounded cleanup windows, deletion/expansion/protected-term guards, and canonical raw transcripts.
- Adaptive transcription timeouts, retry/backoff behavior, content fingerprints, account-rate pacing, and stable long-job errors.
- Deterministic >25 MiB and >100 MiB benchmark plus an explicit live long-audio benchmark command.

### Changed

- Direct multipart uploads now use a conservative 20 MiB safety limit; larger recordings are directed to the long-audio or URL APIs.
- Browser recording can stream MediaRecorder transport fragments through `onChunk` while optionally retaining the complete recording.

## [0.2.0] - 2026-08-09

### Added

- Constructor-level and per-dictation overrides for transcription, cleanup, prompts, hallucination filtering, reasoning, response tokens, and request parameters.
- Exported constants for every built-in model, request, filtering, cleanup, and browser-recording default.

## [0.1.0] - 2026-08-09

### Added

- Reusable TypeScript pipeline for Groq transcription and LLM cleanup.
- Browser microphone recorder with compact Opus/WebM capture.
- Concurrent context-session API and per-stage latency measurements.
- Conservative Whisper silence-hallucination filtering.
- Cleanup model fallback for rate limits and provider failures.
- Local benchmark web application and live smoke-test command.
