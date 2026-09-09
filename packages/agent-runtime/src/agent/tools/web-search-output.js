// @ts-check

export const WEB_SEARCH_TITLE_MAX_CHARS = 500;
export const WEB_SEARCH_SNIPPET_MAX_CHARS = 4_000;
export const WEB_SEARCH_BODY_MAX_BYTES = 64 * 1024;
export const WEB_SEARCH_SNIPPET_TRUNCATION_MARKER = "[snippet truncated; use WebFetch for full source]";

const RESULT_OMISSION_MARKER = "[additional search results omitted by WebSearch output bound]";

/** @param {unknown} value */
function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

/** @param {string} value @param {number} maxChars */
function sliceCodePoints(value, maxChars) {
  return [...value].slice(0, Math.max(0, maxChars)).join("");
}

/** @param {string} value @param {number} maxBytes */
export function sliceUtf8(value, maxBytes) {
  const budget = Math.max(0, Math.floor(maxBytes));
  if (Buffer.byteLength(value, "utf8") <= budget) return value;
  let used = 0;
  let out = "";
  for (const point of value) {
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
  const prefix = sliceCodePoints(text, prefixChars).trimEnd();
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
    text: `${sliceCodePoints(text, WEB_SEARCH_TITLE_MAX_CHARS - 1).trimEnd()}…`,
    truncated: true,
  };
}

/** @param {unknown} value */
function escapeMarkdownLabel(value) {
  return collapseWhitespace(value).replace(/[[\]\\]/gu, "\\$&");
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
 * @param {Array<{title?: unknown, url?: unknown, snippet?: unknown, snippetTruncated?: boolean}>} results
 * @param {{maxBytes?: number}} [options]
 */
export function renderBoundedWebSearchBody(results, { maxBytes = WEB_SEARCH_BODY_MAX_BYTES } = {}) {
  const normalized = results.map((result, index) => {
    const url = String(result?.url || "");
    const title = boundTitle(result?.title || url);
    const snippet = boundWebSearchSnippet(result?.snippet);
    const snippetTruncated = result?.snippetTruncated === true || snippet.truncated;
    const text = snippetTruncated && !snippet.text.endsWith(WEB_SEARCH_SNIPPET_TRUNCATION_MARKER)
      ? boundWebSearchSnippet(`${snippet.text} ${WEB_SEARCH_SNIPPET_TRUNCATION_MARKER}`).text
      : snippet.text;
    return {
      core: `${index + 1}. [${escapeMarkdownLabel(title.text || url)}](${url})`,
      snippet: text,
      truncated: title.truncated || snippetTruncated,
    };
  });

  if (normalized.length === 0) {
    return { body: "No results.", renderedResultCount: 0, truncated: false };
  }

  let selected = normalized.slice();
  let omittedResults = 0;
  const omissionBody = () => omittedResults > 0
    ? `${RESULT_OMISSION_MARKER} (${omittedResults})`
    : "";
  const minimumSnippet = (entry) => entry.snippet
    ? `\n   ${WEB_SEARCH_SNIPPET_TRUNCATION_MARKER}`
    : "";
  const minimumBody = () => [
    ...selected.map((entry) => `${entry.core}${minimumSnippet(entry)}`),
    ...(omittedResults > 0 ? [omissionBody()] : []),
  ].join("\n\n");

  while (selected.length > 0 && Buffer.byteLength(minimumBody(), "utf8") > maxBytes) {
    selected.pop();
    omittedResults += 1;
  }
  if (selected.length === 0) {
    return {
      body: sliceUtf8(omissionBody() || RESULT_OMISSION_MARKER, maxBytes),
      renderedResultCount: 0,
      truncated: true,
    };
  }

  const minimum = minimumBody();
  let remaining = Math.max(0, maxBytes - Buffer.byteLength(minimum, "utf8"));
  let truncated = omittedResults > 0 || selected.some((entry) => entry.truncated);
  const rendered = [];
  for (const entry of selected) {
    if (!entry.snippet) {
      rendered.push(entry.core);
      continue;
    }
    const prefix = "\n   ";
    const minimumTextBytes = Buffer.byteLength(WEB_SEARCH_SNIPPET_TRUNCATION_MARKER, "utf8");
    const desiredBytes = Buffer.byteLength(entry.snippet, "utf8");
    const extraNeeded = Math.max(0, desiredBytes - minimumTextBytes);
    const granted = Math.min(remaining, extraNeeded);
    remaining -= granted;
    const snippetBudget = minimumTextBytes + granted;
    const snippet = truncateSnippetToBytes(entry.snippet, snippetBudget);
    if (snippet !== entry.snippet) truncated = true;
    rendered.push(`${entry.core}${prefix}${snippet}`);
  }
  if (omittedResults > 0) rendered.push(omissionBody());
  const body = rendered.join("\n\n");
  return {
    body,
    renderedResultCount: selected.length,
    truncated,
  };
}
