import { afterEach, expect, it, vi } from "vitest";
import { fork, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture, ready, openStore, bucket } from "./fixtures/managed-native-switch-fixture.mjs";
import { switchDigest } from "../durable-model-switch-contract.js";
import { createAgentHarness } from "../harness.js";
import { createMonoRuntime } from "@mono-agent/runtime-adapter";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const request = { messageId: "fictional-persisted-cold-message", modelKey: "faux:C",
  targetProvenance: { provider: "faux", api: "faux-api", model: "C", account: null }, reason: "capacity" as const };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "native-cold-change-")); roots.push(root);
  const f = await fixture(root); await ready(f); await f.store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { exclusiveWriters: true });
  return { ...f, before: JSON.parse(await readFile(f.canonicalPath, "utf8")) };
}
it("owned cold model transition keeps predecessors P, retires only current C and records one restart-stable cold receipt", async () => {
  const f = await setup(), bytes = await readFile(f.nativePath), oldCurrent = f.before.native.chain.at(-1);
  const preparation = await f.store.beginProviderSessionPreparation(bucket, "fictional-cold-owner");
  const input = { ...request, sourceCanonicalDigest: switchDigest(f.before) };
  const receipt = await preparation.coldModelChange!(input); await preparation.abort();
  const canonical = await readFile(f.canonicalPath), after = JSON.parse(canonical.toString());
  expect(after.messages).toEqual(f.before.messages); expect(after.native.chain).toHaveLength(2);
  expect(after.native.chain[0]).toEqual(f.before.native.chain[0]); expect(await readFile(f.nativePath)).toEqual(bytes);
  expect(after.providerSession.modelKey).toBe("faux:C"); expect(after.native.chain[1].provenance).toEqual(request.targetProvenance);
  expect(after.native.projection).toBeNull(); expect(after.lastSwitch).toEqual(receipt); expect(receipt.artifact).toBeNull();
  expect(receipt.fromEpoch).toBe(f.before.providerSession.epoch); expect(receipt.toEpoch).toBe(after.providerSession.epoch);
  await expect(readFile(join(f.base, "native", "mono-v2", "journals", `${oldCurrent.journalId}.jsonl`))).rejects.toMatchObject({ code: "ENOENT" });
  const reopened = openStore(f.base).store, retry = await reopened.beginProviderSessionPreparation(bucket, "fictional-cold-retry");
  expect(await retry.coldModelChange!(input)).toEqual(receipt); await retry.abort();
  expect(await readFile(f.canonicalPath)).toEqual(canonical); expect((await reopened.stats()).reservedBytes).toBe(0);
  // Old handoff artifacts remain charged/owned, not used as C's native projection.
  expect((await readdir(join(f.base, "history", ".model-switches"))).some((name) => name.endsWith(".handoff.json"))).toBe(true);
  await reopened.reset(bucket); expect(await readdir(join(f.base, "native", "mono-v2", "journals"))).toEqual([]);
  expect(await readdir(join(f.base, "history", ".model-switches"))).toEqual([]);
});
it.each(["store", "staging"])("refuses insufficient safe %s capacity before a cold intent or physical mutation", async (limit) => {
  const f = await setup(), canonical = await readFile(f.canonicalPath), physical = await f.native.inventory();
  const { store } = openStore(f.base, undefined, limit === "store" ? { maxStoreBytes: (await f.store.stats()).bytes + 1 } : { maxStagedBytes: 1 });
  const prep = await store.beginProviderSessionPreparation(bucket, "fictional-quota-owner");
  try { await expect(prep.coldModelChange!({ ...request, sourceCanonicalDigest: switchDigest(JSON.parse(canonical.toString())) })).rejects.toThrow(/capacity/); } finally { await prep.abort(); }
  expect(await readFile(f.canonicalPath)).toEqual(canonical); expect(await f.native.inventory()).toEqual(physical);
  expect((await readdir(join(f.base, "history"))).some((name) => name.startsWith(".native-history-op."))).toBe(false);
});
it.each(["store", "staging"])("cold %s capacity cannot credit canonical replacement before the publication peak", async (limit) => {
  const sample = await setup(); let publicationBytes = 0;
  const reference = openStore(sample.base, async (phase: string) => {
    if (phase !== "epoch_stage_created") return;
    const dir = join(sample.base, "history"), name = (await readdir(dir)).find((name) => name.startsWith(".native-history-op."))!;
    const bytes = await readFile(join(dir, name)), operation = JSON.parse(bytes.toString());
    const plan = reference.native.planColdEpoch(operation.source.native.chain, { hostAuthority: operation.source.native.authority,
      assertOwned: async () => {}, targetEpoch: operation.next.providerSession.epoch,
      targetHandleId: operation.next.native.chain.at(-1).handleId, timestamp: 0, targetProvenance: request.targetProvenance });
    publicationBytes = bytes.length + plan.bytes;
  });
  const referencePrep = await reference.store.beginProviderSessionPreparation(bucket, "fictional-peak-reference");
  try { await referencePrep.coldModelChange!({ ...request, sourceCanonicalDigest: switchDigest(sample.before) }); }
  finally { await referencePrep.abort(); }
  expect(publicationBytes).toBeGreaterThan(0);
  const f = await setup(), before = await readFile(f.canonicalPath), physical = await f.native.inventory();
  // Enough for intent/header, but not for the new canonical stage coexisting
  // with the old canonical. The previous replacement-credit arithmetic fit.
  const { store } = openStore(f.base, undefined, limit === "store"
    ? { maxStoreBytes: (await f.store.stats()).bytes + publicationBytes + 512 }
    : { maxStagedBytes: publicationBytes + 512 });
  const prep = await store.beginProviderSessionPreparation(bucket, "fictional-peak-owner");
  try { await expect(prep.coldModelChange!({ ...request, sourceCanonicalDigest: switchDigest(f.before) })).rejects.toThrow(/capacity/); }
  finally { await prep.abort(); }
  expect(await readFile(f.canonicalPath)).toEqual(before); expect(await f.native.inventory()).toEqual(physical);
  expect((await readdir(join(f.base, "history"))).some((name) => name.startsWith(".native-history-op."))).toBe(false);
});
it.each(["source", "identity", "provenance"])("cold change refuses malformed/stale %s before intent or mutation", async (fault) => {
  const f = await setup(), before = await readFile(f.canonicalPath), physical = await f.native.inventory();
  const prep = await f.store.beginProviderSessionPreparation(bucket, "fictional-invalid-cold-owner");
  try {
    const input = { ...request, sourceCanonicalDigest: switchDigest(f.before),
      ...(fault === "source" ? { sourceCanonicalDigest: "0".repeat(64) } : {}),
      ...(fault === "identity" ? { messageId: "" } : {}),
      ...(fault === "provenance" ? { targetProvenance: { ...request.targetProvenance, model: "fictional-other-model" } } : {}) };
    await expect(prep.coldModelChange!(input)).rejects.toThrow();
  } finally { await prep.abort(); }
  expect(await readFile(f.canonicalPath)).toEqual(before); expect(await f.native.inventory()).toEqual(physical);
  expect((await readdir(join(f.base, "history"))).some((name) => name.startsWith(".native-history-op."))).toBe(false);
});
it("unsettled legacy current cannot lose native-only evidence through a cold change", async () => {
  const f = await setup(), physical = await f.native.inventory();
  const turn = await f.store.beginProviderSessionTurn(bucket, "fictional-unsettled-legacy-turn", { modelKey: f.before.providerSession.modelKey });
  await turn.abort(); const before = await readFile(f.canonicalPath);
  const prep = await f.store.beginProviderSessionPreparation(bucket, "fictional-unsettled-cold-owner");
  try { await expect(prep.coldModelChange!({ ...request, sourceCanonicalDigest: switchDigest(JSON.parse(before.toString())) })).rejects.toThrow(/settled outgoing current/); }
  finally { await prep.abort(); }
  expect(await readFile(f.canonicalPath)).toEqual(before); expect(await f.native.inventory()).toEqual(physical);
});
it("pending/unknown summary work cannot select cold cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-cold-pending-")); roots.push(root); const f = await fixture(root);
  const lease = await f.store.beginModelSwitchStorage(f.state); if (lease.status !== "owned") throw new Error("Expected lease");
  await lease.admit("outgoing"); await lease.release();
  const prep = await f.store.beginProviderSessionPreparation(bucket, "fictional-pending-owner"), before = await readFile(f.canonicalPath);
  try { await expect(prep.coldModelChange!({ ...request, sourceCanonicalDigest: switchDigest(JSON.parse(before.toString())) })).rejects.toThrow(/pending|settle|switch/i); } finally { await prep.abort(); }
  expect(await readFile(f.canonicalPath)).toEqual(before); expect(await readFile(f.nativePath)).toEqual(f.original);
});
it("manual compactConversation on real v4 fails guarded dispatch without generic invalidation/retirement (P is defence-in-depth)", async () => {
  const f = await setup(), predecessor = await readFile(f.nativePath), identityPath = join(f.base, "IDENTITY.md");
  await writeFile(identityPath, "Fictional instructions");
  const faux = fauxProvider({ models: [{ id: "B", contextWindow: 100000, maxTokens: 4096 }] }), models = createModels(); models.setProvider(faux.provider);
  const transport = vi.spyOn(faux.provider, "streamSimple"), runtime = createMonoRuntime({ workspace: f.base, resolvePiApiKey: async () => undefined });
  const run = runtime.run.bind(runtime); runtime.run = (prompt, options) => run(prompt, { ...options, piResolvedModel: faux.getModel("B"), piResolvedModels: models });
  const invalidation = vi.spyOn(runtime, "invalidateSession"), retirement = vi.spyOn(runtime, "retireDurableSession"), execution = vi.spyOn(runtime, "run");
  const harness = createAgentHarness({ identityPath, runtime, model: { provider: "faux", model: "B", reference: "faux:B" }, historyStore: f.store,
    piSessionsRoot: join(f.base, "native"), session: { mode: "continuous", idleTimeoutMs: 60000, supportsResume: true }, runtimeOptions: { allowedTools: [], disallowedTools: [] } });
  try {
    await expect(harness.compactConversation!(bucket)).rejects.toMatchObject({ failureKind: "compaction_failed" });
    expect(execution).toHaveBeenCalledTimes(1); expect(transport).not.toHaveBeenCalled();
    expect(invalidation).not.toHaveBeenCalled(); expect(retirement).not.toHaveBeenCalled();
    expect(await readFile(f.nativePath)).toEqual(predecessor);
    expect(JSON.parse(await readFile(f.canonicalPath, "utf8")).native.chain[0]).toEqual(f.before.native.chain[0]);
  } finally { await harness.dispose?.(); }
});
const worker = fileURLToPath(new URL("./fixtures/managed-native-lifecycle-worker.mjs", import.meta.url));
it.each(["lifecycle_intent_renamed", "lifecycle_intent_directory_synced", "epoch_stage_created", "epoch_renamed", "epoch_directory_synced",
  "lifecycle_canonical_stage_synced", "lifecycle_canonical_published", "lifecycle_canonical_directory_synced", "native_file_removed",
  "native_member_directory_synced", "lifecycle_native_deleted", "lifecycle_intent_removed", "lifecycle_intent_removal_synced"])(
  "cold model change recovers twice storage-only after SIGKILL at %s", async (phase) => {
    const f = await setup(), predecessor = await readFile(f.nativePath);
    await writeFile(join(f.base, "lifecycle-proof.json"), JSON.stringify({ operation: "cold-model" }), { mode: 0o600 });
    const child = fork(worker, [f.base, phase], { silent: true }), exited = once(child, "exit"); let stderr = "", timer: ReturnType<typeof setTimeout> | undefined;
    child.stderr!.on("data", (bytes) => { stderr += bytes; });
    try {
      await Promise.race([once(child, "message"), exited.then(() => { throw new Error(`Early owner exit: ${stderr}`); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Cold boundary timeout")), 10000); })]);
      child.kill("SIGKILL"); expect((await exited)[1]).toBe("SIGKILL");
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
    const run = promisify(execFile), first = JSON.parse((await run(process.execPath, [worker, f.base], { timeout: 10000 })).stdout);
    const second = JSON.parse((await run(process.execPath, [worker, f.base], { timeout: 10000 })).stdout);
    expect(second).toEqual(first); expect(first.operations).toEqual([]); expect(first.stats.reservedBytes).toBe(0);
    expect(first.canonical.providerSession.modelKey).toBe("faux:C"); expect(first.canonical.native.chain).toHaveLength(2);
    expect(first.canonical.lastSwitch.artifact).toBeNull(); expect(first.canonical.native.projection).toBeNull();
    expect(first.canonical.messages).toEqual(f.before.messages); expect(first.journals).toHaveLength(2);
    expect(await readFile(f.nativePath)).toEqual(predecessor);
  }, 40000);
