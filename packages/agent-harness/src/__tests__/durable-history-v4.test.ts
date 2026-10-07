import { mkdtemp, readFile, readdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createDurableHistoryStore } from "../durable-history.js";
import type { DurableHistoryStoreOptions } from "../durable-history.js";
import type { RuntimeSessionTurnReconciliationResult } from "@mono-agent/runtime-adapter";
import { validateTurnHistoryV4 } from "../durable-model-switch-contract.js";
import type { TurnHistoryV4 } from "../durable-model-switch-contract.js";
import { bucket, modelKey, timestamp, canonicalRecord, conversationKey, handleId, evidence } from "./fixtures/canonical-v4-fixture.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(value: unknown = canonicalRecord(), options: Partial<DurableHistoryStoreOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "canonical-v4-test-")); roots.push(root);
  const id = (value as TurnHistoryV4).conversationId;
  const path = join(root, `${conversationKey(id)}.history.json`), fencePath = join(root, ".locks", `${conversationKey(id)}.dirty.json`);
  if ((value as { version?: number }).version === 4) await writeFile(join(root, ".native-history-root.json"), JSON.stringify({ version: 1, kind: "native-history", canonicalVersion: 4, rootId: "1".repeat(64) }), { mode: 0o600 });
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const inspect = vi.fn(async (request) => evidence(request) as RuntimeSessionTurnReconciliationResult);
  const retire = vi.fn(async () => {});
  const store = createDurableHistoryStore({ root, now: () => Date.parse(timestamp), reconcileProviderSessionTurn: inspect, retireProviderSession: retire, ...options });
  const begin = (purpose: "execution" | "compaction" = "execution") => store.beginProviderSessionTurn(id, "fictional-next-turn", { modelKey,
    reconciliation: { ownerKey: canonicalRecord(id).native.authority.ownerKey, purpose,
      ...(purpose === "execution" ? { initial: { persistText: "Fictional new question.", timestamp } } : {}) } });
  return { root, path, fencePath, inspect, retire, store, begin, read: async () => JSON.parse(await readFile(path, "utf8")) as TurnHistoryV4 };
}

it("loads validated v4 without writes, retirement or native inspection", async () => {
  const f = await fixture(), before = await readFile(f.path);
  expect(await f.store.load(bucket)).toEqual(canonicalRecord().messages);
  expect(await f.store.readProviderSessionBinding(bucket)).toEqual({ modelKey, revision: 7, native: true });
  expect((await f.store.modelSwitchStorageSource(bucket)).status).toBe("supported");
  expect(await readFile(f.path)).toEqual(before); expect(f.inspect).not.toHaveBeenCalled(); expect(f.retire).not.toHaveBeenCalled();
});

it.each([
  (record: any) => { record.native.chain[1].epoch = "6".repeat(64); },
  (record: any) => { record.native.authority.ownerKey = "fictional-other"; record.native.chain.forEach((segment: any) => { segment.ownerKey = "fictional-other"; }); },
  (record: any) => { record.native.chain[1].handleId = "7".repeat(64); },
  (record: any) => { record.native.chain[1].predecessorJournalId = null; },
  (record: any) => { record.native.chain[1].unknown = "fictional-extra"; },
  (record: any) => { record.native.authority.canonicalVersion = 3; },
  (record: any) => { record.lastSwitch.artifact.hash = "not-a-hash"; },
])("rejects invalid v4 chain/owner/authority/receipt without altering evidence", async (mutate) => {
  const value = canonicalRecord(); mutate(value); const f = await fixture(value), before = await readFile(f.path);
  await expect(f.store.load(bucket)).rejects.toThrow(); await expect(f.store.append(bucket, [])).rejects.toThrow();
  expect(await readFile(f.path)).toEqual(before); expect(f.retire).not.toHaveBeenCalled();
});

it("preserves v4 authority, chain, projection and both receipts on same-epoch synced writes with eviction", async () => {
  const f = await fixture(undefined, { maxMessages: 1 }), before = await f.read();
  const turn = await f.store.beginProviderSessionTurn(bucket, "fictional-warm-turn", { modelKey });
  expect(turn.providerSessionRevision).toBe(7);
  await (await turn.prepareCommit([{ role: "assistant", content: "Fictional warm answer." }], { providerSessionSynced: true })).commit();
  const after = await f.read(); validateTurnHistoryV4(after, (message) => message as never);
  expect(after.native).toEqual(before.native); expect(after.lastSwitch).toEqual(before.lastSwitch); expect(after.lastCommit).toEqual(before.lastCommit);
  expect(after.providerSession).toEqual({ ...before.providerSession, revision: 8 });
  expect(after.messages).toEqual([{ role: "assistant", content: "Fictional warm answer." }]); expect(f.retire).not.toHaveBeenCalled();
});

