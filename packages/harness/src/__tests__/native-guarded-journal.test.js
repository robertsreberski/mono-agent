import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { appendFile, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { JsonlSessionRepo, MemorySessionRepo } from "../session-store.js";
import { validateJournalHeader } from "../journal-schema.js";
const authority = { version: 1, canonicalVersion: 4, rootId: "1".repeat(64), authorityId: "2".repeat(64), ownerKey: "fictional-owner", historyBucket: "fictional-bucket" };
const upgrade = { hostAuthority: authority, assertOwned: async () => {} };
const roots = [], repos = [];
async function root() { const value = await mkdtemp(join(tmpdir(), "mono-native-upgrade-")); roots.push(value); return value; }
function repo(root, extra = {}) { const value = new JsonlSessionRepo({ sessionsRoot: root, ...extra }); repos.push(value); return value; }
/** A host-owned journal guarded from its first header (switch target or cold epoch). */
async function fixture(r, content = "Fictional fact", guarded = true) {
  const repository = repo(r), store = await repository.create({ id: "fictional-handle", cwd: "/fictional", ...(guarded ? upgrade : {}) });
  await store.appendMessage({ role: "user", content, timestamp: 17 }, "fictional-message"); await store.sync();
  const metadata = { ...store.metadata }; await store.close();
  return { repository, metadata, before: await readFile(metadata.path) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const repository of repos.splice(0)) await repository.close();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

// Exact public P2b implementation snapshot. Normal tests require no Git history,
// package installation, symlinks or provider modules. Every byte is hash-checked.
let oldModules;
beforeAll(async () => {
  const r = await mkdtemp(join(tmpdir(), "mono-native-base-"));
  const snapshot = JSON.parse(await readFile(new URL("./fixtures/native-v2-base-sources.json", import.meta.url), "utf8"));
  expect(snapshot.base).toBe("10f501d4f1dc102db9951fcebb09a96001910452");
  try {
    await writeFile(join(r, "package.json"), '{"type":"module"}');
    for (const [name, text] of Object.entries(snapshot.files)) {
      expect(createHash("sha256").update(text).digest("hex")).toBe(snapshot.sha256[name]);
      await mkdir(dirname(join(r, name)), { recursive: true }); await writeFile(join(r, name), text);
    }
    oldModules = {
      ...await import(pathToFileURL(join(r, "session-store.js")).href),
      ...await import(pathToFileURL(join(r, "journal-schema.js")).href),
      ...await import(pathToFileURL(join(r, "journal-reader.js")).href),
      ...await import(pathToFileURL(join(r, "legacy-import.js")).href),
    };
  } finally { await rm(r, { recursive: true, force: true }); }
});

it("refuses v3 with only an acknowledgement, spoofed metadata, or mismatching authority", async () => {
  const repository = repo(await root()), store = await repository.create({ id: "unupgraded" });
  expect(() => store.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: authority })).toThrow("upgraded native header authority");
  Object.assign(store.metadata, { ownershipSchemaVersion: 2, hostAuthority: authority });
  expect(() => store.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: authority })).toThrow("upgraded native header authority");
  const before = await readFile(store.metadata.path);
  await expect(store.write("model_change", {}, { schemaVersion: 3 })).rejects.toThrow("upgraded native header authority");
  expect(await readFile(store.metadata.path)).toEqual(before);
  await store.close();
  const warm = await repository.open(store.metadata);
  expect(() => warm.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: authority })).toThrow("upgraded native header authority");
  await warm.close();
  const guarded = await repository.create({ id: "guarded", ...upgrade }); await guarded.close();
  const reopened = await repository.open(guarded.metadata);
  expect(() => reopened.enableVersion3Writes({ exclusiveWriters: true })).toThrow("Invalid host journal upgrade authority");
  expect(() => reopened.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: { ...authority, rootId: "3".repeat(64) } })).toThrow("matching upgraded");
  expect(() => reopened.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: authority })).not.toThrow();
});

it.each([false, true])("creates coordinated journals guarded from their first header (%s durable)", async (durable) => {
  const repository = durable ? repo(await root()) : new MemorySessionRepo();
  const store = await repository.create({ id: "born-guarded", ...upgrade });
  expect(store.metadata.ownershipSchemaVersion).toBe(2);
  store.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: authority });
  await store.appendMessage({ role: "user", content: "Fictional guarded fact", timestamp: 17 });
  await store.sync(); await store.close();
  const reopened = await repository.open(store.metadata);
  expect(() => reopened.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: authority })).not.toThrow();
  await reopened.close();
});

