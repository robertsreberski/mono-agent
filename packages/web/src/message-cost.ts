import { deriveUpkeepAccounting, mergeForwardedUpkeepAccounting, parseForwardedUpkeepAccounting, type ForwardedUpkeepAccounting } from "@mono-agent/contracts/upkeep-accounting";
import { costAmount, knownCostAmount } from "./cost-wire.js";
/**
 * The browser-safe cost observation helpers, shared verbatim by both ends of
 * the console.
 *
 * The service sums recognised priced usage for a project's monthly cost; the
 * browser sums the same observations for a conversation's cost display. Written
 * twice, those two sums drift, and the drift is invisible: a project month
 * would disagree with the conversations inside it.
 *
 * This module is imported by `store.ts` and by `webapp/src/usage.ts`
 * (relatively, the way `mcp-app-document.ts` already is), so there is exactly
 * one implementation of the precedence rules.
 *
 * Its sole runtime dependency is the canonical pure upkeep contract, mapped
 * explicitly by the standalone browser shared-source aliases. Only aggregate cost
 * observation moves here -- context occupancy, compaction and processed-token
 * projections stay browser-side.
 */

export interface CostTelemetryPart {
  readonly type: string;
  readonly event?: string;
  readonly kind?: string;
  readonly data?: unknown;
  readonly usage?: unknown;
  readonly attribution?: unknown;
  readonly costUsd?: number | null;
  readonly knownCostUsd?: number;
  readonly costUnknown?: true;
  readonly job?: unknown;
}

export interface NormalizedUsage {
  readonly input?: number;
  readonly cachedInput?: number;
  readonly cacheCreation?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly total?: number;
  readonly contextWindow?: number;
  readonly cost?: number | null;
  readonly knownCostUsd?: number;
  readonly model?: string;
  readonly cacheHitRatio?: number;
}

type UnknownRecord = Readonly<Record<string, unknown>>;
export type UsageRecord = UnknownRecord;

const INPUT_KEYS = ["input", "input_tokens", "inputTokens"] as const;
const CACHED_INPUT_KEYS = [
  "cachedInput",
  "cached_input",
  "cachedInputTokens",
  "cached_input_tokens",
  "cacheRead",
  "cache_read",
  "cacheReadTokens",
  "cache_read_tokens",
] as const;
const CACHE_CREATION_KEYS = [
  "cacheCreation",
  "cache_creation",
  "cacheCreationTokens",
  "cache_creation_tokens",
  "cacheWrite",
  "cache_write",
  "cacheWriteTokens",
  "cache_write_tokens",
] as const;
const OUTPUT_KEYS = ["output", "output_tokens", "outputTokens"] as const;
const REASONING_KEYS = ["reasoning", "reasoning_tokens", "reasoningTokens"] as const;
const TOTAL_KEYS = ["total", "total_tokens", "totalTokens"] as const;
const CONTEXT_WINDOW_KEYS = ["contextWindow", "context_window"] as const;
const COST_KEYS = [
  "cumulativeUsd",
  "cumulative_usd",
  "totalUsd",
  "total_usd",
  "costUsd",
  "cost_usd",
  "cost",
] as const;
const MODEL_KEYS = ["model", "modelId", "model_id"] as const;

const recordValue = (value: unknown): UnknownRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;

/** Read one nested object layer, for callers that walk past `data`. */
export const childRecord = (value: UnknownRecord, key: string): UnknownRecord | undefined =>
  recordValue(value[key]);

export const dataLayers = (value: unknown): readonly UnknownRecord[] => {
  const layers: UnknownRecord[] = [];
  const seen = new Set<UnknownRecord>();
  let current = recordValue(value);
  while (current !== undefined && layers.length < 8 && !seen.has(current)) {
    layers.push(current);
    seen.add(current);
    current = recordValue(Object.getOwnPropertyDescriptor(current, "data")?.value);
  }
  return layers;
};

export const numericValue = (
  records: readonly UnknownRecord[],
  keys: readonly string[],
): number | undefined => {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  return undefined;
};

export const stringValue = (
  records: readonly UnknownRecord[],
  keys: readonly string[],
): string | undefined => {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  }
  return undefined;
};

const telemetryLabels = (event: string, layers: readonly UnknownRecord[]): readonly string[] => [
  event,
  ...layers.flatMap((layer) =>
    [layer.type, layer.event, layer.kind].filter(
      (value): value is string => typeof value === "string",
    ),
  ),
];

