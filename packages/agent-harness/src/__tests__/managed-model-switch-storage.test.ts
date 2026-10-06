import { afterEach, expect, it, vi } from "vitest";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createDurableHistoryStore } from "../durable-history.js";
import { createModelSwitchState } from "../model-switch-billing.js";
import { MODEL_SWITCH_DIRECTORY, switchDigest, switchConversationKey } from "../durable-model-switch-contract.js";
import type { ModelSwitchState } from "../durable-model-switch-contract.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const bucket = "fictional-conversation";
async function fixture(maxStoreBytes = 1024 * 1024, maxStagedBytes = 1024 * 1024) {
  const root = await mkdtemp(join(tmpdir(), "managed-switch-storage-")); roots.push(root);
  const retire = vi.fn(async () => {});
  const store = createDurableHistoryStore({ root, maxStoreBytes, maxStagedBytes, retireProviderSession: retire });
  const turn = await store.beginProviderSessionTurn(bucket, "fictional-source-turn", { modelKey: "faux:A" });
  const prepared = await turn.prepareCommit([{ role: "user", content: "Fictional retained history", timestamp: "1990-05-17T00:00:00.000Z" }], { providerSessionSynced: true }); await prepared.commit();
  const source = await store.modelSwitchStorageSource(bucket); if (source.status !== "supported") throw new Error("Expected supported source");
  const budget = { policy: "mono-handoff-v1", contextWindow: 100000, hostCap: 16384, inputTokens: 100, outputReserve: 2000, safety: 5000, historyAllowance: 76516, hostContextDigest: "4".repeat(64) };
  const descriptor = { journalId: "fictional-journal", epoch: source.sourceEpoch, ordinal: 0, handleId: turn.providerSessionId, predecessorJournalId: null,
    ownerKey: source.ownerKey, historyBucket: bucket, sourceTipId: "fictional-tip", sourceSeq: 4, sourceDigest: "3".repeat(64), provenance: { provider: "faux", api: "faux-api", model: "A", account: null } };
  const state = createModelSwitchState({ ownerKey: source.ownerKey, historyBucket: bucket, sourceCanonicalDigest: source.sourceCanonicalDigest, sourceRevision: source.sourceRevision, sources: [descriptor],
    fromModelKey: source.fromModelKey, toModelKey: "faux:B", targetProvenance: { provider: "faux", api: "faux-api", model: "B", account: null }, targetEpoch: "5".repeat(64), projectionPolicy: "mono-handoff-v1", timestamp: 17, frozenBudgetDigest: switchDigest(budget) },
    { canonicalBytes: 8192, artifactBytes: 32768, retainedNativeBytes: 16384, headerCopyBytes: 16384, pendingBytes: 65536 });
  return { root, store, retire, state, budget };
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
  expect((await store.stats()).bytes).toBeGreaterThan(before.bytes + Object.values(state.reservation).reduce((sum, value) => sum + value, 0));
  const low = createDurableHistoryStore({ root, maxStoreBytes: before.bytes + 1024, maxStagedBytes: 1024, retireProviderSession: async () => {} });
  await expect(low.append("fictional-other", [{ role: "user", content: "Too little capacity", timestamp: "1990-05-17T00:00:00.000Z" }])).rejects.toThrow();
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
  await expect(store.append(bucket, [{ role: "user", content: "No mutation", timestamp: "1990-05-17T00:00:00.000Z" }])).rejects.toThrow("pending");
  await expect(store.reset(bucket)).rejects.toThrow("pending"); expect(retire).not.toHaveBeenCalled(); expect(await store.load(bucket)).toHaveLength(1);
});
it("treats long IDs as unsupported storage, preserving today's cold-epoch replay behavior", async () => {
  const { store, state } = await fixture(); const id = "fictional-" + "x".repeat(513);
  const turn = await store.beginProviderSessionTurn(id, "fictional-long-A", { modelKey: "faux:A" });
  const prepared = await turn.prepareCommit([{ role: "user", content: "Retained fictional long-id history", timestamp: "1990-05-17T00:00:00.000Z" }], { providerSessionSynced: true }); await prepared.commit();
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
