// @ts-check
// Adapted from Hound 13.2.0 search_metasearch.py (DuckDuckGo 315-352,
// Brave 408-433, Mojeek 636-657). Hound MIT (c) 2026 Bishesh Bhandari;
// vendored ddgs MIT (c) 2022 deedy5 / Pragmatic School. Full notices and
// verified source digest: package-root THIRD_PARTY_NOTICES.md.
import { parseHTML } from "linkedom";
import { canonicalizeSearchUrl, collapseWhitespace } from "../web-search-providers/shared.js";

export const HOUND_ENGINES = Object.freeze([
  { name: "duckduckgo", origin: "https://html.duckduckgo.com", date: true },
  { name: "brave", origin: "https://search.brave.com", date: true },
  { name: "mojeek", origin: "https://www.mojeek.com", date: false },
]);

export function houndEngineRequest(engine, query, timeRange, language) {
  const headers = { "Accept-Language": language || "en-US,en;q=0.8" };
  const date = { day: "d", month: "m", year: "y" }[timeRange];
  if (engine.name === "duckduckgo") {
    const body = new URLSearchParams({ q: query, b: "", l: "us-en" });
    if (date) body.set("df", date);
    return { url: `${engine.origin}/html/`, init: { method: "POST", body, headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" } } };
  }
  const url = new URL("/search", engine.origin);
  url.searchParams.set("q", query);
  if (engine.name === "brave") {
    url.searchParams.set("source", "web");
    if (date) url.searchParams.set("tf", { d: "pd", m: "pm", y: "py" }[date]);
  }
  return { url: url.href, init: { headers } };
}

export function parseHoundEngine(engine, html) {
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll("script,style")) node.remove();
  const selector = { duckduckgo: ".result, div.body", brave: 'div[data-type="web"]', mojeek: "ul.results > li" }[engine.name];
  const results = [];
  const seen = new Set();
  for (const row of document.querySelectorAll(selector)) {
    let link;
    let title;
    let snippet;
    if (engine.name === "duckduckgo") {
      link = row.querySelector("a.result__a, h2 a") ?? [...row.children].find((node) => node.tagName === "A");
      title = row.querySelector("h2")?.textContent ?? link?.textContent;
      snippet = row.querySelector(".result__snippet")?.textContent ?? (link?.getAttribute("class") ? "" : link?.textContent);
    } else if (engine.name === "brave") {
      link = [...row.querySelectorAll("a[href]")].find((node) => node.querySelector('[class*="title"]'));
      title = link?.querySelector('[class*="title"]')?.textContent;
      snippet = row.querySelector('[class*="snippet"] [class*="content"]')?.textContent;
    } else {
      link = row.querySelector("h2 a"); title = row.querySelector("h2")?.textContent;
      snippet = row.querySelector("p.s")?.textContent;
    }
    const href = safeSearchUrl(link?.getAttribute("href"), engine.origin);
    if (!href || !collapseWhitespace(title) || seen.has(href)) continue;
    if (new URL(href).pathname === "/y.js" && new URL(href).hostname === "duckduckgo.com") continue;
    seen.add(href);
    results.push({ url: href, title: collapseWhitespace(title).slice(0, 500), snippet: collapseWhitespace(snippet).slice(0, 600), engine: engine.name });
    if (results.length >= 30) break;
  }
  if (!results.length && !/\bno results (?:found|for|were found)\b/iu.test(document.documentElement?.textContent || "")) {
    throw Object.assign(new Error("Unrecognized Hound engine result layout."), { code: "invalid_response" });
  }
  return results;
}

function safeSearchUrl(value, base) {
  try {
    const parsed = new URL(value, base);
    if (!value || parsed.username || parsed.password || !["http:", "https:"].includes(parsed.protocol)) return null;
    const result = canonicalizeSearchUrl(value, base);
    if (!result) return null;
    // Reject credential-bearing wrapped destinations before canonicalization
    // can strip userinfo, rather than laundering them into usable results.
    const wrapped = ["uddg", "url", "u", "target"].map((name) => parsed.searchParams.get(name)).find(Boolean);
    if (wrapped) {
      const target = new URL(wrapped);
      if (target.username || target.password) return null;
    }
    return result;
  } catch { return null; }
}

const RESERVED_GITHUB = new Set("about apps codespaces collections dashboard explore features issues login marketplace new notifications orgs pricing pulls search security settings sponsors topics trending".split(" "));
function dedupeKey(url) {
  const target = new URL(url);
  const segments = target.pathname.split("/");
  if (["github.com", "www.github.com"].includes(target.hostname) && segments[1] && segments[2] && !RESERVED_GITHUB.has(segments[1].toLowerCase())) {
    segments[1] = segments[1].toLowerCase(); segments[2] = segments[2].toLowerCase();
    target.pathname = segments.join("/");
  }
  return target.href;
}

/** Hound consensus/snippet aggregation + lean position ranking and host
 * diversity. Engine order is fixed, not completion order; independent index
 * families are DDG/Bing, Brave, Mojeek. No neural model or authority labels.
 */
export function mergeHoundResults(lists, { includeDomains = [], excludeDomains = [] } = {}) {
  const byUrl = new Map();
  const matches = (host, domain) => host === domain || host.endsWith(`.${domain}`);
  for (const list of lists) for (const [position, result] of list.entries()) {
    const host = new URL(result.url).hostname;
    if (includeDomains.length && !includeDomains.some((domain) => matches(host, domain))) continue;
    if (excludeDomains.some((domain) => matches(host, domain))) continue;
    const key = dedupeKey(result.url);
    const existing = byUrl.get(key);
    if (existing) {
      existing.engines.add(result.engine);
      existing.position = Math.min(existing.position, position);
      if (result.snippet && !existing.snippet.includes(result.snippet)) existing.snippet = `${existing.snippet} ${result.snippet}`.trim().slice(0, 600);
    } else byUrl.set(key, { ...result, position, engines: new Set([result.engine]) });
  }
  const ranked = [...byUrl.values()].sort((a, b) => b.engines.size - a.engines.size || a.position - b.position || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const counts = new Map(); const leading = []; const deferred = [];
  for (const result of ranked) {
    const host = new URL(result.url).hostname.replace(/^www\./u, "");
    const count = counts.get(host) ?? 0; counts.set(host, count + 1);
    (includeDomains.length === 1 || count < 2 ? leading : deferred).push(result);
  }
  return [...leading, ...deferred].map(({ engine: _engine, position: _position, engines: _engines, ...result }) => ({ ...result, backend: "hound" }));
}
