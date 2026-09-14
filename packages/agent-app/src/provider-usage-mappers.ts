import type { ProviderUsageId, ProviderUsageWindow } from "@mono-agent/agent-contracts";

const HOUR = 3_600_000;
const periods = { session: 5 * HOUR, weekly: 7 * 24 * HOUR, monthly: 30 * 24 * HOUR, model: 7 * 24 * HOUR };
const labels = { session: "Session", weekly: "Weekly", monthly: "Monthly", model: "Fable" } as const;
export function usageRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function iso(value: unknown): string | undefined {
  const timestamp = typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(timestamp) && Math.abs(timestamp) < 8.64e15 ? new Date(timestamp).toISOString() : undefined;
}
function window(kind: ProviderUsageWindow["kind"], percent: unknown, reset: unknown): ProviderUsageWindow | undefined {
  const number = numeric(percent);
  if (number === undefined) return undefined;
  const resetsAt = iso(reset);
  return { kind, label: labels[kind], usedPercent: Math.min(100, Math.max(0, number)), periodMs: periods[kind], ...(resetsAt === undefined ? {} : { resetsAt }) };
}
export function mapProviderUsage(provider: ProviderUsageId, body: unknown, headers: Headers, now: number): { windows: ProviderUsageWindow[]; plan?: string } {
  const data = usageRecord(body);
  const windows: ProviderUsageWindow[] = [];
  let plan: string | undefined;
  const add = (value: ProviderUsageWindow | undefined) => {
    if (value !== undefined && !windows.some((item) => item.kind === value.kind)) windows.push(value);
  };
  if (provider === "openai-codex") {
    const limits = usageRecord(data.rate_limit);
    for (const [slot, fallback] of [["primary", "session"], ["secondary", "weekly"]] as const) {
      const raw = limits[`${slot}_window`];
      if (raw === null || raw === undefined) continue;
      const w = usageRecord(raw);
      const kind = w.limit_window_seconds === 18000 ? "session" : w.limit_window_seconds === 604800 ? "weekly" : fallback;
      const header = headers.get(`x-codex-${slot}-used-percent`);
      const percent = numeric(w.used_percent) ?? (header !== null && header.trim() !== "" ? numeric(Number(header)) : undefined);
      const reset = numeric(w.reset_at);
      const relative = numeric(w.reset_after_seconds);
      add(window(kind, percent, reset !== undefined ? reset * 1000 : relative !== undefined ? now + relative * 1000 : undefined));
    }
    if (typeof data.plan_type === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(data.plan_type)) {
      const aliases: Record<string, string> = { prolite: "Pro 5x", pro: "Pro 20x", self_serve_business_prolite: "Business Premium" };
      plan = aliases[data.plan_type] ?? data.plan_type.replace(/[_-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    }
  } else if (provider === "anthropic") {
    for (const [key, kind] of [["five_hour", "session"], ["seven_day", "weekly"]] as const) {
      const w = usageRecord(data[key]);
      add(window(kind, w.utilization, w.resets_at));
    }
    if (Array.isArray(data.limits)) {
      const fable = data.limits.map(usageRecord).find((limit) => limit.kind === "weekly_scoped" && usageRecord(usageRecord(limit.scope).model).display_name === "Fable");
      if (fable) add(window("model", fable.percent, fable.resets_at));
    }
  } else {
    plan = "Go";
    const usage = usageRecord(data.usage);
    for (const [key, kind] of [["rolling", "session"], ["weekly", "weekly"], ["monthly", "monthly"]] as const) {
      const w = usageRecord(usage[key]);
      add(window(kind, w.percent, w.resetsAt));
    }
  }
  if (windows.length === 0) throw new Error("Invalid usage response.");
  windows.sort((a, b) => ["session", "weekly", "monthly", "model"].indexOf(a.kind) - ["session", "weekly", "monthly", "model"].indexOf(b.kind));
  return { windows, ...(plan === undefined ? {} : { plan }) };
}
