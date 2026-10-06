import { afterEach, expect, it, vi } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createDurableHistoryStore } from "../durable-history.js";
import { createModelSwitchState } from "../model-switch-billing.js";
import { MODEL_SWITCH_DIRECTORY, reservationBytes, switchDigest, switchConversationKey } from "../durable-model-switch-contract.js";
import { ModelSwitchPayloadStore } from "../model-switch-payloads.js";
import type { ModelSwitchState } from "../durable-model-switch-contract.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const bucket = "fictional-conversation";
async function fixture(maxStoreBytes = 1024 * 1024, maxStagedBytes = 1024 * 1024, historyBucket = bucket) {
  const root = await mkdtemp(join(tmpdir(), "managed-switch-storage-")); roots.push(root);
  const retire = vi.fn(async () => {});
  const store = createDurableHistoryStore({ root, maxStoreBytes, maxStagedBytes, retireProviderSession: retire });
  const turn = await store.beginProviderSessionTurn(historyBucket, "fictional-source-turn", { modelKey: "faux:A" });
  const fencePath = join(root, ".locks", `${switchConversationKey(historyBucket)}.dirty.json`);
  const sourceFence = JSON.parse(await readFile(fencePath, "utf8"));
  const prepared = await turn.prepareCommit([{ role: "user", content: "Fictional retained history", timestamp: "2000-01-01T00:00:00.000Z" }], { providerSessionSynced: true }); await prepared.commit();
  const source = await store.modelSwitchStorageSource(historyBucket); if (source.status !== "supported") throw new Error("Expected supported source");
  const budget = { policy: "mono-handoff-v1", contextWindow: 100000, hostCap: 16384, inputTokens: 100, outputReserve: 2000, safety: 5000, historyAllowance: 76516, hostContextDigest: "4".repeat(64) };
  const descriptor = { journalId: "fictional-journal", epoch: source.sourceEpoch, ordinal: 0, handleId: turn.providerSessionId, predecessorJournalId: null,
    ownerKey: source.ownerKey, historyBucket, sourceTipId: "fictional-tip", sourceSeq: 4, sourceDigest: "3".repeat(64), provenance: { provider: "faux", api: "faux-api", model: "A", account: null } };
  const state = createModelSwitchState({ ownerKey: source.ownerKey, historyBucket, sourceCanonicalDigest: source.sourceCanonicalDigest, sourceRevision: source.sourceRevision, sources: [descriptor],
    fromModelKey: source.fromModelKey, toModelKey: "faux:B", targetProvenance: { provider: "faux", api: "faux-api", model: "B", account: null }, targetEpoch: "5".repeat(64), projectionPolicy: "mono-handoff-v1", timestamp: 17, frozenBudgetDigest: switchDigest(budget) },
    { canonicalBytes: 8192, artifactBytes: 32768, retainedNativeBytes: 16384, headerCopyBytes: 16384, pendingBytes: 65536 });
  return { root, store, retire, state, budget, sourceFence, fencePath };
}
function artifact(state: ModelSwitchState, budget: unknown) {
  return { version: 1, policy: "mono-handoff-v1", coverage: state.identity.sources.map(({ ordinal, epoch: _epoch, ...entry }) => ({ ...entry, epoch: ordinal })),
    summary: null, checkpoint: null, recent: [], ledger: [], retainedIds: [], producer: "checkpoint", timestamp: 17, target: state.identity.targetProvenance, budget };
}
it("holds the real managed owner while storage operations borrow short root transactions", async () => {
  const { root, store, state, budget } = await fixture();
  const before = await readFile(join(root, `${switchConversationKey(bucket)}.history.json`));
  const lease = await store.beginModelSwitchStorage(state); if (lease.status !== "owned") throw new Error("Expected owned lease");
  expect((await store.stats()).activePreparedAppends).toBe(1);
  await lease.advanceUnfit(); const reference = await lease.accept(artifact(state, budget));
  expect(await lease.recoverArtifact()).toEqual(reference);
  expect(await readFile(join(root, `${switchConversationKey(bucket)}.history.json`))).toEqual(before); // no model binding or dispatch here
  await lease.release(); await expect(lease.read()).rejects.toThrow("released");
  expect((await store.stats()).activePreparedAppends).toBe(0);
  const reopened = await store.beginModelSwitchStorage(state); if (reopened.status !== "owned") throw new Error("Expected replay lease");
  expect(await reopened.recoverArtifact()).toEqual(reference); await reopened.release();
});
it("charges real model storage and remaining durable plans without quota-deleting protected owners", async () => {
  const { root, store, state } = await fixture(); const before = await store.stats();
  const lease = await store.beginModelSwitchStorage(state); if (lease.status !== "owned") throw new Error("Expected owned lease"); await lease.release();
  const inventory = await new ModelSwitchPayloadStore(root, await lstat(root)).inventory();
  const stats = await store.stats();
  expect(stats.bytes).toBe(before.bytes + inventory.bytes);
  expect(stats.reservedBytes).toBe(reservationBytes(state.reservation) - inventory.bytes);
  // Exactly the durable plan fits: state/fence publication is not charged twice.
  const exact = createDurableHistoryStore({ root, maxStoreBytes: before.bytes + reservationBytes(state.reservation), maxStagedBytes: reservationBytes(state.reservation), retireProviderSession: async () => {} });
  const replay = await exact.beginModelSwitchStorage(state); if (replay.status !== "owned") throw new Error("Expected exact-capacity replay");
  await replay.admit("outgoing"); await replay.release();
  expect((await exact.stats()).bytes + (await exact.stats()).reservedBytes).toBe(before.bytes + reservationBytes(state.reservation));
  const low = createDurableHistoryStore({ root, maxStoreBytes: before.bytes + 1024, maxStagedBytes: 1024, retireProviderSession: async () => {} });
  await expect(low.append("fictional-other", [{ role: "user", content: "Too little capacity", timestamp: "2000-01-01T00:00:00.000Z" }])).rejects.toThrow();
  expect(await store.load(bucket)).toHaveLength(1); expect((await readdir(join(root, MODEL_SWITCH_DIRECTORY))).length).toBe(2);
});
it("refuses initial aggregate/header-copy space before creating any intent", async () => {
  const { root, store, state, retire } = await fixture(); const before = await readFile(join(root, `${switchConversationKey(bucket)}.history.json`));
  const low = createDurableHistoryStore({ root, maxStoreBytes: 1024, maxStagedBytes: 1024, retireProviderSession: retire });
  await expect(low.beginModelSwitchStorage(state)).rejects.toThrow("capacity");
  expect(await readdir(root)).not.toContain(MODEL_SWITCH_DIRECTORY); expect(await readFile(join(root, `${switchConversationKey(bucket)}.history.json`))).toEqual(before); expect(retire).not.toHaveBeenCalled();
});
it("blocks ordinary admission, append and reset before retirement while a durable switch intent exists", async () => {
  const { store, state, retire } = await fixture(); const lease = await store.beginModelSwitchStorage(state); if (lease.status !== "owned") throw new Error("Expected owned lease"); await lease.release();
  await expect(store.beginProviderSessionTurn(bucket, "fictional-next", { modelKey: "faux:B" })).rejects.toThrow("pending");
  await expect(store.append(bucket, [{ role: "user", content: "No mutation", timestamp: "2000-01-01T00:00:00.000Z" }])).rejects.toThrow("pending");
  await expect(store.reset(bucket)).rejects.toThrow("pending"); expect(retire).not.toHaveBeenCalled(); expect(await store.load(bucket)).toHaveLength(1);
});
it("treats long IDs as unsupported storage, preserving today's cold-epoch replay behavior", async () => {
  const { store, state } = await fixture(); const id = "fictional-" + "x".repeat(513);
  const turn = await store.beginProviderSessionTurn(id, "fictional-long-A", { modelKey: "faux:A" });
  const prepared = await turn.prepareCommit([{ role: "user", content: "Retained fictional long-id history", timestamp: "2000-01-01T00:00:00.000Z" }], { providerSessionSynced: true }); await prepared.commit();
  expect(await store.modelSwitchStorageSource(id)).toEqual({ status: "unsupported", reason: "id_limit" });
  expect(await store.beginModelSwitchStorage({ ...state, identity: { ...state.identity, historyBucket: id, ownerKey: id } })).toEqual({ status: "unsupported", reason: "id_limit" });
  const cold = await store.beginProviderSessionTurn(id, "fictional-long-B", { modelKey: "faux:B" }); expect(cold.providerSessionId).not.toBe(turn.providerSessionId); expect(cold.providerSessionRevision).toBe(0);
  expect(await store.load(id)).toHaveLength(1); await cold.abort();
});
it("root enumeration accepts only private owned model storage and preserves malformed evidence", async () => {
  const { root, store, state } = await fixture(); expect((await lstat(root)).mode & 0o777).toBe(0o700);
  const lease = await store.beginModelSwitchStorage(state); if (lease.status !== "owned") throw new Error("Expected owned lease"); await lease.release();
  const directory = join(root, MODEL_SWITCH_DIRECTORY); await chmod(directory, 0o755); await expect(store.stats()).rejects.toThrow("permissions"); await chmod(directory, 0o700);
  await writeFile(join(directory, "unknown-evidence"), "Preserved fictional evidence", { mode: 0o600 }); await expect(store.stats()).rejects.toThrow("unavailable");
  expect(await readFile(join(directory, "unknown-evidence"), "utf8")).toBe("Preserved fictional evidence");
});


