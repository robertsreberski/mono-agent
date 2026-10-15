import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { MonoAgentConfigError } from "@mono-agent/config";

/** Raw-config readers must reject the rename before any lifecycle mutation. */
export function assertNoOldSessionsRoot(json: unknown): void {
  const providers = (json as { providers?: { piNative?: unknown } } | undefined)?.providers;
  const native = providers?.piNative;
  if (native !== null && typeof native === "object" && Object.hasOwn(native, "piSessionsRoot")) {
    throw new MonoAgentConfigError("invalid_json",
      "providers.piNative.piSessionsRoot was renamed to runtime.session.root; move the value there",
      { path: "providers.piNative.piSessionsRoot" });
  }
}

/** Read-only preflight, before harness composition or any destructive purge. */
export async function assertSupportedSessionsRoot(root: string | undefined): Promise<void> {
  if (root === undefined) return;
  const path = join(root, "mono-v2");
  try { await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new MonoAgentConfigError("invalid_json",
    `Sessions root contains ${path}, written by a pre-release build; restore a backup or remove it after checking nothing in it is needed. No automatic migration is supported.`,
    { path: "runtime.session.root" });
}
