import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { appendFile, mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { fork, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionRepo } from "@mono-agent/harness/session-store.js";
import { resolveDurableNativeSessionRepo } from "../../ai/providers/pi-native/session-lifecycle.js";
import { createManagedNativeJournalStorage, NativeEvidenceCapacityError, MAX_CAPTURE_JOURNALS } from "../../ai/providers/pi-native/native-journal-storage.js";
const roots = [], repos = [];
const authority = { version: 1, canonicalVersion: 4, rootId: "1".repeat(64), authorityId: "2".repeat(64), ownerKey: "fictional-owner", historyBucket: "fictional-bucket" };
const from = { provider: "openai", api: "responses", model: "gpt-5.5", account: null };
const to = { provider: "anthropic", api: "messages", model: "claude-sonnet-4-6", account: null };
const context = { hostAuthority: authority, assertOwned: async () => {}, timestamp: 17, sourceRevision: 1, fromModelKey: "openai:gpt-5.5",
  targetHandleId: "4".repeat(64), targetEpoch: "5".repeat(64), targetProvenance: to,
  event: { switchId: "6".repeat(64), timestamp: 17, from, to, artifactRef: { id: "7".repeat(64), hash: "8".repeat(64) } } };
async function fixture(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "mono-native-storage-")); roots.push(root);
  const repo = new JsonlSessionRepo({ sessionsRoot: root }); repos.push(repo);
  const store = await repo.create({ id: "3".repeat(64), cwd: "/fictional" });
  await store.scopedWrite(async () => {
    await store.writeRecord("owner_binding", { kind: "host", ownerKey: authority.ownerKey, historyBucket: authority.historyBucket });
    await store.writeRecord("handle_binding", { handleId: store.metadata.id, baseRevision: 0, authoritative: true, model: { provider: from.provider, id: from.model, api: from.api } });
  }, "bind");
  await store.appendMessage({ role: "user", content: "Fictional source fact", timestamp: 17 }, "source-message"); await store.sync();
  const metadata = { ...store.metadata }; await store.close();
  const bridge = createManagedNativeJournalStorage({ sessionsRoot: root, ...extra });
  const source = await bridge.freeze({ epoch: "9".repeat(64), ordinal: 0, handleId: metadata.id, predecessorJournalId: null,
    ownerKey: authority.ownerKey, historyBucket: authority.historyBucket, provenance: from });
  return { root, repo, metadata, bridge, source, before: await readFile(metadata.path) };
}
afterEach(async () => { for (const repo of repos.splice(0)) await repo.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("measures native bytes and peak copy before any native migration or event", async () => {
  const f = await fixture(), measured = await f.bridge.measureSwitch([f.source], context);
  expect(measured.retainedNativeBytes).toBeGreaterThan(f.before.length);
  expect(measured.headerCopyBytes).toBeGreaterThan(f.before.length);
  expect((await f.bridge.inventory()).bytes).toBe(0);
  expect((await f.bridge.inventory([f.source.journalId])).bytes).toBe(f.before.length);
  expect(await readFile(f.metadata.path)).toEqual(f.before);
  expect(await f.repo.listOwned()).toHaveLength(1);
});
it("publishes a source reference and exact initialized epoch idempotently without copied context", async () => {
  const f = await fixture(); const first = await f.bridge.publishSwitch([f.source], context);
  const after = await readFile(f.metadata.path), second = await f.bridge.publishSwitch([f.source], context);
  expect(second).toEqual(first); expect(await readFile(f.metadata.path)).toEqual(after);
  const source = after.toString().trim().split("\n").map((line) => JSON.parse(line));
  expect(source[0].hostAuthority).toEqual(authority); expect(source.filter((r) => r.kind === "model_change")).toHaveLength(1);
  const target = (await f.repo.listOwned()).find((m) => m.id === context.targetHandleId);
  const targetBytes = await readFile(target.path), rows = targetBytes.toString().trim().split("\n").map((line) => JSON.parse(line));
  expect(rows.slice(1)).toHaveLength(4); expect(rows.filter((r) => r.kind === "message")).toHaveLength(0);
  expect(first[1]).toMatchObject({ epoch: context.targetEpoch, predecessorJournalId: f.source.journalId, sourceSeq: 4, sourceTipId: null });
  expect((await f.bridge.inventory()).bytes).toBe(after.length + targetBytes.length);
  expect((await f.bridge.inventory()).stagedBytes).toBe(0);
});
it("rejects changed immutable references without native mutations", async () => {
  const f = await fixture(); await f.bridge.publishSwitch([f.source], context); const before = await readFile(f.metadata.path);
  await expect(f.bridge.publishSwitch([f.source], { ...context, event: { ...context.event, artifactRef: { ...context.event.artifactRef, hash: "a".repeat(64) } } })).rejects.toThrow();
  expect(await readFile(f.metadata.path)).toEqual(before);
});
it("preserves an unknown native tail rather than allowing generic repair", async () => {
  const f = await fixture(); await appendFile(f.metadata.path, "unrecognized partial evidence"); const before = await readFile(f.metadata.path);
  await expect(f.bridge.publishSwitch([f.source], context)).rejects.toThrow(); expect(await readFile(f.metadata.path)).toEqual(before);
});
it("rejects live native writers before upgrade or target publication", async () => {
  const f = await fixture(), writer = await f.repo.open(f.metadata, { repair: false, wait: false });
  try { await expect(f.bridge.publishSwitch([f.source], context)).rejects.toThrow(); expect(await readFile(f.metadata.path)).toEqual(f.before); }
  finally { await writer.close(); }
  expect(await f.repo.listOwned()).toHaveLength(1);
});
it.each(["model_change_started", "model_change_appended", "model_change_ended", "model_change_synced"])("finishes only its own deterministic event frame after %s", async (boundary) => {
  let interrupted = false;
  const f = await fixture({ onPhase: async (phase) => { if (!interrupted && phase === boundary) { interrupted = true; throw new Error("Interrupted event"); } } });
  await expect(f.bridge.publishSwitch([f.source], context)).rejects.toThrow("Interrupted event");
  const result = await f.bridge.publishSwitch([f.source], context);
  expect(await f.bridge.publishSwitch([f.source], context)).toEqual(result);
  const rows = (await readFile(f.metadata.path)).toString().trim().split("\n").map((line) => JSON.parse(line));
  expect(rows.filter((r) => r.kind === "model_change")).toHaveLength(1);
  expect(rows.filter((r) => r.kind === "turn_start" && r.payload.config.cause === "model-change")).toHaveLength(1);
  expect(rows.filter((r) => r.kind === "turn_end").length).toBe(rows.filter((r) => r.kind === "turn_start").length);
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

const worker = fileURLToPath(new URL("./fixtures/native-journal-storage-worker.mjs", import.meta.url));
it.skipIf(process.platform === "win32").each(["model_change_started", "model_change_appended", "model_change_ended", "model_change_synced",
  "epoch_stage_created", "epoch_stage_synced", "epoch_renamed", "epoch_directory_synced"])("recovers twice in fresh processes after SIGKILL at %s", async (phase) => {
  const f = await fixture(); await writeFile(join(f.root, "native-proof.json"), JSON.stringify({ source: f.source, context }), { mode: 0o600 });
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
  expect(second).toEqual(first); expect(second.chain).toHaveLength(2); expect(second.chain[1].sourceSeq).toBe(4);
  expect(second.inventory.stagedBytes).toBe(0);
  const rows = (await readFile(f.metadata.path)).toString().trim().split("\n").map((line) => JSON.parse(line));
  expect(rows.filter((row) => row.kind === "model_change")).toHaveLength(1);
  expect(rows.filter((row) => row.kind === "message")).toHaveLength(1);
  expect(rows.filter((row) => row.kind === "turn_start").length).toBe(rows.filter((row) => row.kind === "turn_end").length);
}, 60_000);

it("charges prototype-shaped native stems without prototype-key ledger credits", async () => {
  const f = await fixture(); await writeFile(join(f.repo.directory, "constructor.jsonl"), "opaque preserved evidence", { mode: 0o600 });
  expect((await f.bridge.inventory()).bytes).toBe(0);
  const inventory = await f.bridge.inventory(["constructor"]); expect(inventory.journals.constructor.retainedBytes).toBe(Buffer.byteLength("opaque preserved evidence"));
  expect(inventory.bytes).toBe(Buffer.byteLength("opaque preserved evidence"));
});

const coldContext = { hostAuthority: authority, assertOwned: async () => {}, timestamp: 23,
  targetHandleId: "b".repeat(64), targetEpoch: "c".repeat(64) };
async function lifecycleFixture(extra = {}) {
  const f = await fixture();
  const chain = await f.bridge.publishSwitch([f.source], context);
  const bridge = createManagedNativeJournalStorage({ sessionsRoot: f.root, ...extra });
  const deletion = { hostAuthority: authority, assertOwned: context.assertOwned,
    disposition: "C", eligibleJournalId: chain.at(-1).journalId };
  return { ...f, bridge, chain, deletion };
}
it("cold creation replaces only the current descriptor and preserves frozen predecessors", async () => {
  const f = await lifecycleFixture(), before = await readFile(f.metadata.path);
  const old = f.chain.at(-1), oldPath = join(f.repo.directory, `${old.journalId}.jsonl`);
  // A rejected current tail is not promoted or repaired by the cold boundary.
  await appendFile(oldPath, "rejected-current-tail"); const rejected = await readFile(oldPath);
  const plan = f.bridge.planColdEpoch(f.chain, coldContext);
  expect((await f.bridge.inventory()).bytes).toBe(before.length + rejected.length);
  const first = await f.bridge.publishColdEpoch(f.chain, coldContext);
  expect(first).toEqual([f.chain[0], plan.descriptor]);
  expect(first[1].predecessorJournalId).toBe(f.chain[0].journalId);
  expect(first[1].ordinal).toBe(1); expect(first[1].sourceSeq).toBe(4);
  expect(await readFile(oldPath)).toEqual(rejected);
  expect(await readFile(f.metadata.path)).toEqual(before);
  expect(await f.bridge.publishColdEpoch(f.chain, coldContext)).toEqual(first);
  await f.bridge.deleteJournals(f.chain, f.deletion);
  await f.bridge.deleteJournals(f.chain, f.deletion);
  expect(await readFile(f.metadata.path)).toEqual(before);
  expect(await readdir(f.repo.directory)).toEqual(expect.arrayContaining([`${first[1].journalId}.jsonl`, `${first[0].journalId}.jsonl`]));
  expect(await readdir(f.repo.directory)).not.toContain(`${old.journalId}.jsonl`);
});
it("refuses C deletion of a referenced predecessor and forged C membership", async () => {
  const f = await lifecycleFixture(), before = await f.bridge.inventory();
  await expect(f.bridge.deleteJournals(f.chain, { ...f.deletion, eligibleJournalId: f.chain[0].journalId })).rejects.toThrow();
  await expect(f.bridge.deleteJournals([f.chain[1]], f.deletion)).rejects.toThrow();
  expect(await f.bridge.inventory()).toEqual(before);
});
it("deletes a whole D set including validated copy storage without recreating absent members", async () => {
  const f = await lifecycleFixture();
  await writeFile(`${f.metadata.path}.upgrading`, await readFile(f.metadata.path), { mode: 0o600 });
  const deletion = { ...f.deletion, disposition: "D" };
  await f.bridge.deleteJournals(f.chain, deletion);
  expect(await readdir(f.repo.directory)).toEqual([]);
  await f.bridge.deleteJournals(f.chain, deletion);
  expect(await f.bridge.inventory()).toEqual({ bytes: 0, stagedBytes: 0, journals: {} });
});
it("preflights every D member before deleting any foreign header or unknown copy", async () => {
  const f = await lifecycleFixture(), current = join(f.repo.directory, `${f.chain[1].journalId}.jsonl`);
  const original = await readFile(current);
  const rows = original.toString().trim().split("\n").map((line) => JSON.parse(line));
  rows[0].hostAuthority.authorityId = "e".repeat(64);
  await writeFile(current, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  const first = await readFile(f.metadata.path);
  await expect(f.bridge.deleteJournals(f.chain, { ...f.deletion, disposition: "D" })).rejects.toThrow();
  expect(await readFile(f.metadata.path)).toEqual(first);
  await writeFile(current, original, { mode: 0o600 });
  await writeFile(`${current}.unknown`, "foreign evidence", { mode: 0o600 });
  await expect(f.bridge.deleteJournals(f.chain, { ...f.deletion, disposition: "D" })).rejects.toThrow();
  expect(await readFile(f.metadata.path)).toEqual(first);
  await rm(`${current}.unknown`);
  await writeFile(`${current}.upgrading`, Buffer.concat([original, Buffer.from("unknown copy tail")]), { mode: 0o600 });
  await expect(f.bridge.deleteJournals(f.chain, { ...f.deletion, disposition: "D" })).rejects.toThrow();
  expect(await readFile(f.metadata.path)).toEqual(first);
  expect(await readFile(`${current}.upgrading`)).toEqual(Buffer.concat([original, Buffer.from("unknown copy tail")]));
});
it("refuses a foreign live writer rather than waiting under host ownership", async () => {
  const f = await lifecycleFixture(); const writer = await f.repo.open({ id: f.chain[1].handleId, journalId: f.chain[1].journalId,
    path: join(f.repo.directory, `${f.chain[1].journalId}.jsonl`) }, { repair: false, wait: false });
  try { await expect(f.bridge.deleteJournals(f.chain, f.deletion)).rejects.toThrow(); }
  finally { await writer.close(); }
  expect(await readdir(f.repo.directory)).toHaveLength(2);
});
it("reasserts ownership before each unlink and never creates a cold epoch with lost authority", async () => {
  const f = await lifecycleFixture(), before = await f.bridge.inventory();
  const assertOwned = async () => { throw new Error("Lost fictional owner"); };
  await expect(f.bridge.publishColdEpoch(f.chain, { ...coldContext, assertOwned })).rejects.toThrow("Lost fictional owner");
  await expect(f.bridge.deleteJournals(f.chain, { ...f.deletion, assertOwned })).rejects.toThrow("Lost fictional owner");
  expect(await f.bridge.inventory()).toEqual(before);
});
const lifecycleWorker = fileURLToPath(new URL("./fixtures/native-lifecycle-storage-worker.mjs", import.meta.url));
it.skipIf(process.platform === "win32").each([
  ["cold", "epoch_stage_created"], ["cold", "epoch_stage_synced"], ["cold", "epoch_renamed"], ["cold", "epoch_directory_synced"],
  ["cold", "native_file_removed"], ["cold", "native_member_directory_synced"], ["cold", "native_member_removed"], ["cold", "native_members_directory_synced"],
  ["delete", "native_file_removed"], ["delete", "native_member_directory_synced"], ["delete", "native_member_removed"], ["delete", "native_members_directory_synced"],
])("recovers native %s twice in fresh processes after SIGKILL at %s", async (operation, phase) => {
  const f = await lifecycleFixture();
  if (operation === "delete") await writeFile(`${f.metadata.path}.upgrading`, await readFile(f.metadata.path), { mode: 0o600 });
  await writeFile(join(f.root, "lifecycle-proof.json"), JSON.stringify({ chain: f.chain, cold: coldContext,
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
  if (operation === "cold") {
    expect(second.published).toEqual([f.chain[0], f.bridge.planColdEpoch(f.chain, coldContext).descriptor]);
    expect(await readdir(f.repo.directory)).toHaveLength(2);
  } else { expect(second.inventory.bytes).toBe(0); expect(await readdir(f.repo.directory)).toEqual([]); }
}, 60000);


it("rejects C for a switched-away journal even when the caller presents it as the only current member", async () => {
  const f = await lifecycleFixture(), before = await readFile(f.metadata.path);
  await expect(f.bridge.deleteJournals([f.chain[0]], { ...f.deletion, eligibleJournalId: f.chain[0].journalId })).rejects.toThrow("switched-away");
  expect(await readFile(f.metadata.path)).toEqual(before); expect(await f.repo.listOwned()).toHaveLength(2);
});
it.each(["model_change_before_open", "model_change_writer_opened"])("never truncates a foreign tail inserted at %s", async (boundary) => {
  let f, preserved;
  f = await fixture({ onPhase: async (phase) => {
    if (boundary === "model_change_writer_opened" && phase === "model_change_before_open") {
      await appendFile(f.metadata.path, "{");
      // Normalize to an exactly restorable filesystem timestamp before scan.
      await utimes(f.metadata.path, 1700000000, 1700000000);
    }
    if (phase !== boundary) return;
    if (boundary === "model_change_before_open") await appendFile(f.metadata.path, "foreign evidence");
    else {
      const handle = await open(f.metadata.path, "r+"), before = await handle.stat();
      try { await handle.write(Buffer.from("x"), 0, 1, before.size - 1); } finally { await handle.close(); }
      await utimes(f.metadata.path, before.atimeMs / 1000, before.mtimeMs / 1000);
      const after = await stat(f.metadata.path);
      expect(after.size).toBe(before.size); expect(Math.floor(after.mtimeMs / 1000)).toBe(Math.floor(before.mtimeMs / 1000));
      // A coarse filesystem may keep ctime unchanged too. Byte validation,
      // not timestamp precision, must still preserve the rewritten tail.
    }
    preserved = await readFile(f.metadata.path);
  } });
  await expect(f.bridge.publishSwitch([f.source], context)).rejects.toThrow();
  expect(preserved).toBeDefined(); expect(await readFile(f.metadata.path)).toEqual(preserved);
  expect(await f.repo.listOwned()).toHaveLength(1);
});
it.each(["foreign-body", "oversized", "partial-header"])("pins a non-prefix header copy during D deletion: %s", async (kind) => {
  const f = await lifecycleFixture(), before = await readFile(f.metadata.path), copy = `${f.metadata.path}.upgrading`;
  const newline = before.indexOf(10) + 1;
  const bytes = kind === "foreign-body" ? Buffer.concat([before.subarray(0, newline), Buffer.from("foreign payload\n")])
    : kind === "oversized" ? Buffer.concat([before, Buffer.from("foreign suffix")]) : Buffer.from("{foreign");
  await writeFile(copy, bytes, { mode: 0o600 });
  expect(await f.bridge.deletionBlocked(f.chain, authority)).toBe(true);
  await expect(f.bridge.deleteJournals(f.chain, { ...f.deletion, disposition: "D", eligibleJournalId: undefined })).rejects.toThrow();
  expect(await readFile(copy)).toEqual(bytes); expect(await readFile(f.metadata.path)).toEqual(before); expect(await f.repo.listOwned()).toHaveLength(2);
});
it.each([0, 11, "body"])("removes only a proven prefix header copy before its source: %s", async (length) => {
  const f = await lifecycleFixture(), source = await readFile(f.metadata.path), copy = `${f.metadata.path}.upgrading`;
  const bytes = source.subarray(0, length === "body" ? source.indexOf(10) + 21 : length);
  await writeFile(copy, bytes, { mode: 0o600 });
  await f.bridge.deleteJournals(f.chain, { ...f.deletion, disposition: "D", eligibleJournalId: undefined });
  expect(await f.repo.listOwned()).toHaveLength(0); await expect(readFile(copy)).rejects.toMatchObject({ code: "ENOENT" });
});
it("does not create a writer lock for an absent-journal deletion probe", async () => {
  const f = await lifecycleFixture(), locks = join(f.root, "mono-v2", "locks");
  await f.bridge.deleteJournals(f.chain, { ...f.deletion, disposition: "D", eligibleJournalId: undefined });
  const before = (await readdir(locks)).sort();
  expect(await f.bridge.deletionBlocked(f.chain, authority)).toBe(false);
  expect((await readdir(locks)).sort()).toEqual(before);
  const orphan = join(f.repo.directory, `${f.chain[0].journalId}.jsonl.upgrading`); await writeFile(orphan, "unknown copy", { mode: 0o600 });
  expect(await f.bridge.deletionBlocked(f.chain, authority)).toBe(true); expect((await readdir(locks)).sort()).toEqual(before);
});
it("upgrades every retained chain member before publishing the next epoch", async () => {
  const f = await fixture(), old = await f.repo.create({ id: "d".repeat(64), cwd: "/fictional" });
  await old.scopedWrite(async () => {
    await old.writeRecord("owner_binding", { kind: "host", ownerKey: authority.ownerKey, historyBucket: authority.historyBucket });
    await old.writeRecord("handle_binding", { handleId: old.metadata.id, baseRevision: 0, authoritative: true, model: { provider: from.provider, id: from.model, api: from.api } });
  }, "bind"); await old.sync(); const oldMetadata = { ...old.metadata }; await old.close();
  const first = await f.bridge.freeze({ epoch: "e".repeat(64), ordinal: 0, handleId: oldMetadata.id, journalId: oldMetadata.journalId, predecessorJournalId: null, ownerKey: authority.ownerKey, historyBucket: authority.historyBucket, provenance: from });
  const second = { ...f.source, ordinal: 1, predecessorJournalId: first.journalId };
  const chain = await f.bridge.publishSwitch([first, second], context); expect(chain).toHaveLength(3);
  for (const member of chain) {
    const header = JSON.parse((await readFile(join(f.repo.directory, `${member.journalId}.jsonl`), "utf8")).split("\n")[0]);
    expect(header.ownershipSchemaVersion).toBe(2); expect(header.hostAuthority).toEqual(authority);
  }
});
it("shares runtime repository identity with the bridge for a trailing-slash sessions root", async () => {
  const f = await fixture(), runtime = resolveDurableNativeSessionRepo(`${f.root}/`); repos.push(runtime);
  expect(resolveDurableNativeSessionRepo(f.root)).toBe(runtime);
  const bridge = createManagedNativeJournalStorage({ sessionsRoot: `${f.root}/` });
  expect(await bridge.publishSwitch([f.source], context)).toHaveLength(2);
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
  expect((await f.bridge.inventory([f.chain[0].journalId], filter)).bytes).toBe(retained);
});

it("does not treat a ready artifact without native reference bytes as runtime switch authority", async () => {
  const f = await fixture(); expect(await f.bridge.hasSwitchReference([f.source], context)).toBe(false);
  expect(await readFile(f.metadata.path)).toEqual(f.before); expect(await f.repo.listOwned()).toHaveLength(1);
});
it.each(["model_change_started", "model_change_appended", "model_change_synced"])("proves an already-started exact reference without mutation after %s", async (boundary) => {
  let stopped = false;
  const f = await fixture({ onPhase: async (phase) => { if (!stopped && phase === boundary) { stopped = true; throw new Error("Interrupted accepted reference"); } } });
  await expect(f.bridge.publishSwitch([f.source], context)).rejects.toThrow("Interrupted accepted reference");
  const before = await readFile(f.metadata.path);
  expect(await f.bridge.hasSwitchReference([f.source], context)).toBe(true);
  expect(await readFile(f.metadata.path)).toEqual(before); expect(await f.repo.listOwned()).toHaveLength(1);
});
it("rejects foreign reference bytes without granting automatic ready recovery", async () => {
  const f = await fixture(); await appendFile(f.metadata.path, "foreign reference"); const before = await readFile(f.metadata.path);
  await expect(f.bridge.hasSwitchReference([f.source], context)).rejects.toThrow(); expect(await readFile(f.metadata.path)).toEqual(before);
});


it("capture throws the exported typed capacity error for the actual native chain limit", async () => {
  const f = await fixture();
  const capture = () => f.bridge.captureEvidence(Array.from({ length: MAX_CAPTURE_JOURNALS + 1 }, () => f.source), { assertOwned: async () => {}, ownerKey: authority.ownerKey, historyBucket: authority.historyBucket });
  await expect(capture()).rejects.toBeInstanceOf(NativeEvidenceCapacityError);
  await expect(capture()).rejects.toMatchObject({ code: "ERR_NATIVE_EVIDENCE_CAPTURE_LIMIT" });
  expect(await readFile(f.metadata.path)).toEqual(f.before);
});
it("freezes legacy model/API from owned binding bytes without auth, never inventing account evidence", async () => {
  const f = await fixture(), { provenance: _provenance, ...coordinate } = f.source;
  expect(await f.bridge.freeze(coordinate)).toEqual(f.source); expect(f.source.provenance.account).toBeNull();
  await expect(f.bridge.freeze({ ...coordinate, ownerKey: "fictional-wrong-owner" })).rejects.toThrow();
});