function withIdentity(state: ModelSwitchState, changes: Partial<ModelSwitchState["identity"]>) {
  const { switchId: _switchId, ...identity } = state.identity;
  const next = { ...identity, ...changes };
  return createModelSwitchState({ ...next, sources: next.sources.map((source) => ({ ...source, ownerKey: next.ownerKey, historyBucket: next.historyBucket })) }, state.reservation);
}
it("rejects unnormalized buckets and mismatched logical owners before acquiring or publishing", async () => {
  const { root, store, state, retire } = await fixture();
  for (const changed of [{ historyBucket: ` ${bucket} ` }, { ownerKey: "fictional-foreign-owner" }]) {
    await expect(store.beginModelSwitchStorage(withIdentity(state, changed))).rejects.toThrow("normalized");
  }
  expect(await readdir(root)).not.toContain(MODEL_SWITCH_DIRECTORY);
  expect(retire).not.toHaveBeenCalled(); expect((await store.stats()).activePreparedAppends).toBe(0);
  await store.append(bucket, [{ role: "assistant", content: "Still writable" }]);
});
it("inventories pending switches only inside the root transaction on ordinary mutation paths", async () => {
  const { store } = await fixture();
  const internal = store as any;
  const acquire = internal.acquireRootTransaction.bind(store);
  const inventory = ModelSwitchPayloadStore.prototype.inventory;
  let held = 0, checks = 0;
  const rootSpy = vi.spyOn(internal, "acquireRootTransaction").mockImplementation(async (...args: unknown[]) => {
    const release = await acquire(...args); held++;
    return async () => { try { await release(); } finally { held--; } };
  });
  const inventorySpy = vi.spyOn(ModelSwitchPayloadStore.prototype, "inventory").mockImplementation(async function (this: ModelSwitchPayloadStore) {
    expect(held).toBeGreaterThan(0); checks++; return inventory.call(this);
  });
  try {
    await store.append(bucket, [{ role: "assistant", content: "Fictional mutation" }]);
    const turn = await store.beginProviderSessionTurn(bucket, "fictional-transaction", { modelKey: "faux:A" });
    await (await turn.prepareCommit([], { providerSessionSynced: true })).commit();
    await store.reset(bucket);
    await store.resetLogicalConversation(bucket);
    expect(checks).toBeGreaterThan(5); expect(held).toBe(0);
  } finally { rootSpy.mockRestore(); inventorySpy.mockRestore(); }
});
it("prechecks every logical sibling before resetting any pending-switch owner", async () => {
  const logical = "fictional-logical";
  const { root, store, state, retire } = await fixture(undefined, undefined, `${logical}#2026-08-14`);
  await store.append(logical, [{ role: "user", content: "Fictional base" }]);
  await store.append(`${logical}#2026-08-13`, [{ role: "user", content: "Fictional earlier sibling" }]);
  const lease = await store.beginModelSwitchStorage(state); if (lease.status !== "owned") throw new Error("Expected owner"); await lease.release();
  const ids = [logical, `${logical}#2026-08-13`, state.identity.historyBucket];
  const before = await Promise.all(ids.map((id) => readFile(join(root, `${switchConversationKey(id)}.history.json`))));
  retire.mockClear();
  await expect(store.resetLogicalConversation(logical)).rejects.toThrow("pending");
  expect(await Promise.all(ids.map((id) => readFile(join(root, `${switchConversationKey(id)}.history.json`))))).toEqual(before);
  expect(retire).not.toHaveBeenCalled();
});
it("preserves inactive retirement fences for pending switch buckets", async () => {
  const { root, store, state, retire, sourceFence, fencePath } = await fixture();
  const before = await readFile(join(root, `${switchConversationKey(bucket)}.history.json`));
  const lease = await store.beginModelSwitchStorage(state); if (lease.status !== "owned") throw new Error("Expected owner"); await lease.release();
  await writeFile(fencePath, JSON.stringify({ ...sourceFence, revision: 1 }), { mode: 0o600 });
  const fenceBefore = await readFile(fencePath);
  const exclusive = await (store as any).beginExclusiveTurn("fictional-unrelated"); await exclusive.abort();
  expect(retire).not.toHaveBeenCalled(); expect(await readFile(fencePath)).toEqual(fenceBefore);
  expect(await readFile(join(root, `${switchConversationKey(bucket)}.history.json`))).toEqual(before);
});
it("requires the provider fence to remain settled when the switch root transaction starts", async () => {
  const { root, store, state, sourceFence, fencePath } = await fixture();
  // Simulate settlement returning just before discovering an unresolved fence.
  const settlement = vi.spyOn(store as any, "settleHeldTurn").mockResolvedValue({ status: "clean" });
  try {
    await writeFile(fencePath, JSON.stringify({ ...sourceFence, version: 5, kind: "execution", payload: { generation: "0".repeat(32), sha256: "0".repeat(64) } }), { mode: 0o600 });
    await expect(store.beginModelSwitchStorage(state)).rejects.toThrow("Pending provider turn requires explicit owner-held reconciliation");
    expect(await readdir(root)).not.toContain(MODEL_SWITCH_DIRECTORY);
  } finally { settlement.mockRestore(); }
});

