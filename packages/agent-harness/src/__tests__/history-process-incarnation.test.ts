import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createDurableHistoryStore } from "../durable-history.js";
import * as incarnation from "../process-incarnation.js";
import { currentHistoryProcessIncarnation, historyOwnerLiveness } from "../history-process-liveness.js";

type Owner = { release(): Promise<void> };
type Internals = {
  acquireLogicalConversation(id: string, tryOnly?: boolean, signal?: AbortSignal): Promise<Owner>;
  acquireExactConversationClaim(id: string, tryOnly?: boolean, signal?: AbortSignal): Promise<Owner>;
};
const roots: string[] = [], children: ChildProcess[] = [], id = "fictional-incarnation-owner";
const key = (id: string) => createHash("sha256").update("mono-agent-history-v1\0").update(id).digest("hex");
const claimKey = (kind: string) => createHash("sha256").update("mono-agent-history-session-claim-v1\0").update(kind).update("\0").update(id).digest("hex");
const input = [{ role: "user" as const, content: "Fictional existing history" }];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "history-incarnation-")); roots.push(root);
  const inspect = vi.fn(async () => ({ status: "absent" as const })), retire = vi.fn(async () => {});
  const store = createDurableHistoryStore({ root, reconcileProviderSessionTurn: inspect, retireProviderSession: retire });
  await store.append(id, input);
  const shard = (Number.parseInt(key(id).slice(0, 8), 16) % 16).toString(16).padStart(2, "0");
  const path = join(root, ".locks", `logical-session-shard-${shard}.sqlite`);
  const current = (await currentHistoryProcessIncarnation())!;
  expect(current).toBeDefined();
  return { root, path, store, inspect, retire, current, stale: { ...current, processStartId: "fictional-previous-birth" }, internal: store as unknown as Internals };
}
function database<T>(path: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path); try { return action(db); } finally { db.close(); }
}
function seedClaim(path: string, kind: string, pid: number, identity?: unknown) {
  database(path, (db) => {
    if (identity === undefined) db.prepare("INSERT INTO session_claims (claim_key,pid,token,acquired_at_ms) VALUES (?,?,?,?)").run(claimKey(kind), pid, "a".repeat(32), 0);
    else db.prepare("INSERT INTO session_claims (claim_key,pid,token,acquired_at_ms,incarnation) VALUES (?,?,?,?,?)").run(claimKey(kind), pid, "a".repeat(32), 0, JSON.stringify(identity));
  });
}
function claim(path: string, kind: string) { return database(path, (db) => db.prepare("SELECT * FROM session_claims WHERE claim_key=?").get(claimKey(kind))); }
async function marker(root: string, pid: number, identity?: unknown, extra = {}, ownerId = id) {
  const token = "b".repeat(32), path = join(root, ".locks", `${key(ownerId)}.${pid}.${token}.active`);
  await fs.writeFile(path, JSON.stringify({ version: 1, conversationKey: key(ownerId), pid, token, ...(identity ? { incarnation: identity } : {}), ...extra }), { mode: 0o600 });
  return path;
}
function emulateAlive(pid: number) {
  const kill = process.kill;
  return vi.spyOn(process, "kill").mockImplementation((target, signal) => target === pid && signal === 0 ? true : kill(target, signal));
}