const hasTelemetryLabel = (
  event: string,
  layers: readonly UnknownRecord[],
  expected: string,
): boolean => telemetryLabels(event, layers).some((label) => label.toLowerCase() === expected);

export const isContextTelemetry = (event: string, layers: readonly UnknownRecord[]): boolean =>
  hasTelemetryLabel(event, layers, "context_usage");

export const isCompactionTelemetry = (event: string, layers: readonly UnknownRecord[]): boolean =>
  hasTelemetryLabel(event, layers, "context_compaction");

export const isUpkeepTelemetry = (event: string, layers: readonly UnknownRecord[]): boolean => hasTelemetryLabel(event, layers, "continuity_upkeep");

const hasUpkeepSpendEvidence = (layers: readonly UnknownRecord[]): boolean => layers.some(layer =>
  Object.getOwnPropertyDescriptor(layer, "accounting") !== undefined
  || Object.getOwnPropertyDescriptor(layer, "accountingPartial")?.value === true
  || Object.getOwnPropertyDescriptor(layer, "providerInvoked")?.value === true
  || Object.getOwnPropertyDescriptor(layer, "status")?.value === "uncertain");

/** Closed data only, used before persistence as well as shaped reloads. */
export function upkeepTelemetryData(value: unknown): UnknownRecord | undefined {
  const partial = { type: "runtime_telemetry", kind: "continuity_upkeep", data: { accountingPartial: true } };
  const layers: UnknownRecord[] = [], seen = new Set<UnknownRecord>();
  let spendEvidence = false;
  try {
    let current = recordValue(value);
    while (current && layers.length < 8 && !seen.has(current)) {
      layers.push(current); seen.add(current);
      current = recordValue(Object.getOwnPropertyDescriptor(current, "data")?.value);
    }
    spendEvidence = hasUpkeepSpendEvidence(layers);
    for (const layer of layers.reverse()) {
      const descriptor = Object.getOwnPropertyDescriptor(layer, "accounting");
      if (descriptor) {
        spendEvidence = true;
        return { type: "runtime_telemetry", kind: "continuity_upkeep", data: { accounting: parseForwardedUpkeepAccounting(descriptor.value), ...(layers.some(layer => Object.getOwnPropertyDescriptor(layer, "accountingPartial")?.value === true) ? { accountingPartial: true } : {}) } };
      }
    }
  } catch { /* Invalid accounting is evidence; a status-only skip is not. */ }
  return spendEvidence ? partial : undefined;
}

export const isAggregateUsageTelemetry = (event: string, layers: readonly UnknownRecord[]): boolean =>
  !isUpkeepTelemetry(event, layers) && !isContextTelemetry(event, layers) && telemetryLabels(event, layers).some((label) => {
    const normalized = label.toLowerCase();
    return normalized.includes("usage") || normalized.includes("cost");
  });

