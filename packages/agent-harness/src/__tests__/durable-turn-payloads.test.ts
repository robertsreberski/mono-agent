import { createDurableHistoryStore } from "../durable-history.js";
import { link, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fork } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { PendingTurnPayloadStore, pendingCoordinates } from "../durable-turn-payloads.js";
import type { PendingPayloadOwner } from "../durable-turn-payloads.js";
import { pendingPayloadName, serializeDurableTurnFence } from "../durable-turn-contract.js";
import type { PendingTurnPayload } from "../durable-turn-contract.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))); });
const payload = (text = "Fictional canonical input.", turnId = "fictional-turn"): PendingTurnPayload => ({ version: 1,
  identity: { purpose: "execution", ownerKey: "fictional-owner", historyBucket: "fictional-bucket", turnId, handleId: "a".repeat(64), modelKey: "openai:fictional-model", baseRevision: 0, fenceDigest: "a".repeat(64) },
  inputs: [{ kind: "initial", id: "initial", placement: "initial", requestDigest: "b".repeat(64), persistText: text, timestamp: "2026-01-01T00:00:00.000Z" }], disposition: "admitted" });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pending-payload-test-")); roots.push(root);
  const info = await lstat(root); const store = new PendingTurnPayloadStore(root, info);
  const owner: PendingPayloadOwner = { assertOwned: vi.fn(async () => {}), reserve: vi.fn(async () => {}) };
  return { root, store, owner };
}
it("publishes immutable file and namespace before returning a replaceable fence pointer", async () => {
  const { root, store, owner } = await fixture(), value = payload(); const phases: string[] = [];
  owner.onPhase = async (phase) => { phases.push(phase); };
  const first = await store.publish(value, owner), second = await store.publish(payload("Fictional updated canonical input."), owner);
  expect(first.generation).not.toBe(second.generation); expect(phases).toEqual(["file_synced", "directory_synced", "file_synced", "directory_synced"]);
  expect(await store.read(first, value.identity)).toEqual(value); expect(await store.read(second, value.identity)).toEqual(payload("Fictional updated canonical input."));
  const entries = await store.list(); expect(entries).toHaveLength(2); expect(entries.reduce((n, e) => n + e.bytes, 0)).toBeGreaterThan(0);
  expect((await lstat(join(root, ".pending-turns"))).mode & 0o777).toBe(0o700);
  expect(owner.reserve).toHaveBeenCalledTimes(2); expect(owner.assertOwned).toHaveBeenCalled();
});
it("leaves an orphan charged on pointer-window failure and collects only this exact owner/run", async () => {
  const { root, store, owner } = await fixture(), value = payload(); const first = await store.publish(value, owner);
  const sibling = payload("Fictional sibling input.", "other-turn"), siblingPointer = await store.publish(sibling, owner);
  owner.onPhase = async (phase) => { if (phase === "directory_synced") throw new Error("Fictional fault before pointer replacement"); };
  await expect(store.publish(payload("Fictional orphan generation."), owner)).rejects.toThrow("before pointer");
  expect(await store.list()).toHaveLength(3); expect(await store.read(first, value.identity)).toEqual(value);
  delete owner.onPhase;
  expect(await store.collectUnreferenced(pendingCoordinates(value.identity), [first], owner)).toBe(1);
  expect(await store.list()).toHaveLength(2); expect(await store.read(siblingPointer, sibling.identity)).toEqual(sibling);
  expect((await readdir(join(root, ".pending-turns"))).length).toBe(2);
});
it("reserves before publication and refuses lost ownership without deleting the previous generation", async () => {
  const { store, owner } = await fixture(), value = payload(); const first = await store.publish(value, owner);
  owner.reserve = async () => { throw new Error("Fictional staged-byte quota exhausted"); };
  await expect(store.publish(value, owner)).rejects.toThrow("quota"); expect(await store.list()).toHaveLength(1);
  owner.reserve = async () => {}; owner.onPhase = async () => { owner.assertOwned = async () => { throw new Error("Fictional ownership lost"); }; };
  await expect(store.publish(value, owner)).rejects.toThrow("ownership lost"); expect(await store.list()).toHaveLength(2);
  expect(await store.read(first, value.identity)).toEqual(value); await expect(store.collectUnreferenced(pendingCoordinates(value.identity), [], owner)).rejects.toThrow("ownership lost");
});
it("checks expected identity/digest without altering referenced bytes", async () => {
  const { root, store, owner } = await fixture(), value = payload(); const pointer = await store.publish(value, owner);
  const coordinates = pendingCoordinates(value.identity), path = join(root, ".pending-turns", pendingPayloadName(coordinates.conversationKey, coordinates.runIdDigest, pointer.generation));
  const bytes = await readFile(path);
  await expect(store.read(pointer, { ...value.identity, ownerKey: "foreign-owner" })).rejects.toThrow("owner/binding");
  await expect(store.read({ ...pointer, sha256: "c".repeat(64) }, value.identity)).rejects.toThrow("digest mismatch"); expect(await readFile(path)).toEqual(bytes);
  await writeFile(path, Buffer.concat([bytes, Buffer.from(" ")])); await expect(store.read(pointer, value.identity)).rejects.toThrow("digest mismatch");
});
it("rejects symlink/hardening failures, traversal pointers and unknown namespace entries", async () => {
  const { root, store, owner } = await fixture(), value = payload(); const pointer = await store.publish(value, owner);
  const [entry] = await store.list(), path = join(root, ".pending-turns", entry!.name), real = join(root, "fixture-target");
  await rename(path, real); await symlink(real, path); await expect(store.read(pointer, value.identity)).rejects.toThrow("permissions"); await rm(path); await rename(real, path);
  await chmod(path, 0o644); await expect(store.list()).rejects.toThrow("permissions"); await chmod(path, 0o600);
  await expect(store.read({ ...pointer, generation: "../foreign" }, value.identity)).rejects.toThrow();
  await writeFile(join(root, ".pending-turns", "unknown"), "Fictional unknown artifact."); await expect(store.list()).rejects.toThrow("Unsupported");
});
it("pins the root and pending directory so reset/replacement cannot resurrect a late generation", async () => {
  const { root, store, owner } = await fixture(), value = payload(); await store.publish(value, owner);
  await rename(join(root, ".pending-turns"), join(root, "old-pending")); await mkdir(join(root, ".pending-turns"), { mode: 0o700 });
  await expect(store.publish(value, owner)).rejects.toThrow("identity"); expect(await readdir(join(root, ".pending-turns"))).toEqual([]);
  await rm(join(root, ".pending-turns"), { recursive: true }); await expect(store.publish(value, owner)).rejects.toMatchObject({ code: "ENOENT" });
});
it("never creates pending storage for read-only absent list", async () => {
  const { root, store } = await fixture(); expect(await store.list()).toEqual([]); expect(await readdir(root)).toEqual([]);
});
it("survives SIGKILL after payload namespace durability before fence pointer update in empty fresh processes", async () => {
  const { root, store, owner } = await fixture(), value = payload(); const pointer = await store.publish(value, owner);
  const script = new URL("./fixtures/pending-payload-worker.mjs", import.meta.url);
  const child = fork(script, [root], { stdio: ["ignore", "pipe", "pipe", "ipc"] }); let errors = ""; child.stderr?.on("data", (chunk) => { errors += String(chunk); });
  const durable = once(child, "message"); child.send({ mode: "publish-stop", value: payload("Fictional crash-window generation.") }); const [message] = await durable; expect(message).toMatchObject({ phase: "directory_synced" });
  const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; expect(errors).toBe(""); expect(await store.read(pointer, value.identity)).toEqual(value);
  const recover = async () => {
    const fresh = fork(script, [root], { stdio: ["ignore", "pipe", "pipe", "ipc"] }); let stderr = ""; fresh.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const response = once(fresh, "message"), ended = once(fresh, "exit"); fresh.send({ mode: "read-collect", pointer, value }); const [row] = await response; await ended; expect(stderr).toBe(""); return row;
  };
  expect(await recover()).toMatchObject({ payload: value, removed: 1, generations: 1 }); expect(await recover()).toMatchObject({ payload: value, removed: 0, generations: 1 });
});

