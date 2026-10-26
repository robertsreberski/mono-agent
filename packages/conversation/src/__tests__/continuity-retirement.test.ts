import type { ContinuityUpkeepReceipt } from "@mono-agent/turn/host";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { ToolHistoryWriter } from "../tool-history/writer.js";
import { ToolHistoryReader } from "../tool-history/reader.js";
import { continuityGenerationId, continuityRecordId } from "../tool-history/continuity-storage.js";
import { createProgressSchema, readProgress, reclaimUpkeepQuota, upkeepBytes } from "../continuity/progress.js";
import { readRetired, writeRetired } from "../continuity/retirement.js";
import { ledgerHash, selectLedgerSources, spanKey, validateLedgerOutput } from "../continuity/ledger.js";
import type { UpkeepReservation } from "../continuity/admission.js";
import { persistContinuityPurge } from "../tool-history/continuity-purge.js";

const scope = { logicalConversationId: "fictional", currentConversationId: "fictional", currentRunId: "next" };
const resources: { root: string; writer: ToolHistoryWriter }[] = [];
const receipt = (r: UpkeepReservation, extra: Partial<ContinuityUpkeepReceipt> = {}): ContinuityUpkeepReceipt => ({
  operationId: r.operationId, model: r.model, api: "fictional", capEnforcement: "request", status: "valid", reason: "completed", providerInvoked: true,
  elapsedMs: 1, inputTokens: 25, outputTokens: 2, estimatedInputTokens: 30, estimatedInputCostUsd: 0.0001, costUsd: 0.0002, visibleEstimate: 2, outputOverrun: false, ...extra,
});
afterEach(async () => { for (const f of resources.splice(0)) { await f.writer.close(); await rm(f.root, { recursive: true, force: true }); } });
async function fixture(text = "Neutral source.", count = 4) {
  const root = await mkdtemp(join(tmpdir(), "sparse-ledger-"));
  const f = { root, writer: await ToolHistoryWriter.open({ root, continuityEnabled: true, persistenceCeilingMs: 5000 }) }; resources.push(f);
  const reader = new ToolHistoryReader(root);
  const capture = async (physical = "fictional") => {
    const generationId = continuityGenerationId(), digest = ledgerHash(generationId);
    await f.writer.prepareContinuity({ generationId, conversationId: physical, logicalConversationId: "fictional", beforeDigest: null, afterDigest: digest,
      records: Array.from({ length: count }, (_, i) => ({ recordId: continuityRecordId(physical, `${generationId}-${i}`), runId: generationId, kind: "user" as const, provenance: "unknown" as const, sequence: i, text })) });
    await f.writer.commitContinuity({ generationId, conversationId: physical, canonicalDigest: digest }); return generationId;
  };
  const generation = await capture();
  const db = <T>(fn: (d: DatabaseSync) => T) => { const d = new DatabaseSync(reader.databasePath); d.exec("PRAGMA foreign_keys=ON;BEGIN IMMEDIATE"); try { const result = fn(d); d.exec("COMMIT"); return result; } catch (e) { d.exec("ROLLBACK"); throw e; } finally { d.close(); } };
  const choose = (ordinals?: number[], physical = "fictional") => {
    const snapshot = reader.snapshotContinuity({ ...scope, currentConversationId: physical, selection: "upkeep" });
    // Explicit sparse request exercises the future caller contract without enabling
    // ranking/re-eligibility in the production chronological selector.
    return selectLedgerSources({ ...snapshot, records: ordinals ? snapshot.records.filter(r => ordinals.includes(r.ordinal)) : snapshot.records }, undefined, 128000);
  };
  const reserve = async (selection = choose(), physical = "fictional") => {
    const expected = (await f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: physical } }))!;
    const fence = expected.ownerToken ? expected : (await f.writer.mutateUpkeep({ kind: "claim", expected, ownerToken: "owner" }))!;
    const reservation: UpkeepReservation = { ...fence, operationId: randomUUID(), runId: "next", recorderNamespace: "fictional", model: "fictional:model", manifest: selection.manifest,
      parent: reader.ledger({ ...scope, currentConversationId: physical })?.generation.id ?? null, budget: fence.bootstrap ? "bootstrap" : "incremental", progress: selection.progress! };
    await f.writer.mutateUpkeep({ kind: "reserve", reservation }); return reservation;
  };
  const dispatch = (reservation: UpkeepReservation) => f.writer.mutateUpkeep({ kind: "dispatch", reservation });
  const finish = async (reservation: UpkeepReservation, saturated = false) => {
    await f.writer.mutateUpkeep({ kind: "outcome", reservation, receipt: receipt(reservation) });
    await f.writer.mutateUpkeep({ kind: "settle", reservation, saturated, analysisOnly: true });
  };
  const compact = () => db(d => reclaimUpkeepQuota(d, () => false));
  const counts = () => db(d => [...(d.prepare("SELECT ordinal,start,end,offer_count count,state FROM continuity_upkeep_offers ORDER BY ordinal,start").all() as any[]), ...readRetired(d, "fictional", "fictional")]);
  return { f, reader, db, choose, reserve, dispatch, finish, compact, counts, capture, generation };
}

