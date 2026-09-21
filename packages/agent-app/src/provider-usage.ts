import { createCopilotCredentialDiscovery } from "./copilot-usage-credentials.js";
import { createHash } from "node:crypto";
import { createPiOAuthApiKeyResolver } from "@mono-agent/agent-runtime";
import {
  PROVIDER_USAGE_ERRORS, PROVIDER_USAGE_IDS, PROVIDER_USAGE_LABELS, PROVIDER_USAGE_SCHEMA,
  type ProviderUsage, type ProviderUsageErrorCode, type ProviderUsageId, type ProviderUsageOperator,
} from "@mono-agent/agent-contracts";
import type { ProviderAuthObservationTracker } from "./provider-auth-observations.js";
import { mapProviderUsage, usageRecord } from "./provider-usage-mappers.js";

export const PROVIDER_USAGE_CACHE_MS = 300_000;
const URLS = {
  anthropic: "https://api.anthropic.com/api/oauth/usage",
  "openai-codex": "https://chatgpt.com/backend-api/wham/usage",
  "opencode-go": "https://opencode.ai/zen/go/v1/usage",
  "github-copilot": "https://api.github.com/copilot_internal/user",
};
type Resolver = ReturnType<typeof createPiOAuthApiKeyResolver>;
type Credential = NonNullable<Awaited<ReturnType<NonNullable<Resolver["readCredential"]>>>>;
interface SelectedCredential { readonly credential: Credential; readonly source: "pi" | "local" }
interface Entry { identity: string; value?: ProviderUsage; nextAt: number; flight?: Promise<ProviderUsage | undefined> }
class UsageFailure extends Error {
  constructor(readonly code: ProviderUsageErrorCode, readonly retryAt?: number) { super(PROVIDER_USAGE_ERRORS[code]); }
}
/** Match Pi 0.86.1 normalizeDomain, but reject malformed persisted markers instead of defaulting them. */
function copilotHost(marker: unknown): string | undefined {
  if (marker === undefined) return "github.com";
  if (typeof marker !== "string") return undefined;
  const trimmed = marker.trim();
  if (!trimmed) return "github.com";
  try { return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname || undefined; }
  catch { return undefined; }
}
function identity(provider: ProviderUsageId, selected: SelectedCredential): string {
  // Private in-memory equality key, never persisted or returned.
  const { credential, source } = selected;
  const value = provider === "github-copilot" && source === "pi" && credential.type === "oauth"
    ? { source, type: credential.type, refresh: credential.refresh, host: copilotHost(credential.enterpriseUrl) }
    : selected;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function usable(provider: ProviderUsageId, selected: SelectedCredential | undefined, now: number): selected is SelectedCredential {
  if (!selected) return false;
  const { credential } = selected;
  if (provider === "opencode-go" || provider === "github-copilot" && credential.type === "api_key") return credential.type === "api_key" && nonempty(credential.key);
  if (provider === "github-copilot") return credential.type === "oauth" && nonempty(credential.refresh)
    && copilotHost(credential.enterpriseUrl) === "github.com";
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
  /** Private local lookup seam; never used when a Pi Copilot credential exists. */
  readonly copilotCredential?: () => Promise<string | undefined>;
  readonly timeoutMs?: number;
  /** Passive evidence only, once per retained vendor fetch (never on cache reads). */
  readonly outcomes?: Pick<ProviderAuthObservationTracker, "generation" | "recordAccountSuccess" | "recordAccountFailure">;
}): Required<ProviderUsageOperator> & { stop(): void } {
  const resolver = options.resolver ?? createPiOAuthApiKeyResolver({ ...(options.path === undefined ? {} : { path: options.path }) });
  const now = options.now ?? Date.now;
  const request = options.fetch ?? fetch;
  const localCopilot = options.copilotCredential ?? createCopilotCredentialDiscovery();
  const entries = new Map<ProviderUsageId, Entry>();
  const lifetime = new AbortController();
  async function piCredentialFor(provider: ProviderUsageId): Promise<SelectedCredential | null | undefined> {
    try {
      const credential = await resolver.readCredential?.(provider);
      return credential === undefined ? undefined : { credential, source: "pi" };
    } catch { return null; } // Unknown ownership, not proven absence; never expose auth-file errors.
  }
  async function credentialFor(provider: ProviderUsageId): Promise<SelectedCredential | undefined> {
    const pi = await piCredentialFor(provider);
    if (pi === null) return undefined;
    // Presence owns the account even when unusable; never pair it with an unrelated local login.
    if (provider !== "github-copilot" || pi !== undefined) return pi;
    try {
      const key = await localCopilot();
      return nonempty(key) ? { credential: { type: "api_key", key }, source: "local" } : undefined;
    } catch { return undefined; }
  }
  async function refresh(provider: ProviderUsageId, entry: Entry, initial: SelectedCredential): Promise<ProviderUsage | undefined> {
    const generation = initial.source === "local" ? undefined : options.outcomes?.generation();
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)]);
    let selected = initial;
    let { credential } = selected;
    try {
      // Pi's refresh is the GitHub device token; access/expiry/catalog belong to inference only.
      let token = credential.type === "api_key" ? credential.key : provider === "github-copilot" ? credential.refresh : credential.access;
      if (provider !== "github-copilot" && selected.source === "pi" && credential.type === "oauth" && (!nonempty(token) || credential.expires <= now())) {
        try { token = await resolver(provider, { signal }); }
        catch { throw new UsageFailure("auth_failed"); }
        selected = await piCredentialFor(provider) ?? selected;
        credential = selected.credential;
        if (credential.type === "oauth" && nonempty(credential.access)) token = credential.access;
        entry.identity = identity(provider, selected);
      }
      if (!nonempty(token)) throw new UsageFailure("auth_failed");
      let response: Response | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        signal.throwIfAborted();
        const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
        if (provider === "openai-codex" && credential.type === "oauth" && nonempty(credential.accountId)) headers["ChatGPT-Account-Id"] = credential.accountId;
        if (provider === "anthropic") Object.assign(headers, { "Content-Type": "application/json", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.69" });
        if (provider === "github-copilot") Object.assign(headers, {
          Authorization: `token ${token}`, "Editor-Version": "vscode/1.96.2",
          "Editor-Plugin-Version": "copilot-chat/0.26.7", "User-Agent": "GitHubCopilotChat/0.26.7",
          "X-Github-Api-Version": "2025-04-01",
        });
        response = await request(URLS[provider], { method: "GET", headers, signal, redirect: "error" });
        // The resolver's rejectedAccessToken contract cannot refresh a GitHub device token.
        if (provider !== "github-copilot" && attempt === 0 && credential.type === "oauth" && selected.source === "pi" && (response.status === 401 || response.status === 403)) {
          await response.body?.cancel();
          try { token = await resolver(provider, { rejectedAccessToken: token, signal }); }
          catch { throw new UsageFailure("auth_failed"); }
          selected = await piCredentialFor(provider) ?? selected;
          credential = selected.credential;
          if (credential.type === "oauth" && nonempty(credential.access)) token = credential.access;
          entry.identity = identity(provider, selected);
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
        fetchedAt: previous?.fetchedAt ?? new Date(now()).toISOString(), stale: previous !== undefined && (previous.windows.length > 0 || previous.plan !== undefined),
        error: { code: failure.code, message: PROVIDER_USAGE_ERRORS[failure.code] },
      };
    }
    // Removed/replaced credentials must not disclose another account's cached usage.
    // A Pi-owned fetch may validate only Pi, never invoke local discovery on failure.
    const current = await (initial.source === "pi" ? piCredentialFor(provider) : credentialFor(provider));
    if (lifetime.signal.aborted || !current || identity(provider, current) !== entry.identity) {
      if (entries.get(provider) === entry) entries.delete(provider);
      return undefined;
    }
    if (generation !== undefined && entry.value !== undefined) {
      const observedAt = new Date(now()).toISOString();
      if (entry.value.error === undefined) options.outcomes?.recordAccountSuccess(provider, generation, observedAt);
      else if (entry.value.error.code === "auth_failed") options.outcomes?.recordAccountFailure(provider, generation, observedAt);
    }
    return entry.value;
  }
  async function read(provider: ProviderUsageId, manual = false): Promise<ProviderUsage | undefined> {
    if (lifetime.signal.aborted) return undefined;
    const credential = await credentialFor(provider);
    if (!usable(provider, credential, now())) {
      if (!entries.get(provider)?.flight) entries.delete(provider);
      return undefined;
    }
    const key = identity(provider, credential);
    let entry = entries.get(provider);
    if (entry?.flight && entry.identity !== key) {
      await entry.flight; // never overlap fetches, even across credential rotation
      return read(provider, manual);
    }
    if (!entry || entry.identity !== key) { entry = { identity: key, nextAt: 0 }; entries.set(provider, entry); }
    // Join through credential/observation validation, even if the fetch has
    // already populated a value while its final retention check is pending.
    if (manual && entry.flight) {
      const value = await entry.flight;
      return value === undefined ? undefined : structuredClone(value);
    }
    // Manual reads bypass successful freshness, never a failure/Retry-After fence.
    // An existing fetch is shared, including SWR and credential-refresh work.
    if (entry.value && now() < entry.nextAt && (!manual || entry.value.error !== undefined)) return structuredClone(entry.value);
    if (!entry.flight) {
      const owned = entry;
      owned.flight = refresh(provider, owned, credential).finally(() => { delete owned.flight; });
    }
    if (!manual && entry.value && (entry.value.windows.length > 0 || entry.value.plan !== undefined)) return { ...structuredClone(entry.value), stale: true };
    const value = await entry.flight;
    return value === undefined ? undefined : structuredClone(value);
  }
  return {
    async snapshot(provider) {
      const results = await Promise.all((provider === undefined ? PROVIDER_USAGE_IDS : [provider]).map((id) => read(id)));
      return { schema: PROVIDER_USAGE_SCHEMA, providers: results.filter((p): p is ProviderUsage => p !== undefined) };
    },
    async refresh(provider) {
      const results = await Promise.all((provider === undefined ? PROVIDER_USAGE_IDS : [provider]).map((id) => read(id, true)));
      return { schema: PROVIDER_USAGE_SCHEMA, providers: results.filter((p): p is ProviderUsage => p !== undefined) };
    },
    stop() { lifetime.abort(); entries.clear(); },
  };
}
