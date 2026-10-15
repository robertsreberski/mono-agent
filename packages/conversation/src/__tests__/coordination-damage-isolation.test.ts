import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createDurableHistoryStore } from "../durable-history.js";
import { OwnedFileDamagedError } from "@mono-agent/turn/engine/owned-fs.js";
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
  it.each(["malformed", "insecure", "oversized", "read failure"])(`${kind}: %s evidence refuses only its owner, stays charged and survives retention`, async (damage) => {
    const { root, store } = await fixture();
    // A live writer may still finish a torn marker/temp; only dead torn files are reclaimable.
    const path = damage === "malformed" ? artifact(root).replace(".1073741824.", `.${process.pid}.`) : artifact(root);
    await fs.writeFile(path, "{broken", { mode: 0o600 });
    if (damage === "insecure") await fs.chmod(path, 0o644);
    if (damage === "oversized") await fs.truncate(path, 2 ** 28); // sparse, above every owner-artifact cap
    const before = await fs.lstat(path);
    if (damage === "read failure") {
      const original = fs.open;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (String(args[0]) === path) throw Object.assign(new Error("Injected entry read failure"), { code: "EACCES" });
        return original(...args);
      });
      // SQLite reads through its own connection, never a raw descriptor. Fail its metadata probe instead.
      if (kind === "lock") {
        const stat = fs.lstat;
        vi.spyOn(fs, "lstat").mockImplementation(((...args: Parameters<typeof fs.lstat>) => {
          if (String(args[0]) === path) return Promise.reject(Object.assign(new Error("Injected lock metadata failure"), { code: "EACCES" }));
          return stat(...args);
        }) as typeof fs.lstat);
      }
    }
    await expect(store.append(owner, message)).rejects.toThrow();
    if (!(damage === "malformed" && (kind === "active" || kind === "temporary"))) {
      const canonical = await fs.readFile(join(root, `${key(owner)}.history.json`));
      for (const reset of [() => store.reset(owner), () => store.resetLogicalConversation(owner)]) {
        await expect(reset()).rejects.toMatchObject({ code: "ERR_HISTORY_RESET_DAMAGED", retryable: false, message: expect.stringContaining(basename(path)) });
      }
      expect(await store.load(owner)).toEqual(message);
      expect(await fs.readFile(join(root, `${key(owner)}.history.json`))).toEqual(canonical);
    }
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
  for (const id of [owner, sibling]) {
    await expect(store.append(id, message)).rejects.toThrow();
    await expect(store.reset(id)).rejects.toMatchObject({ code: "ERR_HISTORY_RESET_DAMAGED", retryable: false, message: expect.stringContaining(name) });
  }
});

