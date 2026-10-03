// @ts-check

export const WEB_SEARCH_TITLE_MAX_CHARS = 500;
export const WEB_SEARCH_SNIPPET_MAX_CHARS = 4_000;
// Bounds the structured result entries JSON (UTF-8 bytes of JSON.stringify(entries)).
// Envelope framing (summary, coverage, next actions) stays outside this allocation.
export const WEB_SEARCH_BODY_MAX_BYTES = 64 * 1024;
export const WEB_SEARCH_SNIPPET_TRUNCATION_MARKER = "[snippet truncated; use WebFetch for full source]";

/** @param {unknown} value */
function collapseWhitespace(value) {
  return toWellFormedText(value).replace(/\s+/gu, " ").trim();
}

/** Replace isolated UTF-16 surrogates while preserving valid astral pairs. @param {unknown} value */
export function toWellFormedText(value) {
  let out = "";
  for (const point of String(value || "")) {
    const unit = point.charCodeAt(0);
    out += point.length === 1 && unit >= 0xd800 && unit <= 0xdfff ? "\uFFFD" : point;
  }
  return out;
}

/** @param {unknown} value @param {number} maxChars */
export function sliceWellFormedCodePoints(value, maxChars) {
  return [...toWellFormedText(value)].slice(0, Math.max(0, maxChars)).join("");
}

/** @param {string} value @param {number} maxBytes */
export function sliceUtf8(value, maxBytes) {
  const budget = Math.max(0, Math.floor(maxBytes));
  const text = toWellFormedText(value);
  if (Buffer.byteLength(text, "utf8") <= budget) return text;
  let used = 0;
  let out = "";
  for (const point of text) {
    const bytes = Buffer.byteLength(point, "utf8");
    if (used + bytes > budget) break;
    out += point;
    used += bytes;
  }
  return out;
}

/** @param {unknown} value @param {number} [maxChars] */
export function boundWebSearchSnippet(value, maxChars = WEB_SEARCH_SNIPPET_MAX_CHARS) {
  const text = collapseWhitespace(value);
  if ([...text].length <= maxChars) return { text, truncated: false };
  const markerChars = [...WEB_SEARCH_SNIPPET_TRUNCATION_MARKER].length;
  const prefixChars = Math.max(0, maxChars - markerChars - 1);
  const prefix = sliceWellFormedCodePoints(text, prefixChars).trimEnd();
  return {
    text: `${prefix}${prefix ? " " : ""}${WEB_SEARCH_SNIPPET_TRUNCATION_MARKER}`,
    truncated: true,
  };
}

/** @param {unknown} value */
function boundTitle(value) {
  const text = collapseWhitespace(value);
  if ([...text].length <= WEB_SEARCH_TITLE_MAX_CHARS) return { text, truncated: false };
  return {
    text: `${sliceWellFormedCodePoints(text, WEB_SEARCH_TITLE_MAX_CHARS - 1).trimEnd()}…`,
    truncated: true,
  };
}

/**
 * @param {string} value
 * @param {number} maxBytes
 */
function truncateSnippetToBytes(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(WEB_SEARCH_SNIPPET_TRUNCATION_MARKER, "utf8");
  if (maxBytes <= markerBytes) return sliceUtf8(WEB_SEARCH_SNIPPET_TRUNCATION_MARKER, maxBytes);
  const source = value.endsWith(WEB_SEARCH_SNIPPET_TRUNCATION_MARKER)
    ? value.slice(0, -WEB_SEARCH_SNIPPET_TRUNCATION_MARKER.length).trimEnd()
    : value;
  const prefix = sliceUtf8(source, Math.max(0, maxBytes - markerBytes - 1)).trimEnd();
  return `${prefix}${prefix ? " " : ""}${WEB_SEARCH_SNIPPET_TRUNCATION_MARKER}`;
}

/**
 * Bound ranked results directly by the UTF-8 bytes of their structured JSON.
 * Titles stay capped at 500 characters, snippets at 4,000 characters, URLs are
 * never truncated, and result order is preserved: lower-ranked snippets shrink
 * first, then whole trailing results are omitted. JSON measurement includes
 * escaping and multibyte expansion, so quoted, backslashed, and astral content
 * is budgeted truthfully.
 *
 * @param {Array<{title?: unknown, url?: unknown, snippet?: unknown, snippetTruncated?: boolean, publishDate?: string}>} results
 * @param {{maxBytes?: number}} [options]
 */
