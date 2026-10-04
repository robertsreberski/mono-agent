import { mkdtemp, mkdir, copyFile, readFile, writeFile, appendFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonlSessionRepo, MemorySessionRepo, SessionStore } from "../../ai/providers/pi-native/harness/session-store.js";
import { readLegacySession } from "../../ai/providers/pi-native/harness/legacy-import.js";
const roots = [];
async function root() { const r = await mkdtemp(join(tmpdir(), "mono-pi-store-")); roots.push(r); return r; }
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
const message = { role: "user", content: [{ type: "text", text: "Fictional project." }], timestamp: 1700000000000 };
async function fixture(r, version) {
  await mkdir(join(r, "legacy"));
  const path = join(r, "legacy", "fixture_fixture-session.jsonl");
  await copyFile(new URL(`./fixtures/pi-harness/legacy-v${version}.jsonl`, import.meta.url), path);
  return path;
}

describe("owned Pi session store", () => {
  for (const durable of [false, true]) {
    it(`round-trips messages, compaction, terminal markers and rollback (${durable ? "JSONL" : "memory"})`, async () => {
      const repo = durable ? new JsonlSessionRepo({ sessionsRoot: await root() }) : new MemorySessionRepo();
      const s = await repo.create({ id: "fictional-session" });
      const a = await s.appendMessage(message);
      await s.openTurn("run-one", { model: { provider: "faux", id: "fictional-model" } });
      await s.appendCompaction({ summary: "Fictional summary.", retainedTail: [message], tokensBefore: 100 });
      await s.closeTurn("run-one", "completed");
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
      expect(sync).toHaveBeenCalledTimes(1);
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
    await s.openTurn("interrupted", {}); await s.appendMessage(message);
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
      append: async () => { order.push("append"); await appendBarrier; },
      sync: async () => { order.push("file+directory-sync"); },
    });
    const pending = s.appendMessage(message);
    const commit = s.sync().then(() => order.push("host-history-commit"));
    await Promise.resolve(); expect(order).toEqual(["append"]);
    release(); await pending; await commit;
    expect(order).toEqual(["append", "file+directory-sync", "host-history-commit"]);
    await s.close();
  });
  it("detects an unfinished turn after killing a child between append and sync", async () => {
    const r = await root();
    const child = fork(new URL("./fixtures/pi-harness/append-worker.mjs", import.meta.url), [r], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
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
