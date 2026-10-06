import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { appendFile, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { JsonlSessionRepo, MemorySessionRepo } from "../session-store.js";
import { validateJournalHeader } from "../journal-schema.js";
const authority = { version: 1, canonicalVersion: 4, rootId: "1".repeat(64), authorityId: "2".repeat(64), ownerKey: "fictional-owner", historyBucket: "fictional-bucket" };
const upgrade = { hostAuthority: authority, assertOwned: async () => {} };
const roots = [], repos = [];
async function root() { const value = await mkdtemp(join(tmpdir(), "mono-native-upgrade-")); roots.push(value); return value; }
function repo(root, extra = {}) { const value = new JsonlSessionRepo({ sessionsRoot: root, ...extra }); repos.push(value); return value; }
const body = (bytes) => bytes.subarray(bytes.indexOf(10) + 1);
async function fixture(r, content = "Fictional fact") {
  const repository = repo(r), store = await repository.create({ id: "fictional-handle", cwd: "/fictional" });
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
  const upgraded = await repository.upgradeHeader(store.metadata, upgrade);
  const reopened = await repository.open(upgraded);
  expect(() => reopened.enableVersion3Writes({ exclusiveWriters: true })).toThrow("Invalid host journal upgrade authority");
  expect(() => reopened.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: { ...authority, rootId: "3".repeat(64) } })).toThrow("matching upgraded");
  expect(() => reopened.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: authority })).not.toThrow();
});

it("publishes an idempotent guarded header without changing native record bytes, IDs or paths", async () => {
  const { repository, metadata, before } = await fixture(await root(), "fictional unicode 🦊 " + "x".repeat(150000));
  const assertOwned = vi.fn(async () => {}), phases = [];
  repository.onHeaderUpgradePhase = async (phase) => { phases.push(phase); };
  const upgraded = await repository.upgradeHeader(metadata, { hostAuthority: authority, assertOwned });
  const bytes = await readFile(metadata.path), header = JSON.parse(bytes.subarray(0, bytes.indexOf(10)));
  expect(body(bytes)).toEqual(body(before)); expect(upgraded.path).toBe(metadata.path); expect(upgraded.journalId).toBe(metadata.journalId);
  expect(header).toMatchObject({ ownershipSchemaVersion: 2, hostAuthority: authority });
  expect(() => validateJournalHeader(header)).not.toThrow();
  expect(assertOwned.mock.calls.length).toBeGreaterThan(4);
  expect(phases).toContain("stage_synced"); expect(phases.at(-1)).toBe("publication_synced");
  const oldInode = (await lstat(metadata.path)).ino;
  const repeated = await repository.upgradeHeader(upgraded, upgrade);
  expect(repeated).toEqual(upgraded); expect((await lstat(metadata.path)).ino).toBe(oldInode); expect(await readFile(metadata.path)).toEqual(bytes);
  const reopened = await repository.open(metadata); // stale v2 caller metadata cannot override the guarded on-disk header
  reopened.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: authority }); await reopened.close();
  await expect(repository.upgradeHeader(upgraded, { ...upgrade, hostAuthority: { ...authority, authorityId: "3".repeat(64) } })).rejects.toThrow("unavailable");
  expect(await readFile(metadata.path)).toEqual(bytes);
});

it.each([false, true])("creates coordinated journals guarded from their first header (%s durable)", async (durable) => {
  const repository = durable ? repo(await root()) : new MemorySessionRepo();
  const store = await repository.create({ id: "born-guarded", ...upgrade });
  expect(store.metadata.ownershipSchemaVersion).toBe(2);
  store.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: authority });
  await store.appendModelChangeReference({ switchId: "fictional-switch", from: {}, to: {}, artifactRef: { id: "fictional-artifact", hash: "0".repeat(64) } });
  await store.sync(); await store.close();
  const reopened = await repository.open(store.metadata);
  expect(() => reopened.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: authority })).not.toThrow();
  await reopened.close();
});

it("requires host ownership, detached native writers and settled native lifecycle before upgrade", async () => {
  const { repository, metadata } = await fixture(await root());
  const before = await readFile(metadata.path);
  await expect(repository.upgradeHeader(metadata, { hostAuthority: authority })).rejects.toThrow("held host ownership assertion");
  await expect(repository.upgradeHeader(metadata, { ...upgrade, assertOwned: async () => { throw new Error("host claim lost"); } })).rejects.toThrow("host claim lost");
  expect(await readFile(metadata.path)).toEqual(before);
  const store = await repository.open(metadata);
  await expect(repository.upgradeHeader(metadata, upgrade)).rejects.toMatchObject({ code: "ERR_HARNESS_WRITER_BUSY" });
  await expect(repo(repository.root).upgradeHeader(metadata, upgrade)).rejects.toMatchObject({ code: "ERR_HARNESS_WRITER_BUSY" });
  await store.beginTurn("unsettled"); await store.sync(); await store.close();
  const unsettled = await readFile(metadata.path);
  await expect(repository.upgradeHeader(metadata, upgrade)).rejects.toThrow("unavailable");
  expect(await readFile(metadata.path)).toEqual(unsettled);
});

