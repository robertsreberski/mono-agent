const MAX_SCAN_CODE_POINTS = 8_192;
export const WEB_PUSH_PREVIEW_CODE_POINTS = 180;

const ENTITY_VALUES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

/**
 * Produce the only text allowed to leave the console in a push payload.
 * The function is intentionally total: malformed Markdown/HTML is treated as
 * text, obvious secret shapes are removed, and the result is code-point bound.
 */
export function webPushPreview(value: unknown, fallback = "Update available."): string {
  const source = typeof value === "string" ? value : "";
  let text = [...source].slice(0, MAX_SCAN_CODE_POINTS).join("");

  text = text
    .replace(/```[^\n]*\n?/gu, " ")
    .replace(/~~~[^\n]*\n?/gu, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<https?:\/\/[^>]+>/giu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gmu, "")
    .replace(/(^|\s)[*_~]{1,3}([^\s][\s\S]*?)[*_~]{1,3}(?=\s|$|[.,!?;:])/gu, "$1$2")
    .replace(/`+/gu, "");

  text = decodeEntities(text);
  text = redactSecrets(text);
  text = text
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  const safe = text.length > 0 ? text : fallback;
  const points = [...safe];
  return points.length <= WEB_PUSH_PREVIEW_CODE_POINTS
    ? safe
    : `${points.slice(0, WEB_PUSH_PREVIEW_CODE_POINTS - 1).join("").trimEnd()}…`;
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]+));/giu, (match, decimal, hex, named) => {
    if (typeof named === "string") return ENTITY_VALUES[named.toLowerCase()] ?? match;
    const codePoint = Number.parseInt((decimal ?? hex) as string, decimal === undefined ? 16 : 10);
    if (!Number.isSafeInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return " ";
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return " ";
    }
  });
}

function redactSecrets(value: string): string {
  return value
    // URL userinfo and sensitive query values. Keep the surrounding URL useful.
    .replace(/(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/giu, "$1[redacted]@")
    .replace(/([?&](?:access_token|api[_-]?key|auth|key|password|secret|signature|token)=)[^&#\s]*/giu, "$1[redacted]")
    // Authorization headers and common command-line/config assignments.
    .replace(/\b(authorization\s*:\s*)(?:basic|bearer|token)\s+[^\s,;]+/giu, "$1[redacted]")
    .replace(/\b(basic|bearer|token)\s+[a-z\d._~+\/-]{8,}={0,2}\b/giu, "$1 [redacted]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
    .replace(/(--(?:api[_-]?key|token|password|secret)(?:=|\s+))[^\s]+/giu, "$1[redacted]")
    // Well-known token families that are dangerous even without a label.
    .replace(/\b(?:gh[opusr]_[a-z\d]{20,}|sk-[a-z\d_-]{20,}|xox[baprs]-[a-z\d-]{20,})\b/giu, "[redacted]");
}
