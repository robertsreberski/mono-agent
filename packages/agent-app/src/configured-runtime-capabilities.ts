import type { MonoRuntimeLike } from "@mono-agent/runtime-adapter";

/** Private memory completion cannot expose storage methods outside its run lease. */
export function completionOnlyRuntime(runtime: MonoRuntimeLike): MonoRuntimeLike {
  const { recoverSession: _recoverSession, reconcileSessionTurn: _reconcileSessionTurn, ...completionRuntime } = runtime;
  return completionRuntime;
}
