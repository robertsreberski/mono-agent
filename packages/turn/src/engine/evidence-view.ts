// @ts-check
import { createHash } from "node:crypto";
import { JournalValidator, validateJournalHeader } from "./journal-schema.js";

export const evidenceDigest = (value: any) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (reason: string) => { throw new TypeError(`Invalid native evidence view: ${reason}`); };
const views = new WeakSet(), scanned = new WeakSet();
const freeze = (value: any) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

/**
 * Two passes over one frozen journal. Pass 1 validates, digests and indexes
 * every record; pass 2 retains only the effective tail (from the last
 * checkpoint's kept messages, or the whole epoch, which starts after any prior
 * handoff) plus the records cited by genuinely unresolved work: outcome-unknown
 * or unplaced calls from anywhere in the epoch (never dropped), and turns/calls
 * interrupted since the last completed turn.
 */
function segmentScanner({ descriptor, header }: { descriptor: any; header: any; }, owner: { ownerKey: string; historyBucket: string; }, maxBytes: number) {
  validateJournalHeader(header);
  if (header.hostAuthority !== undefined && (header.hostAuthority.ownerKey !== owner.ownerKey
    || header.hostAuthority.historyBucket !== owner.historyBucket)) fail("upgraded header owner");
  if (!descriptor || descriptor.ownerKey !== owner.ownerKey || descriptor.historyBucket !== owner.historyBucket
    || descriptor.journalId !== header.journalId || descriptor.handleId !== header.id) fail("identity/source");
  const validator = new JournalValidator(), digest = createHash("sha256").update("["), preserved = new Map(), records: any[] = [];
  let count = 0, bytes = 0, from = 1, settled = false, calls: any[] = [], visible = new Set(), open = new Set();
  const chain: string[] = [], cited = new Set(), causes = new Set(), returned = new Set();
  return {
    validate(record: any) {
      digest.update(`${count++ ? "," : ""}${JSON.stringify(record)}`); validator.apply(record);
      const binding = record.payload.binding;
      if (binding && (binding.ownerKey !== owner.ownerKey || binding.historyBucket !== owner.historyBucket || binding.handleId !== header.id)) fail("binding");
      if (record.kind === "compaction") preserved.set(record.id, record.payload.preservedMessageIds);
    },
    select() {
      if (descriptor.sourceDigest !== digest.update("]").digest("hex")) fail("identity/source");
      if (descriptor.sourceTipId !== validator.tip || descriptor.sourceSeq !== validator.seq) fail("tip");
      for (let id = validator.tip; id !== null;) { const info = validator.contextInfo.get(id); if (!info) fail("ancestry"); chain.push(id); id = info.parentId; }
      chain.reverse(); visible = new Set(chain);
      const checkpoint = chain.filter((id) => validator.contextInfo.get(id).kind === "compaction").at(-1);
      if (checkpoint !== undefined) from = validator.contextInfo.get(preserved.get(checkpoint).find((id: string) => visible.has(id)) ?? checkpoint).seq;
      // A completed model turn (a prompt operation), not an administrative write, resolves earlier work.
      const turns = [...validator.turns.values()], last = turns.map((turn) => turn.end?.payload.status === "completed"
        && turn.operations.some((id: string) => validator.operations.get(id).start.payload.type === "prompt")).lastIndexOf(true);
      settled = last >= 0; open = new Set(turns.slice(last + 1).filter((turn) => turn.end?.payload.status !== "completed").map((turn) => turn.start.turnId));
      calls = [...validator.calls.values()].filter((call) => (!call.result && call.admission === "started") || call.outcome === "unknown"
        || (call.result && !call.placed) || (open.has(call.turnId) && !(visible.has(call.messageId) && call.placed && call.outcome === "success")))
        .map((call) => ({ ...call, rewound: !visible.has(call.messageId) }));
      for (const call of calls) { cited.add(call.messageId); causes.add(call.turnId); returned.add(`${call.operationId}\0${call.callId}`); }
      for (const id of open) causes.add(id);
    },
    retain(record: any, size: number = 0) {
      const p = record.payload;
      if (!(record.seq >= from || cited.has(record.id) || (record.kind === "interruption" && causes.has(record.turnId))
        || (record.kind === "tool_result" && p.phase === "returned" && returned.has(`${record.operationId}\0${p.callId}`)))) return;
      if ((bytes += size) > maxBytes) throw Object.assign(new RangeError("Native evidence exceeds its retained byte limit"), { code: "ERR_JOURNAL_READ_LIMIT" });
      records.push(record);
    },
    build() {
      const context = new Map(records.filter((r) => r.kind === "message" || r.kind === "compaction").map((r) => [r.id, {
        ...(r.kind === "message" ? { type: "message", message: r.payload.message } : { ...r.payload.compaction, type: "compaction" }),
        id: r.id, parentId: r.payload.contextParentId, timestamp: r.timestamp, seq: r.seq, turnId: r.turnId }]));
      const entries = chain.filter((id) => validator.contextInfo.get(id).seq >= from).map((id) => context.get(id));
      const turnIds = new Set([...causes, ...entries.map((entry) => entry.turnId)]);
      const turns = [...validator.turns.values()].filter((t) => t.start.seq >= from || turnIds.has(t.start.turnId)).map((t) => ({ id: t.start.turnId, start: t.start, end: t.end }));
      return { ownerKey: owner.ownerKey, historyBucket: owner.historyBucket, descriptor, header, records, entries, turns, settled,
        openTurns: turns.filter((turn) => open.has(turn.id)), openCalls: calls, queuedInputs: [...validator.inputs].filter(([, data]) => data.state === "queued").map(([id, data]) => ({ id, ...data })) };
    },
  };
}

