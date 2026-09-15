export const PROVIDER_USAGE_SCHEMA = "mono-agent.provider-usage.v1" as const;
export const PROVIDER_USAGE_IDS = ["anthropic", "openai-codex", "opencode-go"] as const;
export type ProviderUsageId = typeof PROVIDER_USAGE_IDS[number];
export const PROVIDER_USAGE_LABELS: Record<ProviderUsageId, string> = {
  anthropic: "Claude", "openai-codex": "Codex", "opencode-go": "OpenCode Go",
};
export const PROVIDER_USAGE_ERRORS = {
  auth_failed: "Credential rejected; re-login to this provider.",
  not_entitled: "No Go subscription.",
  rate_limited: "Rate limited; retrying after backoff.",
  timeout: "Provider request timed out.",
  network_failed: "Provider could not be reached.",
  invalid_response: "Provider returned an invalid usage response.",
  unavailable: "Provider usage is unavailable.",
} as const;
export type ProviderUsageErrorCode = keyof typeof PROVIDER_USAGE_ERRORS;
export interface ProviderUsageWindow {
  readonly kind: "session" | "weekly" | "monthly" | "model";
  readonly label: "Session" | "Weekly" | "Monthly" | "Fable";
  readonly usedPercent: number;
  readonly resetsAt?: string;
  /** Nominal duration only; resetsAt is authoritative (month = 30 days). */
  readonly periodMs: number;
}
export interface ProviderUsage {
  readonly providerId: ProviderUsageId;
  readonly label: string;
  readonly plan?: string;
  readonly windows: readonly ProviderUsageWindow[];
  /** Last successful fetch, or first failed attempt if there is no last-good. */
  readonly fetchedAt: string;
  readonly stale: boolean;
  readonly error?: { readonly code: ProviderUsageErrorCode; readonly message: string };
}
export interface ProviderUsageSnapshot {
  readonly schema: typeof PROVIDER_USAGE_SCHEMA;
  readonly providers: readonly ProviderUsage[];
}
export interface ProviderUsageOperator {
  snapshot(provider?: ProviderUsageId): Promise<ProviderUsageSnapshot>;
  /** Explicit account-usage refresh; awaits shared fetches, never bypasses error backoff. */
  refresh?(provider?: ProviderUsageId): Promise<ProviderUsageSnapshot>;
}
export function isProviderUsageId(value: unknown): value is ProviderUsageId {
  return typeof value === "string" && (PROVIDER_USAGE_IDS as readonly string[]).includes(value);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Invalid provider usage projection.");
  return value as Record<string, unknown>;
}
function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid provider usage projection.");
}
function date(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && value.length <= 35 && Number.isFinite(Date.parse(value));
}
/** Strict, bounded, secret-free projection boundary. Never accepts vendor data directly. */
export function parseProviderUsageSnapshot(value: unknown): ProviderUsageSnapshot {
  const snapshot = record(value, ["schema", "providers"]);
  assert(snapshot.schema === PROVIDER_USAGE_SCHEMA && Array.isArray(snapshot.providers) && snapshot.providers.length <= 3 && Object.keys(snapshot.providers).length === snapshot.providers.length);
  const seen = new Set<string>();
  const providers = snapshot.providers.map((input): ProviderUsage => {
    const p = record(input, ["providerId", "label", "plan", "windows", "fetchedAt", "stale", "error"]);
    assert(isProviderUsageId(p.providerId) && !seen.has(p.providerId));
    const providerId = p.providerId;
    seen.add(providerId);
    assert(p.label === PROVIDER_USAGE_LABELS[providerId] && date(p.fetchedAt) && typeof p.stale === "boolean");
    assert(p.plan === undefined || (providerId !== "anthropic" && typeof p.plan === "string" && /^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$/.test(p.plan)));
    assert(Array.isArray(p.windows) && p.windows.length <= 3 && Object.keys(p.windows).length === p.windows.length);
    const kinds = new Set<string>();
    const windows = p.windows.map((input): ProviderUsageWindow => {
      const w = record(input, ["kind", "label", "usedPercent", "resetsAt", "periodMs"]);
      assert(typeof w.kind === "string" && !kinds.has(w.kind));
      kinds.add(w.kind);
      const labels = { session: "Session", weekly: "Weekly", monthly: "Monthly", model: "Fable" } as const;
      assert(Object.hasOwn(labels, w.kind));
      const kind = w.kind as ProviderUsageWindow["kind"];
      assert(w.label === labels[kind] && (kind !== "model" || providerId === "anthropic") && (kind !== "monthly" || providerId === "opencode-go"));
      assert(typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100);
      assert(typeof w.periodMs === "number" && Number.isFinite(w.periodMs) && w.periodMs > 0);
      assert(w.resetsAt === undefined || date(w.resetsAt));
      return { kind, label: labels[kind], usedPercent: w.usedPercent, periodMs: w.periodMs, ...(w.resetsAt === undefined ? {} : { resetsAt: w.resetsAt }) };
    });
    let error: ProviderUsage["error"];
    if (p.error !== undefined) {
      const e = record(p.error, ["code", "message"]);
      assert(typeof e.code === "string" && Object.hasOwn(PROVIDER_USAGE_ERRORS, e.code));
      const code = e.code as ProviderUsageErrorCode;
      assert(e.message === PROVIDER_USAGE_ERRORS[code]);
      error = { code, message: PROVIDER_USAGE_ERRORS[code] };
    }
    return { providerId, label: PROVIDER_USAGE_LABELS[providerId], windows, fetchedAt: p.fetchedAt, stale: p.stale,
      ...(p.plan === undefined ? {} : { plan: p.plan as string }), ...(error === undefined ? {} : { error }) };
  });
  return { schema: PROVIDER_USAGE_SCHEMA, providers };
}
