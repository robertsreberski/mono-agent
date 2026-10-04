import { mkdtemp, mkdir, copyFile, readFile, writeFile, appendFile, rm, stat, open, rename, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonlSessionRepo, MemorySessionRepo, SessionStore } from "../session-store.js";
import { readLegacySession } from "../legacy-import.js";
const roots = [];
async function root() { const r = await mkdtemp(join(tmpdir(), "mono-pi-store-")); roots.push(r); return r; }
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
const message = { role: "user", content: [{ type: "text", text: "Fictional project." }], timestamp: 1700000000000 };
async function fixture(r, version) {
  await mkdir(join(r, "legacy"));
  const path = join(r, "legacy", "fixture_fixture-session.jsonl");
  await copyFile(new URL(`./fixtures/legacy-v${version}.jsonl`, import.meta.url), path);
  return path;
}

describe("mono-agent harness session store", () => {
  for (const durable of [false, true]) {
    it(`round-trips messages, compaction, terminal markers and rollback (${durable ? "JSONL" : "memory"})`, async () => {
      const repo = durable ? new JsonlSessionRepo({ sessionsRoot: await root() }) : new MemorySessionRepo();
      const s = await repo.create({ id: "fictional-session" });
      const a = await s.appendMessage(message);
      await s.beginTurn("turn-one");
      await s.openOperation("run-one", { model: { provider: "faux", id: "fictional-model" } });
      await s.appendCompaction({ summary: "Fictional summary.", retainedTail: [message], tokensBefore: 100 });
      await s.closeOperation("run-one", "completed");
      await s.endTurn("turn-one", "completed");
      await s.moveTo(a);
      await s.sync();
      const metadata = s.metadata;
      await s.close();
      const reopened = await repo.open(metadata);
      expect(await reopened.getEntries()).toHaveLength(1);
      expect(await reopened.getLeafId()).toBe(a);
      expect((await reopened.getTerminal("run-one")).status).toBe("completed");
      expect(await reopened.getOpenTurns()).toEqual([]);
      await reopened.close();
      await repo.delete(metadata);
      expect(await repo.list()).toEqual([]);
    });
  }
  for (const version of [3, 4]) {
    it(`imports idle v${version} context and archives only after sync`, async () => {
      const r = await root();
      const old = await fixture(r, version);
      const original = await readFile(old);
      const repo = new JsonlSessionRepo({ sessionsRoot: r });
      const sync = vi.spyOn(SessionStore.prototype, "sync");
      const [metadata] = await repo.list();
      const s = await repo.open(metadata);
      expect(s.continuity).toBe("import");
      expect((await s.getEntries()).map((e) => e.message.role)).toEqual(["user", "assistant"]);
      expect(sync).toHaveBeenCalledTimes(2);
      expect(await readFile(`${old}.migrated`)).toEqual(original);
      await expect(stat(old)).rejects.toMatchObject({ code: "ENOENT" });
      await s.close(); sync.mockRestore();
      expect((await repo.list()).map((m) => m.id)).toEqual(["fixture-session"]);
    });
  }
  it("does not archive or publish an import when fsync fails", async () => {
    const r = await root(); const old = await fixture(r, 4);
    const repo = new JsonlSessionRepo({ sessionsRoot: r });
    const sync = vi.spyOn(SessionStore.prototype, "sync").mockRejectedValueOnce(new Error("fsync unavailable"));
    await expect(repo.open((await repo.list())[0])).rejects.toThrow("fsync unavailable");
    sync.mockRestore();
    expect(await stat(old)).toBeTruthy();
    expect(await repo.listOwned()).toEqual([]);
  });
  it("ignores a torn legacy last line without rewriting the source", async () => {
    const r = await root(); const path = await fixture(r, 4);
    await appendFile(path, '{"kind":"value"');
    const bytes = await readFile(path);
    const repo = new JsonlSessionRepo({ sessionsRoot: r });
    const projected = await readLegacySession((await repo.list())[0], r);
    expect(projected.evidence.torn).toBe(true);
    expect(projected.messages).toHaveLength(2);
    expect(await readFile(path)).toEqual(bytes);
  });
  it("clean-breaks open operations, leaves legacy bytes intact and returns an empty new store", async () => {
    const r = await root(); const old = await fixture(r, 4);
    const lines = (await readFile(old, "utf8")).trim().split("\n");
    const seq = Math.max(...lines.slice(1).flatMap((line) => { const w = JSON.parse(line); return (Array.isArray(w) ? w : [w]).map((x) => x.seq); }));
    await appendFile(old, `${JSON.stringify({ kind: "value", seq: seq + 1, namespace: "pi.op.meta", key: "open-operation", op: "set", value: { lane: "main" } })}\n`);
    const bytes = await readFile(old);
    const repo = new JsonlSessionRepo({ sessionsRoot: r });
    const s = await repo.open((await repo.list())[0]);
    expect(s.continuity).toBe("clean_break");
    expect(await s.getEntries()).toEqual([]);
    expect(await readFile(old)).toEqual(bytes);
    await s.close();
    expect(await repo.list()).toHaveLength(1);
  });
  it("repairs only a torn owned line, leaving the complete turn-open marker pending", async () => {
    const repo = new JsonlSessionRepo({ sessionsRoot: await root() });
    const s = await repo.create({ id: "torn-session" });
    await s.beginTurn("interrupted", {}); await s.appendMessage(message);
    await s.close(); await appendFile(s.metadata.path, '{"kind":"turn_close"');
    const reopened = await repo.open(s.metadata);
    expect(await reopened.getEntries()).toHaveLength(1);
    expect(await reopened.getOpenTurns()).toHaveLength(1);
    await reopened.close();
    expect((await readFile(s.metadata.path, "utf8")).endsWith("\n")).toBe(true);
  });
  it("serializes append before sync before the host commit", async () => {
    const order = []; let release;
    const appendBarrier = new Promise((r) => { release = r; });
    const s = new SessionStore({ id: "ordering" }, [], {
      append: async (text) => { if (JSON.parse(text).kind === "message") { order.push("append"); await appendBarrier; } },
      sync: async () => { order.push("file+directory-sync"); },
    });
    const pending = s.appendMessage(message);
    const commit = s.sync().then(() => order.push("host-history-commit"));
    await vi.waitFor(() => expect(order).toEqual(["append"]));
    release(); await pending; await commit;
    expect(order).toEqual(["append", "file+directory-sync", "host-history-commit"]);
    await s.close();
  });
  it("detects an unfinished turn after killing a child between append and sync", async () => {
    const r = await root();
    const child = fork(new URL("./fixtures/append-worker.mjs", import.meta.url), [r], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    try {
      const [notice] = await once(child, "message");
      expect(notice).toEqual({ phase: "appended-not-synced" });
      const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
      const repo = new JsonlSessionRepo({ sessionsRoot: r });
      const s = await repo.open((await repo.list())[0]);
      expect(await s.getOpenTurns()).toHaveLength(1);
      expect(await s.getEntries()).toHaveLength(1);
      await s.close();
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  }, 10000);
});

it("projects only the legacy main branch through its latest compaction", async () => {
  const r = await root(); const path = await fixture(r, 4);
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  const writes = lines.slice(1).flatMap((line) => { const w = JSON.parse(line); return Array.isArray(w) ? w : [w]; });
  let seq = Math.max(...writes.map((w) => w.seq));
  const tip = writes.filter((w) => w.namespace === "pi.branch.tip" && w.key === "main").at(-1).value;
  const transaction = [
    { kind: "entry", seq: ++seq, id: "summary", parentId: tip, timestamp: 1700000000002, type: "compaction", summary: "Fictional earlier work.", tokensBefore: 200, retainedTail: [message] },
    { kind: "value", seq: ++seq, namespace: "pi.branch.tip", key: "main", op: "set", value: "summary" },
    { kind: "entry", seq: ++seq, id: "sibling", parentId: tip, timestamp: 1700000000003, type: "message", message: { ...message, content: "Sibling context must not import." } },
    { kind: "value", seq: ++seq, namespace: "pi.branch.tip", key: "sibling", op: "set", value: "sibling" },
  ];
  await appendFile(path, `${JSON.stringify(transaction)}\n`);
  const repo = new JsonlSessionRepo({ sessionsRoot: r });
  const s = await repo.open((await repo.list())[0]);
  expect((await s.getEntries()).map((e) => e.message.role)).toEqual(["compactionSummary", "user"]);
  expect(JSON.stringify(await s.getEntries())).not.toContain("Sibling context");
  await s.close();
});


it("reopens a journal above 32 MiB with records above 2 MiB using offset-backed storage", async () => {
  const repo = new JsonlSessionRepo({ sessionsRoot: await root() });
  const session = await repo.create({ id: "large-session" });
  await session.beginTurn("synthetic:large");
  const native = { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(3 * 1024 * 1024), thinkingSignature: "opaque" }], additive: { opaque: true } };
  for (let i = 0; i < 12; i++) await session.appendMessage(native);
  await session.endTurn("synthetic:large", "completed"); await session.sync(); await session.close();
  expect((await stat(session.metadata.path)).size).toBeGreaterThan(32 * 1024 * 1024);
  const reopened = await repo.open(session.metadata);
  try {
    expect(reopened.records).toBeNull();
    expect([...reopened.entries.values()].every((entry) => entry.address && entry.message === undefined)).toBe(true);
    expect((await reopened.getEntries()).at(-1).message).toEqual(native);
  } finally { await reopened.close(); }
});

