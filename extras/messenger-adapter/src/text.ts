import { createHmac, timingSafeEqual } from "node:crypto";

/** Messenger Send API text limit per message. */
export const MESSENGER_MAX_MESSAGE_CHARS = 2_000;

/**
 * Verify Meta's `X-Hub-Signature-256` header: `sha256=<hex HMAC-SHA256 of the
 * raw body keyed by the app secret>`. Constant-time on the digest comparison.
 */
export function verifyMessengerSignature(
  body: Uint8Array,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (body.byteLength === 0 || signatureHeader === undefined || appSecret.length === 0) {
    return false;
  }
  const header = signatureHeader.trim();
  if (!header.startsWith("sha256=")) {
    return false;
  }
  const provided = header.slice("sha256=".length).toLowerCase();
  const expected = createHmac("sha256", appSecret).update(body).digest("hex");
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));
}

const CODE_BLOCK = /```[A-Za-z0-9_-]*\n?([\s\S]*?)```/gu;
const INLINE_CODE = /`([^`\n]+)`/gu;
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/gu;
const BOLD_STAR = /\*\*([^*]+)\*\*/gu;
const BOLD_UNDERSCORE = /__([^_]+)__/gu;
const ITALIC_STAR = /(?<![\w*])\*([^*\n]+)\*(?![\w*])/gu;
const ITALIC_UNDERSCORE = /(?<![\w_])_([^_\n]+)_(?![\w_])/gu;
const HEADING = /^#{1,6}\s+/gmu;
const BULLET = /^(\s*)[-*+]\s+/gmu;

/** Messenger renders plain text only; flatten common Markdown to readable text. */
export function stripMarkdownForMessenger(text: string): string {
  if (text.length === 0) {
    return "";
  }
  return text
    .replace(CODE_BLOCK, (_match, code: string) => code.replace(/\n+$/u, ""))
    .replace(INLINE_CODE, "$1")
    .replace(LINK, "$1 ($2)")
    .replace(BOLD_STAR, "$1")
    .replace(BOLD_UNDERSCORE, "$1")
    .replace(ITALIC_STAR, "$1")
    .replace(ITALIC_UNDERSCORE, "$1")
    .replace(HEADING, "")
    .replace(BULLET, "$1• ");
}

/**
 * Split text into Send API chunks of at most `maxChars` code points, preferring
 * paragraph, line, then word boundaries; a boundary earlier than 65% of the
 * window falls back to a hard cut so one long token cannot stall splitting.
 */
export function splitForMessenger(text: string, maxChars: number = MESSENGER_MAX_MESSAGE_CHARS): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 32) {
    throw new RangeError("maxChars must be an integer of at least 32.");
  }
  const points = Array.from(text);
  if (points.length <= maxChars) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = points;
  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining.join(""));
      break;
    }
    const window = remaining.slice(0, maxChars);
    let splitAt = Math.max(
      lastIndexOfSequence(window, ["\n", "\n"]),
      window.lastIndexOf("\n"),
      window.lastIndexOf(" "),
    );
    if (splitAt < Math.floor(maxChars * 0.65)) {
      splitAt = maxChars;
    }
    const chunk = remaining.slice(0, splitAt).join("").replace(/\s+$/u, "");
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    remaining = trimLeadingWhitespace(remaining.slice(splitAt));
  }
  return chunks.length === 0 ? [""] : chunks;
}

function lastIndexOfSequence(points: readonly string[], sequence: readonly string[]): number {
  for (let index = points.length - sequence.length; index >= 0; index -= 1) {
    let matches = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (points[index + offset] !== sequence[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return index;
    }
  }
  return -1;
}

function trimLeadingWhitespace(points: readonly string[]): string[] {
  let start = 0;
  while (start < points.length && /^\s$/u.test(points[start] ?? "")) {
    start += 1;
  }
  return points.slice(start);
}