it("keeps sparse late offers exact across LRU/restart/replay, leaves early holes payable, and rejects a third offer", async () => {
  const x = await fixture(), late = x.choose([4]), first = await x.reserve(late);
  await x.dispatch(first); await x.dispatch(first); expect(x.counts()).toMatchObject([{ ordinal: 4, count: 1 }]);
  await x.finish(first, true); const before = x.db(upkeepBytes); x.compact();
  expect(x.db(upkeepBytes)).toBeLessThan(before);
  expect(x.db(d => d.prepare("SELECT count(*) n FROM continuity_upkeep_offers").get())).toEqual({ n: 0 });
  expect(x.db(d => JSON.parse((d.prepare("SELECT cursor FROM continuity_upkeep_progress").get() as any).cursor))).toMatchObject({ ordinal: 1, offset: 0 });
  expect(x.choose().spans.map(s => s.ordinal)).toEqual([1, 2, 3, 4]); // Existing reofferability, not the new policy.
  await x.f.writer.close(); x.f.writer = await ToolHistoryWriter.open({ root: x.f.root, continuityEnabled: true });
  const second = await x.reserve(x.choose([4])); await x.dispatch(second); await x.dispatch(second); await x.finish(second); x.compact();
  expect(x.counts()).toMatchObject([{ ordinal: 4, count: 2, state: "analyzed" }]);
  // Force a source-valid caller request for the terminal tuple, bypassing only
  // the selector exclusion; the durable dispatch contract still rejects it.
  await expect(x.f.writer.mutateUpkeep({ kind: "reserve", reservation: second })).rejects.toThrow("upkeep_admission_conflict");
  const third = await x.reserve({ ...late, manifest: ledgerHash("third-offer") });
  await expect(x.dispatch(third)).rejects.toMatchObject({ code: "upkeep_dispatch_rejected" });
  expect(x.counts()).toMatchObject([{ ordinal: 4, count: 2 }]);
  const early = await x.reserve(x.choose([1, 2, 3])); await x.dispatch(early); await x.finish(early);
  expect(x.counts().sort((a, b) => a.ordinal - b.ordinal).map(s => [s.ordinal, s.count])).toEqual([[1, 1], [2, 1], [3, 1], [4, 2]]);
  expect(x.db(d => readProgress(d, "fictional", "fictional", 4).cursor?.ordinal)).toBe(4); // Conservative upper-bound under-advancement is allowed.
});

it("refunds proven non-invocation, including a second dispatch, without granting a third paid offer", async () => {
  const x = await fixture("Neutral source.", 1), selection = x.choose(), first = await x.reserve(selection);
  await x.dispatch(first);
  const release = async (r: UpkeepReservation) => x.f.writer.mutateUpkeep({ kind: "outcome", reservation: r, receipt: receipt(r, { providerInvoked: false, status: "skipped", reason: "cap_unsupported" }) });
  await release(first); await release(first);
  expect(x.counts()).toMatchObject([{ count: 0, state: "available" }]);
  expect(x.db(d => readProgress(d, "fictional", "fictional", 1).cursor?.ordinal)).toBe(1);
  const paid = await x.reserve(selection); await x.dispatch(paid); await x.finish(paid, true);
  const notInvoked = await x.reserve(selection); await x.dispatch(notInvoked); await release(notInvoked);
  expect(x.counts()).toMatchObject([{ count: 1, state: "available" }]);
  const last = await x.reserve(selection); await x.dispatch(last); await x.finish(last); x.compact();
  const excess = await x.reserve(selection); await expect(x.dispatch(excess)).rejects.toMatchObject({ code: "upkeep_dispatch_rejected" });
  expect(x.counts()).toMatchObject([{ count: 2 }]);
});