it("preserves referenced payloads and removes an unpublished temp after ENOSPC at durability", async () => {
  const { store, owner } = await fixture(), value = payload(); const first = await store.publish(value, owner);
  owner.onPhase = async (phase) => { if (phase === "file_synced") throw Object.assign(new Error("Fictional ENOSPC durability fault"), { code: "ENOSPC" }); };
  await expect(store.publish(value, owner)).rejects.toMatchObject({ code: "ENOSPC" });
  expect(await store.read(first, value.identity)).toEqual(value); const entries = await store.list(); expect(entries).toHaveLength(1); expect(entries[0]!.name).not.toMatch(/\.tmp$/u);
});
it("rejects a hard-linked generation and root replacement without recreating data", async () => {
  const { root, store, owner } = await fixture(), value = payload(); await store.publish(value, owner);
  const [entry] = await store.list(), path = join(root, ".pending-turns", entry!.name), alias = join(root, "hardlink-fixture");
  await link(path, alias); await expect(store.list()).rejects.toThrow("permissions"); await rm(alias);
  const oldRoot = `${root}-old`; roots.push(oldRoot); await rename(root, oldRoot); await mkdir(root, { mode: 0o700 });
  await expect(store.publish(value, owner)).rejects.toThrow("identity"); expect(await readdir(root)).toEqual([]);
});
it("refuses a denied owner before directory creation or capacity reservation", async () => {
  const { root, store, owner } = await fixture(); owner.assertOwned = async () => { throw new Error("Fictional foreign ownership"); };
  await expect(store.publish(payload(), owner)).rejects.toThrow("foreign ownership"); expect(owner.reserve).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
});