it.each(["execution", "compaction"] as const)("preserves v4 metadata while recovering a v5 %s fence exactly once", async (purpose) => {
  const f = await fixture(), before = await f.read(); const turn = await f.begin(purpose); await turn.abort();
  expect(JSON.parse(await readFile(f.fencePath, "utf8")).version).toBe(5);
  await expect(f.store.recoverProviderSessionTurn(bucket)).resolves.toMatchObject({ status: "recovered" });
  const after = await f.read(); expect(after.version).toBe(4); expect(after.native).toEqual(before.native); expect(after.lastSwitch).toEqual(before.lastSwitch);
  expect(after.lastCommit).toMatchObject({ turnId: "fictional-next-turn", committedRevision: 8 });
  expect(after.messages).toHaveLength(purpose === "execution" ? 3 : 1);
  expect(await f.store.recoverProviderSessionTurn(bucket)).toEqual({ status: "clean" }); expect(await f.read()).toEqual(after);
  expect(f.inspect).toHaveBeenCalledOnce(); expect(f.retire).not.toHaveBeenCalled();
});

it("rejects native evidence from a journal outside the authoritative v4 chain tip", async () => {
  const f = await fixture(), turn = await f.begin(); await turn.abort(); const before = await readFile(f.path), fence = await readFile(f.fencePath);
  f.inspect.mockImplementation(async (request) => ({ ...evidence(request), journalId: "fictional-foreign-journal" }) as RuntimeSessionTurnReconciliationResult);
  await expect(f.store.recoverProviderSessionTurn(bucket)).rejects.toThrow("authoritative chain tip");
  expect(await readFile(f.path)).toEqual(before); expect(await readFile(f.fencePath)).toEqual(fence); expect(f.retire).not.toHaveBeenCalled();
});

it("includes v4 metadata in source and optimistic-version checks during native inspection", async () => {
  const f = await fixture(), source = await f.store.modelSwitchStorageSource(bucket), turn = await f.begin(); await turn.abort();
  f.inspect.mockImplementation(async (request) => {
    const value = await f.read(); const changed = { ...value, native: { ...value.native, projection: { id: "8".repeat(64), hash: "8".repeat(64) } } };
    await writeFile(f.path, `${JSON.stringify(changed)}\n`, { mode: 0o600 });
    return evidence(request) as RuntimeSessionTurnReconciliationResult;
  });
  const fence = await readFile(f.fencePath);
  await expect(f.store.recoverProviderSessionTurn(bucket)).rejects.toThrow("Canonical history changed during native inspection");
  const changedSource = await f.store.modelSwitchStorageSource(bucket);
  if (source.status !== "supported" || changedSource.status !== "supported") throw new Error("Expected supported fictional source");
  expect(changedSource.sourceCanonicalDigest).not.toBe(source.sourceCanonicalDigest);
  expect(await readFile(f.fencePath)).toEqual(fence); expect(f.retire).not.toHaveBeenCalled();
});

it.each(["append", "reset", "logical reset", "exclusive", "import", "model change", "zero retention", "revision overflow"])("guards v4 %s before retirement or canonical deletion", async (action) => {
  const value = canonicalRecord(); if (action === "import") value.messages = []; if (action === "revision overflow") value.providerSession.revision = Number.MAX_SAFE_INTEGER;
  const f = await fixture(value, action === "zero retention" ? { maxMessages: 0 } : {}), before = await readFile(f.path);
  let operation: Promise<unknown>;
  if (action === "append") operation = f.store.append(bucket, []);
  else if (action === "reset") operation = f.store.reset(bucket);
  else if (action === "logical reset") operation = f.store.resetLogicalConversation(bucket);
  else if (action === "exclusive") operation = f.store.contextImport!.beginExclusiveTurn(bucket);
  else if (action === "import") operation = f.store.contextImport!.prepareImport(bucket, { text: "Fictional import.", idempotencyKey: "fictional-import", timestamp });
  else operation = f.store.beginProviderSessionTurn(bucket, "fictional-cold-turn", { modelKey: action === "model change" ? "openai:fictional-other-model" : modelKey });
  await expect(operation).rejects.toThrow(/requires managed (native epoch transition|whole-chain deletion) capability/);
  expect(await readFile(f.path)).toEqual(before); expect(f.retire).not.toHaveBeenCalled(); expect(f.inspect).not.toHaveBeenCalled();
  expect((await f.store.stats()).activePreparedAppends).toBe(0);
});

