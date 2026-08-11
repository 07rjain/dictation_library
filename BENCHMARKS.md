# Long-audio benchmarks

Run the deterministic benchmark with:

```bash
npm run benchmark:long
```

It generates PCM WAV inputs in memory, fingerprints them, segments them through the public long-job API, and uses a deterministic mock provider. Provider calls are mocked, so `orchestrationMs` measures library overhead rather than Groq network latency.

## 2026-08-10 local result

| Input | Size | Chunks | Largest provider chunk | Inspection | Segmentation | Job orchestration |
|---|---:|---:|---:|---:|---:|---:|
| 90 seconds, 16 kHz mono | 2.75 MiB | 1 | 2.75 MiB | 3.6 ms | 0.4 ms | 22.8 ms |
| 10 minutes, 16 kHz mono | 18.31 MiB | 1 | 18.31 MiB | 1.2 ms | 0.2 ms | 373.9 ms |
| 10 minutes, 48 kHz mono | 54.93 MiB | 3 | 19.00 MiB | 1.1 ms | 0.5 ms | 1,041.8 ms |
| 30 minutes, 16 kHz mono | 54.93 MiB | 4 | 18.31 MiB | 0.9 ms | 0.4 ms | 1,033.9 ms |
| 60 minutes, 16 kHz mono | 109.86 MiB | 7 | 18.31 MiB | 1.5 ms | 0.4 ms | 2,221.0 ms |

The important gate is the largest provider chunk: every >25 MiB and >100 MiB input remained at or below the library's 19 MiB long-chunk cap. Orchestration now includes full incremental SHA-256 source identity, so its time scales with input size while peak reads remain bounded.

These results are a correctness and overhead baseline, not a provider-speed claim. Machine, runtime, codec, network, account tier, and Groq load affect live timings.

## 2026-08-10 live provider boundaries

Using generated silence and the configured account:

| Probe | Observed result |
|---|---|
| Multipart WAV, 25 MiB minus 8 KiB | HTTP 200 in 8.5 s |
| Multipart WAV, 25 MiB plus 8 KiB | HTTP 413 in 0.2 s |
| Direct raw GitHub HTTPS URL | HTTP 200 in 0.9 s |
| GitHub URL returning HTTP 302 | HTTP 400; Groq reported the 302 instead of following it |
| Ten-minute, 18.31 MiB WAV | HTTP 200 in 6.7 s; provider reported 599.94 s duration |
| Base64URL just below/above 100 MiB | Both HTTP 413 because encoded request bodies exceeded the request path; this does not establish the remote-URL file ceiling |
| Temporary HTTPS URL just below/above 100 MiB | Both fetched but returned `could not process file`; the account tier was unspecified, so the exact remote 100 MiB ceiling remains an account-controlled experiment |

The exact remote-object ceiling must not be inferred from the Base64 result. Re-run the manual workflow with `GROQ_ACCOUNT_TIER` and a controlled direct object-store URL. Signed-URL expiry, range enforcement, and provider fetch-timeout probes are skipped unless their dedicated URLs are configured.

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
- Large WAV and FFmpeg inputs are processed without a whole-Blob `arrayBuffer()` read.
- Durable event cursors replay only events after the requested cursor.
- Real browser windows decode independently in Chromium, Firefox, WebKit/iOS, and Chromium/Android.
- Batch refuses to run in strict zero-data-retention mode.
