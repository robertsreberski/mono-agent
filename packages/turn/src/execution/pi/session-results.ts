type SessionParams = { options: import("./types.js").PiOptions; requestedSessionId: string | null; providerSessionId: string; durableRepo: any; sessionTtlMs?: number; cwd?: string; resolved: any; events: any[]; runtimeWarnings: import("./types.js").PiWarning[]; start: number; piTransport: string };
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
}: { resolved: any; options: import("./types.js").PiOptions; events: any[]; runtimeWarnings: import("./types.js").PiWarning[]; start: number; sessionId: string; errorMessage: string; failureKind: string; piErrorCode: string; piTransport: string }) {
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

export function resolveSession(state: any, params: any): Promise<{
    done: true;
    result: any;
} | {
    done: false;
}>;
export async function resolveSession(state: import("./types.js").PiRunState, params: SessionParams) {
  const { options, requestedSessionId, providerSessionId, durableRepo, sessionTtlMs, cwd } = params;
  validateNativeSessionAuthority(options, providerSessionId, requestedSessionId);
  const outcome = await storage.resolveSession(state as Parameters<typeof storage.resolveSession>[0], { requestedSessionId, providerSessionId, durableRepo, sessionTtlMs, cwd,
    access: options.nativeSessionAuthority, projection: options.nativeSessionProjection,
    waitSignal: options.abortSignal instanceof AbortSignal ? options.abortSignal : undefined,
    keepAlive: options.sessionKeepAlive, requireExisting: !!options.sessionTurn?.reconciliation && options.sessionTurn.baseRevision! > 0 } as Parameters<typeof storage.resolveSession>[1]);
  if (outcome.status === "ready") return { done: false };
  const { sessionId, message: errorMessage, failureKind, code: piErrorCode } = outcome.unavailable;
  return { done: true, result: sessionUnavailableResult({ ...params, sessionId, errorMessage, failureKind, piErrorCode }) };
}
export function commitSession(state: any, { options, requestedSessionId, providerSessionId, durableRepo, sessionTtlMs, externalAbort, errorMessage, onEvent }: any): Promise<void>;
export async function commitSession(state: import("./types.js").PiRunState, { options, requestedSessionId, providerSessionId, durableRepo, sessionTtlMs, externalAbort, errorMessage, onEvent }: SessionParams & { externalAbort?: boolean; errorMessage?: string | null; onEvent: import("./types.js").PiEventSink }): Promise<void> {
  const { persistFailure } = await storage.commitSession(state as Parameters<typeof storage.commitSession>[0], { requestedSessionId, providerSessionId, durableRepo, sessionTtlMs,
    keepAlive: options.sessionKeepAlive, externalAbort, failed: !!errorMessage } as Parameters<typeof storage.commitSession>[1]);
  if (persistFailure) onEvent({ type: "runtime_warning", warning_kind: "pi_session_persist_failed", message: persistFailure.message });
}

export async function captureSessionRecovery(state: any, { options, providerSessionId, modelKey, model, pending }: any) {
  const outcome = await storage.captureSessionRecovery(state, { identity: { runId: options.sessionRecovery.runId, revision: options.sessionRecovery.revision, providerSessionId, modelKey },
    model, pending, abortSignal: options.abortSignal });
  return outcome.status === "captured" ? outcome.receipt : undefined;
}
export async function discardUncommittedSession(state: any, params: any): Promise<void> { await storage.discardUncommittedSession(state, params); }
export async function rollbackAbortedTurn(state: any, params: any): Promise<void> { await storage.rollbackAbortedTurn(state, params); }
export async function cleanupSessionOnThrow(state: any, params: any): Promise<void> { await storage.cleanupSessionOnThrow(state, params); }
