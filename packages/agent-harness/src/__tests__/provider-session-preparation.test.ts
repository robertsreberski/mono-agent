import { dirname } from "node:path";
import { copyFile, truncate, writeFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFrozenHandoffBudget } from "../durable-model-switch-contract.js";
function frozenBudget(f: Awaited<ReturnType<typeof fixture>>) { validateFrozenHandoffBudget(f.budget); return f.budget; }
import { createPendingInitialInput } from "../durable-turn-contract.js";
import { createDurableHistoryStore } from "../durable-history.js";
import { fixture, openStore, bucket } from "./fixtures/managed-native-switch-fixture.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const path = await mkdtemp(join(tmpdir(), "mono-prepared-owner-")); roots.push(path); return path; }
async function markers(path: string) { return (await readdir(join(path, ".locks"))).filter((name) => name.endsWith(".active")); }
function artifact(f: Awaited<ReturnType<typeof fixture>>) {
  return { version: 1, policy: "mono-handoff-v1",
    coverage: f.state.identity.sources.map(({ ordinal, epoch: _epoch, ...entry }) => ({ ...entry, epoch: ordinal })),
    summary: null, checkpoint: null, recent: [], ledger: [], retainedIds: [], producer: "checkpoint", timestamp: f.state.identity.timestamp,
    target: f.state.identity.targetProvenance, budget: f.budget };
}

it("holds only a claim, captures detached history and leaves the root available without incoming admission", async () => {
  const path = await root(), store = createDurableHistoryStore({ root: path });
  await store.append("fictional", [{ role: "user", content: "Original fictional context" }]);
  const before = (await readdir(path)).filter((name) => name.endsWith(".history.json"));
  const prep = await store.beginProviderSessionPreparation("fictional", "prepared");
  expect(await markers(path)).toHaveLength(1);
  expect((await readdir(join(path, ".locks"))).filter((name) => name.endsWith(".dirty.json"))).toEqual([]);
  const snapshot = await prep.read(); expect(snapshot.source.status).toBe("unsupported");
  (snapshot.history[0] as unknown as { content: string }).content = "Mutated caller copy";
  expect((await prep.read()).history[0]!.content).toBe("Original fictional context");
  await createDurableHistoryStore({ root: path }).append("unrelated", [{ role: "user", content: "Other owner continues" }]);
  expect(await readdir(path)).not.toContain(".native-history-root.json");
  await prep.abort(); await prep.abort(); expect(await markers(path)).toEqual([]);
  await expect(prep.read()).rejects.toThrow("no longer owned");
  expect((await readdir(path)).filter((name) => name.endsWith(".history.json"))).toHaveLength(before.length + 1);
});

it("transfers the same physical claim exactly once; preparation abort cannot release the admitted turn", async () => {
  const path = await root(), store = createDurableHistoryStore({ root: path });
  const prep = await store.beginProviderSessionPreparation("fictional", "prepared"); const original = await markers(path);
  const outcomes = await Promise.allSettled([prep.admit({ modelKey: "faux:A" }), prep.admit({ modelKey: "faux:A" })]);
  expect(outcomes[0].status).toBe("fulfilled"); expect(outcomes[1].status).toBe("rejected");
  if (outcomes[0].status !== "fulfilled") throw new Error("Expected admitted turn"); const turn = outcomes[0].value;
  expect(await markers(path)).toEqual(original); await turn.assertOwned();
  await prep.abort(); expect(await markers(path)).toEqual(original); await turn.assertOwned();
  const append = await turn.prepareCommit([{ role: "user", content: "Observed fictional input" }], { providerSessionSynced: true });
  await expect(turn.assertOwned()).rejects.toThrow("no longer owns"); await append.commit();
  expect(await markers(path)).toEqual([]); await turn.abort(); await prep.abort();
  expect(await store.load("fictional")).toEqual([{ role: "user", content: "Observed fictional input" }]);
  await expect(prep.assertOwned()).rejects.toThrow("no longer owned");
});

