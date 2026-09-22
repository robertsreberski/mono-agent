export const PROVIDER_USAGE_SCHEMA = "mono-agent.provider-usage.v1" as const;
export const PROVIDER_USAGE_IDS = ["anthropic", "openai-codex", "opencode-go", "github-copilot"] as const;
export type ProviderUsageId = typeof PROVIDER_USAGE_IDS[number];
export const PROVIDER_USAGE_LABELS: Record<ProviderUsageId, string> = {
  anthropic: "Claude", "openai-codex": "Codex", "opencode-go": "OpenCode Go", "github-copilot": "GitHub Copilot",
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
  readonly kind: "session" | "weekly" | "monthly" | "model" | "credits" | "chat" | "completions";
  readonly label: "Session" | "Weekly" | "Monthly" | "Fable" | "Credits" | "Chat" | "Completions";
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
/** Constant-rate burn projection for one window, anchored at the measurement `fetchedAt`, not wall-clock. */
export interface ProviderUsageProjection {
  /** 1 = exactly on track to consume the window by its reset. */
  readonly pace: number;
  /** 0..1 of the window elapsed at the measurement anchor. */
  readonly elapsedFraction: number;
  readonly severity: "ok" | "ahead" | "unsustainable";
  readonly confidence: "normal" | "low";
  /** ISO run-out timestamp; present only when projected to hit 100 % before resetsAt. */
  readonly exhaustsAt?: string;
  /** Gap between exhaustsAt and resetsAt in ms; present exactly when exhaustsAt is. */
  readonly leadMs?: number;
}
/** One window's projection, for consumers that render per-window state. */
export interface ProviderUsageWindowProjection {
  readonly kind: ProviderUsageWindow["kind"];
  readonly projection: ProviderUsageProjection;
}
/** Shared pure derivation: constant-rate extrapolation from the last measurement, not a forecast. */
export function projectProviderUsageWindow(
  window: ProviderUsageWindow, fetchedAt: string,
): ProviderUsageProjection | undefined {
  if (window.resetsAt === undefined) return undefined;
  const resetMs = Date.parse(window.resetsAt);
  const anchorMs = Date.parse(fetchedAt);
  if (!Number.isFinite(resetMs) || !Number.isFinite(anchorMs)
    || !Number.isFinite(window.periodMs) || window.periodMs <= 0) return undefined;
  const elapsedMs = anchorMs - (resetMs - window.periodMs);
  if (elapsedMs <= 0) return undefined;
  const elapsedFraction = elapsedMs / window.periodMs;
  if (elapsedFraction > 1) return undefined;
  const confidence = elapsedFraction < 0.1 ? "low" : "normal";
  // Very early in a window one call extrapolates wildly: report pace, force ok, no run-out.
  if (window.usedPercent === 0) return { pace: 0, elapsedFraction, severity: "ok", confidence };
  const pace = window.usedPercent / (100 * elapsedFraction);
  if (confidence === "low" || pace <= 1) return { pace, elapsedFraction, severity: "ok", confidence };
  const severity = pace >= 1.5 ? "unsustainable" : "ahead";
  const roundedExhaustMs = window.usedPercent >= 100 ? Math.round(anchorMs)
    : Math.round(anchorMs + (100 - window.usedPercent) / (window.usedPercent / elapsedMs));
  return { pace, elapsedFraction, severity, confidence,
    exhaustsAt: new Date(roundedExhaustMs).toISOString(), leadMs: resetMs - roundedExhaustMs };
}
/** Compact lead shape (`3d 2h` / `5h 20m` / `12m`); same granularity as the meter countdown. */
export function formatProviderUsageLead(leadMs: number): string {
  const minutes = Math.max(0, Math.ceil(leadMs / 60_000));
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m`;
}
/** Per-window projections for one provider; windows without a projection are omitted, never null. */
export function projectProviderUsage(usage: Pick<ProviderUsage, "windows" | "fetchedAt">): readonly ProviderUsageWindowProjection[] {
  const out: ProviderUsageWindowProjection[] = [];
  for (const window of usage.windows) {
    const projection = projectProviderUsageWindow(window, usage.fetchedAt);
    if (projection !== undefined) out.push({ kind: window.kind, projection });
  }
  return out;
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
  assert(snapshot.schema === PROVIDER_USAGE_SCHEMA && Array.isArray(snapshot.providers) && snapshot.providers.length <= 4 && Object.keys(snapshot.providers).length === snapshot.providers.length);
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
      const labels = { session: "Session", weekly: "Weekly", monthly: "Monthly", model: "Fable", credits: "Credits", chat: "Chat", completions: "Completions" } as const;
      assert(Object.hasOwn(labels, w.kind));
      const kind = w.kind as ProviderUsageWindow["kind"];
      assert((["credits", "chat", "completions"].includes(kind)) === (providerId === "github-copilot"));
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
