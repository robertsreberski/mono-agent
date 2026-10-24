// @ts-check
// Request retry profiles for one assistant request on the native driver.
//
// Legacy layering (worst case per assistant request, per router attempt):
//   * pi-ai provider SDK retries (`piMaxRetries` = N) cover failures BEFORE a
//     response starts; Codex additionally falls back from websocket to SSE
//     before its first stream event.
//   * This policy covers transient failures AFTER the response started (the
//     provider emitted `start`), which the SDK layer never repeats. It never
//     retries a failure before `start`, so the two layers do not multiply on
//     the same pre-response error.
// Outage profile: adapter retries are zero; the driver owns connection/server
// recovery in both phases, with disjoint short HTTP retries at the fetch seam.
// A failed assistant message never executes tools and live input is only
// consumed between requests, so the retried request repeats no effect.

import { retryableProviderFailureInfo } from "../../telemetry/failure.js";
import { normalizePiErrorMessage } from "../../providers/pi/errors.js";
import { failureKindForPiError } from "./result-builder.js";
import { attributedCauseCode, createRequestObserver, TERMINAL_PROVIDER_ERROR } from "../../providers/pi/request-attempt.js";

/** Additional attempts after a mid-stream failure (inherited Pi harness value). */
const REQUEST_RETRY_LIMIT = 3;
/** First backoff; doubles per retry (1 s, 2 s, 4 s). */
const REQUEST_RETRY_BASE_DELAY_MS = 1000;

// Account/limit states that a few seconds cannot fix, even when a provider
// phrases them like a transient throttle.
const NEVER_RETRY_RE = /usage[_ ]limit|insufficient[_ ]quota|quota[_ ]exceeded|billing|out of budget|available balance|max(?:imum)?(?:[_ ]output)?[_ ]tokens?|max turns/i;
const NEVER_RETRY_SUBKINDS = new Set(["context_limit", "subscription_limit", "non_retryable"]);

/**
 * Whether a failed assistant request is a transient transport/server failure
 * (websocket error/close, connection reset, terminated or prematurely closed
 * stream, timeout, overloaded/5xx/429). Auth, quota/usage limits, context
 * limits, safety failures and validation errors are never transient.
 */
export function isTransientRequestFailure(errorText: string | null | undefined): boolean {
  const text = normalizePiErrorMessage(errorText);
  if (!text || NEVER_RETRY_RE.test(text)) return false;
  if (failureKindForPiError(text, {}) !== "provider_unavailable") return false;
  const info = retryableProviderFailureInfo({ errorText: text, failureKind: "provider_unavailable" });
  return info.retryable && !NEVER_RETRY_SUBKINDS.has(info.subkind ?? "");
}

/**
 * Driver retry policy for one turn. `piMaxRetries: 0` disables it with the SDK
 * layer; provider checks stay single-shot.
 */
export function requestRetryPolicy({ maxRetries, maxRetryDelayMs, providerCheck, retryBudgetMs = 0 }: {
    maxRetries: number;
    maxRetryDelayMs: number;
    providerCheck: boolean;
    retryBudgetMs?: number;
}) {
  const enabled = maxRetries > 0 && !providerCheck;
  if (enabled && Number.isFinite(retryBudgetMs) && retryBudgetMs > 0) {
    return {
      enabled: true, outage: true, maxRetries: 16, baseDelayMs: 1000, maxDelayMs: Math.min(20_000, maxRetryDelayMs),
      shouldRetry: (message: any, _phase: { responseStarted: boolean }) => isTransientRequestFailure(message?.errorMessage),
      // A fresh controller for EACH assistant request, not for each turn/attempt.
      createRequest: () => outageRequestPolicy(maxRetries, maxRetryDelayMs, Math.min(180_000, retryBudgetMs)),
    };
  }
  return {
    enabled,
    maxRetries: enabled ? REQUEST_RETRY_LIMIT : 0,
    baseDelayMs: REQUEST_RETRY_BASE_DELAY_MS,
    maxDelayMs: maxRetryDelayMs,
    shouldRetry: (message: any, { responseStarted }: { responseStarted: boolean; }) => responseStarted && isTransientRequestFailure(message?.errorMessage),
  };
}

