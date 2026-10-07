import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
