import { afterEach, expect, it } from "vitest";
import { fork, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture, ready, openStore, bucket } from "./fixtures/managed-native-switch-fixture.mjs";
import { createModelSwitchState } from "../model-switch-billing.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() { const root = await mkdtemp(join(tmpdir(), "mono-managed-native-")); roots.push(root); return fixture(root); }
it("keeps pending switches in host storage without native events or B binding", async () => {
  const f = await setup(), before = await readFile(f.canonicalPath);
  const lease = await f.store.beginModelSwitchStorage(f.state); if (lease.status !== "owned") throw new Error("Expected lease"); await lease.release();
  expect(await f.store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { exclusiveWriters: true })).toEqual({ status: "pending" });
  expect(await readFile(f.nativePath)).toEqual(f.original); expect(await readFile(f.canonicalPath)).toEqual(before);
  expect((await f.store.readProviderSessionBinding(bucket))?.modelKey).toBe("faux:A");
  await expect(f.store.beginProviderSessionTurn(bucket, "no-dispatch", { modelKey: "faux:B" })).rejects.toThrow("pending");
});
it("rolls ready content into native event, exact journal, binding, receipt and durable fence cleanup", async () => {
  const f = await setup(), reference = await ready(f);
  expect(await f.store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { exclusiveWriters: true })).toEqual({ status: "committed" });
  const first = await readFile(f.canonicalPath), canonical = JSON.parse(first.toString());
  expect(canonical.version).toBe(4); expect(canonical.native.chain).toHaveLength(2);
  expect(canonical.providerSession).toMatchObject({ epoch: f.state.identity.targetEpoch, revision: 0, modelKey: "faux:B" });
  expect(canonical.lastSwitch.artifact).toEqual(reference); expect(canonical.native.projection).toEqual(reference);
  expect(canonical.native.authority).toEqual(JSON.parse((await readFile(f.nativePath)).toString().split("\n")[0]!).hostAuthority);
  expect((await f.store.stats()).reservedBytes).toBe(0);
  expect((await readdir(join(f.base, "history", ".model-switches"))).filter((name) => name.endsWith(".fence.json"))).toHaveLength(0);
  expect(await f.store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { exclusiveWriters: true })).toEqual({ status: "committed" });
  expect(await readFile(f.canonicalPath)).toEqual(first);
  const rows = (await readFile(f.nativePath)).toString().trim().split("\n").map((line) => JSON.parse(line));
  expect(rows.filter((row) => row.kind === "model_change")).toHaveLength(1);
  const bytes = await f.native.inventory();
  let hostBytes = 0;
  for (const name of await readdir(join(f.base, "history"))) if (name.endsWith(".history.json") || name === ".native-history-root.json") hostBytes += (await readFile(join(f.base, "history", name))).length;
  for (const name of await readdir(join(f.base, "history", ".model-switches"))) hostBytes += (await readFile(join(f.base, "history", ".model-switches", name))).length;
  expect((await f.store.stats()).bytes).toBe(hostBytes + bytes.bytes);
});
it.each(["canonicalBytes", "retainedNativeBytes", "headerCopyBytes"] as const)("refuses undersized measured %s before intent publication", async (field) => {
  const f = await setup(), { switchId: _switchId, ...identity } = f.state.identity;
  const state = createModelSwitchState(identity, { ...f.state.reservation, [field]: 0 });
  await expect(f.store.beginModelSwitchStorage(state)).rejects.toThrow(/capacity/);
  expect(await readFile(f.nativePath)).toEqual(f.original);
  expect(await readdir(join(f.base, "history"))).not.toContain(".model-switches");
});
it("keeps canonical B nondispatchable while a publication fence still exists", async () => {
  const f = await setup(); await ready(f);
  await expect(f.store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { exclusiveWriters: true,
    onPhase: async (phase) => { if (phase === "switch_canonical_directory_synced") throw new Error("Interrupted cleanup"); } })).rejects.toThrow("Interrupted cleanup");
  await expect(f.store.beginProviderSessionTurn(bucket, "early-B", { modelKey: "faux:B" })).rejects.toThrow("pending");
  expect(await openStore(f.base).store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { exclusiveWriters: true })).toEqual({ status: "committed" });
});
it("does not trust a matching canonical receipt with forged native membership", async () => {
  const f = await setup(); await ready(f);
  await expect(f.store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { exclusiveWriters: true,
    onPhase: async (phase) => { if (phase === "switch_canonical_directory_synced") throw new Error("Interrupted cleanup"); } })).rejects.toThrow();
  const canonical = JSON.parse(await readFile(f.canonicalPath, "utf8"));
  canonical.native.chain[0].journalId = "fictional-foreign-journal"; canonical.native.chain[1].predecessorJournalId = "fictional-foreign-journal";
  await writeFile(f.canonicalPath, JSON.stringify(canonical) + "\n", { mode: 0o600 });
  const before = await readFile(f.nativePath);
  await expect(openStore(f.base).store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { exclusiveWriters: true })).rejects.toThrow("native journal evidence");
  expect(await readFile(f.nativePath)).toEqual(before);
  expect((await readdir(join(f.base, "history", ".model-switches"))).filter((name) => name.endsWith(".fence.json"))).toHaveLength(1);
});
it("does not recreate missing target evidence merely because a canonical receipt exists", async () => {
  const f = await setup(); await ready(f);
  await expect(f.store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { exclusiveWriters: true,
    onPhase: async (phase) => { if (phase === "switch_canonical_directory_synced") throw new Error("Interrupted cleanup"); } })).rejects.toThrow();
  const canonical = JSON.parse(await readFile(f.canonicalPath, "utf8")), target = canonical.native.chain[1].journalId;
  await rm(join(f.base, "native", "mono-v2", "journals", `${target}.jsonl`));
  await expect(openStore(f.base).store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { exclusiveWriters: true })).rejects.toThrow();
  expect((await readdir(join(f.base, "native", "mono-v2", "journals"))).some((name) => name.startsWith(target))).toBe(false);
  expect((await readdir(join(f.base, "history", ".model-switches"))).filter((name) => name.endsWith(".fence.json"))).toHaveLength(1);
});
const worker = fileURLToPath(new URL("./fixtures/managed-native-switch-worker.mjs", import.meta.url));
it.skipIf(process.platform === "win32").each([
  "header_stage_created", "header_header_written", "header_body_copied", "header_stage_synced", "header_published", "header_publication_synced",
  "model_change_started", "model_change_appended", "model_change_ended", "model_change_synced",
  "epoch_stage_created", "epoch_stage_synced", "epoch_renamed", "epoch_directory_synced",
  "switch_canonical_stage_synced", "switch_canonical_renamed", "switch_canonical_directory_synced", "switch_fence_removed", "switch_fence_directory_synced",
])("reconciles actual host/native state twice in fresh processes after SIGKILL at %s", async (phase) => {
  const f = await setup(), reference = await ready(f);
  await writeFile(join(f.base, "switch-proof.json"), JSON.stringify({ switchId: f.state.identity.switchId }), { mode: 0o600 });
  const child = fork(worker, [f.base, phase], { silent: true }); let error = "";
  child.stderr!.on("data", (bytes) => { error += bytes; }); const exited = once(child, "exit");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([once(child, "message"), exited.then(() => { throw new Error(`Owner exited early: ${error}`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Proof boundary timeout")), 15000); })]);
    child.kill("SIGKILL"); expect((await exited)[1]).toBe("SIGKILL");
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
  const run = promisify(execFile);
  const first = JSON.parse((await run(process.execPath, [worker, f.base], { timeout: 30000 })).stdout);
  const second = JSON.parse((await run(process.execPath, [worker, f.base], { timeout: 30000 })).stdout);
  expect(second).toEqual(first); expect(first.result).toEqual({ status: "committed" }); expect(first.stats.reservedBytes).toBe(0);
  const canonical = JSON.parse(await readFile(f.canonicalPath, "utf8")); expect(canonical.native.chain).toHaveLength(2);
  expect(canonical.lastSwitch.artifact).toEqual(reference); expect(canonical.native.projection).toEqual(reference);
  const rows = (await readFile(f.nativePath)).toString().trim().split("\n").map((line) => JSON.parse(line));
  expect(rows.filter((row) => row.kind === "model_change")).toHaveLength(1);
  expect(rows.filter((row) => row.kind === "message")).toHaveLength(1);
  expect((await readdir(join(f.base, "history", ".model-switches"))).filter((name) => name.endsWith(".fence.json"))).toHaveLength(0);
}, 60000);