it.each([false, true])("actual old open/scan/repair/delete refuses a guarded header before mutation (torn v3: %s)", async (torn) => {
  const r = await root(), { metadata } = await fixture(r);
  if (torn) await appendFile(metadata.path, '{"schemaVersion":3,"kind":"compaction"');
  const bytes = await readFile(metadata.path), old = new oldModules.JsonlSessionRepo({ sessionsRoot: r });
  for (const repair of [false, true]) {
    await expect(old.open(metadata, { repair })).rejects.toMatchObject({ code: "ERR_HARNESS_JOURNAL_CORRUPT" });
    expect(await readFile(metadata.path)).toEqual(bytes);
  }
  const reader = await oldModules.JournalReader.open(metadata.path, r);
  try {
    let recordVisits = 0;
    await expect(reader.scan((record) => { oldModules.validateJournalHeader(record); recordVisits++; })).rejects.toMatchObject({ code: "ERR_HARNESS_JOURNAL_CORRUPT" });
    expect(recordVisits).toBe(0);
  } finally { await reader.close(); }
  for (const action of [() => old.list(), () => old.removeOwned(metadata), () => old.delete(metadata), () => old.retireByHandle(metadata.id)]) {
    await expect(action()).rejects.toMatchObject({ code: "ERR_HARNESS_JOURNAL_CORRUPT" });
    expect(await readFile(metadata.path)).toEqual(bytes);
  }
  await old.close();
});

it("actual old binary still truncates an unguarded first torn v3 fragment, proving the guard is necessary", async () => {
  const r = await root(), { metadata, before } = await fixture(r, "Fictional fact", false);
  await appendFile(metadata.path, '{"schemaVersion":3');
  const old = new oldModules.JsonlSessionRepo({ sessionsRoot: r });
  const opened = await old.open(metadata); await opened.close();
  expect(await readFile(metadata.path)).toEqual(before); await old.close();
});

it("current guarded writer repairs its own torn v3 only behind the durable header exclusion", async () => {
  const r = await root(), { metadata, before } = await fixture(r);
  await appendFile(metadata.path, '{"schemaVersion":3');
  const store = await repo(r).open(metadata); await store.close();
  expect(await readFile(metadata.path)).toEqual(before);
});

it("guarded headers reject foreign and instance ownership before native admission", async () => {
  const repository = repo(await root()), store = await repository.create({ id: "bound-guard", ...upgrade });
  await store.beginTurn("synthetic-owner-test");
  const before = await readFile(store.metadata.path);
  for (const owner of [{ kind: "instance", ownerKey: authority.ownerKey, historyBucket: null }, { kind: "host", ownerKey: "foreign", historyBucket: authority.historyBucket }]) {
    await expect(store.write("owner_binding", owner)).rejects.toMatchObject({ code: "ERR_HARNESS_JOURNAL_CORRUPT" });
    expect(await readFile(store.metadata.path)).toEqual(before);
  }
  await store.write("owner_binding", { kind: "host", ownerKey: authority.ownerKey, historyBucket: authority.historyBucket });
  await store.endTurn("synthetic-owner-test", "completed");
});

it("guarded deletion refuses stale/uncoordinated/P/U callbacks and requires held C/D authority", async () => {
  const { repository, metadata } = await fixture(await root());
  const upgraded = metadata, bytes = await readFile(metadata.path);
  for (const options of [undefined, { ...upgrade, disposition: "P" }, { ...upgrade, disposition: "U" }, { ...upgrade, disposition: "C", hostAuthority: { ...authority, ownerKey: "foreign" } }]) {
    await expect(repository.delete(metadata, options)).rejects.toThrow();
    expect(await readFile(metadata.path)).toEqual(bytes);
  }
  const store = await repository.open(upgraded);
  Object.assign(store.metadata, { ownershipSchemaVersion: 1, hostAuthority: undefined }); // cannot demote validated authority
  await expect(repository.retire(upgraded)).rejects.toThrow();
  await expect(repository.retireByHandle(metadata.id)).rejects.toThrow();
  expect(store.retired).toBe(false); expect(repository.retiredHandles.has(metadata.id)).toBe(false);
  await store.appendMessage({ role: "user", content: "Still usable after stale cleanup", timestamp: 17 });
  await store.close();
  const assertOwned = vi.fn(async () => {});
  await repository.delete(metadata, { hostAuthority: authority, disposition: "C", assertOwned });
  expect(assertOwned).toHaveBeenCalled(); expect(await repository.list()).toEqual([]);
  // D is the native primitive for a host-authorized reset member.
  const next = await repository.create({ id: "reset-member", ...upgrade }); await next.close();
  await repository.retireByHandle(next.metadata.id, { ...upgrade, disposition: "D" });
  expect(await repository.list()).toEqual([]);
});

it.each([false, true])("validates every explicit deletion disposition on unguarded journals (durable: %s)", async (durable) => {
  const repository = durable ? repo(await root()) : new MemorySessionRepo();
  const store = await repository.create({ id: "unguarded-dispositions", cwd: "/fictional" });
  const metadata = { ...store.metadata }; await store.close();
  const actions = [() => repository.delete(metadata, currentOptions)];
  let currentOptions;
  if (durable) actions.push(() => repository.retire(metadata, currentOptions), () => repository.retireByHandle(metadata.id, currentOptions), () => repository.removeOwned(metadata, currentOptions));
  for (const disposition of ["P", "U", "unknown", undefined, null, 17]) {
    currentOptions = { disposition };
    for (const action of actions) {
      await expect(action()).rejects.toThrow("C/D disposition");
      expect((await repository.list()).map((entry) => entry.id)).toEqual([metadata.id]);
    }
  }
  await repository.delete(metadata, { disposition: "C" });
  expect(await repository.list()).toEqual([]);
  const next = await repository.create({ id: "default-deletion" }); await next.close();
  await repository.delete(next.metadata); expect(await repository.list()).toEqual([]);
});

