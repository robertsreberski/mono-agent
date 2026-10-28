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

/** Browser/channel projection: storage identities never cross this boundary. */
export type ForwardedUpkeepAccounting = Omit<AgentUpkeepAccounting, "recorderNamespace" | "databaseId" | "incarnation" | "logicalConversationId">;
const LOCAL_KEYS = new Set(["recorderNamespace", "databaseId", "incarnation", "logicalConversationId"]);
export function forwardUpkeepAccounting(value: unknown): ForwardedUpkeepAccounting {
  return Object.fromEntries(Object.entries(parseAgentUpkeepAccounting(value)).filter(([key]) => !LOCAL_KEYS.has(key))) as unknown as ForwardedUpkeepAccounting;
}
export function parseForwardedUpkeepAccounting(value: unknown): ForwardedUpkeepAccounting {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Invalid forwarded upkeep accounting");
  const data: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !KEYS.has(key) || LOCAL_KEYS.has(key) || !d || !("value" in d)) throw new TypeError("Invalid forwarded upkeep accounting");
    data[key] = d.value;
  }
  return forwardUpkeepAccounting({ ...data, recorderNamespace: "x", databaseId: "x", incarnation: "x", logicalConversationId: "x" });
}
export function mergeForwardedUpkeepAccounting(values: readonly unknown[]): readonly ForwardedUpkeepAccounting[] {
  const full = values.map(value => ({ ...parseForwardedUpkeepAccounting(value), recorderNamespace: "x", databaseId: "x", incarnation: "x", logicalConversationId: "x" }));
  return mergeAgentUpkeepAccounting(full).map(forwardUpkeepAccounting);
}

/** Pure shared derivation. Reservations/estimates are never observations. */
export function deriveUpkeepAccounting(values: readonly unknown[], inference: { readonly totalUsd?: number | null | undefined; readonly knownCostUsd?: number | undefined } = { totalUsd: 0 }) {
  const operations: readonly ForwardedUpkeepAccounting[] = [...mergeForwardedUpkeepAccounting(values)].sort((a, b) => a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0);
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  let knownCostUsd = valid(inference.totalUsd) ? inference.totalUsd : valid(inference.knownCostUsd) ? inference.knownCostUsd : 0, partial = !valid(inference.totalUsd);
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let tokensPartial = false;
  for (const a of operations) {
    if (a.costUsd === null || !Number.isFinite(knownCostUsd + a.costUsd)) partial = true;
    else knownCostUsd += a.costUsd;
    for (const [target, source] of [["input", "inputTokens"], ["cacheRead", "cacheReadTokens"], ["cacheWrite", "cacheWriteTokens"], ["output", "outputTokens"]] as const) {
      const n = a[source];
      if (n === null || !Number.isSafeInteger(tokens[target] + n)) tokensPartial = true;
      else tokens[target] += n;
    }
  }
  return { operations, cost: { totalUsd: partial ? null : knownCostUsd, knownCostUsd, partial }, tokens, tokensPartial };
}