export function boundWebSearchEntries(results, { maxBytes = WEB_SEARCH_BODY_MAX_BYTES } = {}) {
  const budget = Math.max(0, Math.floor(maxBytes));
  const markerBytes = Buffer.byteLength(WEB_SEARCH_SNIPPET_TRUNCATION_MARKER, "utf8");
  const normalized = results.map((result) => {
    const url = String(result?.url || "");
    const title = boundTitle(result?.title || url);
    const snippet = boundWebSearchSnippet(result?.snippet);
    const snippetTruncated = result?.snippetTruncated === true || snippet.truncated;
    const text = snippetTruncated && !snippet.text.endsWith(WEB_SEARCH_SNIPPET_TRUNCATION_MARKER)
      ? boundWebSearchSnippet(`${snippet.text} ${WEB_SEARCH_SNIPPET_TRUNCATION_MARKER}`).text
      : snippet.text;
    const published = /^\d{4}-\d{2}-\d{2}$/u.test(result?.publishDate) ? result.publishDate : undefined;
    return {
      truncated: title.truncated || snippetTruncated,
      title: title.text || url,
      url,
      ...(published === undefined ? {} : { published }),
      snippet: text,
    };
  });

  if (normalized.length === 0) {
    return { entries: [], resultCount: 0, truncated: false, omittedCount: 0 };
  }

  /** @param {{title: string, url: string, published?: string, snippet: string}} entry @param {string} snippet */
  const toOutput = (entry, snippet) => ({
    title: entry.title,
    url: entry.url,
    ...(entry.published === undefined ? {} : { published: entry.published }),
    snippet,
  });
  const minimalSnippet = (snippet) => !snippet
    ? ""
    : truncateSnippetToBytes(snippet, markerBytes);

  // Omit whole trailing results (never slice a URL) while even the minimal
  // snippet-per-entry JSON exceeds the budget.
  let normalizedSelected = normalized.slice();
  let omittedCount = 0;
  while (normalizedSelected.length > 0) {
    const minimal = normalizedSelected.map((entry) => minimalSnippet(entry.snippet));
    const size = Buffer.byteLength(JSON.stringify(
      normalizedSelected.map((entry, index) => toOutput(entry, minimal[index])),
    ), "utf8");
    if (size <= budget) break;
    normalizedSelected.pop();
    omittedCount += 1;
  }
  if (normalizedSelected.length === 0) {
    return {
      entries: [],
      resultCount: 0,
      truncated: true,
      omittedCount: normalized.length,
    };
  }

  // Expand snippets in rank order, always reserving the minimal JSON for the
  // entries that have not been expanded yet. Measurement uses the encoded JSON
  // so escapes and multibyte sequences count toward the bound; only snippets
  // shrink, URLs and titles keep their character-bound values intact.
  const finalSnippets = normalizedSelected.map((entry) => minimalSnippet(entry.snippet));
  const measuredBytes = (snippets) => Buffer.byteLength(JSON.stringify(
    normalizedSelected.map((entry, trialIndex) => toOutput(entry, snippets[trialIndex])),
  ), "utf8");
  let truncated = omittedCount > 0 || normalizedSelected.some((entry) => entry.truncated);
  for (let index = 0; index < normalizedSelected.length; index += 1) {
    const desired = normalizedSelected[index].snippet;
    if (!desired || finalSnippets[index] === desired) continue;
    const floor = minimalSnippet(desired);
    const floorBytes = Buffer.byteLength(floor, "utf8");
    const desiredBytes = Buffer.byteLength(desired, "utf8");
    const fullTrial = finalSnippets.slice();
    fullTrial[index] = desired;
    if (measuredBytes(fullTrial) <= budget) {
      finalSnippets[index] = desired;
      continue;
    }
    // Binary-search the largest raw snippet budget whose full serialized entry
    // still fits. The floor is the hard minimum: highly escapable content
    // (quotes/backslashes) can make JSON overflow far larger than the raw
    // deficit, so subtracting the overflow from raw bytes overshoots to empty.
    let best = floor;
    let low = floorBytes;
    let high = desiredBytes;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = truncateSnippetToBytes(desired, mid);
      const trial = finalSnippets.slice();
      trial[index] = candidate;
      if (measuredBytes(trial) <= budget) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    finalSnippets[index] = best;
    if (finalSnippets[index] !== desired) truncated = true;
  }

  const entries = normalizedSelected.map((entry, index) => toOutput(entry, finalSnippets[index]));
  return {
    entries,
    resultCount: normalizedSelected.length,
    truncated,
    omittedCount,
  };
}
