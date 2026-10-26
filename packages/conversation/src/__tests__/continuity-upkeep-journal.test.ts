import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { ContinuityUpkeepReceipt } from "@mono-agent/turn/host";
import { ToolHistoryWriter } from "../tool-history/writer.js";
import { ToolHistoryReader } from "../tool-history/reader.js";
import { mutateUpkeep, resetUpkeep, assertUpkeepPublication, type UpkeepAdmission, type UpkeepReservation, type UpkeepMutation } from "../continuity/admission.js";
import { createDurableHistoryStore } from "../history/canonical/store.js";
import { createLedgerSupplier } from "../continuity/upkeep.js";
import { selectLedgerSources, ledgerHash } from "../continuity/ledger.js";
import { continuityGenerationId, continuityRecordId } from "../tool-history/continuity-storage.js";
import { persistContinuityPurge } from "../tool-history/continuity-purge.js";
import type { ConversationHarnessOptions } from "../harness/contracts.js";

const scopes = { logicalId: "fictional", conversationId: "fictional" };
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function receipt(r: UpkeepReservation, extra: Partial<ContinuityUpkeepReceipt> = {}): ContinuityUpkeepReceipt {
  return { operationId: r.operationId, model: r.model, api: "openai-responses", capEnforcement: "request", status: "valid", reason: "completed", providerInvoked: true,
    elapsedMs: 1, inputTokens: 25, outputTokens: 2, estimatedInputTokens: 30, estimatedInputCostUsd: 0.0001, costUsd: 0.0002, visibleEstimate: 2, outputOverrun: false, ...extra };
}
function reservation(fence: UpkeepAdmission, operationId = "operation"): UpkeepReservation {
  const { bootstrap, ...fields } = fence;
  return { ...fields, operationId, runId: "origin-run", recorderNamespace: "fictional-recorder", model: "fictional:base", manifest: "a".repeat(64), parent: null, budget: bootstrap ? "bootstrap" : "incremental" };
}
function memory() {
  const db = new DatabaseSync(":memory:"); cleanups.push(() => db.close());
  const mutate = (input: UpkeepMutation) => mutateUpkeep(db, "fictional-root", input);
  const inspect = () => mutate({ kind: "inspect", scope: scopes })!;
  const claim = (ownerToken: string) => mutate({ kind: "claim", expected: inspect(), ownerToken })!;
  return { db, mutate, inspect, claim };
}

it("replays identical transitions but refuses conflicting payloads and duplicate source purchases", () => {
  const f = memory(), expected = f.inspect(), fence = f.mutate({ kind: "claim", expected, ownerToken: "owner" })!;
  expect(f.mutate({ kind: "claim", expected, ownerToken: "owner" })).toEqual(fence);
  const r = reservation(fence);
  for (let i = 0; i < 2; i++) f.mutate({ kind: "reserve", reservation: r });
  expect(() => f.mutate({ kind: "reserve", reservation: { ...r, model: "fictional:other" } })).toThrow();
  expect(() => f.mutate({ kind: "reserve", reservation: { ...r, operationId: "duplicate" } })).toThrow("upkeep_repeat_suppressed");
  expect(() => f.mutate({ kind: "outcome", reservation: r, receipt: receipt(r) })).toThrow();
  for (let i = 0; i < 2; i++) f.mutate({ kind: "dispatch", reservation: r });
  for (let i = 0; i < 2; i++) f.mutate({ kind: "outcome", reservation: r, receipt: receipt(r) });
  expect(() => f.mutate({ kind: "outcome", reservation: r, receipt: receipt(r, { costUsd: 1 }) })).toThrow();
  expect(() => f.mutate({ kind: "dispatch", reservation: r })).toThrow();
  expect(f.inspect().bootstrap).toBe(false);
});

