// @ts-check
// Hound 13.2.0 bounded metasearch adaptation. Hound/ddgs MIT notices and
// source digest in package-root THIRD_PARTY_NOTICES.md. No upstream transport.
import { HOUND_ENGINES, houndEngineRequest, parseHoundEngine, mergeHoundResults } from "./engines.js";
import { assertHoundTarget, houndRequest } from "./network.js";
import { assertHoundRobots } from "./robots.js";
import { claimWebSearchRequest, countWebSearchDispatch } from "../web-search-state.js";
import { withWebDeadline } from "../web-request.js";

const CODES = new Set(["network_denied", "robots_denied", "robots_unavailable", "robots_crawl_delay", "rate_limited", "access_challenge", "authentication_required", "invalid_response", "response_too_large", "search_budget_exhausted", "coordination_unavailable", "aborted", "deadline_exceeded"]);

export async function searchLocalHound(query, options) {
  let claimed = false;
  const metrics = { coordinationWaitMs: 0, backendDurationMs: 0 };
  const recordMetrics = (result) => {
    metrics.coordinationWaitMs += result.coordinationWaitMs || 0;
    metrics.backendDurationMs += result.backendDurationMs || 0;
  };
  const beforeDispatch = () => {
    if (!claimed) { claimWebSearchRequest(options.searchState, "hound", options.callClaims); claimed = true; }
    else countWebSearchDispatch(options.searchState, "hound");
  };
  return withWebDeadline(options.signal, 15_000, async (deadlineSignal) => {
    const abort = new AbortController();
    const signal = AbortSignal.any([deadlineSignal, abort.signal]);
    let fatal;
    const entries = await Promise.all(HOUND_ENGINES.map(async (engine) => {
      if (options.timeRange && !engine.date) return { engine: engine.name, code: "unsupported_filter", results: [] };
      const request = houndEngineRequest(engine, query, options.timeRange, options.language);
      const child = { ...options, engine: engine.name, signal, beforeDispatch, recordMetrics };
      try {
        assertHoundTarget(request.url, child); // before robots, host admission or claims
        await assertHoundRobots(request.url, child);
        const { response, text } = await houndRequest(request.url, { ...child, rejectRedirects: true }, request.init);
        if (!response.ok) throw Object.assign(new Error("Engine request failed."), { code: response.status >= 300 && response.status < 400 ? "access_challenge" : "provider_unavailable" });
        const results = parseHoundEngine(engine, text);
        return { engine: engine.name, code: results.length ? "ok" : "empty", results };
      } catch (error) {
        const code = signal.aborted ? (["coordination_unavailable", "deadline_exceeded"].includes(signal.reason?.code) ? signal.reason.code : "aborted") : CODES.has(error?.code) ? error.code : "provider_unavailable";
        if (code === "coordination_unavailable") { fatal = code; abort.abort(Object.assign(new Error("Coordination unavailable."), { code })); }
        return { engine: engine.name, code, results: [], ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}) };
      }
    }));
    const engineOutcomes = entries.map((entry) => ({ engine: entry.engine, code: entry.code, ...("retryAfterMs" in entry ? { retryAfterMs: entry.retryAfterMs } : {}) }));
    const delays = engineOutcomes.filter((entry) => entry.code === "rate_limited")
      .map((entry) => entry.retryAfterMs).filter((delay) => Number.isFinite(delay) && delay >= 0);
    const now = Date.now();
    const retryAfterMs = delays.length ? Math.min(8_640_000_000_000_000 - now, ...delays) : undefined;
    const fail = (code) => ({
      ...(code === "rate_limited" ? { rateLimited: true, ...(retryAfterMs === undefined ? {} : { retryAfterMs, retryAtMs: now + retryAfterMs }) } : {}),
      ok: false, backend: "hound", code, message: `Native Hound search refused (${code}).`, retryable: false, engineOutcomes, ...metrics });
    if (options.signal?.aborted) return fail(options.signal.reason?.code === "deadline_exceeded" ? "deadline_exceeded" : "aborted");
    if (fatal) return fail(fatal);
    if (deadlineSignal.aborted) return fail("deadline_exceeded");
    const results = mergeHoundResults(entries.map((entry) => entry.results), options);
    const partial = entries.some((entry) => !["ok", "empty"].includes(entry.code));
    if (!results.length) {
      if (entries.some((entry) => entry.code === "search_budget_exhausted")) return fail("search_budget_exhausted");
      if (!entries.some((entry) => ["ok", "empty"].includes(entry.code))) return fail(entries.some((entry) => entry.code === "rate_limited") ? "rate_limited" : entries.find((entry) => entry.code !== "unsupported_filter")?.code ?? "provider_unavailable");
    }
    return { ok: true, backend: "hound", results, partial, engineOutcomes, ...metrics };
  });
}
