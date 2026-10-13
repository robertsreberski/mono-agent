import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createDurableHistoryStore } from "../durable-history.js";
import { MonoAgentHarness } from "../harness.js";
import { createInMemoryHistoryStore } from "../history.js";

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof fs>() }));
type Identity = { dev: number; ino: number };
type Owner = { release(): Promise<void> };
type Internals = {
  ensureRoot(): Promise<Identity>;
  acquireRootTransaction(identity: Identity, signal?: AbortSignal): Promise<() => Promise<void>>;
  acquireLogicalConversation(id: string, tryOnly?: boolean, signal?: AbortSignal): Promise<Owner>;
  acquireExactConversationClaim(id: string, tryOnly?: boolean, signal?: AbortSignal): Promise<Owner>;
  createActiveMarker(...args: unknown[]): Promise<unknown>;
};
const roots: string[] = [], children: ChildProcess[] = [], id = "fictional-cancel-owner";
const hash = createHash("sha256").update("mono-agent-history-v1\0").update(id).digest("hex");
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
async function fixture() {
  const base = await fs.mkdtemp(join(tmpdir(), "history-acquisition-")); roots.push(base);
  const root = join(base, "history"), inspect = vi.fn(async () => ({ status: "absent" as const })), retire = vi.fn(async () => {});
  const store = createDurableHistoryStore({ root, reconcileProviderSessionTurn: inspect, retireProviderSession: retire });
  return { root, store, internal: store as unknown as Internals, inspect, retire };
}
async function markers(root: string) { return (await fs.readdir(join(root, ".locks"))).filter((name) => name.endsWith(".active")); }
async function claims(root: string) {
  let count = 0;
  for (const name of await fs.readdir(join(root, ".locks"))) if (name.startsWith("logical-session-shard-") && name.endsWith(".sqlite")) {
    const db = new DatabaseSync(join(root, ".locks", name));
    try { if (db.prepare("SELECT name FROM sqlite_master WHERE name='session_claims'").get()) count += Number(db.prepare("SELECT count(*) AS count FROM session_claims").get()!.count); }
    finally { db.close(); }
  }
  return count;
}
async function child(root: string, mode: string) {
  const process = fork(new URL("./fixtures/history-acquisition-worker.mjs", import.meta.url), [root, id, mode], { stdio: ["ignore", "ignore", "pipe", "ipc"] }); children.push(process);
  let stderr = ""; process.stderr!.on("data", (bytes) => { stderr += String(bytes); });
  const phase = once(process, "message"), exit = once(process, "exit");
  await Promise.race([phase, exit.then(() => { throw new Error(`Acquisition worker exited: ${stderr}`); })]);
  return process;
}
function observeBusySqlite() {
  const busy = deferred(), exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
    try { exec.call(this, sql); } catch (error) { if (/locked|busy/u.test(String(error))) busy.resolve(); throw error; }
  });
  return busy.promise;
}
it.each(["turn", "preparation", "exclusive"])("pre-aborted %s does not create history or admit work", async (kind) => {
  const f = await fixture(), controller = new AbortController(); controller.abort();
  const acquisition = kind === "turn" ? f.store.beginProviderSessionTurn(id, "fictional-turn", undefined, controller.signal)
    : kind === "preparation" ? f.store.beginProviderSessionPreparation(id, "fictional-turn", controller.signal)
    : f.store.contextImport!.beginExclusiveTurn(id, controller.signal);
  await expect(acquisition).rejects.toMatchObject({ name: "AbortError" });
  await expect(fs.lstat(f.root)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.inspect).not.toHaveBeenCalled(); expect(f.retire).not.toHaveBeenCalled();
});
it("cancelled tail preserves its predecessor, then a later tryOnly owner is not busy", async () => {
  const f = await fixture(), holder = await f.internal.acquireLogicalConversation(id), controller = new AbortController();
  const waiter = f.internal.acquireLogicalConversation(id, false, controller.signal);
  controller.abort(); controller.abort();
  await expect(waiter).rejects.toMatchObject({ name: "AbortError" });
  await expect(f.internal.acquireLogicalConversation(id, true)).rejects.toMatchObject({ code: "ERR_HARNESS_WRITER_BUSY", retryable: true });
  await holder.release();
  // Queue-tail promises settle asynchronously after the predecessor releases.
  await new Promise((resolve) => setImmediate(resolve));
  const successor = await f.internal.acquireLogicalConversation(id, true); await successor.release();
  expect(await claims(f.root)).toBe(0);
});
it("a cancelled middle waiter never lets its successor bypass the live predecessor", async () => {
  const f = await fixture(), holder = await f.internal.acquireLogicalConversation(id), controller = new AbortController();
  const middle = f.internal.acquireLogicalConversation(id, false, controller.signal);
  let acquired = false;
  const successor = f.internal.acquireLogicalConversation(id).then((owner) => { acquired = true; return owner; });
  controller.abort(); await expect(middle).rejects.toMatchObject({ name: "AbortError" });
  await new Promise((resolve) => setImmediate(resolve)); expect(acquired).toBe(false);
  await holder.release(); await (await successor).release(); expect(await claims(f.root)).toBe(0);
});
it("cancels the in-process root queue without leaving a claim or marker", async () => {
  const f = await fixture(); await f.store.stats();
  const release = await f.internal.acquireRootTransaction(await f.internal.ensureRoot()), controller = new AbortController();
  const enter = vi.spyOn(f.internal, "acquireRootTransaction"), waiting = f.store.beginProviderSessionPreparation(id, "fictional-wait", controller.signal);
  await vi.waitFor(() => expect(enter).toHaveBeenCalled()); controller.abort();
  await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  expect(await markers(f.root)).toEqual([]); expect(await claims(f.root)).toBe(0);
  await release(); const next = await f.store.beginProviderSessionPreparation(id, "fictional-next"); await next.abort();
});
for (const mode of ["root", "logical", "exact", "legacy", "shard"]) {
  it(`cancels cross-process ${mode} contention without stealing the holder and admits a successor`, async () => {
    const f = await fixture(); await f.store.stats(); const holder = await child(f.root, mode), controller = new AbortController();
    let waiting: Promise<Owner | Awaited<ReturnType<typeof f.store.beginProviderSessionPreparation>>>;
    let polled: Promise<void>;
    if (mode === "logical" || mode === "exact") {
      const seen = deferred(), kill = process.kill;
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => { if (pid === holder.pid && signal === 0) seen.resolve(); return kill(pid, signal); });
      polled = seen.promise;
    } else polled = observeBusySqlite();
    waiting = mode === "exact" ? f.internal.acquireExactConversationClaim(id, false, controller.signal)
      : f.store.beginProviderSessionPreparation(id, "fictional-wait", controller.signal);
    const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await polled; controller.abort(); await rejected;
    expect(holder.exitCode).toBeNull(); expect(holder.signalCode).toBeNull();
    expect(await claims(f.root)).toBe(mode === "logical" || mode === "exact" ? 1 : 0);
    expect((await markers(f.root)).length).toBe(mode === "logical" ? 1 : 0);
    const exit = once(holder, "exit"); holder.send("release"); await exit;
    const next = await f.store.beginProviderSessionPreparation(id, "fictional-next"); await next.abort();
    expect(await claims(f.root)).toBe(0); expect(f.inspect).not.toHaveBeenCalled();
  }, 15_000);
}
it("releases a newly committed claim when abort races its commit", async () => {
  const f = await fixture(), controller = new AbortController(), exec = DatabaseSync.prototype.exec;
  let aborted = false;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
    exec.call(this, sql);
    if (sql === "COMMIT" && !aborted) { aborted = true; controller.abort(); }
  });
  await expect(f.store.beginProviderSessionPreparation(id, "fictional-race", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(aborted).toBe(true); expect(await claims(f.root)).toBe(0); expect(await markers(f.root)).toEqual([]);
  const next = await f.store.beginProviderSessionPreparation(id, "fictional-next"); await next.abort();
});
it("releases an acquired root lock when abort races its return, before creating a marker", async () => {
  const f = await fixture(), controller = new AbortController(), acquire = f.internal.acquireRootTransaction.bind(f.internal);
  vi.spyOn(f.internal, "acquireRootTransaction").mockImplementation(async (...args) => { const release = await acquire(...args); controller.abort(); return release; });
  const marker = vi.spyOn(f.internal, "createActiveMarker");
  await expect(f.store.beginProviderSessionPreparation(id, "fictional-race", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(marker).not.toHaveBeenCalled(); expect(await claims(f.root)).toBe(0);
  const next = await f.store.beginProviderSessionPreparation(id, "fictional-next"); await next.abort();
});
it("SIGKILL during cancelled-owner unwind leaves recoverable claims and never steals the surviving root lock", async () => {
  const f = await fixture(); await f.store.stats();
  const db = new DatabaseSync(join(f.root, ".locks", "root.sqlite")); db.exec("PRAGMA journal_mode=MEMORY; BEGIN IMMEDIATE");
  try {
    const waiter = await child(f.root, "cancel"); // Its committed claim is waiting for this root lock.
    const unwinding = once(waiter, "message"); waiter.send("abort");
    expect((await unwinding)[0]).toMatchObject({ phase: "unwind" });
    const exit = once(waiter, "exit"); waiter.kill("SIGKILL"); expect(await exit).toEqual([null, "SIGKILL"]);
    expect(await claims(f.root)).toBe(1); expect(await markers(f.root)).toEqual([]);
    const polled = observeBusySqlite(); let acquired = false;
    const successor = f.store.beginProviderSessionPreparation(id, "fictional-survivor").then((owner) => { acquired = true; return owner; });
    await polled; expect(acquired).toBe(false); // Neither the cancelled nor the new owner stole the root transaction.
    db.exec("ROLLBACK"); await (await successor).abort();
    expect(await claims(f.root)).toBe(0); expect(await markers(f.root)).toEqual([]);
    expect(f.inspect).not.toHaveBeenCalled(); expect(f.retire).not.toHaveBeenCalled();
  } finally { db.close(); }
}, 15_000);
it("an incomplete coordination write has stable retryable busy metadata", async () => {
  const f = await fixture(); await f.store.stats();
  await fs.writeFile(join(f.root, ".locks", `${hash}.${process.pid}.${"a".repeat(32)}.active`), "{", { mode: 0o600 });
  await expect(f.store.beginProviderSessionPreparation(id, "fictional-wait")).rejects.toMatchObject({ code: "ERR_HARNESS_WRITER_BUSY", retryable: true });
});
it.each(["EACCES", "EPERM"])("%s cleanup denial of a sound dead-owner fence temp propagates rather than becoming damage", async (code) => {
  const f = await fixture(); await f.store.stats(); const path = join(f.root, ".locks", `.${hash}.1073741824.${"a".repeat(24)}.dirty.tmp`);
  await fs.writeFile(path, JSON.stringify({ version: 1, conversationKey: hash, epoch: "b".repeat(64), revision: 0, runIdDigest: "c".repeat(64) }), { mode: 0o600 });
  const error = Object.assign(new Error("Fictional cleanup denial"), { code }), remove = fs.rm;
  vi.spyOn(fs, "rm").mockImplementation(async (...args) => { if (args[0] === path) throw error; return remove(...args); });
  await expect(f.store.beginProviderSessionPreparation("fictional-other", "fictional-wait")).rejects.toBe(error);
  expect((await fs.lstat(path)).size).toBeGreaterThan(0);
});

it.each(["provider", "exclusive", "compaction"])("harness %s acquisition cancellation does not admit or dispatch and leaves a usable successor", async (mode) => {
  const f = await fixture(), identityPath = join(f.root, "..", "IDENTITY.md"); await fs.writeFile(identityPath, "Fictional instructions");
  if (mode === "compaction") await f.store.append(id, [{ role: "user", content: "Fictional seed" }]);
  const before = await f.store.load(id), holder = await f.store.beginProviderSessionPreparation(id, "fictional-holder"), controller = new AbortController();
  const run = vi.fn(async () => ({ text: "Fictional response" })), syncSession = vi.fn(async () => true);
  const harness = new MonoAgentHarness({ identityPath, model: { provider: "openai", model: "fictional-model", reference: "openai:fictional-model" },
    historyStore: f.store, session: { mode: "continuous", idleTimeoutMs: 60_000, supportsResume: true },
    ...(mode === "exclusive" ? {} : { piSessionsRoot: join(f.root, "..", "native") }),
    runtime: { run, syncSession, refreshSession: async () => {}, disposeSession: async () => true, disposeAllSessions: async () => {} } });
  const entered = mode === "exclusive" ? vi.spyOn(f.store.contextImport!, "beginExclusiveTurn") : vi.spyOn(f.store, "beginProviderSessionTurn");
  try {
    const pending = mode === "compaction" ? harness.compactConversation(id, undefined, controller.signal)
      : harness.run({ conversationId: id, userMessage: "Fictional cancelled input", abortSignal: controller.signal });
    const cancelled = mode === "compaction" ? expect(pending).rejects.toMatchObject({ failureKind: "compaction_failed" })
      : expect(pending).resolves.toMatchObject({ failure: { kind: "cancelled" } });
    await vi.waitFor(() => expect(entered).toHaveBeenCalled()); controller.abort(); await cancelled;
    expect(run).not.toHaveBeenCalled(); expect(syncSession).not.toHaveBeenCalled();
    expect(await f.store.load(id)).toEqual(before); expect((await markers(f.root)).length).toBe(1);
  } finally { await holder.abort(); await harness.dispose(); }
  const next = await f.store.beginProviderSessionPreparation(id, "fictional-next"); await next.abort();
});
it("closes an acquired SQLite connection when cancellation races BEGIN IMMEDIATE", async () => {
  const f = await fixture(), controller = new AbortController(), exec = DatabaseSync.prototype.exec;
  let aborted = false;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
    exec.call(this, sql);
    if (sql === "BEGIN IMMEDIATE" && !aborted) { aborted = true; controller.abort(); }
  });
  await expect(f.store.beginProviderSessionPreparation(id, "fictional-race", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(aborted).toBe(true); expect(await claims(f.root)).toBe(0); expect(await markers(f.root)).toEqual([]);
  const next = await f.store.beginProviderSessionPreparation(id, "fictional-next"); await next.abort();
});

it("finishes started marker publication and allows uncancellable cleanup after a late abort", async () => {
  const f = await fixture(), controller = new AbortController(), create = f.internal.createActiveMarker.bind(f.internal);
  vi.spyOn(f.internal, "createActiveMarker").mockImplementation(async (...args) => { const marker = await create(...args); controller.abort(); return marker; });
  const owner = await f.store.beginProviderSessionPreparation(id, "fictional-published", controller.signal);
  expect(controller.signal.aborted).toBe(true); expect((await markers(f.root)).length).toBe(1);
  await owner.abort(); expect(await claims(f.root)).toBe(0); expect(await markers(f.root)).toEqual([]);
});

it.each(["provider", "exclusive"])("cancellation during attachment preflight before %s acquisition publishes nothing behind a held owner", async (mode) => {
  const f = await fixture(), identityPath = join(f.root, "..", "IDENTITY.md"), attachmentsDir = join(f.root, "..", "attachments");
  await fs.writeFile(identityPath, "Fictional instructions");
  const holder = await f.store.beginProviderSessionPreparation(id, "fictional-holder"), controller = new AbortController(), mkdir = fs.mkdir;
  vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => { if (args[0] === attachmentsDir) controller.abort(); return mkdir(...args); });
  const append = vi.spyOn(f.store, "prepareAppend"), provider = vi.spyOn(f.store, "beginProviderSessionTurn"), exclusive = vi.spyOn(f.store.contextImport!, "beginExclusiveTurn");
  const run = vi.fn(async () => ({ text: "Fictional response" }));
  const harness = new MonoAgentHarness({ identityPath, attachmentsDir, model: { provider: "openai", model: "fictional-model", reference: "openai:fictional-model" },
    historyStore: f.store, session: { mode: "continuous", idleTimeoutMs: 60_000, supportsResume: true },
    ...(mode === "provider" ? { piSessionsRoot: join(f.root, "..", "native") } : {}), runtime: { run } });
  let settled = false;
  const pending = harness.run({ conversationId: id, userMessage: "Fictional cancelled input", abortSignal: controller.signal,
    attachments: [{ kind: "document", mimeType: "text/plain", name: "fictional.txt", data: Buffer.from("Fictional attachment").toString("base64") }] }).then((result) => { settled = true; return result; });
  try {
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 2_000 });
    expect((await pending).failure?.kind).toBe("cancelled"); expect(controller.signal.aborted).toBe(true);
    expect(append).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled(); expect(exclusive).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    expect(await f.store.load(id)).toEqual([]); await holder.assertOwned();
  } finally { await holder.abort(); await pending; await harness.dispose(); }
});
it.each(["provider", "exclusive", "uncoordinated"])("an admitted %s turn retains its cancellation account", async (mode) => {
  const f = await fixture(), identityPath = join(f.root, "..", "IDENTITY.md"), controller = new AbortController();
  await fs.writeFile(identityPath, "Fictional instructions");
  const store = mode === "uncoordinated" ? createInMemoryHistoryStore({ maxMessages: 64 }) : f.store;
  if (mode === "provider") {
    const begin = f.store.beginProviderSessionTurn.bind(f.store);
    vi.spyOn(f.store, "beginProviderSessionTurn").mockImplementation(async (...args) => { const turn = await begin(...args); controller.abort(); return turn; });
  } else if (mode === "exclusive") {
    const begin = f.store.contextImport!.beginExclusiveTurn.bind(f.store.contextImport);
    vi.spyOn(f.store.contextImport!, "beginExclusiveTurn").mockImplementation(async (...args) => { const turn = await begin(...args); controller.abort(); return turn; });
  }
  const run = vi.fn(async () => { controller.abort(); return { text: "Fictional late response" }; });
  const harness = new MonoAgentHarness({ identityPath, model: { provider: "openai", model: "fictional-model", reference: "openai:fictional-model" }, historyStore: store,
    session: { mode: "continuous", idleTimeoutMs: 60_000, supportsResume: true }, ...(mode === "provider" ? { piSessionsRoot: join(f.root, "..", "native") } : {}), runtime: { run } });
  try {
    expect((await harness.run({ conversationId: id, userMessage: "Fictional admitted input", abortSignal: controller.signal })).failure?.kind).toBe("cancelled");
    const messages = await store.load(id); expect(messages.some((message) => message.role === "user" && message.content.includes("Fictional admitted input"))).toBe(true);
    expect(messages.some((message) => message.role === "assistant" && message.content.includes("cancelled"))).toBe(true);
    expect(run).toHaveBeenCalledTimes(mode === "uncoordinated" ? 1 : 0);
  } finally { await harness.dispose(); }
});
it.each(["valid", "torn"])("a concurrently reaped %s dead-owner fence temp does not fail acquisition", async (kind) => {
  const f = await fixture(); await f.store.stats(); const path = join(f.root, ".locks", `.${hash}.1073741824.${"a".repeat(24)}.dirty.tmp`);
  await fs.writeFile(path, kind === "torn" ? "{" : JSON.stringify({ version: 1, conversationKey: hash, epoch: "b".repeat(64), revision: 0, runIdDigest: "c".repeat(64) }), { mode: 0o600 });
  const remove = fs.rm; let reaped = false;
  vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
    if (args[0] === path && !reaped) { reaped = true; await remove(path); }
    return remove(...args);
  });
  const owner = await f.store.beginProviderSessionPreparation("fictional-other", "fictional-successor"); await owner.abort();
  expect(reaped).toBe(true); await expect(fs.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
});
