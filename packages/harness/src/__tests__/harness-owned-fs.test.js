import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, stat, chmod, readdir, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { JournalLocks } from "../journal-lock.js";
import { JsonlSessionRepo } from "../session-store.js";
import { listLegacySessions } from "../legacy-import.js";
import { listOwned, publishAtomic, readOwned } from "../owned-fs.js";
const roots = [];
async function root() { const r = await mkdtemp(join(tmpdir(), "harness-owned-")); roots.push(r); return r; }
afterEach(async () => { vi.restoreAllMocks(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
const aborted = { name: "AbortError" };
const fail = () => { throw new Error("fictional identity failure"); };

it("lists only matching names and classifies wrong-mode, hard-linked and non-file entries as charged damage", async () => {
  const r = await root();
  await writeFile(join(r, ".DS_Store"), "stray"); await mkdir(join(r, "scratch"), { mode: 0o700 });
  await writeFile(join(r, "a.json"), "{}", { mode: 0o600 }); await writeFile(join(r, "b.json"), "{}", { mode: 0o644 });
  await writeFile(join(r, "c.json"), "{}", { mode: 0o600 }); await link(join(r, "c.json"), join(r, "c-alias")); await mkdir(join(r, "d.json"), { mode: 0o700 });
  const entries = await listOwned(r, /^[a-d]\.json$/);
  expect(entries.map(({ name, damaged, bytes }) => ({ name, damaged, bytes: name === "d.json" ? "dir" : bytes })))
    .toEqual([{ name: "a.json", damaged: false, bytes: 2 }, { name: "b.json", damaged: true, bytes: 2 }, { name: "c.json", damaged: true, bytes: 2 }, { name: "d.json", damaged: true, bytes: "dir" }]);
  await expect(readOwned(join(r, "b.json"))).rejects.toMatchObject({ code: "ERR_OWNED_FILE_DAMAGED" });
  await expect(readOwned(join(r, "missing.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readOwned(join(r, "a.json"))).bytes.toString()).toBe("{}");
});

it("publishes atomically and removes only its own temp after a pre-rename failure", async () => {
  const r = await root(), path = join(r, "final.json"), temporary = join(r, "final.json.tmp"), steps = [];
  await publishAtomic({ path, temporary, bytes: Buffer.from("{}"), fail, sync: async () => {}, phase: async (step) => { steps.push(step); } });
  expect(steps).toEqual(["created", "written", "file_synced", "renamed", "directory_synced"]);
  expect(await readdir(r)).toEqual(["final.json"]); expect((await stat(path)).mode & 0o777).toBe(0o600);
  await expect(publishAtomic({ path: join(r, "other.json"), temporary: join(r, "other.json.tmp"), bytes: Buffer.from("{}"), fail, sync: async () => {},
    check: async () => { throw new Error("fictional lost ownership"); } })).rejects.toThrow("lost ownership");
  // check() also guards the cleanup, so the temp stays (charged) rather than being removed unowned.
  expect((await readdir(r)).sort()).toEqual(["final.json", "other.json.tmp"]);
});

it("cancels a catalogue wait, and releases a catalogue acquisition that races cancellation", async () => {
  const r = await root(), locks = await JournalLocks.open(r);
  const held = await locks.tryLock(locks.catalogPath), callback = vi.fn(async () => "ran");
  const controller = new AbortController(), waiting = locks.withCatalog(callback, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await expect(waiting).rejects.toMatchObject(aborted); expect(callback).not.toHaveBeenCalled();
  held.release();
  await expect(locks.withCatalog(callback, { signal: AbortSignal.abort() })).rejects.toMatchObject(aborted);
  const race = new AbortController(), tryLock = locks.tryLock.bind(locks);
  vi.spyOn(locks, "tryLock").mockImplementation(async (path) => { const lock = await tryLock(path); if (lock) race.abort(); return lock; });
  await expect(locks.withCatalog(callback, { signal: race.signal })).rejects.toMatchObject(aborted);
  expect(callback).not.toHaveBeenCalled(); vi.restoreAllMocks();
  expect(await locks.withCatalog(async () => "free", { wait: false })).toBe("free");
});

it("cancels a writer wait, and releases a writer acquisition that races cancellation", async () => {
  const r = await root(), locks = await JournalLocks.open(r), held = await locks.acquireWriter("journal-fictional");
  const controller = new AbortController(), waiting = locks.acquireWriter("journal-fictional", { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await expect(waiting).rejects.toMatchObject(aborted);
  expect(await locks.withCatalog(async () => "free", { wait: false })).toBe("free");
  held.release();
  const race = new AbortController(), tryLock = locks.tryLock.bind(locks);
  vi.spyOn(locks, "tryLock").mockImplementation(async (path) => { const lock = await tryLock(path); if (lock && path.endsWith("journal-fictional.sqlite")) race.abort(); return lock; });
  await expect(locks.acquireWriter("journal-fictional", { signal: race.signal })).rejects.toMatchObject(aborted);
  vi.restoreAllMocks();
  const next = await locks.acquireWriter("journal-fictional", { wait: false }); next.release();
});

it("cancels a repository delete waiting behind a foreign writer without touching the journal", async () => {
  const r = await root(), owner = new JsonlSessionRepo({ sessionsRoot: r }), session = await owner.create({ id: "fictional-busy" });
  const bytes = await readFile(session.metadata.path), controller = new AbortController();
  const other = new JsonlSessionRepo({ sessionsRoot: r }), deletion = other.delete(session.metadata, { abortSignal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await expect(deletion).rejects.toMatchObject(aborted);
  expect((await readFile(session.metadata.path)).equals(bytes)).toBe(true);
  await session.close(); await other.delete(session.metadata, { abortSignal: new AbortController().signal });
  expect(await other.list()).toEqual([]);
});

it("keeps a stale native stage whose writer lock is insecure, unattributed, without failing the catalogue", async () => {
  const r = await root(), repo = new JsonlSessionRepo({ sessionsRoot: r });
  await (await repo.create({ id: "fictional-healthy" })).close();
  const journalId = "55555555-5555-4555-8555-555555555555", stage = join(r, "mono-v2", "journals", `${journalId}.jsonl.creating`);
  const lock = join(r, "mono-v2", "locks", `${journalId}.sqlite`);
  await writeFile(stage, "", { mode: 0o600 }); await writeFile(lock, "", { mode: 0o644 });
  expect((await repo.list()).map((m) => m.id)).toEqual(["fictional-healthy"]);
  expect((await repo.catalogue()).unattributed).toEqual([{ name: `${journalId}.jsonl.creating` }]);
  const reopened = await repo.open((await repo.list())[0]); await reopened.close();
  await (await repo.create({ id: "fictional-new" })).close();
  expect((await stat(stage)).size).toBe(0); expect((await stat(lock)).mode & 0o777).toBe(0o644);
});

it("isolates stray and damaged legacy entries to their own handle", async () => {
  const r = await root(), legacy = join(r, "legacy"); await mkdir(legacy);
  await copyFile(new URL("./fixtures/legacy-v4.jsonl", import.meta.url), join(legacy, "fixture_fixture-session.jsonl"));
  await writeFile(join(legacy, ".DS_Store"), "stray"); await writeFile(join(legacy, "notes.jsonl.tmp"), "stray"); await mkdir(join(legacy, "scratch"));
  const damaged = { "t_fictional-empty.jsonl": "", "t_fictional-invalid.jsonl": "{not json\n", "untitled.jsonl": "{\"unknown\":true}\n" };
  for (const [name, text] of Object.entries(damaged)) await writeFile(join(legacy, name), text);
  await mkdir(join(legacy, "t_fictional-dir.jsonl"));
  const listed = await listLegacySessions(r);
  expect(listed.sessions.map((m) => m.id)).toEqual(["fixture-session"]);
  expect(listed.unattributed.map((entry) => entry.id ?? null).sort()).toEqual(["fictional-dir", "fictional-empty", "fictional-invalid", null]);
  const repo = new JsonlSessionRepo({ sessionsRoot: r });
  expect((await repo.list()).map((m) => m.id)).toEqual(["fixture-session"]);
  expect((await repo.catalogue()).unattributed.some((entry) => entry.id === "fictional-invalid")).toBe(true);
  await expect(repo.retireByHandle("fictional-invalid")).rejects.toMatchObject({ code: "ERR_HARNESS_JOURNAL_UNREADABLE" });
  const imported = await repo.open((await repo.list())[0]); expect(await imported.getEntries()).toHaveLength(2); await imported.close();
  await repo.retireByHandle("fixture-session"); await repo.retireByHandle("fictional-absent");
  for (const [name, text] of Object.entries(damaged)) expect(await readFile(join(legacy, name), "utf8")).toBe(text);
  expect((await stat(join(legacy, "t_fictional-dir.jsonl"))).isDirectory()).toBe(true);
  if (process.getuid?.() !== 0) {
    await mkdir(join(r, "unreadable")); await chmod(join(r, "unreadable"), 0o000);
    try { expect((await listLegacySessions(r)).unattributed).toContainEqual({ name: "unreadable" }); }
    finally { await chmod(join(r, "unreadable"), 0o700); }
  }
});

it("cancels open, create and list lock waits from the caller's signal without leaking locks", async () => {
  const r = await root(), owner = new JsonlSessionRepo({ sessionsRoot: r }), session = await owner.create({ id: "fictional-held" });
  const other = new JsonlSessionRepo({ sessionsRoot: r }), locks = await other.ensureDirectory();
  const opening = new AbortController(), open = other.open(session.metadata, { signal: opening.signal });
  setTimeout(() => opening.abort(), 30); await expect(open).rejects.toMatchObject(aborted);
  const held = await locks.tryLock(locks.catalogPath);
  try {
    for (const run of [(signal) => other.create({ id: "fictional-new" }, { abortSignal: signal }), (signal) => other.list(undefined, { abortSignal: signal })]) {
      const controller = new AbortController(), waiting = run(controller.signal);
      setTimeout(() => controller.abort(), 30); await expect(waiting).rejects.toMatchObject(aborted);
    }
  } finally { held.release(); }
  await session.close();
  expect((await other.list()).map((m) => m.id)).toEqual(["fictional-held"]);
  expect((await readdir(join(r, "mono-v2", "locks"))).sort()).toEqual(["catalog.sqlite", `${session.metadata.journalId}.sqlite`].sort());
  const reopened = await other.open(session.metadata, { signal: new AbortController().signal }); await reopened.close();
});
