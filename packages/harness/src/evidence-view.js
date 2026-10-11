// @ts-check
import { planRepairEntries } from "./repair-entries.js";
import { createHash } from "node:crypto";
import { JournalValidator, validateJournalHeader } from "./journal-schema.js";

export const evidenceDigest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (reason) => { throw new TypeError(`Invalid native evidence view: ${reason}`); };
const views = new WeakSet();
const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

/**
 * Pure validation, not canonical authorization. The host supplies the frozen
 * current journal (or none when it is definitively missing), canonical gaps and
 * the prior accepted handoff it inherits. Nothing is opened for writing.
 * @param {{ownerKey:string, historyBucket:string, segments:any[], gaps?:any[], prior?:any}} input
 */
export function createEvidenceView(input) {
  if (!input?.ownerKey || !input.historyBucket || !Array.isArray(input.segments) || input.segments.length > 1) fail("owner/segments");
  const gaps = structuredClone(input.gaps ?? []);
  if (!Array.isArray(gaps) || gaps.some((g) => typeof g.reference !== "string" || !g.reference || typeof g.reason !== "string" || !g.reason
    || !(g.afterJournalId === null || typeof g.afterJournalId === "string") || !Array.isArray(g.messages))) fail("canonical gap");
  if (!input.segments.length && !gaps.length) fail("owner/segments");
  const prior = input.prior === undefined || input.prior === null ? null : structuredClone(input.prior);
  if (prior && (typeof prior !== "object" || !Array.isArray(prior.coverage) || !Array.isArray(prior.ledger))) fail("prior handoff");
  const priorCoverage = prior ? evidenceDigest({ version: 1, sources: prior.coverage.map(({ journalId, sourceTipId, sourceSeq, sourceDigest }) => ({ journalId, sourceTipId, sourceSeq, sourceDigest })) }) : null;
  const segments = input.segments.map((source) => {
    const { descriptor, header, records } = structuredClone({ descriptor: source.descriptor, header: source.header, records: source.records });
    validateJournalHeader(header);
    if (header.ownershipSchemaVersion === 2 && (header.hostAuthority.ownerKey !== input.ownerKey
      || header.hostAuthority.historyBucket !== input.historyBucket)) fail("upgraded header owner");
    if (!descriptor || descriptor.ownerKey !== input.ownerKey || descriptor.historyBucket !== input.historyBucket
      || descriptor.journalId !== header.journalId || descriptor.handleId !== header.id || !Array.isArray(records)
      || descriptor.sourceDigest !== evidenceDigest(records)) fail("identity/source");
    const validator = new JournalValidator(); const context = new Map(); const repairs = [];
    for (const record of records) {
      validator.apply(record);
      const p = record.payload;
      const binding = p.binding;
      if (binding && (binding.ownerKey !== input.ownerKey || binding.historyBucket !== input.historyBucket || binding.handleId !== header.id)) fail("binding");
      if (record.kind === "message" || record.kind === "compaction") context.set(record.id, {
        ...(record.kind === "message" ? { type: "message", message: p.message } : { ...p.compaction, type: "compaction" }),
        id: record.id, parentId: p.contextParentId, timestamp: record.timestamp, seq: record.seq, turnId: record.turnId,
      });
      if (record.kind === "interruption") repairs.push({ ...p, turnId: record.turnId, timestamp: record.timestamp });
    }
    if (descriptor.sourceTipId !== validator.tip || descriptor.sourceSeq !== validator.seq) fail("tip");
    const entries = []; for (let id = validator.tip; id !== null;) {
      const entry = context.get(id); if (!entry) fail("ancestry"); entries.unshift(entry); id = entry.parentId;
    }
    const visible = new Set(entries.map((e) => e.id));
    const plan = planRepairEntries({ tip: validator.tip, visible, interruptions: repairs, validator,
      timestamp: (id) => context.get(id).timestamp });
    const outcome = (call) => records.find((r) => r.kind === "tool_result" && r.payload.phase === "returned"
      && r.operationId === call.operationId && r.payload.callId === call.callId)?.payload.message;
    for (const repair of plan.repairs) repair.calls = repair.calls.map((call) => ({ ...call, returned: outcome(call) }));
    for (const addition of plan.additions) addition.account.calls.push({ ...addition.call, returned: outcome(addition.call) });
    return { descriptor, header, records, entries,
      repairs: plan.repairs,
      turns: [...validator.turns.values()].map((t) => ({ id: t.start.turnId, start: t.start, end: t.end })),
      allCalls: [...validator.calls.values()],
      calls: [...validator.calls.values()].filter((call) => visible.has(call.messageId)),
      inputs: [...validator.inputs].map(([id, data]) => ({ id, ...data })) };
  });
  // A composed checkpoint covers exactly the inherited prior handoff, never a guess.
  for (const segment of segments) for (const entry of segment.entries) {
    const coverage = entry.checkpoint?.inheritedCoverage;
    if (coverage && (priorCoverage === null || evidenceDigest(coverage) !== priorCoverage)) fail("composed coverage");
  }
  const view = freeze({ version: 1, gaps, prior, ownerKey: input.ownerKey, historyBucket: input.historyBucket, segments });
  views.add(view); return view;
}

/** @param {any} view */
export function assertEvidenceView(view) { if (!views.has(view)) fail("unvalidated view"); }