export const normalizeUsage = (data: unknown): NormalizedUsage | null => {
  const outerToInner = dataLayers(data);
  const innerToOuter = [...outerToInner].reverse();
  const tokenRecords = [
    ...innerToOuter.flatMap((layer) => {
      const tokens = recordValue(layer.tokens);
      return tokens === undefined ? [] : [tokens];
    }),
    ...innerToOuter,
  ];
  const input = numericValue(tokenRecords, INPUT_KEYS);
  const cachedInput = numericValue(tokenRecords, CACHED_INPUT_KEYS);
  const cacheCreation = numericValue(tokenRecords, CACHE_CREATION_KEYS);
  const output = numericValue(tokenRecords, OUTPUT_KEYS);
  const reasoning = numericValue(tokenRecords, REASONING_KEYS);
  const total = numericValue(tokenRecords, TOTAL_KEYS);
  const contextWindow = numericValue(innerToOuter, CONTEXT_WINDOW_KEYS);
  let cost: number | null | undefined;
  let knownCostUsd: number | undefined;
  for (const layer of innerToOuter) {
    if (layer.costUnknown === true) { cost = null; knownCostUsd = knownCostAmount(layer); break; }
    for (const key of COST_KEYS) {
      const amount = costAmount(layer, key);
      if (amount !== undefined) { cost = amount; knownCostUsd = knownCostAmount(layer); break; }
    }
    if (cost !== undefined) break;
  }
  const model = stringValue(innerToOuter, MODEL_KEYS);
  const inputTotal = input !== undefined && cachedInput !== undefined && cacheCreation !== undefined
    ? input + cachedInput + cacheCreation : undefined;
  const usage: NormalizedUsage = {
    ...(input === undefined ? {} : { input }),
    ...(cachedInput === undefined ? {} : { cachedInput }),
    ...(cacheCreation === undefined ? {} : { cacheCreation }),
    ...(output === undefined ? {} : { output }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(total === undefined ? {} : { total }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(cost === undefined ? {} : { cost }),
    ...(knownCostUsd === undefined ? {} : { knownCostUsd }),
    ...(model === undefined ? {} : { model }),
    ...(inputTotal === undefined || inputTotal === 0 ? {} : { cacheHitRatio: cachedInput! / inputTotal }),
  };
  return Object.keys(usage).length === 0 ? null : usage;
};

/**
 * The latest recognised aggregate cost observation of one message, in USD.
 *
 * Latest wins within the message; context-occupancy observations never price
 * anything; subagent delegations are not top-level telemetry and are never
 * added on top of the aggregate that already contains them.
 */
function latestAggregateCostUsd(parts: readonly CostTelemetryPart[]): number | null | undefined {
  for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
    const part = parts[partIndex];
    if (part?.type !== "telemetry" || part.event === undefined) continue;
    const layers = dataLayers(part.data);
    if (part.kind === "continuity_upkeep" || !isAggregateUsageTelemetry(part.event, layers)) continue;
    const cost = normalizeUsage(part.data)?.cost;
    if (cost !== undefined) return cost;
  }
  return undefined;
}

/** Read summary request snapshots separately: a lifecycle cost is not a run aggregate. */
function compactionObservations(parts: readonly CostTelemetryPart[]) {
  type Row = { tokensPartial?: boolean; model?: string | undefined; included: boolean; input?: number | undefined; cachedInput?: number | undefined; cacheCreation?: number | undefined; output?: number | undefined; cost?: number | undefined; costUnknown?: boolean };
  const requests = new Map<string, Row>();
  for (const part of parts) {
    if (part.type !== "telemetry" || !part.event) continue;
    const layers = dataLayers(part.data);
    if (!isCompactionTelemetry(part.event, layers)) continue;
    for (const layer of layers) {
      const accounting = recordValue(layer.accounting);
      if (!accounting || !Array.isArray(accounting.requests)) continue;
      for (const raw of accounting.requests) {
        const row = recordValue(raw);
        if (!row || typeof row.requestId !== "string" || row.requestId.length > 256) continue;
        if (row.providerInvoked === false) { requests.delete(row.requestId); continue; }
        const usage = normalizeUsage(row);
        const tokens = tokenObservation(row);
        const before = requests.get(row.requestId);
        const known = (value: number | undefined, previous: number | undefined) => value !== undefined && value >= 0 ? value : previous;
        requests.set(row.requestId, { included: accounting.version === 2 && accounting.usageIncluded === true,
          model: usage?.model ?? before?.model ?? (typeof layer.model === "string" ? layer.model : undefined),
          tokensPartial: hasTokenFields(row) && tokens === undefined,
          input: known(tokens ? usage?.input : undefined, before?.input), cachedInput: known(tokens ? usage?.cachedInput : undefined, before?.cachedInput),
          cacheCreation: known(tokens ? usage?.cacheCreation : undefined, before?.cacheCreation), output: known(tokens ? usage?.output : undefined, before?.output), cost: usage?.cost === null ? usage.knownCostUsd : known(usage?.cost, before?.cost),
          costUnknown: usage?.cost === undefined ? before?.costUnknown ?? false : usage.cost === null });
      }
    }
  }
  const rows = [...requests.values()];
  const slice = (values: Row[]): MessageUsageSlice => {
    const observed = values.filter((row) => [row.input, row.cachedInput, row.cacheCreation, row.output].some((value) => value !== undefined));
    const costs = values.filter((row) => row.cost !== undefined);
    const sums = (["input", "cachedInput", "cacheCreation", "output"] as const).map((key) => observed.reduce((sum, row) => sum + (row[key] ?? 0), 0));
    const [input = 0, cacheRead = 0, cacheWrite = 0, output = 0] = sums.map((value) => Math.min(Number.MAX_SAFE_INTEGER, value));
    return {
      ...(observed.length ? { tokens: { input, cacheRead, cacheWrite, output } } : {}),
      ...(values.some((row) => row.costUnknown) || costs.length > 0 ? { costUsd: values.some((row) => row.costUnknown) ? null : costs.reduce((sum, row) => sum + (row.cost ?? 0), 0) } : {}),
      ...(values.some((row) => row.costUnknown) && costs.length ? { knownCostUsd: costs.reduce((sum, row) => sum + (row.cost ?? 0), 0) } : {}),
      ...(costs.length < values.length ? { costPartial: true as const } : {}),
      ...(sums.some((value) => !Number.isSafeInteger(value)) || values.some((row) => row.tokensPartial || [row.input, row.cachedInput, row.cacheCreation, row.output].some((value) => value === undefined)) ? { tokensPartial: true as const } : {}),
    };
  };
  return { rows, slice: slice(rows), extra: slice(rows.filter((row) => !row.included)),
    byModel: [...new Set(rows.map((row) => row.model))].map((model) => ({ ...slice(rows.filter((row) => row.model === model)), ...(model === undefined ? {} : { model }) })) };
}

/** Aggregate totals already include v2 run summaries; legacy/manual receipts do not. */
function latestInferenceMessageCostUsd(parts: readonly CostTelemetryPart[]): number | null | undefined {
  const aggregate = latestAggregateCostUsd(parts);
  const compaction = compactionObservations(parts);
  if (aggregate === undefined) return compaction.slice.costUsd;
  if (aggregate === null || compaction.extra.costUsd === null) return null;
  return aggregate + (compaction.extra.costUsd ?? 0);
}

/**
 * Sum recognised per-message observations, omitting the total when nothing was
 * priced. A measured zero is kept as zero: no priced observation is not the
 * same as a free month.
 */
export function sumMessageCosts(costs: readonly (number | null | undefined)[]): number | null | undefined {
  let total = 0;
  let priced = false;
  for (const cost of costs) {
    if (cost === null) return null;
    if (cost === undefined) continue;
    total += cost;
    priced = true;
  }
  return priced ? total : undefined;
}

/** A per-message observation. Synchronous children are a subset of main cost. */
export interface MessageUsageSlice {
  readonly pending?: true;
  readonly model?: string;
  readonly tokens?: { readonly input: number; readonly cacheRead: number; readonly cacheWrite: number; readonly output: number };
  readonly costUsd?: number | null;
  readonly knownCostUsd?: number;
  readonly costPartial?: true;
  readonly tokensPartial?: true;
}
export interface MessageUsageRollup {
  readonly main: MessageUsageSlice;
  readonly inference?: MessageUsageSlice;
  readonly upkeep?: MessageUsageSlice & { readonly operations: number };
  readonly upkeepAccounting?: readonly ForwardedUpkeepAccounting[];
  readonly upkeepPartial?: true;
  readonly subagents: readonly (MessageUsageSlice & { readonly detached: boolean })[];
  readonly compaction?: MessageUsageSlice & { readonly requests: number; readonly requestsWithUsage: number };
  readonly compactionByModel?: readonly (MessageUsageSlice & { readonly model?: string })[];
}

type PartRecord = CostTelemetryPart & Readonly<Record<string, unknown>>;
const tokenObservation = (value: unknown): MessageUsageSlice["tokens"] => {
  const usage = normalizeUsage(value);
  const values = [usage?.input, usage?.cachedInput, usage?.cacheCreation, usage?.output];
  if (usage === null || values.every((value) => value === undefined)
    || values.some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) return undefined;
  return {
    input: usage.input ?? 0, cacheRead: usage.cachedInput ?? 0,
    cacheWrite: usage.cacheCreation ?? 0, output: usage.output ?? 0,
  };
};

function hasTokenFields(value: unknown): boolean {
  const layers = dataLayers(value);
  return layers.some((layer) => [layer, recordValue(layer.tokens)].some((record) => record !== undefined
    && [...INPUT_KEYS, ...CACHED_INPUT_KEYS, ...CACHE_CREATION_KEYS, ...OUTPUT_KEYS]
      .some((key) => Object.hasOwn(record, key))));
}

function inferenceUsageRollup(message: {
  readonly parts: readonly CostTelemetryPart[];
  readonly turnId?: string;
  readonly attribution?: { readonly executed?: { readonly model?: string }; readonly attempted?: { readonly model?: string } };
}): MessageUsageRollup {
  let aggregate: NormalizedUsage | null = null;
  let tokens: MessageUsageSlice["tokens"];
  let rejectedTokens = false;
  for (const part of message.parts) {
    if (part.type !== "telemetry" || part.event === undefined) continue;
    const layers = dataLayers(part.data);
    if (part.kind === "continuity_upkeep" || !isAggregateUsageTelemetry(part.event, layers)) continue;
    const observation = normalizeUsage(part.data);
    if (observation === null) {
      if (hasTokenFields(part.data)) rejectedTokens = true;
      continue;
    }
    if (observation.cost !== undefined) aggregate = observation;
    // A cost-only update must not erase the most recent aggregate token sample.
    const observed = tokenObservation(part.data);
    if (observed !== undefined) { tokens = observed; rejectedTokens = false; }
    else if (hasTokenFields(part.data)) rejectedTokens = true;
  }
  const subagents: Array<MessageUsageSlice & { readonly detached: boolean }> = [];
  for (const part of message.parts) {
    const record = part as PartRecord;
    if (part.type === "subagent") {
      const attribution = recordValue(record.attribution);
      const executed = attribution && recordValue(attribution.executed);
      const costUsd = costAmount(record);
      const knownCostUsd = knownCostAmount(record);
      const observed = tokenObservation(record.usage);
      subagents.push({ detached: false,
        ...(typeof executed?.model === "string" ? { model: executed.model } : {}),
        ...(costUsd === undefined ? {} : { costUsd }),
        ...(knownCostUsd === undefined ? {} : { knownCostUsd }),
        ...(observed === undefined ? {} : { tokens: observed }),
      });
    } else if (part.type === "process-job") {
      const job = recordValue(record.job);
      const progress = job && recordValue(job.subagentProgress);
      if (!progress) continue;
      const route = recordValue(progress.route);
      const executed = route && recordValue(route.executed);
      const costUsd = costAmount(progress);
      const knownCostUsd = knownCostAmount(progress);
      const observed = tokenObservation(progress.usage);
      subagents.push({ detached: true,
        ...(typeof executed?.model === "string" ? { model: executed.model } : {}),
        ...(costUsd === undefined ? {} : { costUsd }),
        ...(knownCostUsd === undefined ? {} : { knownCostUsd }),
        ...(observed === undefined ? {} : { tokens: observed }),
      });
    }
  }
  const syncCost = subagents.reduce((sum, child) => sum + (child.detached ? 0 : child.costUsd ?? 0), 0);
  const syncTokens = subagents.filter((child) => !child.detached && child.tokens !== undefined)
    .map((child) => child.tokens!);
  const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const syncTotals = Object.fromEntries(fields.map((field) => [field,
    syncTokens.reduce((sum, child) => sum + child[field], 0)])) as Record<(typeof fields)[number], number>;
  const compaction = compactionObservations(message.parts);
  const extraTokens = tokens === undefined ? compaction.slice.tokens : compaction.extra.tokens;
  if (extraTokens) tokens = { input: (tokens?.input ?? 0) + extraTokens.input, output: (tokens?.output ?? 0) + extraTokens.output,
    cacheRead: (tokens?.cacheRead ?? 0) + extraTokens.cacheRead, cacheWrite: (tokens?.cacheWrite ?? 0) + extraTokens.cacheWrite };
  const guardedTokens = tokens === undefined && syncTokens.length === 0 ? undefined
    : Object.fromEntries(fields.map((field) => [field,
      Math.min(Number.MAX_SAFE_INTEGER, Math.max(tokens?.[field] ?? 0, syncTotals[field]))])) as MessageUsageSlice["tokens"];
  const tokenGuardPartial = fields.some((field) => (tokens?.[field] ?? 0) > Number.MAX_SAFE_INTEGER || syncTotals[field] > Number.MAX_SAFE_INTEGER
    || (tokens !== undefined && syncTotals[field] > tokens[field]));
  const reportedCost = latestInferenceMessageCostUsd(message.parts);
  const syncChildren = subagents.filter((child) => !child.detached);
  const syncKnown = syncChildren.reduce((sum, child) => sum + (child.costUsd ?? child.knownCostUsd ?? 0), 0);
  const summaryKnown = compaction.slice.costUsd ?? compaction.slice.knownCostUsd ?? 0;
  const reportedKnown = aggregate?.cost === null ? aggregate.knownCostUsd : aggregate?.cost;
  const inclusiveKnown = reportedKnown === undefined ? undefined : reportedKnown + (compaction.extra.costUsd ?? compaction.extra.knownCostUsd ?? 0);
  const known = Math.max(inclusiveKnown ?? 0, syncKnown + summaryKnown);
  const hasKnown = inclusiveKnown !== undefined || syncChildren.some((child) => typeof child.costUsd === "number" || child.knownCostUsd !== undefined)
    || compaction.slice.costUsd !== undefined && compaction.slice.costUsd !== null || compaction.slice.knownCostUsd !== undefined;
  const unknown = reportedCost === null || compaction.slice.costUsd === null || syncChildren.some((child) => child.costUsd === null);
  const costUsd = unknown ? null : reportedCost === undefined
    ? syncChildren.some((child) => typeof child.costUsd === "number") ? syncCost + summaryKnown : undefined
    : Math.max(reportedCost, syncCost + summaryKnown);
  // A failed run may have no executed attribution, but its attempted reference
  // still names the provider model used by the persisted turn when available.
  const model = aggregate?.model ?? message.attribution?.executed?.model ?? message.attribution?.attempted?.model;
  return {
    main: {
      ...(model === undefined ? {} : { model }),
      ...(guardedTokens === undefined ? {} : { tokens: guardedTokens }),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(costUsd === null && hasKnown ? { knownCostUsd: known } : {}),
      ...((guardedTokens !== undefined && reportedCost === undefined) || compaction.slice.costPartial
        || (typeof reportedCost === "number" && reportedCost < syncCost + (compaction.slice.costUsd ?? 0)) ? { costPartial: true as const } : {}),
      ...(rejectedTokens || tokenGuardPartial || compaction.slice.tokensPartial || (tokens === undefined && syncTokens.length > 0)
        ? { tokensPartial: true as const } : {}),
    },
    subagents,
    ...(compaction.rows.length ? { compaction: { ...compaction.slice, requests: compaction.rows.length,
      requestsWithUsage: compaction.rows.filter((row) => row.input !== undefined || row.output !== undefined).length },
      compactionByModel: compaction.byModel } : {}),
  };
}

/** Shared web slice, with result precedence and conflict isolation. */
export function upkeepUsageRollup(candidates: readonly unknown[], partial = false) {
  const accepted = new Map<string, ForwardedUpkeepAccounting>();
  for (const value of candidates) {
    try {
      const next = parseForwardedUpkeepAccounting(value), previous = accepted.get(next.operationId);
      accepted.set(next.operationId, mergeForwardedUpkeepAccounting(previous ? [previous, next] : [next])[0]!);
    } catch { partial = true; }
  }
  const accounting = [...accepted.values()];
  const slice = (values: readonly ForwardedUpkeepAccounting[]): MessageUsageSlice => {
    const derived = deriveUpkeepAccounting(values);
    const unknown = partial || derived.cost.partial;
    const pending = !partial && derived.operations.length > 0 && derived.operations.every(a => a.phase === "dispatch");
    return { ...(pending ? { pending: true as const } : { tokens: derived.tokens }), costUsd: unknown ? null : derived.cost.totalUsd,
      ...(unknown ? { knownCostUsd: derived.cost.knownCostUsd, costPartial: true } : {}),
      ...(partial || derived.tokensPartial ? { tokensPartial: true } : {}) };
  };
  const groups = new Map<string, ForwardedUpkeepAccounting[]>();
  for (const a of accounting) { const group = groups.get(a.model) ?? []; group.push(a); groups.set(a.model, group); }
  const byModel: MessageUsageSlice[] = [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([model, rows]) => ({ ...slice(rows), model }));
  if (partial && !accounting.length) byModel.push(slice([]));
  return { accounting, partial, slice: { ...slice(accounting), operations: accounting.length }, byModel };
}
export function hasUpkeepTelemetry(parts: readonly CostTelemetryPart[]): boolean {
  return parts.some(part => part.type === "telemetry" && !!part.event && (part.kind === "continuity_upkeep" || isUpkeepTelemetry(part.event, dataLayers(part.data))) && hasUpkeepSpendEvidence(dataLayers(part.data)));
}
function upkeepObservations(parts: readonly CostTelemetryPart[]) {
  const candidates: unknown[] = [];
  let partial = false;
  for (const part of parts) {
    if (part.type !== "telemetry" || !part.event || part.kind !== "continuity_upkeep" && !isUpkeepTelemetry(part.event, dataLayers(part.data))) continue;
    const data = upkeepTelemetryData(part.data);
    if (!data) continue;
    const layer = recordValue(data.data)!;
    if (layer.accounting !== undefined) candidates.push(layer.accounting);
    if (layer.accountingPartial === true) partial = true;
  }
  return upkeepUsageRollup(candidates, partial);
}
export function messageUsageRollup(message: Parameters<typeof inferenceUsageRollup>[0]): MessageUsageRollup {
  const base = inferenceUsageRollup(message), upkeep = upkeepObservations(message.parts);
  if (!upkeep.accounting.length && !upkeep.partial) return base;
  const inclusive = deriveUpkeepAccounting(upkeep.accounting, { totalUsd: base.main.costUsd, knownCostUsd: base.main.knownCostUsd });
  const partial = inclusive.cost.partial || upkeep.partial;
  const pending = upkeep.slice.pending && base.main.costUsd === undefined && base.main.tokens === undefined && !base.subagents.length && !base.compaction;
  const tokens = Object.fromEntries((["input", "cacheRead", "cacheWrite", "output"] as const).map(key => [key,
    Math.min(Number.MAX_SAFE_INTEGER, (base.main.tokens?.[key] ?? 0) + inclusive.tokens[key])])) as NonNullable<MessageUsageSlice["tokens"]>;
  return { ...base, inference: base.main, upkeep: upkeep.slice, upkeepAccounting: upkeep.accounting,
    ...(upkeep.partial ? { upkeepPartial: true } : {}),
    main: { ...base.main, ...(pending ? { pending: true as const } : { tokens }), costUsd: partial ? null : inclusive.cost.totalUsd,
      ...(partial ? { knownCostUsd: inclusive.cost.knownCostUsd, costPartial: true } : {}),
      ...(inclusive.tokensPartial || base.main.tokens === undefined || (["input", "cacheRead", "cacheWrite", "output"] as const).some(key => !Number.isSafeInteger((base.main.tokens?.[key] ?? 0) + inclusive.tokens[key])) ? { tokensPartial: true } : {}) } };
}
export function latestMessageCostUsd(parts: readonly CostTelemetryPart[]): number | null | undefined {
  const upkeep = upkeepObservations(parts);
  return upkeep.accounting.length || upkeep.partial ? messageUsageRollup({ parts }).main.costUsd : latestInferenceMessageCostUsd(parts);
}

/** Final metadata is another view of the same operations, not another charge. */
export function upkeepSummaryParts(summary: unknown): { type: "telemetry"; event: "runtime_telemetry"; data: UnknownRecord }[] {
  const marker = () => ({ type: "telemetry" as const, event: "runtime_telemetry" as const, data: upkeepTelemetryData({ accountingPartial: true })! });
  try {
    if (!summary || typeof summary !== "object") return [];
    const own = (key: string) => Object.getOwnPropertyDescriptor(summary, key)?.value as unknown;
    const has = (key: string) => Object.prototype.hasOwnProperty.call(summary, key);
    if (!has("upkeepAccounting") && !has("upkeepAccountingPartial")) return [];
    const runId = own("runId"), conversationId = own("conversationId"), values = own("upkeepAccounting");
    if (typeof runId !== "string" || typeof conversationId !== "string" || has("upkeepAccounting") && !Array.isArray(values)) return [marker()];
    const result: { type: "telemetry"; event: "runtime_telemetry"; data: UnknownRecord }[] = [];
    let partial = own("upkeepAccountingPartial") === true;
    for (const candidate of Array.isArray(values) ? values : []) {
      try {
        const accounting = parseForwardedUpkeepAccounting(candidate);
        if (accounting.runId !== runId || accounting.conversationId !== conversationId) { partial = true; continue; }
        result.push({ type: "telemetry", event: "runtime_telemetry", data: { kind: "continuity_upkeep", data: { accounting } } });
      } catch { partial = true; }
    }
    if (partial) result.push(marker());
    return result;
  } catch { return [marker()]; }
}