it("completes short writes instead of publishing a partial record", async () => {
  const repo = new JsonlSessionRepo({ sessionsRoot: await root() }); const session = await repo.create({ id: "short-write" });
  const fd = await open(session.metadata.path, "r"); const prototype = Object.getPrototypeOf(fd); await fd.close();
  const original = prototype.write;
  const spy = vi.spyOn(prototype, "write").mockImplementationOnce(function (buffer, offset, length, position) {
    return original.call(this, buffer, offset, Math.min(7, length), position);
  });
  try { await session.appendMessage(message); expect(spy.mock.calls.length).toBeGreaterThan(1); }
  finally { spy.mockRestore(); await session.close(); }
  const reopened = await repo.open(session.metadata); expect(await reopened.getEntries()).toHaveLength(1); await reopened.close();
});

it("poisons ENOSPC writes, releases ownership on close, and fsync-repairs only the incomplete owned tail", async () => {
  const repo = new JsonlSessionRepo({ sessionsRoot: await root() }); const session = await repo.create({ id: "no-space" });
  const fd = await open(session.metadata.path, "r"); const prototype = Object.getPrototypeOf(fd); await fd.close();
  const original = prototype.write;
  const spy = vi.spyOn(prototype, "write").mockImplementationOnce(async function (buffer, offset, length, position) {
    await original.call(this, buffer, offset, Math.min(7, length), position);
    throw Object.assign(new Error("Fictional no space"), { code: "ENOSPC" });
  });
  try {
    await expect(session.appendMessage(message)).rejects.toMatchObject({ code: "ENOSPC" });
    await expect(session.sync()).rejects.toMatchObject({ code: "ENOSPC" });
    await expect(session.appendMessage(message)).rejects.toMatchObject({ code: "ENOSPC" });
  } finally { spy.mockRestore(); await expect(session.close()).rejects.toMatchObject({ code: "ENOSPC" }); }
  const reopened = await repo.open(session.metadata); expect(await reopened.getEntries()).toEqual([]);
  await reopened.appendMessage(message); await reopened.sync(); await reopened.close();
  expect((await readFile(session.metadata.path, "utf8")).endsWith("\n")).toBe(true);
});