it("installs a fence before releasing reserved work and rejects every delayed old transition", () => {
  const f = memory(), old = reservation(f.claim("old")); f.mutate({ kind: "reserve", reservation: old });
  const current = f.claim("new"); expect(current.bootstrap).toBe(true);
  for (const kind of ["reserve", "dispatch", "outcome"] as const) expect(() => f.mutate(kind === "outcome" ? { kind, reservation: old, receipt: receipt(old) } : { kind, reservation: old })).toThrow();
  expect(() => assertUpkeepPublication(f.db, "fictional-root", old)).toThrow();
  const next = reservation(current, "next"); f.mutate({ kind: "reserve", reservation: next }); f.mutate({ kind: "dispatch", reservation: next });
  expect(f.inspect().bootstrap).toBe(false);
});

it.each(["model_identity", "input_budget", "cap_unsupported", "model_headroom", "aborted", "unavailable"])("releases only durable allowlisted non-invocation proof (%s)", reason => {
  const f = memory(), r = reservation(f.claim("owner")); f.mutate({ kind: "reserve", reservation: r }); f.mutate({ kind: "dispatch", reservation: r });
  f.mutate({ kind: "outcome", reservation: r, receipt: receipt(r, { status: "skipped", providerInvoked: false, reason }) });
  expect(f.claim("recovery").bootstrap).toBe(!["aborted", "unavailable"].includes(reason));
});

it("reset rotates incarnation, clears only this scope and blocks stale claims/publications", () => {
  const f = memory(), r = reservation(f.claim("old")); f.mutate({ kind: "reserve", reservation: r }); f.mutate({ kind: "dispatch", reservation: r });
  f.mutate({ kind: "outcome", reservation: r, receipt: receipt(r) });
  resetUpkeep(f.db, "logical", "unrelated"); expect(f.inspect().bootstrap).toBe(false);
  const expected = f.inspect(); resetUpkeep(f.db, "physical", "fictional");
  expect(f.inspect()).toMatchObject({ bootstrap: true, fence: expected.fence + 1 });
  expect(f.inspect().incarnation).not.toBe(expected.incarnation);
  expect(() => f.mutate({ kind: "claim", expected, ownerToken: "old" })).toThrow();
  expect(() => assertUpkeepPublication(f.db, "fictional-root", r)).toThrow();
  expect(f.db.prepare("SELECT * FROM continuity_upkeep_operations").all()).toEqual([]);
});

it("binds admission to database/root, logical and physical identity", () => {
  const f = memory(), fence = f.claim("owner"), r = reservation(fence);
  expect(() => mutateUpkeep(f.db, "different-root", { kind: "reserve", reservation: r })).toThrow();
  expect(() => f.mutate({ kind: "reserve", reservation: { ...r, logicalId: "other" } })).toThrow();
  const other = f.mutate({ kind: "inspect", scope: { logicalId: "fictional", conversationId: "fictional:next" } })!;
  expect(other.bootstrap).toBe(true); expect(other.incarnation).not.toBe(fence.incarnation);
});

