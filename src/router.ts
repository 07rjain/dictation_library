import { DEFAULT_DIRECT_UPLOAD_MAX_BYTES } from "./defaults.js";
import { inspectAudio } from "./audio.js";
import type { AudioInput, AudioMetadata } from "./types.js";

export type AudioRouteKind = "direct" | "stored-url" | "chunked" | "batch";

export interface AudioRoutingOptions {
  forceLong?: boolean;
  background?: boolean;
  storageAvailable?: boolean;
  directMaxBytes?: number;
  /** Direct-route duration gate. Defaults to 90 seconds when duration is known. */
  directMaxDurationMs?: number;
  /** Conservative URL ceiling when known. Defaults to 22 MiB free / 90 MiB developer. */
  accountTier?: "free" | "developer";
  /** Explicitly expose advisory stored-url/Batch decisions that dictateAuto cannot execute. */
  allowManualRoutes?: boolean;
  /** Reuse authoritative metadata already obtained from an application audio processor. */
  sourceMetadata?: AudioMetadata;
}

export interface AudioRouteDecision {
  kind: AudioRouteKind;
  reason: string;
  metadata: AudioMetadata;
}

/** Pure policy entry point used by applications that want to show or log the selected route. */
export async function routeAudio(
  audio: AudioInput,
  options: AudioRoutingOptions = {},
): Promise<AudioRouteDecision> {
  const metadata = options.sourceMetadata ?? await inspectAudio(audio);
  const directLimit = options.directMaxBytes ?? DEFAULT_DIRECT_UPLOAD_MAX_BYTES;
  const directDurationLimit = options.directMaxDurationMs ?? 90_000;
  const urlLimit = (options.accountTier ?? "free") === "developer" ? 90 * 1024 * 1024 : 22 * 1024 * 1024;
  if (options.allowManualRoutes && options.background && options.storageAvailable) {
    return { kind: "batch", reason: "background processing requested with URL-capable storage", metadata };
  }
  const durationFits = metadata.durationMs === undefined || metadata.durationMs <= directDurationLimit;
  if (!options.forceLong && metadata.sizeBytes <= directLimit && durationFits) {
    return { kind: "direct", reason: "audio is below the conservative multipart threshold", metadata };
  }
  if (options.allowManualRoutes && options.storageAvailable && metadata.sizeBytes <= urlLimit) {
    return { kind: "stored-url", reason: "audio exceeds direct multipart policy but fits the conservative URL route", metadata };
  }
  return { kind: "chunked", reason: "audio requires bounded codec-aware chunks", metadata };
}
