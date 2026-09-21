// @ts-check
// Adapted from Hound 13.2.0 search_metasearch.py (DuckDuckGo 315-352).
// Hound MIT (c) 2026 Bishesh Bhandari; vendored ddgs MIT (c) 2022 deedy5 /
// Pragmatic School. Full notices and verified source digest: package-root
// THIRD_PARTY_NOTICES.md.
//
// Brave (`https://search.brave.com/search`) and Mojeek
// (`https://www.mojeek.com/search`) serve `Disallow: /search` to every user
// agent in their robots.txt, so the proactive robots gate refuses them on
// every search and they can never return a result. The pool is therefore a
// single DuckDuckGo HTML engine until a robots-permitted endpoint exists.
import { parseHTML } from "linkedom";
import { canonicalizeSearchUrl, collapseWhitespace, wrappedSearchDestination } from "../web-search-providers/shared.js";
import { duckDuckGoRegion } from "../web-search-country.js";

export const LOCAL_ENGINES = Object.freeze([
  { name: "duckduckgo", origin: "https://html.duckduckgo.com", date: true, country: true },
]);

export function localEngineRequest(engine, query, timeRange, language, country) {
  const headers = { "Accept-Language": language || "en-US,en;q=0.8" };
  const date = { day: "d", month: "m", year: "y" }[timeRange];
  if (engine.name === "duckduckgo") {
    const body = new URLSearchParams({ q: query, b: "", l: duckDuckGoRegion(country, language) ?? "wt-wt" });
    if (date) body.set("df", date);
    return { url: `${engine.origin}/html/`, init: { method: "POST", body, headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" } } };
  }
  throw Object.assign(new Error(`Unsupported local search engine (${engine?.name}).`), { code: "endpoint_not_supported" });
}

export function parseLocalEngine(engine, html) {
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll("script,style")) node.remove();
  const results = [];
  const seen = new Set();
  for (const row of document.querySelectorAll(".result, div.body")) {
    const link = row.querySelector("a.result__a, h2 a") ?? [...row.children].find((node) => node.tagName === "A");
    const title = row.querySelector("h2")?.textContent ?? link?.textContent;
    const snippet = row.querySelector(".result__snippet")?.textContent ?? (link?.getAttribute("class") ? "" : link?.textContent);
    const href = safeSearchUrl(link?.getAttribute("href"), engine.origin);
    if (!href || !collapseWhitespace(title) || seen.has(href)) continue;
    if (new URL(href).pathname === "/y.js" && new URL(href).hostname === "duckduckgo.com") continue;
    seen.add(href);
    results.push({ url: href, title: collapseWhitespace(title).slice(0, 500), snippet: collapseWhitespace(snippet).slice(0, 600), engine: engine.name });
    if (results.length >= 30) break;
  }
  if (!results.length && !/\bno results (?:found|for|were found)\b/iu.test(document.documentElement?.textContent || "")) {
    throw Object.assign(new Error("Unrecognized local engine result layout."), { code: "invalid_response" });
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
    const wrapped = wrappedSearchDestination(parsed);
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

/** Local consensus/snippet aggregation + lean position ranking and host
 * diversity. With the single-engine pool every result carries one engine vote;
 * the merge still dedupes and diversifies hosts. No neural model or authority
 * labels.
 */
export function mergeLocalResults(lists, { includeDomains = [], excludeDomains = [] } = {}) {
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
  return [...leading, ...deferred].map(({ engine: _engine, position: _position, engines: _engines, ...result }) => ({ ...result, backend: "local" }));
}
