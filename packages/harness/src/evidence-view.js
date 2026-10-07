// @ts-check
import { planRepairEntries } from "./repair-entries.js";
import { createHash } from "node:crypto";
import { JournalValidator, validateJournalHeader } from "./journal-schema.js";

export const evidenceDigest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (reason) => { throw new TypeError(`Invalid native evidence view: ${reason}`); };
const views = new WeakSet();
const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

/**
 * Pure validation, not canonical authorization. The host supplies its authorized
 * ordered descriptors and exact frozen bytes. No predecessor is opened for writing.
 * @param {{ownerKey:string, historyBucket:string, segments:any[], gaps?:any[]}} input
 */
export function createEvidenceView(input) {
  if (!input?.ownerKey || !input.historyBucket || !Array.isArray(input.segments) || !input.segments.length) fail("owner/segments");
  const gaps = structuredClone(input.gaps ?? []);
  if (!Array.isArray(gaps) || gaps.some((g) => typeof g.reference !== "string" || !g.reference || typeof g.reason !== "string" || !g.reason
    || !(g.afterJournalId === null || typeof g.afterJournalId === "string") || !Array.isArray(g.messages))) fail("canonical gap");
  const seen = new Set(); let predecessor = null;
  const segments = input.segments.map((source) => {
    const { descriptor, header, records } = structuredClone({ descriptor: source.descriptor, header: source.header, records: source.records });
    validateJournalHeader(header);
    if (header.ownershipSchemaVersion === 2 && (header.hostAuthority.ownerKey !== input.ownerKey
      || header.hostAuthority.historyBucket !== input.historyBucket)) fail("upgraded header owner");
    if (!descriptor || descriptor.ownerKey !== input.ownerKey || descriptor.historyBucket !== input.historyBucket
      || descriptor.journalId !== header.journalId || descriptor.handleId !== header.id
      || descriptor.predecessorJournalId !== predecessor || seen.has(header.journalId)
      || !Number.isSafeInteger(descriptor.epoch) || descriptor.epoch < 0 || !Array.isArray(records)
      || descriptor.sourceDigest !== evidenceDigest(records)) fail("chain/identity/source");
    seen.add(header.journalId); predecessor = header.journalId;
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
  for (let i = 1; i < segments.length; i++) if (segments[i].descriptor.epoch <= segments[i - 1].descriptor.epoch) fail("epoch");
  for (let index = 0; index < segments.length; index++) for (const entry of segments[index].entries) {
    const coverage = entry.checkpoint?.inheritedCoverage;
    if (coverage && (coverage.sources.length !== index || coverage.sources.some((s, i) =>
      !matchesEvidenceCoverage(s, segments[i])))) fail("composed coverage");
  }
  if (gaps.some((g) => g.afterJournalId !== null && !seen.has(g.afterJournalId))) fail("gap linkage");
  const view = freeze({ version: 1, gaps, ownerKey: input.ownerKey, historyBucket: input.historyBucket, segments });
  views.add(view); return view;
}

/** A composed checkpoint can name the exact source before its later reference
 * frame. Only a proved model-change triplet may follow that covered prefix.
 * @param {any} reference @param {any} segment */
export function matchesEvidenceCoverage(reference, segment) {
  const source = segment.descriptor;
  if (reference.journalId !== source.journalId || reference.sourceTipId !== source.sourceTipId) return false;
  if (reference.sourceSeq === source.sourceSeq) return reference.sourceDigest === source.sourceDigest;
  if (!Number.isSafeInteger(reference.sourceSeq) || reference.sourceSeq < 0 || reference.sourceSeq + 3 !== source.sourceSeq) return false;
  const prefix = segment.records.slice(0, reference.sourceSeq), [start, change, end] = segment.records.slice(reference.sourceSeq);
  return evidenceDigest(prefix) === reference.sourceDigest && start?.kind === "turn_start" && start.payload.identitySource === "synthetic"
    && start.payload.config?.cause === "model-change" && start.payload.baselineTipId === reference.sourceTipId
    && change?.kind === "model_change" && end?.kind === "turn_end" && end.payload.status === "completed"
    && end.payload.tipId === reference.sourceTipId && start.turnId === change.turnId && start.turnId === end.turnId;
}

/** @param {any} view */
export function assertEvidenceView(view) { if (!views.has(view)) fail("unvalidated view"); }

/** Positive account matching is ONLY a switch rule, never a same-model reopen rule. */
export function nativeCompatibility(source, target) {
  for (const key of ["provider", "api", "account"]) {
    if (typeof source?.[key] !== "string" || !source[key].trim() || source[key].trim().toLowerCase() === "unknown"
      || typeof target?.[key] !== "string" || !target[key].trim() || target[key].trim().toLowerCase() === "unknown") return { compatible: false, reason: `unknown_${key}` };
    if (source[key] !== target[key]) return { compatible: false, reason: `different_${key}` };
  }
  return { compatible: true, reason: "matching_provenance" };
}

