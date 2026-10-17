/** Bounded manual-compaction billing receipt. Never carries generated prose. */
export interface AgentCompactionAccounting {
  readonly version: 2;
  readonly usageIncluded: false;
  readonly requests: readonly {
    readonly requestId: string;
    readonly model?: string;
    readonly status: "succeeded" | "rejected" | "failed";
    readonly input: number | null;
    readonly output: number | null;
    readonly cacheRead: number | null;
    readonly cacheWrite: number | null;
    readonly costUsd: number | null;
  }[];
}

export function isAgentCompactionAccounting(value: unknown): value is AgentCompactionAccounting {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const accounting = value as Record<string, unknown>;
  if (Object.keys(accounting).some((key) => !["version", "usageIncluded", "requests"].includes(key))
    || accounting.version !== 2 || accounting.usageIncluded !== false
    || !Array.isArray(accounting.requests) || accounting.requests.length > 2) return false;
  const seen = new Set<string>();
  return accounting.requests.every((value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some((key) => !["requestId", "model", "status", "input", "output", "cacheRead", "cacheWrite", "costUsd"].includes(key))
      || typeof row.requestId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/u.test(row.requestId) || seen.has(row.requestId)
      || (row.model !== undefined && (typeof row.model !== "string" || row.model.length > 256))
      || !["succeeded", "rejected", "failed"].includes(String(row.status))) return false;
    seen.add(row.requestId);
    return ["input", "output", "cacheRead", "cacheWrite", "costUsd"].every((key) => row[key] === null
      || (typeof row[key] === "number" && Number.isFinite(row[key]) && row[key] >= 0
        && (key === "costUsd" || Number.isSafeInteger(row[key]))));
  });
}
