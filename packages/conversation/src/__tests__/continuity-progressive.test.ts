import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { ToolHistoryWriter } from "../tool-history/writer.js";
import { ToolHistoryReader } from "../tool-history/reader.js";
import { continuityGenerationId, continuityRecordId, retainContinuity } from "../tool-history/continuity-storage.js";
import { persistContinuityPurge } from "../tool-history/continuity-purge.js";
import { createContinuityPackSupplier } from "../continuity/pack.js";
import { reclaimProgress, upkeepBytes } from "../continuity/progress.js";
import { fitsLedgerPrefix } from "../continuity/render-fit.js";
import { ledgerHash, fitLedgerSelection, projectedLedgerPayloadBytes, LEDGER_PAYLOAD_BYTES, normalizeLedger, renderLedger, selectLedgerSources, spanKey, validateLedgerOutput, type LedgerEntry } from "../continuity/ledger.js";
import type { ConversationHarnessOptions } from "../harness/contracts.js";

const word = (n: number) => String.fromCharCode(97 + Math.floor(n / 676) % 26, 97 + Math.floor(n / 26) % 26, 97 + n % 26);
const scope = { logicalConversationId: "fictional", currentConversationId: "fictional", currentRunId: "new-turn" };
const resources: { root: string; writer: ToolHistoryWriter }[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of resources.splice(0)) { await f.writer.close(); await rm(f.root, { recursive: true, force: true }); } });
const eligibility = { sessionsEnabled: true, isolated: false, ownedStore: true, primaryAttempt: true, maxTokens: 8000, withOwner: async <T>(fn: (owner: string) => Promise<T>) => fn("fictional-owner") };
const parse = (prompt: string) => prompt.split("\nSources:\n")[1]!.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "progressive-ledger-")), writer = await ToolHistoryWriter.open({ root, continuityEnabled: true, persistenceCeilingMs: 5000 });
  resources.push({ root, writer });
  const reader = new ToolHistoryReader(root), selections: any[][] = [], budgets: number[] = [], caps: number[] = [];
  let response = (rows: any[], _cap: number) => [{ kind: "open_work", value: `Fictional state ${rows[0].ordinal}/${rows[0].start}.`, status: "unknown", sources: [rows[0].id] }];
  const complete = vi.fn(async (prompt: string, _signal: AbortSignal, budget: { operationId: string; inputTokens: number; maxEntries?: number }) => {
    const rows = parse(prompt); selections.push(rows); budgets.push(budget.inputTokens); caps.push(budget.maxEntries ?? 24);
    return { text: JSON.stringify({ entries: response(rows, budget.maxEntries ?? 24), covered: rows.map(row => row.id) }), receipt: { operationId: budget.operationId, model: "fictional:base", status: "valid", reason: "completed", providerInvoked: true, capEnforcement: "request" } };
  });
  const ports = { writer, reader, mutateUpkeep: writer.mutateUpkeep.bind(writer), publishLedger: writer.publishLedger.bind(writer), continuityEnabled: true, logicalConversationId: () => "fictional", upkeep: { enabled: true, recorderNamespace: resolve("/fictional-recorder"), model: "fictional:base", complete } };
  let serial = 0; // Accounting fixtures are distinct evidence, not one repeated template.
  const capture = async (count = 1, text = "Rule.", physical = "fictional", neutral = false) => {
    for (let left = count; left > 0; left -= 128) {
      const generationId = continuityGenerationId(), digest = ledgerHash(generationId);
      await writer.prepareContinuity({ generationId, conversationId: physical, logicalConversationId: "fictional", beforeDigest: null, afterDigest: digest,
        records: Array.from({ length: Math.min(128, left) }, (_, i) => ({ recordId: continuityRecordId(physical, `${generationId}-${i}`), runId: generationId, inputId: `${generationId}-${i}`, kind: neutral ? "user" as const : "owner" as const, provenance: neutral ? "unknown" as const : "host-owner" as const, sequence: i, text: count > 1 ? `${text} ${word(serial++)}` : text, source: neutral ? {} : { attestation: { inputId: `${generationId}-${i}`, requestDigest: digest } } })) });
      await writer.commitContinuity({ generationId, conversationId: physical, canonicalDigest: digest });
    }
  };
  const db = <T>(fn: (db: DatabaseSync) => T): T => { const database = new DatabaseSync(reader.databasePath); try { database.exec("PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON"); return fn(database); } finally { database.close(); } };
  const prepare = async (maxTokens = 8000, physical = "fictional", twice = false) => {
    const events: any[] = [], supplier = createContinuityPackSupplier({ toolHistory: ports } as unknown as ConversationHarnessOptions, { conversationId: physical, userMessage: "Current fictional boundary.", abortSignal: new AbortController().signal }, randomUUID())!;
    await supplier.prepare({ ...eligibility, maxTokens }, "cold_rebuild", event => events.push(event));
    if (twice) await supplier.prepare({ ...eligibility, maxTokens }, "cold_rebuild", event => events.push(event));
    return { events, pack: () => JSON.stringify(supplier([], maxTokens, "cold_rebuild", () => {})) };
  };
  return { root, writer, reader, complete, capture, prepare, selections, budgets, caps, db, ports, respond: (fn: typeof response) => { response = fn; } };
}

it("progresses beyond 512 records, preserves earlier stable entries, and reaches actual tool interiors", async () => {
  const f = await fixture(); await f.capture(640, "Rule.", "fictional", true);
  const binding = { conversationId: "fictional", logicalConversationId: "fictional", runId: "tool-run", isolated: false, continuityEnabled: true as const, finalizedContinuity: true as const };
  await f.writer.persist(binding, { phase: "invocation", toolCallId: "lookup", toolName: "mail_read", arguments: {} });
  await f.writer.persist(binding, { phase: "result", toolCallId: "lookup", toolName: "mail_read", state: "success", content: "Fictional heading.\n\n" + "neutral prose ".repeat(1600) + "FABLE-Z91" }); await f.writer.finishRun(binding, "completed");
  let first: LedgerEntry | undefined;
  for (let i = 0; i < 24; i++) {
    const result = await f.prepare(); expect(f.reader.ledger(scope), JSON.stringify(result.events)).toBeDefined(); const generation = f.reader.ledger(scope)!.generation;
    expect(result.events).toContainEqual(expect.objectContaining({ status: "valid", generationId: generation.id }));
    first ??= generation.entries[0]; expect(generation.entries).toContainEqual(first);
    expect(result.pack()).toContain("### Continuity ledger");
    if (f.selections.at(-1)!.some(row => row.text.includes("FABLE-Z91"))) break;
  }
  expect(f.selections.flat().some(row => row.ordinal > 512 && row.start > 0 && row.text.includes("FABLE-Z91"))).toBe(true);
  const keys = f.selections.flat().map(spanKey); expect(Math.max(...keys.map(key => keys.filter(other => other === key).length))).toBeLessThanOrEqual(2);
  expect(f.budgets[0]).toBe(128000); expect(f.budgets.slice(1).every(budget => budget === 64000)).toBe(true);
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_operations WHERE budget='bootstrap'").get())).toEqual({ n: 1 });
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_offers WHERE state='analyzed'").get())).not.toEqual({ n: 0 });
}, 20000);

it("resumes a UTF-8 interior cursor with bounded reoffers and without relying on a source anchor", async () => {
  const f = await fixture(); await f.capture(1, "Fictional Ω prose ".repeat(24000), "fictional", true);
  await f.prepare(); const cursor = f.db(db => JSON.parse((db.prepare("SELECT cursor FROM continuity_upkeep_progress").get() as { cursor: string }).cursor));
  expect(cursor.offset).toBeGreaterThan(0); expect(cursor.ordinal).toBe(1);
  await f.prepare(); expect(f.selections[1]!.some(span => span.start === cursor.offset)).toBe(true);
  expect(f.selections[1]!.map(span => span.start)).toEqual(f.selections[1]!.map(span => span.start).sort((a, b) => a - b));
  const keys = f.selections.flat().map(spanKey); expect(Math.max(...keys.map(k => keys.filter(other => other === k).length))).toBeLessThanOrEqual(2);
  expect(f.selections[1]!.every(span => Buffer.from(span.text).toString("utf8") === span.text)).toBe(true);
  expect(f.reader.ledger(scope)!.generation.entries).toHaveLength(2);
});

it("advances by ordinal when an unoffered cursor-anchor row disappears", async () => {
  const f = await fixture(); await f.capture(130); await f.prepare();
  const cursor = f.db(db => JSON.parse((db.prepare("SELECT cursor FROM continuity_upkeep_progress").get() as { cursor: string }).cursor));
  f.db(db => db.prepare("DELETE FROM continuity_records WHERE ordinal=?").run(cursor.ordinal));
  await f.prepare(); expect(f.selections[1]![0].ordinal).toBe(cursor.ordinal + 1);
  expect(f.reader.ledger(scope)!.generation.entries).toHaveLength(2);
});