it("rejects a different model before any incoming fence or retirement, retaining the preparation for a ready binding", async () => {
  const path = await root(), retire = vi.fn(async () => {}), store = createDurableHistoryStore({ root: path, retireProviderSession: retire });
  const initial = await store.beginProviderSessionTurn("fictional", "first", { modelKey: "faux:A" });
  await (await initial.prepareCommit([], { providerSessionSynced: true })).commit();
  const prep = await store.beginProviderSessionPreparation("fictional", "prepared");
  await expect(prep.admit({ modelKey: "faux:B" })).rejects.toThrow("ready canonical model binding");
  expect(retire).not.toHaveBeenCalled(); await prep.assertOwned();
  expect((await readdir(join(path, ".locks"))).filter((name) => name.endsWith(".dirty.json"))).toEqual([]);
  const turn = await prep.admit({ modelKey: "faux:A" }); await turn.abort();
});

it("borrows authority/switch leases without reacquisition; child release does not release the preparation", async () => {
  const f = await fixture(await root()), prep = await f.store.beginProviderSessionPreparation(bucket, "prepared");
  const original = await markers(join(f.base, "history"));
  await expect(prep.acquireNativeHistoryAuthority({ exclusiveWriters: false } as never)).rejects.toThrow("exclusive upgraded writers");
  const authority = await prep.acquireNativeHistoryAuthority({ exclusiveWriters: true });
  if (authority.status !== "owned") throw new Error("Expected authority"); await authority.assertOwned(); await authority.release();
  await expect(authority.assertOwned()).rejects.toThrow("released"); await prep.assertOwned();
  const switchLease = await prep.beginModelSwitchStorage(f.state); if (switchLease.status !== "owned") throw new Error("Expected switch lease");
  expect(await markers(join(f.base, "history"))).toEqual(original); await switchLease.release();
  await expect(switchLease.read()).rejects.toThrow("released"); await prep.assertOwned();
  await expect(prep.admit({ modelKey: "faux:A" })).rejects.toThrow("pending");
  await prep.assertOwned(); expect(await readFile(f.nativePath)).toEqual(f.original);
  await prep.abort(); expect(await markers(join(f.base, "history"))).toEqual([]);
});

it("publishes a ready switch and admits B under the original owner without executable predecessor authority", async () => {
  const f = await fixture(await root()), prep = await f.store.beginProviderSessionPreparation(bucket, "prepared");
  const original = await markers(join(f.base, "history")), authority = await prep.acquireNativeHistoryAuthority({ exclusiveWriters: true });
  const lease = await prep.beginModelSwitchStorage(f.state); if (lease.status !== "owned") throw new Error("Expected switch lease");
  await lease.advanceUnfit(); const reference = await lease.accept(artifact(f));
  expect(await prep.rollForwardModelSwitch(f.state.identity.switchId, { exclusiveWriters: true })).toEqual({ status: "committed" });
  const snapshot = await prep.read(); expect(snapshot.native?.chain).toHaveLength(2); expect(snapshot.lastSwitch?.artifact).toEqual(reference);
  const turn = await prep.admit({ modelKey: "faux:B" }); expect(turn.modelKey).toBe("faux:B"); expect(turn.providerSessionRevision).toBe(0);
  expect(await markers(join(f.base, "history"))).toEqual(original); await prep.abort(); await turn.assertOwned();
  await expect(lease.read()).rejects.toThrow("no longer owned");
  if (authority.status === "owned") await expect(authority.assertOwned()).rejects.toThrow("no longer owned");
  await (await turn.prepareCommit([], { providerSessionSynced: true })).commit();
  const canonical = JSON.parse(await readFile(f.canonicalPath, "utf8")); expect(canonical.native.projection).toEqual(reference); expect(canonical.native.chain).toHaveLength(2);
  expect(await markers(join(f.base, "history"))).toEqual([]);
});

