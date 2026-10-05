import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { PendingTurnPayloadStore, pendingCoordinates } from "../durable-turn-payloads.js";
import { createPendingTurnPayload, serializeDurableTurnFence } from "../durable-turn-contract.js";

const fault = vi.hoisted(() => ({ removePath: "", syncPath: "" }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (args[0] === fault.removePath) { fault.removePath = ""; throw new Error("injected pending cleanup failure"); }
      return await actual.rm(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[0] === fault.syncPath) {
        fault.syncPath = "";
        handle.sync = async () => { throw Object.assign(new Error("injected pending directory fsync ENOSPC"), { code: "ENOSPC" }); };
      }
      return handle;
    },
  };
});
const { createDurableHistoryStore } = await import("../durable-history.js");
const dirs: string[] = [];
const hash = "a".repeat(64), modelKey = "openai:fictional-model";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pending-reset-test-")); dirs.push(root);
  const retireProviderSession = vi.fn(async (_id: string, _modelKey?: string) => undefined);
  const store = createDurableHistoryStore({ root, retireProviderSession });
  // Establish the real lock namespace/ownership machinery, not a fake store.
  const seed = await store.beginProviderSessionTurn("namespace-seed", "fictional-seed", { modelKey });
  await (await seed.prepareCommit([], { providerSessionSynced: true })).commit();
  const payloads = new PendingTurnPayloadStore(root, await lstat(root));
  const publish = async (bucket: string, turnId: string, purpose: "execution" | "compaction" = "execution", withFence = true) => {
    const identity = { purpose, ownerKey: bucket.replace(/#\d{4}-\d{2}-\d{2}$/u, ""), historyBucket: bucket, turnId,
      handleId: hash, modelKey, baseRevision: 0, fenceDigest: hash };
    const payload = createPendingTurnPayload(identity, purpose === "compaction" ? [] : [{ kind: "initial", id: "fictional-input", placement: "initial",
      requestDigest: hash, persistText: "Fictional reset input.", timestamp: "2026-01-01T00:00:00.000Z" }], "admitted");
    // Publication fixture owns no model/tool; store mutation itself acquires real owners.
    const pointer = await payloads.publish(payload, { assertOwned: async () => undefined, reserve: async () => undefined });
    const coordinates = pendingCoordinates(identity), path = join(root, ".locks", `${coordinates.conversationKey}.dirty.json`);
    if (withFence) await writeFile(path, serializeDurableTurnFence({ version: 5, kind: purpose, ...coordinates,
      logicalConversationKey: pendingCoordinates({ historyBucket: identity.ownerKey, turnId }).conversationKey,
      epoch: hash, providerSessionId: hash, modelKey, revision: 0, payload: pointer }), { mode: 0o600 });
    return { coordinates, path, pointer };
  };
  return { root, store, payloads, publish, retireProviderSession };
}
afterEach(async () => {
  fault.removePath = ""; fault.syncPath = "";
  await Promise.all(dirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(["execution", "compaction"] as const)("explicit physical reset removes every %s generation and leaves siblings intact", async (purpose) => {
  const f = await fixture(); const pending = await f.publish("fictional-reset", "fictional-turn", purpose);
  await f.publish("fictional-reset", "fictional-turn", purpose); // Older and current same-run generations.
  await f.publish("fictional-reset", "fictional-orphan-turn", purpose, false); // No active marker/fence needed for accounting.
  const sibling = await f.publish("fictional-sibling", "fictional-sibling-turn");
  f.retireProviderSession.mockImplementation(async () => {
    // The reset intent is durable and explicitly non-adoptable before deletion.
    expect(JSON.parse(await readFile(pending.path, "utf8"))).toMatchObject({ version: 5, kind: "retirement" });
    expect(JSON.parse(await readFile(pending.path, "utf8"))).not.toHaveProperty("payload");
    expect((await f.payloads.list()).filter((entry) => entry.conversationKey === pending.coordinates.conversationKey)).toHaveLength(3);
  });
  await f.store.reset("fictional-reset");
  expect(f.retireProviderSession).toHaveBeenCalledWith(hash, modelKey);
  expect(await f.store.load("fictional-reset")).toEqual([]);
  await expect(readFile(pending.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.payloads.list()).toEqual([expect.objectContaining(sibling.coordinates)]);
});

it("logical reset finds dirty-only and orphan-only rollover buckets and preserves other owners", async () => {
  const f = await fixture();
  const dirty = await f.publish("fictional-logical#2026-01-01", "fictional-dirty-turn");
  const orphan = await f.publish("fictional-logical#2026-01-02", "fictional-orphan-turn", "execution", false);
  const sibling = await f.publish("fictional-other#2026-01-01", "fictional-other-turn");
  await f.store.resetLogicalConversation("fictional-logical");
  expect(await f.payloads.list()).toEqual([expect.objectContaining(sibling.coordinates)]);
  await expect(readFile(dirty.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.store.load("fictional-logical#2026-01-01")).toEqual([]);
  expect(await f.store.load("fictional-logical#2026-01-02")).toEqual([]);
  expect((await readdir(f.root)).filter((name) => name.endsWith(".history.json"))).toEqual(expect.arrayContaining([
    `${dirty.coordinates.conversationKey}.history.json`, `${orphan.coordinates.conversationKey}.history.json`,
  ]));
});

it("keeps a non-adoptable reset intent and all payloads when native retirement fails, then retries", async () => {
  const f = await fixture(); const pending = await f.publish("fictional-reset", "fictional-turn");
  f.retireProviderSession.mockRejectedValueOnce(new Error("fictional native retirement unavailable"));
  await expect(f.store.reset("fictional-reset")).rejects.toThrow("native retirement unavailable");
  expect(JSON.parse(await readFile(pending.path, "utf8"))).toMatchObject({ kind: "retirement" });
  expect(await f.payloads.list()).toHaveLength(1);
  await f.store.reset("fictional-reset"); expect(await f.payloads.list()).toEqual([]);
  await expect(readFile(pending.path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses explicit pending reset without fail-closed native retirement", async () => {
  const f = await fixture(); const pending = await f.publish("fictional-reset", "fictional-turn"); const before = await readFile(pending.path);
  const unconfigured = createDurableHistoryStore({ root: f.root });
  await expect(unconfigured.reset("fictional-reset")).rejects.toThrow("fail-closed provider retirement");
  expect(await readFile(pending.path)).toEqual(before); expect(await f.payloads.list()).toHaveLength(1);
});

it.each(["unlink", "directory-fsync"])("keeps canonical reset committed when post-commit payload %s fails, reports it, and retries cleanup", async (phase) => {
  const f = await fixture(); const pending = await f.publish("fictional-reset", "fictional-turn");
  const entries = await f.payloads.list();
  if (phase === "unlink") fault.removePath = join(f.root, ".pending-turns", entries[0]!.name);
  else fault.syncPath = join(f.root, ".pending-turns");
  await f.store.reset("fictional-reset");
  expect(await f.store.load("fictional-reset")).toEqual([]);
  expect((await f.store.stats()).lastPostCommitMaintenanceError).toContain("injected pending");
  expect(JSON.parse(await readFile(pending.path, "utf8"))).toMatchObject({ kind: "retirement" });
  await f.store.reset("fictional-reset"); expect(await f.payloads.list()).toEqual([]);
  await expect(readFile(pending.path)).rejects.toMatchObject({ code: "ENOENT" });
});

function worker(root: string): ChildProcess {
  return fork(new URL("./fixtures/pending-reset-worker.mjs", import.meta.url), [root], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
}
function message(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let stderr = ""; child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`Reset worker IPC timed out: ${stderr}`)); }, 10_000);
    const onMessage = (value: unknown) => { cleanup(); resolve(value); };
    const onExit = (code: number | null) => { cleanup(); reject(new Error(`Reset worker exited ${code}: ${stderr}`)); };
    const cleanup = () => { clearTimeout(timeout); child.off("message", onMessage); child.off("exit", onExit); };
    child.once("message", onMessage); child.once("exit", onExit);
  });
}
it("survives SIGKILL after reset intent durability and completes deletion in two empty fresh processes", async () => {
  const f = await fixture(); const pending = await f.publish("fictional-reset", "fictional-turn");
  await f.publish("fictional-reset", "fictional-orphan-turn", "execution", false);
  let child: ChildProcess | undefined;
  try {
    child = worker(f.root); const ready = message(child);
    child.send({ mode: "reset-stop", conversationId: "fictional-reset" });
    await expect(ready).resolves.toEqual({ phase: "retirement-intent-durable" });
    expect(JSON.parse(await readFile(pending.path, "utf8"))).toMatchObject({ kind: "retirement" });
    expect(await f.payloads.list()).toHaveLength(2);
    const killed = once(child, "exit"); child.kill("SIGKILL"); await killed;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      child = worker(f.root); const reply = message(child), exited = once(child, "exit");
      child.send({ mode: "reset", conversationId: "fictional-reset" });
      await expect(reply).resolves.toMatchObject({ history: [], pending: [] });
      expect((await exited)[0]).toBe(0);
    }
    await expect(readFile(pending.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  }
}, 20_000);

it("fails closed on an unattributable partial orphan during logical discovery without deleting any owner", async () => {
  const f = await fixture(); const own = await f.publish("fictional-logical#2026-01-01", "fictional-own-turn");
  await f.publish("fictional-other#2026-01-01", "fictional-partial-turn", "execution", false);
  const other = (await f.payloads.list()).find((entry) => entry.conversationKey !== own.coordinates.conversationKey)!;
  await writeFile(join(f.root, ".pending-turns", other.name), '{"version":', { mode: 0o600 });
  const before = await readFile(own.path);
  await expect(f.store.resetLogicalConversation("fictional-logical")).rejects.toThrow();
  expect(await readFile(own.path)).toEqual(before); expect(await f.payloads.list()).toHaveLength(2);
  expect(f.retireProviderSession).not.toHaveBeenCalled();
});
