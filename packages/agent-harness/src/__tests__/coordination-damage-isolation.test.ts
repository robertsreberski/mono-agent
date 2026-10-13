import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDurableHistoryStore } from "../durable-history.js";
import { OwnedFileDamagedError } from "@mono-agent/harness/owned-fs.js";
import { PendingTurnPayloadStore } from "../durable-turn-payloads.js";

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof fs>() }));
const roots: string[] = [];
const key = (id: string) => createHash("sha256").update("mono-agent-history-v1\0").update(id).digest("hex");
const owner = "fictional-owner", sibling = "fictional-sibling", victim = "fictional-victim";
const message = [{ role: "user" as const, content: "Fictional history." }];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "coordination-damage-")); roots.push(root);
  const store = createDurableHistoryStore({ root, maxConversations: 2, maxStoreBytes: 2 ** 40, maxStagedBytes: 2 ** 40, now: () => 10_000 });
  await store.append(owner, message); await store.append(victim, message);
  await fs.utimes(join(root, `${key(owner)}.history.json`), 1, 1);
  await fs.utimes(join(root, `${key(victim)}.history.json`), 2, 2);
  return { root, store };
}
const artifacts = {
  lock: (root: string) => join(root, ".locks", `${key(owner)}.sqlite`),
  active: (root: string) => join(root, ".locks", `${key(owner)}.1073741824.${"a".repeat(32)}.active`),
  fence: (root: string) => join(root, ".locks", `${key(owner)}.dirty.json`),
  temporary: (root: string) => join(root, ".locks", `.${key(owner)}.1073741824.${"a".repeat(24)}.dirty.tmp`),
  lifecycle: (root: string) => join(root, `.native-history-op.${key(owner)}.json`),
};
for (const [kind, artifact] of Object.entries(artifacts)) {
  it.each(["malformed", "insecure", "oversized", "read failure"])(`${kind}: %s damage refuses only its owner, stays charged and survives retention`, async (damage) => {
    const { root, store } = await fixture(), path = artifact(root);
    await fs.writeFile(path, "{broken", { mode: 0o600 });
    if (damage === "insecure") await fs.chmod(path, 0o644);
    if (damage === "oversized") await fs.truncate(path, 2 ** 28); // sparse, above every owner-artifact cap
    const before = await fs.lstat(path);
    if (damage === "read failure") {
      const original = fs.open;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (String(args[0]) === path) throw Object.assign(new Error("Injected entry read failure"), { code: "EIO" });
        return original(...args);
      });
      // SQLite reads through its own connection, never a raw descriptor. Fail its metadata probe instead.
      if (kind === "lock") {
        const stat = fs.lstat;
        vi.spyOn(fs, "lstat").mockImplementation(((...args: Parameters<typeof fs.lstat>) => {
          if (String(args[0]) === path) return Promise.reject(Object.assign(new Error("Injected lock metadata failure"), { code: "EIO" }));
          return stat(...args);
        }) as typeof fs.lstat);
      }
    }
    await expect(store.append(owner, message)).rejects.toThrow();
    await store.append(sibling, message);
    expect(await store.load(sibling)).toEqual(message);
    expect(await store.load(owner)).toEqual(message);
    await expect(fs.lstat(join(root, `${key(victim)}.history.json`))).rejects.toMatchObject({ code: "ENOENT" });
    const canonicalBytes = (await Promise.all([owner, sibling].map((id) => fs.lstat(join(root, `${key(id)}.history.json`))))).reduce((n, info) => n + info.size, 0);
    expect((await store.stats()).bytes).toBeGreaterThanOrEqual(canonicalBytes + before.size);
    vi.restoreAllMocks();
    const after = await fs.lstat(path);
    expect([after.ino, after.size, after.mode, after.mtimeMs]).toEqual([before.ino, before.size, before.mode, before.mtimeMs]);
    if (damage !== "oversized") expect(await fs.readFile(path, "utf8")).toBe("{broken");
  });
}

it("ignores retired conversation shards without deleting or validating an older writer's inode", async () => {
  const { root, store } = await fixture(), path = join(root, ".locks", "conversation-shard-00.sqlite");
  await fs.writeFile(path, "old writer evidence", { mode: 0o644 });
  const before = await fs.lstat(path);
  await store.append(sibling, message);
  expect((await fs.lstat(path)).ino).toBe(before.ino);
  expect(await fs.readFile(path, "utf8")).toBe("old writer evidence");
});