function outageRequestPolicy(shortRetries: number, maxRetryDelayMs: number, budgetMs: number) {
  const observer = createRequestObserver({ maxRetries: shortRetries, maxRetryDelayMs });
  const startedAt = Date.now();
  let recoveryStartedAt: number | undefined;
  return {
    enabled: true, maxRetries: 16, baseDelayMs: 1000, maxDelayMs: Math.min(20_000, maxRetryDelayMs),
    fetch: observer.fetch,
    beforeAttempt: observer.reset,
    shouldRetry(message: any, _phase: { responseStarted: boolean }) {
      const seen = observer.snapshot();
      const text = normalizePiErrorMessage(message?.errorMessage) || "";
      if (seen.veto || seen.delayLimit || seen.shortPolicy || seen.terminal || TERMINAL_PROVIDER_ERROR.test(text)
        || /\b429\b|rate.?limit|too many requests/i.test(text)
        || failureKindForPiError(text, {}) !== "provider_unavailable") return false;
      if (seen.status !== undefined && seen.status >= 400 && seen.status < 500) return false;
      // SDKs flatten even invalid fetch arguments to "Connection error.". Do not
      // turn an observed programming/config error into an outage on that basis.
      if (seen.httpPhase === "pre-response" && !seen.transportFailure && !/timed? ?out|ETIMEDOUT/i.test(text)) return false;
      // Text alone is all APIConnectionError sometimes leaves us. Actual fetch
      // and body read failures are also positive request-attributed evidence.
      const eligible = seen.transportFailure || seen.bodyFailure || (seen.status !== undefined && seen.status >= 500)
        || (!/429|rate.?limit/i.test(text) && (isTransientRequestFailure(text) || /fetch failed|\bEPIPE\b/i.test(text)));
      if (eligible) recoveryStartedAt ??= Date.now();
      return eligible;
    },
    retryDelay(retry: number) {
      const remaining = budgetMs - (Date.now() - (recoveryStartedAt ?? Date.now()));
      const serverDelay = observer.snapshot().serverDelayMs ?? 0;
      if (remaining <= 1 || serverDelay >= remaining) return null;
      const delay = Math.max(serverDelay,
        Math.min(1000 * 2 ** (retry - 1), 20_000, maxRetryDelayMs) * (1 - Math.random() * 0.25));
      // Use the tail of the window too, without starting at/after expiry or
      // violating a provider's lower bound. Recheck the clock after sleeping.
      return Math.max(serverDelay, Math.min(delay, remaining - 1));
    },
    canStartAttempt: () => recoveryStartedAt === undefined || Date.now() - recoveryStartedAt < budgetMs,
    finish(message: any, { responseStarted, attempts, reason }: { responseStarted: boolean; attempts: number; reason: string }) {
      if (message.stopReason !== "error") return message;
      const seen = observer.snapshot();
      // Codex's request-local websocket diagnostic may retain a DIRECT code,
      // but global undici correlation is deliberately never consulted here.
      const transport = message.diagnostics?.findLast((entry: any) => entry.type === "provider_transport_failure");
      const cause = seen.cause ?? attributedCauseCode(transport?.error) ?? "unknown";
      const suffix = `[provider_retry phase=${responseStarted ? "post-response" : "pre-response"} http=${seen.httpPhase}`
        + ` attempts=${attempts} http_sends=${observer.sends()} elapsed_ms=${Math.max(0, Date.now() - startedAt)} cause=${cause} exhausted=${seen.delayLimit ? "delay_limit" : reason}]`;
      return { ...message, errorMessage: `${message.errorMessage || "Unknown provider error"} ${suffix}` };
    },
  };
}
