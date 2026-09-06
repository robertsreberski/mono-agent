// @ts-check

/** One deadline covers admission, backend startup, I/O, and retries. */
export async function withWebDeadline(signal, milliseconds, execute) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(Object.assign(new Error("Web request deadline exceeded."), { code: "deadline_exceeded" })), milliseconds);
  try { return await execute(controller.signal); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

export async function coordinatedWebRequest(coordinator, kind, key, signal, execute, classify = classifySearch) {
  signal?.throwIfAborted();
  const permit = coordinator ? await coordinator.acquire({ kind, key, signal, deadlineMs: Date.now() + (kind === "fetch" ? 45_000 : 60_000) }) : undefined;
  const started = Date.now();
  try {
    signal?.throwIfAborted();
    const value = await execute();
    const completion = await permit?.complete(signal?.aborted ? { status: "cancelled" } : classify(value));
    const persistedCooldown = value?.rateLimited ? completion : undefined;
    return {
      ...value,
      ...(Number.isFinite(persistedCooldown?.retryAfterMs) ? { retryAfterMs: persistedCooldown.retryAfterMs } : {}),
      ...(Number.isFinite(persistedCooldown?.retryAtMs) ? { retryAtMs: persistedCooldown.retryAtMs } : {}),
      coordinationWaitMs: permit?.waitMs ?? 0,
      backendDurationMs: Date.now() - started,
    };
  } catch (error) {
    // A run-local budget refusal happens after admission but before a provider
    // request. Release the lease without teaching the shared host coordinator
    // that the provider failed.
    await permit?.complete({
      status: signal?.aborted || error?.code === "search_budget_exhausted"
        ? "cancelled"
        : "unavailable",
    });
    throw error;
  }
}

function classifySearch(result) {
  return {
    status: result.rateLimited ? "rate_limited" : result.ok ? "ok" : result.retryable ? "unavailable" : "cancelled",
    ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
    ...(result.retryAtMs === undefined ? {} : { retryAtMs: result.retryAtMs }),
  };
}

export function webRequestFailure(error, backend, signal) {
  const code = signal?.aborted ? (signal.reason?.code === "deadline_exceeded" ? "deadline_exceeded" : "aborted") : error?.code;
  return {
    ok: false, backend, code: code || "backend_unavailable",
    message: code === "coordination_unavailable" ? "Web request coordination is unavailable."
      : code === "rate_limited" ? `${backend} is cooling down.`
        : code === "search_budget_exhausted" ? "WebSearch request budget exhausted for this run."
        : code === "deadline_exceeded" ? "Web request deadline exceeded."
          : code === "aborted" ? "Web request was aborted." : `${backend} request unavailable.`,
    retryable: !["aborted", "search_budget_exhausted"].includes(code),
    cooldown: code === "rate_limited", rateLimited: code === "rate_limited",
    retryAfterMs: error?.retryAfterMs,
    retryAtMs: error?.retryAtMs,
  };
}
