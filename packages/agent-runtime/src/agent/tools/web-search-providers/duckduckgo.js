// @ts-check
import { parseHTML } from "linkedom";
import { keylessHtmlSearch, canonicalizeSearchUrl, collapseWhitespace } from "./shared.js";
import { duckDuckGoRegion, unsupportedCountryFilter } from "../web-search-country.js";
export const duckduckgoProvider = {
  name: "duckduckgo", batchesQueries: false,
  filterSupport: { language: "advisory", timeRange: "provider", country: "provider" },
  configure: () => ({ value: {} }), eligibility: () => true,
  admission: () => ({ kind: "duckduckgo", key: "duckduckgo", processPolicy: "keyless" }),
  networkTargets: () => ["https://html.duckduckgo.com"],
  preflight: (options) => options.country && !duckDuckGoRegion(options.country, options.language)
    ? unsupportedCountryFilter("duckduckgo") : null,
  search: searchDuckDuckGo,
};
function searchDuckDuckGo(query, options) {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  url.searchParams.set("kl", duckDuckGoRegion(options.country, options.language));
  const date = { day: "d", month: "m", year: "y" }[options.timeRange];
  if (date) url.searchParams.set("df", date);
  return keylessHtmlSearch({
    backend: "duckduckgo",
    label: "DuckDuckGo",
    url: url.href,
    parse: parseDuckDuckGoResults,
  }, options);
}

export function parseDuckDuckGoResults(html) {
  const { document } = parseHTML(String(html || ""));
  const rows = [...document.querySelectorAll(".result")];
  return rows.flatMap((row) => {
    const link = row.querySelector("a.result__a");
    if (!link) return [];
    const url = canonicalizeSearchUrl(link.getAttribute("href"), "https://html.duckduckgo.com/");
    if (!url) return [];
    return [{
      title: collapseWhitespace(link.textContent),
      url,
      snippet: collapseWhitespace(row.querySelector(".result__snippet")?.textContent),
      backend: "duckduckgo",
    }];
  });
}