it.each(["root", "locks"])("rechecks the pinned %s before classifying a marker read failure as local damage", async (directory) => {
  const { root, store } = await fixture(), path = artifacts.active(root), target = directory === "root" ? root : join(root, ".locks");
  await fs.writeFile(path, "{broken", { mode: 0o600 });
  const original = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (String(args[0]) === path) {
      await fs.chmod(target, 0o755);
      throw Object.assign(new Error("Injected entry read failure"), { code: "EACCES" });
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
it("bootstrap preserves malformed unrelated pending evidence without opening it", async () => {
  const f = await bootstrapFixture(), inspect = vi.spyOn(PendingTurnPayloadStore.prototype, "inspect");
  const lease = await f.store.acquireNativeHistoryAuthority(sibling);
  expect(lease.status).toBe("owned"); if (lease.status === "owned") await lease.release();
  expect(inspect).not.toHaveBeenCalled();
  expect(await fs.readFile(f.path, "utf8")).toBe("{broken");
});
it.each(["EMFILE", "EIO"])("bootstrap does not probe unrelated pending contents that could fail with %s", async (code) => {
  const f = await bootstrapFixture(), error = new OwnedFileDamagedError(f.name, Object.assign(new Error("Injected operational error"), { code }));
  const inspect = vi.spyOn(PendingTurnPayloadStore.prototype, "inspect").mockRejectedValue(error);
  const lease = await f.store.acquireNativeHistoryAuthority(sibling);
  expect(lease.status).toBe("owned"); if (lease.status === "owned") await lease.release();
  expect(inspect).not.toHaveBeenCalled();
});
it("bootstrap still refuses damaged shared pending-directory permissions", async () => {
  const f = await bootstrapFixture(); await fs.chmod(f.directory, 0o755);
  await expect(f.store.acquireNativeHistoryAuthority(sibling)).rejects.toThrow("Pending turn storage identity or permissions unavailable");
  await fs.chmod(f.directory, 0o700);
});

for (const [kind, artifact] of Object.entries(artifacts)) {
  it.each(["EMFILE", "EIO"])(`${kind}: operational %s escapes unchanged instead of becoming damage`, async (code) => {
    const { root, store } = await fixture(), path = artifact(root), error = Object.assign(new Error("Injected operational failure"), { code });
    await fs.writeFile(path, "{broken", { mode: 0o600 });
    const original = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation(((...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === path) return Promise.reject(error);
      return original(...args);
    }) as typeof fs.lstat);
    await expect(store.append(sibling, message)).rejects.toBe(error);
    vi.restoreAllMocks(); expect(await fs.readFile(path, "utf8")).toBe("{broken");
  });
}
it.each(["EMFILE", "EIO", "ENOENT"])("lifecycle discovery and content accounting preserve the %s distinction", async (code) => {
  const { root, store } = await fixture(), path = artifacts.lifecycle(root), cause = Object.assign(new Error("Injected content read failure"), { code });
  await fs.writeFile(path, "{broken", { mode: 0o600 });
  const error = new OwnedFileDamagedError(basename(path), cause), original = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (String(args[0]) === path) throw error;
    return original(...args);
  });
  const internal = store as unknown as { nativeOperationOwners(identity: Awaited<ReturnType<typeof fs.lstat>>): Promise<unknown> };
  const discovery = internal.nativeOperationOwners(await fs.lstat(root));
  if (code === "ENOENT") {
    await expect(discovery).resolves.toEqual([]);
    await expect(store.stats()).resolves.toMatchObject({ bytes: (await fs.lstat(join(root, `${key(owner)}.history.json`))).size + (await fs.lstat(join(root, `${key(victim)}.history.json`))).size });
  } else {
    await expect(discovery).rejects.toBe(error);
    await expect(store.stats()).rejects.toBe(error);
  }
});
it("a no-code marker read failure is damage, never evidence of a torn write", async () => {
  const { root, store } = await fixture(), path = artifacts.active(root), original = fs.open;
  await fs.writeFile(path, "", { mode: 0o600 });
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (String(args[0]) === path) throw new Error("Injected unreadable marker");
    return original(...args);
  });
  await store.append(sibling, message);
  await expect(store.append(owner, message)).rejects.toThrow();
  expect((await fs.lstat(path)).size).toBe(0);
});
it("stats exclude damaged markers while counting healthy prepared appends", async () => {
  const { root, store } = await fixture(), path = artifacts.active(root);
  await fs.writeFile(path, "{broken", { mode: 0o600 }); await fs.chmod(path, 0o644);
  expect((await store.stats()).activePreparedAppends).toBe(0);
  const prepared = await store.prepareAppend(sibling, message);
  expect((await store.stats()).activePreparedAppends).toBe(1);
  await prepared.abort(); expect((await store.stats()).activePreparedAppends).toBe(0);
});
it.each(["active", "temporary"] as const)("reaps a dead writer's torn %s before native-root bootstrap", async (kind) => {
  const f = await bootstrapFixture(); await fs.rm(f.path);
  const torn = artifacts[kind](f.root); await fs.writeFile(torn, "{", { mode: 0o600 });
  const lease = await f.store.acquireNativeHistoryAuthority(sibling);
  expect(lease.status).toBe("owned"); if (lease.status === "owned") await lease.release();
  await expect(fs.lstat(torn)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["count", "bytes"])("%s quota refusal names the damaged entry protecting an owner", async (quota) => {
  const { root } = await fixture(), path = artifacts.fence(root);
  await fs.writeFile(path, "{broken", { mode: 0o600 });
  const store = createDurableHistoryStore({ root, ...(quota === "count" ? { maxConversations: 1 } : { maxStoreBytes: 1, maxStagedBytes: 2 ** 40 }), now: () => 10_000 });
  await expect(store.append(sibling, message)).rejects.toThrow(basename(path));
});
it("aggregate quota refusal names damaged lifecycle intents", async () => {
  const { root } = await fixture(), path = artifacts.lifecycle(root);
  await fs.writeFile(path, "{broken", { mode: 0o600 }); await fs.chmod(path, 0o644);
  const store = createDurableHistoryStore({ root, maxStoreBytes: 1, maxStagedBytes: 2 ** 40 });
  await expect(store.append(sibling, message)).rejects.toThrow(basename(path));
});
for (const kind of ["active", "temporary"]) {
  it.each([0, 5])(`SIGKILL after writing %s bytes of ${kind}: a fresh process owner accepts the next message`, async (written) => {
    const { root } = await fixture();
    const child = fork(new URL("./fixtures/torn-coordination-worker.mjs", import.meta.url), [root, owner, kind, String(written)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = ""; child.stderr!.on("data", (bytes) => { stderr += String(bytes); });
    const exited = once(child, "exit"), timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [info] = await Promise.race([once(child, "message"), exited.then(() => { throw new Error(`Writer exited before barrier: ${stderr}`); })]);
      const torn = (info as { path: string }).path;
      expect((await fs.lstat(torn)).size).toBe(written);
      child.kill("SIGKILL"); expect((await exited)[1]).toBe("SIGKILL");
      const fresh = createDurableHistoryStore({ root });
      const turn = await fresh.beginProviderSessionTurn(owner, "fictional-next-message", { modelKey: "openai:fictional-model" });
      await (await turn.prepareCommit(message, { providerSessionSynced: true })).commit();
      expect((await fresh.load(owner)).at(-1)).toEqual(message[0]);
      await expect(fs.lstat(torn)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
  }, 15_000);
}

it.each(["active", "temporary"] as const)("bootstrap preserves a live unrelated writer's torn %s without requiring it idle", async (kind) => {
  const f = await bootstrapFixture(); await fs.rm(f.path);
  const torn = artifacts[kind](f.root).replace(".1073741824.", `.${process.pid}.`); await fs.writeFile(torn, "{", { mode: 0o600 });
  const lease = await f.store.acquireNativeHistoryAuthority(sibling);
  expect(lease.status).toBe("owned"); if (lease.status === "owned") await lease.release();
  expect(await fs.readFile(torn, "utf8")).toBe("{");
});

it.each(["root", "logical"])("malformed %s coordination names its database instead of blaming the conversation lock", async (kind) => {
  const { root, store } = await fixture(), directory = join(root, ".locks");
  const names = kind === "root" ? ["root.sqlite"] : (await fs.readdir(directory)).filter((name) => /^logical-session-shard-[a-f0-9]{2}\.sqlite$/u.test(name));
  for (const name of names) await fs.writeFile(join(directory, name), "{fictional-damaged-database}");
  for (const reset of [() => store.reset(owner), () => store.resetLogicalConversation(owner)]) {
    const failure = await reset().catch((error: Error) => error);
    expect(failure).toMatchObject({ code: "ERR_HISTORY_RESET_DAMAGED", retryable: false });
    expect(names.some((name) => (failure as Error).message.includes(name))).toBe(true);
  }
  for (const name of names) expect(await fs.readFile(join(directory, name), "utf8")).toBe("{fictional-damaged-database}");
});

it("bootstrap refuses its own damaged orphan by basename", async () => {
  const f = await bootstrapFixture();
  const name = f.name.replace(key("fictional-orphan"), key(sibling));
  await fs.rename(f.path, join(f.directory, name));
  await expect(f.store.acquireNativeHistoryAuthority(sibling)).rejects.toMatchObject({ code: "ERR_NATIVE_HISTORY_AUTHORITY_DAMAGED", message: expect.stringContaining(`(${name})`) });
});

it("bootstrap treats its own pending temp as retryable contention rather than permanent damage", async () => {
  const f = await bootstrapFixture();
  const name = f.name.replace(key("fictional-orphan"), key(sibling)) + ".tmp";
  const path = join(f.directory, name); await fs.rename(f.path, path);
  await expect(f.store.acquireNativeHistoryAuthority(sibling)).rejects.toMatchObject({ code: "ERR_NATIVE_HISTORY_AUTHORITY_BUSY", retryable: true });
  expect(await fs.readFile(path, "utf8")).toBe("{broken");
  await fs.rm(path);
  const lease = await f.store.acquireNativeHistoryAuthority(sibling);
  expect(lease.status).toBe("owned"); if (lease.status === "owned") await lease.release();
});
