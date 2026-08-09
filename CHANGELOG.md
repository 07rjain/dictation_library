# Changelog

All notable changes to this project will be documented here. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