it("restarts span enumeration on changed source digest rather than inheriting its old byte offset", async () => {
  const f = await fixture(); await f.capture(1, "Fictional source prose ".repeat(17000), "fictional", true); await f.prepare();
  const text = "Revised fictional text ".repeat(17000);
  f.db(db => db.prepare("UPDATE continuity_records SET retained_text=?,text_sha256=?,retained_bytes=?").run(text, ledgerHash(text), Buffer.byteLength(text)));
  expect(f.reader.ledger(scope)).toBeUndefined(); await f.prepare();
  expect(f.selections[1]![0]).toMatchObject({ ordinal: 1, start: 0, sha256: ledgerHash(text) });
});

it("atomically invalidates all representation on a contributing tombstone but reconstructs only successful survivors", async () => {
  const f = await fixture(); await f.capture(130); await f.prepare(); await f.prepare();
  const successes = f.db(db => db.prepare("SELECT ordinal FROM continuity_upkeep_offers WHERE state='represented'").all()) as { ordinal: number }[];
  const victim = f.db(db => db.prepare("SELECT ordinal FROM continuity_upkeep_offers WHERE state='analyzed' LIMIT 1").get()) as { ordinal: number };
  f.db(db => db.prepare("UPDATE continuity_records SET retained_text=NULL WHERE ordinal=?").run(victim.ordinal));
  expect(f.reader.ledger(scope)).toBeUndefined();
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_offers WHERE state='represented'").get())).toEqual({ n: 0 });
  expect(f.db(db => db.prepare("SELECT ordinal FROM continuity_upkeep_offers WHERE state='unrepresented' ORDER BY ordinal").all())).toEqual(successes);
  f.respond(rows => rows.filter(row => successes.some(old => old.ordinal === row.ordinal)).map(row => ({ kind: "open_work", value: `Reconstructed ${row.ordinal}.`, status: "unknown", sources: [row.id] })));
  for (let i = 0; i < 4; i++) { const result = await f.prepare(); expect(f.reader.ledger(scope), JSON.stringify(result.events)).toBeDefined(); if (f.reader.ledger(scope)!.generation.entries.length === successes.length) break; }
  const next = f.selections.slice(2).flat();
  for (const success of successes) expect(next.some(row => row.ordinal === success.ordinal)).toBe(true);
  expect(next.some(row => row.ordinal === victim.ordinal)).toBe(false);
  expect(f.reader.ledger(scope)!.generation.entries).toHaveLength(successes.length);
});

it("never reoffers an uncertain batch even after new evidence arrives", async () => {
  const f = await fixture(); await f.capture(2);
  const mutate = f.ports.mutateUpkeep;
  f.ports.mutateUpkeep = async request => { if (request.kind === "outcome") throw new Error("fictional lost outcome"); return mutate(request); };
  await f.prepare(); await f.capture(1); await f.prepare();
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.db(db => db.prepare("SELECT DISTINCT state FROM continuity_upkeep_offers").all())).toEqual([{ state: "uncertain" }]);
  expect(f.reader.ledger(scope)).toBeUndefined();
});

it("clears scoped progress only on explicit reset and keeps rollover progress independent", async () => {
  const f = await fixture(); await f.capture(2); await f.prepare();
  persistContinuityPurge(f.root, { scope: "physical", conversationId: "fictional" }); await f.writer.stats();
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_offers").get())).toEqual({ n: 0 });
  expect((await f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } }))!.bootstrap).toBe(false);
  persistContinuityPurge(f.root, { scope: "physical", conversationId: "fictional", resetUpkeep: true }); await f.writer.stats();
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_offers").get())).toEqual({ n: 0 });
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_progress").get())).toEqual({ n: 0 });
  await f.capture(); await f.prepare(); await f.capture(1, "New bucket.", "next-bucket"); await f.prepare(8000, "next-bucket");
  expect(f.budgets).toEqual([128000, 128000, 128000]);
  expect(f.selections[2]!.every(row => row.text === "New bucket.")).toBe(true);
});

it("preserves the injectable prior and makes zero calls when smaller boundary headroom cannot reserve a delta", async () => {
  const f = await fixture(); await f.capture(); await f.prepare(); const prior = f.reader.ledger(scope)!;
  await f.capture(1, "Additional rule."); f.complete.mockClear(); const result = await f.prepare(1100);
  expect(f.complete).not.toHaveBeenCalled(); expect(f.reader.ledger(scope)!.generation.id).toBe(prior.generation.id);
  expect(result.events).toContainEqual(expect.objectContaining({ reason: "source_oversized", providerInvoked: false }));
  expect(result.pack()).toContain("### Continuity ledger"); expect(result.pack()).toContain("Upkeep coverage gap");
});

it("rejects actual escaped rendering overflow without replacing the prior", async () => {
  const f = await fixture(); await f.capture(); await f.prepare(); const prior = f.reader.ledger(scope)!;
  await f.capture(1, "Additional rule."); f.respond(rows => [{ kind: "open_work", value: "<".repeat(200), status: "unknown", sources: [rows[0].id] }]);
  const result = await f.prepare(); expect(result.events).toContainEqual(expect.objectContaining({ failure: "entry_bounds" }));
  expect(f.reader.ledger(scope)!.generation.id).toBe(prior.generation.id);
});

it.each(["current delivery date 2031-04-09", "save as draft; do not send", "current release date 2031-11-21"])("does not mark a current fact superseded: %s", async value => {
  const f = await fixture(); await f.capture(1, `Fictional current fact: ${value}.`);
  const source = f.reader.snapshotContinuity(scope), selection = selectLedgerSources(source);
  const generation = validateLedgerOutput(JSON.stringify({ entries: [{ kind: "decision", value, status: "superseded", sources: ["s0"] }], covered: ["s0"] }), selection, scope);
  expect(generation.entries[0]!.status).toBe("unknown"); expect(renderLedger(generation, source.records)).not.toContain("status=superseded");
});

it.each(["unrelated correction to FABLE-52", "hypothetically replace the date", "quoted text: 'change the date'", "decoy revised amount"])("preserves prior state for an unestablished relation: %s", async text => {
  const f = await fixture(); await f.capture(1, "Current delivery is 2031-04-09.");
  const first = selectLedgerSources(f.reader.snapshotContinuity(scope));
  const prior = validateLedgerOutput(JSON.stringify({ entries: [{ kind: "decision", value: "2031-04-09", status: "active", sources: ["s0"] }], covered: ["s0"] }), first, scope);
  await f.capture(1, text); const source = f.reader.snapshotContinuity(scope), selection = selectLedgerSources({ ...source, records: [source.records[1]!] });
  const target = prior.entries[0]!, output = { entries: [{ id: "delta", kind: "supersession", value: text, status: "active", sources: ["s0"] }], covered: ["s0"], relations: [{ target: target.id, value: target.value, sources: target.sources, successor: "delta" }] };
  const merged = validateLedgerOutput(JSON.stringify(output), selection, scope, prior);
  expect(merged.entries[0]).toEqual(target); expect(merged.entries[1]!.status).toBe("conflicted");
  for (const relation of [{ ...output.relations[0], target: "forged" }, { ...output.relations[0], value: "forged" }, { ...output.relations[0], sources: ["forged"] }, { ...output.relations[0], successor: target.id }]) expect(() => validateLedgerOutput(JSON.stringify({ ...output, relations: [relation] }), selection, scope, prior)).toThrow();
  const earlier = { ...selection, spans: selection.spans.map(span => ({ ...span, ordinal: 1 })) };
  expect(() => validateLedgerOutput(JSON.stringify(output), earlier, scope, prior)).toThrow();
});

it("enforces 64 aggregate and 24/request or 8/Codex delta bounds, with stable legacy identities", async () => {
  const f = await fixture(); await f.capture(); const source = f.reader.snapshotContinuity(scope), selection = selectLedgerSources(source);
  const entry = { kind: "open_work", status: "unknown", value: "Fictional state", sources: ["s0"] };
  const output = (count: number) => JSON.stringify({ entries: Array.from({ length: count }, (_, i) => ({ ...entry, value: `State ${i}` })), covered: ["s0"] });
  expect(validateLedgerOutput(output(24), selection, scope).entries).toHaveLength(24);
  expect(() => validateLedgerOutput(output(25), selection, scope)).toThrow("output_schema");
  expect(validateLedgerOutput(output(8), selection, scope, undefined, "stream_abort").entries).toHaveLength(8);
  expect(() => validateLedgerOutput(output(9), selection, scope, undefined, "stream_abort")).toThrow("output_schema");
  expect(() => validateLedgerOutput(output(2), { ...selection, maxEntries: 1 }, scope)).toThrow("output_schema");
  const base = validateLedgerOutput(output(1), selection, scope), prior = { ...base, entries: Array.from({ length: 63 }, (_, i) => ({ ...base.entries[0]!, id: `legacy-${i}`, value: `v${i}` })) };
  const sixtyFour = validateLedgerOutput(JSON.stringify({ entries: [entry], covered: ["s0"] }), selection, scope, prior);
  expect(sixtyFour.entries).toHaveLength(64); expect(() => validateLedgerOutput(output(2), selection, scope, prior)).toThrow("entry_bounds");
  const { id: _id, ...legacyEntry } = base.entries[0]!;
  const legacy = { ...base, entries: [{ ...legacyEntry, status: "superseded" }] };
  expect(normalizeLedger(legacy)!.entries).toEqual(normalizeLedger({ ...legacy, id: randomUUID() })!.entries);
  expect(normalizeLedger({ ...legacy, spans: legacy.spans.map(span => ({ ...span, sha256: "f".repeat(64) })) })!.entries[0]!.id).not.toBe(normalizeLedger(legacy)!.entries[0]!.id);
  expect(normalizeLedger(legacy)!.entries[0]).toMatchObject({ id: expect.stringMatching(/^e/), status: "unknown" });
  expect(() => validateLedgerOutput(output(1), selection, scope, { ...base, conversationId: "other" })).toThrow("source_changed");
  expect(fitsLedgerPrefix(renderLedger(prior, source.records), 8000)).toBe(true);
  await f.writer.publishLedger(prior); await f.capture(1, "Additional rule.");
  await f.writer.publishLedger({ ...sixtyFour, parent: prior.id });
  f.complete.mockClear(); const result = await f.prepare(); expect(f.complete).not.toHaveBeenCalled(); expect(result.pack()).toContain("### Continuity ledger");
  expect(result.events).toContainEqual(expect.objectContaining({ reason: "ledger_aggregate_capacity" }));
});

