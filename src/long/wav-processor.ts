import { inspectAudio, isWav } from "../audio.js";
import { DictationError } from "../errors.js";
import type { AudioInput, AudioMetadata } from "../types.js";
import type { AudioChunk, AudioProcessor, AudioSegmentationOptions } from "./types.js";

interface WavLayout {
  bytes: Uint8Array;
  dataOffset: number;
  dataLength: number;
  byteRate: number;
  blockAlign: number;
  format: number;
  bitsPerSample: number;
  channels: number;
  sampleRate: number;
}

export interface WavAudioProcessorOptions {
  /** Search around nominal boundaries for a quiet PCM frame. Zero keeps fixed boundaries. */
  boundarySearchMs?: number;
  /** Maximum normalized RMS for a boundary to count as quiet. */
  silenceThreshold?: number;
}

/** Dependency-free PCM WAV segmenter used by default for WAV uploads and benchmarks. */
export class WavAudioProcessor implements AudioProcessor {
  readonly name: string = "wav-pcm";

  constructor(private readonly options: WavAudioProcessorOptions = {}) {}

  inspect(audio: AudioInput): Promise<AudioMetadata> {
    return inspectAudio(audio);
  }

  async segment(audio: AudioInput, options: AudioSegmentationOptions): Promise<readonly AudioChunk[]> {
    const metadata = await inspectAudio(audio);
    if (!isWav(metadata.mimeType, metadata.filename)) {
      throw new DictationError(
        "The built-in processor can segment PCM WAV audio only. Supply an AudioProcessor for WebM, MP4, FLAC, or other codecs.",
        { code: "AUDIO_PROCESSING_UNAVAILABLE", details: metadata },
      );
    }
    const layout = parseWav(new Uint8Array(await audio.data.arrayBuffer()));
    const totalMs = (layout.dataLength / layout.byteRate) * 1000;
    const sizeBoundMs = options.maxChunkBytes === undefined
      ? Number.POSITIVE_INFINITY
      : (options.maxChunkBytes / layout.byteRate) * 1000;
    const targetMs = Math.max(1_000, Math.min(options.targetChunkMs, sizeBoundMs));
    const overlapMs = Math.min(Math.max(0, options.overlapMs), targetMs / 2);
    const chunks: AudioChunk[] = [];
    let startMs = 0;
    let index = 0;
    while (startMs < totalMs) {
      if (options.signal?.aborted) throw options.signal.reason;
      const nominalEndMs = Math.min(totalMs, startMs + targetMs);
      const endMs = nominalEndMs < totalMs
        ? findQuietBoundary(layout, startMs, nominalEndMs, targetMs, this.options)
        : nominalEndMs;
      const startByte = alignedByte(layout, startMs);
      const endByte = Math.min(layout.dataLength, alignedByte(layout, endMs));
      const wav = createWavSlice(layout, startByte, Math.max(startByte, endByte));
      chunks.push({
        index,
        startMs,
        endMs,
        overlapBeforeMs: index === 0 ? 0 : overlapMs,
        audio: {
          data: new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }),
          filename: `chunk-${String(index).padStart(5, "0")}.wav`,
          durationMs: endMs - startMs,
        },
      });
      if (endMs >= totalMs) break;
      startMs = endMs - overlapMs;
      index += 1;
    }
    return chunks;
  }
}

/** VAD-assisted PCM WAV processor. It moves boundaries to quiet frames but never drops audio. */
export class VadWavAudioProcessor extends WavAudioProcessor {
  override readonly name = "wav-pcm-vad";

  constructor(options: WavAudioProcessorOptions = {}) {
    super({ boundarySearchMs: 5_000, silenceThreshold: 0.025, ...options });
  }
}

function parseWav(bytes: Uint8Array): WavLayout {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new DictationError("Invalid WAV container.", { code: "INVALID_AUDIO" });
  }
  let offset = 12;
  let byteRate = 0;
  let blockAlign = 0;
  let dataOffset = -1;
  let dataLength = 0;
  let format = 0;
  let bitsPerSample = 0;
  let channels = 0;
  let sampleRate = 0;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (id === "fmt " && start + 16 <= bytes.length) {
      format = view.getUint16(start, true);
      if (format !== 1 && format !== 3) {
        throw new DictationError("Built-in WAV segmentation supports PCM and IEEE float WAV only.", {
          code: "AUDIO_PROCESSING_UNAVAILABLE",
          details: { wavFormat: format },
        });
      }
      byteRate = view.getUint32(start + 8, true);
      blockAlign = view.getUint16(start + 12, true);
      channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
      bitsPerSample = view.getUint16(start + 14, true);
    }
    if (id === "data") {
      dataOffset = start;
      dataLength = Math.min(size, bytes.length - start);
      break;
    }
    offset = start + size + (size % 2);
  }
  if (dataOffset < 0 || !byteRate || !blockAlign) {
    throw new DictationError("WAV metadata is incomplete.", { code: "INVALID_AUDIO" });
  }
  return { bytes, dataOffset, dataLength, byteRate, blockAlign, format, bitsPerSample, channels, sampleRate };
}

function findQuietBoundary(
  layout: WavLayout,
  chunkStartMs: number,
  nominalEndMs: number,
  targetMs: number,
  options: WavAudioProcessorOptions,
): number {
  const searchMs = Math.max(0, options.boundarySearchMs ?? 0);
  if (!searchMs || layout.format !== 1 || layout.bitsPerSample !== 16) return nominalEndMs;
  const totalMs = (layout.dataLength / layout.byteRate) * 1000;
  const earliest = Math.max(chunkStartMs + targetMs * 0.6, nominalEndMs - searchMs);
  const latest = Math.min(totalMs, nominalEndMs + searchMs);
  const frameMs = 20;
  let bestMs = nominalEndMs;
  let bestRms = Number.POSITIVE_INFINITY;
  const view = new DataView(layout.bytes.buffer, layout.bytes.byteOffset, layout.bytes.byteLength);
  for (let candidate = earliest; candidate <= latest; candidate += frameMs) {
    const start = layout.dataOffset + alignedByte(layout, candidate);
    const end = Math.min(layout.dataOffset + layout.dataLength, start + alignedByte(layout, frameMs));
    let sumSquares = 0;
    let samples = 0;
    for (let offset = start; offset + 1 < end; offset += 2) {
      const normalized = view.getInt16(offset, true) / 32768;
      sumSquares += normalized * normalized;
      samples += 1;
    }
    const rms = samples ? Math.sqrt(sumSquares / samples) : Number.POSITIVE_INFINITY;
    if (rms < bestRms) {
      bestRms = rms;
      bestMs = candidate + frameMs / 2;
    }
  }
  return bestRms <= (options.silenceThreshold ?? 0.025) ? bestMs : nominalEndMs;
}

function alignedByte(layout: WavLayout, milliseconds: number): number {
  const raw = Math.floor((milliseconds / 1000) * layout.byteRate);
  return Math.floor(raw / layout.blockAlign) * layout.blockAlign;
}

function createWavSlice(layout: WavLayout, relativeStart: number, relativeEnd: number): Uint8Array {
  const dataLength = relativeEnd - relativeStart;
  const header = layout.bytes.slice(0, layout.dataOffset);
  const output = new Uint8Array(header.length + dataLength);
  output.set(header);
  output.set(layout.bytes.subarray(layout.dataOffset + relativeStart, layout.dataOffset + relativeEnd), header.length);
  const view = new DataView(output.buffer);
  view.setUint32(4, output.length - 8, true);
  view.setUint32(layout.dataOffset - 4, dataLength, true);
  return output;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
