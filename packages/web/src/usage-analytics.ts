import { parseUsageHistoryRange, usageHistoryBucket, type UsageHistoryRange } from "@mono-agent/contracts/provider-usage";
import type { WebUsageAnalytics, WebUsageAnalyticsQuery, WebUsageSlice } from "./contracts.js";
import { upkeepUsageRollup, type MessageUsageRollup, type MessageUsageSlice } from "./message-cost.js";
import { sumThreadUsage, sumUsageSlices, usageModelContributions } from "./thread-usage.js";

export interface UsageAnalyticsMessage {
  readonly threadId: string;
  readonly title: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly archived: boolean;
  readonly at: string;
  readonly role: string;
  readonly running: boolean;
  readonly rollup: MessageUsageRollup;
  readonly projectUsage: MessageUsageSlice;
}
const priced = (slice: WebUsageSlice) => slice.costUsd ?? slice.knownCostUsd ?? 0;
const hasUsage = (slice: WebUsageSlice) => slice.tokens !== undefined || slice.costUsd !== undefined || slice.pending;
const encoder = new TextEncoder();
const boundedModel = (model: string | undefined): string | undefined => model && model.trim() && !/[\u0000-\u001f\u007f]/u.test(model) && encoder.encode(model).byteLength <= 512 ? model : undefined;
const providerOf = (model: string | undefined): string | null => {
  if (!model) return null;
  const index = model.indexOf(":");
  const provider = model.slice(0, index);
  return index > 0 && /^[a-z0-9][a-z0-9-]*$/u.test(provider) && model.slice(index + 1).trim() ? provider : null;
};
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) { const k = key(item), group = groups.get(k) ?? []; group.push(item); groups.set(k, group); }
  return groups;
}

/** Canonicalize upkeep across the whole thread range BEFORE dividing into buckets. */
function contributions(rows: readonly UsageAnalyticsMessage[]): Array<{ at: string; rollup: MessageUsageRollup }> {
  const output: Array<{ at: string; rollup: MessageUsageRollup }> = rows.map(row => {
    const { upkeepAccounting: _accounting, upkeepPartial: _partial, ...rollup } = row.rollup;
    return { at: row.at, rollup };
  });
  const upkeep = upkeepUsageRollup(rows.flatMap(row => row.rollup.upkeepAccounting ?? []), rows.some(row => row.rollup.upkeepPartial));
  const anchors = new Map<string, string>();
  for (const row of rows) for (const op of row.rollup.upkeepAccounting ?? []) {
    const before = anchors.get(op.operationId);
    if (before === undefined || row.at < before) anchors.set(op.operationId, row.at);
  }
  for (const op of upkeep.accounting) output.push({ at: anchors.get(op.operationId)!, rollup: {
    main: {}, subagents: [], upkeepAccounting: [op], ...(upkeep.partial ? { upkeepPartial: true } : {}),
  } });
  if (upkeep.partial && !upkeep.accounting.length) output.push({ at: rows.find(row => row.rollup.upkeepPartial)?.at ?? rows[0]!.at,
    rollup: { main: {}, subagents: [], upkeepPartial: true } });
  return output;
}

