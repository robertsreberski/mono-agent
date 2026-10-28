import { resolve } from "node:path";
import { createUpkeepNamespaceNormalizer } from "./upkeep-accounting.js";
import { mergeAgentUpkeepAccounting, parseAgentUpkeepAccounting, type AgentUpkeepAccounting } from "@mono-agent/contracts";
import { isRecord } from "./artifact-fs.js";
import { recordedCost } from "./recorded-cost.js";
import type { InclusiveRunCost, RunRecorder, RunSummary, RuntimeEventLike, RuntimeResultLike } from "./types.js";

type Origin = Pick<RunSummary, "runId" | "conversationId" | "upkeepAccounting" | "upkeepAccountingPartial">;
/** Validate each contribution independently, preserving good evidence on conflict. */
export function runUpkeepAccounting(origin: Origin, candidates: readonly unknown[] = [], onInvalid?: () => void, normalizeNamespace: (namespace: string) => string = resolve): readonly AgentUpkeepAccounting[] {
  let values: readonly AgentUpkeepAccounting[] = [];
  for (const candidate of [...(origin.upkeepAccounting ?? []), ...candidates]) {
    try {
      const parsed = parseAgentUpkeepAccounting(candidate);
      const a = { ...parsed, recorderNamespace: normalizeNamespace(parsed.recorderNamespace) };
      if (a.runId !== origin.runId || a.conversationId !== origin.conversationId) continue;
      values = mergeAgentUpkeepAccounting([...values, a]);
    } catch { onInvalid?.(); }
  }
  return values;
}
export function upkeepEventAccounting(event: RuntimeEventLike): readonly unknown[] {
  return ["continuity_upkeep", "continuity_upkeep_dispatch"].includes(String(event.type)) && event.accounting !== undefined ? [event.accounting] : [];
}

/** Inference fields are never rewritten or repriced at the answer model. */
export function inclusiveRecordedCost(summary: Pick<RunSummary, "cost" | "usage">, upkeep: readonly AgentUpkeepAccounting[]): InclusiveRunCost {
  const inference = recordedCost(summary);
  let knownCostUsd = inference.total ?? inference.known ?? 0;
  let partial = inference.total == null;
  for (const a of mergeAgentUpkeepAccounting(upkeep)) {
    if (a.costUsd === null) partial = true;
    else if (Number.isFinite(knownCostUsd + a.costUsd)) knownCostUsd += a.costUsd;
    else partial = true;
  }
  return { totalUsd: partial ? null : knownCostUsd, knownCostUsd, partial };
}
export function withRecordedUpkeep<T extends Origin & Pick<RunSummary, "usage" | "cost">>(summary: T, candidates: readonly unknown[] = [], normalizeNamespace: (namespace: string) => string = resolve): T {
  let partial = summary.upkeepAccountingPartial === true;
  const upkeepAccounting = runUpkeepAccounting(summary, candidates, () => { partial = true; }, normalizeNamespace);
  if (!upkeepAccounting.length && !partial) return summary;
  const cost = inclusiveRecordedCost(summary, upkeepAccounting);
  return { ...summary, upkeepAccounting, ...(partial ? { upkeepAccountingPartial: true as const } : {}),
    inclusiveCost: partial ? { ...cost, totalUsd: null, partial: true } : cost };
}

const token = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
/** Numeric fields are known subtotals, not zero-coerced complete observations. */
export function sessionTokenTotals(usage: unknown, upkeep: readonly AgentUpkeepAccounting[]) {
  const r = isRecord(usage) ? usage : {};
  const vectors = [[token(r.input_tokens ?? r.input), token(r.cache_read_tokens ?? r.cacheRead ?? r.cachedInput),
    token(r.cache_creation_tokens ?? r.cache_write_tokens ?? r.cacheWrite ?? r.cacheCreation), token(r.output_tokens ?? r.output)],
  ...mergeAgentUpkeepAccounting(upkeep).map(a => [a.inputTokens, a.cacheReadTokens, a.cacheWriteTokens, a.outputTokens])];
  const known = [0, 0, 0, 0], complete = [true, true, true, true];
  for (const vector of vectors) vector.forEach((n, i) => {
    if (n === null || n === undefined || !Number.isSafeInteger(known[i]! + n)) complete[i] = false;
    else known[i]! += n;
  });
  const [tokIn = 0, tokCacheRead = 0, tokCacheWrite = 0, tokOut = 0] = known;
  const inputTotal = tokIn + tokCacheRead + tokCacheWrite;
  const inputsComplete = complete.slice(0, 3).every(Boolean) && Number.isSafeInteger(inputTotal);
  return { tokIn, tokOut, tokCache: tokCacheRead + tokCacheWrite, tokCacheRead, tokCacheWrite,
    ...(!complete.every(Boolean) || !inputsComplete ? { tokensPartial: true as const } : {}),
    ...(inputsComplete ? { tokInputTotal: inputTotal, ...(inputTotal ? { cacheHitRatio: tokCacheRead / inputTotal } : {}) } : {}) };
}

