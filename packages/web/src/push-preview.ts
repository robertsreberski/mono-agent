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

  // Decode first because entities can introduce bidi/control characters, then
  // delete invisible format and control separators before any redaction pass.
  // Redacting first could consume only the visible prefix of one credential
  // and strand its suffix after the separator is removed.
  text = decodeEntities(text)
    .replace(/\b(basic|bearer|token)[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Default_Ignorable_Code_Point}]+(?=[a-z\d._~+\/-])/giu, "$1 ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "");

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

  text = redactSecrets(text);
  text = text
    .replace(/\s+/gu, " ")
    .trim();
  // Keep this second pass: whitespace/Markdown normalization can reveal a
  // credential shape that was not contiguous in the source text.
  text = redactSecrets(text);

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
  let text = value
    // URL userinfo and sensitive query values. Keep the surrounding URL useful.
    .replace(/(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/giu, "$1[redacted]@")
    .replace(/([?&](?:access_token|api[_-]?key|auth|key|password|secret|signature|token)=)[^&#\s]*/giu, "$1[redacted]")
    // Authorization headers and common command-line/config assignments.
    .replace(/\b(authorization\s*:\s*)(?:basic|bearer|token)\s+[^\s,;]+/giu, "$1[redacted]")
    .replace(/\b(basic|bearer|token)\s+[a-z\d._~+\/-]{8,}={0,2}\b/giu, "$1 [redacted]");
  text = redactCredentialAssignments(text);
  // Well-known token families that are dangerous even without a label.
  return text.replace(/\b(?:gh[opusr]_[a-z\d]{20,}|sk-[a-z\d_-]{20,}|xox[baprs]-[a-z\d-]{20,})\b/giu, "[redacted]");
}

function redactCredentialAssignments(value: string): string {
  return redactValuesAfterPrefixes(
    value,
    /(^|[\s,.;:{}()[\]])(?:(['"])(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\2[ \t]*[:=][ \t]*|--(?:api[_-]?key|token|password|secret)(?:=|[ \t]+)|(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)[ \t]*[:=][ \t]*)/gimu,
  );
}

function redactValuesAfterPrefixes(value: string, pattern: RegExp): string {
  let cursor = 0;
  let output = "";
  const anchoredPattern = new RegExp(pattern.source, pattern.flags.replace("g", "y"));
  pattern.lastIndex = 0;
  for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
    if (match.index < cursor) continue;
    const valueStart = match.index + match[0].length;
    if (value.startsWith("[redacted]", valueStart)) continue;
    const scanned = scanCredentialValue(value, valueStart, anchoredPattern);
    if (scanned.end === valueStart) continue;
    output += value.slice(cursor, valueStart);
    output += scanned.quote === undefined ? "[redacted]" : `${scanned.quote}[redacted]${scanned.quote}`;
    cursor = scanned.end;
    pattern.lastIndex = scanned.end;
  }
  return cursor === 0 ? value : output + value.slice(cursor);
}

function scanCredentialValue(
  value: string,
  start: number,
  credentialPrefix: RegExp,
): { readonly end: number; readonly quote?: "\"" | "'" } {
  let cursor = start;
  let segmentCount = 0;
  let soleClosedQuote: "\"" | "'" | undefined;
  while (cursor < value.length) {
    const character = value[cursor]!;
    if (/\s/u.test(character) || /[,;}\])]/u.test(character)) break;
    segmentCount += 1;
    if (character !== "\"" && character !== "'") {
      soleClosedQuote = undefined;
      while (cursor < value.length) {
        const unquoted = value[cursor]!;
        if (/\s/u.test(unquoted) || /[,;]/u.test(unquoted) || unquoted === "\"" || unquoted === "'") break;
        if (/[.:{}()[\]]/u.test(unquoted)) {
          credentialPrefix.lastIndex = cursor;
          if (credentialPrefix.exec(value) !== null) return { end: cursor };
        }
        cursor += unquoted === "\\" ? Math.min(2, value.length - cursor) : 1;
      }
      continue;
    }
    const quote = character;
    cursor += 1;
    let closed = false;
    while (cursor < value.length) {
      const quoted = value[cursor]!;
      if (quoted === "\\") {
        cursor += Math.min(2, value.length - cursor);
        continue;
      }
      if (quoted === quote) {
        cursor += 1;
        closed = true;
        break;
      }
      cursor += 1;
    }
    if (!closed) return { end: cursor };
    soleClosedQuote = segmentCount === 1 ? quote : undefined;
  }
  return soleClosedQuote === undefined
    ? { end: cursor }
    : { end: cursor, quote: soleClosedQuote };
}