it("counts uncertainty conservatively and never compacts pending/uncertain work; repeated purge keeps only opaque identity", async () => {
  const x = await fixture(), r = await x.reserve(); await x.dispatch(r); x.compact();
  expect(x.counts()).toHaveLength(4); expect(x.counts().every(s => s.count === 1 && s.state === "uncertain")).toBe(true);
  expect(x.db(d => readRetired(d, "fictional", "fictional"))).toEqual([]);
  await x.f.writer.mutateUpkeep({ kind: "outcome", reservation: r, receipt: receipt(r, { providerInvoked: false, status: "invalid", reason: "lost" }) });
  await expect(x.reserve()).rejects.toMatchObject({ code: "upkeep_repeat_suppressed" });
  for (let i = 0; i < 2; i++) { persistContinuityPurge(x.f.root, { scope: "physical", conversationId: "fictional" }); await x.f.writer.stats(); }
  expect(x.counts()).toHaveLength(4); expect(x.counts().every(s => s.ordinal === 0 && s.start === 0 && s.end === 0 && s.count === 1)).toBe(true);
  const stored = x.db(d => d.prepare("SELECT reservation FROM continuity_upkeep_operations").get()) as any;
  expect(JSON.parse(stored.reservation)).toMatchObject({ purged: 1 }); expect(JSON.parse(stored.reservation)).not.toHaveProperty("progress");
});

it("validates canonical geometry and source keys before charging, preventing alternate-coordinate/key count evasion", async () => {
  const x = await fixture("Neutral Ω paragraph.\n\n" + "z".repeat(18000), 1), selected = x.choose(), r = await x.reserve(selected);
  for (const forged of [
    { ...r.progress!, spans: r.progress!.spans.map((s, i) => i ? s : { ...s, key: "f".repeat(64) }) },
    { ...r.progress!, spans: r.progress!.spans.map((s, i) => {
      if (i !== r.progress!.spans.length - 1) return s;
      const original = selected.spans[i]!, end = s.end - 1;
      const digest = ledgerHash(Buffer.from(selected.records[0]!.text).subarray(s.start, end));
      return { ...s, end, key: spanKey({ ...original, end, digest }) };
    }) },
  ]) {
    const reservation = { ...r, operationId: randomUUID(), manifest: ledgerHash(randomUUID()), progress: forged }; await x.f.writer.mutateUpkeep({ kind: "reserve", reservation });
    await expect(x.dispatch(reservation)).rejects.toMatchObject({ code: "upkeep_dispatch_rejected" });
  }
  expect(x.counts()).toEqual([]); await x.dispatch(r); await x.finish(r);
  expect(x.counts().every(s => s.count === 1)).toBe(true);
});

it("never jumps an early or interior unpaid hole for an oversized mutation and never overwrites a later frontier", async () => {
  const x = await fixture("One.\n\nTwo.\n\nThree.", 1), selection = x.choose(), r = await x.reserve(selection);
  const oversizedId = randomUUID();
  const progress = { ...r.progress!, spans: [r.progress!.spans[2]!] };
  await x.f.writer.mutateUpkeep({ kind: "oversized", fence: r, operationId: oversizedId, progress, advance: true });
  expect(x.counts()).toMatchObject([{ start: 12, count: 0, state: "oversized" }]);
  expect(x.db(d => readProgress(d, "fictional", "fictional", 1).cursor?.offset)).toBe(0);
  const first = await x.reserve({ ...selection, manifest: ledgerHash("first"), progress: { ...progress, spans: [r.progress!.spans[0]!] } }); await x.dispatch(first); await x.finish(first);
  expect(x.db(d => readProgress(d, "fictional", "fictional", 1).cursor?.offset)).toBe(6);
  const middle = await x.reserve({ ...selection, manifest: ledgerHash("middle"), progress: { ...progress, spans: [r.progress!.spans[1]!] } }); await x.dispatch(middle); await x.finish(middle);
  const later = x.db(d => readProgress(d, "fictional", "fictional", 1).cursor);
  expect(later?.ordinal).toBe(2);
  // An identical oversized acknowledgement is free and cannot move back.
  await x.f.writer.mutateUpkeep({ kind: "oversized", fence: r, operationId: oversizedId, progress, advance: true });
  expect(x.db(d => readProgress(d, "fictional", "fictional", 1).cursor)).toMatchObject({ ordinal: later!.ordinal, offset: later!.offset, digest: later!.digest });
});

