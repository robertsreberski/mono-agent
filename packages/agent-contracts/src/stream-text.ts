/**
 * Code-point-safe text helpers shared by chat-style communication adapters,
 * which had each copied the same chunker, tail preview, and trailing
 * normalizer. Pure and transport-agnostic.
 */

/** Default per-message character budget for chat transports. */
export const DEFAULT_MAX_MESSAGE_CHARS = 3_800;

/** Default placeholder used when a finished response has no text. */
export const DEFAULT_EMPTY_FINAL_TEXT = "No response text was returned.";

/** Trim trailing whitespace, falling back to a placeholder when empty. */
export function normalizeTrailing(text: string, fallback: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Split text into chunks of at most `maxChars` Unicode code points, so
 * multi-byte characters are never cut in half.
 */
export function splitTextByCodePoints(text: string, maxChars: number): string[] {
  assertPositiveBudget(maxChars);
  const characters = Array.from(text);
  if (characters.length <= maxChars) {
    return [text];
  }
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += maxChars) {
    chunks.push(characters.slice(index, index + maxChars).join(""));
  }
  return chunks;
}

/**
 * How much of a window's tail is searched for a natural break. A boundary in the
 * first half would leave a chunk so short that the blind cut reads better, and
 * the remainder would usually need cutting anyway.
 */
const BREAK_SEARCH_FRACTION = 0.5;

/**
 * Split text into chunks of at most `maxChars` code points, cutting at a
 * paragraph, line, or word boundary when one is available near the end of the
 * window and falling back to a blind cut when none is.
 *
 * This is what a chat transport should use for a finished answer:
 * {@link splitTextByCodePoints} cuts mid-sentence, and leaving the text
 * unchunked hands the boundary to the channel — Slack silently breaks a long
 * `chat.postMessage` into several messages of its own choosing and returns only
 * the last fragment's id.
 *
 * Whitespace AT a chosen boundary is consumed, so a chunk never begins with the
 * newline it was split on. Every other character survives, in order, and the
 * indentation of the line after a break is preserved.
 */
export function splitTextForChat(text: string, maxChars: number): string[] {
  assertPositiveBudget(maxChars);
  const characters = Array.from(text);
  if (characters.length <= maxChars) {
    return [text];
  }
  const minChunk = Math.max(1, Math.floor(maxChars * BREAK_SEARCH_FRACTION));
  const chunks: string[] = [];
  let start = 0;
  while (start < characters.length) {
    if (characters.length - start <= maxChars) {
      pushChunk(chunks, characters.slice(start).join(""));
      break;
    }
    const windowEnd = start + maxChars;
    const breakAt = findBreakIndex(characters, start + minChunk, windowEnd);
    if (breakAt < 0) {
      chunks.push(characters.slice(start, windowEnd).join(""));
      start = windowEnd;
      continue;
    }
    pushChunk(chunks, characters.slice(start, contentEndBefore(characters, breakAt, start)).join(""));
    start = skipBoundaryWhitespace(characters, breakAt);
  }
  // Only reachable for input that is entirely whitespace, which `pushChunk`
  // refuses to emit. Returning it whole beats returning nothing at all.
  return chunks.length > 0 ? chunks : [text];
}

/** Drop a chunk with no visible content rather than posting an empty message. */
function pushChunk(chunks: string[], chunk: string): void {
  if (chunk.trim().length > 0) {
    chunks.push(chunk);
  }
}

/**
 * Index of the separator to cut at, searching backwards through
 * `[minEnd, windowEnd)` for the latest paragraph break, then the latest line
 * break, then the latest space. `-1` when the window holds none of them.
 */
function findBreakIndex(characters: readonly string[], minEnd: number, windowEnd: number): number {
  for (let index = windowEnd - 1; index >= minEnd; index -= 1) {
    if (isNewline(characters[index]) && index > 0 && isNewline(characters[index - 1])) {
      return index;
    }
  }
  for (let index = windowEnd - 1; index >= minEnd; index -= 1) {
    if (isNewline(characters[index])) {
      return index;
    }
  }
  for (let index = windowEnd - 1; index >= minEnd; index -= 1) {
    if (characters[index] === " " || characters[index] === "\t") {
      return index;
    }
  }
  return -1;
}

/**
 * Where the chunk's content ends: the cut rewound past the whole whitespace run
 * it landed in, so a chunk never trails the blank line it was split on. Dropping
 * trailing whitespace is free — every transport trims it before posting.
 */
function contentEndBefore(characters: readonly string[], breakAt: number, start: number): number {
  let index = breakAt;
  while (index > start && isWhitespace(characters[index - 1])) {
    index -= 1;
  }
  return index;
}

/**
 * Advance past the separator run the cut landed in. A newline break consumes
 * only newlines, so the next chunk keeps the indentation of the line it starts;
 * a space break consumes only spaces and tabs.
 */
function skipBoundaryWhitespace(characters: readonly string[], breakAt: number): number {
  const consumesNewlines = isNewline(characters[breakAt]);
  let index = breakAt;
  while (index < characters.length) {
    const character = characters[index];
    const skippable = consumesNewlines
      ? isNewline(character)
      : character === " " || character === "\t";
    if (!skippable) {
      break;
    }
    index += 1;
  }
  return index;
}

function isNewline(character: string | undefined): boolean {
  return character === "\n" || character === "\r";
}

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && character.trim().length === 0;
}

function assertPositiveBudget(maxChars: number): void {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new RangeError("maxChars must be a positive integer.");
  }
}

/**
 * Build a bounded "tail" preview for streaming edits: when text exceeds
 * `maxChars`, show a `prefix` marker followed by the most recent code points.
 */
export function buildStreamingTailPreview(
  text: string,
  maxChars: number,
  prefix = "...\n",
): string {
  const characters = Array.from(text);
  if (characters.length <= maxChars) {
    return text;
  }
  const available = Math.max(1, maxChars - Array.from(prefix).length);
  return `${prefix}${characters.slice(-available).join("")}`;
}