it("captures this process once, sharing the in-flight lookup", async () => {
  const capture = vi.spyOn(incarnation, "readHistoryProcessIncarnation");
  const values = await Promise.all(Array.from({ length: 8 }, () => currentHistoryProcessIncarnation()));
  expect(capture).toHaveBeenCalledTimes(1); expect(values[0]).toBeDefined();
  for (const value of values) expect(value).toBe(values[0]);
});
it("resolves a foreign incarnation once per owner per wait, polls kill(0), and refreshes for a new wait/owner", async () => {
  const expected = (await currentHistoryProcessIncarnation())!, pid = 1_073_741_823;
  const kill = emulateAlive(pid), read = vi.spyOn(incarnation, "readHistoryProcessIncarnation").mockResolvedValue(expected), live = historyOwnerLiveness();
  for (let index = 0; index < 8; index++) expect(await live(pid, expected)).toBe(true);
  expect(read).toHaveBeenCalledTimes(1); expect(kill).toHaveBeenCalledTimes(16);
  const next = { ...expected, processStartId: "fictional-next-birth" }; read.mockResolvedValue(next);
  expect(await live(pid, next)).toBe(true); expect(read).toHaveBeenCalledTimes(2);
  expect(await historyOwnerLiveness()(pid, next)).toBe(true); expect(read).toHaveBeenCalledTimes(3);
  kill.mockImplementation(() => { throw Object.assign(new Error("Gone"), { code: "ESRCH" }); });
  expect(await live(pid, next)).toBe(false); expect(read).toHaveBeenCalledTimes(3);
});
for (const kind of ["logical", "exact"] as const) {
  const acquire = (f: Awaited<ReturnType<typeof fixture>>, signal?: AbortSignal) => kind === "logical"
    ? f.internal.acquireLogicalConversation(id, !signal, signal) : f.internal.acquireExactConversationClaim(id, !signal, signal);
  it(`${kind} reclaims a stale incarnation even though its PID belongs to this live process`, async () => {
    const f = await fixture(); seedClaim(f.path, kind, process.pid, f.stale);
    const owner = await acquire(f), row = claim(f.path, kind)!;
    expect(row.token).not.toBe("a".repeat(32)); expect(JSON.parse(String(row.incarnation))).toEqual(f.current);
    await owner.release(); expect(claim(f.path, kind)).toBeUndefined(); expect(await f.store.load(id)).toEqual(input);
  });
  it.each(["current", "unknown", "v1"])(`${kind} never steals a %s incarnation with a live PID`, async (identity) => {
    const f = await fixture(); seedClaim(f.path, kind, process.pid, identity === "current" ? f.current : identity === "v1" ? { ...f.stale, schema: incarnation.PROCESS_INCARNATION_SCHEMA } : { schema: "unrecognized" });
    const before = claim(f.path, kind);
    await expect(acquire(f)).rejects.toMatchObject({ code: "ERR_HARNESS_WRITER_BUSY" }); expect(claim(f.path, kind)).toEqual(before);
  });
  it(`${kind} upgrades an old schema and honours an old-format named-column INSERT as PID-only`, async () => {
    const f = await fixture(); database(f.path, (db) => db.exec("DROP TABLE session_claims; CREATE TABLE session_claims (claim_key TEXT PRIMARY KEY,pid INTEGER NOT NULL,token TEXT NOT NULL,acquired_at_ms INTEGER NOT NULL) WITHOUT ROWID"));
    seedClaim(f.path, kind, process.pid);
    await expect(acquire(f)).rejects.toMatchObject({ code: "ERR_HARNESS_WRITER_BUSY" });
    expect(claim(f.path, kind)).toMatchObject({ pid: process.pid, token: "a".repeat(32), incarnation: null });
    // The old writer has stopped. Its unidentifiable PID must actually die before recovery.
    database(f.path, (db) => db.prepare("UPDATE session_claims SET pid=?").run(1_073_741_824));
    await (await acquire(f)).release(); expect(claim(f.path, kind)).toBeUndefined();
    seedClaim(f.path, kind, process.pid); // Also valid after the nullable-column migration.
    await expect(acquire(f)).rejects.toMatchObject({ code: "ERR_HARNESS_WRITER_BUSY" });
  });
  it(`${kind} polls a live foreign claim without repeating its incarnation lookup`, async () => {
    const f = await fixture(), pid = 1_073_741_823, controller = new AbortController(); seedClaim(f.path, kind, pid, f.current);
    const originalKill = process.kill; let polls = 0;
    vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target !== pid || signal !== 0) return originalKill(target, signal);
      if (++polls === 8) controller.abort(); return true;
    });
    const read = vi.spyOn(incarnation, "readHistoryProcessIncarnation").mockResolvedValue(f.current);
    await expect(acquire(f, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(polls).toBe(8); expect(read).toHaveBeenCalledTimes(1); expect(claim(f.path, kind)?.token).toBe("a".repeat(32));
  });
  it.each(["permission", "unavailable"])(`${kind} keeps a foreign owner live when incarnation lookup is %s`, async (reason) => {
    const f = await fixture(), pid = 1_073_741_823; seedClaim(f.path, kind, pid, f.stale); emulateAlive(pid);
    const read = vi.spyOn(incarnation, "readHistoryProcessIncarnation");
    if (reason === "permission") read.mockRejectedValue(Object.assign(new Error("Fictional permission failure"), { code: "EACCES" })); else read.mockResolvedValue(undefined);
    await expect(acquire(f)).rejects.toMatchObject({ code: "ERR_HARNESS_WRITER_BUSY" }); expect(claim(f.path, kind)?.token).toBe("a".repeat(32));
    expect(read).toHaveBeenCalledTimes(1);
  });
}
it("capacity recovery applies incarnation proof and retains old-format live rows", async () => {
  const f = await fixture(); database(f.path, (db) => {
    db.exec("BEGIN IMMEDIATE"); const insert = db.prepare("INSERT INTO session_claims (claim_key,pid,token,acquired_at_ms,incarnation) VALUES (?,?,?,?,?)");
    for (let index = 0; index < 1_024; index++) insert.run(key(`fictional-capacity-${index}`), process.pid, "a".repeat(32), 0, index === 0 ? null : JSON.stringify(f.stale));
    db.exec("COMMIT");
  });
  await (await f.internal.acquireLogicalConversation(id, true)).release();
  expect(database(f.path, (db) => db.prepare("SELECT count(*) AS count FROM session_claims").get()!.count)).toBe(1);
});
it("reclaims a valid marker with a stale v2 incarnation and a reused live PID", async () => {
  const f = await fixture(), path = await marker(f.root, process.pid, f.stale);
  await f.store.stats(); await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" }); expect(await f.store.load(id)).toEqual(input);
});
it.each(["current", "legacy", "unknown", "v1"])("never reaps a live %s marker", async (format) => {
  const f = await fixture(), path = await marker(f.root, process.pid, format === "current" ? f.current : format === "unknown" ? { schema: "unrecognized" } : format === "v1" ? { ...f.stale, schema: incarnation.PROCESS_INCARNATION_SCHEMA } : undefined);
  const before = await fs.readFile(path); await f.store.stats(); expect(await fs.readFile(path)).toEqual(before);
});
it("reclaims the legacy marker left by a stopped old writer only after its PID dies", async () => {
  const f = await fixture(), path = await marker(f.root, 1_073_741_824);
  await f.store.stats(); await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
});
it("unreadable foreign incarnation keeps a marker protected", async () => {
  const f = await fixture(), pid = 1_073_741_823, path = await marker(f.root, pid, f.stale), before = await fs.readFile(path); emulateAlive(pid);
  vi.spyOn(incarnation, "readHistoryProcessIncarnation").mockRejectedValue(Object.assign(new Error("Fictional denied identity"), { code: "EPERM" }));
  await f.store.stats(); expect(await fs.readFile(path)).toEqual(before);
});
it("unparseable or filename-mismatched marker contents supply no incarnation proof", async () => {
  const f = await fixture(), path = await marker(f.root, process.pid, f.stale, { token: "c".repeat(32) });
  const before = await fs.readFile(path); await f.store.stats(); expect(await fs.readFile(path)).toEqual(before);
  await marker(f.root, process.pid, f.stale, { version: 999 });
  const invalid = await fs.readFile(path); await f.store.stats(); expect(await fs.readFile(path)).toEqual(invalid);
  await fs.writeFile(path, "{"); await f.store.stats(); expect(await fs.readFile(path, "utf8")).toBe("{");
});
it("bootstrap reaps another owner's marker with a reused PID and attested stale incarnation", async () => {
  const f = await fixture(), turn = await f.store.beginProviderSessionTurn(id, "fictional-bound", { modelKey: "faux:fictional-model" });
  await (await turn.prepareCommit([], { providerSessionSynced: true })).commit();
  const path = await marker(f.root, process.pid, f.stale, {}, "fictional-other-owner");
  const lease = await f.store.acquireNativeHistoryAuthority(id);
  expect(lease.status).toBe("owned"); if (lease.status === "owned") await lease.release();
  await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" }); expect(await f.store.load(id)).toEqual(input);
});
it("insecure marker contents never supply incarnation-based deletion authority", async () => {
  const f = await fixture(), path = await marker(f.root, process.pid, f.stale), before = await fs.readFile(path);
  await fs.chmod(path, 0o644); await f.store.stats(); expect(await fs.readFile(path)).toEqual(before);
  await expect(f.store.append(id, input)).rejects.toThrow();
});
it("new marker contents attest the current owner without changing the filename format", async () => {
  const f = await fixture(), owner = await f.store.beginProviderSessionPreparation(id, "fictional-live");
  const names = (await fs.readdir(join(f.root, ".locks"))).filter((name) => name.endsWith(".active"));
  expect(names).toHaveLength(1); expect(names[0]).toMatch(new RegExp(`^${key(id)}\\.${process.pid}\\.[a-f0-9]{32}\\.active$`, "u"));
  expect(JSON.parse(await fs.readFile(join(f.root, ".locks", names[0]!), "utf8"))).toMatchObject({ incarnation: f.current, pid: process.pid });
  await f.store.stats(); await owner.abort();
});
it("SIGKILL plus simulated PID reuse recovers both claims and marker without replaying pending input", async () => {
  const f = await fixture();
  const seed = await f.store.beginProviderSessionTurn(id, "fictional-bound-seed", { modelKey: "faux:fictional-model" });
  await (await seed.prepareCommit([], { providerSessionSynced: true })).commit(); f.inspect.mockClear(); f.retire.mockClear();
  const child = fork(new URL("./fixtures/history-acquisition-worker.mjs", import.meta.url), [f.root, id, "incarnation"], { stdio: ["ignore", "ignore", "pipe", "ipc"] }); children.push(child);
  let stderr = ""; child.stderr!.on("data", (bytes) => { stderr += String(bytes); });
  const exit = once(child, "exit");
  await Promise.race([once(child, "message"), exit.then(() => { throw new Error(`Owner exited early: ${stderr}`); })]);
  const names = (await fs.readdir(join(f.root, ".locks"))).filter((name) => name.endsWith(".active")); expect(names).toHaveLength(1);
  const old = JSON.parse(await fs.readFile(join(f.root, ".locks", names[0]!), "utf8")); expect(old.incarnation.schema).toBe(incarnation.HISTORY_PROCESS_INCARNATION_SCHEMA);
  child.kill("SIGKILL"); expect(await exit).toEqual([null, "SIGKILL"]);
  // Model the OS assigning that exact PID to a different incarnation. Persisted
  // owner bytes remain genuine, including the real killed child's incarnation.
  emulateAlive(child.pid!);
  const read = vi.spyOn(incarnation, "readHistoryProcessIncarnation").mockResolvedValue({ ...old.incarnation, processStartId: "fictional-reused-birth" });
  expect((await fs.readdir(join(f.root, ".pending-turns"))).length).toBeGreaterThan(0);
  await f.store.reset(id);
  await expect(fs.lstat(join(f.root, ".locks", names[0]!))).rejects.toMatchObject({ code: "ENOENT" });
  expect(claim(f.path, "logical")).toBeUndefined(); expect(claim(f.path, "exact")).toBeUndefined();
  expect(await f.store.load(id)).toEqual([]); expect(f.inspect).not.toHaveBeenCalled(); expect(read).toHaveBeenCalled();
  await f.store.append(id, [{ role: "user", content: "Fictional fresh successor" }]);
  expect(await createDurableHistoryStore({ root: f.root }).load(id)).toEqual([{ role: "user", content: "Fictional fresh successor" }]);
  expect(await fs.readdir(join(f.root, ".pending-turns"))).toEqual([]);
}, 15_000);