it("requires canonical ready publication before admission and refuses rotation back to the outgoing model", async () => {
  const f = await fixture(await root()), prep = await f.store.beginProviderSessionPreparation(bucket, "prepared");
  const lease = await prep.beginModelSwitchStorage(f.state); if (lease.status !== "owned") throw new Error("Expected lease");
  await lease.advanceUnfit(); await lease.accept(artifact(f));
  await expect(prep.admit({ modelKey: "faux:A" })).rejects.toThrow("pending");
  expect((await prep.read()).source).toMatchObject({ status: "supported", fromModelKey: "faux:A" });
  await prep.rollForwardModelSwitch(f.state.identity.switchId, { exclusiveWriters: true });
  await expect(prep.admit({ modelKey: "faux:A" })).rejects.toThrow("ready canonical model binding");
  expect((await prep.read()).source).toMatchObject({ status: "supported", fromModelKey: "faux:B" });
  const turn = await prep.admit({ modelKey: "faux:B" }); await turn.abort();
});

it("keeps native publication outside the root lock while retaining the prepared conversation claim", async () => {
  const f = await fixture(await root()), other = createDurableHistoryStore({ root: join(f.base, "history") }); let observed = false;
  const { store } = openStore(f.base, async (phase) => {
    if (phase !== "header_stage_created") return;
    await prep.assertOwned();
    const append = other.append("unrelated", [{ role: "user", content: "Independent owner" }]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([append, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Root held during native publication")), 3000); })]); }
    finally { clearTimeout(timer); }
    observed = true;
  });
  const prep = await store.beginProviderSessionPreparation(bucket, "prepared");
  try {
    const lease = await prep.beginModelSwitchStorage(f.state); if (lease.status !== "owned") throw new Error("Expected lease");
    await lease.advanceUnfit(); await lease.accept(artifact(f));
    expect(await prep.rollForwardModelSwitch(f.state.identity.switchId, { exclusiveWriters: true })).toEqual({ status: "committed" });
    expect(observed).toBe(true); await prep.assertOwned();
  } finally { await prep.abort(); }
});

it("refuses a foreign intent, overlong reconciled run and missing reconciliation capability without stranding ownership", async () => {
  const f = await fixture(await root()), prep = await f.store.beginProviderSessionPreparation(bucket, "prepared");
  await expect(prep.beginModelSwitchStorage({ ...f.state, identity: { ...f.state.identity, historyBucket: "foreign" } })).rejects.toThrow();
  await prep.assertOwned(); await prep.abort();
  const path = await root(), store = createDurableHistoryStore({ root: path });
  const invalid = await store.beginProviderSessionPreparation("fictional", "r".repeat(513));
  const binding = { modelKey: "faux:A", reconciliation: { ownerKey: "fictional", purpose: "execution" as const, initial: { persistText: "Fictional", timestamp: "2001-01-01T00:00:00Z" } } };
  await expect(invalid.admit(binding)).rejects.toThrow("512 bytes"); await invalid.assertOwned(); await invalid.abort();
  const failed = await store.beginProviderSessionPreparation("fictional", "prepared");
  await expect(failed.admit(binding)).rejects.toThrow("not configured");
  await failed.assertOwned(); expect(await markers(path)).toHaveLength(1);
  const turn = await failed.admit({ modelKey: "faux:A" }); await turn.assertOwned(); await turn.abort();
  expect(await markers(path)).toEqual([]); await failed.abort(); await expect(failed.read()).rejects.toThrow("no longer owned");
});

it("fails closed on claim-marker loss before transfer and cleans up after the failed preparation", async () => {
  const path = await root(), store = createDurableHistoryStore({ root: path }), prep = await store.beginProviderSessionPreparation("fictional", "prepared");
  const marker = (await markers(path))[0]!; await rm(join(path, ".locks", marker));
  await expect(prep.admit({ modelKey: "faux:A" })).rejects.toThrow();
  await expect(prep.assertOwned()).rejects.toThrow(); await prep.abort();
  expect((await readdir(join(path, ".locks"))).filter((name) => name.endsWith(".dirty.json"))).toEqual([]);
});

it("admits the existing reconciled P2 fence only after preparation and updates the exact decorated initial input under the transferred owner", async () => {
  const path = await root(), inspect = vi.fn(async () => ({ status: "absent" as const }));
  const store = createDurableHistoryStore({ root: path, reconcileProviderSessionTurn: inspect, retireProviderSession: async () => {} });
  const prep = await store.beginProviderSessionPreparation("fictional", "prepared"); const original = await markers(path);
  expect((await readdir(join(path, ".locks"))).filter((name) => name.endsWith(".dirty.json"))).toEqual([]);
  const turn = await prep.admit({ modelKey: "faux:A", reconciliation: { ownerKey: "fictional", purpose: "execution",
    initial: { persistText: "Fictional input", timestamp: "2001-01-01T00:00:00Z" } } });
  expect(await markers(path)).toEqual(original); expect(turn.reconciliation).toBeDefined();
  const id = turn.reconciliation!.descriptor.reconciliation!.initialInputId!;
  await turn.reconciliation!.admit(createPendingInitialInput({ id, persistText: "Fictional input", timestamp: "2001-01-01T00:00:00Z" }, "Frozen decorated fictional input"));
  const files = (await readdir(join(path, ".locks"))).filter((name) => name.endsWith(".dirty.json")); expect(files).toHaveLength(1);
  expect(JSON.parse(await readFile(join(path, ".locks", files[0]!), "utf8")).version).toBe(5);
  expect(inspect).not.toHaveBeenCalled(); await prep.abort(); await turn.assertOwned(); await turn.abort();
  expect(await markers(path)).toEqual([]); expect((await readdir(join(path, ".locks"))).filter((name) => name.endsWith(".dirty.json"))).toEqual(files);
});

it("snapshots the requested binding before queued admission can observe caller mutation", async () => {
  const path = await root(), store = createDurableHistoryStore({ root: path });
  const prep = await store.beginProviderSessionPreparation("fictional", "prepared");
  const binding = { modelKey: "faux:A" }, admitted = prep.admit(binding); binding.modelKey = "faux:B";
  const turn = await admitted; expect(turn.modelKey).toBe("faux:A"); await turn.abort();
});


it("queues abort behind a running admit without releasing the transferred claim", async () => {
  const path = await root();
  let releaseRetirement!: () => void, retirementStarted!: () => void;
  const paused = new Promise<void>((resolve) => { releaseRetirement = resolve; });
  const started = new Promise<void>((resolve) => { retirementStarted = resolve; });
  const store = createDurableHistoryStore({ root: path, maxMessages: 0,
    retireProviderSession: async () => { retirementStarted(); await paused; } });
  const first = await store.beginProviderSessionTurn("fictional", "first", { modelKey: "faux:A" });
  await (await first.prepareCommit([], { providerSessionSynced: true })).commit();
  const prep = await store.beginProviderSessionPreparation("fictional", "second"), original = await markers(path);
  const admitted = prep.admit({ modelKey: "faux:A" }); await started;
  let aborted = false; const abort = prep.abort().then(() => { aborted = true; });
  try {
    await Promise.resolve(); expect(aborted).toBe(false); expect(await markers(path)).toEqual(original);
  } finally { releaseRetirement(); }
  const turn = await admitted; await abort;
  expect(aborted).toBe(true); expect(await markers(path)).toEqual(original); await turn.assertOwned();
  await turn.abort(); expect(await markers(path)).toEqual([]);
});

it("cold-rotates an unbound record with committed revision instead of inventing native model ownership", async () => {
  const path = await root(), retire = vi.fn(async () => {});
  const store = createDurableHistoryStore({ root: path, retireProviderSession: retire });
  const first = await store.beginProviderSessionTurn("fictional", "first");
  await (await first.prepareCommit([{ role: "user", content: "Unbound fictional context" }], { providerSessionSynced: true })).commit();
  expect(await store.readProviderSessionBinding("fictional")).toEqual({ revision: 1 });
  const prep = await store.beginProviderSessionPreparation("fictional", "second"), original = await markers(path);
  const turn = await prep.admit({ modelKey: "faux:A" });
  expect(turn.previousModelWasUnbound).toBe(true); expect(turn.modelKey).toBe("faux:A");
  expect(turn.providerSessionRevision).toBe(0); expect(turn.providerSessionId).not.toBe(first.providerSessionId);
  expect(retire).toHaveBeenCalledWith(first.providerSessionId, undefined);
  expect(await markers(path)).toEqual(original); await turn.assertOwned(); await turn.abort();
});

it("keeps the same-model non-reusable cold-rotation rule under prepared admission", async () => {
  const path = await root(), retire = vi.fn(async () => {});
  const store = createDurableHistoryStore({ root: path, maxMessages: 0, retireProviderSession: retire });
  const first = await store.beginProviderSessionTurn("fictional", "first", { modelKey: "faux:A" });
  await (await first.prepareCommit([], { providerSessionSynced: true })).commit();
  const prep = await store.beginProviderSessionPreparation("fictional", "second");
  const turn = await prep.admit({ modelKey: "faux:A" });
  expect(turn.modelKey).toBe("faux:A"); expect(turn.providerSessionRevision).toBe(0);
  expect(turn.providerSessionId).not.toBe(first.providerSessionId);
  expect(retire).toHaveBeenCalledWith(first.providerSessionId, "faux:A"); await turn.assertOwned(); await turn.abort();
});

it("aborts directly after marker loss and releases the logical claim for the next owner", async () => {
  const path = await root(), store = createDurableHistoryStore({ root: path });
  const prep = await store.beginProviderSessionPreparation("fictional", "first");
  await rm(join(path, ".locks", (await markers(path))[0]!));
  await expect(prep.assertOwned()).rejects.toThrow(); await prep.abort(); await prep.abort();
  const next = await store.beginProviderSessionPreparation("fictional", "second");
  await next.assertOwned(); expect(await markers(path)).toHaveLength(1); await next.abort();
  expect(await markers(path)).toEqual([]);
});

it("persists the exact frozen budget before production and exposes detached pending state after reopening", async () => {
  const f = await fixture(await root()); f.state = { ...f.state, frozenBudget: structuredClone(frozenBudget(f)) };
  const prep = await f.store.beginProviderSessionPreparation(bucket, "budget"), lease = await prep.beginModelSwitchStorage(f.state);
  if (lease.status !== "owned") throw new Error("Expected switch"); await lease.admit("outgoing"); await prep.abort();
  const reopened = openStore(f.base).store, next = await reopened.beginProviderSessionPreparation(bucket, "next");
  const captured = await next.read(); expect(captured.pending?.frozenBudget).toEqual(f.budget);
  (captured.pending!.frozenBudget as unknown as { inputTokens: number }).inputTokens = 999;
  expect((await next.read()).pending?.frozenBudget).toEqual(f.budget); expect((await next.read()).pending?.attempts).toHaveLength(1);
  await next.abort(); expect(await readFile(f.nativePath)).toEqual(f.original);
});
it("reads accepted pending/current artifacts under the same claim without admission or inferred budgets", async () => {
  const f = await fixture(await root()); f.state = { ...f.state, frozenBudget: structuredClone(frozenBudget(f)) };
  const prep = await f.store.beginProviderSessionPreparation(bucket, "artifact"), lease = await prep.beginModelSwitchStorage(f.state);
  if (lease.status !== "owned") throw new Error("Expected switch"); await lease.advanceUnfit(); const reference = await lease.accept(artifact(f));
  const cached = await prep.readHandoff(f.state.identity.switchId, reference); expect(cached.budget).toEqual(f.budget); expect(cached.artifact).toEqual(artifact(f));
  (cached.budget as unknown as { inputTokens: number }).inputTokens = 999;
  expect((await prep.readHandoff(f.state.identity.switchId, reference)).budget).toEqual(f.budget);
  await expect(prep.readHandoff(f.state.identity.switchId, { id: "a".repeat(64), hash: "a".repeat(64) })).rejects.toThrow("accepted");
  await prep.rollForwardModelSwitch(f.state.identity.switchId, { exclusiveWriters: true });
  expect((await prep.readHandoff(f.state.identity.switchId, reference)).budget).toEqual(f.budget); await prep.abort();
  await expect(prep.readHandoff(f.state.identity.switchId, reference)).rejects.toThrow("no longer owned");
});
it("rejects changed frozen budget before intent publication and captures complete legacy evidence without inventing account ownership", async () => {
  const f = await fixture(await root()), prep = await f.store.beginProviderSessionPreparation(bucket, "capture");
  await expect(prep.beginModelSwitchStorage({ ...f.state, frozenBudget: { ...frozenBudget(f), inputTokens: 999 } })).rejects.toThrow();
  expect((await prep.read()).pending).toBeUndefined();
  const captured = await prep.captureNativeEvidence({ provider: "faux", model: "A", api: "faux-api", account: "not-legacy-proof" });
  expect(captured.sources[0]!.provenance.account).toBeNull(); expect(captured.view.segments[0]!.entries.length).toBeGreaterThan(0);
  expect(captured.view.segments[0]!.records.length).toBe(captured.sources[0]!.sourceSeq);
  expect(Object.isFrozen(captured.view.segments[0]!.records)).toBe(true); expect(await readFile(f.nativePath)).toEqual(f.original);
  await prep.abort();
});
it("captures the whole switched chain read-only and exposes typed pure handoff/native preparation", async () => {
  const f = await fixture(await root()), prep = await f.store.beginProviderSessionPreparation(bucket, "whole-chain"), lease = await prep.beginModelSwitchStorage(f.state);
  if (lease.status !== "owned") throw new Error("Expected switch"); await lease.advanceUnfit(); await lease.accept(artifact(f));
  await prep.rollForwardModelSwitch(f.state.identity.switchId, { exclusiveWriters: true });
  const captured = await prep.captureNativeEvidence({ provider: "faux", model: "B", api: "faux-api", account: "unproven" });
  expect(captured.sources).toHaveLength(2); expect(captured.view.segments).toHaveLength(2);
  const options = { target: f.state.identity.targetProvenance, budget: frozenBudget(f), timestamp: 17, hostContext: { systemPrompt: "Fictional rules", tools: [] } };
  expect(f.native.prepareHandoff(captured.view, options).status).toBe("prepared");
  const proposal = f.native.buildHandoff(captured.view, options); expect(proposal.status).toBe("ready"); expect(JSON.stringify(proposal)).toContain("Fictional source fact");
  expect(f.native.projectChain(captured.view, options)).toMatchObject({ status: "handoff_required", reason: "unknown_account" });
  expect(() => f.native.prepareHandoff(structuredClone(captured.view), options)).toThrow("unvalidated view");
  const tiny = f.native.createBudget({ contextWindow: 20000, inputTokens: 100, outputReserve: 4096, hostContext: options.hostContext });
  expect(f.native.prepareHandoff(captured.view, { ...options, budget: tiny })).toMatchObject({ status: "budget_failure" });
  await prep.abort();
});
it("captures and projects composed checkpoints whose exact inherited prefix predates the switch reference frame", async () => {
  const f = await fixture(await root()), prep = await f.store.beginProviderSessionPreparation(bucket, "composed"), lease = await prep.beginModelSwitchStorage(f.state);
  if (lease.status !== "owned") throw new Error("Expected switch"); await lease.advanceUnfit(); await lease.accept(artifact(f));
  await prep.rollForwardModelSwitch(f.state.identity.switchId, { exclusiveWriters: true });
  const snapshot = await prep.read();
  const { JsonlSessionRepo } = await import("@mono-agent/harness/session-store.js"), repo = new JsonlSessionRepo({ sessionsRoot: join(f.base, "native") });
  const metadata = (await repo.list()).find((entry) => entry.id === snapshot.native!.chain.at(-1)!.handleId)!;
  const current = await repo.open(metadata); current.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: snapshot.native!.authority });
  await current.appendCompaction({ summary: "Fictional inherited checkpoint", tokensBefore: 10, retainedTail: [] }, { version: 1,
    sources: f.state.identity.sources.map(({ journalId, sourceTipId, sourceSeq, sourceDigest }) => ({ journalId, sourceTipId, sourceSeq, sourceDigest })) }, { sourceTipId: current.tip, sourceSeq: current.seq });
  await current.sync(); await current.close(); await repo.close();
  const captured = await prep.captureNativeEvidence({ provider: "faux", model: "B", api: "faux-api", account: null });
  expect(captured.view.segments[1]!.entries.at(-1)?.type).toBe("compaction");
  const options = { target: f.state.identity.targetProvenance, budget: frozenBudget(f), timestamp: 17, hostContext: { systemPrompt: "Fictional rules", tools: [] } };
  expect(f.native.buildHandoff(captured.view, options).status).toBe("ready");
  const { createEvidenceView } = await import("@mono-agent/harness");
  const positive = createEvidenceView({ ownerKey: bucket, historyBucket: bucket, segments: captured.view.segments.map((segment) => ({ ...segment,
    descriptor: { ...segment.descriptor, provenance: { ...segment.descriptor.provenance, account: "fictional-positive-account" } } })) });
  const projected = f.native.projectChain(positive, { ...options, target: { ...options.target, account: "fictional-positive-account" } });
  expect(projected.status).toBe("ready"); expect(JSON.stringify(projected)).toContain("Fictional inherited checkpoint");
  const { evidenceDigest } = await import("@mono-agent/harness");
  const forged = JSON.parse(JSON.stringify(captured.view));
  forged.segments[1].records.find((record: { kind: string }) => record.kind === "compaction").payload.compaction.checkpoint.inheritedCoverage.sources[0].sourceDigest = "0".repeat(64);
  forged.segments[1].descriptor.sourceDigest = evidenceDigest(forged.segments[1].records);
  expect(() => createEvidenceView(forged)).toThrow("composed coverage");
  await prep.abort();
});


it("capture rejects excess chain count and aggregate/single journal bytes before allocating or scanning records", async () => {
  const f = await fixture(await root()), prep = await f.store.beginProviderSessionPreparation(bucket, "bounded-capture");
  const captured = await prep.captureNativeEvidence({ provider: "faux", model: "A", api: "faux-api", account: null });
  const source = captured.sources[0]!;
  const context = { ownerKey: source.ownerKey, historyBucket: source.historyBucket, assertOwned: () => prep.assertOwned() };
  const { JournalReader } = await import("@mono-agent/harness/journal-reader.js"); const scan = vi.spyOn(JournalReader.prototype, "scan");
  await expect(f.native.captureEvidence(Array.from({ length: 33 }, () => source), context)).rejects.toThrow("journal/chain limit");
  await truncate(f.nativePath, 16 * 1024 * 1024 + 1);
  await expect(f.native.captureEvidence([source], context)).rejects.toThrow("journal/chain limit");
  await truncate(f.nativePath, 8 * 1024 * 1024 + 1);
  const extra = join(dirname(f.nativePath), "fictional-extra.jsonl"); await copyFile(f.nativePath, extra);
  await expect(f.native.captureEvidence([source, { ...source, ordinal: 1, predecessorJournalId: source.journalId, journalId: "fictional-extra" }], context)).rejects.toThrow("journal/chain limit");
  expect(scan).not.toHaveBeenCalled(); scan.mockRestore();
  await writeFile(f.nativePath, f.original);
  const original = JournalReader.prototype.scan;
  const growing = vi.spyOn(JournalReader.prototype, "scan").mockImplementation(async function (this: typeof JournalReader.prototype, visit, options) {
    await truncate(f.nativePath, 16 * 1024 * 1024 + 1); return original.call(this, visit, options);
  });
  await expect(f.native.captureEvidence([source], context)).rejects.toMatchObject({ code: "ERR_NATIVE_EVIDENCE_CAPTURE_LIMIT" });
  expect(growing).toHaveBeenCalledOnce(); growing.mockRestore(); await prep.abort();
});