/** Pure, bounded by the store's message budget. No prompts/parts enter its result. */
export function aggregateUsageAnalytics(sourceId: string, input: WebUsageAnalyticsQuery, rows: readonly UsageAnalyticsMessage[], computedAt: string): WebUsageAnalytics {
  const range = parseUsageHistoryRange(input);
  const assistant = rows.filter(row => row.role === "assistant");
  const byThread = groupBy(assistant, row => row.threadId);
  const buckets = new Map<number, { start: string; end: string; totals: MessageUsageSlice[]; models: Map<string | undefined, MessageUsageSlice[]> }>();
  let cursor = Date.parse(range.from);
  while (cursor < Date.parse(range.to)) {
    const bounds = usageHistoryBucket(cursor, range);
    buckets.set(bounds.start, { start: new Date(bounds.start).toISOString(), end: new Date(bounds.end).toISOString(), totals: [], models: new Map() });
    cursor = bounds.end;
  }
  const threadUsage = new Map<string, WebUsageSlice>();
  for (const [id, threadRows] of byThread) {
    // The legacy aggregate is the total's authority, including partial/pending markers.
    threadUsage.set(id, sumThreadUsage(threadRows.map(row => row.rollup), computedAt).total);
    const prepared = contributions(threadRows);
    const byBucket = groupBy(prepared, row => String(usageHistoryBucket(Date.parse(row.at), range).start));
    for (const [key, values] of byBucket) {
      const bucket = buckets.get(Number(key));
      if (!bucket) continue;
      const rolled = usageModelContributions(values.map(value => value.rollup));
      bucket.totals.push(rolled.total);
      for (const slice of rolled.byModel) {
        const model = boundedModel(slice.model);
        const group = bucket.models.get(model) ?? []; group.push(slice); bucket.models.set(model, group);
      }
    }
  }
  const total = sumUsageSlices([...threadUsage.values()]);
  const modelTotals = new Map<string | undefined, MessageUsageSlice[]>();
  for (const bucket of buckets.values()) for (const [model, slices] of bucket.models) {
    const group = modelTotals.get(model) ?? []; group.push(...slices); modelTotals.set(model, group);
  }
  // Keep the same 20 model colors for the entire range. Grouping never discards counters.
  const rankedModels = [...modelTotals].map(([model, slices]) => ({ model, usage: sumUsageSlices(slices) }))
    .sort((a, b) => priced(b.usage) - priced(a.usage) || (a.model ?? "").localeCompare(b.model ?? ""));
  const selected = new Set(rankedModels.slice(0, 20).map(row => row.model));
  const projects = new Map<string, { name: string; usage: MessageUsageSlice[]; comparable: MessageUsageSlice[] }>();
  const unassigned: MessageUsageSlice[] = [];
  const conversations = [...byThread].flatMap(([threadId, messages]) => {
    const usage = threadUsage.get(threadId)!;
    const row = messages[0]!;
    if (row.projectId) {
      const project = projects.get(row.projectId) ?? { name: row.projectName ?? "Project", usage: [], comparable: [] };
      project.usage.push(usage); projects.set(row.projectId, project);
    } else unassigned.push(usage);
    return hasUsage(usage) ? [{ threadId, title: row.title, usage }] : [];
  }).sort((a, b) => priced(b.usage) - priced(a.usage) || a.threadId.localeCompare(b.threadId));
  for (const row of rows) if (row.projectId && !row.archived) {
    const project = projects.get(row.projectId);
    if (project) project.comparable.push(row.projectUsage);
  }
  const projectRows = [...projects].map(([projectId, project]) => ({ projectId, name: project.name,
    usage: sumUsageSlices(project.usage), projectSummaryUsage: sumUsageSlices(project.comparable) }))
    .filter(row => hasUsage(row.usage)).sort((a, b) => priced(b.usage) - priced(a.usage) || a.projectId.localeCompare(b.projectId));
  return {
    schema: "mono-agent.usage-analytics.v1", sourceId, ...range, computedAt, attribution: "message-created-at", scope: "retained-conversations", total,
    buckets: [...buckets.values()].map(bucket => {
      const others: MessageUsageSlice[] = [];
      const models: Array<WebUsageSlice & { model: string | null; provider: string | null; other?: true }> = [...bucket.models].flatMap(([model, slices]) => {
        const usage = sumUsageSlices(slices);
        if (!selected.has(model)) { others.push(usage); return []; }
        return [{ ...usage, model: model ?? null, provider: providerOf(model) }];
      }).sort((a, b) => (a.model ?? "").localeCompare(b.model ?? ""));
      if (others.length) models.push({ ...sumUsageSlices(others), model: "Other models", provider: null, other: true });
      return { start: bucket.start, end: bucket.end, total: sumUsageSlices(bucket.totals), models };
    }),
    topConversations: conversations.slice(0, 10), topProjects: projectRows.slice(0, 10), unassignedUsage: sumUsageSlices(unassigned),
    coverage: { messages: assistant.length, conversations: conversations.length, projects: projectRows.length,
      containsRunningUsage: assistant.some(row => row.running), tokensPartial: total.tokensPartial === true,
      costPartial: total.costUsd === null || total.costPartial === true || total.costUsd === undefined && total.tokens !== undefined },
  };
}

export function validateUsageAnalyticsRange(input: WebUsageAnalyticsQuery): UsageHistoryRange { return parseUsageHistoryRange(input); }
