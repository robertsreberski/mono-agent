import { afterEach, expect, it, vi } from "vitest";
import { fork, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { lstat, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture, ready, openStore, bucket } from "./fixtures/managed-native-switch-fixture.mjs";
import { ModelSwitchPayloadStore } from "../model-switch-payloads.js";
import { JsonlSessionRepo } from "@mono-agent/harness/session-store.js";
import { boundedSwitchBytes, validateModelSwitchFence, switchConversationKey } from "../durable-model-switch-contract.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(id = bucket) {
  const root = await mkdtemp(join(tmpdir(), "mono-native-lifecycle-")); roots.push(root);
  const f = await fixture(root, id); await ready(f);
  await f.store.rollForwardModelSwitch(id, f.state.identity.switchId, { exclusiveWriters: true });
  const before = JSON.parse(await readFile(f.canonicalPath, "utf8"));
  return { ...f, before };
}
it("cold host append publishes an exact current replacement and reference-checks cleanup", async () => {
  const f = await setup(), predecessor = await readFile(f.nativePath);
  await f.store.append(bucket, [{ role: "assistant", content: "Fictional host-only update" }]);
  const after = JSON.parse(await readFile(f.canonicalPath, "utf8"));
  expect(after.version).toBe(4); expect(after.native.chain).toHaveLength(2);
  expect(after.native.chain[0]).toEqual(f.before.native.chain[0]);
  expect(after.native.chain[1].predecessorJournalId).toBe(after.native.chain[0].journalId);
  expect(after.native.chain[1].epoch).not.toBe(f.before.providerSession.epoch);
  expect(after.native.chain[1].epoch).toBe(after.providerSession.epoch);
  expect(after.lastSwitch).toEqual(f.before.lastSwitch);
  expect(await readFile(f.nativePath)).toEqual(predecessor);
  const names = await readdir(join(f.base, "native", "mono-v2", "journals"));
  expect(names).toHaveLength(2); expect(names).not.toContain(`${f.before.native.chain[1].journalId}.jsonl`);
  expect((await f.store.stats()).reservedBytes).toBe(0);
});
it("aborted prepared cold append does not create or delete native epochs", async () => {
  const f = await setup(), canonical = await readFile(f.canonicalPath), physical = await f.native.inventory();
  const prepared = await f.store.prepareAppend(bucket, [{ role: "assistant", content: "Uncommitted fictional update" }]);
  await prepared.abort(); expect(await readFile(f.canonicalPath)).toEqual(canonical); expect(await f.native.inventory()).toEqual(physical);
});
it("resets the entire owner chain and its switch artifacts before dropping membership", async () => {
  const f = await setup(); await f.store.reset(bucket);
  const after = JSON.parse(await readFile(f.canonicalPath, "utf8"));
  expect(after.version).toBe(3); expect(after.messages).toEqual([]); expect(after.native).toBeUndefined(); expect(after.lastSwitch).toBeUndefined();
  expect(await readdir(join(f.base, "native", "mono-v2", "journals"))).toEqual([]);
  expect(await readdir(join(f.base, "history", ".model-switches"))).toEqual([]);
  expect((await readdir(join(f.base, "history"))).some((name) => name.startsWith(".native-history-op."))).toBe(false);
});
it("retention deletes a whole inactive v4 victim without violating count quota", async () => {
  const f = await setup(), { store } = openStore(f.base, undefined, { maxConversations: 1 });
  await store.append("fictional-next-owner", [{ role: "assistant", content: "Fictional replacement" }]);
  expect((await store.stats()).conversations).toBe(1); expect(await store.load(bucket)).toEqual([]);
  expect(await readdir(join(f.base, "native", "mono-v2", "journals"))).toEqual([]);
  expect(await readdir(join(f.base, "history", ".model-switches"))).toEqual([]);
});
it("stale current admission cold-rotates only its own epoch, preserving predecessor evidence", async () => {
  const f = await setup(); const turn = await f.store.beginProviderSessionTurn(bucket, "fictional-aborted", { modelKey: "faux:B" }); await turn.abort();
  const next = await f.store.beginProviderSessionTurn(bucket, "fictional-next", { modelKey: "faux:B" }); await next.abort();
  const after = JSON.parse(await readFile(f.canonicalPath, "utf8"));
  expect(after.native.chain[0]).toEqual(f.before.native.chain[0]); expect(after.native.chain[1].epoch).not.toBe(f.before.providerSession.epoch);
  expect(await readdir(join(f.base, "native", "mono-v2", "journals"))).toHaveLength(2);
});
it("unsynced provider commit uses current-only C rather than deleting a predecessor", async () => {
  const f = await setup(); const turn = await f.store.beginProviderSessionTurn(bucket, "fictional-unsynced", { modelKey: "faux:B" });
  await (await turn.prepareCommit([{ role: "assistant", content: "Fictional canonical-only result" }], { providerSessionSynced: false })).commit();
  const after = JSON.parse(await readFile(f.canonicalPath, "utf8"));
  expect(after.native.chain[0]).toEqual(f.before.native.chain[0]); expect(after.providerSession.revision).toBe(0);
  expect(after.providerSession.epoch).not.toBe(f.before.providerSession.epoch); expect(await readdir(join(f.base, "native", "mono-v2", "journals"))).toHaveLength(2);
});
it("exclusive host mutation and empty-owner context import preserve predecessors", async () => {
  const f = await setup(); const exclusive = await f.store.contextImport!.beginExclusiveTurn(bucket);
  await (await exclusive.prepareCommit([{ role: "assistant", content: "Fictional exclusive update" }])).append.commit();
  let current = JSON.parse(await readFile(f.canonicalPath, "utf8")); expect(current.native.chain[0]).toEqual(f.before.native.chain[0]);
  current.messages = []; await writeFile(f.canonicalPath, JSON.stringify(current) + "\n", { mode: 0o600 });
  const imported = await f.store.contextImport!.prepareImport(bucket, { text: "Fictional import", idempotencyKey: "fictional-import", timestamp: "2030-01-01T00:00:00.000Z" });
  expect(imported.result.status).toBe("appended"); await imported.append!.commit();
  current = JSON.parse(await readFile(f.canonicalPath, "utf8")); expect(current.native.chain[0]).toEqual(f.before.native.chain[0]); expect(current.native.chain).toHaveLength(2);
});
it("cleans a resurrected completed switch fence after cold rotation without restoring obsolete B", async () => {
  const f = await setup(), directory = join(f.base, "history", ".model-switches"), names = await readdir(directory);
  const stateName = names.find((name) => name.endsWith(".state.json"))!, stateBytes = await readFile(join(directory, stateName));
  const { createHash } = await import("node:crypto");
  await f.store.append(bucket, [{ role: "assistant", content: "Fictional later update" }]); const before = await readFile(f.canonicalPath);
  const fence = { version: 6 as const, kind: "model-switch" as const, targetEpoch: f.state.identity.targetEpoch, conversationKey: switchConversationKey(bucket), switchId: f.state.identity.switchId,
    payload: { generation: stateName.split(".")[2]!, sha256: createHash("sha256").update(stateBytes).digest("hex") } };
  validateModelSwitchFence(fence);
  await writeFile(join(directory, `${switchConversationKey(bucket)}.${f.state.identity.switchId}.fence.json`), boundedSwitchBytes(fence, 1024), { mode: 0o600 });
  expect(await f.store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { exclusiveWriters: true })).toEqual({ status: "committed" });
  expect(await readFile(f.canonicalPath)).toEqual(before); expect(await readdir(join(f.base, "native", "mono-v2", "journals"))).toHaveLength(2);
});
it("logical reset deletes the v4 chain and leaves another logical owner untouched", async () => {
  const f = await setup(); await f.store.append("fictional-sibling-owner", [{ role: "assistant", content: "Fictional sibling" }]);
  await f.store.resetLogicalConversation(bucket); expect(await f.store.load("fictional-sibling-owner")).toHaveLength(1);
  expect(await readdir(join(f.base, "native", "mono-v2", "journals"))).toEqual([]);
  expect(await readdir(join(f.base, "history"))).toContain(".native-history-root.json");
});
it("settles a v4 absent native turn once into a cold epoch without replay", async () => {
  const f = await setup(); let inspections = 0;
  const { store } = openStore(f.base, undefined, { reconcileProviderSessionTurn: async () => { inspections++; return { status: "absent" }; } });
  const turn = await store.beginProviderSessionTurn(bucket, "fictional-interrupted-native", { modelKey: "faux:B", reconciliation: {
    purpose: "execution", ownerKey: bucket, initial: { persistText: "Fictional unanswered input", timestamp: "2030-01-01T00:00:00.000Z" } } });
  await turn.abort(); await store.recoverProviderSessionTurn(bucket); await store.recoverProviderSessionTurn(bucket);
  const current = JSON.parse(await readFile(f.canonicalPath, "utf8"));
  expect(inspections).toBe(1); expect(current.lastCommit.outcome).toBe("interrupted");
  expect(current.native.chain[0]).toEqual(f.before.native.chain[0]); expect(current.providerSession.epoch).not.toBe(f.before.providerSession.epoch);
  expect(current.messages.filter((message: { content: string }) => message.content === "Fictional unanswered input")).toHaveLength(1);
});
it("refuses cold publication capacity before changing native or canonical bytes", async () => {
  const f = await setup(), physical = await f.native.inventory(), before = await readFile(f.canonicalPath);
  const { store } = openStore(f.base, undefined, { maxStoreBytes: (await f.store.stats()).bytes + 1 });
  await expect(store.append(bucket, [{ role: "assistant", content: "Fictional quota update" }])).rejects.toThrow(/quota|capacity/);
  expect(await f.native.inventory()).toEqual(physical); expect(await readFile(f.canonicalPath)).toEqual(before);
});
it("never recreates missing cold evidence behind a published canonical receipt", async () => {
  const f = await setup();
  const { store } = openStore(f.base, undefined, { onNativeHistoryPhase: async (phase) => { if (phase === "lifecycle_canonical_directory_synced") throw new Error("Interrupted cold cleanup"); } });
  await store.append(bucket, [{ role: "assistant", content: "Fictional committed update" }]);
  const current = JSON.parse(await readFile(f.canonicalPath, "utf8")), path = join(f.base, "native", "mono-v2", "journals", `${current.native.chain[1].journalId}.jsonl`);
  await rm(path); const fresh = openStore(f.base).store;
  await expect(fresh.beginProviderSessionTurn(bucket, "fictional-refusal", { modelKey: "faux:B" })).rejects.toThrow("native journal evidence");
  expect(await readdir(join(f.base, "native", "mono-v2", "journals"))).not.toContain(`${current.native.chain[1].journalId}.jsonl`);
  expect((await readdir(join(f.base, "history"))).some((name) => name.startsWith(".native-history-op."))).toBe(true);
});
it("preserves all predecessors across two switches and cold rotations, then D clears both artifact generations", async () => {
  const f = await setup(); await f.store.append(bucket, [{ role: "assistant", content: "Fictional cold boundary" }]);
  const current = JSON.parse(await readFile(f.canonicalPath, "utf8"));
  const turn = await f.store.beginProviderSessionTurn(bucket, "fictional-B-turn", { modelKey: "faux:B" });
  const { JsonlSessionRepo } = await import("@mono-agent/harness/session-store.js");
  const repo = new JsonlSessionRepo({ sessionsRoot: join(f.base, "native") });
  const metadata = (await repo.listOwned()).find((entry: { id: string }) => entry.id === turn.providerSessionId)!;
  const native = await repo.open(metadata, { repair: false, wait: false });
  await native.scopedWrite(async () => {
    await native.writeRecord("owner_binding", { kind: "host", ownerKey: bucket, historyBucket: bucket });
    await native.writeRecord("handle_binding", { handleId: turn.providerSessionId, baseRevision: 0, authoritative: true, model: { provider: "faux", id: "B", api: "faux-api" } });
  }, "fictional-bind");
  await native.appendMessage({ role: "user", content: "Fictional intervening B fact", timestamp: 23 }); await native.sync(); await native.close(); await repo.close();
  await (await turn.prepareCommit([{ role: "user", content: "Fictional intervening B fact" }], { providerSessionSynced: true })).commit();
  const descriptor = await f.native.freeze({ epoch: current.providerSession.epoch, ordinal: 1, handleId: turn.providerSessionId,
    predecessorJournalId: current.native.chain[0].journalId, ownerKey: bucket, historyBucket: bucket, provenance: current.native.chain[1].provenance });
  const source = await f.store.modelSwitchStorageSource(bucket); if (source.status !== "supported") throw new Error("Expected supported source");
  const { createModelSwitchState } = await import("../model-switch-billing.js");
  const { switchId: _id, ...identity } = f.state.identity;
  const state = createModelSwitchState({ ...identity, sourceCanonicalDigest: source.sourceCanonicalDigest, sourceRevision: source.sourceRevision,
    sources: [current.native.chain[0], descriptor], fromModelKey: "faux:B", toModelKey: "faux:A", targetEpoch: "d".repeat(64),
    targetProvenance: { provider: "faux", api: "faux-api", model: "A", account: null }, timestamp: 23 }, { ...f.state.reservation, retainedNativeBytes: 32768 });
  await ready({ ...f, state }); await f.store.rollForwardModelSwitch(bucket, state.identity.switchId, { exclusiveWriters: true });
  const switched = JSON.parse(await readFile(f.canonicalPath, "utf8")); expect(switched.native.chain).toHaveLength(3);
  const predecessorBytes = await Promise.all(switched.native.chain.slice(0, -1).map((entry: { journalId: string }) => readFile(join(f.base, "native", "mono-v2", "journals", `${entry.journalId}.jsonl`))));
  await f.store.append(bucket, [{ role: "assistant", content: "Fictional later A boundary" }]);
  expect(await Promise.all(switched.native.chain.slice(0, -1).map((entry: { journalId: string }) => readFile(join(f.base, "native", "mono-v2", "journals", `${entry.journalId}.jsonl`))))).toEqual(predecessorBytes);
  await f.store.reset(bucket); expect(await readdir(join(f.base, "native", "mono-v2", "journals"))).toEqual([]); expect(await readdir(join(f.base, "history", ".model-switches"))).toEqual([]);
});
it("protects a busy v4 native victim at reservation instead of allowing unbounded quota growth", async () => {
  const f = await setup(); const { JsonlSessionRepo } = await import("@mono-agent/harness/session-store.js");
  const repo = new JsonlSessionRepo({ sessionsRoot: join(f.base, "native") });
  const metadata = (await repo.listOwned()).find((entry: { id: string }) => entry.id === f.before.native.chain[1].handleId)!;
  const writer = await repo.open(metadata, { repair: false, wait: false });
  const { store } = openStore(f.base, undefined, { maxConversations: 1 });
  try {
    for (let index = 0; index < 12; index++) {
      await expect(store.append(`fictional-quota-owner-${index}`, [{ role: "assistant", content: "Fictional bounded candidate" }])).rejects.toThrow(/quota/);
      expect((await store.stats()).conversations).toBe(1);
    }
    expect(await readFile(f.canonicalPath)).toEqual(Buffer.from(JSON.stringify(f.before) + "\n"));
  } finally { await writer.close(); await repo.close(); }
  await store.append("fictional-quota-winner", [{ role: "assistant", content: "Fictional replacement" }]);
  expect((await store.stats()).conversations).toBe(1); expect(await readdir(join(f.base, "native", "mono-v2", "journals"))).toEqual([]);
});
const worker = fileURLToPath(new URL("./fixtures/managed-native-lifecycle-worker.mjs", import.meta.url));
it.skipIf(process.platform === "win32").each([
  ...["lifecycle_intent_renamed", "lifecycle_intent_directory_synced", "epoch_stage_created", "epoch_stage_synced", "epoch_renamed", "epoch_directory_synced",
    "lifecycle_canonical_stage_synced", "lifecycle_canonical_published", "lifecycle_canonical_directory_synced", "native_file_removed", "native_member_directory_synced",
    "lifecycle_native_deleted", "lifecycle_fence_cleaned", "lifecycle_intent_removed", "lifecycle_intent_removal_synced"].map((phase) => ["cold", phase]),
  ...["lifecycle_intent_renamed", "lifecycle_intent_directory_synced", "native_file_removed", "native_member_directory_synced", "native_member_removed",
    "lifecycle_native_deleted", "lifecycle_switch_file_removed", "lifecycle_switch_storage_deleted", "lifecycle_pending_deleted", "lifecycle_canonical_stage_synced",
    "lifecycle_canonical_published", "lifecycle_canonical_directory_synced", "lifecycle_fence_cleaned", "lifecycle_intent_removed", "lifecycle_intent_removal_synced"].map((phase) => ["reset", phase]),
  ...["native_file_removed", "native_member_directory_synced", "lifecycle_switch_file_removed", "lifecycle_canonical_published", "lifecycle_intent_removed"].map((phase) => ["retention", phase]),
])("recovers host %s twice in fresh processes after SIGKILL at %s", async (operation, phase) => {
  const f = await setup(); await writeFile(join(f.base, "lifecycle-proof.json"), JSON.stringify({ operation }), { mode: 0o600 });
  const child = fork(worker, [f.base, phase], { silent: true }); let error = "";
  child.stderr!.on("data", (bytes) => { error += bytes; }); const exited = once(child, "exit"); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([once(child, "message"), exited.then(() => { throw new Error(`Owner exited early: ${error}`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Boundary timeout")), 15000); })]);
    child.kill("SIGKILL"); expect((await exited)[1]).toBe("SIGKILL");
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
  const run = promisify(execFile);
  const first = JSON.parse((await run(process.execPath, [worker, f.base], { timeout: 30000 })).stdout);
  const second = JSON.parse((await run(process.execPath, [worker, f.base], { timeout: 30000 })).stdout);
  expect(second).toEqual(first); expect(first.stats.reservedBytes).toBe(0); expect(first.operations).toEqual([]);
  if (operation === "cold") { expect(first.canonical.native.chain).toHaveLength(2); expect(first.journals).toHaveLength(2); expect(first.canonical.messages.at(-1).content).toBe("Fictional cold update"); }
  else { if (operation === "retention") { expect(first.canonical).toBeNull(); expect(first.stats.conversations).toBe(1); }
    else expect(first.canonical.version).toBe(3); expect(first.journals).toEqual([]); expect(first.switches).toEqual([]); }
}, 60000);


it.each(["count", "bytes"])("protects busy exact sibling claims before reserving %s quota", async (quota) => {
  const older = `${bucket}#2000-01-01`, f = await setup(older), before = await readFile(f.canonicalPath), stats = await f.store.stats();
  const { store } = openStore(f.base, undefined, quota === "count" ? { maxConversations: 1 } : { maxStoreBytes: stats.bytes + 100 });
  const internals = store as unknown as { acquireExactConversationClaim(id: string, tryOnly: boolean): Promise<{ release(): Promise<void> }> };
  const busy = await internals.acquireExactConversationClaim(older, true);
  try { for (let retry = 0; retry < 2; retry++) {
    await expect(store.append(`${bucket}#2000-01-02`, [{ role: "assistant", content: "Same-owner sibling update" }])).rejects.toThrow("quota");
    expect(await readFile(f.canonicalPath)).toEqual(before); expect((await store.stats()).conversations).toBe(1);
    expect(await readdir(join(f.base, "native", "mono-v2", "journals"))).toHaveLength(2);
  } } finally { await busy.release(); }
});
it("recomputes retention after native deletion lets another owner publish and acquire a turn", async () => {
  const f = await setup(), other = "fictional-racing-legacy";
  const { store: independent } = openStore(f.base, undefined, { retireProviderSession: async () => {} });
  await independent.append(other, [{ role: "assistant", content: "Original legacy history" }]);
  let active: Awaited<ReturnType<typeof independent.beginProviderSessionTurn>> | undefined, entered = false;
  const { store } = openStore(f.base, async (phase) => {
    if (entered || phase !== "native_member_removed") return; entered = true;
    await independent.append(other, [{ role: "assistant", content: "Concurrent valid update" }]);
    active = await independent.beginProviderSessionTurn(other, "fictional-racing-turn");
  }, { maxAgeMs: 0, retireProviderSession: async () => {} });
  try {
    await store.append("fictional-new-winner", [{ role: "assistant", content: "New retained owner" }]);
    expect(entered).toBe(true); expect((await independent.load(other)).some((row) => row.content === "Concurrent valid update")).toBe(true);
    expect(await independent.load("fictional-new-winner")).toHaveLength(1); await expect(readFile(f.canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await active?.abort(); }
});
it("retries the same cold commit near quota without charging its published intent twice", async () => {
  const f = await setup(), input = [{ role: "assistant" as const, content: "Near-quota cold update" }];
  const estimate = await f.store.prepareAppend(bucket, input), history = join(f.base, "history");
  const stageName = (await readdir(history)).find((name) => name.endsWith(".tmp")); if (!stageName) throw new Error("Expected stage");
  const stageBytes = await readFile(join(history, stageName)), next = JSON.parse(stageBytes.toString());
  const plan = f.native.planColdEpoch(f.before.native.chain, { hostAuthority: f.before.native.authority, assertOwned: async () => {},
    targetEpoch: next.providerSession.epoch, targetHandleId: next.native.chain.at(-1).handleId, timestamp: 0 });
  const operationBytes = Buffer.byteLength(JSON.stringify({ version: 1, disposition: "C", source: f.before, next, timestamp: 0 }) + "\n");
  await estimate.abort(); const base = (await f.store.stats()).bytes, canonicalBytes = (await readFile(f.canonicalPath)).length;
  let interrupted = false;
  const { store } = openStore(f.base, undefined, {
    onNativeHistoryPhase: async (phase: string) => { if (!interrupted && phase === "lifecycle_intent_directory_synced") { interrupted = true; throw new Error("Interrupted exact cold intent"); } },
    maxStoreBytes: base + stageBytes.length - canonicalBytes + operationBytes + plan.bytes + 32 });
  const prepared = await store.prepareAppend(bucket, input);
  await expect(prepared.commit()).rejects.toThrow("Interrupted exact cold intent");
  await prepared.commit(); expect((await store.load(bucket)).at(-1)?.content).toBe(input[0]!.content);
  expect((await store.stats()).reservedBytes).toBe(0);
});
it("does not charge or credit unrelated v1-v3 provider journals", async () => {
  const f = await setup(), before = await f.store.stats(), repo = new JsonlSessionRepo({ sessionsRoot: join(f.base, "native") });
  try {
    const legacy = await repo.create({ id: "f".repeat(64), cwd: "/fictional" });
    await legacy.appendMessage({ role: "assistant", content: "Unmanaged provider data ".repeat(3000), timestamp: 17 }); await legacy.sync(); await legacy.close();
  } finally { await repo.close(); }
  expect((await f.store.stats()).bytes).toBe(before.bytes); expect((await f.native.inventory()).bytes).toBeGreaterThan(0);
});
it("payload read remains absent after fence removal and after its old target is cold-replaced", async () => {
  const f = await setup(), history = join(f.base, "history"), payloads = new ModelSwitchPayloadStore(history, await lstat(history));
  expect(await payloads.read(bucket, f.state.identity.switchId)).toBeUndefined();
  await f.store.append(bucket, [{ role: "assistant", content: "Cold replacement after completed receipt" }]);
  expect(await payloads.read(bucket, f.state.identity.switchId)).toBeUndefined();
  const oldTarget = f.before.native.chain.at(-1).journalId;
  expect(await readdir(join(f.base, "native", "mono-v2", "journals"))).not.toContain(`${oldTarget}.jsonl`);
});


it("preserves native quota charges when a managed canonical becomes unreadable", async () => {
  const f = await setup(), canonicalBytes = (await readFile(f.canonicalPath)).length, before = await f.store.stats();
  await writeFile(f.canonicalPath, "{");
  const protectedBytes = before.bytes - canonicalBytes + 1;
  expect((await f.store.stats()).bytes).toBe(protectedBytes);
  const { store } = openStore(f.base, undefined, { maxStoreBytes: protectedBytes + 1024 });
  await expect(store.append("fictional-capacity-owner", [{ role: "assistant", content: "x".repeat(2048) }])).rejects.toThrow("quota");
  expect(await readFile(f.canonicalPath, "utf8")).toBe("{");
  expect(await readdir(join(f.base, "native", "mono-v2", "journals"))).toHaveLength(2);
});


it("rolls over at the count limit by deleting an older v4 day under its held logical claim", async () => {
  const older = `${bucket}#2000-01-01`, newer = `${bucket}#2000-01-02`, f = await setup(older);
  const { store } = openStore(f.base, undefined, { maxConversations: 1, retireProviderSession: async () => {} });
  await store.append(newer, [{ role: "assistant", content: "Next fictional day" }]);
  expect(await store.load(newer)).toHaveLength(1); await expect(readFile(f.canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(join(f.base, "native", "mono-v2", "journals"))).toHaveLength(0);
  expect((await store.stats()).conversations).toBe(1); expect((await store.stats()).postCommitMaintenanceFailures).toBe(0);
});
it("preserves mixed-root LRU order instead of preferring legacy victims", async () => {
  const f = await setup(), history = join(f.base, "history"), legacy = "fictional-newer-legacy";
  const { store: seed } = openStore(f.base, undefined, { retireProviderSession: async () => {} });
  await seed.append(legacy, [{ role: "assistant", content: "Newer legacy survives" }]);
  await utimes(f.canonicalPath, new Date(1000), new Date(1000));
  await utimes(join(history, `${switchConversationKey(legacy)}.history.json`), new Date(2000), new Date(2000));
  const { store } = openStore(f.base, undefined, { maxConversations: 2, maxAgeMs: Number.MAX_SAFE_INTEGER, retireProviderSession: async () => {} });
  await store.append("fictional-newest", [{ role: "assistant", content: "Newest history" }]);
  await expect(readFile(f.canonicalPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await store.load(legacy))[0]?.content).toBe("Newer legacy survives"); expect((await store.stats()).conversations).toBe(2);
});


it("computes switch/native footprints and canonical snapshots once per root transaction", async () => {
  const f = await setup(), history = join(f.base, "history");
  const internals = f.store as unknown as {
    acquireRootTransaction: (...args: unknown[]) => Promise<() => Promise<void>>;
    readCommittedEntryRecord: (entry: { name: string }, ...args: unknown[]) => Promise<unknown>;
    modelSwitchPayloads: (identity: { dev: number; ino: number }) => { inventory: () => Promise<unknown> };
  };
  const physical = vi.spyOn(f.native, "inventory"), canonical = vi.spyOn(internals, "readCommittedEntryRecord");
  const switches = vi.spyOn(internals.modelSwitchPayloads(await lstat(history)), "inventory");
  const acquire = internals.acquireRootTransaction.bind(internals); let observed = 0;
  vi.spyOn(internals, "acquireRootTransaction").mockImplementation(async (...args) => {
    const release = await acquire(...args), nativeStart = physical.mock.calls.length,
      switchStart = switches.mock.calls.length, recordStart = canonical.mock.calls.length;
    return async () => {
      const nativeReads = physical.mock.calls.length - nativeStart, switchReads = switches.mock.calls.length - switchStart;
      expect(nativeReads).toBeLessThanOrEqual(1); expect(switchReads).toBeLessThanOrEqual(1);
      const names = canonical.mock.calls.slice(recordStart).map(([entry]) => entry.name);
      expect(new Set(names).size).toBe(names.length); if (nativeReads) observed++;
      await release();
    };
  });
  await f.store.append("fictional-cached-accounting", [{ role: "assistant", content: "Ordinary unrelated update" }]);
  expect(observed).toBeGreaterThanOrEqual(2);
});
it("always rolls an accepted still-current model-change frame forward before allowing C", async () => {
  const root = await mkdtemp(join(tmpdir(), "mono-current-reference-")); roots.push(root);
  const f = await fixture(root); await ready(f);
  let stopped = false;
  const { store } = openStore(root, async (phase) => {
    if (!stopped && phase === "model_change_synced") { stopped = true; throw new Error("Interrupted current reference"); }
  });
  await expect(store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { exclusiveWriters: true })).rejects.toThrow("Interrupted current reference");
  const current = JSON.parse(await readFile(f.canonicalPath, "utf8")); expect(current.providerSession.epoch).toBe(f.state.identity.sources.at(-1)!.epoch);
  expect((await readFile(f.nativePath, "utf8")).split("\n").filter((line) => line.includes('"kind":"model_change"'))).toHaveLength(1);
  await expect(store.append(bucket, [{ role: "assistant", content: "Cannot cold-replace accepted reference" }])).rejects.toThrow("pending");
  expect((await readdir(join(root, "history"))).some((name) => name.startsWith(".native-history-op."))).toBe(false);
  expect(await store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { exclusiveWriters: true })).toEqual({ status: "committed" });
  await store.append(bucket, [{ role: "assistant", content: "Cold update after unconditional roll-forward" }]);
  expect((await store.load(bucket)).at(-1)?.content).toBe("Cold update after unconditional roll-forward");
  expect((await readdir(join(root, "history"))).some((name) => name.startsWith(".native-history-op."))).toBe(false);
});
