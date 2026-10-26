import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { ToolHistoryWriter } from "../tool-history/writer.js";
import { ToolHistoryReader } from "../tool-history/reader.js";
import { continuityGenerationId, continuityRecordId } from "../tool-history/continuity-storage.js";
import { persistContinuityPurge } from "../tool-history/continuity-purge.js";
import { createContinuityPackSupplier } from "../continuity/pack.js";
import { fitsLedgerPrefix } from "../continuity/render-fit.js";
import { ledgerHash, normalizeLedger, renderLedger, selectLedgerSources, spanKey, validateLedgerOutput, type LedgerEntry } from "../continuity/ledger.js";
import type { ConversationHarnessOptions } from "../harness/contracts.js";

const scope = { logicalConversationId: "fictional", currentConversationId: "fictional", currentRunId: "new-turn" };
const resources: { root: string; writer: ToolHistoryWriter }[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of resources.splice(0)) { await f.writer.close(); await rm(f.root, { recursive: true, force: true }); } });
const eligibility = { sessionsEnabled: true, isolated: false, ownedStore: true, primaryAttempt: true, maxTokens: 8000, withOwner: async <T>(fn: (owner: string) => Promise<T>) => fn("fictional-owner") };
const parse = (prompt: string) => prompt.split("\nSources:\n")[1]!.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "progressive-ledger-")), writer = await ToolHistoryWriter.open({ root, continuityEnabled: true, persistenceCeilingMs: 5000 });
  resources.push({ root, writer });
  const reader = new ToolHistoryReader(root), selections: any[][] = [], budgets: number[] = [];
  let response = (rows: any[]) => [{ kind: "open_work", value: `Fictional state ${rows[0].ordinal}/${rows[0].start}.`, status: "unknown", sources: [rows[0].id] }];
  const complete = vi.fn(async (prompt: string, _signal: AbortSignal, budget: { operationId: string; inputTokens: number }) => {
    const rows = parse(prompt); selections.push(rows); budgets.push(budget.inputTokens);
    return { text: JSON.stringify({ entries: response(rows), covered: rows.map(row => row.id) }), receipt: { operationId: budget.operationId, model: "fictional:base", status: "valid", reason: "completed", providerInvoked: true, capEnforcement: "request" } };
  });
  const ports = { writer, reader, mutateUpkeep: writer.mutateUpkeep.bind(writer), publishLedger: writer.publishLedger.bind(writer), continuityEnabled: true, logicalConversationId: () => "fictional", upkeep: { enabled: true, model: "fictional:base", complete } };
  const capture = async (count = 1, text = "Rule.", physical = "fictional", neutral = false) => {
    for (let left = count; left > 0; left -= 128) {
      const generationId = continuityGenerationId(), digest = ledgerHash(generationId);
      await writer.prepareContinuity({ generationId, conversationId: physical, logicalConversationId: "fictional", beforeDigest: null, afterDigest: digest,
        records: Array.from({ length: Math.min(128, left) }, (_, i) => ({ recordId: continuityRecordId(physical, `${generationId}-${i}`), runId: generationId, inputId: `${generationId}-${i}`, kind: neutral ? "user" as const : "owner" as const, provenance: neutral ? "unknown" as const : "host-owner" as const, sequence: i, text, source: neutral ? {} : { attestation: { inputId: `${generationId}-${i}`, requestDigest: digest } } })) });
      await writer.commitContinuity({ generationId, conversationId: physical, canonicalDigest: digest });
    }
  };
  const db = <T>(fn: (db: DatabaseSync) => T): T => { const database = new DatabaseSync(reader.databasePath); try { database.exec("PRAGMA foreign_keys=ON"); return fn(database); } finally { database.close(); } };
  const prepare = async (maxTokens = 8000, physical = "fictional") => {
    const events: any[] = [], supplier = createContinuityPackSupplier({ toolHistory: ports } as unknown as ConversationHarnessOptions, { conversationId: physical, userMessage: "Current fictional boundary.", abortSignal: new AbortController().signal }, randomUUID())!;
    await supplier.prepare({ ...eligibility, maxTokens }, "cold_rebuild", event => events.push(event));
    return { events, pack: () => JSON.stringify(supplier([], maxTokens, "cold_rebuild", () => {})) };
  };
  return { root, writer, reader, complete, capture, prepare, selections, budgets, db, ports, respond: (fn: typeof response) => { response = fn; } };
}