it.each(["update", "delete", "generation", "logical", "physical"] as const)("purges compact tuples exactly for %s without clearing unrelated sources or renewing bootstrap", async kind => {
  const x = await fixture(), r = await x.reserve(); await x.dispatch(r); await x.finish(r); x.compact();
  await x.capture("other"); const other = await x.reserve(x.choose(undefined, "other"), "other"); await x.dispatch(other); await x.finish(other); x.compact();
  if (kind === "update") x.db(d => d.exec("UPDATE continuity_records SET retained_text='Changed.',text_sha256='changed' WHERE ordinal=1"));
  else if (kind === "delete") x.db(d => d.exec("DELETE FROM continuity_records WHERE ordinal=1"));
  else if (kind === "generation") x.db(d => d.prepare("DELETE FROM continuity_generations WHERE generation_id=?").run(x.generation));
  else { persistContinuityPurge(x.f.root, kind === "logical" ? { scope: "logical", conversationId: "fictional" } : { scope: "physical", conversationId: "fictional" }); await x.f.writer.stats(); }
  expect(x.db(d => readRetired(d, "fictional", "fictional")).map(s => s.ordinal)).toEqual(kind === "update" || kind === "delete" ? [2, 3, 4] : []);
  expect(x.db(d => readRetired(d, "fictional", "other")).length).toBe(kind === "logical" ? 0 : 4);
  expect((await x.f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } }))!.bootstrap).toBe(false);
});

it("retains compact representation through publication and reconstructs only once after invalidation", async () => {
  const x = await fixture(), selection = x.choose(), r = await x.reserve(selection); await x.dispatch(r); await x.finish(r);
  const generation = validateLedgerOutput(JSON.stringify({ entries: [{ kind: "open_work", value: "Retained state.", status: "unknown", sources: ["s0"] }], covered: ["s0"] }), selection, scope);
  await x.f.writer.publishLedger(generation, r); x.compact();
  expect(x.db(d => readRetired(d, "fictional", "fictional")).find(s => s.ordinal === 1)).toMatchObject({ state: "represented", count: 1 });
  await x.capture(); const extra = x.choose([5]), next = await x.reserve(extra); await x.dispatch(next); await x.finish(next);
  const replacement = validateLedgerOutput(JSON.stringify({ entries: [{ kind: "open_work", value: "New state.", status: "unknown", sources: ["s0"] }], covered: ["s0"] }), extra, scope, generation);
  await x.f.writer.publishLedger(replacement, next); x.compact();
  expect(x.db(d => readRetired(d, "fictional", "fictional")).find(s => s.ordinal === 1)).toMatchObject({ state: "represented", count: 1 });
  // Existing ancestry-purge behavior invalidates the ledger on an uncited input.
  x.db(d => d.exec("UPDATE continuity_records SET retained_text=NULL WHERE ordinal=2"));
  expect(x.reader.ledger(scope)).toBeUndefined();
  expect(x.db(d => readRetired(d, "fictional", "fictional")).find(s => s.ordinal === 1)).toMatchObject({ state: "unrepresented", count: 1 });
  const rebuilt = x.choose([1]), second = await x.reserve(rebuilt); await x.dispatch(second); await x.finish(second);
  const successor = validateLedgerOutput(JSON.stringify({ entries: [{ kind: "open_work", value: "Reconstructed.", status: "unknown", sources: ["s0"] }], covered: ["s0"] }), rebuilt, scope);
  await x.f.writer.publishLedger(successor, second); x.compact(); x.db(d => d.exec("DELETE FROM continuity_ledger"));
  expect(x.db(d => readRetired(d, "fictional", "fictional")).find(s => s.ordinal === 1)).toMatchObject({ state: "lost", count: 2 });
});

