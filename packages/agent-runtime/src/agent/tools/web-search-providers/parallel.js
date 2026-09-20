// @ts-check
import { claimWebSearchRequest } from "../web-search-state.js";
import { callParallelMcp, parallelFailure, parallelStructuredContent, PARALLEL_MCP_URL } from "../parallel-mcp.js";
import { canonicalizeSearchUrl } from "./shared.js";

export const parallelProvider = {
  name: "parallel", batchesQueries: true,
  filterSupport: { language: "advisory", timeRange: "advisory", country: "advisory" },
  configure: (input) => ({ value: { parallel: input?.parallel } }),
  eligibility: () => true,
  admission: () => ({ kind: "parallel", key: PARALLEL_MCP_URL, processPolicy: "endpoint" }),
  networkTargets: () => [PARALLEL_MCP_URL],
  async search(query, options) {
    try {
      // Reserve before initialization too: an exhausted run must not connect.
      claimWebSearchRequest(options.searchState, "parallel", options.callClaims);
      const response = await callParallelMcp("web_search", {
        objective: parallelSearchObjective(options.queries?.[0] ?? query, options),
        search_queries: options.queries ?? [query], session_id: options.sessionId,
      }, { ...options, config: options.config.parallel });
      return { ok: true, backend: "parallel", results: parseParallelSearch(response) };
    } catch (error) { return parallelFailure(error, options.signal); }
  },
};

export function parallelSearchObjective(query, options) {
  return [query, options.language ? `Prefer sources in ${options.language}.` : "",
    options.country ? `Prefer search results localized for country ${options.country}.` : "",
    options.timeRange ? `Prefer sources published within the last ${options.timeRange}.` : "",
    options.includeDomains?.length ? `Prefer these domains: ${options.includeDomains.join(", ")}.` : "",
    options.excludeDomains?.length ? `Avoid these domains: ${options.excludeDomains.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
}

export function parseParallelSearch(response) {
  const data = parallelStructuredContent(response);
  if (typeof data.search_id !== "string") throw new Error("Malformed Parallel search response.");
  return data.results.map((entry) => {
    const url = canonicalizeSearchUrl(entry?.url);
    if (!url || !(entry.title === null || typeof entry.title === "string")
      || !Array.isArray(entry.excerpts) || entry.excerpts.some((text) => typeof text !== "string")
      || !(entry.publish_date === null || /^\d{4}-\d{2}-\d{2}$/u.test(entry.publish_date))) {
      throw new Error("Malformed Parallel search result.");
    }
    return { url, title: entry.title || url, snippet: entry.excerpts.join("\n\n"), backend: "parallel",
      ...(entry.publish_date ? { publishDate: entry.publish_date } : {}) };
  });
}