it("progresses beyond 512 records, preserves earlier stable entries, and reaches actual tool interiors", async () => {
  const f = await fixture(); await f.capture(640);
  const binding = { conversationId: "fictional", logicalConversationId: "fictional", runId: "tool-run", isolated: false, continuityEnabled: true as const, finalizedContinuity: true as const };
  await f.writer.persist(binding, { phase: "invocation", toolCallId: "lookup", toolName: "mail_read", arguments: {} });
  await f.writer.persist(binding, { phase: "result", toolCallId: "lookup", toolName: "mail_read", state: "success", content: "Fictional heading.\n\n" + "neutral prose ".repeat(1600) + "FABLE-Z91" }); await f.writer.finishRun(binding, "completed");
  let first: LedgerEntry | undefined;
  for (let i = 0; i < 14; i++) {
    const result = await f.prepare(), generation = f.reader.ledger(scope)!.generation;
    expect(result.events).toContainEqual(expect.objectContaining({ status: "valid", generationId: generation.id }));
    first ??= generation.entries[0]; expect(generation.entries).toContainEqual(first);
    expect(result.pack()).toContain("### Continuity ledger");
    if (f.selections.at(-1)!.some(row => row.text.includes("FABLE-Z91"))) break;
  }
  expect(f.selections.flat().some(row => row.ordinal > 512 && row.start > 0 && row.text.includes("FABLE-Z91"))).toBe(true);
  const keys = f.selections.flat().map(spanKey); expect(new Set(keys).size).toBe(keys.length);
  expect(f.budgets[0]).toBe(128000); expect(f.budgets.slice(1).every(budget => budget === 64000)).toBe(true);
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_operations WHERE budget='bootstrap'").get())).toEqual({ n: 1 });
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_offers WHERE state='failed'").get())).not.toEqual({ n: 0 });
}, 20000);

it("resumes a UTF-8 interior cursor without reoffering windows or relying on a source anchor", async () => {
  const f = await fixture(); await f.capture(1, "Fictional Ω prose ".repeat(24000), "fictional", true);
  await f.prepare(); const cursor = f.db(db => JSON.parse((db.prepare("SELECT cursor FROM continuity_upkeep_progress").get() as { cursor: string }).cursor));
  expect(cursor.offset).toBeGreaterThan(0); expect(cursor.ordinal).toBe(1);
  await f.prepare(); expect(f.selections[1]![0].start).toBe(cursor.offset);
  const keys = f.selections.flat().map(spanKey); expect(new Set(keys).size).toBe(keys.length);
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
  const victim = f.db(db => db.prepare("SELECT ordinal FROM continuity_upkeep_offers WHERE state='failed' LIMIT 1").get()) as { ordinal: number };
  f.db(db => db.prepare("UPDATE continuity_records SET retained_text=NULL WHERE ordinal=?").run(victim.ordinal));
  expect(f.reader.ledger(scope)).toBeUndefined();
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_offers WHERE state='represented'").get())).toEqual({ n: 0 });
  expect(f.db(db => db.prepare("SELECT ordinal FROM continuity_upkeep_offers WHERE state='unrepresented' ORDER BY ordinal").all())).toEqual(successes);
  f.respond(rows => rows.filter(row => successes.some(old => old.ordinal === row.ordinal)).map(row => ({ kind: "open_work", value: `Reconstructed ${row.ordinal}.`, status: "unknown", sources: [row.id] })));
  await f.prepare(); const next = f.selections[2]!;
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
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_offers").get())).toEqual({ n: 2 });
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
  expect(result.events).toContainEqual(expect.objectContaining({ reason: "ledger_render_budget", providerInvoked: false }));
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

it("stops before invocation at metadata capacity without deleting anti-repurchase evidence", async () => {
  const f = await fixture(); await f.capture();
  await f.writer.mutateUpkeep({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional" } });
  f.db(db => db.exec(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<65536)
    INSERT INTO continuity_upkeep_offers SELECT 'other','other','incarnation',printf('%064x',n),1,printf('%064x',0),0,1,printf('op-%d',n),'uncertain',NULL FROM seq;`));
  await f.prepare(); expect(f.complete).not.toHaveBeenCalled();
  expect(f.db(db => db.prepare("SELECT count(*) n FROM continuity_upkeep_offers").get())).toEqual({ n: 65536 });
});

it("leaves the disabled path without progress/admission tables or a completion", async () => {
  const f = await fixture(); await f.capture(); f.ports.upkeep.enabled = false;
  await f.prepare(); expect(f.complete).not.toHaveBeenCalled();
  expect(f.db(db => db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'continuity_upkeep_%'").all())).toEqual([]);
});

it("continues after deletion of the actual interior cursor record without renewing bootstrap", async () => {
  const f = await fixture(); await f.capture(1, "Fictional neutral prose ".repeat(18000), "fictional", true); await f.capture(1, "Surviving rule.");
  await f.prepare(); expect(f.selections[0]!.every(span => span.ordinal === 1)).toBe(true);
  f.db(db => db.prepare("DELETE FROM continuity_records WHERE ordinal=1").run());
  await f.prepare(); expect(f.selections[1]![0]).toMatchObject({ ordinal: 2, start: 0, text: "Surviving rule." });
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
  const source = f.reader.snapshotContinuity(scope), selection = selectLedgerSources(source);
  const base = validateLedgerOutput(JSON.stringify({ entries: [{ kind: "open_work", value: "Prior fact.", status: "unknown", sources: ["s0"] }], covered: ["s0", "s1"] }), selection, scope);
  const legacy = { ...base, coveredSpans: base.spans.map(span => span.id), uncovered: 0 };
  await f.writer.publishLedger(legacy);
  const read = f.reader.ledger(scope)!.generation;
  expect(read.coveredSpans).toEqual([base.spans[0]!.id]); expect(read.uncovered).toBe(1);
  await f.prepare(); expect(f.complete).toHaveBeenCalledTimes(1);
  expect(f.selections[0]!.map(row => row.ordinal)).toEqual([2]);
  expect(f.reader.ledger(scope)!.generation.entries).toContainEqual(base.entries[0]);
});