it("poisons fsync failures and never acknowledges a later host commit", async () => {
  const repo = new JsonlSessionRepo({ sessionsRoot: await root() }); const session = await repo.create({ id: "sync-fault" });
  await session.appendMessage(message);
  const fd = await open(session.metadata.path, "r"); const prototype = Object.getPrototypeOf(fd); await fd.close();
  const spy = vi.spyOn(prototype, "sync").mockRejectedValueOnce(new Error("Fictional fsync failure"));
  let committed = false;
  try {
    await expect(session.sync().then(() => { committed = true; })).rejects.toThrow("fsync failure");
    await expect(session.appendMessage(message)).rejects.toThrow("fsync failure"); expect(committed).toBe(false);
  } finally { spy.mockRestore(); await expect(session.close()).rejects.toThrow("fsync failure"); }
  const reopened = await repo.open(session.metadata); expect(await reopened.getEntries()).toHaveLength(1); await reopened.close();
});

it("rejects complete corrupt records without repairing them", async () => {
  const repo = new JsonlSessionRepo({ sessionsRoot: await root() }); const session = await repo.create({ id: "corrupt" });
  await session.close(); await appendFile(session.metadata.path, '{"schemaVersion":9}\n');
  const original = await readFile(session.metadata.path);
  await expect(repo.open(session.metadata)).rejects.toThrow("Invalid");
  expect(await readFile(session.metadata.path)).toEqual(original);
});

it("rejects replaced roots and symlink files without recreating or mutating them", async () => {
  const r = await root(); const repo = new JsonlSessionRepo({ sessionsRoot: r }); const session = await repo.create({ id: "replaced" });
  await rename(join(r, "mono-v2"), join(r, "quarantined"));
  await expect(session.appendMessage(message)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(session.close()).rejects.toMatchObject({ code: "ENOENT" });
  await expect(repo.create({ id: "late" })).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(join(r, "mono-v2"))).rejects.toMatchObject({ code: "ENOENT" });
  const other = new JsonlSessionRepo({ sessionsRoot: await root() }); const victim = await other.create({ id: "symlink" }); await victim.close();
  const target = `${victim.metadata.path}.target`; await rename(victim.metadata.path, target); const bytes = await readFile(target);
  await symlink(target, victim.metadata.path);
  await expect(other.open(victim.metadata)).rejects.toThrow("read unavailable");
  expect(await readFile(target)).toEqual(bytes);
});

