// @ts-check
import { markdownToText } from "./web-markdown-text.js";

/**
 * Reject empty extraction, not short documents. Two letters/numbers are enough
 * (e.g. an HTML "OK" response); URL/title echoes are not document evidence.
 * Plain text/Markdown, JSON, XML and PDF retain their extraction contracts.
 * @param {{kind: string, text?: string, url?: string, title?: string}} input
 */
export function assertWebReadableEvidence({ kind, text, url, title }) {
  if (!["html", "rendered", "remote-markdown"].includes(kind)) return;
  const readable = normalizeEvidence(text);
  if ((readable.match(/[\p{L}\p{N}]/gu) || []).length < 2
    || (url && readable === normalizeEvidence(url))
    || (title && readable === normalizeEvidence(title))) {
    throw Object.assign(new Error("No readable document evidence was retrieved."), { code: "unusable_content" });
  }
}

function normalizeEvidence(value) {
  return markdownToText(String(value || "")
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<[^>]*>/gu, " "))
    // Turndown's setext heading underline is decoration, not title evidence.
    .replace(/^\s*(?:={2,}|-{2,})\s*$/gmu, "")
    .normalize("NFKC").replace(/\s+/gu, " ").trim().replace(/\/$/u, "").toLowerCase();
}
