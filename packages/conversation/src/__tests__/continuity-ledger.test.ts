import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { ToolHistoryWriter } from "../tool-history/writer.js";
import { ToolHistoryReader } from "../tool-history/reader.js";
import { continuityGenerationId, continuityRecordId } from "../tool-history/continuity-storage.js";
import { persistContinuityPurge } from "../tool-history/continuity-purge.js";
import { ledgerHash, selectLedgerSources, validateLedgerOutput, type LedgerSelection } from "../continuity/ledger.js";
import { createContinuityPackSupplier, renderContinuityPack } from "../continuity/pack.js";
import type { ConversationHarnessOptions } from "../harness/contracts.js";
const scope = { logicalConversationId: "fictional", currentConversationId: "fictional", currentRunId: "current" };
const resources: { root: string; writer: ToolHistoryWriter }[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of resources.splice(0)) { await f.writer.close(); await rm(f.root, { recursive: true, force: true }); } });
async function fixture(maxBytes?: number) {
  const root = await mkdtemp(join(tmpdir(), "ledger-"));
  const writer = await ToolHistoryWriter.open({ root, continuityEnabled: true, persistenceCeilingMs: 5000, ...(maxBytes ? { retention: { maxBytes } } : {}) });
  resources.push({ root, writer }); return { root, writer, reader: new ToolHistoryReader(root) };
}
async function owner(f: Awaited<ReturnType<typeof fixture>>, text = "Never send without confirmation.", count = 1) {
  const generationId = continuityGenerationId(), digest = ledgerHash(generationId);
  await f.writer.prepareContinuity({ generationId, conversationId: "fictional", logicalConversationId: "fictional", beforeDigest: null, afterDigest: digest,
    records: Array.from({ length: count }, (_, i) => ({ recordId: continuityRecordId("fictional", `${generationId}-${i}`), runId: generationId, inputId: `${generationId}-${i}`,
      kind: "owner" as const, provenance: "host-owner" as const, sequence: i, text,
      source: { attestation: { inputId: `${generationId}-${i}`, requestDigest: digest } } })) });
  await f.writer.commitContinuity({ generationId, conversationId: "fictional", canonicalDigest: digest });
}
async function tool(f: Awaited<ReturnType<typeof fixture>>, text: string) {
  const binding = { conversationId: "fictional", logicalConversationId: "fictional", runId: "effect", isolated: false, continuityEnabled: true as const, finalizedContinuity: true as const };
  await f.writer.persist(binding, { phase: "invocation", toolCallId: "lookup", toolName: "mail_read", arguments: {} });
  await f.writer.persist(binding, { phase: "result", toolCallId: "lookup", toolName: "mail_read", state: "success", content: text });
  await f.writer.finishRun(binding, "completed");
}
const output = (selection: LedgerSelection) => JSON.stringify({ entries: [{ kind: "open_work", value: "Derived fictional state.", status: "unknown", sources: [selection.spans[0]!.id] }], covered: selection.spans.map(s => s.id) });
const eligible = { sessionsEnabled: true, isolated: false, ownedStore: true, primaryAttempt: true, maxTokens: 8000, withOwner: async <T>(op: () => Promise<T>) => await op() };

it("selects independently past the owner-first shortlist, including tool interiors under the cumulative input estimate", async () => {
  const f = await fixture(); for (let i = 0; i < 5; i++) await owner(f, "Fictional filler.", 128);
  await tool(f, "Fictional head.\n\n" + "lookup prose ".repeat(1600) + "BURIED-42\n\nRevised actual amount: $725.");
  expect(f.reader.snapshotContinuity(scope).records.every(r => r.kind !== "tool")).toBe(true);
  const source = f.reader.snapshotContinuity({ ...scope, selection: "upkeep" });
  expect(source.records[0]!.kind).toBe("tool");
  const selected = selectLedgerSources(source);
  expect(selected.prompt).toContain("BURIED-42"); expect(selected.prompt).toContain("$725");
  expect((Buffer.byteLength(selected.prompt) / 2 + 16) * 1.25).toBeLessThanOrEqual(64000);
  expect(selected.uncovered).toBeGreaterThan(0);
});

