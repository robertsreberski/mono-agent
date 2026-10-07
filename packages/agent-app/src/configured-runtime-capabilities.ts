import type { MonoRuntimeLike } from "@mono-agent/runtime-adapter";

/** Private memory completion cannot expose storage methods outside its run lease. */
export function completionOnlyRuntime(runtime: MonoRuntimeLike): MonoRuntimeLike {
  const { sessionTurnReconciliation: _sessionTurnReconciliation, recoverSession: _recoverSession, reconcileSessionTurn: _reconcileSessionTurn, nativePreparedDispatch: _nativePreparedDispatch, prepareNativeDispatch: _prepareNativeDispatch, ...completionRuntime } = runtime;
  return completionRuntime;
}
