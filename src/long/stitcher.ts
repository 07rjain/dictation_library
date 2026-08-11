import type { TranscriptionSegment } from "../types.js";
import type { LongChunkResult, StitchDecision } from "./types.js";

export function stitchChunks(chunks: readonly LongChunkResult[]): string {
  return stitchChunksDetailed(chunks).text;
}

export function stitchChunksDetailed(
  chunks: readonly LongChunkResult[],
): { text: string; decisions: readonly StitchDecision[] } {
  const ordered = [...chunks].sort((left, right) => left.index - right.index);
  const timestamped = ordered.map((chunk) => validSegments(chunk.segments));
  const ownershipStarts = ordered.map(() => Number.NEGATIVE_INFINITY);
  const ownershipEnds = ordered.map(() => Number.POSITIVE_INFINITY);
  const boundaryProof = ordered.map(() => false);
  const decisions: StitchDecision[] = [];

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (current.overlapBeforeMs <= 0) continue;
    const proven = timestamped[index - 1] !== undefined && timestamped[index] !== undefined;
    boundaryProof[index] = proven;
    if (!proven) {
      decisions.push({
        boundaryIndex: current.index,
        confidence: "low",
        method: "preserved-uncertain",
        deduplicatedSegments: 0,
        alternatives: [boundaryTail(previous.text), boundaryHead(current.text)],
      });
      continue;
    }
    const boundarySeconds = current.startMs / 1_000 + current.overlapBeforeMs / 2_000;
    ownershipEnds[index - 1] = Math.min(ownershipEnds[index - 1]!, boundarySeconds);
    ownershipStarts[index] = Math.max(ownershipStarts[index]!, boundarySeconds);
    const removedFromPrevious = timestamped[index - 1]!.filter((segment) => midpoint(segment) >= boundarySeconds).length;
    const removedFromCurrent = timestamped[index]!.filter((segment) => midpoint(segment) < boundarySeconds).length;
    decisions.push({
      boundaryIndex: current.index,
      confidence: "high",
      method: "timestamp-ownership",
      deduplicatedSegments: removedFromPrevious + removedFromCurrent,
    });
  }

  const text = ordered.map((chunk, index) => {
    const segments = timestamped[index];
    const usesOwnership = boundaryProof[index] || boundaryProof[index + 1];
    if (!usesOwnership || segments === undefined) return chunk.text.trim();
    // An empty owned region is meaningful: never restore the unfiltered overlapping chunk text.
    return segments.filter((segment) => {
      const center = midpoint(segment);
      return center >= ownershipStarts[index]! && center < ownershipEnds[index]!;
    }).map((segment) => segment.text?.trim() ?? "").filter(Boolean).join(" ");
  }).filter(Boolean).join(" ");

  return { text: normalizeSpacing(text), decisions };
}

function validSegments(
  segments: readonly TranscriptionSegment[],
): readonly (TranscriptionSegment & { start: number; end: number })[] | undefined {
  if (segments.length === 0 || segments.some((segment) =>
    !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.end! < segment.start!
  )) return undefined;
  return segments as readonly (TranscriptionSegment & { start: number; end: number })[];
}

function midpoint(segment: { start: number; end: number }): number {
  return (segment.start + segment.end) / 2;
}

function boundaryTail(text: string): string {
  return text.trim().split(/\s+/).slice(-24).join(" ");
}

function boundaryHead(text: string): string {
  return text.trim().split(/\s+/).slice(0, 24).join(" ");
}

function normalizeSpacing(text: string): string {
  return text.replace(/\s+([,.;:!?])/g, "$1").replace(/\s+/g, " ").trim();
}