it("stops at bounded operation capacity without discarding the bootstrap marker", () => {
  const f = memory(), r = reservation(f.claim("owner")); f.mutate({ kind: "reserve", reservation: r }); f.mutate({ kind: "dispatch", reservation: r });
  f.mutate({ kind: "outcome", reservation: r, receipt: receipt(r) });
  f.db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<16383)
    INSERT INTO continuity_upkeep_operations SELECT 'filled-'||x,'other','other','old',0,'old','{}','key','incremental','released',NULL FROM n`);
  expect(() => f.mutate({ kind: "reserve", reservation: { ...reservation(f.claim("new"), "new"), manifest: "b".repeat(64) } })).toThrow();
  expect(f.inspect().bootstrap).toBe(false);
  expect(f.db.prepare("SELECT count(*) n FROM continuity_upkeep_operations").get()).toMatchObject({ n: 16384 });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "upkeep-journal-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const writer = await ToolHistoryWriter.open({ root, continuityEnabled: true }); cleanups.push(() => writer.close());
  const reader = new ToolHistoryReader(root), generationId = continuityGenerationId(), digest = ledgerHash(generationId);
  await writer.prepareContinuity({ generationId, conversationId: "fictional", logicalConversationId: "fictional", beforeDigest: null, afterDigest: digest,
    records: [{ recordId: continuityRecordId("fictional", generationId), runId: "historical-run", inputId: "owner-input", kind: "owner", provenance: "host-owner", sequence: 0,
      text: "Never send without confirmation.", source: { attestation: { inputId: "owner-input", requestDigest: digest } } }] });
  await writer.commitContinuity({ generationId, conversationId: "fictional", canonicalDigest: digest });
  const db = new DatabaseSync(reader.databasePath); cleanups.push(() => db.close());
  const mutate = writer.mutateUpkeep.bind(writer);
  const inspect = async () => (await mutate({ kind: "inspect", scope: scopes }))!;
  const claim = async (ownerToken: string) => (await mutate({ kind: "claim", expected: await inspect(), ownerToken }))!;
  return { root, writer, reader, db, mutate, inspect, claim };
}
function harness(f: Awaited<ReturnType<typeof fixture>>, mutation = f.mutate, owner = async <T>(op: (token: string) => Promise<T>) => await op("owner")) {
  let fetches = 0;
  const complete = vi.fn(async (prompt, _signal, budget) => {
    fetches++;
    // Provider boundary stand-in: return only source-validated fictional data.
    const span = prompt.split("\n").map((line: string) => { try { return JSON.parse(line); } catch { return {}; } }).find((row: any) => row.id);
    const r = { operationId: budget.operationId, model: "fictional:base" } as UpkeepReservation;
    return { text: JSON.stringify({ entries: [{ kind: "constraint", value: "Require confirmation.", status: "active", sources: [span.id] }], covered: [span.id] }), receipt: receipt(r) };
  });
  const options = { toolHistory: { continuityEnabled: true, reader: f.reader, writer: f.writer, logicalConversationId: (id: string) => id,
    upkeep: { enabled: true, model: "fictional:base", recorderNamespace: "origin-recorder", complete }, mutateUpkeep: mutation,
    publishLedger: f.writer.publishLedger.bind(f.writer) } } as unknown as ConversationHarnessOptions;
  const events: any[] = [];
  return { complete, events, get fetches() { return fetches; }, prepare: async () => await createLedgerSupplier(options,
    { conversationId: "fictional", userMessage: "Current.", abortSignal: new AbortController().signal }, "origin-run").prepare(
    { sessionsEnabled: true, isolated: false, ownedStore: true, primaryAttempt: true, maxTokens: 8000, withOwner: owner }, "cold_rebuild", e => events.push(e)) };
}

it("keeps disabled upkeep entirely outside durable admission", async () => {
  const f = await fixture(), complete = vi.fn(), mutation = vi.fn(f.mutate);
  const options = { toolHistory: { continuityEnabled: true, reader: f.reader, writer: f.writer, logicalConversationId: (id: string) => id,
    upkeep: { enabled: false, complete }, mutateUpkeep: mutation } } as unknown as ConversationHarnessOptions;
  await createLedgerSupplier(options, { conversationId: "fictional", userMessage: "Current.", abortSignal: new AbortController().signal }, "current").prepare(
    { sessionsEnabled: true, isolated: false, ownedStore: true, primaryAttempt: true, maxTokens: 8000 }, "cold_rebuild", () => {});
  expect(complete).not.toHaveBeenCalled(); expect(mutation).not.toHaveBeenCalled();
  expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'continuity_upkeep_%'").all()).toEqual([]);
});

it("records outcome and origin identity before publication and before the receipt", async () => {
  const f = await fixture(), calls: string[] = [];
  const h = harness(f, async input => { const result = await f.mutate(input); calls.push(input.kind); return result; });
  const publish = vi.spyOn(f.writer, "publishLedger");
  // Production host publishes through the bound method, so inspect durable rows on read.
  vi.spyOn(f.reader, "ledger").mockImplementationOnce(() => undefined).mockImplementation(() => {
    const row = f.db.prepare("SELECT reservation,outcome,state FROM continuity_upkeep_operations").get() as any;
    if (row) { expect(row.state).toBe("terminal"); expect(JSON.parse(row.reservation)).toMatchObject({ runId: "origin-run", recorderNamespace: "origin-recorder", budget: "bootstrap" }); expect(JSON.parse(row.outcome).inputTokens).toBe(25); }
    return undefined;
  });
  await h.prepare(); expect(h.fetches).toBe(1); expect(h.complete.mock.calls[0]![2]).toMatchObject({ inputTokens: 128000 });
  expect(calls).toEqual(["inspect", "claim", "reserve", "dispatch", "outcome"]);
  expect(f.db.prepare("SELECT id FROM continuity_ledger").all()).toHaveLength(1);
  expect(h.events).toContainEqual(expect.objectContaining({ providerInvoked: true })); publish.mockRestore();
});

it("does not invoke after a committed barrier fails the canonical owner post-check", async () => {
  const f = await fixture(); let lost = false;
  const history = createDurableHistoryStore({ root: f.root, continuity: {} as never });
  const claims = (history as any).claims, acquire = claims.acquireLogicalConversation.bind(claims);
  vi.spyOn(claims, "acquireLogicalConversation").mockImplementation(async (...args) => {
    const held = await acquire(...args), assertOwned = held.assertOwned.bind(held);
    vi.spyOn(held, "assertOwned").mockImplementation(async () => { if (lost) throw new Error("owner_lost"); await assertOwned(); });
    return held;
  });
  const turn = await history.contextImport!.beginExclusiveTurn("fictional");
  const h = harness(f, async input => { const result = await f.mutate(input); if (input.kind === "dispatch") lost = true; return result; }, turn.withContinuityOwner!.bind(turn));
  try { await h.prepare(); } finally { lost = false; await turn.abort(); }
  expect(h.fetches).toBe(0); expect(h.complete).not.toHaveBeenCalled();
  expect((f.db.prepare("SELECT state,outcome FROM continuity_upkeep_operations").get() as any)).toMatchObject({ state: "dispatch_started", outcome: null });
  expect((await f.claim("recovery")).bootstrap).toBe(false);
});

it.each(["delay_execution", "delay_ack"])("a timed-out %s cannot invoke or defeat a new fence", async mode => {
  const f = await fixture(), internal = f.writer as any; let delayed: any;
  const post = internal.worker.postMessage.bind(internal.worker), response = internal.handleResponse.bind(internal);
  const h = harness(f, async input => {
    if (input.kind !== "dispatch") return await f.mutate(input);
    if (mode === "delay_execution") internal.worker.postMessage = (request: any) => { delayed = request; };
    else internal.handleResponse = (message: any) => { delayed = message; };
    try { return await internal.request("continuity_upkeep", input, 30); }
    finally { internal.worker.postMessage = post; internal.handleResponse = response; }
  });
  await h.prepare(); expect(h.fetches).toBe(0); expect(delayed).toBeDefined();
  const next = await f.claim("recovery"); expect(next.bootstrap).toBe(mode === "delay_execution");
  if (mode === "delay_execution") { post(delayed); await f.writer.stats(); }
  else response(delayed); // The timed-out waiter is gone; a late ack is not dispatch permission.
  expect(h.fetches).toBe(0);
  expect((f.db.prepare("SELECT state FROM continuity_upkeep_operations").get() as any).state).toBe(mode === "delay_execution" ? "released" : "dispatch_started");
});

it("keeps a lost terminal acknowledgement unknown rather than publishing or emitting zero usage", async () => {
  const f = await fixture();
  const h = harness(f, async input => { const result = await f.mutate(input); if (input.kind === "outcome") throw new Error("lost_ack"); return result; });
  await h.prepare(); expect(h.fetches).toBe(1);
  expect(h.events).toContainEqual(expect.objectContaining({ type: "continuity_upkeep", status: "uncertain", providerInvoked: true, costUsd: null, inputTokens: null }));
  expect(f.reader.ledger({ logicalConversationId: "fictional", currentConversationId: "fictional", currentRunId: "origin-run" })).toBeUndefined();
  const row = f.db.prepare("SELECT state,outcome FROM continuity_upkeep_operations").get() as any;
  expect(row.state).toBe("terminal"); expect(JSON.parse(row.outcome).costUsd).toBe(0.0002);
});

it("reset fences queued outcomes and publication while retention purge keeps bootstrap consumed", async () => {
  const f = await fixture(), old = reservation(await f.claim("owner")); await f.mutate({ kind: "reserve", reservation: old }); await f.mutate({ kind: "dispatch", reservation: old });
  persistContinuityPurge(f.root, { scope: "physical", conversationId: "fictional" }); await f.writer.stats();
  expect((await f.inspect()).bootstrap).toBe(false);
  persistContinuityPurge(f.root, { scope: "physical", conversationId: "fictional", resetUpkeep: true }); await f.writer.stats();
  expect((await f.inspect()).bootstrap).toBe(true);
  await expect(f.mutate({ kind: "outcome", reservation: old, receipt: receipt(old) })).rejects.toThrow();
  await expect(f.writer.publishLedger({ id: "old", conversationId: "fictional", logicalId: "fictional", parent: null, manifest: old.manifest, inputs: [], entries: [], spans: [], coveredOwners: [], uncovered: 0 }, old)).rejects.toThrow();
});

// Literal fixture URLs keep the spawned children visible to the dead-code scan.
const CRASH_CHILD = new URL("./fixtures/upkeep-crash-child.mjs", import.meta.url);
const SUPPLIER_CRASH_CHILD = new URL("./fixtures/upkeep-supplier-crash-child.mjs", import.meta.url);

async function child(root: string, phase: string, fixture: URL = CRASH_CHILD, extra: string[] = []): Promise<{ process: ChildProcess; message: any; exit: Promise<unknown> }> {
  const process = spawn(globalThis.process.execPath, [fileURLToPath(fixture), root, phase, ...extra], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = ""; process.stderr!.on("data", data => { errors += data; });
  const exit = once(process, "exit");
  cleanups.push(async () => { if (process.exitCode === null && process.signalCode === null) { process.kill("SIGKILL"); await exit; } });
  const message = await Promise.race([once(process, "message").then(([message]) => message), exit.then(() => { throw new Error(`Child exited before checkpoint: ${errors}`); })]);
  return { process, message, exit };
}

it.each(["reserved", "dispatch_started", "provider_return", "outcome"])("recovers in a fresh process after death at %s without replaying the provider", async phase => {
  const root = await mkdtemp(join(tmpdir(), "upkeep-crash-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const first = await child(root, phase); expect(first.message.fetches).toBe(["provider_return", "outcome"].includes(phase) ? 1 : 0);
  // A live canonical owner is not reclaimable just because another waiter expired.
  const blocked = await child(root, "recover"); expect(blocked.message).toMatchObject({ phase: "owner_busy", fetches: 0 }); await blocked.exit;
  first.process.kill("SIGKILL"); await first.exit;
  const recovered = await child(root, "recover"); await recovered.exit;
  expect(recovered.message.fetches).toBe(0); expect(recovered.message.bootstrap).toBe(phase === "reserved");
  expect(recovered.message.bootstrapRejected).toBe(phase !== "reserved");
  expect(recovered.message.incrementalRejected).toBe(["dispatch_started", "provider_return"].includes(phase));
  const [row] = recovered.message.rows; expect(row.state).toBe(phase === "reserved" ? "released" : phase === "outcome" ? "terminal" : "dispatch_started");
  expect(JSON.parse(row.reservation)).toMatchObject({ runId: "origin-run", recorderNamespace: "fictional-recorder", model: "fictional:base", budget: "bootstrap" });
  if (phase === "outcome") expect(JSON.parse(row.outcome)).toMatchObject({ costUsd: 0.0002, providerUsage: { input: 20, cacheRead: 5, cacheWrite: 0, output: 2 } });
  else expect(row.outcome).toBeNull(); // Unknown is not a zero-cost outcome.
}, 15000);

it("threads the bootstrap budget through selection, including prior and prompt overhead", async () => {
  const f = await fixture(), scope = { logicalConversationId: "fictional", currentConversationId: "fictional", currentRunId: "current" };
  const record = f.reader.snapshotContinuity(scope).records[0]!;
  const records = Array.from({ length: 30 }, (_, i) => { const text = `Fictional rule ${i}. ` + "neutral ".repeat(1500); return { ...record, recordId: `record-${i}`, ordinal: i, text, sha256: ledgerHash(text) }; });
  const source = { ...f.reader.snapshotContinuity(scope), records };
  const small = selectLedgerSources(source, undefined, 64000), large = selectLedgerSources(source, undefined, 128000);
  expect(large.spans.length).toBeGreaterThan(small.spans.length);
  expect(Buffer.byteLength(small.prompt) * 0.625 + 1024).toBeLessThan(64000);
  expect(Buffer.byteLength(large.prompt) * 0.625 + 1024).toBeLessThan(128000);
});

it.each(["dispatch_started", "provider_return"])("production supplier does not repurchase after SIGKILL at %s", async phase => {
  const directory = await mkdtemp(join(tmpdir(), "upkeep-supplier-crash-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "history"), counter = join(directory, "provider-calls");
  const first = await child(root, phase, SUPPLIER_CRASH_CHILD, [counter]);
  expect(first.message).toMatchObject({ phase, calls: 1 });
  const db = new DatabaseSync(join(root, "tool-history", "tool-lifecycles.sqlite"), { readOnly: true });
  expect(db.prepare("SELECT state,outcome FROM continuity_upkeep_operations").get()).toMatchObject({ state: "dispatch_started", outcome: null }); db.close();
  first.process.kill("SIGKILL"); await first.exit;
  for (let i = 0; i < 2; i++) {
    const recovered = await child(root, "recover", SUPPLIER_CRASH_CHILD, [counter]); await recovered.exit;
    expect(recovered.process.pid).not.toBe(first.process.pid);
    expect(recovered.message).toMatchObject({ calls: 1, published: false, operations: [{ state: "dispatch_started", outcome: null }] });
    expect(recovered.message.events).toContainEqual(expect.objectContaining({ type: "continuity_upkeep", providerInvoked: false, reason: "upkeep_repeat_suppressed" }));
    expect((await readFile(counter, "utf8")).trim().split("\n")).toEqual(["provider-call"]);
  }
}, 15000);

it("bounds UTF-8 journal bytes including future outcomes without rejecting identical reserve acknowledgements", () => {
  const f = memory(), r = reservation(f.claim("owner")); f.mutate({ kind: "reserve", reservation: r });
  f.db.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<234)
    INSERT INTO continuity_upkeep_operations SELECT printf('filler-%d',n),logical_id,conversation_id,incarnation,fence,owner_token,?,printf('selection-%d',n),budget,'released',NULL
    FROM continuity_upkeep_operations CROSS JOIN seq WHERE operation_id=?`).run("Ω".repeat(64000), r.operationId);
  expect(Number((f.db.prepare("SELECT sum(length(CAST(reservation AS BLOB))) n FROM continuity_upkeep_operations").get() as { n: number }).n)).toBeLessThan(32 * 1024 * 1024);
  expect(f.mutate({ kind: "reserve", reservation: r })).toBeNull();
  expect(() => f.mutate({ kind: "reserve", reservation: { ...r, operationId: "new-operation", manifest: "b".repeat(64) } })).toThrow("upkeep_admission_conflict");
});