it("keeps known failed offers separate from represented state and never repurchases them", async () => {
  const f = await fixture(); await f.capture(2);
  f.respond(rows => [{ kind: "forged", value: "Fictional invalid state.", status: "unknown", sources: [rows[0].id] }]);
  await f.prepare(); const result = await f.prepare(); expect(f.complete).toHaveBeenCalledTimes(1);
  expect(result.events).toContainEqual(expect.objectContaining({ reason: "upkeep_repeat_suppressed" }));
  expect(f.db(db => db.prepare("SELECT DISTINCT state FROM continuity_upkeep_offers").all())).toEqual([{ state: "failed" }]);
  await f.capture(); await f.prepare(); expect(f.complete).toHaveBeenCalledTimes(2);
  expect(f.selections[1]!.every(span => span.ordinal === 3)).toBe(true);
});

it("isolates offer capacity to its own scope without deleting another scope's uncertain evidence", async () => {
  const f = await fixture(); await f.capture();
  await f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } });
  f.db(db => db.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<65536)
    INSERT INTO continuity_upkeep_offers SELECT 'other','other','incarnation',printf('%064x',n),n,printf('%064x',0),0,1,printf('op-%d',n),'uncertain',NULL,0,1 FROM seq;`));
  await f.prepare(); expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_offers WHERE logical_id='other'").get())).toEqual({ n: 65536 });
});

it("leaves the disabled path without progress/admission tables or a completion", async () => {
  const f = await fixture(); await f.capture(); f.ports.upkeep.enabled = false;
  await f.prepare(); expect(f.complete).not.toHaveBeenCalled();
  expect(f.db(db => db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'continuity_upkeep_%'").all())).toEqual([]);
});

it("continues after deletion of the actual interior cursor record without renewing bootstrap", async () => {
  const f = await fixture(); await f.capture(1, "Fictional neutral prose ".repeat(18000), "fictional", true); await f.capture(1, "Surviving rule.");
  await f.prepare(); expect(f.selections[0]!.some(span => span.ordinal === 1)).toBe(true);
  f.db(db => db.prepare("DELETE FROM continuity_records WHERE ordinal=1").run());
  await f.prepare(); expect(f.selections[1]!.some(span => span.ordinal === 2 && span.start === 0 && span.text === "Surviving rule.")).toBe(true);
  expect(f.budgets).toEqual([128000, 64000]);
});

it("freezes a selection watermark and extends it only on the next preparation", async () => {
  const f = await fixture(); await f.capture(); const complete = f.complete.getMockImplementation()!;
  f.complete.mockImplementationOnce(async (...args) => { await f.capture(1, "Later boundary evidence."); return complete(...args); });
  await f.prepare();
  expect(f.db(db => JSON.parse((db.prepare("SELECT cursor FROM continuity_upkeep_progress").get() as { cursor: string }).cursor).watermark)).toBe(1);
  expect(f.reader.ledger(scope)!.generation.inputs).toHaveLength(1);
  await f.prepare(); expect(f.selections[1]![0].ordinal).toBe(2);
  expect(f.db(db => JSON.parse((db.prepare("SELECT cursor FROM continuity_upkeep_progress").get() as { cursor: string }).cursor).watermark)).toBe(2);
});

it("storage rejects dropping prior entries or lineage even with a valid parent CAS", async () => {
  const f = await fixture(); await f.capture(); await f.prepare(); const prior = f.reader.ledger(scope)!.generation;
  const next = { ...prior, id: randomUUID(), parent: prior.id };
  await expect(f.writer.publishLedger({ ...next, entries: [] })).rejects.toMatchObject({ code: "publish_source_changed" });
  await expect(f.writer.publishLedger({ ...next, inputs: [] })).rejects.toMatchObject({ code: "publish_source_changed" });
  expect(f.reader.ledger(scope)!.generation.id).toBe(prior.id);
});

it("does not inherit legacy analyzed-but-uncited coverage as representation", async () => {
  const f = await fixture(); await f.capture(2);
  const source = f.reader.snapshotContinuity(scope), selection = selectLedgerSources({ ...source, records: [source.records[0]!] });
  const base = validateLedgerOutput(JSON.stringify({ entries: [{ kind: "open_work", value: "Prior fact.", status: "unknown", sources: ["s0"] }], covered: ["s0"] }), selection, scope);
  const extra = selectLedgerSources({ ...source, records: [source.records[1]!] }).spans[0]!;
  const { text: _text, ...uncited } = extra;
  const spans = [...base.spans, { ...uncited, id: "legacy-uncited" }];
  const legacy = { ...base, spans, manifest: ledgerHash(JSON.stringify(spans)), inputs: source.records.map(r => ({ recordId: r.recordId, sha256: r.sha256 })), coveredSpans: spans.map(span => span.id), uncovered: 0 };
  await f.writer.publishLedger(legacy);
  const read = f.reader.ledger(scope)!.generation;
  expect(read.coveredSpans).toEqual([base.spans[0]!.id]); expect(read.uncovered).toBe(1);
  await f.prepare(); expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.selections[0]!.map(row => row.ordinal)).toEqual([2]);
  expect(f.reader.ledger(scope)!.generation.entries).toContainEqual(base.entries[0]);
});

it("skips an intrinsically oversized owner paragraph durably without paying for it or stalling later evidence", async () => {
  const f = await fixture(); await f.capture(1, "Before."); await f.capture(1, "Fictional pasted log ".repeat(600)); await f.capture(1, "After.");
  const result = await f.prepare(); expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.selections[0]!.map(row => row.text).sort()).toEqual(["After.", "Before."]);
  expect(f.db(db => db.prepare("SELECT ordinal,state FROM continuity_upkeep_offers WHERE state='oversized'").all())).toEqual([{ ordinal: 2, state: "oversized" }]);
  expect(result.pack()).toContain("Upkeep coverage gap");
  await f.capture(1, "Later."); await f.prepare(); expect(f.selections[1]!.some(row => row.text === "Later.")).toBe(true);
});

it("advances an all-oversized boundary with zero calls and preserves bootstrap", async () => {
  const f = await fixture(); await f.capture(1, "Fictional log ".repeat(30000));
  const result = await f.prepare(); expect(f.complete).not.toHaveBeenCalled();
  expect(result.events).toContainEqual(expect.objectContaining({ reason: "source_oversized", providerInvoked: false }));
  expect((await f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } }))!.bootstrap).toBe(true);
  await f.capture(1, "Reachable later."); await f.prepare(); expect(f.selections[0]![0].text).toBe("Reachable later.");
});

it("admits a balanced dense delta and preserves it at the next real supplier boundary", async () => {
  const f = await fixture(); await f.capture(100);
  f.respond((rows, cap) => Array.from({ length: Math.ceil(rows.length / 8) }, (_, i) => ({ kind: "open_work", value: `Dense ${rows[i * 8].ordinal}.`, status: "unknown", sources: rows.slice(i * 8, i * 8 + 8).map(row => row.id) })).slice(0, cap));
  await f.prepare(); const prior = f.reader.ledger(scope)!.generation;
  expect(prior.entries.length).toBeGreaterThan(1); expect(f.caps[0]).toBeGreaterThan(1);
  await f.prepare(); const merged = f.reader.ledger(scope)!.generation;
  for (const entry of prior.entries) expect(merged.entries).toContainEqual(entry);
  for (let i = 0; i < 2; i++) {
    expect(f.selections[i]!.length).toBeLessThanOrEqual(8 * f.caps[i]!);
    expect(f.complete.mock.calls[i]![0]).toContain(`Delta limit: ${f.caps[i]} entries`);
    expect(f.complete.mock.calls[i]![0]).not.toContain("At most 24");
  }
  expect(f.db(db => db.prepare("SELECT DISTINCT state FROM continuity_upkeep_offers").all())).toEqual([{ state: "represented" }]);
});

it("gives unsaturated uncited spans one second chance alongside fresh evidence, then stops idle payments", async () => {
  const f = await fixture(); await f.capture(3); await f.prepare();
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_offers WHERE state='analyzed'").get())).toEqual({ n: 2 });
  // Cite the fresh evidence explicitly: prompt order is chronological, not rank.
  f.respond(rows => [{ kind: "open_work", value: "Fresh state.", status: "unknown", sources: [rows.find(row => row.ordinal === 4).id] }]);
  await f.capture(1, "Fresh."); await f.prepare(); expect(f.selections[1]!.some(row => row.ordinal === 4)).toBe(true); expect(f.selections[1]).toHaveLength(3);
  await f.prepare(); expect(f.complete).toHaveBeenCalledTimes(2);
  expect(f.reader.ledger(scope)!.generation.entries).toHaveLength(2);
});

it("projects the merged shape conservatively at the payload edge, including eight remapped citations per delta entry", async () => {
  const f = await fixture(); await f.capture(8); const source = f.reader.snapshotContinuity(scope), selection = selectLedgerSources(source);
  const entry = (i: number) => ({ kind: "open_work", value: "\0".repeat(106) + String(i).padStart(2, "0"), status: "unknown", sources: selection.spans.map(span => span.id) });
  const prior = validateLedgerOutput(JSON.stringify({ entries: [entry(0)], covered: selection.spans.map(span => span.id) }), selection, scope);
  let edge = { ...prior, inputs: [...prior.inputs] };
  while (projectedLedgerPayloadBytes({ ...selection, maxEntries: 8 }, scope, edge) < LEDGER_PAYLOAD_BYTES - 400) edge = { ...edge, inputs: [...edge.inputs, { recordId: `reserved-${edge.inputs.length}-` + "x".repeat(160), sha256: "a".repeat(64) }] };
  const fitted = fitLedgerSelection(selection, scope, { generation: edge, records: [...source.records], retainedBytes: 40 });
  expect(fitted.selection.spans.length).toBeGreaterThan(0); expect(fitted.projectedBytes).toBeLessThanOrEqual(LEDGER_PAYLOAD_BYTES);
  const text = JSON.stringify({ entries: Array.from({ length: fitted.selection.maxEntries! }, (_, i) => ({ ...entry(i + 1), sources: fitted.selection.spans.slice(0, 8).map(span => span.id) })), covered: fitted.selection.spans.map(span => span.id) });
  const actual = validateLedgerOutput(text, fitted.selection, scope, edge);
  expect(Buffer.byteLength(JSON.stringify(actual))).toBeLessThanOrEqual(fitted.projectedBytes);
  expect(actual.selectionManifest).toBe(fitted.selection.manifest); expect(actual.coveredSpans!.some(id => id.startsWith("p"))).toBe(true);
});

it("bounds fit work without rebuilding the source prompt at every prefix", async () => {
  const f = await fixture(); await f.capture(64, "Fictional owner paragraph. ".repeat(4));
  const source = f.reader.snapshotContinuity(scope), selection = selectLedgerSources(source, undefined, 128000);
  const prior = validateLedgerOutput(JSON.stringify({ entries: [{ kind: "open_work", value: "Prior.", status: "unknown", sources: ["s0"] }], covered: ["s0"] }), selection, scope);
  let projections = 0; const stringify = JSON.stringify;
  vi.spyOn(JSON, "stringify").mockImplementation((value: any, replacer?: any, space?: any) => { if (value?.inputs && value?.entries && value?.spans) projections++; return stringify(value, replacer, space); });
  const started = performance.now();
  const fit = fitLedgerSelection(selection, scope, { generation: prior, records: [...source.records], retainedBytes: source.records.reduce((n, record) => n + Buffer.byteLength(record.text), 0) });
  expect(performance.now() - started).toBeLessThan(5000); expect(projections).toBeLessThanOrEqual(200);
  expect(fit.selection.spans.length).toBeGreaterThan(0);
}, 10000);

it("keeps a near-limit legacy ledger injectable without rendering newly assigned identities", async () => {
  const f = await fixture(); await f.capture(); const source = f.reader.snapshotContinuity(scope), selection = selectLedgerSources(source);
  const base = validateLedgerOutput(JSON.stringify({ entries: [{ kind: "open_work", value: "Prior.", status: "unknown", sources: ["s0"] }], covered: ["s0"] }), selection, scope);
  let prior = base;
  for (let length = 1; length <= 512; length++) {
    const candidate = { ...base, entries: Array.from({ length: 64 }, (_, i) => ({ kind: "open_work", value: `${i}:` + "v".repeat(length), status: "unknown", sources: base.entries[0]!.sources })) };
    if (!fitsLedgerPrefix(renderLedger(candidate, source.records), 8000)) break;
    prior = candidate;
  }
  const rendered = renderLedger(prior, source.records); expect(rendered).not.toContain(" id=");
  expect(fitsLedgerPrefix(rendered, 8000)).toBe(true); expect(fitsLedgerPrefix(rendered + "x".repeat(28 * 64), 8000)).toBe(false);
  await f.writer.publishLedger(prior); const result = await f.prepare(); expect(result.pack()).toContain("### Continuity ledger");
});

it("rechecks actual headroom after the provider returns and rejects only the delta", async () => {
  const f = await fixture(); await f.capture(); await f.prepare(); const prior = f.reader.ledger(scope)!.generation;
  await f.capture(1, "Additional rule."); const context = { ...eligibility }, complete = f.complete.getMockImplementation()!;
  f.complete.mockImplementationOnce(async (...args) => { const result = await complete(...args); context.maxTokens = 500; return result; });
  const events: any[] = [], publish = vi.spyOn(f.ports, "publishLedger");
  const supplier = createContinuityPackSupplier({ toolHistory: f.ports } as unknown as ConversationHarnessOptions, { conversationId: "fictional", userMessage: "Current.", abortSignal: new AbortController().signal }, randomUUID())!;
  await supplier.prepare(context, "cold_rebuild", event => events.push(event));
  expect(events).toContainEqual(expect.objectContaining({ failure: "ledger_render_budget" }));
  expect(publish).not.toHaveBeenCalled(); expect(f.reader.ledger(scope)!.generation.id).toBe(prior.id);
});

it("reports a definitive rolled-back dispatch as skipped without consuming bootstrap", async () => {
  const f = await fixture(); await f.capture(); await f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } });
  f.db(db => db.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<65536)
    INSERT INTO continuity_upkeep_offers SELECT 'fictional','fictional','incarnation',printf('%064x',n),n,printf('%064x',0),0,1,printf('op-%d',n),'uncertain',NULL,0,1 FROM seq;`));
  const result = await f.prepare(); expect(f.complete).not.toHaveBeenCalled();
  expect(result.events).toContainEqual(expect.objectContaining({ status: "skipped", reason: "upkeep_dispatch_rejected", providerInvoked: false }));
  expect(result.events.some(event => event.status === "uncertain")).toBe(false);
  expect((await f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } }))!.bootstrap).toBe(true);
});

