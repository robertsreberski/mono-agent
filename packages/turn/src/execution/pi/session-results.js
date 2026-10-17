// @ts-check
import * as storage from "../../engine/sessions.js";
import { validateNativeSessionAuthority } from "./session-options.js";

function sessionUnavailableResult({
  resolved,
  options,
  events,
  runtimeWarnings,
  start,
  sessionId,
  errorMessage,
  failureKind,
  piErrorCode,
  piTransport,
}) {
  return {
    text: null,
    events,
    usage: {},
    durationMs: Date.now() - start,
    numTurns: 0,
    model: resolved?.reference || (resolved?.provider && resolved?.model ? `${resolved.provider}:${resolved.model}` : null),
    effort: options.effort || null,
    sdk: "pi",
    cancelled: false,
    error: errorMessage,
    failureKind,
    providerSessionId: sessionId,
    runtimeWarnings,
    diagnostics: {
      provider_session_id: sessionId,
      pi_error_code: piErrorCode,
      pi_engine: "native",
      pi_transport_requested: piTransport,
    },
  };
}


/** @param {any} state @param {any} params
 * @returns {Promise<{done:true,result:any}|{done:false}>} */
export async function resolveSession(state, params) {
  const { options, requestedSessionId, providerSessionId, durableRepo, sessionTtlMs, cwd } = params;
  validateNativeSessionAuthority(options, providerSessionId, requestedSessionId);
  const outcome = await storage.resolveSession(state, { requestedSessionId, providerSessionId, durableRepo, sessionTtlMs, cwd,
    access: options.nativeSessionAuthority, projection: options.nativeSessionProjection,
    waitSignal: options.abortSignal instanceof AbortSignal ? options.abortSignal : undefined,
    keepAlive: options.sessionKeepAlive, requireExisting: !!options.sessionTurn?.reconciliation && options.sessionTurn.baseRevision > 0 });
  if (outcome.status === "ready") return { done: false };
  const { sessionId, message: errorMessage, failureKind, code: piErrorCode } = outcome.unavailable;
  return { done: true, result: sessionUnavailableResult({ ...params, sessionId, errorMessage, failureKind, piErrorCode }) };
}
/** @param {any} state @param {any} params */
export async function commitSession(state, { options, requestedSessionId, providerSessionId, durableRepo, sessionTtlMs, externalAbort, errorMessage, onEvent }) {
  const { persistFailure } = await storage.commitSession(state, { requestedSessionId, providerSessionId, durableRepo, sessionTtlMs,
    keepAlive: options.sessionKeepAlive, externalAbort, failed: !!errorMessage });
  if (persistFailure) onEvent({ type: "runtime_warning", warning_kind: "pi_session_persist_failed", message: persistFailure.message });
}
/** @param {any} state @param {any} params */
export async function captureSessionRecovery(state, { options, providerSessionId, modelKey, model, pending }) {
  const outcome = await storage.captureSessionRecovery(state, { identity: { runId: options.sessionRecovery.runId, revision: options.sessionRecovery.revision, providerSessionId, modelKey },
    model, pending, abortSignal: options.abortSignal });
  return outcome.status === "captured" ? outcome.receipt : undefined;
}
/** @param {any} state @param {any} params */
export async function discardUncommittedSession(state, params) { await storage.discardUncommittedSession(state, params); }
/** @param {any} state @param {any} params */
export async function rollbackAbortedTurn(state, params) { await storage.rollbackAbortedTurn(state, params); }
/** @param {any} state @param {any} params */
export async function cleanupSessionOnThrow(state, params) { await storage.cleanupSessionOnThrow(state, params); }
