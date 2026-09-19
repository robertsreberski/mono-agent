// @ts-check
import { claimWebSearchRequest } from "../web-search-state.js";
import { callHoundMcp, houndFailure, houndRemoteAllowedByPolicy, houndStructuredContent, validateHoundEndpoint, HOUND_SEARCH_TOOL } from "../hound-mcp.js";
import { canonicalizeSearchUrl, collapseWhitespace } from "./shared.js";

/**
 * Optional Hound backend (user-managed loopback MCP endpoint).
 *
 * One provider dispatch fans out server-side across Hound's keyless engine
 * pool (plus intent backends and any server-side BYOK keys); it is never one
 * underlying engine request. Host budget and cooldown apply to Hound
 * invocations only. Server-provided action hints (next_action, fetch_hint,
 * related_queries) are never surfaced; the host envelope synthesizes actions.
 */
export const houndProvider = {
  name: "hound", batchesQueries: false,
  filterSupport: { language: "provider", timeRange: "provider" },
  configure: (input, selected) => {
    const result = normalizeHoundEndpointConfig(input?.hound, selected ? "hound" : undefined);
    return result.error ? result : { value: { hound: result.value } };
  },
  eligibility: (config) => Boolean(config.hound?.endpoint),
  admission: (config) => ({ kind: "hound", key: config.hound.endpoint, processPolicy: "endpoint" }),
  networkTargets: (config) => [config.hound.endpoint],
  async search(query, options) {
    // The loopback endpoint gate in searchOneQuery is not sufficient: Hound
    // fans out server-side to arbitrary public engines. A restricted host
    // policy fails here, before quota is claimed and before any MCP dispatch.
    if (!houndRemoteAllowedByPolicy(options.policy)) {
      return { ok: false, backend: "hound", code: "network_denied", message: "Network access denied by sandbox policy.", retryable: false };
    }
    try {
      // Reserve before connecting too: an exhausted run must not connect.
      claimWebSearchRequest(options.searchState, "hound", options.callClaims);
      const endpoint = options.config.hound?.endpoint;
      const response = await callHoundMcp(endpoint, HOUND_SEARCH_TOOL, {
        query, options: houndSearchOptions(options),
      }, options);
      return { ok: true, backend: "hound", results: parseHoundSearch(response) };
    } catch (error) { return houndFailure(error, options.signal); }
  },
};

const HOUND_FRESHNESS = new Set(["day", "week", "month", "year"]);

export function houndSearchOptions(options) {
  const output = { max_results: options.maxResults };
  if (typeof options.language === "string" && options.language.trim()) {
    output.language = options.language.trim();
  }
  if (typeof options.timeRange === "string" && HOUND_FRESHNESS.has(options.timeRange)) {
    output.freshness = options.timeRange;
  }
  // The chain already appends site: operators to the query text and post-filters
  // by domain. A single include domain is also passed natively; multiple domains
  // stay in the query text because Hound accepts only one `site` value.
  if (Array.isArray(options.includeDomains) && options.includeDomains.length === 1) {
    output.site = options.includeDomains[0];
  }
  if (Array.isArray(options.excludeDomains) && options.excludeDomains.length > 0) {
    output.exclude_sites = [...options.excludeDomains];
  }
  return output;
}

export function parseHoundSearch(response) {
  const data = houndStructuredContent(response);
  if (!Array.isArray(data.results)) throw new Error("Malformed Hound search response.");
  if (data.results.length > 0) {
    const parsed = data.results.flatMap((entry) => normalizeHoundResult(entry));
    if (parsed.length === 0) throw new Error("Hound search returned no usable result URLs.");
    return parsed;
  }
  // An empty result set is a genuine answer, even when the server notes blocked
  // engines. A server-level error with no results is a failure, without
  // repeating provider-controlled text.
  if (typeof data.error === "string" && data.error.trim()) throw new Error("Hound search failed.");
  return [];
}

function normalizeHoundResult(entry) {
  if (!entry || typeof entry !== "object") return [];
  const url = canonicalizeSearchUrl(entry.url);
  if (!url) return [];
  const title = collapseWhitespace(entry.title) || url;
  const snippet = collapseWhitespace(entry.snippet);
  return [{ url, title, snippet, backend: "hound" }];
}

function normalizeHoundEndpointConfig(input, backend) {
  if (backend !== "hound" && input === undefined) return { value: undefined };
  const validated = validateHoundEndpoint(input?.endpoint);
  if (validated.error) return { error: validated.error };
  return { value: { endpoint: validated.endpoint } };
}
