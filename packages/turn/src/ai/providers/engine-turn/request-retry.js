// @ts-check
// Mid-stream retry policy for one assistant request on the native driver.
//
// Layering (worst case per assistant request, per router attempt):
//   * pi-ai provider SDK retries (`piMaxRetries` = N) cover failures BEFORE a
//     response starts; Codex additionally falls back from websocket to SSE
//     before its first stream event.
//   * This policy covers transient failures AFTER the response started (the
//     provider emitted `start`), which the SDK layer never repeats. It never
//     retries a failure before `start`, so the two layers do not multiply on
//     the same pre-response error.
// A failed assistant message never executes tools and live input is only
// consumed between requests, so the retried request repeats no effect.

import { retryableProviderFailureInfo } from "../../failure.js";
import { normalizePiErrorMessage } from "../pi-errors.js";
import { failureKindForPiError } from "./result-builder.js";

/** Additional attempts after a mid-stream failure (inherited Pi harness value). */
export const REQUEST_RETRY_LIMIT = 3;
/** First backoff; doubles per retry (1 s, 2 s, 4 s). */
export const REQUEST_RETRY_BASE_DELAY_MS = 1000;

// Account/limit states that a few seconds cannot fix, even when a provider
// phrases them like a transient throttle.
const NEVER_RETRY_RE = /usage[_ ]limit|insufficient[_ ]quota|quota[_ ]exceeded|billing|out of budget|available balance|max(?:imum)?(?:[_ ]output)?[_ ]tokens?|max turns/i;
const NEVER_RETRY_SUBKINDS = new Set(["context_limit", "subscription_limit", "non_retryable"]);

/**
 * Whether a failed assistant request is a transient transport/server failure
 * (websocket error/close, connection reset, terminated or prematurely closed
 * stream, timeout, overloaded/5xx/429). Auth, quota/usage limits, context
 * limits, safety failures and validation errors are never transient.
 * @param {string|null|undefined} errorText
 * @returns {boolean}
 */
export function isTransientRequestFailure(errorText) {
  const text = normalizePiErrorMessage(errorText);
  if (!text || NEVER_RETRY_RE.test(text)) return false;
  if (failureKindForPiError(text, {}) !== "provider_unavailable") return false;
  const info = retryableProviderFailureInfo({ errorText: text, failureKind: "provider_unavailable" });
  return info.retryable && !NEVER_RETRY_SUBKINDS.has(info.subkind ?? "");
}

/**
 * Driver retry policy for one turn. `piMaxRetries: 0` disables it with the SDK
 * layer; provider checks stay single-shot.
 * @param {{maxRetries: number, maxRetryDelayMs: number, providerCheck: boolean}} params
 */
export function requestRetryPolicy({ maxRetries, maxRetryDelayMs, providerCheck }) {
  const enabled = maxRetries > 0 && !providerCheck;
  return {
    enabled,
    maxRetries: enabled ? REQUEST_RETRY_LIMIT : 0,
    baseDelayMs: REQUEST_RETRY_BASE_DELAY_MS,
    maxDelayMs: maxRetryDelayMs,
    /** @param {any} message @param {{responseStarted: boolean}} attempt */
    shouldRetry: (message, { responseStarted }) => responseStarted && isTransientRequestFailure(message?.errorMessage),
  };
}
