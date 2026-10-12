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
  expect(await f.store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { })).toEqual({ status: "pending" });
  expect(await readFile(f.nativePath)).toEqual(f.original); expect(await readFile(f.canonicalPath)).toEqual(before);
  expect((await f.store.readProviderSessionBinding(bucket))?.modelKey).toBe("faux:A");
  await expect(f.store.beginProviderSessionTurn(bucket, "no-dispatch", { modelKey: "faux:B" })).rejects.toThrow("pending");
});
const journals = (f: { base: string }) => readdir(join(f.base, "native", "mono-v2", "journals"));
const exists = (path: string) => readFile(path).then(() => true, () => false);
it("rolls ready content into the exact target journal, binding and receipt, then retires the outgoing journal and fence", async () => {
  const f = await setup(), reference = await ready(f);
  expect(await f.store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { })).toEqual({ status: "committed" });
  const first = await readFile(f.canonicalPath), canonical = JSON.parse(first.toString());
  expect(canonical.version).toBe(3); expect(Object.keys(canonical.native).sort()).toEqual(["authority", "projection"]);
  expect(canonical.providerSession).toMatchObject({ epoch: f.state.identity.targetEpoch, revision: 0, modelKey: "faux:B" });
  expect(canonical.lastSwitch).toMatchObject({ fromEpoch: f.state.identity.sourceEpoch, toEpoch: f.state.identity.targetEpoch, artifact: reference });
  expect(canonical.native.projection).toEqual(reference);
  // Exactly one current journal: the guarded target. The outgoing journal is retired.
  const names = await journals(f); expect(names).toHaveLength(1); expect(await exists(f.nativePath)).toBe(false);
  const target = (await readFile(join(f.base, "native", "mono-v2", "journals", names[0]!), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(target[0].hostAuthority).toEqual(canonical.native.authority); expect(target.slice(1)).toHaveLength(4);
  expect((await f.store.stats()).reservedBytes).toBe(0);
  expect((await readdir(join(f.base, "history", ".model-switches"))).filter((name) => name.endsWith(".fence.json"))).toHaveLength(0);
  expect(await f.store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { })).toEqual({ status: "committed" });
  expect(await readFile(f.canonicalPath)).toEqual(first);
  const bytes = await f.native.inventory();
  let hostBytes = 0;
  for (const name of await readdir(join(f.base, "history"))) if (name.endsWith(".history.json") || name === ".native-history-root.json") hostBytes += (await readFile(join(f.base, "history", name))).length;
  for (const name of await readdir(join(f.base, "history", ".model-switches"))) hostBytes += (await readFile(join(f.base, "history", ".model-switches", name))).length;
  expect((await f.store.stats()).bytes).toBe(hostBytes + bytes.bytes);
});
it.each(["canonicalBytes", "nativeBytes"] as const)("refuses undersized measured %s before intent publication", async (field) => {
  const f = await setup(), { switchId: _switchId, ...identity } = f.state.identity;
  const state = createModelSwitchState(identity, { ...f.state.reservation, [field]: 0 });
  await expect(f.store.beginModelSwitchStorage(state)).rejects.toThrow(/capacity/);
  expect(await readFile(f.nativePath)).toEqual(f.original);
  expect(await readdir(join(f.base, "history"))).not.toContain(".model-switches");
});
it("settles an accepted B publication before permitting dispatch after interrupted cleanup", async () => {
  const f = await setup(); await ready(f);
  await expect(f.store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { onPhase: async (phase) => { if (phase === "switch_canonical_directory_synced") throw new Error("Interrupted cleanup"); } })).rejects.toThrow("Interrupted cleanup");
  expect(await exists(f.nativePath)).toBe(true);
  const turn = await f.store.beginProviderSessionTurn(bucket, "recovered-B", { modelKey: "faux:B" });
  try {
    expect(turn.modelKey).toBe("faux:B"); expect(await exists(f.nativePath)).toBe(false);
    expect((await f.store.stats()).reservedBytes).toBe(0);
  } finally { await turn.abort(); }
  expect(await openStore(f.base).store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { })).toEqual({ status: "committed" });
});
it("recovering a renamed but not directory-synced canonical re-syncs it before deleting the outgoing journal or artifacts", async () => {
  const f = await setup(); await ready(f);
  await expect(f.store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { onPhase: async (phase) => { if (phase === "switch_canonical_renamed") throw new Error("Interrupted before directory fsync"); } })).rejects.toThrow("directory fsync");
  const reopened = openStore(f.base), events: string[] = [], remove = reopened.native.deleteJournals.bind(reopened.native);
  reopened.native.deleteJournals = async (...args) => { events.push("delete_outgoing"); return await remove(...args); };
  expect(await reopened.store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { onPhase: async (phase) => { events.push(phase); } })).toEqual({ status: "committed" });
  expect(events).not.toContain("switch_target_created"); // receipt recognized: no re-publication
  const synced = events.indexOf("switch_canonical_synced");
  expect(synced).toBeGreaterThanOrEqual(0); expect(synced).toBeLessThan(events.indexOf("delete_outgoing"));
  expect(events.slice(0, synced).some((phase) => phase.includes("removed"))).toBe(false);
  expect(await exists(f.nativePath)).toBe(false);
});