it("charges published pending generations to history staging quota without deleting them when markers are absent", async () => {
  const { root, store, owner } = await fixture(), value = payload(); const pointer = await store.publish(value, owner);
  const history = createDurableHistoryStore({ root, maxStagedBytes: 1 });
  await expect(history.prepareAppend(value.identity.historyBucket, [{ role: "user", content: "Fictional canonical append." }])).rejects.toThrow("staging quota");
  expect(await store.read(pointer, value.identity)).toEqual(value); expect(await store.list()).toHaveLength(1);
});
it("accepts the secure pending namespace while load remains read-only and recovery-free", async () => {
  const { root, store, owner } = await fixture(), value = payload(); const pointer = await store.publish(value, owner);
  const history = createDurableHistoryStore({ root });
  await history.append("other-bucket", [{ role: "user", content: "Fictional other history." }]);
  const before = await readdir(join(root, ".pending-turns")), stats = await history.stats(); expect(stats.conversations).toBe(1);
  expect(await history.load(value.identity.historyBucket)).toEqual([]); expect(await readdir(join(root, ".pending-turns"))).toEqual(before); expect(await store.read(pointer, value.identity)).toEqual(value);
});

it.each(["execution", "compaction"] as const)("preserves a new %s fence against legacy admission/plain append/import and maintenance", async (kind) => {
  const { root, store, owner } = await fixture(), base = payload();
  const value: PendingTurnPayload = kind === "compaction" ? { ...base, identity: { ...base.identity, purpose: "compaction" }, inputs: [] } : base;
  const retired = vi.fn(async () => {});
  const history = createDurableHistoryStore({ root, retireProviderSession: retired });
  await history.append(value.identity.historyBucket, [{ role: "user", content: "Fictional prior canonical history." }]); const pointer = await store.publish(value, owner);
  const coordinates = pendingCoordinates(value.identity), path = join(root, ".locks", `${coordinates.conversationKey}.dirty.json`);
  const logicalConversationKey = coordinates.conversationKey;
  const bytes = serializeDurableTurnFence({ version: 5, kind, conversationKey: coordinates.conversationKey, logicalConversationKey, epoch: "a".repeat(64), providerSessionId: "b".repeat(64), modelKey: value.identity.modelKey, revision: 0, runIdDigest: coordinates.runIdDigest, payload: pointer });
  await writeFile(path, bytes, { mode: 0o600 }); const count = retired.mock.calls.length;
  expect(await history.load(value.identity.historyBucket)).toMatchObject([{ content: "Fictional prior canonical history." }]); expect(await readFile(path)).toEqual(bytes); expect(retired).toHaveBeenCalledTimes(count);
  await expect(history.beginProviderSessionTurn(value.identity.historyBucket, "new-turn", { modelKey: value.identity.modelKey })).rejects.toThrow("owner-held reconciliation");
  await expect(history.append(value.identity.historyBucket, [{ role: "assistant", content: "Fictional later delivery." }])).rejects.toThrow("owner-held reconciliation");
  await expect(history.contextImport!.beginExclusiveTurn(value.identity.historyBucket)).rejects.toThrow("owner-held reconciliation");
  await expect(history.contextImport!.prepareImport(value.identity.historyBucket, { text: "Fictional imported output.", idempotencyKey: "fictional-import", timestamp: "2026-01-01T00:00:00.000Z" })).rejects.toThrow("owner-held reconciliation");
  await history.append("other-bucket", [{ role: "user", content: "Fictional unrelated turn." }]);
  expect(await readFile(path)).toEqual(bytes); expect(await store.read(pointer, value.identity)).toEqual(value); expect(retired).toHaveBeenCalledTimes(count);
});
