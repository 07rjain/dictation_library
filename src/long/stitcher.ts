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
  const ownershipBoundarySeconds = chunk.startMs / 1000 + chunk.overlapBeforeMs / 2000;
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
    if (suffix.every((token, index) => token === prefix[index])) {
      overlap = count;
      continue;
    }
    if (count >= 3 && fuzzySequenceSimilarity(suffix, prefix) >= 0.82) overlap = count;
  }
  return `${previous} ${right.slice(overlap).join(" ")}`;
}

function tokenize(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function normalizeToken(token: string): string {
  return token.toLocaleLowerCase().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
}

function fuzzySequenceSimilarity(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 1;
  const rows = left.length + 1;
  const columns = right.length + 1;
  const matrix = Array.from({ length: rows }, () => new Uint16Array(columns));
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      matrix[row]![column] = tokensSimilar(left[row - 1]!, right[column - 1]!)
        ? matrix[row - 1]![column - 1]! + 1
        : Math.max(matrix[row - 1]![column]!, matrix[row]![column - 1]!);
    }
  }
  return matrix[left.length]![right.length]! / Math.max(left.length, right.length);
}

function tokensSimilar(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1 || Math.min(left.length, right.length) < 5) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length]! <= 1;
}

function normalizeSpacing(text: string): string {
  return text.replace(/\s+([,.;:!?])/g, "$1").replace(/\s+/g, " ").trim();
}
