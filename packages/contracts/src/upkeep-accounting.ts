/** Content-free, non-aggregate billing evidence for one continuity operation. */
export interface AgentUpkeepAccounting {
  readonly version: 1;
  readonly usageIncluded: false;
  readonly operationId: string;
  readonly databaseId: string;
  readonly incarnation: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly logicalConversationId: string;
  readonly recorderNamespace: string;
  readonly model: string;
  readonly budget: "bootstrap" | "incremental";
  /** Distinct immutable identities; result always takes precedence over dispatch. */
  readonly phase: "dispatch" | "result";
  readonly invocation: "uncertain" | "invoked" | "not_invoked";
  readonly outcome: "uncertain" | "valid" | "invalid" | "skipped";
  readonly inputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
}
const IDENTITIES = ["operationId", "databaseId", "incarnation", "runId", "conversationId", "logicalConversationId", "recorderNamespace", "model", "budget"] as const;
const COUNTERS = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "costUsd"] as const;
const KEYS = new Set<string>(["version", "usageIncluded", ...IDENTITIES, "phase", "invocation", "outcome", ...COUNTERS]);

/** Reject rather than coerce unknown fields, missing counters, or conflicting origins. */
export function parseAgentUpkeepAccounting(value: unknown): AgentUpkeepAccounting {
  const fail = (): never => { throw new TypeError("Invalid upkeep accounting"); };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || !KEYS.has(key))) return fail();
  const data: Record<string, unknown> = {};
  for (const key of KEYS) {
    const d = descriptors[key];
    if (!d || !("value" in d)) return fail();
    data[key] = d.value;
  }
  if (data.version !== 1 || data.usageIncluded !== false) return fail();
  for (const key of IDENTITIES) if (typeof data[key] !== "string" || !(data[key] as string).trim() || (data[key] as string).length > 4096 || /[\u0000-\u001f]/u.test(data[key] as string)) return fail();
  if (data.budget !== "bootstrap" && data.budget !== "incremental") return fail();
  if (data.phase !== "dispatch" && data.phase !== "result") return fail();
  if (!["uncertain", "invoked", "not_invoked"].includes(data.invocation as string) || !["uncertain", "valid", "invalid", "skipped"].includes(data.outcome as string)) return fail();
  for (const key of COUNTERS) {
    const n = data[key];
    if (n !== null && (typeof n !== "number" || !Number.isFinite(n) || n < 0 || (key !== "costUsd" && !Number.isSafeInteger(n)))) return fail();
  }
  if (data.phase === "dispatch" && (data.invocation !== "uncertain" || data.outcome !== "uncertain" || COUNTERS.some(key => data[key] !== null))) return fail();
  if (data.invocation === "not_invoked" && (data.outcome !== "skipped" || COUNTERS.some(key => data[key] !== 0))) return fail();
  if (data.invocation === "uncertain" && (data.outcome !== "uncertain" || COUNTERS.some(key => data[key] !== null))) return fail();
  if (data.invocation === "invoked" && data.outcome === "uncertain") return fail();
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > 16384) return fail();
  return data as unknown as AgentUpkeepAccounting;
}

/** Merge summaries/events/companions without ever letting late uncertainty win. */
export function mergeAgentUpkeepAccounting(values: readonly unknown[]): readonly AgentUpkeepAccounting[] {
  const operations = new Map<string, AgentUpkeepAccounting>();
  for (const value of values) {
    const next = parseAgentUpkeepAccounting(value), old = operations.get(next.operationId);
    if (old) {
      if (IDENTITIES.some(key => old[key] !== next[key])) throw new TypeError("Conflicting upkeep identity");
      if (old.phase === next.phase && JSON.stringify(old) !== JSON.stringify(next)) throw new TypeError("Conflicting upkeep evidence");
      if (old.phase === "result") continue;
    }
    operations.set(next.operationId, next);
  }
  return [...operations.values()];
}
