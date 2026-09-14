import { createHash } from "node:crypto";
import { createPiOAuthApiKeyResolver } from "@mono-agent/agent-runtime";
import {
  PROVIDER_USAGE_ERRORS, PROVIDER_USAGE_IDS, PROVIDER_USAGE_LABELS, PROVIDER_USAGE_SCHEMA,
  type ProviderUsage, type ProviderUsageErrorCode, type ProviderUsageId, type ProviderUsageOperator,
} from "@mono-agent/agent-contracts";
import { mapProviderUsage, usageRecord } from "./provider-usage-mappers.js";

export const PROVIDER_USAGE_CACHE_MS = 300_000;
const URLS = {
  anthropic: "https://api.anthropic.com/api/oauth/usage",
  "openai-codex": "https://chatgpt.com/backend-api/wham/usage",
  "opencode-go": "https://opencode.ai/zen/go/v1/usage",
};
type Resolver = ReturnType<typeof createPiOAuthApiKeyResolver>;
type Credential = NonNullable<Awaited<ReturnType<NonNullable<Resolver["readCredential"]>>>>;
interface Entry { identity: string; value?: ProviderUsage; nextAt: number; flight?: Promise<ProviderUsage | undefined> }
class UsageFailure extends Error {
  constructor(readonly code: ProviderUsageErrorCode, readonly retryAt?: number) { super(PROVIDER_USAGE_ERRORS[code]); }
}
function identity(credential: Credential): string {
  // Private in-memory equality key, never persisted or returned.
  return createHash("sha256").update(JSON.stringify(credential)).digest("hex");
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function usable(provider: ProviderUsageId, credential: Credential | undefined, now: number): credential is Credential {
  if (!credential) return false;
  if (provider === "opencode-go") return credential.type === "api_key" && nonempty(credential.key);
  return credential.type === "oauth" && Number.isFinite(credential.expires)
    && (nonempty(credential.refresh) || (nonempty(credential.access) && credential.expires > now));
}
async function readBody(response: Response): Promise<unknown> {
  if (!response.body) throw new UsageFailure("invalid_response");
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 128 * 1024) throw new UsageFailure("invalid_response");
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw new UsageFailure("invalid_response"); }
  } finally { await reader.cancel().catch(() => undefined); }
}
export function createProviderUsageService(options: {
  readonly path?: string;
  readonly resolver?: Resolver;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}): ProviderUsageOperator & { stop(): void } {
  const resolver = options.resolver ?? createPiOAuthApiKeyResolver({ ...(options.path === undefined ? {} : { path: options.path }) });
  const now = options.now ?? Date.now;
  const request = options.fetch ?? fetch;
  const entries = new Map<ProviderUsageId, Entry>();
  const lifetime = new AbortController();
  async function credentialFor(provider: ProviderUsageId) {
    try { return await resolver.readCredential?.(provider); }
    catch { return undefined; } // No usable credential evidence; never expose auth-file errors.
  }
  async function refresh(provider: ProviderUsageId, entry: Entry, initial: Credential): Promise<ProviderUsage | undefined> {
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)]);
    let credential = initial;
    try {
      let token = credential.type === "api_key" ? credential.key : credential.access;
      if (credential.type === "oauth" && (!nonempty(token) || credential.expires <= now())) {
        try { token = await resolver(provider, { signal }); }
        catch { throw new UsageFailure("auth_failed"); }
        credential = await credentialFor(provider) ?? credential;
        if (credential.type === "oauth" && nonempty(credential.access)) token = credential.access;
        entry.identity = identity(credential);
      }
      if (!nonempty(token)) throw new UsageFailure("auth_failed");
      let response: Response | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        signal.throwIfAborted();
        const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
        if (provider === "openai-codex" && credential.type === "oauth" && nonempty(credential.accountId)) headers["ChatGPT-Account-Id"] = credential.accountId;
        if (provider === "anthropic") Object.assign(headers, { "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.69" });
        response = await request(URLS[provider], { method: "GET", headers, signal, redirect: "error" });
        if (attempt === 0 && provider !== "opencode-go" && (response.status === 401 || response.status === 403)) {
          await response.body?.cancel();
          try { token = await resolver(provider, { rejectedAccessToken: token, signal }); }
          catch { throw new UsageFailure("auth_failed"); }
          credential = await credentialFor(provider) ?? credential;
          if (credential.type === "oauth" && nonempty(credential.access)) token = credential.access;
          entry.identity = identity(credential);
          if (!nonempty(token)) throw new UsageFailure("auth_failed");
          continue;
        }
        break;
      }
      if (!response) throw new UsageFailure("unavailable");
      if (response.status === 429) {
        const header = response.headers.get("retry-after");
        const seconds = header !== null && /^\d+(\.\d+)?$/.test(header) ? Number(header) : NaN;
        const until = Number.isFinite(seconds) ? now() + seconds * 1000 : header ? Date.parse(header) : NaN;
        await response.body?.cancel();
        throw new UsageFailure("rate_limited", Math.max(now() + PROVIDER_USAGE_CACHE_MS, Number.isFinite(until) ? until : 0));
      }
      if (response.status === 403 && provider === "opencode-go") {
        const body = await readBody(response).catch(() => undefined);
        throw new UsageFailure(usageRecord(usageRecord(body).error).type === "EntitlementError" ? "not_entitled" : "auth_failed");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new UsageFailure(response.status === 401 || response.status === 403 ? "auth_failed" : "unavailable");
      }
      const body = await readBody(response);
      let mapped: ReturnType<typeof mapProviderUsage>;
      try { mapped = mapProviderUsage(provider, body, response.headers, now()); }
      catch { throw new UsageFailure("invalid_response"); }
      signal.throwIfAborted();
      entry.value = { providerId: provider, label: PROVIDER_USAGE_LABELS[provider], ...mapped, fetchedAt: new Date(now()).toISOString(), stale: false };
      entry.nextAt = now() + PROVIDER_USAGE_CACHE_MS;
    } catch (caught) {
      const failure = signal.aborted ? new UsageFailure("timeout") : caught instanceof UsageFailure ? caught : new UsageFailure("network_failed");
      entry.nextAt = failure.retryAt ?? now() + PROVIDER_USAGE_CACHE_MS;
      const previous = entry.value;
      entry.value = {
        providerId: provider, label: PROVIDER_USAGE_LABELS[provider], windows: previous?.windows ?? [],
        ...(previous?.plan === undefined ? {} : { plan: previous.plan }),
        fetchedAt: previous?.fetchedAt ?? new Date(now()).toISOString(), stale: previous !== undefined && previous.windows.length > 0,
        error: { code: failure.code, message: PROVIDER_USAGE_ERRORS[failure.code] },
      };
    }
    // Removed/replaced credentials must not disclose another account's cached usage.
    const current = await credentialFor(provider);
    if (lifetime.signal.aborted || !current || identity(current) !== entry.identity) {
      if (entries.get(provider) === entry) entries.delete(provider);
      return undefined;
    }
    return entry.value;
  }
  async function read(provider: ProviderUsageId): Promise<ProviderUsage | undefined> {
    if (lifetime.signal.aborted) return undefined;
    const credential = await credentialFor(provider);
    if (!usable(provider, credential, now())) {
      if (!entries.get(provider)?.flight) entries.delete(provider);
      return undefined;
    }
    const key = identity(credential);
    let entry = entries.get(provider);
    if (entry?.flight && entry.identity !== key) {
      await entry.flight; // never overlap fetches, even across credential rotation
      return read(provider);
    }
    if (!entry || entry.identity !== key) { entry = { identity: key, nextAt: 0 }; entries.set(provider, entry); }
    if (entry.value && now() < entry.nextAt) return structuredClone(entry.value);
    if (!entry.flight) {
      const owned = entry;
      owned.flight = refresh(provider, owned, credential).finally(() => { delete owned.flight; });
    }
    if (entry.value?.windows.length) return { ...structuredClone(entry.value), stale: true };
    const value = await entry.flight;
    return value === undefined ? undefined : structuredClone(value);
  }
  return {
    async snapshot(provider) {
      const results = await Promise.all((provider === undefined ? PROVIDER_USAGE_IDS : [provider]).map(read));
      return { schema: PROVIDER_USAGE_SCHEMA, providers: results.filter((p): p is ProviderUsage => p !== undefined) };
    },
    stop() { lifetime.abort(); entries.clear(); },
  };
}