it("recovers the real logical/physical owner and admission twice after SIGKILL without refund or native deletion", async () => {
  const { root, state } = await fixture();
  const stateDirectory = await mkdtemp(join(tmpdir(), "managed-switch-coordinates-")); roots.push(stateDirectory);
  const statePath = join(stateDirectory, "fixture-state.json"); await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  const run = async (action: string) => {
    const child = fork(new URL("./fixtures/managed-switch-storage-worker.mjs", import.meta.url), [root, action, statePath], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: ["--no-warnings"] });
    let stderr = ""; child.stderr!.on("data", (data) => { stderr += data; }); const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    try {
      const result: any = await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", (code) => reject(new Error(`Worker exited ${code}: ${stderr}`))); });
      expect(result.error).toBeUndefined(); const exit = once(child, "exit"); if (action === "admit") { expect(result.phase).toBe("admitted"); child.kill("SIGKILL"); }
      const [code, signal] = await exit; expect(action === "admit" ? signal : code).toBe(action === "admit" ? "SIGKILL" : 0); return result;
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  };
  await run("admit"); const first = await run("recover"), second = await run("recover");
  expect(first.refused).toBe(true); expect(second.refused).toBe(true); expect(first.state.attempts).toHaveLength(1);
  expect(second.state).toEqual(first.state); expect(second.bytes).toBe(first.bytes); expect(first.files).toHaveLength(2);
}, 30000);