it("memory metadata cannot forge or downgrade its private validated native header", async () => {
  const repository = new MemorySessionRepo();
  const plain = await repository.create({ id: "memory-forge", cwd: "/fictional" });
  const original = structuredClone(plain.metadata);
  Object.assign(plain.metadata, { format: "mono-harness", version: 2, ownershipSchemaVersion: 2,
    ownership: { kind: "unbound" }, initialHandle: { id: original.id }, hostAuthority: structuredClone(authority) });
  expect(() => plain.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: authority })).toThrow("upgraded native header authority");
  expect(await repository.list()).toEqual([original]);
  await plain.close();
  // Even direct mutation of the public catalogue copy cannot replace the private header.
  Object.assign(repository.sessions.get(original.id).metadata, plain.metadata);
  const reopened = await repository.open(plain.metadata);
  expect(reopened.metadata).toEqual(original);
  expect(() => reopened.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: authority })).toThrow("upgraded native header authority");
  await reopened.close(); await repository.delete(plain.metadata);

  const guarded = await repository.create({ id: "memory-downgrade", cwd: "/fictional", ...upgrade });
  const header = structuredClone(guarded.metadata);
  guarded.metadata.ownershipSchemaVersion = 1; delete guarded.metadata.hostAuthority;
  expect(await repository.list()).toEqual([header]);
  await guarded.close();
  const publicCopy = repository.sessions.get(header.id).metadata;
  publicCopy.ownershipSchemaVersion = 1; delete publicCopy.hostAuthority;
  await expect(repository.delete(guarded.metadata)).rejects.toThrow("Invalid host journal upgrade authority");
  const reopenedGuard = await repository.open(guarded.metadata);
  expect(reopenedGuard.metadata).toEqual(header);
  reopenedGuard.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: authority });
  reopenedGuard.metadata.hostAuthority.ownerKey = "forged-owner";
  expect((await repository.list())[0].hostAuthority.ownerKey).toBe(authority.ownerKey);
  await reopenedGuard.close();
  await expect(repository.delete(header, { ...upgrade, disposition: "D", hostAuthority: { ...authority, ownerKey: "forged-owner" } })).rejects.toThrow("authorized C/D");
  await repository.delete(header, { ...upgrade, disposition: "D" }); expect(await repository.list()).toEqual([]);
});


it("actual old catalogue listing and legacy import reject the whole root once one guarded journal exists", async () => {
  const r = await root(), { repository, metadata } = await fixture(r, "Fictional fact", false);
  const untouched = await repository.create({ id: "untouched-journal", cwd: "/fictional" }); await untouched.close();
  await mkdir(join(r, "legacy"), { mode: 0o700 });
  const source = join(r, "legacy", "fixture_fixture-session.jsonl");
  await copyFile(new URL("./fixtures/legacy-v3.jsonl", import.meta.url), source);
  const legacy = (await oldModules.listLegacySessions(r))[0], original = await readFile(source);
  const born = await repository.create({ id: "born-guarded", cwd: "/fictional", ...upgrade }); await born.close();
  const guarded = await readFile(born.metadata.path), old = new oldModules.JsonlSessionRepo({ sessionsRoot: r });
  await expect(old.list()).rejects.toMatchObject({ code: "ERR_HARNESS_JOURNAL_CORRUPT" });
  await expect(old.importLegacy(legacy)).rejects.toMatchObject({ code: "ERR_HARNESS_JOURNAL_CORRUPT" });
  expect(await readFile(source)).toEqual(original); expect(await readFile(born.metadata.path)).toEqual(guarded);
  await expect(lstat(`${source}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
  // Catalogue refusal is root-wide, but it is NOT a universal direct-open barrier.
  const direct = await old.open(untouched.metadata); await direct.close(); await old.close();
});

it("keeps cancellation context separate from guarded deletion authority", async () => {
  const context = { abortSignal: new AbortController().signal };
  for (const durable of [false, true]) {
    const repository = durable ? repo(await root()) : new MemorySessionRepo();
    const plain = await repository.create({ id: "context-plain" }); await plain.close();
    await repository.delete(plain.metadata, context); expect(await repository.list()).toEqual([]);
    const guard = await repository.create({ id: "context-guard", ...upgrade }); await guard.close();
    const deletion = { ...upgrade, disposition: "D" };
    await expect(repository.delete(guard.metadata, context)).rejects.toThrow("authority");
    await expect(repository.delete(guard.metadata, { ...context, ...deletion })).rejects.toThrow("Ambiguous");
    await expect(repository.delete(guard.metadata, deletion, deletion)).rejects.toThrow("Ambiguous");
    await repository.delete(guard.metadata, context, deletion); expect(await repository.list()).toEqual([]);
    if (durable) {
      const retired = await repository.create({ id: "context-retire", ...upgrade }); await retired.close();
      await repository.retire(retired.metadata, context, deletion); expect(await repository.list()).toEqual([]);
    }
  }
});