it("retires a local writer only after draining storage and holds its lock until close", async () => {
  const r = await root(); const repo = new JsonlSessionRepo({ sessionsRoot: r }); const session = await repo.create({ id: "retiring" });
  await session.beginTurn("synthetic:retire");
  let release, started; const gate = new Promise((resolve) => { release = resolve; }); const admitted = new Promise((resolve) => { started = resolve; });
  const append = session.io.append; session.io.append = async (text) => { started(); await gate; return append(text); };
  const pending = session.appendMessage(message); await admitted;
  const retired = repo.retire(session.metadata); expect(await stat(session.metadata.path)).toBeTruthy();
  release(); await pending; await retired;
  await expect(stat(session.metadata.path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(session.appendMessage(message)).rejects.toThrow("retired");
  expect((await readdir(join(r, "mono-v2", "locks"))).length).toBe(2);
  await expect(repo.create({ id: "retiring" })).rejects.toThrow("retired");
  await expect(session.close()).rejects.toThrow("retired");
  expect(await readdir(join(r, "mono-v2", "locks"))).toEqual(["catalog.sqlite"]);
  expect(await repo.listOwned()).toEqual([]);
  const fresh = await repo.create({ id: "retiring" }); await fresh.close(); await repo.delete(fresh.metadata);
});

it("waits for foreign writer ownership before retirement and reclaims its released lock", async () => {
  const r = await root(); const repo = new JsonlSessionRepo({ sessionsRoot: r }); const session = await repo.create({ id: "foreign-owner" });
  await session.appendMessage(message); await session.close();
  const child = fork(new URL("./fixtures/store-owner-worker.mjs", import.meta.url), [r], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let spy;
  try {
    const [notice] = await once(child, "message"); expect(notice.phase).toBe("opened");
    const locks = await repo.locksPromise; const original = locks.tryLock.bind(locks);
    let signal; const blocked = new Promise((resolve) => { signal = resolve; });
    spy = vi.spyOn(locks, "tryLock").mockImplementation(async (path) => {
      const result = await original(path); if (!result && path.endsWith(`${session.metadata.journalId}.sqlite`)) signal(); return result;
    });
    const retirement = repo.retire(session.metadata); await blocked;
    expect(await stat(session.metadata.path)).toBeTruthy();
    const closed = once(child, "message"); const exit = once(child, "exit"); child.send({ close: true });
    expect((await closed)[0].phase).toBe("closed"); await exit; await retirement;
    await expect(stat(session.metadata.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(r, "mono-v2", "locks"))).toEqual(["catalog.sqlite"]);
  } finally { spy?.mockRestore(); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}, 10000);

it("retirement removes staging and published phases under one writer lock", async () => {
  const r = await root(); const repo = new JsonlSessionRepo({ sessionsRoot: r }); const s = await repo.create({ id: "two-phases" }); await s.close();
  const staging = `${s.metadata.path}.importing`; await copyFile(s.metadata.path, staging);
  await repo.retireByHandle(s.metadata.id);
  await expect(stat(s.metadata.path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(join(r, "mono-v2", "locks"))).toEqual(["catalog.sqlite"]);
});

it("unknown aliases pin ownership and make retirement fail closed", async () => {
  const r = await root(); const repo = new JsonlSessionRepo({ sessionsRoot: r }); const s = await repo.create({ id: "alias-guard" }); await s.close();
  await mkdir(join(r, "mono-v2", "aliases"), { mode: 0o700 });
  await writeFile(join(r, "mono-v2", "aliases", "future.json"), JSON.stringify({ journalId: s.metadata.journalId }), { mode: 0o600 });
  await expect(repo.retireByHandle(s.metadata.id)).rejects.toThrow("Invalid");
  expect(await stat(s.metadata.path)).toBeTruthy();
  expect(await repo.journalDataGone(s.metadata)).toBe(false);
});

it("does not sweep corrupt legacy exact-name files or paths outside the root", async () => {
  const r = await root(); const repo = new JsonlSessionRepo({ sessionsRoot: r });
  await mkdir(join(r, "legacy")); const path = join(r, "legacy", "fictional_corrupt.jsonl"); await writeFile(path, "{bad}\n");
  await expect(repo.retireByHandle("corrupt")).rejects.toThrow("Invalid");
  expect(await readFile(path, "utf8")).toBe("{bad}\n");
  const outside = await root(); const other = await fixture(outside, 4);
  await expect(repo.delete({ id: "fixture-session", path: other, legacy: true })).rejects.toThrow("Invalid");
  expect(await stat(other)).toBeTruthy();
});
