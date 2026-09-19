// @ts-check
import { parseHTML } from "linkedom";
import { keylessHtmlSearch, canonicalizeSearchUrl, collapseWhitespace } from "./shared.js";
export const duckduckgoProvider = {
  name: "duckduckgo", batchesQueries: false,
  filterSupport: { language: "advisory", timeRange: "provider" },
  configure: () => ({ value: {} }), eligibility: () => true,
  admission: () => ({ kind: "duckduckgo", key: "duckduckgo", processPolicy: "keyless" }),
  networkTargets: () => ["https://html.duckduckgo.com"],
  search: searchDuckDuckGo,
};
function searchDuckDuckGo(query, options) {
  return keylessHtmlSearch({
    backend: "duckduckgo",
    label: "DuckDuckGo",
    url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}${({ day: "d", month: "m", year: "y" }[options.timeRange]) ? `&df=${({ day: "d", month: "m", year: "y" }[options.timeRange])}` : ""}`,
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

