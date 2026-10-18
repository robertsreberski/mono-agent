import { createSessionRegistry as createRegistry } from "../engine/session-registry.js";
import { nativeSessionRegistry } from "../engine/session-lifecycle.js";
const allRegistries = new Set([nativeSessionRegistry]);
/**
 * @coreScanRetained
 */
export function createSessionRegistry(options?: Parameters<typeof createRegistry>[0]): ReturnType<typeof createRegistry> {
  const registry = createRegistry(options); allRegistries.add(registry); return registry;
}

export async function disposeProviderSession(providerSessionId: unknown): Promise<boolean> {
  if (typeof providerSessionId !== "string" || !providerSessionId.trim()) return false;
  let disposed = false;
  for (const registry of allRegistries) {
    if (await registry.dispose(providerSessionId)) disposed = true;
  }
  return disposed;
}

/**
 * Flush provider-owned durable session state after a successful run and before
 * the host commits canonical history. Providers without durable live state
 * acknowledge the barrier immediately; provider sync errors propagate.
 */
export async function syncProviderSession(providerSessionId: unknown): Promise<boolean> {
  if (typeof providerSessionId !== "string" || !providerSessionId.trim()) return false;
  let synced = false;
  for (const registry of allRegistries) {
    if (await registry.sync(providerSessionId)) synced = true;
  }
  return synced;
}

/**
 * Guarantee that no provider registry can reuse process-local state for this
 * id. Durable provider transcripts are preserved so the next resume reopens
 * them from disk. Absence is success; cleanup failure rejects.
 */
export async function refreshProviderSession(providerSessionId: unknown): Promise<void> {
  if (typeof providerSessionId !== "string" || !providerSessionId.trim()) {
    throw new TypeError("providerSessionId must be a non-empty string");
  }
  for (const registry of allRegistries) {
    await registry.refresh(providerSessionId);
  }
}

/**
 * Irreversibly discard a provider session whose transcript is not represented
 * by canonical host history. Unlike ordinary disposal, providers with durable
 * session caches must remove the persisted transcript as well as the live
 * registry entry.
 */
export async function invalidateProviderSession(providerSessionId: unknown): Promise<boolean> {
  if (typeof providerSessionId !== "string" || !providerSessionId.trim()) return false;
  let invalidated = false;
  for (const registry of allRegistries) {
    if (await registry.invalidate(providerSessionId)) invalidated = true;
  }
  return invalidated;
}

export async function disposeAllProviderSessions(): Promise<void> {
  for (const registry of allRegistries) {
    await registry.disposeAll();
  }
}
