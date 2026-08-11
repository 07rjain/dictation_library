import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inspectAudio } from "../audio.js";
import { DictationError } from "../errors.js";
import type { AudioInput, AudioMetadata } from "../types.js";
import type { AudioChunk, AudioProcessor, AudioSegmentationOptions } from "../long/types.js";

const run = promisify(execFile);

export interface FfmpegAudioProcessorOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  temporaryRoot?: string;
  commandTimeoutMs?: number;
  /** Output codec. WAV is lowest-latency; FLAC produces smaller files. */
  output?: "wav" | "flac";
}

/** Server-side codec adapter for WebM, MP4, FLAC, WAV, and other FFmpeg inputs. */
export class FfmpegAudioProcessor implements AudioProcessor {
  readonly name = "ffmpeg-16khz-mono";
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly temporaryRoot: string;
  private readonly commandTimeoutMs: number;
  private readonly output: "wav" | "flac";

  constructor(options: FfmpegAudioProcessorOptions = {}) {
    this.ffmpegPath = options.ffmpegPath ?? "ffmpeg";
    this.ffprobePath = options.ffprobePath ?? "ffprobe";
    this.temporaryRoot = options.temporaryRoot ?? tmpdir();
    this.commandTimeoutMs = options.commandTimeoutMs ?? 10 * 60_000;
    this.output = options.output ?? "flac";
  }

  supports(): boolean {
    return true;
  }

  async inspect(audio: AudioInput): Promise<AudioMetadata> {
    const basic = await inspectAudio(audio);
    if (basic.durationMs !== undefined) return basic;
    return this.withInput(audio, async (path) => {
      try {
        const { stdout } = await run(this.ffprobePath, [
          "-v", "error",
          "-select_streams", "a:0",
          "-show_entries", "stream=sample_rate,channels,codec_name:format=duration",
          "-of", "json",
          path,
        ], { timeout: this.commandTimeoutMs });
        const info = JSON.parse(stdout) as {
          streams?: Array<{ sample_rate?: string; channels?: number; codec_name?: string }>;
          format?: { duration?: string };
        };
        const stream = info.streams?.[0];
        const duration = Number(info.format?.duration);
        const sampleRate = Number(stream?.sample_rate);
        return {
          ...basic,
          ...(Number.isFinite(duration) ? { durationMs: duration * 1000 } : {}),
          ...(Number.isFinite(sampleRate) ? { sampleRate } : {}),
          ...(stream?.channels !== undefined ? { channels: stream.channels } : {}),
          ...(stream?.codec_name ? { codec: stream.codec_name } : {}),
        };
      } catch (cause) {
        throw ffmpegError("Unable to inspect audio with ffprobe.", cause);
      }
    });
  }

  async segment(audio: AudioInput, options: AudioSegmentationOptions): Promise<readonly AudioChunk[]> {
    const metadata = options.metadata ?? await this.inspect(audio);
    if (metadata.durationMs === undefined) {
      throw new DictationError("Audio duration could not be determined.", { code: "INVALID_AUDIO" });
    }
    return this.withInput(audio, async (inputPath, directory) => {
      const chunks: AudioChunk[] = [];
      const conservativeOutputBytesPerSecond = 16_000 * 2;
      const sizeBoundMs = options.maxChunkBytes === undefined
        ? Number.POSITIVE_INFINITY
        : (options.maxChunkBytes / conservativeOutputBytesPerSecond) * 1000;
      const targetMs = Math.max(1_000, Math.min(options.targetChunkMs, sizeBoundMs));
      const overlapMs = Math.min(Math.max(0, options.overlapMs), targetMs / 2);
      let startMs = 0;
      let index = 0;
      while (startMs < metadata.durationMs!) {
        if (options.signal?.aborted) throw options.signal.reason;
        const endMs = Math.min(metadata.durationMs!, startMs + targetMs);
        const extension = this.output === "flac" ? ".flac" : ".wav";
        const outputPath = join(directory, `chunk-${String(index).padStart(5, "0")}${extension}`);
        const codecArgs = this.output === "flac" ? ["-c:a", "flac"] : ["-c:a", "pcm_s16le"];
        try {
          await run(this.ffmpegPath, [
            "-hide_banner", "-loglevel", "error", "-y",
            "-ss", (startMs / 1000).toFixed(3),
            "-i", inputPath,
            "-t", ((endMs - startMs) / 1000).toFixed(3),
            "-vn", "-map", "0:a:0", "-ar", "16000", "-ac", "1",
            ...codecArgs,
            outputPath,
          ], { timeout: this.commandTimeoutMs, signal: options.signal });
        } catch (cause) {
          throw ffmpegError(`Unable to create audio chunk ${index}.`, cause);
        }
        const bytes = await readFile(outputPath);
        chunks.push({
          index,
          startMs,
          endMs,
          overlapBeforeMs: index === 0 ? 0 : overlapMs,
          audio: {
            data: new Blob([bytes], { type: this.output === "flac" ? "audio/flac" : "audio/wav" }),
            filename: `chunk-${String(index).padStart(5, "0")}${extension}`,
            durationMs: endMs - startMs,
          },
        });
        if (endMs >= metadata.durationMs!) break;
        startMs = endMs - overlapMs;
        index += 1;
      }
      return chunks;
    });
  }

  private async withInput<T>(
    audio: AudioInput,
    action: (path: string, directory: string) => Promise<T>,
  ): Promise<T> {
    const directory = await mkdtemp(join(this.temporaryRoot, "groq-dictation-"));
    const extension = safeExtension(audio.filename);
    const path = join(directory, `input${extension}`);
    await pipeline(
      Readable.fromWeb(audio.data.stream() as import("node:stream/web").ReadableStream),
      createWriteStream(path, { mode: 0o600 }),
    );
    try {
      return await action(path, directory);
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function safeExtension(filename?: string): string {
  const extension = extname(filename ?? "").toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".audio";
}

function ffmpegError(message: string, cause: unknown): DictationError {
  const missing = typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
  return new DictationError(missing ? `${message} FFmpeg/ffprobe is not installed or not on PATH.` : message, {
    code: "AUDIO_PROCESSING_FAILED",
    cause,
  });
}