it("reclaims terminal progress journals and proof-obsolete offers, but never uncertain rows or markers", async () => {
  const f = await fixture(); f.respond(() => []);
  for (let i = 0; i < 72; i++) { await f.capture(1, `New fictional ${i}.`); await f.prepare(); }
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_operations").get())).toEqual({ n: 64 });
  expect((await f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } }))!.bootstrap).toBe(false);
  f.db(db => { db.prepare("INSERT INTO continuity_upkeep_offers VALUES ('fictional','fictional','incarnation','obsolete',9999,'gone',0,1,'obsolete','failed',NULL,0,1)").run(); reclaimProgress(db, "fictional", "fictional"); });
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_offers WHERE span_key='obsolete'").get())).toEqual({ n: 0 });
  const mutate = f.ports.mutateUpkeep; f.ports.mutateUpkeep = async input => { if (input.kind === "outcome") throw new Error("Lost outcome."); return mutate(input); };
  await f.capture(1, "Uncertain."); await f.prepare();
  const operation = f.db(db => db.prepare("SELECT operation_id FROM continuity_upkeep_operations WHERE state='dispatch_started'").get()) as { operation_id: string };
  f.db(db => { db.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<80)
    INSERT INTO continuity_upkeep_operations SELECT 'tail-'||n,'fictional','fictional','incarnation',0,'owner','{"progress":{}}','tail-'||n,'incremental','terminal',NULL FROM seq;`); reclaimProgress(db, "fictional", "fictional"); });
  expect(f.db(db => db.prepare("SELECT state FROM continuity_upkeep_operations WHERE operation_id=?").get(operation.operation_id))).toEqual({ state: "dispatch_started" });
  expect((await f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } }))!.bootstrap).toBe(false);
}, 15000);

it.each(["physical", "logical", "tombstone", "delete", "generation"] as const)("erases text-derived upkeep fingerprints on %s while retaining opaque uncertainty", async kind => {
  const f = await fixture(); await f.capture(1, "Fictional private code ".repeat(17000), "fictional", true);
  const mutate = f.ports.mutateUpkeep; f.ports.mutateUpkeep = async input => { if (input.kind === "outcome") throw new Error("Lost outcome."); return mutate(input); };
  await f.prepare(); const digest = f.selections[0]![0].sha256, keys = f.selections[0]!.map(spanKey);
  if (kind === "physical" || kind === "logical") { persistContinuityPurge(f.root, { scope: kind, conversationId: "fictional" }); await f.writer.stats(); }
  else f.db(db => db.exec(kind === "tombstone" ? "UPDATE continuity_records SET retained_text=NULL" : kind === "generation" ? "DELETE FROM continuity_generations" : "DELETE FROM continuity_records"));
  const dump = f.db(db => JSON.stringify((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(row => db.prepare(`SELECT * FROM "${row.name}"`).all())));
  expect(dump).not.toContain(digest); for (const key of keys) expect(dump).not.toContain(key);
  const operation = f.db(db => db.prepare("SELECT operation_id,state,reservation,selection_key FROM continuity_upkeep_operations").get()) as any;
  expect(operation.state).toBe("dispatch_started"); expect(operation.selection_key).toBe(operation.operation_id);
  expect(JSON.parse(operation.reservation)).not.toHaveProperty("progress");
  expect(f.db(db => db.prepare("SELECT DISTINCT source_digest,state FROM continuity_upkeep_offers").all())).toEqual([{ source_digest: "", state: "uncertain" }]);
  await f.capture(1, "New evidence."); await f.prepare(); expect(f.complete).toHaveBeenCalledTimes(1);
});

it("bounds selected materialization including tool arguments without truncating the completed scan", async () => {
  const f = await fixture(); await f.capture(4, "Fictional neutral ".padEnd(1000000, "n"), "fictional", true);
  const binding = { conversationId: "fictional", logicalConversationId: "fictional", runId: "large-tool", isolated: false, continuityEnabled: true as const, finalizedContinuity: true as const };
  await f.writer.persist(binding, { phase: "invocation", toolCallId: "large", toolName: "lookup", arguments: {} });
  await f.writer.persist(binding, { phase: "result", toolCallId: "large", toolName: "lookup", state: "success", content: "Fictional tool record." }); await f.writer.finishRun(binding, "completed");
  const fence = (await f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } }))!;
  const payload = JSON.stringify({ value: "x".repeat(250000) });
  f.db(db => db.prepare("UPDATE tool_records SET payload_json=?,payload_sha256=?,retained_bytes=? WHERE phase='invocation'").run(payload, ledgerHash(payload), Buffer.byteLength(payload)));
  const first = f.reader.snapshotContinuity({ ...scope, selection: "upkeep" });
  expect(first.records).toHaveLength(4); expect(first.upkeep?.scan).toMatchObject({ complete: true, materializationSkipped: 1 });
  expect(first.records.some(r => r.kind === "tool")).toBe(true);
  const ordinal = f.db(db => (db.prepare("SELECT ordinal FROM continuity_records WHERE kind='tool'").get() as { ordinal: number }).ordinal);
  f.db(db => db.prepare("INSERT INTO continuity_upkeep_progress VALUES (?,?,?,?)").run("fictional", "fictional", fence.incarnation, JSON.stringify({ ordinal, offset: 0, digest: "", watermark: ordinal })));
  const next = f.reader.snapshotContinuity({ ...scope, selection: "upkeep" });
  expect(next.degradedReason).toBeUndefined(); expect(next.records.find(r => r.kind === "tool")!.tool!.arguments.length).toBeGreaterThan(200000);
});

it("purges terminal fingerprints without refunding bootstrap or blocking genuinely new evidence", async () => {
  const f = await fixture(); await f.capture(); await f.prepare(); const digest = f.selections[0]![0].sha256;
  persistContinuityPurge(f.root, { scope: "physical", conversationId: "fictional" }); await f.writer.stats();
  const journal = f.db(db => db.prepare("SELECT state,reservation,selection_key FROM continuity_upkeep_operations").all());
  expect(JSON.stringify(journal)).not.toContain(digest); expect(journal[0]).toMatchObject({ state: "terminal" });
  await f.capture(1, "New evidence."); await f.prepare(); expect(f.budgets).toEqual([128000, 64000]);
});

it.each([false, true])("migrates legacy reservations once without a retention barrier (uncertain=%s)", async uncertain => {
  const f = await fixture(); await f.capture();
  const expected = (await f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } }))!;
  const fence = (await f.writer.mutateUpkeep({ kind: "claim", expected, ownerToken: "legacy-owner" }))!;
  const reservation = { ...fence, operationId: randomUUID(), runId: "legacy-run", recorderNamespace: resolve("/fictional"), model: "fictional:base", manifest: "a".repeat(64), parent: null, budget: "bootstrap" as const };
  await f.writer.mutateUpkeep({ kind: "reserve", reservation }); await f.writer.mutateUpkeep({ kind: "dispatch", reservation });
  if (!uncertain) await f.writer.mutateUpkeep({ kind: "outcome", reservation, receipt: { operationId: reservation.operationId, model: reservation.model, providerInvoked: true, status: "invalid" } as any });
  f.db(db => db.exec("DROP TRIGGER continuity_upkeep_privacy_delete; DROP TRIGGER continuity_upkeep_privacy_update; DROP TRIGGER continuity_upkeep_privacy_tombstone; DROP TRIGGER continuity_upkeep_privacy_generation; DROP TABLE continuity_upkeep_offers; DROP TABLE continuity_upkeep_progress; DROP TABLE continuity_upkeep_migrations"));
  const limits = f.reader.stats()!.limits; f.ports.upkeep.enabled = false;
  f.db(db => retainContinuity(db, { ...limits, maxAgeMs: 1 }, Date.now() + 10000));
  expect(f.db(db => db.prepare("SELECT 1 FROM sqlite_master WHERE name='continuity_upkeep_progress'").get())).toBeUndefined();
  f.ports.upkeep.enabled = true; await f.capture(1, "New evidence."); await f.prepare();
  expect(f.complete).toHaveBeenCalledTimes(uncertain ? 0 : 1); expect(f.budgets).toEqual(uncertain ? [] : [64000]);
  const old = f.db(db => db.prepare("SELECT reservation,state FROM continuity_upkeep_operations WHERE operation_id=?").get(reservation.operationId)) as any;
  expect(old.state).toBe(uncertain ? "dispatch_started" : "terminal"); expect(JSON.parse(old.reservation).manifest).toBe(reservation.operationId);
  await f.prepare(); expect(f.db(db => db.prepare("SELECT reservation FROM continuity_upkeep_operations WHERE operation_id=?").get(reservation.operationId))).toEqual({ reservation: old.reservation });
});

it("reoffers empty analyzed evidence once, then makes zero idle purchases", async () => {
  const f = await fixture(); await f.capture(3); f.respond(() => []);
  for (let i = 0; i < 3; i++) await f.prepare();
  expect(f.complete).toHaveBeenCalledTimes(2);
  expect(f.db(db => db.prepare("SELECT DISTINCT state FROM continuity_upkeep_offers").all())).toEqual([{ state: "analyzed" }]);
  expect(f.reader.ledger(scope)).toBeUndefined();
});

it("allows only one re-offer when the admitted cap was saturated", async () => {
  const f = await fixture(); await f.capture(12, "Neutral.", "fictional", true);
  f.respond((rows, cap) => Array.from({ length: cap }, (_, i) => ({ kind: "open_work", value: `Saturated ${rows[0].ordinal} ${i}.`, status: "unknown", sources: [rows[0].id] })));
  for (let i = 0; i < 4; i++) await f.prepare();
  expect(f.complete).toHaveBeenCalledTimes(2);
  expect(f.db(db => db.prepare("SELECT max(attempt) n FROM continuity_upkeep_offers").get())).toEqual({ n: 1 });
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_offers WHERE state='reofferable'").get())).toEqual({ n: 0 });
});

it.each(["publish_cas", "publish_cancelled", "publish_quota", "publish_bounds"])("bounds post-payment publication failure %s", async code => {
  const f = await fixture(); await f.capture(2); f.ports.publishLedger = async () => { throw Object.assign(new Error("Fictional publication failure."), { code }); };
  for (let i = 0; i < 4; i++) await f.prepare();
  const transient = code === "publish_cas" || code === "publish_cancelled";
  expect(f.complete).toHaveBeenCalledTimes(transient ? 2 : 1);
  expect(f.db(db => db.prepare("SELECT DISTINCT state FROM continuity_upkeep_offers").all())).toEqual([{ state: transient ? "analyzed" : "failed" }]);
});

it("does not rewind a frontier beyond 512 represented anchors on an old tombstone", async () => {
  const f = await fixture(); await f.capture(640, "Anchor.", "fictional", true);
  const fence = (await f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } }))!;
  f.db(db => { db.prepare("INSERT INTO continuity_upkeep_progress VALUES (?,?,?,?)").run("fictional", "fictional", fence.incarnation, JSON.stringify({ ordinal: 641, offset: 0, digest: "", watermark: 640 }));
    db.exec(`INSERT INTO continuity_upkeep_offers SELECT 'fictional','fictional','incarnation',printf('%064x',ordinal),ordinal,text_sha256,0,retained_bytes,'historical','represented','historical',0,1 FROM continuity_records;
      UPDATE continuity_records SET retained_text=NULL WHERE ordinal=1;`); });
  expect(f.db(db => JSON.parse((db.prepare("SELECT cursor FROM continuity_upkeep_progress").get() as any).cursor).ordinal)).toBe(641);
  await f.capture(1, "Later tool evidence.", "fictional", true); await f.prepare(); await f.prepare();
  expect(f.complete).toHaveBeenCalledTimes(1); expect(f.selections[0]!.map(row => row.ordinal)).toEqual([641]);
});

it("does not scrub an unrelated in-flight reservation between dispatch and outcome", async () => {
  const f = await fixture(); await f.capture(); f.respond(() => [{ kind: "identifier", value: "forged", status: "active", sources: ["forged"] }]); await f.prepare();
  await f.capture(1, "New evidence."); f.respond(rows => { f.db(db => db.exec("UPDATE continuity_records SET retained_text=NULL WHERE ordinal=1")); return [{ kind: "open_work", value: "Valid new evidence.", status: "unknown", sources: [rows[0].id] }]; });
  await f.prepare(); expect(f.complete).toHaveBeenCalledTimes(2);
  expect(f.reader.ledger(scope)!.generation.entries[0]!.value).toBe("Valid new evidence.");
  expect(f.db(db => db.prepare("SELECT state FROM continuity_upkeep_operations ORDER BY rowid DESC LIMIT 1").get())).toEqual({ state: "terminal" });
});

it("skips a leading owner paragraph relative to the actual grown prior and reaches tool evidence", async () => {
  const f = await fixture(); await f.capture(); const source = f.reader.snapshotContinuity(scope), selection = selectLedgerSources(source);
  const prior = validateLedgerOutput(JSON.stringify({ entries: Array.from({ length: 11 }, (_, i) => ({ kind: "open_work", value: `${i}:` + "v".repeat(490), status: "unknown", sources: ["s0"] })), covered: ["s0"] }), selection, scope);
  await f.writer.publishLedger(prior); await f.capture(1, "x".repeat(4000));
  const binding = { conversationId: "fictional", logicalConversationId: "fictional", runId: "later-tool", isolated: false, continuityEnabled: true as const, finalizedContinuity: true as const };
  await f.writer.persist(binding, { phase: "invocation", toolCallId: "lookup", toolName: "lookup", arguments: {} });
  await f.writer.persist(binding, { phase: "result", toolCallId: "lookup", toolName: "lookup", state: "success", content: "Fictional actual tool evidence." }); await f.writer.finishRun(binding, "completed");
  await f.prepare(); expect(f.complete).toHaveBeenCalledTimes(1); expect(f.selections[0]!.some(row => row.kind === "tool")).toBe(true);
  expect(f.selections[0]!.some(row => row.ordinal === 2)).toBe(false);
  expect(f.db(db => db.prepare("SELECT ordinal FROM continuity_upkeep_offers WHERE state='oversized'").all())).toEqual([{ ordinal: 2 }]);
  for (const entry of prior.entries) expect(f.reader.ledger(scope)!.generation.entries).toContainEqual(entry);
});

it("reclaims LRU working sets under the shared quota without losing unknowns or markers", async () => {
  const f = await fixture(); f.respond(() => []); await f.capture(); await f.prepare();
  const oldMarker = f.db(db => db.prepare("SELECT bootstrap_operation FROM continuity_upkeep_admissions").get());
  await f.capture(1, "Newer working set.", "newer"); await f.prepare(8000, "newer");
  const expected = (await f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "other", conversationId: "other" } }))!;
  const fence = (await f.writer.mutateUpkeep({ kind: "claim", expected, ownerToken: "other-owner" }))!;
  const reservation = { ...fence, operationId: randomUUID(), runId: "other-run", recorderNamespace: resolve("/fictional"), model: "fictional:base", manifest: "a".repeat(64), parent: null, budget: "bootstrap" as const };
  await f.writer.mutateUpkeep({ kind: "reserve", reservation }); await f.writer.mutateUpkeep({ kind: "dispatch", reservation });
  const before = f.reader.stats()!, metadata = f.db(upkeepBytes); expect(metadata).toBeGreaterThan(0);
  const unknown = f.db(db => db.prepare("SELECT * FROM continuity_upkeep_operations WHERE operation_id=?").get(reservation.operationId));
  f.db(db => retainContinuity(db, { ...before.limits, maxBytes: before.retainedBytes - 1 }, Date.now()));
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_operations WHERE logical_id='fictional' AND conversation_id='fictional'").get())).toEqual({ n: 0 });
  expect(f.db(db => db.prepare("SELECT * FROM continuity_upkeep_operations WHERE operation_id=?").get(reservation.operationId))).toEqual(unknown);
  expect(f.db(db => db.prepare("SELECT bootstrap_operation FROM continuity_upkeep_admissions WHERE logical_id='fictional' AND conversation_id='fictional'").get())).toEqual(oldMarker);
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_operations WHERE conversation_id='newer'").get())).toEqual({ n: 1 });
  expect(f.db(db => db.prepare("SELECT bootstrap_operation FROM continuity_upkeep_admissions WHERE logical_id='other'").get())).toEqual({ bootstrap_operation: reservation.operationId });
  expect(f.db(upkeepBytes)).toBeLessThan(metadata); expect(f.reader.stats()!.retainedBytes).toBeLessThan(before.retainedBytes);
  await f.prepare(); expect(f.complete).toHaveBeenCalledTimes(3); // Exact compact count preserves its one remaining offer.
  await f.capture(1, "Fresh after reclamation."); await f.prepare(); expect(f.complete).toHaveBeenCalledTimes(4); expect(f.budgets.slice(2)).toEqual([64000, 64000]);
});

it("erases a reserved first operation before the first dispatch without advancing or consuming bootstrap", async () => {
  const f = await fixture(); await f.capture();
  const expected = (await f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } }))!;
  const fence = (await f.writer.mutateUpkeep({ kind: "claim", expected, ownerToken: "owner" }))!;
  const selection = selectLedgerSources(f.reader.snapshotContinuity({ ...scope, selection: "upkeep" }));
  const reservation = { ...fence, operationId: randomUUID(), runId: "reserved", recorderNamespace: resolve("/fictional"), model: "fictional:base", manifest: selection.manifest, parent: null, budget: "bootstrap" as const, progress: selection.progress! };
  await f.writer.mutateUpkeep({ kind: "reserve", reservation });
  f.db(db => db.exec("UPDATE continuity_records SET retained_text=NULL"));
  const row = f.db(db => db.prepare("SELECT reservation,state FROM continuity_upkeep_operations").get()) as any;
  expect(row.state).toBe("reserved"); expect(JSON.parse(row.reservation)).not.toHaveProperty("progress");
  expect(f.db(db => db.prepare("SELECT text_sha256 FROM continuity_records").get())).toEqual({ text_sha256: "" });
  expect((await f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } }))!.bootstrap).toBe(true);
  expect(f.complete).not.toHaveBeenCalled();
});

it("counts an idle scope claim as LRU use after its analyzed allowance is exhausted", async () => {
  const f = await fixture(); f.respond(() => []); await f.capture(); await f.prepare(); await f.prepare();
  await f.capture(1, "Newer scope.", "newer"); await f.prepare(8000, "newer");
  f.db(db => db.exec("UPDATE continuity_upkeep_progress SET cursor=json_set(cursor,'$.touchedAt',CASE WHEN conversation_id='fictional' THEN 0 ELSE 1 END)"));
  await f.prepare(); expect(f.complete).toHaveBeenCalledTimes(3);
  const stats = f.reader.stats()!;
  f.db(db => retainContinuity(db, { ...stats.limits, maxBytes: stats.retainedBytes - 1 }, Date.now()));
  expect(f.db(db => db.prepare("SELECT conversation_id FROM continuity_upkeep_operations").all())).toEqual([{ conversation_id: "fictional" }, { conversation_id: "fictional" }]);
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_admissions WHERE bootstrap_operation IS NOT NULL").get())).toEqual({ n: 2 });
});

it("accounts a paid related-source tombstone without publishing or blocking the scope", async () => {
  const f = await fixture(); await f.capture(); const complete = f.complete.getMockImplementation()!; let identity: string | undefined;
  f.complete.mockImplementationOnce(async (...args) => {
    const result = await complete(...args);
    identity = f.db(db => JSON.parse((db.prepare("SELECT reservation FROM continuity_upkeep_operations").get() as any).reservation).reservationIdentity);
    f.db(db => db.exec("UPDATE continuity_records SET retained_text=NULL WHERE ordinal=1"));
    return { ...result, receipt: { ...result.receipt, inputTokens: 25, outputTokens: 5, costUsd: 0.002 } };
  });
  const result = await f.prepare(); expect(result.events).toContainEqual(expect.objectContaining({ status: "invalid", failure: "publish_source_changed", costUsd: 0.002 }));
  const row = f.db(db => db.prepare("SELECT reservation,state,outcome FROM continuity_upkeep_operations").get()) as any;
  expect(row.state).toBe("terminal"); expect(JSON.parse(row.outcome)).toMatchObject({ inputTokens: 25, outputTokens: 5, costUsd: 0.002 });
  expect(JSON.parse(row.reservation)).toMatchObject({ reservationIdentity: identity, purged: 1 }); expect(JSON.parse(row.reservation)).not.toHaveProperty("progress");
  expect(f.db(db => db.prepare("SELECT DISTINCT state FROM continuity_upkeep_offers").all())).toEqual([{ state: "failed" }]);
  expect(f.reader.ledger(scope)).toBeUndefined();
  expect((await f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } }))!.uncertain).not.toBe(true);
  await f.prepare(); await f.prepare(); expect(f.complete).toHaveBeenCalledTimes(1);
  await f.capture(1, "Fresh after erasure."); await f.prepare();
  expect(f.complete).toHaveBeenCalledTimes(2); expect(f.budgets[1]).toBe(64000);
});

it("bounds reconstruction per span across five successive retention invalidations", async () => {
  const f = await fixture(); await f.capture(6, "Retained neutral evidence.", "fictional", true);
  f.respond(rows => [{ kind: "open_work", value: `Retained state ${rows[0].ordinal}.`, status: "unknown", sources: rows.map(row => row.id) }]);
  await f.prepare(8000, "fictional", true);
  for (let boundary = 0; boundary < 5; boundary++) {
    await f.capture(1, `Fresh neutral ${boundary}.`, "fictional", true);
    f.db(db => {
      const now = Date.now(); db.prepare("UPDATE continuity_records SET created_at_ms=? WHERE retained_text IS NOT NULL").run(now + 1000);
      db.exec("UPDATE continuity_records SET created_at_ms=0 WHERE record_id=(SELECT i.record_id FROM continuity_ledger_inputs i JOIN continuity_records r USING(record_id) ORDER BY r.ordinal LIMIT 1)");
      retainContinuity(db, { ...f.reader.stats()!.limits, maxAgeMs: 1000 }, now);
    });
    expect(f.reader.ledger(scope)).toBeUndefined();
    await f.prepare(8000, "fictional", true); expect(f.complete).toHaveBeenCalledTimes(boundary + 2);
  }
  const counts = new Map<string, number>();
  for (const rows of f.selections) for (const row of rows) counts.set(spanKey(row), (counts.get(spanKey(row)) ?? 0) + 1);
  expect(Math.max(...counts.values())).toBe(2);
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_offers WHERE state='lost'").get())).toEqual({ n: 4 });
  expect(f.db(db => db.prepare("SELECT max(attempt) n FROM continuity_upkeep_offers").get())).toEqual({ n: 1 });
  expect(f.db(db => db.prepare("SELECT max(offer_count) n FROM continuity_upkeep_offers").get())).toEqual({ n: 2 });
  await f.prepare(); expect(f.complete).toHaveBeenCalledTimes(6);
});

it.each(["request", "stream_abort"] as const)("settles an empty %s delta as analyzed without publishing or losing its prior", async mode => {
  const f = await fixture(); await f.capture(); await f.prepare(); const prior = f.reader.ledger(scope)!.generation;
  await f.capture(1, "Unrelated neutral archive text.", "fictional", true);
  const publish = vi.spyOn(f.ports, "publishLedger"), complete = f.complete.getMockImplementation()!;
  f.complete.mockImplementationOnce(async (...args) => {
    const result = await complete(...args);
    return { ...result, text: '{"entries":[],"covered":[]}', receipt: { ...result.receipt, capEnforcement: mode, inputTokens: 25, outputTokens: 5, costUsd: 0.002 } };
  });
  const result = await f.prepare();
  expect(result.events).toContainEqual(expect.objectContaining({ status: "valid", reason: "analyzed", inputTokens: 25, outputTokens: 5, costUsd: 0.002 }));
  // Valid "nothing new" analysis is not a degraded ledger: no warning is emitted.
  expect(result.events).not.toContainEqual(expect.objectContaining({ type: "runtime_warning" }));
  expect(publish).not.toHaveBeenCalled(); expect(f.reader.ledger(scope)!.generation).toEqual(prior);
  expect(result.pack()).toContain(prior.entries[0]!.value);
  const row = f.db(db => db.prepare("SELECT state,outcome,operation_id FROM continuity_upkeep_operations ORDER BY rowid DESC LIMIT 1").get()) as any;
  expect(row.state).toBe("terminal"); expect(JSON.parse(row.outcome)).toMatchObject({ inputTokens: 25, outputTokens: 5, costUsd: 0.002 });
  expect(f.db(db => db.prepare("SELECT DISTINCT state FROM continuity_upkeep_offers WHERE operation_id=?").all(row.operation_id))).toEqual([{ state: "analyzed" }]);
  await f.prepare(); await f.prepare(); expect(f.complete).toHaveBeenCalledTimes(3);
});

it("accepts the captured nothing-new delta without treating omitted evidence as represented", async () => {
  const f = await fixture(); await f.capture(1, "Unrelated neutral archive text.", "fictional", true);
  const selection = selectLedgerSources(f.reader.snapshotContinuity({ ...scope, selection: "upkeep" }));
  // Exact content-free fictional response from the failed progressive boundary.
  const captured = '{"entries":[],"covered":[]}';
  const generation = validateLedgerOutput(captured, selection, scope, undefined, "stream_abort");
  expect(generation.entries).toEqual([]); expect(generation.coveredSpans).toEqual([]);
  expect(generation.uncovered).toBeGreaterThan(0);
});

it.each(["request", "stream_abort"] as const)("requires strict offered-id subset coverage for empty %s deltas", async mode => {
  const f = await fixture(); await f.capture(1, "Neutral archive.", "fictional", true);
  const selection = selectLedgerSources(f.reader.snapshotContinuity(scope)), id = selection.spans[0]!.id;
  for (const covered of [[], [id]]) expect(validateLedgerOutput(JSON.stringify({ entries: [], covered }), selection, scope, undefined, mode)).toMatchObject({ entries: [], coveredSpans: [] });
  for (const covered of [null, {}, 1, "s0", [id, id], ["not-offered"]]) expect(() => validateLedgerOutput(JSON.stringify({ entries: [], covered }), selection, scope, undefined, mode)).toThrow();
  expect(() => validateLedgerOutput('{"entries":[],"covered":[],"extra":true}', selection, scope, undefined, mode)).toThrow("output_schema");
});

it("consumes an analysis-only bootstrap and one bounded second offer without a generation", async () => {
  const f = await fixture(); await f.capture(1, "Neutral archive.", "fictional", true); f.respond(() => []);
  const publish = vi.spyOn(f.ports, "publishLedger"), result = await f.prepare();
  expect(result.events).toContainEqual(expect.objectContaining({ status: "valid", reason: "analyzed" }));
  expect(publish).not.toHaveBeenCalled(); expect(f.reader.ledger(scope)).toBeUndefined();
  await f.prepare(); expect(f.complete).toHaveBeenCalledTimes(2);
  await f.capture(1, "New fictional evidence.", "fictional", true); await f.prepare();
  expect(f.budgets).toEqual([128000, 64000, 64000]); expect(publish).not.toHaveBeenCalled();
});


it("completes a ranked scan beyond 512 records and 4MiB and reaches high-signal tool interiors immediately", async () => {
  const f = await fixture(); await f.capture(540, "Archival prose.", "fictional", true);
  await f.capture(5, "n".repeat(1000000), "fictional", true);
  const binding = { conversationId: "fictional", logicalConversationId: "fictional", runId: "late-tool", isolated: false, continuityEnabled: true as const, finalizedContinuity: true as const };
  await f.writer.persist(binding, { phase: "invocation", toolCallId: "late", toolName: "read_notes", arguments: {} });
  await f.writer.persist(binding, { phase: "result", toolCallId: "late", state: "success", content: "Header.\n\n" + "filler prose ".repeat(1700) + "REF-Z120" }); await f.writer.finishRun(binding, "completed");
  const result = await f.prepare();
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.selections[0]!.some(s => s.ordinal > 512 && s.start > 0 && s.text.includes("REF-Z120"))).toBe(true);
  expect(result.events).toContainEqual(expect.objectContaining({ type: "continuity_upkeep_scan", complete: true, rows: 546, bindingQueries: 1 }));
  expect(result.events.find(e => e.type === "continuity_upkeep_scan").bytes).toBeGreaterThan(4 * 1024 * 1024);
});
it.each([{ rows: 1 }, { bytes: 1 }, { windows: 1 }, { ms: 0 }])("fails closed with zero calls when a whole-history scan budget expires: %j", async scanBudget => {
  const f = await fixture(); await f.capture(3);
  const snapshot = f.reader.snapshotContinuity.bind(f.reader);
  vi.spyOn(f.reader, "snapshotContinuity").mockImplementation(input => snapshot({ ...input, ...(input.selection ? { scanBudget } : {}) }));
  const result = await f.prepare(); expect(f.complete).not.toHaveBeenCalled();
  expect(result.events).toContainEqual(expect.objectContaining({ status: "skipped", reason: "ledger_scan_capacity", providerInvoked: false }));
  expect((await f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } }))!.bootstrap).toBe(true);
});
it("batches lifecycle bindings once per run across read pages", async () => {
  const f = await fixture(), binding = { conversationId: "fictional", logicalConversationId: "fictional", runId: "one-run", isolated: false, continuityEnabled: true as const, finalizedContinuity: true as const };
  for (let i = 0; i < 130; i++) {
    await f.writer.persist(binding, { phase: "invocation", toolCallId: `call-${i}`, toolName: "read_notes", arguments: {} });
    await f.writer.persist(binding, { phase: "result", toolCallId: `call-${i}`, state: "success", content: `Reference REF-${i}.` });
  }
  await f.writer.finishRun(binding, "completed");
  const source = f.reader.snapshotContinuity({ ...scope, selection: "upkeep" });
  expect(source.upkeep?.scan).toMatchObject({ complete: true, rows: 130, pages: 3, bindingQueries: 1, bindings: 130 });
  expect(source.records.every(r => r.tool?.name === "read_notes")).toBe(true);
});
it("releases each page transaction and rejects a selected source deleted between pages", async () => {
  const f = await fixture(); await f.capture(150);
  const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec;
  let page = false, mutated = false;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) { if (sql.includes("ORDER BY r.ordinal LIMIT 64")) page = true; return prepare.call(this, sql); });
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
    const result = exec.call(this, sql);
    if (sql === "COMMIT" && page && !mutated) { page = false; mutated = true; f.db(db => db.exec("DELETE FROM continuity_records WHERE ordinal=1")); }
    return result;
  });
  await f.prepare(); expect(mutated).toBe(true); expect(f.complete).not.toHaveBeenCalled();
});

it("excludes legacy current citations before the oldest-never-offered fairness queue", async () => {
  const f = await fixture(); await f.capture(64, "Archival prose.");
  const covered = selectLedgerSources(f.reader.snapshotContinuity({ ...scope, selection: "upkeep" })).spans.map(spanKey);
  await f.capture(256, "Reference REF-120.");
  const source = f.reader.snapshotContinuity({ ...scope, selection: "upkeep", priorCovered: covered });
  expect(source.upkeep?.scan).toMatchObject({ complete: true, rows: 320, excluded: 64 });
  expect(source.upkeep?.candidates?.some(s => s.ordinal === 65)).toBe(true);
  expect(source.upkeep?.candidates?.every(s => s.ordinal > 64)).toBe(true);
});

it("counts repeated shapes over the complete native scan before choosing diverse representatives", async () => {
  const f = await fixture();
  for (let i = 0; i < 24; i++) await f.capture(1, `Dispatch notice REF-${100 + i}: amount $${200 + i}.`, "fictional", true);
  await f.capture(1, "The register now records $275 instead of the previous $490.", "fictional", true);
  await f.capture(1, "Plain background paragraph.\n\n".repeat(2000) + "Routing token RIVET-123.", "fictional", true);
  const source = f.reader.snapshotContinuity({ ...scope, selection: "upkeep" });
  expect(source.records.map(r => r.ordinal)).toEqual(source.records.map(r => r.ordinal).sort((a, b) => a - b));
  expect(source.upkeep?.scan).toMatchObject({ complete: true, rows: 26, diversity: { templateSuppressed: 2020 } });
  expect(source.upkeep?.candidates?.filter(s => s.ordinal <= 24).length).toBeLessThanOrEqual(2);
  expect(source.upkeep?.candidates?.some(s => s.ordinal === 25)).toBe(true);
  const r = source.records.find(r => r.ordinal === 26)!;
  expect(source.upkeep?.candidates?.some(s => s.ordinal === 26 && s.start > 0 && Buffer.from(r.text).subarray(s.start, s.end).toString().includes("RIVET-123"))).toBe(true);
  expect(f.complete).not.toHaveBeenCalled();
});

it("owns a distinct BEGIN/COMMIT pair for each of three history pages", async () => {
  const f = await fixture(); await f.capture(150);
  const exec = DatabaseSync.prototype.exec, prepare = DatabaseSync.prototype.prepare;
  const active = new Map<DatabaseSync, { pages: number }>(), completed: { pages: number }[] = [];
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
    const result = exec.call(this, sql);
    if (sql === "BEGIN") { expect(active.has(this)).toBe(false); active.set(this, { pages: 0 }); }
    if (sql === "COMMIT") { const transaction = active.get(this); expect(transaction).toBeDefined(); completed.push(transaction!); active.delete(this); }
    return result;
  });
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
    if (sql.includes("ORDER BY r.ordinal LIMIT 64")) { expect(active.has(this)).toBe(true); active.get(this)!.pages++; }
    return prepare.call(this, sql);
  });
  const snapshot = f.reader.snapshotContinuity({ ...scope, selection: "upkeep" });
  expect(snapshot.upkeep?.scan).toMatchObject({ complete: true, rows: 150, pages: 3 });
  expect(completed.filter(transaction => transaction.pages)).toEqual([{ pages: 1 }, { pages: 1 }, { pages: 1 }]);
  expect(active.size).toBe(0);
});
// validateRecord closes source keys; safeMetadata caps three strings at 512 bytes,
// normalizeId caps the attested input at 4096 bytes, and requestDigest is 64 hex.
// Even 6x JSON escaping plus keys/safe revision stays below 36 KiB (<64 KiB scan cap).
it("bounds source metadata at admission and keeps healthy history scannable", async () => {
  const f = await fixture(), generationId = continuityGenerationId(), digest = ledgerHash(generationId);
  const inputId = '"'.repeat(4096), source = { epoch: '"'.repeat(512), journalId: '"'.repeat(512), operationId: '"'.repeat(512), revision: Number.MAX_SAFE_INTEGER, attestation: { inputId, requestDigest: digest } };
  expect(Buffer.byteLength(JSON.stringify(source))).toBeLessThan(36 * 1024);
  const record = { recordId: continuityRecordId("fictional", "bound"), runId: generationId, inputId, kind: "owner" as const, provenance: "host-owner" as const, sequence: 0, text: "Bounded evidence.", source };
  const input = { generationId, conversationId: "fictional", logicalConversationId: "fictional", beforeDigest: null, afterDigest: digest, records: [record] };
  await expect(f.writer.prepareContinuity({ ...input, records: [{ ...record, source: { ...source, epoch: "x".repeat(65537) } }] })).rejects.toMatchObject({ code: "continuity_invalid_provenance" });
  await expect(f.writer.prepareContinuity({ ...input, records: [{ ...record, inputId: "x".repeat(65537), source: { attestation: { inputId: "x".repeat(65537), requestDigest: digest } } }] })).rejects.toThrow("4096");
  await f.writer.prepareContinuity(input); await f.writer.commitContinuity({ generationId, conversationId: "fictional", canonicalDigest: digest });
  await f.capture(3);
  const snapshot = f.reader.snapshotContinuity({ ...scope, selection: "upkeep" });
  expect(snapshot.upkeep?.scan).toMatchObject({ complete: true, rows: 4 });
  expect(snapshot.degradedReason).toBeUndefined(); expect(snapshot.gaps).toBe(0);
  expect(snapshot.records).toHaveLength(4);
});
it("releases a non-invoked bootstrap and admits a fresh bootstrap then incremental operation", async () => {
  const f = await fixture(); await f.capture(3);
  f.complete.mockImplementationOnce(async (_prompt, _signal, budget) => ({ text: "", receipt: { operationId: budget.operationId, model: "fictional:base", status: "skipped", reason: "model_headroom", providerInvoked: false, capEnforcement: "request" } }));
  await f.prepare();
  expect(f.db(db => db.prepare("SELECT state,budget FROM continuity_upkeep_operations").all())).toEqual([{ state: "released", budget: "bootstrap" }]);
  expect((await f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } }))!.bootstrap).toBe(true);
  await f.prepare(); await f.prepare();
  const rows = f.db(db => db.prepare("SELECT state,budget FROM continuity_upkeep_operations ORDER BY rowid").all());
  expect(rows).toHaveLength(3); expect(rows[0]).toEqual({ state: "released", budget: "bootstrap" });
  expect(rows[1]).toMatchObject({ budget: "bootstrap" }); expect(rows[2]).toMatchObject({ budget: "incremental" });
  expect(f.budgets).toEqual([128000, 64000]);
});

it("uses durable first-offer counts for the short-owner bonus without changing retirement", async () => {
  const f = await fixture(); f.respond(() => []);
  await f.capture(1, "Keep the LANTERN exhibit pending review.");
  const scan = () => f.reader.snapshotContinuity({ ...scope, selection: "upkeep" }).upkeep!.candidates!;
  const first = scan()[0]!;
  await f.prepare();
  const reoffer = scan().find(candidate => candidate.key === first.key)!;
  expect(reoffer.offers).toBe(1); expect(reoffer.score).toBe(first.score - 16);
  await f.capture(1, "Cancel the WILLOW exhibit commitment.");
  const fresh = scan().find(candidate => candidate.ordinal > first.ordinal)!;
  expect(fresh.offers).toBe(0);
  await f.prepare();
  expect(f.selections[1]!.some(row => row.ordinal === fresh.ordinal)).toBe(true);
  expect(scan().some(candidate => candidate.key === first.key)).toBe(false); // Unchanged two-offer limit.
  expect(f.reader.ledger(scope)).toBeUndefined(); // Both deltas were analysis only.
});