it("rejects unknown stage evidence and torn source bytes without repair or deletion", async () => {
  const { repository, metadata, before } = await fixture(await root());
  const stage = `${metadata.path}.upgrading`;
  await writeFile(stage, "unknown fictional evidence", { mode: 0o600 });
  await expect(repository.upgradeHeader(metadata, upgrade)).rejects.toThrow("unavailable");
  expect(await readFile(stage, "utf8")).toBe("unknown fictional evidence"); expect(await readFile(metadata.path)).toEqual(before);
  await expect(repository.delete(metadata)).rejects.toThrow(); // disposition C cannot erase unknown upgrade evidence
  expect(await readFile(metadata.path)).toEqual(before);
  await rm(stage);
  await appendFile(metadata.path, '{"schemaVersion":3');
  const torn = await readFile(metadata.path);
  await expect(repository.upgradeHeader(metadata, upgrade)).rejects.toThrow("unavailable");
  expect(await readFile(metadata.path)).toEqual(torn);
});

it.each([false, true])("actual old open/scan/repair/delete refuses a guarded header before mutation (torn v3: %s)", async (torn) => {
  const r = await root(), { repository, metadata } = await fixture(r);
  const upgraded = await repository.upgradeHeader(metadata, upgrade);
  if (torn) await appendFile(metadata.path, '{"schemaVersion":3,"kind":"model_change"');
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
  for (const action of [() => old.list(), () => old.removeOwned(upgraded), () => old.delete(metadata), () => old.retireByHandle(metadata.id)]) {
    await expect(action()).rejects.toMatchObject({ code: "ERR_HARNESS_JOURNAL_CORRUPT" });
    expect(await readFile(metadata.path)).toEqual(bytes);
  }
  await old.close();
});

it("actual old binary still truncates an unguarded first torn v3 fragment, proving the guard is necessary", async () => {
  const r = await root(), { metadata, before } = await fixture(r);
  await appendFile(metadata.path, '{"schemaVersion":3');
  const old = new oldModules.JsonlSessionRepo({ sessionsRoot: r });
  const opened = await old.open(metadata); await opened.close();
  expect(await readFile(metadata.path)).toEqual(before); await old.close();
});

it("current upgraded writer repairs its own torn v3 only after header exclusion is durable", async () => {
  const r = await root(), { repository, metadata } = await fixture(r);
  const upgraded = await repository.upgradeHeader(metadata, upgrade), before = await readFile(metadata.path);
  await appendFile(metadata.path, '{"schemaVersion":3');
  const store = await repo(r).open(upgraded); await store.close();
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

async function worker(r, phase, kill = false) {
  const child = fork(new URL("./fixtures/header-upgrade-worker.mjs", import.meta.url), [r, phase], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: ["--no-warnings"] });
  let stderr = ""; child.stderr.on("data", (bytes) => { stderr += bytes; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.on("message", resolve); child.on("error", reject); child.on("exit", (code, signal) => reject(new Error(`worker exited ${code}/${signal}: ${stderr}`)));
    });
    const exit = once(child, "exit");
    if (kill) { expect(result).toEqual({ phase }); child.kill("SIGKILL"); }
    else expect(result).toEqual({ ready: true });
    const [code, signal] = await exit;
    expect(kill ? signal : code).toBe(kill ? "SIGKILL" : 0);
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}
for (const phase of ["stage_created", "header_written", "body_copied", "stage_synced", "published", "publication_synced"]) {
  it(`recovers header upgrade twice in fresh processes after SIGKILL at ${phase}`, async () => {
    const r = await root(), { metadata, before } = await fixture(r, "fictional crash evidence " + "c".repeat(150000));
    await worker(r, phase, true);
    await worker(r, "recover"); const recovered = await readFile(metadata.path);
    await worker(r, "recover"); expect(await readFile(metadata.path)).toEqual(recovered);
    expect(body(recovered)).toEqual(body(before));
    expect(JSON.parse(recovered.subarray(0, recovered.indexOf(10)))).toMatchObject({ ownershipSchemaVersion: 2, hostAuthority: authority });
    expect((await readdir(dirname(metadata.path))).filter((name) => name.endsWith(".upgrading"))).toEqual([]);
  });
}


it("never returns a v3-eligible writer after a failed guarded publication directory barrier", async () => {
  const { repository, metadata, before } = await fixture(await root());
  const sync = vi.spyOn(repository, "syncDirectories").mockRejectedValueOnce(new Error("directory fsync unavailable"));
  await expect(repository.upgradeHeader(metadata, upgrade)).rejects.toThrow("directory fsync unavailable");
  expect(body(await readFile(metadata.path))).toEqual(body(before));
  sync.mockRejectedValueOnce(new Error("directory fsync unavailable"));
  await expect(repository.open(metadata)).rejects.toThrow("directory fsync unavailable");
  expect(repository.openSessions.size).toBe(0);
  sync.mockRestore();
  const store = await repository.open(metadata);
  store.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: authority });
  await store.close();
});

