import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createDurableHistoryStore } from "../durable-history.js";
import { NATIVE_HISTORY_ROOT_FILE, NATIVE_HISTORY_ROOT_TEMP } from "../native-history-root.js";
import { bucket, canonicalRecord, conversationKey, modelKey } from "./fixtures/canonical-v4-fixture.mjs";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const legacy = (id = bucket) => { const value = canonicalRecord(id); return { version: 3, conversationId: id, messages: value.messages, providerSession: value.providerSession, lastCommit: value.lastCommit }; };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-root-authority-")); roots.push(root);
  const path = join(root, `${conversationKey(bucket)}.history.json`); await writeFile(path, `${JSON.stringify(legacy())}\n`, { mode: 0o600 });
  const retire = vi.fn(async (_id: string, _key?: string) => {}), store = createDurableHistoryStore({ root, retireProviderSession: retire });
  return { root, path, retire, store };
}

it("requires explicit exclusive-writer acknowledgement and drained host ownership", async () => {
  const f = await fixture(), before = await readFile(f.path);
  await expect(f.store.acquireNativeHistoryAuthority(bucket, { exclusiveWriters: false } as never)).rejects.toThrow("exclusive upgraded writers");
  const active = await f.store.beginProviderSessionTurn("fictional-active", "fictional-active-turn", { modelKey });
  await expect(f.store.acquireNativeHistoryAuthority(bucket, { exclusiveWriters: true })).rejects.toThrow("drained host owners");
  expect(await readdir(f.root)).not.toContain(NATIVE_HISTORY_ROOT_FILE); expect(await readFile(f.path)).toEqual(before); await active.abort();
});

it("issues immutable bounded root authority without migrating canonical history or native files", async () => {
  const f = await fixture(), before = await readFile(f.path), initial = await f.store.stats();
  const lease = await f.store.acquireNativeHistoryAuthority(bucket, { exclusiveWriters: true }); if (lease.status !== "owned") throw new Error("Expected owned authority");
  await lease.assertOwned(); expect(Object.isFrozen(lease.authority)).toBe(true);
  const markerBytes = await readFile(join(f.root, NATIVE_HISTORY_ROOT_FILE)), marker = JSON.parse(markerBytes.toString());
  expect(marker.rootId).toBe(lease.authority.rootId); expect(markerBytes.byteLength).toBeLessThanOrEqual(1024);
  expect(lease.authority).toMatchObject({ version: 1, canonicalVersion: 4, ownerKey: bucket, historyBucket: bucket });
  expect(await readFile(f.path)).toEqual(before); expect(f.retire).not.toHaveBeenCalled();
  await lease.release(); await expect(lease.assertOwned()).rejects.toThrow("released");
  const fresh = createDurableHistoryStore({ root: f.root, retireProviderSession: f.retire });
  const replay = await fresh.acquireNativeHistoryAuthority(bucket, { exclusiveWriters: true }); if (replay.status !== "owned") throw new Error("Expected replay authority");
  expect(replay.authority).toEqual(lease.authority); await replay.release();
  expect(await readFile(join(f.root, NATIVE_HISTORY_ROOT_FILE))).toEqual(markerBytes);
  expect((await fresh.stats()).bytes).toBe(initial.bytes + markerBytes.byteLength);
});

it("refuses capacity before marker publication and preserves unknown proposals", async () => {
  const f = await fixture(), bytes = (await f.store.stats()).bytes;
  const low = createDurableHistoryStore({ root: f.root, maxStoreBytes: bytes, retireProviderSession: f.retire });
  await expect(low.acquireNativeHistoryAuthority(bucket, { exclusiveWriters: true })).rejects.toThrow("capacity unavailable");
  expect(await readdir(f.root)).not.toContain(NATIVE_HISTORY_ROOT_FILE);
  const proposal = join(f.root, `.native-history-root.${"1".repeat(32)}.tmp`); await writeFile(proposal, "Unknown fictional proposal", { mode: 0o600 });
  await expect(f.store.acquireNativeHistoryAuthority(bucket, { exclusiveWriters: true })).rejects.toThrow();
  expect(await readFile(proposal, "utf8")).toBe("Unknown fictional proposal");
  expect((await f.store.stats()).bytes).toBe(bytes + Buffer.byteLength("Unknown fictional proposal"));
});

it("fails closed on disappearance or replacement of a pinned root marker", async () => {
  const f = await fixture(), lease = await f.store.acquireNativeHistoryAuthority(bucket, { exclusiveWriters: true }); if (lease.status !== "owned") throw new Error("Expected authority");
  const path = join(f.root, NATIVE_HISTORY_ROOT_FILE), original = await readFile(path);
  await writeFile(path, JSON.stringify({ ...JSON.parse(original.toString()), rootId: "9".repeat(64) }), { mode: 0o600 });
  await expect(lease.assertOwned()).rejects.toThrow("unavailable"); await writeFile(path, original, { mode: 0o600 });
  await rm(path); await expect(lease.assertOwned()).rejects.toThrow("unavailable"); await writeFile(path, original, { mode: 0o600 }); await lease.release();
});