it("migrates legacy attempts conservatively and preserves but never extends a legacy floor", async () => {
  const x = await fixture("Neutral.", 6), r = await x.reserve(); await x.dispatch(r); await x.finish(r);
  x.db(d => { d.exec(`UPDATE continuity_upkeep_offers SET state=CASE ordinal WHEN 1 THEN 'represented' WHEN 2 THEN 'reofferable' WHEN 3 THEN 'oversized' WHEN 4 THEN 'uncertain' WHEN 5 THEN 'available' ELSE 'analyzed' END,attempt=CASE WHEN ordinal IN (2,5) THEN 1 ELSE 0 END;
    ALTER TABLE continuity_upkeep_offers DROP COLUMN offer_count;
    UPDATE continuity_upkeep_progress SET cursor=json_set(cursor,'$.retiredThrough',2);`); createProgressSchema(d); });
  expect(x.counts().map(s => s.count)).toEqual([1, 2, 0, 1, 2, 1]);
  expect(x.counts()[4]).toMatchObject({ state: "analyzed", count: 2 });
  expect(x.db(d => readProgress(d, "fictional", "fictional", 6).cursor?.ordinal)).toBe(7);
  x.db(d => d.exec("UPDATE continuity_upkeep_offers SET state='failed' WHERE state='uncertain'")); x.compact();
  expect(x.db(d => JSON.parse((d.prepare("SELECT cursor FROM continuity_upkeep_progress").get() as any).cursor).retiredThrough)).toBe(2);
});

it("bounds packed chunks and the combined live identity allowance; compaction does not discard counts to fit quota", async () => {
  const x = await fixture("Neutral.", 1); await x.reserve();
  const incarnation = x.db(d => (d.prepare("SELECT incarnation FROM continuity_upkeep_scopes").get() as any).incarnation);
  const entries = Array.from({ length: 65536 }, (_, i) => ({ ordinal: i + 2, start: 0, end: 1, count: 2, state: "analyzed" }));
  x.db(d => writeRetired(d, "fictional", "fictional", incarnation, entries, null));
  expect(x.db(d => d.prepare("SELECT count(*) n,sum(length(data)) bytes,max(length(data)) max FROM continuity_upkeep_retired").get())).toEqual({ n: 9, bytes: 1114112, max: 131070 });
  const before = x.db(upkeepBytes); expect(before).toBeGreaterThan(1114112);
  expect(() => x.db(d => writeRetired(d, "fictional", "fictional", incarnation, [...entries, { ...entries[0]!, ordinal: 70000 }], null))).toThrow("upkeep_progress_capacity");
  const excess = await x.reserve({ ...x.choose(), manifest: ledgerHash("excess") }); await expect(x.dispatch(excess)).rejects.toMatchObject({ code: "upkeep_dispatch_rejected" });
  x.compact(); expect(x.db(d => readRetired(d, "fictional", "fictional"))).toHaveLength(65536);
  expect(x.db(upkeepBytes)).toBeGreaterThanOrEqual(1114112); // fits=false never erases identity evidence.
});

it("fails shared-quota admission without discarding compact counts for pinned surviving evidence", async () => {
  const x = await fixture("Pinned source.", 1), selection = x.choose(), r = await x.reserve(selection); await x.dispatch(r); await x.finish(r); x.compact();
  await x.f.writer.pinContinuity({ logicalConversationId: "fictional", recordId: selection.records[0]!.recordId, ownerKind: "ledger", ownerId: "pin" });
  const expected = (await x.f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } }))!;
  const fence = (await x.f.writer.mutateUpkeep({ kind: "claim", expected, ownerToken: "quota-owner" }))!;
  const bytes = x.db(d => upkeepBytes(d) + Number((d.prepare("SELECT sum(retained_bytes) n FROM continuity_records").get() as any).n));
  await x.f.writer.close(); x.f.writer = await ToolHistoryWriter.open({ root: x.f.root, continuityEnabled: true, retention: { maxBytes: bytes - 1 } });
  const excess = { ...r, ...fence, budget: "incremental" as const, operationId: randomUUID(), manifest: ledgerHash("new-operation") };
  await expect(x.f.writer.mutateUpkeep({ kind: "reserve", reservation: excess })).rejects.toMatchObject({ code: "continuity_quota_exhausted" });
  expect(x.db(d => readRetired(d, "fictional", "fictional"))).toMatchObject([{ count: 1, state: "analyzed" }]);
  expect(x.db(d => d.prepare("SELECT count(*) n FROM continuity_records WHERE retained_text IS NOT NULL").get())).toEqual({ n: 1 });
});