/**
 * Stream one frozen journal with the caller's reader (`each` visits every record
 * after the header, once per call). Only the selected records are retained.
 */
export async function scanEvidenceSegment(source: { descriptor: any; header: any; }, owner: { ownerKey: string; historyBucket: string; }, each: (visit: (record: any, bytes: number) => void) => Promise<void>, maxBytes: number = Infinity) {
  const scanner = segmentScanner(structuredClone(source), owner, maxBytes);
  await each((record) => scanner.validate(record)); scanner.select();
  await each((record, bytes) => scanner.retain(record, bytes));
  const segment = scanner.build(); scanned.add(segment); return segment;
}

/**
 * Pure validation, not canonical authorization. The host supplies the frozen
 * current journal (or none when it is definitively missing) as a streamed
 * segment or raw records, canonical gaps and the prior accepted handoff it
 * inherits. Nothing is opened for writing.
 */
export function createEvidenceView(input: { ownerKey: string; historyBucket: string; segments: any[]; gaps?: any[]; prior?: any; }) {
  if (!input?.ownerKey || !input.historyBucket || !Array.isArray(input.segments) || input.segments.length > 1) fail("owner/segments");
  const gaps = structuredClone(input.gaps ?? []);
  if (!Array.isArray(gaps) || gaps.some((g) => typeof g.reference !== "string" || !g.reference || typeof g.reason !== "string" || !g.reason
    || !(g.afterJournalId === null || typeof g.afterJournalId === "string") || !Array.isArray(g.messages))) fail("canonical gap");
  if (!input.segments.length && !gaps.length) fail("owner/segments");
  const prior = input.prior === undefined || input.prior === null ? null : structuredClone(input.prior);
  if (prior && (typeof prior !== "object" || !Array.isArray(prior.coverage) || !Array.isArray(prior.ledger))) fail("prior handoff");
  const priorCoverage = prior ? evidenceDigest({ version: 1, sources: prior.coverage.map(({ journalId, sourceTipId, sourceSeq, sourceDigest }: any) => ({ journalId, sourceTipId, sourceSeq, sourceDigest })) }) : null;
  const segments = input.segments.map((source) => {
    if (scanned.has(source)) {
      if (source.ownerKey !== input.ownerKey || source.historyBucket !== input.historyBucket) fail("identity/source");
      return source;
    }
    if (!Array.isArray(source?.records)) fail("identity/source");
    const records = structuredClone(source.records), scanner = segmentScanner(structuredClone({ descriptor: source.descriptor, header: source.header }), input, Infinity);
    for (const record of records) scanner.validate(record);
    scanner.select(); for (const record of records) scanner.retain(record);
    return scanner.build();
  });
  // A composed checkpoint covers exactly the inherited prior handoff, never a guess.
  for (const segment of segments) for (const entry of segment.entries) {
    const coverage = entry.checkpoint?.inheritedCoverage;
    if (coverage && (priorCoverage === null || evidenceDigest(coverage) !== priorCoverage)) fail("composed coverage");
  }
  const view = freeze({ version: 1, gaps, prior, ownerKey: input.ownerKey, historyBucket: input.historyBucket, segments });
  views.add(view); return view;
}

export function assertEvidenceView(view: any) { if (!views.has(view)) fail("unvalidated view"); }
