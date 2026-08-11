import { DictationError } from "./errors.js";
import type { AudioInput, AudioMetadata } from "./types.js";
import { IncrementalSha256 } from "./sha256.js";

export async function inspectAudio(audio: AudioInput): Promise<AudioMetadata> {
  const filename = audio.filename ?? filenameForMime(audio.data.type);
  const mimeType = audio.data.type || mimeForFilename(filename);
  const fingerprint = await legacyAudioFingerprint(audio.data);
  const base: AudioMetadata = {
    sizeBytes: audio.data.size,
    mimeType,
    filename,
    ...(fingerprint ? { fingerprint } : {}),
    ...(audio.durationMs !== undefined ? { durationMs: audio.durationMs } : {}),
  };
  if (!isWav(mimeType, filename) || audio.data.size < 44) return base;

  try {
    const header = new DataView(await audio.data.slice(0, Math.min(audio.data.size, 65_536)).arrayBuffer());
    const wav = readWavMetadata(header);
    return { ...base, ...wav, ...(base.durationMs !== undefined ? { durationMs: base.durationMs } : {}) };
  } catch {
    return base;
  }
}

/** Legacy bounded identity used by inspectAudio and 0.3.x manifest migration. */
export async function legacyAudioFingerprint(blob: Blob): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined;
  const sampleSize = 65_536;
  const head = new Uint8Array(await blob.slice(0, sampleSize).arrayBuffer());
  const tailStart = Math.max(head.length, blob.size - sampleSize);
  const tail = new Uint8Array(await blob.slice(tailStart).arrayBuffer());
  const payload = new Uint8Array(8 + head.length + tail.length);
  new DataView(payload.buffer).setBigUint64(0, BigInt(blob.size), true);
  payload.set(head, 8);
  payload.set(tail, 8 + head.length);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", payload));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Full content identity for durable long-job resume checks. Kept off the short dictation path. */
export async function fullAudioFingerprint(blob: Blob): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined;
  // Web Crypto is substantially faster for ordinary files. The incremental path keeps
  // large recordings bounded without penalizing the latency-sensitive short path.
  if (blob.size <= 4 * 1024 * 1024) {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
    return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  const digest = new IncrementalSha256();
  const chunkBytes = 4 * 1024 * 1024;
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    digest.update(new Uint8Array(await blob.slice(offset, offset + chunkBytes).arrayBuffer()));
  }
  return `sha256:${digest.digestHex()}`;
}

export function assertDirectUploadSize(metadata: AudioMetadata, maximumBytes: number): void {
  if (metadata.sizeBytes <= maximumBytes) return;
  throw new DictationError(
    `Audio is ${formatBytes(metadata.sizeBytes)}, above the safe direct-upload limit of ${formatBytes(maximumBytes)}. Use dictateLong() or createJob().`,
    {
      code: "AUDIO_TOO_LARGE",
      details: { sizeBytes: metadata.sizeBytes, maximumBytes, filename: metadata.filename },
    },
  );
}

export function isWav(mimeType: string, filename: string): boolean {
  return /(?:wav|wave)/i.test(mimeType) || /\.wav$/i.test(filename);
}

function readWavMetadata(view: DataView): Partial<AudioMetadata> {
  if (ascii(view, 0, 4) !== "RIFF" || ascii(view, 8, 4) !== "WAVE") return {};
  let offset = 12;
  let sampleRate: number | undefined;
  let channels: number | undefined;
  let byteRate: number | undefined;
  let dataBytes: number | undefined;
  while (offset + 8 <= view.byteLength) {
    const id = ascii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (id === "fmt " && start + 16 <= view.byteLength) {
      channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
      byteRate = view.getUint32(start + 8, true);
    } else if (id === "data") {
      dataBytes = size;
      break;
    }
    offset = start + size + (size % 2);
  }
  return {
    ...(sampleRate !== undefined ? { sampleRate } : {}),
    ...(channels !== undefined ? { channels } : {}),
    ...(dataBytes !== undefined && byteRate ? { durationMs: (dataBytes / byteRate) * 1000 } : {}),
    codec: "pcm-wav",
  };
}

function ascii(view: DataView, offset: number, length: number): string {
  let result = "";
  for (let index = 0; index < length && offset + index < view.byteLength; index += 1) {
    result += String.fromCharCode(view.getUint8(offset + index));
  }
  return result;
}

function filenameForMime(mime: string): string {
  if (mime.includes("wav")) return "dictation.wav";
  if (mime.includes("ogg")) return "dictation.ogg";
  if (mime.includes("mp4") || mime.includes("m4a")) return "dictation.m4a";
  return "dictation.webm";
}

function mimeForFilename(filename: string): string {
  if (/\.wav$/i.test(filename)) return "audio/wav";
  if (/\.ogg$/i.test(filename)) return "audio/ogg";
  if (/\.(?:m4a|mp4)$/i.test(filename)) return "audio/mp4";
  return "audio/webm";
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