it("validates exact spans and quotes whole owner paragraphs without promoting derived prose", async () => {
  const f = await fixture(); await owner(f, "Never send. Keep the suffix. Require confirmation.");
  const source = f.reader.snapshotContinuity(scope), selection = selectLedgerSources(source);
  const generation = validateLedgerOutput(output(selection), selection, scope);
  const pack = renderContinuityPack(source, [], 8000, { generation, records: source.records });
  expect(pack.text).toContain("derived interpretation, not owner authority");
  expect(pack.text).toContain("Never send. Keep the suffix. Require confirmation.");
  expect(pack.text).toContain("Historical owner request"); expect(pack.counts.owner).toBe(1);
  expect(pack.text!.indexOf("### Continuity ledger")).toBeLessThan(pack.text!.indexOf("Historical owner request"));
  expect(pack.ledgerEntries).toBe(1);
  expect(() => validateLedgerOutput('{"entries":[],"covered":["forged"]}', selection, scope)).toThrow();
  const bad = { ...selection, spans: [{ ...selection.spans[0]!, start: 1 }] };
  expect(() => validateLedgerOutput(output(bad), bad, scope)).toThrow();
  expect(() => validateLedgerOutput(JSON.stringify({ entries: [{ kind: "identifier", value: "INVENTED-99", status: "active", sources: ["s0"] }], covered: ["s0"] }), selection, scope)).toThrow();
  expect(() => validateLedgerOutput(JSON.stringify({ entries: [{ kind: "commitment", value: "sent", status: "confirmed", sources: ["s0"] }], covered: ["s0"] }), selection, scope)).toThrow();
});

it("publishes only the latest generation with parent/manifest CAS and inherited-source cascade on an old-binary B1 deletion", async () => {
  const f = await fixture(); await owner(f);
  const first = selectLedgerSources(f.reader.snapshotContinuity(scope));
  const parent = validateLedgerOutput(output(first), first, scope); await f.writer.publishLedger(parent);
  expect(f.reader.ledger(scope)?.generation.id).toBe(parent.id);
  await owner(f, "Other fictional evidence.");
  const second = selectLedgerSources(f.reader.snapshotContinuity(scope), parent);
  const next = validateLedgerOutput(output(second), second, scope, parent); await f.writer.publishLedger(next);
  await expect(f.writer.publishLedger({ ...next, id: "stale", parent: parent.id })).rejects.toThrow();
  const db = new DatabaseSync(f.reader.databasePath); db.exec("PRAGMA foreign_keys=ON");
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
  expect(db.prepare("SELECT count(*) n FROM continuity_ledger").get()).toEqual({ n: 1 });
  // No new purge API needed: a pre-ledger writer's source deletion cascades.
  db.prepare("DELETE FROM continuity_records WHERE record_id=?").run(parent.inputs[0]!.recordId); db.close();
  expect(f.reader.ledger(scope)).toBeUndefined();
});

it.each(["tombstone", "changed", "quota"])("invalidates or refuses %s without advancing coverage", async mode => {
  const f = await fixture(mode === "quota" ? 512 : undefined); await owner(f);
  const selection = selectLedgerSources(f.reader.snapshotContinuity(scope));
  const generation = validateLedgerOutput(output(selection), selection, scope);
  if (mode === "quota") { await expect(f.writer.publishLedger(generation)).rejects.toThrow(); expect(f.reader.ledger(scope)).toBeUndefined(); return; }
  await f.writer.publishLedger(generation);
  const db = new DatabaseSync(f.reader.databasePath);
  db.exec(mode === "tombstone" ? "UPDATE continuity_records SET retained_text=NULL" : "UPDATE continuity_records SET retained_text='Changed fictional source.'"); db.close();
  expect(f.reader.ledger(scope)).toBeUndefined();
});

it.each([
  ["per_message", { sessionsEnabled: false }], ["isolated", { isolated: true }], ["unowned_store", { ownedStore: false }],
  ["detached_attempt", { primaryAttempt: false }], ["trigger_headroom", { maxTokens: 0 }],
] as const)("explicitly records %s ineligibility without a model request", async (reason, patch) => {
  const f = await fixture(); await owner(f); const complete = vi.fn(); const events: unknown[] = [];
  const options = { toolHistory: { ...f, logicalConversationId: (id: string) => id, continuityEnabled: true, upkeep: { enabled: true, complete }, publishLedger: f.writer.publishLedger.bind(f.writer) } } as unknown as ConversationHarnessOptions;
  const supplier = createContinuityPackSupplier(options, { conversationId: "fictional", userMessage: "Current.", abortSignal: new AbortController().signal }, "current")!;
  await supplier.prepare({ ...eligible, ...patch }, "cold_rebuild", e => events.push(e));
  expect(complete).not.toHaveBeenCalled(); expect(events).toContainEqual(expect.objectContaining({ type: "continuity_upkeep", status: "skipped", reason }));
});