it("prechecks v4 logical membership before resetting a legacy sibling", async () => {
  const logical = "fictional-logical", id = `${logical}#2026-08-14`;
  const f = await fixture(canonicalRecord(id));
  await f.store.append(logical, [{ role: "assistant", content: "Fictional legacy base." }]);
  const legacyPath = join(f.root, `${conversationKey(logical)}.history.json`), before = await readFile(legacyPath); f.retire.mockClear();
  await expect(f.store.resetLogicalConversation(logical)).rejects.toThrow("whole-chain deletion capability");
  expect(await readFile(legacyPath)).toEqual(before); expect(f.retire).not.toHaveBeenCalled();
});

it("guards unsynced v4 commit and stale admission without consuming the dirty fence", async () => {
  const f = await fixture(), before = await readFile(f.path);
  const turn = await f.store.beginProviderSessionTurn(bucket, "fictional-unsynced", { modelKey }); const fence = await readFile(f.fencePath);
  await expect(turn.prepareCommit([], { providerSessionSynced: false })).rejects.toThrow("native epoch transition capability"); await turn.abort();
  await expect(f.store.beginProviderSessionTurn(bucket, "fictional-stale", { modelKey })).rejects.toThrow("native epoch transition capability");
  expect(await readFile(f.path)).toEqual(before); expect(await readFile(f.fencePath)).toEqual(fence); expect(f.retire).not.toHaveBeenCalled();
});

it("preserves unresolved v4 dirty fences without blocking unrelated exclusive maintenance", async () => {
  const f = await fixture(), before = await readFile(f.path);
  const turn = await f.store.beginProviderSessionTurn(bucket, "fictional-abandoned", { modelKey }); await turn.abort(); const fence = await readFile(f.fencePath);
  const exclusive = await f.store.contextImport!.beginExclusiveTurn("fictional-other"); await exclusive.abort();
  await f.store.append("fictional-other", [{ role: "user", content: "Fictional unrelated work." }]);
  expect(await readFile(f.path)).toEqual(before); expect(await readFile(f.fencePath)).toEqual(fence); expect(f.retire).not.toHaveBeenCalled();
});