/** A host-owned receipt sink, outside runtime attempts and recorder injection.
 * A failed/cancelled attempt can never discard receipts already observed here. */
export function withUpkeepAccounting(recorder: RunRecorder, runId: string, conversationId: string): RunRecorder {
  const normalizeNamespace = createUpkeepNamespaceNormalizer();
  let upkeepAccounting: readonly AgentUpkeepAccounting[] = [];
  let partial = false;
  let terminal: Promise<RunSummary> | undefined;
  const origin = () => ({ runId, conversationId, upkeepAccounting, ...(partial ? { upkeepAccountingPartial: true as const } : {}) });
  const result = (value: RuntimeResultLike): RuntimeResultLike => upkeepAccounting.length || partial ? { ...value, upkeepAccounting, ...(partial ? { upkeepAccountingPartial: true as const } : {}) } : value;
  const snapshot = (summary: RunSummary): RunSummary => {
    if (!upkeepAccounting.length && !partial) return summary;
    // Recorder injection is untrusted: never spread its summary or execute
    // getters/toJSON while adding host-owned fields. External shaping retains
    // its existing descriptor-based fail-closed behavior for all other fields.
    try {
      const descriptors = Object.getOwnPropertyDescriptors(summary);
      const billing = (key: "cost" | "usage") => {
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor) || !isRecord(descriptor.value)) return undefined;
        const own = Object.getOwnPropertyDescriptors(descriptor.value);
        return Object.fromEntries(["cumulativeUsd", "totalUsd", "knownCostUsd", "knownUsd", "cost_usd", "known_cost_usd"]
          .flatMap(k => own[k] && "value" in own[k]! ? [[k, own[k]!.value]] : []));
      };
      const cost = inclusiveRecordedCost({ cost: billing("cost"), usage: billing("usage") }, upkeepAccounting);
      const data = (value: unknown) => ({ value, enumerable: true, configurable: true });
      return Object.create(Object.getPrototypeOf(summary), { ...descriptors,
        upkeepAccounting: data(upkeepAccounting),
        inclusiveCost: data(partial ? { ...cost, totalUsd: null, partial: true } : cost),
        upkeepAccountingPartial: { value: partial ? true : undefined, enumerable: partial, configurable: true },
      }) as RunSummary;
    } catch { return summary; } // Unsafe recorder objects remain fail-closed at the external boundary.
  };
  const finish = (work: () => Promise<RunSummary>, recover = false): Promise<RunSummary> => {
    if (terminal) return recover ? terminal.catch(() => finish(work, true)) : terminal;
    const pending = work().then(snapshot);
    terminal = pending;
    void pending.catch(() => { if (terminal === pending) terminal = undefined; });
    return pending;
  };
  return {
    ...(recorder.start ? { start: async () => snapshot(await recorder.start!()) } : {}),
    onEvent(event) {
      const candidates = upkeepEventAccounting(event);
      if (candidates.length) upkeepAccounting = runUpkeepAccounting(origin(), candidates, () => { partial = true; }, normalizeNamespace);
      return recorder.onEvent(event);
    },
    ...(recorder.prepareFinish ? { prepareFinish: (value: RuntimeResultLike) => recorder.prepareFinish!(result(value)) } : {}),
    ...(recorder.commitFinish ? { commitFinish: (value: RuntimeResultLike) => finish(() => recorder.commitFinish!(result(value))) } : {}),
    finish: value => finish(() => recorder.finish(result(value)), value.cancelled === true),
    fail: (error, context) => finish(() => recorder.fail(error, context), true),
  };
}
