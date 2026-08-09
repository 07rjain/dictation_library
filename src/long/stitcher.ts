import type { LongChunkResult } from "./types.js";

export function stitchChunks(chunks: readonly LongChunkResult[]): string {
  const ordered = [...chunks].sort((left, right) => left.index - right.index);
  let text = "";
  for (const chunk of ordered) {
    const timestampOwned = timestampOwnedText(chunk);
    const candidate = timestampOwned || chunk.text.trim();
    if (!candidate) continue;
    text = text ? mergeOverlap(text, candidate, chunk.overlapBeforeMs > 0) : candidate;
  }
  return normalizeSpacing(text);
}

function timestampOwnedText(chunk: LongChunkResult): string {
  if (chunk.segments.length === 0) return "";
  const ownershipBoundarySeconds = chunk.overlapBeforeMs / 2000;
  return chunk.segments
    .filter((segment) => {
      if (chunk.index === 0) return true;
      const start = segment.start ?? 0;
      const end = segment.end ?? start;
      return (start + end) / 2 >= ownershipBoundarySeconds;
    })
    .map((segment) => segment.text?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
}

function mergeOverlap(previous: string, current: string, hasTemporalOverlap: boolean): string {
  if (!hasTemporalOverlap) return `${previous} ${current}`;
  const left = tokenize(previous);
  const right = tokenize(current);
  const maximum = Math.min(80, left.length, right.length);
  let overlap = 0;
  for (let count = 1; count <= maximum; count += 1) {
    const suffix = left.slice(-count).map(normalizeToken);
    const prefix = right.slice(0, count).map(normalizeToken);
    if (suffix.every((token, index) => token === prefix[index])) overlap = count;
  }
  return `${previous} ${right.slice(overlap).join(" ")}`;
}

function tokenize(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function normalizeToken(token: string): string {
  return token.toLocaleLowerCase().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
}

function normalizeSpacing(text: string): string {
  return text.replace(/\s+([,.;:!?])/g, "$1").replace(/\s+/g, " ").trim();
}
