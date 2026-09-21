// @ts-check
import { claimWebSearchRequest } from "../web-search-state.js";
import { requestSignal, readLimitedText, normalizedResult, collapseWhitespace, fetchFailure, parseRetryAfter } from "./shared.js";
const SEARXNG_THROTTLE_REASON_RE = /captcha|too many requests|rate.?limit|suspend|blocked|denied/iu;
export const searxngProvider = {
  name: "searxng", batchesQueries: false, chainDeadlineMs: 3000,
  // domains: "unverified" — the operator text is forwarded verbatim, but the
  // endpoint is operator-owned and support for site: is a property of its
  // configured upstream engines, not of this adapter; only the client-side
  // domain filter can be relied on across deployments.
  filterSupport: { language: "provider", timeRange: "provider", country: "unsupported", domains: "unverified" },
  configure(input, selected) {
  const legacyEndpoint = input?.endpoint;
  const nestedEndpoint = input?.searxng?.endpoint;
  if (legacyEndpoint && nestedEndpoint && String(legacyEndpoint).trim() !== String(nestedEndpoint).trim()) {
    return { error: "Legacy and canonical SearXNG endpoints disagree." };
  }
  let endpoint;
  const endpointInput = nestedEndpoint ?? legacyEndpoint;
  if (endpointInput !== undefined && String(endpointInput).trim()) {
    try {
      const parsed = new URL(String(endpointInput));
      if (parsed.protocol !== "http:" || !isLoopbackHost(parsed.hostname) || parsed.username || parsed.password) {
        return { error: "SearXNG endpoint must be an unauthenticated loopback http URL." };
      }
      if (parsed.search || parsed.hash) {
        return { error: "SearXNG endpoint must not contain a query string or fragment." };
      }
      parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
      endpoint = parsed.href.replace(/\/+$/u, "");
    } catch {
      return { error: "SearXNG endpoint must be a valid loopback http URL." };
    }
  }
  if (selected && !endpoint) {
    return { error: "SearXNG backend requires tools.web.search.searxng.endpoint." };
  }
    return { value: { endpoint } };
  },
  eligibility: (config) => Boolean(config.endpoint),
  admission: (config) => ({ kind: "searxng", key: config.endpoint, processPolicy: "endpoint" }),
  networkTargets: (config) => [`${config.endpoint}/search`],
  search: searchSearxng,
};
async function searchSearxng(query, options) {
  const endpoint = options.config.endpoint;
  if (!endpoint) {
    return { ok: false, backend: "searxng", message: "SearXNG endpoint is not configured.", retryable: false };
  }
  const url = `${endpoint}/search`;
  if (!options.sandbox.networkAllowsUrl(options.policy, url)) {
    return { ok: false, backend: "searxng", message: "Network access denied by sandbox policy.", retryable: false };
  }
  const body = new URLSearchParams({ q: query, format: "json", categories: "general" });
  if (typeof options.language === "string" && options.language.trim()) {
    body.set("language", options.language.trim());
  }
  if (["day", "month", "year"].includes(options.timeRange)) {
    body.set("time_range", options.timeRange);
  }
  try {
    claimWebSearchRequest(options.searchState, "searxng", options.callClaims);
    const response = await options.fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": "mono-agent-web/1",
      },
      body,
      signal: options.chained ? AbortSignal.any([options.signal, AbortSignal.timeout(3000)]) : requestSignal(options.signal),
      redirect: "error",
    });
    const text = await readLimitedText(response);
    if (!response.ok) {
      return {
        ok: false,
        backend: "searxng",
        message: `SearXNG HTTP ${response.status}`,
        rateLimited: response.status === 429, retryAfterMs: parseRetryAfter(response),
        retryable: response.status === 429 || response.status >= 500,
      };
    }
    let data;
    try { data = JSON.parse(text); } catch {
      return { ok: false, backend: "searxng", message: "SearXNG returned invalid JSON.", retryable: false };
    }
    const results = Array.isArray(data?.results)
      ? data.results.flatMap((entry) => normalizedResult(entry, "searxng"))
      : [];
    // An instance whose engines are all captcha'd or suspended still answers
    // `200 {"results": []}`, and `unresponsive_engines` is the only thing that
    // tells that apart from a query nothing matched. Reading `results` alone is
    // what let a completely dead instance report "No results." on every query
    // for weeks. Naming each engine and its reason is what makes the next one
    // diagnosable from the tool output instead of from the container logs.
    //
    // Counted on the RAW array, not the normalized one: results that all fail
    // canonicalization are an unusable answer from working engines, which is a
    // different fault and must not be blamed on the engines that did fail.
    const unresponsive = normalizeUnresponsiveEngines(data?.unresponsive_engines);
    if (!Array.isArray(data?.results) || (data.results.length === 0 && unresponsive.length > 0)) {
      if (unresponsive.length === 0) {
        return { ok: false, backend: "searxng", message: "SearXNG returned no results array.", retryable: false };
      }
      // Deliberately not "every engine failed": SearXNG lists only the engines
      // that failed, so a working engine that simply matched nothing is
      // indistinguishable here from one that was never queried.
      const detail = unresponsive.map((entry) => `${entry.name}: ${entry.reason}`).join("; ");
      return {
        ok: false,
        backend: "searxng",
        message: `SearXNG returned no results and ${unresponsive.length === 1 ? "1 engine" : `${unresponsive.length} engines`} failed (${detail})`,
        retryable: true,
        rateLimited: unresponsive.some((entry) => SEARXNG_THROTTLE_REASON_RE.test(entry.reason)),
      };
    }
    return { ok: true, backend: "searxng", results };
  } catch (error) {
    return fetchFailure("searxng", error);
  }
}

function normalizeUnresponsiveEngines(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const [name, reason] = Array.isArray(entry) ? entry : [entry?.name, entry?.error ?? entry?.reason];
    const normalizedName = collapseWhitespace(name);
    if (!normalizedName) return [];
    return [{ name: normalizedName, reason: collapseWhitespace(reason) || "unknown error" }];
  });
}

function isLoopbackHost(hostname) {
  const value = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

