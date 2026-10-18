// @ts-check

const DEFAULT_WEB_SEARCH_MAX_REQUESTS_PER_RUN = 4;
export const MAX_WEB_SEARCH_REQUESTS_PER_RUN = 20;

/**
 * Private mutable state shared by every WebSearch controller created for one
 * logical runtime run. Router retries receive the same object, while child and
 * later runs receive a fresh one.
 */
export function createWebSearchRunState(searchConfig: any, existing?: any): any {
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
    dispatchesUsed: 0,
    deferredProviders: new Map(),
  };
}

/** Reserve one answered search and count its first dispatch synchronously. */
export function claimWebSearchRequest(state: any, backend: any, callClaims: any): void {
  if (!isWebSearchRunState(state)) throw new Error("Invalid WebSearch run state.");
  if (state.requestsUsed >= state.maxRequests) {
    throw Object.assign(new Error("WebSearch request budget exhausted for this run."), {
      code: "search_budget_exhausted",
      backend,
    });
  }
  countWebSearchDispatch(state, backend);
  state.requestsUsed += 1;
  if (callClaims && Number.isSafeInteger(callClaims.requests)) callClaims.requests += 1;
}

/** Count network work without reserving another answered search (endpoint probes). */
export function countWebSearchDispatch(state: any, backend: any): void {
  if (!isWebSearchRunState(state)) throw new Error("Invalid WebSearch run state.");
  const used = state.dispatchesUsed ?? 0;
  if (used >= state.maxRequests * 4) {
    throw Object.assign(new Error("WebSearch dispatch ceiling exhausted for this run."), {
      code: "search_budget_exhausted",
      reason: "dispatch_ceiling",
      backend,
    });
  }
  state.dispatchesUsed = used + 1;
}

/** Refund only this failed dispatch's reservations, never its network work. */
export function refundWebSearchRequests(state: any, count: any, callClaims: any): void {
  if (!isWebSearchRunState(state)) throw new Error("Invalid WebSearch run state.");
  if (!Number.isSafeInteger(count) || count <= 0) return;
  state.requestsUsed = Math.max(0, state.requestsUsed - count);
  if (callClaims && Number.isSafeInteger(callClaims.requests)) {
    callClaims.requests = Math.max(0, callClaims.requests - count);
  }
}

export function webSearchBudgetSnapshot(state: any, requestsThisCall: number = 0): { requestsThisCall: number; maxRequestsPerRun: any; requestsUsed: any; requestsRemaining: number; dispatchesUsed: any; maxDispatches: number; dispatchesRemaining: number } {
  const resolved = createWebSearchRunState(undefined, state);
  return {
    requestsThisCall,
    maxRequestsPerRun: resolved.maxRequests,
    requestsUsed: resolved.requestsUsed,
    requestsRemaining: Math.max(0, resolved.maxRequests - resolved.requestsUsed),
    dispatchesUsed: resolved.dispatchesUsed ?? 0,
    maxDispatches: resolved.maxRequests * 4,
    dispatchesRemaining: Math.max(0, resolved.maxRequests * 4 - (resolved.dispatchesUsed ?? 0)),
  };
}

export function deferWebSearchProvider(state: any, backend: any, retryAtMs: any): void {
  if (!isWebSearchRunState(state)) return;
  const current = state.deferredProviders.get(backend);
  const next = Number.isFinite(retryAtMs) ? retryAtMs : undefined;
  if (current === undefined || (next !== undefined && (current.retryAtMs === undefined || next > current.retryAtMs))) {
    state.deferredProviders.set(backend, { retryAtMs: next });
  }
}

export function deferredWebSearchProvider(state: any, backend: any): any {
  return isWebSearchRunState(state) ? state.deferredProviders.get(backend) : undefined;
}

function isWebSearchRunState(value: any) {
  return value?.schema === "mono-agent.web-search-run.v1"
    && Number.isSafeInteger(value.maxRequests)
    && value.maxRequests >= 1
    && value.maxRequests <= MAX_WEB_SEARCH_REQUESTS_PER_RUN
    && Number.isSafeInteger(value.requestsUsed)
    && value.requestsUsed >= 0
    && value.requestsUsed <= value.maxRequests
    && (value.dispatchesUsed === undefined || (Number.isSafeInteger(value.dispatchesUsed)
      && value.dispatchesUsed >= 0
      && value.dispatchesUsed <= value.maxRequests * 4))
    && value.deferredProviders instanceof Map;
}