for (const phase of ["payload_renamed", "fence_renamed", "fence_directory_synced", "obsolete_state_removed", "reservation_adjusted"]) {
  it(`recovers managed publication twice in fresh processes after SIGKILL at ${phase}`, async () => {
    const { root, state, store, retire } = await fixture();
    const canonicalBytes = (await store.stats()).bytes;
    const coordinates = await mkdtemp(join(tmpdir(), "managed-switch-crash-")); roots.push(coordinates);
    const statePath = join(coordinates, "fixture-state.json"); await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
    const run = async (action: "admit" | "recover") => {
      const child = fork(new URL("./fixtures/managed-switch-storage-worker.mjs", import.meta.url), [root, action, statePath, ...(action === "admit" ? [phase] : [])], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: ["--no-warnings"] });
      let stderr = ""; child.stderr!.on("data", (data) => { stderr += data; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      try {
        const result: any = await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", (code) => reject(new Error(`Worker exited ${code}: ${stderr}`))); });
        expect(result.error).toBeUndefined(); const exit = once(child, "exit");
        if (action === "admit") { expect(result.phase).toBe(phase); child.kill("SIGKILL"); }
        const [code, signal] = await exit; expect(action === "admit" ? signal : code).toBe(action === "admit" ? "SIGKILL" : 0);
        return result;
      } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    };
    await run("admit"); const first = await run("recover"), second = await run("recover");
    expect(second).toEqual(first);
    if (phase === "payload_renamed") {
      expect(first.state.attempts).toHaveLength(0); expect(first.files).toHaveLength(3);
      const states = await Promise.all(first.files.filter((name: string) => name.endsWith(".state.json")).map(async (name: string) => JSON.parse(await readFile(join(root, MODEL_SWITCH_DIRECTORY, name), "utf8"))));
      expect(states.some((candidate) => candidate.attempts.length === 1)).toBe(true); // future admission preserved and charged
      const orphanBytes = (await Promise.all(first.files.filter((name: string) => name.endsWith(".state.json")).map(async (name: string) => {
        const bytes = await readFile(join(root, MODEL_SWITCH_DIRECTORY, name));
        return JSON.parse(bytes.toString()).attempts.length ? bytes.byteLength : 0;
      }))).reduce((sum, bytes) => sum + bytes, 0);
      expect(first.bytes + first.reservedBytes).toBe(canonicalBytes + reservationBytes(state.reservation) + orphanBytes);
    } else {
      expect(first.refused).toBe(true); expect(first.state.attempts).toHaveLength(1); expect(first.files).toHaveLength(2);
      expect(first.bytes + first.reservedBytes).toBe(canonicalBytes + reservationBytes(state.reservation));
    }
    expect((await store.stats()).bytes).toBe(first.bytes); expect(retire).not.toHaveBeenCalled();
  }, 30000);
}