it("freezes one generation across retry, preserves the host receipt and suppresses purge intents", async () => {
  const f = await fixture(); await owner(f); const selection = selectLedgerSources(f.reader.snapshotContinuity(scope));
  const complete = vi.fn(async () => ({ text: output(selection), receipt: { status: "valid", reason: "completed", providerInvoked: true } }));
  const options = { toolHistory: { ...f, logicalConversationId: (id: string) => id, continuityEnabled: true, upkeep: { enabled: true, complete }, publishLedger: f.writer.publishLedger.bind(f.writer) } } as unknown as ConversationHarnessOptions;
  const request = { conversationId: "fictional", userMessage: "Current.", abortSignal: new AbortController().signal };
  const supplier = createContinuityPackSupplier(options, request, "current")!, events: unknown[] = [];
  await supplier.prepare(eligible, "cold_rebuild", e => events.push(e));
  await supplier.prepare({ ...eligible, primaryAttempt: false }, "detached_context", e => events.push(e));
  expect(complete).toHaveBeenCalledTimes(1);
  expect(events.filter((event: any) => event.type === "continuity_upkeep")).toHaveLength(1);
  expect(events).toContainEqual(expect.objectContaining({ generationId: expect.any(String) }));
  expect(JSON.stringify(supplier([], 8000, "cold_rebuild", () => {}))).toContain("### Continuity ledger");
  persistContinuityPurge(f.root, { scope: "physical", conversationId: "fictional" });
  expect(JSON.stringify(supplier([], 8000, "detached_context", () => {}))).not.toContain("Never send");
});

it("read-only ledger reuse makes no completion and explicit disabled controls render no ledger", async () => {
  const f = await fixture(); await owner(f); const selection = selectLedgerSources(f.reader.snapshotContinuity(scope));
  await f.writer.publishLedger(validateLedgerOutput(output(selection), selection, scope));
  const complete = vi.fn();
  const request = { conversationId: "fictional", userMessage: "Current.", abortSignal: new AbortController().signal };
  for (const ledgerEnabled of [false, true]) {
    const options = { toolHistory: { ...f, logicalConversationId: (id: string) => id, continuityEnabled: true, ledgerEnabled, upkeep: { enabled: false, complete } } } as unknown as ConversationHarnessOptions;
    const supplier = createContinuityPackSupplier(options, request, "current")!;
    await supplier.prepare(eligible, "cold_rebuild", () => {});
    expect(JSON.stringify(supplier([], 8000, "cold_rebuild", () => {})).includes("### Continuity ledger")).toBe(ledgerEnabled);
  }
  expect(complete).not.toHaveBeenCalled();
});
it("invalid output never publishes a generation or removes canonical owner dedup proof", async () => {
  const f = await fixture(); await owner(f); const events: any[] = [];
  const options = { toolHistory: { ...f, logicalConversationId: (id: string) => id, continuityEnabled: true, upkeep: { enabled: true, complete: async () => ({ text: "INVALID", receipt: { status: "valid", providerInvoked: true } }) }, publishLedger: f.writer.publishLedger.bind(f.writer) } } as unknown as ConversationHarnessOptions;
  const supplier = createContinuityPackSupplier(options, { conversationId: "fictional", userMessage: "Current.", abortSignal: new AbortController().signal }, "current")!;
  await supplier.prepare(eligible, "cold_rebuild", event => events.push(event));
  expect(f.reader.ledger(scope)).toBeUndefined();
  expect(events).toContainEqual(expect.objectContaining({ type: "continuity_upkeep", status: "invalid" }));
  const record = f.reader.snapshotContinuity(scope).records[0]!;
  supplier([{ role: "user", content: record.text, runId: record.runId, timestamp: "2026-01-01T00:00:00Z" }], 8000, "cold_rebuild", event => events.push(event));
  expect(events).toContainEqual(expect.objectContaining({ type: "continuity_pack_injected", degradedReason: "upkeep_gap", ownerDeduped: 1, ownerEntries: 0 }));
});

it("rejects a corrupted ledger payload before any paid extraction while preserving independent evidence", async () => {
  const f = await fixture(); await owner(f); const selection = selectLedgerSources(f.reader.snapshotContinuity(scope));
  await f.writer.publishLedger(validateLedgerOutput(output(selection), selection, scope));
  const db = new DatabaseSync(f.reader.databasePath); db.exec("UPDATE continuity_ledger SET payload=replace(payload,'Derived fictional state.','Altered fictional state.')"); db.close();
  expect(() => f.reader.ledger(scope)).toThrow("ledger_payload_digest");
  const complete = vi.fn(), events: any[] = [];
  const options = { toolHistory: { ...f, logicalConversationId: (id: string) => id, continuityEnabled: true, upkeep: { enabled: true, complete }, publishLedger: f.writer.publishLedger.bind(f.writer) } } as unknown as ConversationHarnessOptions;
  const supplier = createContinuityPackSupplier(options, { conversationId: "fictional", userMessage: "Current.", abortSignal: new AbortController().signal }, "current")!;
  await supplier.prepare(eligible, "cold_rebuild", event => events.push(event));
  expect(complete).not.toHaveBeenCalled();
  expect(JSON.stringify(supplier([], 8000, "cold_rebuild", () => {}))).toContain("Never send");
  expect(events).toContainEqual(expect.objectContaining({ type: "continuity_upkeep", status: "skipped", providerInvoked: false }));
});
