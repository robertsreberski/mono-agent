import { uniqueSessionHandles, type ProviderSessionHandle, type SessionRuntimeResolver } from "../session-runtime.js";
import type { RuntimeSessionRecord, RuntimeSessionStore } from "../sessions.js";
import type { AgentHarnessOptions } from "../types.js";

/**
 * Invalidates provider sessions attached to a turn that canonical host history
 * will not commit, then removes the confirmed warm mapping.
 */
export async function retireRunResultSession(
  options: AgentHarnessOptions,
  runtimeForSession: SessionRuntimeResolver,
  sessionStore: RuntimeSessionStore | undefined,
  sessionsEnabled: boolean,
  conversationId: string,
  sessionRecord: RuntimeSessionRecord | undefined,
  ...handles: readonly ProviderSessionHandle[]
): Promise<void> {
  if (!sessionsEnabled) return;
  for (const handle of uniqueSessionHandles([
    ...(sessionRecord === undefined ? [] : [sessionRecord]),
    ...handles,
  ])) {
    const id = handle.providerSessionId;
    const runtime = runtimeForSession(handle.modelKey);
    try {
      if (runtime.invalidateSession !== undefined) {
        await runtime.invalidateSession(id);
      } else {
        await runtime.disposeSession?.(id);
      }
    } catch {
      // Cleanup is best-effort; the host mapping is still evicted below.
    }
    if (options.piSessionsRoot !== undefined && runtime.retireDurableSession !== undefined) {
      try {
        await runtime.retireDurableSession(id, options.piSessionsRoot);
      } catch {
        // An open provider may still be unwinding. The canonical epoch has
        // already rotated; a returned provider result retries this cleanup.
      }
    }
  }
  if (sessionRecord !== undefined) {
    await sessionStore?.evict(conversationId, "stale", sessionRecord.providerSessionId);
  }
}
