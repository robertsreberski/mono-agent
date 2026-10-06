import { afterEach, expect, it } from "vitest";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fork, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlSessionRepo } from "@mono-agent/harness/session-store.js";
import { createManagedNativeJournalStorage } from "../../ai/providers/pi-native/native-journal-storage.js";
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
  expect((await f.bridge.inventory()).bytes).toBe(f.before.length);
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
  expect(await readFile(stage)).toEqual(before); expect((await f.bridge.inventory()).bytes).toBe(f.before.length + before.length);
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
  const inventory = await f.bridge.inventory(); expect(inventory.journals.constructor.retainedBytes).toBe(Buffer.byteLength("opaque preserved evidence"));
  expect(inventory.bytes).toBe(f.before.length + Buffer.byteLength("opaque preserved evidence"));
});
