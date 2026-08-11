# Changelog

All notable changes to this project will be documented here. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-08-11

### Added

- Near-live conversation sessions with ordered partial transcripts, prior-window prompt context, final guarded cleanup, and independently playable browser recording windows.
- Deterministic live-session coverage plus a secret-backed GitHub Actions smoke test that replays `test.wav` through the live API.
- An opt-in near-live mode in the GitHub Pages BYOK demo, built directly from the current library source during deployment.
- Content-addressed long-job request keys, provider-attempt/unknown-outcome telemetry, and expiring worker leases for in-memory and file-backed stores.
- Timestamp-proven stitch decisions with confidence, provenance, and preserved alternatives.
- Experimental Batch recovery for failed, missing, and partially expired `custom_id` results plus a manual real-account smoke workflow.
- Playwright integration coverage of real `MediaRecorder` rotation and independent decoding in Chromium, Firefox, WebKit/iOS, and Chromium/Android.
- Durable cursor-addressed long-job events, per-window cleanup decisions/diffs, resumable storage progress events, a bounded Silero VAD adapter, and manual provider-boundary verification.

### Changed

- Near-live transcription now returns raw output by default; cleanup runs only when explicitly enabled.
- Near-live browser windows now default to ten seconds instead of five seconds, matching Groq's minimum billed duration while retaining 500 ms overlap.
- Live capture now uses bounded overlapping windows and deduplicates only explicitly declared overlap.
- Provider `Retry-After` values are now authoritative; `maxDelayMs` only caps locally calculated exponential backoff.
- Long jobs dynamically reduce future concurrency after provider rate limits.
- Long-job scheduling now parses Groq quota headers and dynamically paces later queued requests across the reported reset window.
- Cleanup safety now uses mode-specific limits and preserves likely named entities plus caller-defined stable transcript segments.
- Large-source hashing, PCM WAV segmentation, and FFmpeg input staging now use bounded chunks or streams instead of whole-file reads.
- Automatic routing no longer selects conceptual storage or Batch routes unless planning code explicitly enables manual routes.
- Audio Batch submission now requires an explicit `{ experimental: true }` acknowledgement.

### Fixed

- Stale file-lease guard recovery is serialized, and manifest persistence can recover after a transient store rejection.
- Browser overlap automatically falls back to sequential capture when tracks cannot be cloned; storage-deletion errors preserve successful transcripts or the original provider error.
- Long-job concurrency now recovers additively after sustained success, future HTTP-date `Retry-After` values have regression coverage, and live aborts emit `live.canceled`.
- The live provider-boundary harness now expects direct raw URLs to succeed and redirecting share URLs to fail unless explicitly configured otherwise.
- The live smoke fixture now explicitly enables dictation cleanup, matching the raw-by-default live-session API.
- Browser CI now runs Chromium/Android on Linux and Firefox/WebKit-iOS on macOS, where each Playwright engine exposes the required real `MediaRecorder` implementation.
- Cross-browser assertions tolerate normal codec startup/flush trimming while still requiring substantial independently decodable audio across a rotation boundary.
- Explicitly enabled live cleanup now runs in bounded sections and emits `live.failed` when a cleanup request fails.
- Recorder cancellation settles an in-flight stop, terminal errors are delivered only after preserved windows, and browsers that reject concurrent MediaRecorders fall back to sequential windows.
- Live overlap reconciliation now retains unspaced CJK/Thai boundaries rather than risking deletion from an unverifiable character-only match.
- Automatic long-audio routing validates processor/container compatibility before segmentation and reports `LONG_AUDIO_PROCESSOR_REQUIRED` for unsupported formats.
- The Pages demo preserves completed live windows after capture errors and fully resets its recording timer, controls, and session state.
- Completed resumable jobs now verify the supplied audio source before returning a cached result.
- Long-job resume validation now uses a full SHA-256 source identity, detecting equal-sized mutations anywhere in the recording.
- Existing `0.3.x` bounded source fingerprints are validated and upgraded in place, preserving durable job compatibility.
- GitHub Pages now deploys commit-addressed app and library modules, preventing stale mixed-version assets from leaving controls unresponsive.
- The demo now reports missing keys, unsupported recording APIs, microphone startup, and busy states directly beside the record control.
- A terminal live recorder remains logically busy until accepted windows and asynchronous error handling settle, preventing session re-entry during failure cleanup.
- Automatic long-audio routing now reuses inspected source metadata during segmentation instead of probing the same audio twice.
- Recording generations isolate delayed window and error-handler completion, so cancellation followed by restart cannot release or settle the new recording.
- Explicit `createJob()` and `dictateLong()` calls now apply the same processor compatibility preflight as automatic routing.
- Pages deployment now runs when library source or build inputs change, not only when demo files change.
- Recorder cancellation clears terminal state and pending stop handles, including cancellation during microphone startup.
- The deployed Pages revision is visible alongside its commit-addressed assets.
- Batch reads and deletions now have bounded timeouts/retries, polling supports an overall deadline, and artifact deletion failures are visible.
- Batch polling deadlines now abort an in-flight status request rather than waiting for its per-request timeout.
- Object-storage cleanup failures now report the object key/version and provider outcome instead of masking audit state.
- Long-audio stitching preserves intentional repetition unless timestamps prove both readings came from the declared overlap.
- Overlapping browser windows now use cloned audio tracks, preventing Chromium from producing undecodable output when simultaneous recorders share one track.
- Versioned temporary objects are deleted with their immutable version and report that version in storage lifecycle events.
- Timestamp ownership is now bilateral, and an empty owned region can no longer fall back to restoring duplicate chunk text.
- Legacy manifests without configuration identity require explicit migration; cached legacy results gain stitch provenance during migration.
- Live aborts cancel in-flight provider work, reject with `LIVE_SESSION_ABORTED`, and emit exactly one typed `live.canceled` event; non-cancellation terminal errors emit `live.failed`.
- Any rejected long-cleanup window now restores the complete canonical raw transcript instead of producing mixed-trust output.
- Fatal parallel chunk failures abort in-flight work, drain it before job settlement, and prevent queued chunks from starting.
- File-backed lease mutations are serialized by a cross-process guard to avoid normal acquire/renew/release races.

### Testing

- Added regression coverage for live backpressure, overlap stitching, raw-output fidelity, bounded cleanup, CJK boundaries, recorder cancellation/error ordering, and unsupported automatic long-audio routing.
- Added regressions for cancel/restart generation isolation, asynchronous terminal callbacks, and explicit long-job processor compatibility.
- Added regressions for pending microphone cancellation, stale stop handles, live cleanup failures, and both supported `Retry-After` formats.
- Added coverage for provider-authoritative retry delays, pending-permission stop behavior, immutable Pages assembly, Batch timeouts/retries, and visible artifact cleanup failures.
- Added explicit regressions for missing Web Crypto, cached legacy result migration, and deadline-aborted Batch polling sleep.
- Added blocker reproductions for empty and one-sided timestamp ownership, measured post-429 concurrency, provider abort propagation, fatal pool draining, explicit legacy migration, exact cleanup restoration, and contended file leases.
- Expanded deterministic coverage for completed-job reuse, manifest isolation, cleanup windowing, sequential context, temporary-storage cleanup, Batch lifecycle and validation, and file-store safety.
- Added explicit regression gates on Node.js 22 and 24 plus a real cross-browser recorder matrix on every push and pull request.

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
