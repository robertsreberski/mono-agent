import { MAX_CAPTURE_BYTES } from "../../engine/native-journal-storage.js";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { appendFile, chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { fork, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionRepo } from "../../engine/session-store.js";
import { resolveDurableNativeSessionRepo } from "../../engine/session-lifecycle.js";
import { createManagedNativeJournalStorage } from "../../execution/pi/storage-capability.js";
import { NativeEvidenceCapacityError } from "../../engine/native-journal-storage.js";
const roots = [], repos = [];
const authority = { version: 1, rootId: "1".repeat(64), authorityId: "2".repeat(64), ownerKey: "fictional-owner", historyBucket: "fictional-bucket" };
const from = { provider: "openai", api: "responses", model: "gpt-5.5", account: null };
// One deterministic guarded epoch: a switch target or a same-model cold rotation.
const context = { hostAuthority: authority, assertOwned: async () => {}, timestamp: 17, targetHandleId: "4".repeat(64) };
async function fixture(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "mono-native-storage-")); roots.push(root);
  const repo = new JsonlSessionRepo({ sessionsRoot: root }); repos.push(repo);
  const store = await repo.create({ id: "3".repeat(64), cwd: "/fictional" });
  await store.scopedWrite(async () => {
    await store.writeRecord("owner_binding", { kind: "host", ownerKey: authority.ownerKey, historyBucket: authority.historyBucket });
    await store.writeRecord("handle_binding", { handleId: store.metadata.id, baseRevision: 0, authoritative: true, model: { provider: from.provider, id: from.model, api: from.api } });
  }, "bind");
  await store.appendMessage({ role: "user", content: "Fictional source fact", timestamp: 17 }, /** @type {any} */ ("source-message")); await store.sync();
  const metadata = { ...store.metadata }; await store.close();
  const bridge = createManagedNativeJournalStorage({ sessionsRoot: root, ...extra });
  const source = await bridge.freeze({ epoch: "9".repeat(64), handleId: metadata.id,
    ownerKey: authority.ownerKey, historyBucket: authority.historyBucket, provenance: from });
  return { root, repo, metadata, bridge, source, before: await readFile(metadata.path) };
}
afterEach(async () => { for (const repo of repos.splice(0)) await repo.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
/** Outgoing unguarded source plus its created guarded switch target. */
async function lifecycleFixture(extra = {}) {
  const f = await fixture();
  await f.bridge.createEpoch(context);
  const target = (await f.repo.listOwned()).find((m) => m.id === context.targetHandleId);
  const bridge = createManagedNativeJournalStorage({ sessionsRoot: f.root, ...extra });
  return { ...f, bridge, target, journals: { source: { handleId: f.metadata.id, journalId: f.metadata.journalId }, target: { handleId: target.id, journalId: target.journalId } },
    deletion: { hostAuthority: authority, assertOwned: context.assertOwned, disposition: "C" } };
}
it("creates the exact initialized guarded epoch idempotently, without copied context or touching the source", async () => {
  const f = await fixture();
  await f.bridge.createEpoch(context); const target = (await f.repo.listOwned()).find((m) => m.id === context.targetHandleId);
  const bytes = await readFile(target.path); await f.bridge.createEpoch(context); expect(await readFile(target.path)).toEqual(bytes);
  const rows = bytes.toString().trim().split("\n").map((line) => JSON.parse(line));
  expect(rows[0]).toMatchObject({ ownershipSchemaVersion: 1, hostAuthority: authority }); expect(rows.slice(1)).toHaveLength(4);
  expect(rows.filter((r) => r.kind === "message")).toHaveLength(0);
  expect(await readFile(f.metadata.path)).toEqual(f.before);
  expect((await f.bridge.inventory()).bytes).toBe(bytes.length); expect((await f.bridge.inventory()).stagedBytes).toBe(0);
  // A later turn makes the epoch non-initial: recreation refuses instead of truncating.
  await appendFile(target.path, "{\"later\":true}\n"); await expect(f.bridge.createEpoch(context)).rejects.toThrow();
});
it("rejects lost authority before any epoch publication", async () => {
  const f = await fixture();
  await expect(f.bridge.createEpoch({ ...context, assertOwned: async () => { throw new Error("Lost fictional owner"); } })).rejects.toThrow("Lost fictional owner");
  expect(await f.repo.listOwned()).toHaveLength(1);
});
it.each(["epoch_stage_created", "epoch_stage_synced", "epoch_renamed", "epoch_directory_synced"])("replays atomic epoch publication after an ordinary interruption at %s", async (boundary) => {
  const f = await fixture(); let thrown = false;
  const options = { id: context.targetHandleId, timestamp: context.timestamp, hostAuthority: authority, assertOwned: context.assertOwned,
    onPhase: async (phase) => { if (!thrown && phase === boundary) { thrown = true; throw new Error("Interrupted publication"); } } };
  await expect(f.repo.createGuardedEpoch(options)).rejects.toThrow("Interrupted publication");
  const published = await f.repo.createGuardedEpoch(options), before = await readFile(published.path);
  expect(await f.repo.createGuardedEpoch(options)).toEqual(published); expect(await readFile(published.path)).toEqual(before);
  expect(before.toString().trim().split("\n")).toHaveLength(5);
  expect((await readdir(f.repo.directory)).filter((name) => name.endsWith(".creating"))).toHaveLength(0);
});
it("preserves a foreign deterministic epoch stage and charges its bytes", async () => {
  const f = await fixture(); const plan = JsonlSessionRepo.guardedEpochPlan({ id: context.targetHandleId, timestamp: 17, hostAuthority: authority });
  const stage = join(f.repo.directory, `${plan.header.journalId}.jsonl.creating`);
  // Use the real creator to establish owner-private metadata then poison only its own test stage.
  await expect(f.repo.createGuardedEpoch({ id: context.targetHandleId, timestamp: 17, hostAuthority: authority, assertOwned: context.assertOwned,
    onPhase: async (phase) => { if (phase === "epoch_stage_created") throw new Error("Interrupted"); } })).rejects.toThrow();
  await appendFile(stage, "foreign evidence"); const before = await readFile(stage);
  await expect(f.repo.createGuardedEpoch({ id: context.targetHandleId, timestamp: 17, hostAuthority: authority, assertOwned: context.assertOwned })).rejects.toThrow();
  expect(await readFile(stage)).toEqual(before); expect((await f.bridge.inventory([plan.header.journalId])).bytes).toBe(before.length);
});

it("charges prototype-shaped native stems without prototype-key ledger credits", async () => {
  const f = await fixture(); await writeFile(join(f.repo.directory, "constructor.jsonl"), "opaque preserved evidence", { mode: 0o600 });
  expect((await f.bridge.inventory()).bytes).toBe(0);
  const inventory = await f.bridge.inventory(["constructor"]); expect(inventory.journals.constructor.retainedBytes).toBe(Buffer.byteLength("opaque preserved evidence"));
  expect(inventory.bytes).toBe(Buffer.byteLength("opaque preserved evidence"));
});

it("freezes legacy model/API from owned binding bytes without auth, never inventing account evidence", async () => {
  const f = await fixture(), { provenance: _provenance, ...coordinate } = f.source;
  expect(await f.bridge.freeze(coordinate)).toEqual(f.source); expect(f.source.provenance.account).toBeNull();
  await expect(f.bridge.freeze({ ...coordinate, ownerKey: "fictional-wrong-owner" })).rejects.toThrow();
});
it.each([
  ["legacy identical account metadata", ["fictional-account", "fictional-account"], null],
  ["different accounts across operations", ["fictional-account", "fictional-other"], null],
  ["one operation without recorded provenance", ["fictional-account", undefined], null],
  ["explicit unknown account", [null, null], null],
  ["no content-bearing operation", [], null],
])("ignores legacy unguarded account metadata: %s", async (_name, accounts, expected) => {
  const root = await mkdtemp(join(tmpdir(), "mono-native-lease-")); roots.push(root);
  const repo = new JsonlSessionRepo({ sessionsRoot: root }); repos.push(repo);
  const store = await repo.create({ id: "3".repeat(64), cwd: "/fictional" });
  await store.scopedWrite(async () => {
    await store.writeRecord("owner_binding", { kind: "host", ownerKey: authority.ownerKey, historyBucket: authority.historyBucket });
    await store.writeRecord("handle_binding", { handleId: store.metadata.id, baseRevision: 0, authoritative: true, model: { provider: from.provider, id: from.model, api: from.api } });
  }, "bind");
  for (const [index, account] of accounts.entries()) {
    await store.beginTurn(`fictional-turn-${index}`, undefined, undefined, undefined);
    await store.openOperation(`fictional-op-${index}`, { model: { provider: from.provider, api: from.api, id: from.model },
      ...(account === undefined ? {} : { nativeProvenance: { ...from, account } }) });
    await store.appendMessage({ role: "user", content: `Fictional fact ${index}`, timestamp: 17 });
    await store.closeOperation(`fictional-op-${index}`, "completed"); await store.endTurn(`fictional-turn-${index}`, "completed");
  }
  await store.sync(); const metadata = { ...store.metadata }; await store.close();
  const bridge = createManagedNativeJournalStorage({ sessionsRoot: root });
  const frozen = await bridge.freeze({ epoch: "9".repeat(64), handleId: metadata.id, ownerKey: authority.ownerKey, historyBucket: authority.historyBucket });
  expect(frozen.provenance).toEqual({ ...from, account: expected });
});
it("deterministic lookup ignores misnamed damage, including when the requested journal is missing", async () => {
  const f = await fixture(), present = { handleId: f.metadata.id }, absent = { handleId: "a".repeat(64) };
  await writeFile(join(f.repo.directory, ".DS_Store"), "fictional", { mode: 0o600 });
  await writeFile(join(f.repo.directory, "notes.txt~"), "fictional", { mode: 0o644 });
  await mkdir(join(f.repo.directory, "scratch"));
  expect(await f.bridge.inspectCurrentJournal(present)).toEqual({ status: "present" });
  expect(await f.bridge.inspectCurrentJournal(absent)).toEqual({ status: "missing" });
  // A headerless published journal cannot be attributed: it may be the lost one.
  const foreign = join(f.repo.directory, "11111111-1111-4111-8111-111111111111.jsonl");
  for (const bytes of ["", "{not json\n"]) {
    await writeFile(foreign, bytes, { mode: 0o600 });
    expect(await f.bridge.inspectCurrentJournal(present)).toEqual({ status: "present" });
    expect(await f.bridge.inspectCurrentJournal(absent)).toEqual({ status: "missing" });
    expect(await readFile(foreign, "utf8")).toBe(bytes);
  }
  // A readable header for another handle is unrelated evidence and never blocks.
  await writeFile(foreign, f.before.toString().replaceAll(f.metadata.id, "b".repeat(64)).replaceAll(f.metadata.journalId, "11111111-1111-4111-8111-111111111111"), { mode: 0o600 });
  expect(await f.bridge.inspectCurrentJournal(absent)).toEqual({ status: "missing" });
});
it("charges an enrolled hard-linked or unopenable journal as owner damage without failing the root inventory", async () => {
  const f = await lifecycleFixture(), ids = [f.metadata.journalId, f.target.journalId], targetBytes = await readFile(f.target.path);
  const outside = await mkdtemp(join(tmpdir(), "mono-native-alias-")); roots.push(outside);
  await link(f.target.path, join(outside, "alias.jsonl"));
  const linked = await f.bridge.inventory(ids);
  expect(linked.journals[f.target.journalId]).toEqual({ retainedBytes: targetBytes.length, stagedBytes: 0, damaged: true });
  expect(linked.journals[f.metadata.journalId]).toEqual({ retainedBytes: f.before.length, stagedBytes: 0 });
  expect(linked.bytes).toBe(targetBytes.length + f.before.length);
  expect(await f.bridge.deletionBlocked([f.journals.target], authority)).toBe(true); // damaged evidence is never a victim
  expect((await stat(f.target.path)).nlink).toBe(2); expect(await readFile(f.target.path)).toEqual(targetBytes);
  await rm(join(outside, "alias.jsonl")); await chmod(f.metadata.path, 0o644);
  const insecure = await f.bridge.inventory(ids);
  expect(insecure.journals[f.metadata.journalId]).toEqual({ retainedBytes: f.before.length, stagedBytes: 0, damaged: true });
  expect(insecure.journals[f.target.journalId].damaged).toBeUndefined();
  expect(await f.bridge.inspectCurrentJournal({ handleId: f.target.id, journalId: f.target.journalId })).toEqual({ status: "present" });
  expect(await readFile(f.metadata.path)).toEqual(f.before);
});
it("a damaged legacy source blocks only its own handle's missing verdict", async () => {
  const f = await fixture(), legacy = join(f.root, "legacy"), absent = { handleId: "a".repeat(64) }; await mkdir(legacy);
  await writeFile(join(legacy, ".DS_Store"), "fictional"); await writeFile(join(legacy, `t_${"b".repeat(64)}.jsonl`), "{not json\n");
  expect(await f.bridge.inspectCurrentJournal({ handleId: f.metadata.id })).toEqual({ status: "present" });
  expect(await f.bridge.inspectCurrentJournal(absent)).toEqual({ status: "missing" });
  expect(await f.bridge.inspectCurrentJournal({ handleId: "b".repeat(64) })).toEqual({ status: "unreadable", reason: "unattributed" });
  expect(await readFile(join(legacy, `t_${"b".repeat(64)}.jsonl`), "utf8")).toBe("{not json\n");
});
const worker = fileURLToPath(new URL("./fixtures/native-journal-storage-worker.mjs", import.meta.url));
it.skipIf(process.platform === "win32").each(["epoch_stage_created", "epoch_stage_synced", "epoch_renamed", "epoch_directory_synced"])("recovers epoch creation twice in fresh processes after SIGKILL at %s", async (phase) => {
  const f = await fixture(); await writeFile(join(f.root, "native-proof.json"), JSON.stringify({ context }), { mode: 0o600 });
  const child = fork(worker, [f.root, phase], { silent: true }); let error = "";
  child.stderr.on("data", (bytes) => { error += bytes; });
  const exited = once(child, "exit");
  try {
    await Promise.race([once(child, "message"), exited.then(() => { throw new Error(`Proof owner exited before boundary: ${error}`); }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Boundary timeout")), 15_000); timer.unref(); })]);
    child.kill("SIGKILL"); expect((await exited)[1]).toBe("SIGKILL");
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
  const run = promisify(execFile);
  const first = JSON.parse((await run(process.execPath, [worker, f.root], { timeout: 30_000 })).stdout);
  const second = JSON.parse((await run(process.execPath, [worker, f.root], { timeout: 30_000 })).stdout);
  expect(second).toEqual(first); expect(second.inventory.stagedBytes).toBe(0);
  expect((await f.repo.listOwned()).map((row) => row.id).sort()).toEqual([f.metadata.id, context.targetHandleId].sort());
  expect(await readFile(f.metadata.path)).toEqual(f.before);
}, 60_000);

it("retires an unguarded switch source by its exact frozen header and a guarded journal only under its authority", async () => {
  const f = await lifecycleFixture(), target = await readFile(f.target.path);
  await f.bridge.deleteJournals([f.journals.source], f.deletion);
  await f.bridge.deleteJournals([f.journals.source], f.deletion); // idempotent
  expect(await readdir(f.repo.directory)).toEqual([`${f.target.journalId}.jsonl`]); expect(await readFile(f.target.path)).toEqual(target);
  await expect(f.bridge.deleteJournals([f.journals.target], { ...f.deletion, hostAuthority: { ...authority, authorityId: "e".repeat(64) } })).rejects.toThrow();
  await expect(f.bridge.deleteJournals([{ ...f.journals.target, handleId: "e".repeat(64) }], f.deletion)).rejects.toThrow();
  expect(await readFile(f.target.path)).toEqual(target);
  await f.bridge.deleteJournals([f.journals.target], { ...f.deletion, disposition: "D" });
  expect(await f.bridge.inventory()).toEqual({ bytes: 0, stagedBytes: 0, journals: {} });
});
it("preflights every member before deleting any foreign header or unknown copy", async () => {
  const f = await lifecycleFixture(), all = [f.journals.source, f.journals.target];
  const original = await readFile(f.target.path);
  const rows = original.toString().trim().split("\n").map((line) => JSON.parse(line));
  rows[0].hostAuthority.authorityId = "e".repeat(64);
  await writeFile(f.target.path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  await expect(f.bridge.deleteJournals(all, { ...f.deletion, disposition: "D" })).rejects.toThrow();
  expect(await readFile(f.metadata.path)).toEqual(f.before);
  await writeFile(f.target.path, original, { mode: 0o600 });
  await writeFile(`${f.target.path}.unknown`, "foreign evidence", { mode: 0o600 });
  await expect(f.bridge.deleteJournals(all, { ...f.deletion, disposition: "D" })).rejects.toThrow();
  expect(await readFile(f.metadata.path)).toEqual(f.before);
});
it("refuses a foreign live writer and reasserts ownership before each unlink", async () => {
  const f = await lifecycleFixture(); const writer = await f.repo.open(f.target, { repair: false, wait: false });
  try { await expect(f.bridge.deleteJournals([f.journals.target], f.deletion)).rejects.toThrow(); }
  finally { await writer.close(); }
  const before = await f.bridge.inventory();
  await expect(f.bridge.deleteJournals([f.journals.target], { ...f.deletion, assertOwned: async () => { throw new Error("Lost fictional owner"); } })).rejects.toThrow("Lost fictional owner");
  expect(await f.bridge.inventory()).toEqual(before); expect(await readdir(f.repo.directory)).toHaveLength(2);
});
const lifecycleWorker = fileURLToPath(new URL("./fixtures/native-lifecycle-storage-worker.mjs", import.meta.url));
it.skipIf(process.platform === "win32").each([
  ["cold", "epoch_stage_created"], ["cold", "epoch_renamed"], ["cold", "native_file_removed"], ["cold", "native_members_directory_synced"],
  ["delete", "native_file_removed"], ["delete", "native_member_directory_synced"], ["delete", "native_member_removed"], ["delete", "native_members_directory_synced"],
])("recovers native %s twice in fresh processes after SIGKILL at %s", async (operation, phase) => {
  const f = await lifecycleFixture();
  const cold = { ...context, targetHandleId: "b".repeat(64), timestamp: 23 };
  await writeFile(join(f.root, "lifecycle-proof.json"), JSON.stringify({ current: f.journals.target, cold,
    deletion: { ...f.deletion, disposition: operation === "delete" ? "D" : "C" }, operation }), { mode: 0o600 });
  const child = fork(lifecycleWorker, [f.root, phase], { silent: true }); let error = "";
  child.stderr.on("data", (bytes) => { error += bytes; }); const exited = once(child, "exit"); let timer;
  try {
    await Promise.race([once(child, "message"), exited.then(() => { throw new Error(`Proof owner exited before boundary: ${error}`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Boundary timeout")), 15000); })]);
    child.kill("SIGKILL"); expect((await exited)[1]).toBe("SIGKILL");
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
  const run = promisify(execFile);
  const first = JSON.parse((await run(process.execPath, [lifecycleWorker, f.root], { timeout: 30000 })).stdout);
  const second = JSON.parse((await run(process.execPath, [lifecycleWorker, f.root], { timeout: 30000 })).stdout);
  expect(second).toEqual(first); expect(second.inventory.stagedBytes).toBe(0);
  const names = (await readdir(f.repo.directory)).sort();
  if (operation === "cold") expect(names).toEqual([`${f.metadata.journalId}.jsonl`, `${(await f.repo.listOwned()).find((m) => m.id === cold.targetHandleId).journalId}.jsonl`].sort());
  else expect(names).toEqual([`${f.metadata.journalId}.jsonl`]);
}, 60000);
it("does not create a writer lock for an absent-journal deletion probe", async () => {
  const f = await lifecycleFixture(), locks = join(f.root, "locks");
  await f.bridge.deleteJournals([f.journals.target], { ...f.deletion, disposition: "D" });
  const before = (await readdir(locks)).sort();
  expect(await f.bridge.deletionBlocked([f.journals.target], authority)).toBe(false);
  expect((await readdir(locks)).sort()).toEqual(before);
  const orphan = `${f.target.path}.importing`; await writeFile(orphan, "unknown copy", { mode: 0o600 });
  expect(await f.bridge.deletionBlocked([f.journals.target], authority)).toBe(true); expect((await readdir(locks)).sort()).toEqual(before);
});
it("shares runtime repository identity with the bridge for a trailing-slash sessions root", async () => {
  const f = await fixture(), runtime = resolveDurableNativeSessionRepo(`${f.root}/`); repos.push(runtime);
  expect(resolveDurableNativeSessionRepo(f.root)).toBe(runtime);
  await createManagedNativeJournalStorage({ sessionsRoot: `${f.root}/` }).createEpoch(context);
  expect(runtime.root).toBe(f.root); expect((await runtime.listOwned()).map((row) => row.id).sort()).toEqual([f.metadata.id, context.targetHandleId].sort());
});
it("charges guarded unreadable-owner evidence only in the pinned root and exact bucket", async () => {
  const f = await lifecycleFixture(), retained = (await f.bridge.inventory()).bytes;
  const filter = { rootId: authority.rootId,
    conversationKeys: [createHash("sha256").update("mono-agent-history-v1\0").update(authority.historyBucket).digest("hex")] };
  const foreignRoot = { ...authority, rootId: "e".repeat(64), authorityId: "f".repeat(64) };
  await f.repo.createGuardedEpoch({ id: "d".repeat(64), timestamp: 17, hostAuthority: foreignRoot, assertOwned: context.assertOwned });
  await f.repo.createGuardedEpoch({ id: "c".repeat(64), timestamp: 17,
    hostAuthority: { ...authority, ownerKey: "fictional-other-owner", historyBucket: "fictional-other-bucket" }, assertOwned: context.assertOwned });
  const legacy = await f.repo.create({ id: "f".repeat(64), cwd: "/fictional" }); await legacy.close();
  expect((await f.bridge.inventory([])).bytes).toBe(0);
  expect((await f.bridge.inventory([], filter)).bytes).toBe(retained);
  expect((await f.bridge.inventory([f.journals.target.journalId], filter)).bytes).toBe(retained);
});
it("captures exactly one current journal, or canonical gaps when it is missing, and throws the typed capacity error", async () => {
  const f = await fixture(), owner = { assertOwned: async () => {}, ownerKey: authority.ownerKey, historyBucket: authority.historyBucket };
  const view = await f.bridge.captureEvidence(f.source, owner);
  expect(view.segments).toHaveLength(1); expect(view.segments[0].descriptor).not.toHaveProperty("epoch"); expect(view.prior).toBeNull();
  const gap = { reference: "canonical:fixture", reason: "journal_missing", afterJournalId: null, messages: [{ role: "user", content: "Fictional canonical fact" }] };
  const missing = await f.bridge.captureEvidence(null, { ...owner, gaps: [gap] });
  expect(missing.segments).toEqual([]); expect(missing.gaps).toEqual([gap]);
  await expect(f.bridge.captureEvidence(null, owner)).rejects.toThrow();
  // The limit bounds retained evidence, not the physical journal: an effective
  // tail (no checkpoint) larger than the limit is the typed capacity refusal.
  const store = await f.repo.open(f.metadata);
  await store.appendMessage({ role: "user", content: "x".repeat(MAX_CAPTURE_BYTES), timestamp: 18 }, /** @type {any} */ ("oversized-tail")); await store.sync(); await store.close();
  const source = await f.bridge.freeze({ epoch: "9".repeat(64), handleId: f.metadata.id, ownerKey: authority.ownerKey, historyBucket: authority.historyBucket, provenance: from });
  const capture = () => f.bridge.captureEvidence(source, owner);
  await expect(capture()).rejects.toBeInstanceOf(NativeEvidenceCapacityError);
  await expect(capture()).rejects.toMatchObject({ code: "ERR_NATIVE_EVIDENCE_CAPTURE_LIMIT" });
});
// Missing-vs-corrupt classification for owner-approved cold recovery.
it("classifies the current journal as present, definitively missing or unreadable without mutation", async () => {
  const f = await fixture(), exact = { handleId: f.metadata.id, journalId: f.metadata.journalId };
  expect(await f.bridge.inspectCurrentJournal(exact)).toEqual({ status: "present" });
  expect(await f.bridge.inspectCurrentJournal({ handleId: f.metadata.id })).toEqual({ status: "present" });
  expect(await f.bridge.inspectCurrentJournal({ handleId: "a".repeat(64) })).toEqual({ status: "missing" });
  expect(await f.bridge.inspectCurrentJournal({ handleId: "a".repeat(64), journalId: "fictional-absent" })).toEqual({ status: "missing" });
  // A torn final line belongs to the existing open/repair path, never to "missing".
  await appendFile(f.metadata.path, "{\"torn\":");
  expect(await f.bridge.inspectCurrentJournal(exact)).toEqual({ status: "present" });
  const lines = f.before.toString().split("\n");
  // The probe is O(1): header identity only. Record damage is refused by the
  // ordinary open/capture path, never reported as missing or silently used.
  const record = [...lines.slice(0, 2), "{\"broken\":", ...lines.slice(3)].join("\n");
  await writeFile(f.metadata.path, record);
  expect(await f.bridge.inspectCurrentJournal(exact)).toEqual({ status: "present" });
  await expect(f.bridge.captureEvidence(f.source, { assertOwned: async () => {}, ownerKey: authority.ownerKey, historyBucket: authority.historyBucket })).rejects.toThrow();
  expect(await readFile(f.metadata.path, "utf8")).toBe(record);
  const header = ["{not json", ...lines.slice(1)].join("\n");
  await writeFile(f.metadata.path, header);
  expect(await f.bridge.inspectCurrentJournal(exact)).toMatchObject({ status: "unreadable" });
  expect(await f.bridge.inspectCurrentJournal({ handleId: f.metadata.id })).toMatchObject({ status: "unreadable" });
  expect(await readFile(f.metadata.path, "utf8")).toBe(header);
  // Staged-only bytes are uncertainty, not absence.
  await writeFile(`${f.metadata.path}.importing`, f.before, { mode: 0o600 }); await rm(f.metadata.path);
  expect(await f.bridge.inspectCurrentJournal(exact)).toEqual({ status: "unreadable", reason: "staged_only" });
  await expect(f.bridge.inspectCurrentJournal({ handleId: "../escape" })).rejects.toThrow();
});
it.each([".importing", ".creating"])("a handle-only staged-only %s journal is unreadable, never missing, and is never reclaimed", async (suffix) => {
  const f = await fixture(), staged = `${f.metadata.path}${suffix}`;
  await writeFile(staged, f.before, { mode: 0o600 }); await rm(f.metadata.path);
  expect(await f.bridge.inspectCurrentJournal({ handleId: f.metadata.id })).toEqual({ status: "unreadable", reason: "staged_only" });
  expect(await readFile(staged)).toEqual(f.before);
  // Like listOwnedUnlocked's reclaim rule, a partial or header-only creation
  // stage is a failed unpublished create, not evidence: ignored, never unlinked.
  await rm(staged); const partial = join(f.repo.directory, "00000000-0000-4000-8000-000000000000.jsonl.creating");
  await writeFile(partial, "{\"format\"", { mode: 0o600 });
  const headerOnly = `${f.metadata.path}.creating`; await writeFile(headerOnly, `${f.before.toString().split("\n")[0]}\n`, { mode: 0o600 });
  expect(await f.bridge.inspectCurrentJournal({ handleId: f.metadata.id })).toEqual({ status: "missing" });
  expect(await readFile(partial, "utf8")).toBe("{\"format\""); expect((await readFile(headerOnly, "utf8")).split("\n")).toHaveLength(2);
});
it("retention inventory and deletion ignore stray entries and unattributed damaged journals, never deleting them", async () => {
  const f = await lifecycleFixture(), all = await f.bridge.inventory(), ids = [f.journals.source.journalId, f.journals.target.journalId], scoped = await f.bridge.inventory(ids);
  const strays = { ".DS_Store": "fictional", "notes.txt~": "fictional", "11111111-1111-4111-8111-111111111111.jsonl": "", "bad name.jsonl": "{not json\n" };
  for (const [name, text] of Object.entries(strays)) await writeFile(join(f.repo.directory, name), text, { mode: 0o600 });
  await mkdir(join(f.repo.directory, "scratch")); await mkdir(join(f.repo.directory, "33333333-3333-4333-8333-333333333333.jsonl"));
  expect(await f.bridge.inventory()).toEqual(all);
  expect(await f.bridge.inventory(ids)).toEqual(scoped);
  expect(await f.bridge.inventory(ids, { rootId: authority.rootId, conversationKeys: ["c".repeat(64)] })).toEqual(scoped);
  await f.bridge.deleteJournals([f.journals.source, f.journals.target], { hostAuthority: authority, assertOwned: context.assertOwned, disposition: "D" });
  expect((await f.bridge.inventory()).bytes).toBe(0);
  for (const [name, text] of Object.entries(strays)) expect(await readFile(join(f.repo.directory, name), "utf8")).toBe(text);
  expect((await stat(join(f.repo.directory, "scratch"))).isDirectory()).toBe(true);
});


it("unknown-owner legacy damage does not block a missing current journal; named damage does", async () => {
  const f = await fixture(), absent = { handleId: "a".repeat(64) };
  const legacyDir = join(f.root, "fictional-legacy"); await mkdir(legacyDir, { mode: 0o700 });
  const unknown = join(legacyDir, "damaged.jsonl"); await writeFile(unknown, "{torn", { mode: 0o600 });
  expect(await f.bridge.inspectCurrentJournal(absent)).toEqual({ status: "missing" });
  const named = join(legacyDir, `2000-01-01T00-00-00-000Z_${absent.handleId}.jsonl`);
  await writeFile(named, "{torn", { mode: 0o600 });
  expect(await f.bridge.inspectCurrentJournal(absent)).toMatchObject({ status: "unreadable" });
  expect(await readFile(unknown, "utf8")).toBe("{torn");
});
