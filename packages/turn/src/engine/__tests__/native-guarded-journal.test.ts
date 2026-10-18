import { afterEach, expect, it, vi } from "vitest";
import { appendFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionRepo, MemorySessionRepo } from "../session-store.js";
import { validateJournalHeader } from "../journal-schema.js";
const authority: import("../header-authority.js").HostJournalAuthority = { version: 1, rootId: "1".repeat(64), authorityId: "2".repeat(64), ownerKey: "fictional-owner", historyBucket: "fictional-bucket" };
const upgrade = { hostAuthority: authority, assertOwned: async () => {} };
const roots: string[] = [], repos: any[] = [];
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), "mono-native-upgrade-")); roots.push(value); return value; }
function repo(root: any, extra: {} = {}): JsonlSessionRepo { const value = new JsonlSessionRepo({ sessionsRoot: root, ...extra }); repos.push(value); return value; }
/** A host-owned journal guarded from its first header (switch target or cold epoch). */
async function fixture(r: any, content: string = "Fictional fact", guarded: boolean = true): Promise<{ repository: JsonlSessionRepo; metadata: any; before: NonSharedBuffer; }> {
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


it.each([false, true])("creates coordinated journals guarded from their first header (%s durable)", async (durable: boolean) => {
  const repository = durable ? repo(await root()) : new MemorySessionRepo();
  const store = await repository.create({ id: "born-guarded", ...upgrade });
  expect(store.metadata.ownershipSchemaVersion).toBe(1);
  await store.appendMessage({ role: "user", content: "Fictional guarded fact", timestamp: 17 });
  await store.sync(); await store.close();
  const reopened = await repository.open(store.metadata);
  await reopened.close();
});

it("current guarded writer repairs its own torn record only under held native ownership", async () => {
  const r = await root(), { metadata, before } = await fixture(r);
  await appendFile(metadata.path, '{"schemaVersion":2');
  const store = await repo(r).open(metadata); await store.close();
  expect(await readFile(metadata.path)).toEqual(before);
});

it("guarded headers reject foreign and instance ownership before native admission", async () => {
  const repository = repo(await root()), store = await repository.create({ id: "bound-guard", ...upgrade });
  await (store.beginTurn as (...args: any[]) => ReturnType<typeof store.beginTurn>)("synthetic-owner-test");
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
    // @ts-expect-error Deliberately malformed/uncoordinated deletion options.
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
  await repository.retireByHandle(next.metadata.id, { ...upgrade, disposition: ((("D") as "D")) });
  expect(await repository.list()).toEqual([]);
});

it.each([false, true])("validates every explicit deletion disposition on unguarded journals (durable: %s)", async (durable: boolean) => {
  const repository = durable ? repo(await root()) : new MemorySessionRepo();
  const store = await repository.create({ id: "unguarded-dispositions", cwd: "/fictional" });
  const metadata = { ...store.metadata }; await store.close();
  const actions = [() => repository.delete(metadata, currentOptions)];
  let currentOptions: any;
  if (repository instanceof JsonlSessionRepo) actions.push(() => repository.retire(metadata, currentOptions), () => repository.retireByHandle(metadata.id, currentOptions), () => repository.removeOwned(metadata, currentOptions));
  for (const disposition of ["P", "U", "unknown", undefined, null, 17]) {
    currentOptions = { disposition };
    for (const action of actions) {
      await expect(action()).rejects.toThrow("C/D disposition");
      expect((await repository.list()).map((entry: any) => entry.id)).toEqual([metadata.id]);
    }
  }
  // @ts-expect-error Unguarded deletion deliberately supplies only the disposition.
  await repository.delete(metadata, { disposition: "C" });
  expect(await repository.list()).toEqual([]);
  const next = await repository.create({ id: "default-deletion" }); await next.close();
  await repository.delete(next.metadata); expect(await repository.list()).toEqual([]);
});

it("memory metadata cannot forge or downgrade its private validated native header", async () => {
  const repository = new MemorySessionRepo();
  const plain = await repository.create({ id: "memory-forge", cwd: "/fictional" });
  const original = structuredClone(plain.metadata);
  Object.assign(plain.metadata, { format: "mono-harness", version: 2, ownershipSchemaVersion: 1,
    ownership: { kind: "unbound" }, initialHandle: { id: original.id }, hostAuthority: structuredClone(authority) });
  expect(await repository.list()).toEqual([original]);
  await plain.close();
  // Even direct mutation of the public catalogue copy cannot replace the private header.
  Object.assign(repository.sessions.get(original.id).metadata, plain.metadata);
  const reopened = await repository.open(plain.metadata);
  expect(reopened.metadata).toEqual(original);
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
  reopenedGuard.metadata.hostAuthority.ownerKey = "forged-owner";
  expect((await repository.list())[0].hostAuthority.ownerKey).toBe(authority.ownerKey);
  await reopenedGuard.close();
  await expect(repository.delete(header, { ...upgrade, disposition: ((("D") as "D")), hostAuthority: { ...authority, ownerKey: "forged-owner" } })).rejects.toThrow("authorized C/D");
  await repository.delete(header, { ...upgrade, disposition: ((("D") as "D")) }); expect(await repository.list()).toEqual([]);
});


it("keeps cancellation context separate from guarded deletion authority", async () => {
  const context = { abortSignal: new AbortController().signal };
  for (const durable of [false, true]) {
    const repository = durable ? repo(await root()) : new MemorySessionRepo();
    const plain = await repository.create({ id: "context-plain" }); await plain.close();
    await repository.delete(plain.metadata, context); expect(await repository.list()).toEqual([]);
    const guard = await repository.create({ id: "context-guard", ...upgrade }); await guard.close();
    const deletion = { ...upgrade, disposition: ((("D") as "D")) };
    await expect(repository.delete(guard.metadata, context)).rejects.toThrow("authority");
    await expect(repository.delete(guard.metadata, { ...context, ...deletion })).rejects.toThrow("Ambiguous");
    await expect(repository.delete(guard.metadata, deletion, deletion)).rejects.toThrow("Ambiguous");
    await repository.delete(guard.metadata, context, deletion); expect(await repository.list()).toEqual([]);
    if (repository instanceof JsonlSessionRepo) {
      const retired = await repository.create({ id: "context-retire", ...upgrade }); await retired.close();
      await repository.retire(retired.metadata, context, deletion); expect(await repository.list()).toEqual([]);
    }
  }
});



it.each(["projectionBinding", "inheritedCoverage", "artifactRef"])("refuses unguarded journal records carrying %s on open", async (field: string) => {
  const { repository, metadata, before } = await fixture(await root(), "Fictional fact", false);
  const lines = before.toString().trimEnd().split("\n").map((line: string) => JSON.parse(line));
  // Put the guarded extension on the first record. The header-aware guard must
  // reject it before ordinary record-shape validation or context application.
  if (field === "inheritedCoverage") lines[1].payload.compaction = { checkpoint: { inheritedCoverage: {} } };
  else lines[1].payload[field] = field === "projectionBinding" ? { version: 1,
    artifact: { id: "3".repeat(64), hash: "4".repeat(64) },
    coverage: { version: 1, sources: [] }, messageDigest: "5".repeat(64) } : {};
  const bytes = lines.map((line: any) => JSON.stringify(line)).join("\n") + "\n";
  await writeFile(metadata.path, bytes);
  await expect(repository.open(metadata)).rejects.toThrow("Invalid mono-agent harness session binding");
  expect(await readFile(metadata.path, "utf8")).toBe(bytes);
});