it.each(["append", "reset", "logical reset", "exclusive", "import", "admission"])("strictly rejects truncated managed v4 before %s can overwrite it as v3", async (action) => {
  const f = await fixture(), lease = await f.store.acquireNativeHistoryAuthority(bucket, { exclusiveWriters: true }); if (lease.status !== "owned") throw new Error("Expected authority");
  const value = canonicalRecord(); value.native.authority = { ...lease.authority }; await lease.release();
  await writeFile(f.path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const torn = Buffer.from(JSON.stringify(value).slice(0, -8)); await writeFile(f.path, torn, { mode: 0o600 });
  const fresh = createDurableHistoryStore({ root: f.root, retireProviderSession: f.retire });
  const operation = action === "append" ? fresh.append(bucket, []) : action === "reset" ? fresh.reset(bucket)
    : action === "logical reset" ? fresh.resetLogicalConversation(bucket) : action === "exclusive" ? fresh.contextImport!.beginExclusiveTurn(bucket)
    : action === "import" ? fresh.contextImport!.prepareImport(bucket, { text: "Fictional context.", idempotencyKey: "fictional-import", timestamp: "2000-01-01T00:00:00.000Z" })
    : fresh.beginProviderSessionTurn(bucket, "fictional-new-turn", { modelKey });
  await expect(operation).rejects.toThrow("not valid JSON"); expect(await readFile(f.path)).toEqual(torn); expect(f.retire).not.toHaveBeenCalled();
  await fresh.append("fictional-unrelated", [{ role: "user", content: "Fictional unrelated work." }]);
  expect(await readFile(f.path)).toEqual(torn);
});

it("does not let valid unresolved v4 fences block unrelated v1-v4 owners", async () => {
  const f = await fixture(); await writeFile(join(f.root, NATIVE_HISTORY_ROOT_FILE), JSON.stringify({ version: 1, kind: "native-history", canonicalVersion: 4, rootId: "1".repeat(64) }), { mode: 0o600 });
  await writeFile(f.path, `${JSON.stringify(canonicalRecord())}\n`, { mode: 0o600 });
  const original = await f.store.beginProviderSessionTurn(bucket, "fictional-abandoned", { modelKey }); await original.abort();
  const fencePath = join(f.root, ".locks", `${conversationKey(bucket)}.dirty.json`), fence = await readFile(fencePath), canonical = await readFile(f.path);
  for (const version of [1, 2, 3, 4]) {
    const id = `fictional-other-v${version}`, v4 = canonicalRecord(id), v3 = legacy(id);
    const value = version === 4 ? v4 : { version, conversationId: id, messages: v3.messages,
      ...(version === 1 ? {} : { providerSession: v3.providerSession }), ...(version === 3 ? { lastCommit: v3.lastCommit } : {}) };
    await writeFile(join(f.root, `${conversationKey(id)}.history.json`), `${JSON.stringify(value)}\n`, { mode: 0o600 });
    const turn = await f.store.beginProviderSessionTurn(id, `fictional-turn-v${version}`, { modelKey });
    await (await turn.prepareCommit([], { providerSessionSynced: true })).commit();
  }
  expect(await readFile(f.path)).toEqual(canonical); expect(await readFile(fencePath)).toEqual(fence);
  expect(f.retire.mock.calls.some(([id]) => id === original.providerSessionId)).toBe(false);
});

it("prunes legacy victims around protected v4 and never grows past count or byte quotas", async () => {
  const f = await fixture(); await writeFile(join(f.root, NATIVE_HISTORY_ROOT_FILE), JSON.stringify({ version: 1, kind: "native-history", canonicalVersion: 4, rootId: "1".repeat(64) }), { mode: 0o600 });
  await writeFile(f.path, `${JSON.stringify(canonicalRecord())}\n`, { mode: 0o600 });
  const canonical = await readFile(f.path), bounded = createDurableHistoryStore({ root: f.root, maxConversations: 2, maxStoreBytes: 8192, retireProviderSession: f.retire });
  for (let index = 0; index < 12; index++) {
    await bounded.append(`fictional-legacy-${index}`, [{ role: "assistant", content: "Fictional bounded answer." }]);
    const stats = await bounded.stats(); expect(stats.conversations).toBeLessThanOrEqual(2); expect(stats.bytes).toBeLessThanOrEqual(8192);
  }
  expect(await readFile(f.path)).toEqual(canonical);
  const low = createDurableHistoryStore({ root: f.root, maxStoreBytes: canonical.byteLength, retireProviderSession: f.retire });
  await expect(low.append("fictional-too-large", [{ role: "assistant", content: "x".repeat(1024) }])).rejects.toThrow("aggregate quota");
  expect(await readFile(f.path)).toEqual(canonical);
});

for (const phase of ["root_marker_file_synced", "root_marker_renamed", "root_marker_directory_synced", "root_marker_proposals_synced", "root_marker_proposal_removed"]) {
  it(`recovers root authority twice in fresh processes after SIGKILL at ${phase}`, async () => {
    const f = await fixture(), before = await readFile(f.path);
    if (phase === "root_marker_proposal_removed") {
      const lease = await f.store.acquireNativeHistoryAuthority(bucket, { exclusiveWriters: true }); if (lease.status !== "owned") throw new Error("Expected authority"); await lease.release();
      await writeFile(join(f.root, `.native-history-root.${"8".repeat(32)}.tmp`), await readFile(join(f.root, NATIVE_HISTORY_ROOT_FILE)), { mode: 0o600 });
    }
    const run = async (action: "issue" | "recover") => {
      const child = fork(new URL("./fixtures/native-history-root-worker.mjs", import.meta.url), [f.root, action, phase], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: ["--no-warnings"] });
      let stderr = ""; child.stderr!.on("data", (bytes) => { stderr += bytes; }); const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      try {
        const result: any = await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", (code) => reject(new Error(`Worker exited ${code}: ${stderr}`))); });
        expect(result.error).toBeUndefined(); const exit = once(child, "exit"); if (action === "issue") { expect(result.phase).toBe(phase); child.kill("SIGKILL"); }
        const [code, signal] = await exit; expect(action === "issue" ? signal : code).toBe(action === "issue" ? "SIGKILL" : 0); return result;
      } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    };
    await run("issue"); const first = await run("recover"), second = await run("recover"); expect(second).toEqual(first);
    expect(first.proposals).toEqual([]); expect(await readFile(f.path)).toEqual(before);
    expect(first.authority.rootId).toBe(first.marker.rootId); expect(f.retire).not.toHaveBeenCalled();
    expect((await readdir(f.root)).filter((name) => NATIVE_HISTORY_ROOT_TEMP.test(name))).toEqual([]);
  }, 30000);
}


