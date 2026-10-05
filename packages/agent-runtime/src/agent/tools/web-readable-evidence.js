// @ts-check
import { DOMParser } from "linkedom";
import { markdownToText } from "./web-markdown-text.js";

/**
 * Reject empty extraction, not short documents. Two letters/numbers are enough
 * (e.g. an HTML "OK" response); URL/title echoes are not document evidence.
 * Plain text/Markdown, JSON, XML and PDF retain their extraction contracts.
 * @param {{kind: string, text?: string, url?: string, title?: string}} input
 */
export function assertWebReadableEvidence({ kind, text, url, title }) {
  if (!["html", "rendered", "remote-markdown"].includes(kind)) return;
  let readable = normalizeEvidence(text);
  // A title plus a URL (in either order) is still only navigation metadata.
  // Remove whole echoes, not substrings of substantive words such as "hotels".
  for (const echo of [url, title]) {
    const normalized = normalizeEvidence(echo);
    if (!normalized) continue;
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    readable = readable.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu"), " ");
  }
  if ((readable.match(/[\p{L}\p{N}]/gu) || []).length < 2) {
    throw Object.assign(new Error("No readable document evidence was retrieved."), { code: "unusable_content" });
  }
}

function normalizeEvidence(value) {
  return decodeHtmlEntities(markdownToText(String(value || "")
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<[^>]*>/gu, " ")))
    // Turndown's setext heading underline is decoration, not title evidence.
    .replace(/^\s*(?:={2,}|-{2,})\s*$/gmu, "")
    .normalize("NFKC").replace(/\s+/gu, " ").trim().replace(/\/$/u, "").toLowerCase();
}

function decodeHtmlEntities(value) {
  if (!value.includes("&")) return value;
  // Escape literal markup so the existing HTML parser only decodes entities;
  // entity-decoded angle brackets remain text rather than being reparsed.
  const document = new DOMParser().parseFromString(`<html><body>${value.replaceAll("<", "&lt;")}</body></html>`, "text/html");
  return document.body.textContent || "";
}
