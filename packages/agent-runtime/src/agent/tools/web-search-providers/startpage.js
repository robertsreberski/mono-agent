// @ts-check
import { parseHTML } from "linkedom";
import { keylessHtmlSearch, canonicalizeSearchUrl, collapseWhitespace } from "./shared.js";
export const startpageProvider = {
  name: "startpage", batchesQueries: false,
  filterSupport: { language: "advisory", timeRange: "advisory" },
  configure: () => ({ value: {} }), eligibility: () => true,
  admission: () => ({ kind: "startpage", key: "startpage", processPolicy: "keyless" }),
  networkTargets: () => ["https://www.startpage.com"],
  search: searchStartpage,
};
function searchStartpage(query, options) {
  // Startpage serves its results from a form POST. The old query-string GET was
  // answered with a 3xx, which `redirect: "error"` turned into a bare
  // `TypeError: fetch failed` — so this backend never once returned a result,
  // and its useless error was the only thing the operator ever saw.
  const body = new URLSearchParams({ query, cat: "web" });
  const withDate = { day: "d", month: "m", year: "y" }[options.timeRange];
  if (withDate) body.set("with_date", withDate);
  return keylessHtmlSearch({
    backend: "startpage",
    label: "Startpage",
    url: "https://www.startpage.com/sp/search",
    init: {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    },
    parse: parseStartpageResults,
  }, options);
}

export function parseStartpageResults(html) {
  const { document } = parseHTML(String(html || ""));
  // Startpage inlines emotion CSS in <style> tags nested inside the result
  // anchors, and textContent happily returns the stylesheet as part of the
  // title (".css-i3irj7{line-height:18px;...}Best time to visit Japan").
  for (const node of document.querySelectorAll("style, script")) node.remove();
  const selectors = [".w-gl__result", ".result", "article"];
  const rows = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
  const seen = new Set();
  const results = [];
  for (const row of rows) {
    const link = row.querySelector("a.w-gl__result-title, a.result-link, h2 a, h3 a");
    if (!link) continue;
    const url = canonicalizeSearchUrl(link.getAttribute("href"), "https://www.startpage.com/");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: collapseWhitespace(link.textContent),
      url,
      snippet: collapseWhitespace(
        row.querySelector(".w-gl__description, .result-description, p")?.textContent,
      ),
      backend: "startpage",
    });
  }
  return results;
}

