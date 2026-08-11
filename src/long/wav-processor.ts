import { inspectAudio, isWav } from "../audio.js";
import { DictationError } from "../errors.js";
import type { AudioInput, AudioMetadata } from "../types.js";
import type { AudioChunk, AudioProcessor, AudioSegmentationOptions } from "./types.js";

interface WavLayout {
  header: Uint8Array;
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

export interface LearnedVadSpeechSegment {
  start: number;
  end: number;
}

/** Compatible with `@ricky0123/vad-web`'s initialized `NonRealTimeVAD` instance. */
export interface SileroVadRuntime {
  run(audio: Float32Array, sampleRate: number): AsyncIterable<LearnedVadSpeechSegment>;
}

/** Dependency-free PCM WAV segmenter used by default for WAV uploads and benchmarks. */
export class WavAudioProcessor implements AudioProcessor {
  readonly name: string = "wav-pcm";

  constructor(protected readonly options: WavAudioProcessorOptions = {}) {}

  inspect(audio: AudioInput): Promise<AudioMetadata> {
    return inspectAudio(audio);
  }

  supports(_audio: AudioInput, metadata: AudioMetadata): boolean {
    return isWav(metadata.mimeType, metadata.filename);
  }

  async segment(audio: AudioInput, options: AudioSegmentationOptions): Promise<readonly AudioChunk[]> {
    const metadata = options.metadata ?? await inspectAudio(audio);
    if (!isWav(metadata.mimeType, metadata.filename)) {
      throw new DictationError(
        "The built-in processor can segment PCM WAV audio only. Supply an AudioProcessor for WebM, MP4, FLAC, or other codecs.",
        { code: "AUDIO_PROCESSING_UNAVAILABLE", details: metadata },
      );
    }
    const layout = await readWavLayout(audio.data);
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
        ? await this.selectBoundary(audio.data, layout, startMs, nominalEndMs, targetMs)
        : nominalEndMs;
      const startByte = alignedByte(layout, startMs);
      const endByte = Math.min(layout.dataLength, alignedByte(layout, endMs));
      const wav = createWavSlice(audio.data, layout, startByte, Math.max(startByte, endByte));
      chunks.push({
        index,
        startMs,
        endMs,
        overlapBeforeMs: index === 0 ? 0 : overlapMs,
        audio: {
          data: wav,
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

  protected selectBoundary(
    blob: Blob,
    layout: WavLayout,
    chunkStartMs: number,
    nominalEndMs: number,
    targetMs: number,
  ): Promise<number> {
    return findQuietBoundary(blob, layout, chunkStartMs, nominalEndMs, targetMs, this.options);
  }
}

/** VAD-assisted PCM WAV processor. It moves boundaries to quiet frames but never drops audio. */
export class VadWavAudioProcessor extends WavAudioProcessor {
  override readonly name = "wav-pcm-vad";

  constructor(options: WavAudioProcessorOptions = {}) {
    super({ boundarySearchMs: 5_000, silenceThreshold: 0.025, ...options });
  }
}

/**
 * Learned Silero boundary selection without buffering the complete recording.
 * Pass an initialized `NonRealTimeVAD` from `@ricky0123/vad-web`; only the bounded
 * boundary-search window is decoded and evaluated by the model.
 */
export class SileroVadWavAudioProcessor extends WavAudioProcessor {
  override readonly name = "wav-pcm-silero-vad";

  constructor(
    private readonly vad: SileroVadRuntime,
    options: WavAudioProcessorOptions = {},
  ) {
    super({ boundarySearchMs: 5_000, ...options });
  }

  protected override async selectBoundary(
    blob: Blob,
    layout: WavLayout,
    chunkStartMs: number,
    nominalEndMs: number,
    targetMs: number,
  ): Promise<number> {
    if ((layout.format !== 1 && layout.format !== 3) || ![16, 32].includes(layout.bitsPerSample)) {
      return super.selectBoundary(blob, layout, chunkStartMs, nominalEndMs, targetMs);
    }
    const searchMs = Math.max(0, this.options.boundarySearchMs ?? 5_000);
    if (!searchMs) return nominalEndMs;
    const totalMs = (layout.dataLength / layout.byteRate) * 1000;
    const earliest = Math.max(chunkStartMs + targetMs * 0.6, nominalEndMs - searchMs);
    const latest = Math.min(totalMs, nominalEndMs + searchMs);
    const startByte = alignedByte(layout, earliest);
    const endByte = alignedByte(layout, latest);
    const bytes = new Uint8Array(await blob.slice(
      layout.dataOffset + startByte,
      layout.dataOffset + endByte,
    ).arrayBuffer());
    const samples = pcmToMonoFloat(bytes, layout);
    const speech: LearnedVadSpeechSegment[] = [];
    for await (const segment of this.vad.run(samples, layout.sampleRate)) speech.push(segment);
    const relativeNominal = nominalEndMs - earliest;
    const relative = nearestNonSpeechPoint(relativeNominal, latest - earliest, speech);
    return earliest + relative;
  }
}

async function readWavLayout(blob: Blob): Promise<WavLayout> {
  let headerBytes = Math.min(blob.size, 64 * 1024);
  while (headerBytes <= Math.min(blob.size, 4 * 1024 * 1024)) {
    const bytes = new Uint8Array(await blob.slice(0, headerBytes).arrayBuffer());
    const parsed = parseWav(bytes, blob.size, headerBytes === blob.size);
    if (parsed) return parsed;
    if (headerBytes === blob.size) break;
    headerBytes = Math.min(blob.size, headerBytes * 2);
  }
  throw new DictationError("WAV metadata exceeds the 4 MiB safety limit or is incomplete.", {
    code: "INVALID_AUDIO",
  });
}

function parseWav(bytes: Uint8Array, blobSize: number, complete: boolean): WavLayout | undefined {
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
      if (start > bytes.length) return undefined;
      dataLength = Math.min(size, Math.max(0, blobSize - start));
      break;
    }
    offset = start + size + (size % 2);
  }
  if (dataOffset < 0 && !complete) return undefined;
  if (dataOffset < 0 || !byteRate || !blockAlign) {
    throw new DictationError("WAV metadata is incomplete.", { code: "INVALID_AUDIO" });
  }
  return {
    header: bytes.slice(0, dataOffset),
    dataOffset,
    dataLength,
    byteRate,
    blockAlign,
    format,
    bitsPerSample,
    channels,
    sampleRate,
  };
}

async function findQuietBoundary(
  blob: Blob,
  layout: WavLayout,
  chunkStartMs: number,
  nominalEndMs: number,
  targetMs: number,
  options: WavAudioProcessorOptions,
): Promise<number> {
  const searchMs = Math.max(0, options.boundarySearchMs ?? 0);
  if (!searchMs || layout.format !== 1 || layout.bitsPerSample !== 16) return nominalEndMs;
  const totalMs = (layout.dataLength / layout.byteRate) * 1000;
  const earliest = Math.max(chunkStartMs + targetMs * 0.6, nominalEndMs - searchMs);
  const latest = Math.min(totalMs, nominalEndMs + searchMs);
  const frameMs = 20;
  let bestMs = nominalEndMs;
  let bestRms = Number.POSITIVE_INFINITY;
  const rangeStart = alignedByte(layout, earliest);
  const rangeEnd = Math.min(layout.dataLength, alignedByte(layout, latest + frameMs));
  const bytes = new Uint8Array(await blob.slice(
    layout.dataOffset + rangeStart,
    layout.dataOffset + rangeEnd,
  ).arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let candidate = earliest; candidate <= latest; candidate += frameMs) {
    const start = alignedByte(layout, candidate) - rangeStart;
    const end = Math.min(bytes.byteLength, start + alignedByte(layout, frameMs));
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

function createWavSlice(blob: Blob, layout: WavLayout, relativeStart: number, relativeEnd: number): Blob {
  const dataLength = relativeEnd - relativeStart;
  const header = layout.header.slice();
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  view.setUint32(4, header.length + dataLength - 8, true);
  view.setUint32(layout.dataOffset - 4, dataLength, true);
  return new Blob([
    header,
    blob.slice(layout.dataOffset + relativeStart, layout.dataOffset + relativeEnd),
  ], { type: "audio/wav" });
}

function pcmToMonoFloat(bytes: Uint8Array, layout: WavLayout): Float32Array {
  const bytesPerSample = layout.bitsPerSample / 8;
  const frames = Math.floor(bytes.byteLength / layout.blockAlign);
  const output = new Float32Array(frames);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < layout.channels; channel += 1) {
      const offset = frame * layout.blockAlign + channel * bytesPerSample;
      sum += layout.format === 3
        ? view.getFloat32(offset, true)
        : view.getInt16(offset, true) / 32768;
    }
    output[frame] = Math.max(-1, Math.min(1, sum / layout.channels));
  }
  return output;
}

function nearestNonSpeechPoint(
  nominalMs: number,
  durationMs: number,
  speech: readonly LearnedVadSpeechSegment[],
): number {
  const candidates: number[] = [nominalMs, 0, durationMs];
  for (const segment of speech) candidates.push(segment.start, segment.end);
  const outsideSpeech = (time: number) => !speech.some((segment) => time > segment.start && time < segment.end);
  return candidates
    .filter((time) => Number.isFinite(time) && time >= 0 && time <= durationMs && outsideSpeech(time))
    .sort((left, right) => Math.abs(left - nominalMs) - Math.abs(right - nominalMs))[0] ?? nominalMs;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
