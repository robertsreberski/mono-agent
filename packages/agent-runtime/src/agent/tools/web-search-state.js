// @ts-check

export const DEFAULT_WEB_SEARCH_MAX_REQUESTS_PER_RUN = 4;
export const MAX_WEB_SEARCH_REQUESTS_PER_RUN = 20;

/**
 * Private mutable state shared by every WebSearch controller created for one
 * logical runtime run. Router retries receive the same object, while child and
 * later runs receive a fresh one.
 *
 * @param {any} searchConfig
 * @param {any} [existing]
 */
export function createWebSearchRunState(searchConfig, existing) {
  if (isWebSearchRunState(existing)) return existing;
  const configured = searchConfig?.maxRequestsPerRun;
  const maxRequests = Number.isSafeInteger(configured)
    && configured >= 1
    && configured <= MAX_WEB_SEARCH_REQUESTS_PER_RUN
    ? configured
    : DEFAULT_WEB_SEARCH_MAX_REQUESTS_PER_RUN;
  return {
    schema: "mono-agent.web-search-run.v1",
    maxRequests,
    requestsUsed: 0,
    deferredProviders: new Map(),
  };
}

/** Claim one actual provider dispatch synchronously. */
export function claimWebSearchRequest(state, backend) {
  if (!isWebSearchRunState(state)) throw new Error("Invalid WebSearch run state.");
  if (state.requestsUsed >= state.maxRequests) {
    throw Object.assign(new Error("WebSearch request budget exhausted for this run."), {
      code: "search_budget_exhausted",
      backend,
    });
  }
  state.requestsUsed += 1;
}

export function webSearchBudgetSnapshot(state, requestsThisCall = 0) {
  const resolved = createWebSearchRunState(undefined, state);
  return {
    requestsThisCall,
    maxRequestsPerRun: resolved.maxRequests,
    requestsUsed: resolved.requestsUsed,
    requestsRemaining: Math.max(0, resolved.maxRequests - resolved.requestsUsed),
  };
}

export function deferWebSearchProvider(state, backend, retryAtMs) {
  if (!isWebSearchRunState(state)) return;
  const current = state.deferredProviders.get(backend);
  const next = Number.isFinite(retryAtMs) ? retryAtMs : undefined;
  if (current === undefined || (next !== undefined && (current.retryAtMs === undefined || next > current.retryAtMs))) {
    state.deferredProviders.set(backend, { retryAtMs: next });
  }
}

export function deferredWebSearchProvider(state, backend) {
  return isWebSearchRunState(state) ? state.deferredProviders.get(backend) : undefined;
}

function isWebSearchRunState(value) {
  return value?.schema === "mono-agent.web-search-run.v1"
    && Number.isSafeInteger(value.maxRequests)
    && Number.isSafeInteger(value.requestsUsed)
    && value.deferredProviders instanceof Map;
}