it("guarded deletion refuses stale/uncoordinated/P/U callbacks and requires held C/D authority", async () => {
  const { repository, metadata } = await fixture(await root());
  const upgraded = await repository.upgradeHeader(metadata, upgrade), bytes = await readFile(metadata.path);
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
  // D is the native primitive for a host-authorized reset member, not a native
  // claim that it knows the whole chain. Whole-chain transaction follows later.
  const next = await repository.create({ id: "reset-member", ...upgrade }); await next.close();
  await repository.retireByHandle(next.metadata.id, { ...upgrade, disposition: "D" });
  expect(await repository.list()).toEqual([]);
});

it("upgrade refuses contradictory pre-existing host ownership instead of relabelling it", async () => {
  const { repository, metadata } = await fixture(await root());
  const store = await repository.open(metadata);
  await store.beginTurn("foreign-owner");
  await store.write("owner_binding", { kind: "host", ownerKey: "foreign-owner", historyBucket: authority.historyBucket });
  await store.endTurn("foreign-owner", "completed"); await store.sync(); await store.close();
  const bytes = await readFile(metadata.path);
  await expect(repository.upgradeHeader(metadata, upgrade)).rejects.toThrow("unavailable");
  expect(await readFile(metadata.path)).toEqual(bytes);
});


it("actual old warm index cannot bypass a newly published guarded header", async () => {
  const r = await root(), { repository, metadata } = await fixture(r);
  const old = new oldModules.JsonlSessionRepo({ sessionsRoot: r });
  const warmed = await old.open(metadata); await warmed.close();
  await repository.upgradeHeader(metadata, upgrade);
  await appendFile(metadata.path, '{"schemaVersion":3');
  const bytes = await readFile(metadata.path);
  await expect(old.open(metadata)).rejects.toMatchObject({ code: "ERR_HARNESS_JOURNAL_CORRUPT" });
  expect(await readFile(metadata.path)).toEqual(bytes); await old.close();
});