it("counts v4 as non-evictable and rejects over-quota admission before publication", async () => {
  const f = await fixture(undefined, { maxConversations: 1, maxAgeMs: 1 }); const before = await readFile(f.path);
  const legacyId = "fictional-legacy-victim", seed = canonicalRecord(legacyId);
  const legacyPath = join(f.root, `${conversationKey(legacyId)}.history.json`);
  await writeFile(legacyPath, `${JSON.stringify({ version: 3, conversationId: legacyId, messages: seed.messages, providerSession: seed.providerSession })}\n`, { mode: 0o600 });
  const legacyBefore = await readFile(legacyPath);
  await utimes(legacyPath, new Date(0), new Date(0)); await utimes(f.path, new Date(1), new Date(1));
  await expect(f.store.append("fictional-other", [{ role: "assistant", content: "Fictional new history." }])).rejects.toThrow("quota");
  expect(await readFile(f.path)).toEqual(before); expect(f.retire).not.toHaveBeenCalled(); expect(await readFile(legacyPath)).toEqual(legacyBefore);
  await expect(readFile(join(f.root, `${conversationKey("fictional-other")}.history.json`))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["absent", "cancelled"])("guards cold v5 settlement (%s) without deleting payload or native evidence", async (outcome) => {
  const f = await fixture(), turn = await f.begin();
  if (outcome === "cancelled") await turn.reconciliation!.claim("cancelled", { outcome: "cancelled", text: "Fictional cancellation.", timestamp, error: null, failureKind: "cancelled" });
  await turn.abort(); const before = await readFile(f.path), fence = await readFile(f.fencePath), pending = await readdir(join(f.root, ".pending-turns"));
  if (outcome === "absent") f.inspect.mockResolvedValue({ status: "absent" });
  await expect(f.store.recoverProviderSessionTurn(bucket)).rejects.toThrow("native epoch transition capability");
  expect(await readFile(f.path)).toEqual(before); expect(await readFile(f.fencePath)).toEqual(fence);
  expect(await readdir(join(f.root, ".pending-turns"))).toEqual(pending); expect(f.retire).not.toHaveBeenCalled();
});

it("guards old receipt cleanup when its epoch has become a v4 predecessor", async () => {
  const f = await fixture(), turn = await f.begin();
  const internal = f.store as any, cleanup = vi.spyOn(internal, "removeDirtyFenceAfterCommit").mockRejectedValue(new Error("Fictional cleanup interruption"));
  await (await turn.prepareCommit([], { providerSessionSynced: true })).commit(); cleanup.mockRestore();
  const value = await f.read(), prior = value.native.chain.at(-1)!;
  const epoch = "9".repeat(64);
  const advanced = { ...value, providerSession: { ...value.providerSession, epoch, revision: 0 }, native: { ...value.native,
    chain: [...value.native.chain, { ...prior, journalId: "fictional-new-current", predecessorJournalId: prior.journalId, ordinal: 2, epoch, handleId: handleId(bucket, epoch) }] } };
  await writeFile(f.path, `${JSON.stringify(advanced)}\n`, { mode: 0o600 }); const fence = await readFile(f.fencePath);
  await expect(f.store.recoverProviderSessionTurn(bucket)).rejects.toThrow("native epoch transition capability");
  expect(await f.read()).toEqual(advanced); expect(await readFile(f.fencePath)).toEqual(fence); expect(f.retire).not.toHaveBeenCalled();
});

it.each([1, 2, 3])("keeps unupgraded v%i cold rotation/reset/retention and root format unchanged", async (version) => {
  const initial = canonicalRecord(); const value = { version, conversationId: bucket, messages: initial.messages,
    ...(version === 1 ? {} : { providerSession: initial.providerSession }), ...(version === 3 ? { lastCommit: initial.lastCommit } : {}) };
  const f = await fixture(value), before = await readFile(f.path);
  expect(await f.store.load(bucket)).toEqual(value.messages); expect(await readFile(f.path)).toEqual(before);
  const turn = await f.store.beginProviderSessionTurn(bucket, "fictional-change", { modelKey: "openai:fictional-other-model" });
  await (await turn.prepareCommit([], { providerSessionSynced: false })).commit();
  expect((await f.read()).version).toBe(3); expect((await f.read()).providerSession.revision).toBe(0);
  await f.store.reset(bucket); expect((await f.read()).messages).toEqual([]);
  const low = createDurableHistoryStore({ root: f.root, maxConversations: 1, retireProviderSession: f.retire });
  await low.append("fictional-other", [{ role: "assistant", content: "Fictional quota replacement." }]);
  await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(f.root)).not.toContain(".model-switches");
  expect((await low.stats()).conversations).toBe(1);
});

for (const phase of ["canonical_stage_synced", "canonical_renamed", "canonical_directory_synced", "fence_cleanup_started", "fence_removed", "payload_removed"]) {
  it(`recovers a same-epoch v4 write twice in fresh processes after SIGKILL at ${phase}`, async () => {
    const f = await fixture(), before = await f.read();
    const run = async (action: "commit" | "recover") => {
      const child = fork(new URL("./fixtures/canonical-v4-worker.mjs", import.meta.url), [f.root, action, phase], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: ["--no-warnings"] });
      let stderr = ""; child.stderr!.on("data", (data) => { stderr += data; }); const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      try {
        const result: any = await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", (code) => reject(new Error(`Worker exited ${code}: ${stderr}`))); });
        expect(result.error).toBeUndefined(); const exit = once(child, "exit");
        if (action === "commit") { expect(result.phase).toBe(phase); child.kill("SIGKILL"); }
        const [code, signal] = await exit; expect(action === "commit" ? signal : code).toBe(action === "commit" ? "SIGKILL" : 0); return result;
      } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    };
    await run("commit"); const first = await run("recover"), second = await run("recover");
    expect(second.record).toEqual(first.record); expect(first.record.version).toBe(4); expect(first.record.native).toEqual(before.native); expect(first.record.lastSwitch).toEqual(before.lastSwitch);
    expect(first.record.providerSession.revision).toBe(8); expect(first.record.messages).toHaveLength(3);
    expect(first.record.lastCommit.turnId).toBe("fictional-next-turn"); expect(first.pending).toEqual([]); expect(first.fences).toEqual([]);
    expect(second.pending).toEqual([]); expect(second.fences).toEqual([]); expect(second.inspections).toBe(0);
    expect(first.inspections).toBe(phase === "canonical_stage_synced" ? 1 : 0); expect(f.retire).not.toHaveBeenCalled();
  }, 30000);
}