it.each([false, true])("keeps unrelated append independent of unreadable canonicals (managed=%s)", async (managed) => {
  for (const bytes of ["{", "{}", JSON.stringify({ version: 99, conversationId: bucket }), JSON.stringify(legacy("fictional-wrong-file-id"))]) {
    const f = await fixture();
    if (managed) { const lease = await f.store.acquireNativeHistoryAuthority(bucket, { exclusiveWriters: true }); if (lease.status !== "owned") throw new Error("Expected authority"); await lease.release(); }
    await writeFile(f.path, bytes);
    await f.store.append("fictional-unrelated", [{ role: "assistant", content: "Independent valid history" }]);
    expect(await f.store.load("fictional-unrelated")).toHaveLength(1); expect(await readFile(f.path, "utf8")).toBe(bytes);
  }
});
it("does not deserialize existing legacy canonicals on an under-quota append", async () => {
  const f = await fixture();
  const spy = vi.spyOn(f.store as unknown as { readCommittedEntryRecord: (...args: unknown[]) => Promise<unknown> }, "readCommittedEntryRecord");
  await f.store.append("fictional-first", [{ role: "assistant", content: "First update" }]); expect(spy).not.toHaveBeenCalled();
  await Promise.all(Array.from({ length: 128 }, async (_, index) => {
    const id = `fictional-seeded-${index}`; await writeFile(join(f.root, `${conversationKey(id)}.history.json`), JSON.stringify(legacy(id)) + "\n", { mode: 0o600 });
  }));
  await f.store.append("fictional-next", [{ role: "assistant", content: "Next update" }]); expect(spy).not.toHaveBeenCalled();
});

it.each([false, true])("retains the previous unmanaged retirement-fence failure policy (managed=%s)", async (managed) => {
  const f = await fixture();
  if (managed) { const lease = await f.store.acquireNativeHistoryAuthority(bucket, { exclusiveWriters: true }); if (lease.status !== "owned") throw new Error("Expected authority"); await lease.release(); }
  const interrupted = await f.store.beginProviderSessionTurn(bucket, "fictional-interrupted", { modelKey }); await interrupted.abort();
  await writeFile(f.path, "{");
  const append = f.store.append("fictional-independent", [{ role: "assistant", content: "Independent update" }]);
  if (managed) await append;
  else await expect(append).rejects.toThrow("not valid JSON");
  expect(f.retire).not.toHaveBeenCalled(); expect(await readFile(f.path, "utf8")).toBe("{");
  expect((await readdir(join(f.root, ".locks"))).some((name) => name.endsWith(".dirty.json"))).toBe(true);
});