it("never retires the outgoing journal against a canonical receipt that conflicts with the intent", async () => {
  const f = await setup(); await ready(f);
  await expect(f.store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { onPhase: async (phase) => { if (phase === "switch_canonical_directory_synced") throw new Error("Interrupted cleanup"); } })).rejects.toThrow();
  const canonical = JSON.parse(await readFile(f.canonicalPath, "utf8"));
  canonical.lastSwitch.intentDigest = "f".repeat(64);
  await writeFile(f.canonicalPath, JSON.stringify(canonical) + "\n", { mode: 0o600 });
  await expect(openStore(f.base).store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { })).rejects.toThrow("conflicts");
  expect(await readFile(f.nativePath)).toEqual(f.original);
  expect((await readdir(join(f.base, "history", ".model-switches"))).filter((name) => name.endsWith(".fence.json"))).toHaveLength(1);
});
it("never recreates a target journal lost after the canonical receipt; recovery only finishes cleanup", async () => {
  const f = await setup(); await ready(f);
  await expect(f.store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { onPhase: async (phase) => { if (phase === "switch_canonical_directory_synced") throw new Error("Interrupted cleanup"); } })).rejects.toThrow();
  const target = (await journals(f)).find((name) => !f.nativePath.endsWith(name))!;
  await rm(join(f.base, "native", "mono-v2", "journals", target));
  expect(await openStore(f.base).store.rollForwardModelSwitch(bucket, f.state.identity.switchId, { })).toEqual({ status: "committed" });
  expect(await journals(f)).toEqual([]);
  expect((await readdir(join(f.base, "history", ".model-switches"))).filter((name) => name.endsWith(".fence.json"))).toHaveLength(0);
});
const worker = fileURLToPath(new URL("./fixtures/managed-native-switch-worker.mjs", import.meta.url));
it.skipIf(process.platform === "win32").each([
  "epoch_stage_created", "epoch_stage_synced", "epoch_renamed", "epoch_directory_synced", "switch_target_created",
  "switch_canonical_stage_synced", "switch_canonical_renamed", "switch_canonical_directory_synced", "switch_canonical_synced",
  "native_file_removed", "native_members_directory_synced", "switch_source_retired", "switch_fence_removed", "switch_fence_directory_synced",
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
  const canonical = JSON.parse(await readFile(f.canonicalPath, "utf8")); expect(canonical.version).toBe(3);
  expect(canonical.lastSwitch.artifact).toEqual(reference); expect(canonical.native.projection).toEqual(reference);
  expect(await journals(f)).toHaveLength(1); expect(await exists(f.nativePath)).toBe(false);
  expect((await readdir(join(f.base, "history", ".model-switches"))).filter((name) => name.endsWith(".fence.json"))).toHaveLength(0);
}, 60000);
