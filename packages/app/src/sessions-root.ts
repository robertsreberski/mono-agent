import { probeUnsupportedSessionsRoot } from "@mono-agent/turn/host";
import { hasRetiredPiSessionsRoot, MonoAgentConfigError } from "@mono-agent/config";

/** Raw-config readers must reject the rename before any lifecycle mutation. */
export function assertNoOldSessionsRoot(json: unknown): void {
  const providers = (json as { providers?: { piNative?: unknown } } | undefined)?.providers;
  const native = providers?.piNative;
  if (hasRetiredPiSessionsRoot(native)) {
    throw new MonoAgentConfigError("invalid_json",
      "providers.piNative.piSessionsRoot was renamed to runtime.session.root; move the value there",
      { path: "providers.piNative.piSessionsRoot" });
  }
}

/** Read-only preflight, before harness composition or any destructive purge. */
export async function assertSupportedSessionsRoot(root: string | undefined): Promise<void> {
  if (root === undefined) return;
  const path = await probeUnsupportedSessionsRoot(root);
  if (path === undefined) return;
  throw new MonoAgentConfigError("invalid_json",
    `Sessions root contains ${path}, written by a pre-release build; restore a backup or remove it after checking nothing in it is needed. No automatic migration is supported.`,
    { path: "runtime.session.root" });
}