it.each(["root.sqlite", "logical-session-shard-00.sqlite", ".native-history-root.json"])("shared %s damage still refuses both owners", async (name) => {
  const { root, store } = await fixture(), path = join(root, name.endsWith(".sqlite") ? ".locks" : "", name);
  if (name.endsWith(".json")) await fs.writeFile(path, "{broken", { mode: 0o600 });
  else await fs.chmod(path, 0o644);
  for (const id of [owner, sibling]) await expect(store.append(id, message)).rejects.toThrow();
});

it.each(["root", "locks"])("rechecks the pinned %s before classifying a marker read failure as local damage", async (directory) => {
  const { root, store } = await fixture(), path = artifacts.active(root), target = directory === "root" ? root : join(root, ".locks");
  await fs.writeFile(path, "{broken", { mode: 0o600 });
  const original = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (String(args[0]) === path) {
      await fs.chmod(target, 0o755);
      throw Object.assign(new Error("Injected entry read failure"), { code: "EIO" });
    }
    return original(...args);
  });
  await expect(store.append(sibling, message)).rejects.toThrow(/0700/);
  vi.restoreAllMocks(); await fs.chmod(target, 0o700);
});

async function bootstrapFixture() {
  const { root, store } = await fixture(), directory = join(root, ".pending-turns");
  const turn = await store.beginProviderSessionTurn(sibling, "fictional-binding", { modelKey: "openai:fictional-model" });
  await (await turn.prepareCommit(message, { providerSessionSynced: true })).commit();
  await fs.mkdir(directory, { mode: 0o700 });
  const name = `${key("fictional-orphan")}.${"b".repeat(64)}.${"c".repeat(32)}.json`, path = join(directory, name);
  await fs.writeFile(path, "{broken", { mode: 0o600 });
  return { root, store, directory, name, path };
}
it("bootstrap removes an entry that vanishes after discovery from its pending set", async () => {
  const f = await bootstrapFixture(), inspect = PendingTurnPayloadStore.prototype.inspect;
  vi.spyOn(PendingTurnPayloadStore.prototype, "inspect").mockImplementation(async function (this: PendingTurnPayloadStore, entry, digest) {
    await fs.rm(f.path); return inspect.call(this, entry, digest);
  });
  const lease = await f.store.acquireNativeHistoryAuthority(sibling);
  expect(lease.status).toBe("owned"); if (lease.status === "owned") await lease.release();
});
it("bootstrap names the malformed pending artifact by basename", async () => {
  const f = await bootstrapFixture();
  await expect(f.store.acquireNativeHistoryAuthority(sibling)).rejects.toMatchObject({ code: "ERR_NATIVE_HISTORY_AUTHORITY_DAMAGED", message: expect.stringContaining(`(${f.name})`) });
  expect(await fs.readFile(f.path, "utf8")).toBe("{broken");
});
it.each(["EMFILE", "EIO"])("bootstrap propagates wrapped %s without losing its cause or reporting damage", async (code) => {
  const f = await bootstrapFixture(), cause = Object.assign(new Error("Injected operational error"), { code }), error = new OwnedFileDamagedError(f.name, cause);
  vi.spyOn(PendingTurnPayloadStore.prototype, "inspect").mockRejectedValue(error);
  await expect(f.store.acquireNativeHistoryAuthority(sibling)).rejects.toBe(error);
  expect(error.cause).toBe(cause);
});
it("bootstrap rechecks the pinned pending directory before isolating an inspection failure", async () => {
  const f = await bootstrapFixture();
  vi.spyOn(PendingTurnPayloadStore.prototype, "inspect").mockImplementation(async () => {
    await fs.rename(f.directory, `${f.directory}-old`); await fs.mkdir(f.directory, { mode: 0o700 });
    throw new OwnedFileDamagedError(f.name);
  });
  await expect(f.store.acquireNativeHistoryAuthority(sibling)).rejects.toThrow("Pending turn storage identity or permissions unavailable");
});