it("uses one identity allowance across working and packed state and validates the versioned encoding", async () => {
  const x = await fixture("One.\n\nTwo.", 1), selection = x.choose();
  const first = await x.reserve({ ...selection, progress: { ...selection.progress!, spans: [selection.progress!.spans[0]!] } }); await x.dispatch(first); await x.finish(first, true);
  x.db(d => writeRetired(d, "fictional", "fictional", first.incarnation, Array.from({ length: 65535 }, (_, i) => ({ ordinal: i + 2, start: 0, end: 1, count: 2, state: "analyzed" })), null));
  const next = await x.reserve(); await expect(x.dispatch(next)).rejects.toMatchObject({ code: "upkeep_dispatch_rejected" });
  expect(x.counts()).toHaveLength(65536);
  const reuse = await x.reserve({ ...selection, manifest: ledgerHash("capacity-reuse"), progress: first.progress! }); await x.dispatch(reuse); await x.finish(reuse);
  expect(x.counts().find(s => s.ordinal === 1)).toMatchObject({ count: 2 }); // Reuse does not consume a new identity slot.
  for (const sql of ["UPDATE continuity_upkeep_retired SET version=2", "UPDATE continuity_upkeep_retired SET data=x'FF'", "UPDATE continuity_upkeep_retired SET data=zeroblob(131073)"]) {
    expect(() => x.db(d => { d.exec(sql); readRetired(d, "fictional", "fictional"); })).toThrow("upkeep_retirement_encoding");
  }
});

it("keeps current-fence acknowledgements until ownership changes, then safely trims the old journal tail", async () => {
  const x = await fixture("Neutral.", 72); let old: UpkeepReservation | undefined;
  for (let ordinal = 1; ordinal <= 70; ordinal++) {
    const r = await x.reserve(x.choose([ordinal])); await x.dispatch(r); await x.finish(r); if (ordinal === 2) old = r;
  }
  expect(x.db(d => d.prepare("SELECT count(*) n FROM continuity_upkeep_operations").get())).toEqual({ n: 70 });
  await x.f.writer.mutateUpkeep({ kind: "reserve", reservation: old! });
  await expect(x.dispatch(old!)).rejects.toThrow("upkeep_admission_conflict");
  expect(x.counts().every(s => s.count === 1)).toBe(true);
  const expected = (await x.f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } }))!;
  await x.f.writer.mutateUpkeep({ kind: "claim", expected, ownerToken: "new-owner" });
  const next = await x.reserve(x.choose([71])); await x.dispatch(next); await x.finish(next);
  expect(x.db(d => d.prepare("SELECT count(*) n FROM continuity_upkeep_operations").get())).toEqual({ n: 64 });
  await expect(x.f.writer.mutateUpkeep({ kind: "reserve", reservation: old! })).rejects.toThrow("upkeep_admission_conflict");
  expect(x.counts().every(s => s.count === 1)).toBe(true);
});

it("compacts an oversized-only scope even before any reservation or cursor was created", async () => {
  const x = await fixture(), selected = x.choose([4]);
  const expected = (await x.f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } }))!;
  const fence = (await x.f.writer.mutateUpkeep({ kind: "claim", expected, ownerToken: "owner" }))!;
  await x.f.writer.mutateUpkeep({ kind: "oversized", fence, operationId: randomUUID(), progress: selected.progress!, advance: false });
  x.compact();
  expect(x.db(d => readRetired(d, "fictional", "fictional"))).toMatchObject([{ ordinal: 4, count: 0, state: "oversized" }]);
  expect(x.db(d => d.prepare("SELECT count(*) n FROM continuity_upkeep_offers").get())).toEqual({ n: 0 });
  expect(x.choose().spans.map(s => s.ordinal)).toEqual([1, 2, 3]);
});
