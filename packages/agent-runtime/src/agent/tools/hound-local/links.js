// @ts-check
// Adapted from hound-mcp 13.2.0 src/master_fetch/links.py (MIT).
// Copyright (c) 2026 Bishesh Bhandari. See ../../../../THIRD_PARTY_NOTICES.md
// in the package root for the complete license and verified source provenance.
import { parseHTML } from "linkedom";

export const MAX_WEB_FETCH_LINKS = 20;
export const MAX_WEB_FETCH_LINK_URL_CHARS = 2000;
export const MAX_WEB_FETCH_LINK_TEXT_CHARS = 200;
const CHROME = 'nav,header,footer,aside,[role="navigation"],[role="menu"],[role="menubar"]';

export function safeDocumentUrl(value, base) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const parsed = new URL(value, base);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
    return parsed.href;
  } catch { return ""; }
}

export function sanitizeDocumentLinks(document, baseUrl) {
  for (const node of document.querySelectorAll("a[href],img[src]")) {
    const attribute = node.tagName?.toLowerCase() === "a" ? "href" : "src";
    const safe = safeDocumentUrl(node.getAttribute(attribute), baseUrl);
    if (safe) node.setAttribute(attribute, safe);
    else node.removeAttribute(attribute);
  }
}

/**
 * Hound's container classification and fragment dedupe, adapted to Mono's
 * bounded flat link contract. Content citations win over earlier chrome links,
 * including duplicates; neither canonical metadata nor host popularity confers
 * source authority. No network work is performed here.
 * @param {unknown} html
 * @param {unknown} baseUrl
 * @param {{limit?: number}} [options]
 * @returns {Array<{url: string, text: string, provenance: string}>}
 */
export function extractHtmlLinks(html, baseUrl, { limit = MAX_WEB_FETCH_LINKS } = {}) {
  const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_WEB_FETCH_LINKS) : MAX_WEB_FETCH_LINKS;
  const { document } = parseHTML(String(html || ""));
  const content = new Map();
  const page = new Map();
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href")?.trim();
    if (!href || href.startsWith("#")) continue;
    const resolved = safeDocumentUrl(href, baseUrl);
    if (!resolved || resolved.length > MAX_WEB_FETCH_LINK_URL_CHARS) continue;
    const url = resolved.split("#", 1)[0];
    const main = !anchor.closest(CHROME) && Boolean(anchor.closest('article,main,[role="main"],section,p,li'));
    const destination = main ? content : page;
    // Each priority bucket is independently bounded. A duplicate in chrome
    // must not prevent retaining the later, more informative article citation.
    if (destination.has(url) || destination.size >= cap) continue;
    destination.set(url, {
      url,
      text: String(anchor.textContent || "").replace(/\s+/gu, " ").trim().slice(0, MAX_WEB_FETCH_LINK_TEXT_CHARS),
      provenance: main ? "main-content" : "page",
    });
  }
  return [...content.values(), ...[...page.values()].filter((link) => !content.has(link.url))].slice(0, cap);
}
