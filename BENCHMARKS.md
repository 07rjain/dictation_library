# Long-audio benchmarks

Run the deterministic benchmark with:

```bash
npm run benchmark:long
```

It generates PCM WAV inputs in memory, fingerprints them, segments them through the public long-job API, and uses a deterministic mock provider. Provider calls are mocked, so `orchestrationMs` measures library overhead rather than Groq network latency.

## 2026-08-09 local result

| Input | Size | Chunks | Largest provider chunk | Inspection | Segmentation | Job orchestration |
|---|---:|---:|---:|---:|---:|---:|
| 90 seconds, 16 kHz mono | 2.75 MiB | 1 | 2.75 MiB | 2.0 ms | 1.3 ms | 12.4 ms |
| 10 minutes, 16 kHz mono | 18.31 MiB | 1 | 18.31 MiB | 0.6 ms | 5.2 ms | 7.5 ms |
| 10 minutes, 48 kHz mono | 54.93 MiB | 3 | 19.00 MiB | 1.1 ms | 38.2 ms | 32.4 ms |
| 30 minutes, 16 kHz mono | 54.93 MiB | 4 | 18.31 MiB | 0.9 ms | 14.1 ms | 12.9 ms |
| 60 minutes, 16 kHz mono | 109.86 MiB | 7 | 18.31 MiB | 3.3 ms | 59.8 ms | 75.2 ms |

The important gate is the largest provider chunk: every >25 MiB and >100 MiB input remained at or below the library's 19 MiB long-chunk cap.

These results are a correctness and overhead baseline, not a provider-speed claim. Machine, runtime, codec, network, account tier, and Groq load affect live timings.

## Live benchmark

```bash
GROQ_API_KEY=your_key npm run test:long:live -- /path/to/audio.flac
```

The live command normalizes through FFmpeg, uses 60-second chunks with 2-second overlap and concurrency two, disables generative cleanup, and prints only a short transcript preview plus per-chunk timings. It consumes Groq quota and uploads the supplied audio.

## Release gates

- Existing `dictate(audio)` tests remain green.
- Direct audio above 20 MiB fails before a provider request.
- Long chunks remain at or below 19 MiB.
- >25 MiB and >100 MiB inputs finish through the chunked job path.
- Successful chunks persist after another chunk fails.
- Resumption does not retranscribe successful chunks.
- Timeline overlap is deduplicated while repetition outside overlap is preserved.
- Cleanup guards preserve raw text, numbers, URLs, emails, and digit-bearing identifiers.
- Batch refuses to run in strict zero-data-retention mode.