const reorderedAuthority = Object.fromEntries(Object.entries(authority).reverse());
for (const failureKind of ["ENOSPC", "fsync", "host_claim"]) for (const recovery of ["re-upgrade", "unguarded-delete"]) {
  it(`cleans its failed ${failureKind} stage before ${recovery}`, async () => {
    const r = await root(), { repository, metadata, before } = await fixture(r);
    const temporary = `${metadata.path}.upgrading`;
    const probe = await open(join(r, "file-handle-probe"), "w", 0o600);
    const prototype = Object.getPrototypeOf(probe); await probe.close();
    let lostOwnership = false, stageIdentity;
    const injected = Object.assign(new Error(`injected ${failureKind}`), { code: failureKind === "ENOSPC" ? "ENOSPC" : "EIO" });
    repository.onHeaderUpgradePhase = async (phase) => {
      if (phase === "stage_created") {
        stageIdentity = await lstat(temporary);
        if (failureKind !== "host_claim") {
          const method = failureKind === "ENOSPC" ? "write" : "sync", original = prototype[method];
          vi.spyOn(prototype, method).mockImplementation(async function (...args) {
            const identity = await this.stat();
            if (identity.dev === stageIdentity.dev && identity.ino === stageIdentity.ino) throw injected;
            return original.apply(this, args);
          });
        }
      }
      if (phase === "body_copied" && failureKind === "host_claim") lostOwnership = true;
    };
    await expect(repository.upgradeHeader(metadata, { hostAuthority: authority, assertOwned: async () => { if (lostOwnership) throw injected; } })).rejects.toBe(injected);
    vi.restoreAllMocks();
    expect(await readFile(metadata.path)).toEqual(before);
    await expect(lstat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    repository.onHeaderUpgradePhase = async () => {};
    if (recovery === "re-upgrade") {
      const upgraded = await repository.upgradeHeader(metadata, { ...upgrade, hostAuthority: reorderedAuthority });
      const bytes = await readFile(metadata.path), header = JSON.parse(bytes.subarray(0, bytes.indexOf(10)));
      expect(body(bytes)).toEqual(body(before)); expect(header.hostAuthority).toEqual(authority);
      expect(Object.keys(header.hostAuthority)).toEqual(Object.keys(authority));
      await repository.delete(upgraded, { ...upgrade, disposition: "D" });
    } else await repository.delete(metadata);
    expect(await repository.list()).toEqual([]);
  });
}

it("does not unlink a replaced stage inode during in-process failure cleanup", async () => {
  const { repository, metadata, before } = await fixture(await root());
  const stage = `${metadata.path}.upgrading`;
  repository.onHeaderUpgradePhase = async (phase) => {
    if (phase === "header_written") {
      await rename(stage, `${stage}.saved`);
      await writeFile(stage, "Unknown replacement fixture evidence", { mode: 0o600 });
      throw new Error("injected replaced stage failure");
    }
  };
  await expect(repository.upgradeHeader(metadata, upgrade)).rejects.toThrow("injected replaced stage failure");
  expect(await readFile(stage, "utf8")).toBe("Unknown replacement fixture evidence");
  expect(await readFile(metadata.path)).toEqual(before);
});

it("recovers canonically ordered staged bytes with reordered equal authority after a process crash", async () => {
  const r = await root(), { repository, metadata, before } = await fixture(r);
  await worker(r, "header_written", true);
  const staged = await readFile(`${metadata.path}.upgrading`);
  const stagedHeader = JSON.parse(staged.subarray(0, staged.indexOf(10)));
  expect(Object.keys(stagedHeader.hostAuthority)).toEqual(Object.keys(authority));
  await repository.upgradeHeader(metadata, { ...upgrade, hostAuthority: reorderedAuthority });
  const ready = await readFile(metadata.path);
  expect(ready.subarray(0, ready.indexOf(10) + 1)).toEqual(staged);
  expect(body(ready)).toEqual(body(before));
  await worker(r, "recover"); expect(await readFile(metadata.path)).toEqual(ready);
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


it("actual old catalogue listing and legacy import reject the whole root after one journal upgrade", async () => {
  const r = await root(), { repository, metadata } = await fixture(r);
  const untouched = await repository.create({ id: "untouched-journal", cwd: "/fictional" }); await untouched.close();
  await mkdir(join(r, "legacy"), { mode: 0o700 });
  const source = join(r, "legacy", "fixture_fixture-session.jsonl");
  await copyFile(new URL("./fixtures/legacy-v3.jsonl", import.meta.url), source);
  const legacy = (await oldModules.listLegacySessions(r))[0], original = await readFile(source);
  await repository.upgradeHeader(metadata, upgrade);
  const guarded = await readFile(metadata.path), old = new oldModules.JsonlSessionRepo({ sessionsRoot: r });
  await expect(old.list()).rejects.toMatchObject({ code: "ERR_HARNESS_JOURNAL_CORRUPT" });
  await expect(old.importLegacy(legacy)).rejects.toMatchObject({ code: "ERR_HARNESS_JOURNAL_CORRUPT" });
  expect(await readFile(source)).toEqual(original); expect(await readFile(metadata.path)).toEqual(guarded);
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

it("records one model_change per switch identity across concurrent calls and cold reopen", async () => {
  const r = await root(), repository = repo(r), store = await repository.create({ id: "switch-event", ...upgrade });
  const event = { switchId: "fictional-switch-id", from: { provider: "faux", model: "A" }, to: { provider: "faux", model: "B" }, artifactRef: { id: "fictional-artifact", hash: "0".repeat(64) } };
  store.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: authority });
  const [first, repeat] = await Promise.all([store.appendModelChangeReference(event), store.appendModelChangeReference(event)]);
  expect(first).toEqual(repeat); await store.sync(); await store.close();
  const bytes = await readFile(store.metadata.path);
  const reopened = await repo(r).open(store.metadata); reopened.enableVersion3Writes({ exclusiveWriters: true, hostAuthority: authority });
  expect(await reopened.appendModelChangeReference({ ...event, from: { model: "A", provider: "faux" } })).toEqual(first);
  await expect(reopened.appendModelChangeReference({ ...event, artifactRef: { ...event.artifactRef, hash: "1".repeat(64) } })).rejects.toThrow("conflicts");
  await reopened.close(); expect(await readFile(store.metadata.path)).toEqual(bytes);
  expect(bytes.toString().split("\n").filter((line) => line.includes('"kind":"model_change"'))).toHaveLength(1);
});
