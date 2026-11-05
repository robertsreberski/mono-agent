import { beforeEach, afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Socket } from "node:net";
import { lookupPilotWork } from "../lib/continuity-lookup-pilot-runtime.mjs";
import { lookupProcessStartIdentity } from "../lib/continuity-process-identity.mjs";
import { writeLookupPreparation, writeLookupPreflight, verifyLookupPreparation, restoreLookupPreparation, lookupPreparedBoundary, lookupPilotServesArm, restoreLookupPreflight, removeLookupWorkTree } from "../lib/continuity-lookup-preparation.mjs";
import { acquireLookupPilotLease } from "../lib/continuity-lookup-lease.mjs";
import { armById } from "../lib/continuity-arms.mjs";
let root, a, state, snapshot, work;
const save = () => fs.writeFile(join(root, "lookup-pilot-controller.json"), JSON.stringify(state), { mode: 0o600 });
beforeEach(async () => {
  vi.spyOn(Socket.prototype, "connect").mockImplementation(() => { throw Error("test_egress_denied"); });
  vi.stubGlobal("fetch", () => { throw Error("test_egress_denied"); });
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lookup-preparation-")));
  a = { outputRoot: root, slotId: "slot", slot: { traceId: "trace" }, epoch: "epoch", index: 0, roleRequest: { binding: { arm: "native-lookup" } } };
  work = lookupPilotWork(a); snapshot = join(dirname(work), "snapshot"); await fs.mkdir(snapshot, { recursive: true, mode: 0o700 });
  await fs.writeFile(join(snapshot, "history.json"), "fictional-pristine", { mode: 0o600 });
  const treeDigest = await writeLookupPreparation(a, { work, snapshot, record: { conversationId: "fictional-conversation" } });
  state = { schema: "continuity-lookup-faux-controller-v1", slots: [{ worker: { pid: process.pid, startIdentity: lookupProcessStartIdentity(process.pid) }, preparation: { schema: "lookup-preparation-record-v1", pid: 2147483647, startIdentity: "fictional-exited", exited: true, treeDigest } }] }; await save();
});
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllGlobals(); if (root) await removeLookupWorkTree(root); });
it("restores only verified bytes and produces an opaque same-work boundary", async () => {
  const restored = await restoreLookupPreparation(a);
  expect(await fs.readFile(join(work, "history.json"), "utf8")).toBe("fictional-pristine");
  expect(lookupPreparedBoundary({ preparation: restored.proof }, armById("native-lookup"), work, "fictional-conversation")).toBe(true);
  expect(lookupPreparedBoundary({ preparation: restored.proof }, armById("native-lookup"), work, "fictional-conversation")).toBe(false);
  await expect(restoreLookupPreparation(a)).rejects.toThrow("lookup_preparation_invalid");
  expect(lookupPreparedBoundary({ preparation: { ...restored.proof } }, armById("native-lookup"), work, "fictional-conversation")).toBe(false);
  expect(lookupPreparedBoundary({ preparation: restored.proof }, armById("native-lookup"), `${work}-other`, "fictional-conversation")).toBe(false);
  expect(lookupPreparedBoundary({ preparation: restored.proof }, armById("restart-switch-compact"), work, "fictional-conversation")).toBe(false);
});
it("refuses snapshot tampering before any restore", async () => {
  await fs.writeFile(join(snapshot, "history.json"), "fictional-tampered");
  await expect(restoreLookupPreparation(a)).rejects.toThrow("lookup_preparation_invalid"); await expect(fs.lstat(work)).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses manifest tampering", async () => {
  const file = join(dirname(work), "preparation.json"), value = JSON.parse(await fs.readFile(file)); value.conversationId = "other"; await fs.writeFile(file, JSON.stringify(value));
  await expect(restoreLookupPreparation(a)).rejects.toThrow("lookup_preparation_invalid");
});
it.each(["same pid", "live tuple", "not exited", "missing record"])("refuses %s", async kind => {
  if (kind === "same pid") state.slots[0].preparation.pid = process.pid;
  if (kind === "live tuple") { state.slots[0].preparation.pid = process.ppid; state.slots[0].preparation.startIdentity = lookupProcessStartIdentity(process.ppid); }
  if (kind === "not exited") state.slots[0].preparation.exited = false;
  if (kind === "missing record") delete state.slots[0].preparation;
  await expect(verifyLookupPreparation(a, state)).rejects.toThrow("lookup_preparation_invalid");
});
it("accepts an exited tuple even when the scalar start string equals the probe start", async () => {
  state.slots[0].preparation.startIdentity = lookupProcessStartIdentity(process.pid);
  await expect(verifyLookupPreparation(a, state)).resolves.toEqual(state.slots[0].preparation);
});
it("accepts a reused PID with a different start identity", async () => {
  state.slots[0].preparation.pid = process.ppid;
  state.slots[0].preparation.startIdentity = "fictional-earlier-start";
  await expect(verifyLookupPreparation(a, state)).resolves.toEqual(state.slots[0].preparation);
});
it("rejects changed durable preparation after verification without rehashing mutable work", async () => {
  await restoreLookupPreparation(a); await fs.writeFile(join(work, "history.json"), "legitimate-probe-change");
  await expect(verifyLookupPreparation(a, state, true)).resolves.toEqual(state.slots[0].preparation);
  state.slots[0].preparation.treeDigest = "0".repeat(64);
  await expect(verifyLookupPreparation(a, state, true)).rejects.toThrow("lookup_preparation_invalid");
});
it("does not mint a restored proof from read-only verification", async () => {
  await verifyLookupPreparation(a, state); await expect(verifyLookupPreparation(a, state, true)).rejects.toThrow("lookup_preparation_invalid");
});
it("restores hashed buffers even if the source changes after verification", async () => {
  const remove = fs.rm; vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
    if (args[0] === work) await fs.writeFile(join(snapshot, "history.json"), "changed-after-hash");
    return remove(...args);
  });
  syncBuiltinESMExports();
  await restoreLookupPreparation(a); expect(await fs.readFile(join(work, "history.json"), "utf8")).toBe("fictional-pristine");
});
it.each(["symlink", "hardlink"])("refuses a %s in the snapshot", async kind => {
  const file = join(snapshot, "history.json"), target = join(root, "other"); await fs.rename(file, target);
  if (kind === "symlink") await fs.symlink(target, file); else await fs.link(target, file);
  await expect(restoreLookupPreparation(a)).rejects.toThrow("lookup_preparation_invalid");
});
it.each(["native-lookup", "continuity-pack-cold", "continuity-pack-boundary"])("serves only the intended in-place arm %s", id => { expect(lookupPilotServesArm(armById(id))).toBe(true); });
it("refuses explicit restart and auxiliary preparation arms", () => {
  for (const id of ["restart-switch-compact", "continuity-ledger-cold", "continuity-store-compaction", "cold-rebuild"]) expect(lookupPilotServesArm(armById(id))).toBe(false);
});

it("rejects a renamed live lease inode before opening a non-SQLite descriptor", async () => {
  const lease = await acquireLookupPilotLease(root), original = join(root, "controller-lock.sqlite"), alias = join(snapshot, "renamed-lease");
  try {
    await fs.rename(original, alias); const opened = vi.spyOn(fs, "open"); syncBuiltinESMExports();
    await expect(restoreLookupPreparation(a)).rejects.toThrow("lookup_preparation_invalid");
    expect(opened.mock.calls.some(([path]) => path === alias)).toBe(false);
  } finally { await fs.rename(alias, original); lease.release(); }
});

it("restores children before applying read-only directory modes", async () => {
  const nested = join(snapshot, "readonly"); await fs.mkdir(nested, {mode: 0o700}); await fs.writeFile(join(nested, "item"), "Fictional child.", {mode: 0o400}); await fs.chmod(nested, 0o500);
  await fs.unlink(join(dirname(work), "preparation.json"));
  state.slots[0].preparation.treeDigest = await writeLookupPreparation(a, { work, snapshot, record: {conversationId: "fictional-conversation"} }); await save();
  try { await restoreLookupPreparation(a); expect(await fs.readFile(join(work, "readonly/item"), "utf8")).toBe("Fictional child."); expect((await fs.stat(join(work, "readonly"))).mode & 0o777).toBe(0o500); }
  finally { await fs.chmod(nested, 0o700); await fs.chmod(join(work, "readonly"), 0o700).catch(() => {}); }
});
it.each(["continuity-lookup-controller-v1", "continuity-lookup-faux-controller-v1"])("rejects a preflight record and snapshot under %s", async schema => {
  state.schema = schema; state.slots[0].preparation.schema = "lookup-preflight-record-v1";
  await expect(verifyLookupPreparation(a, state)).rejects.toThrow("lookup_preparation_invalid");
  state.slots[0].preparation.schema = "lookup-preparation-record-v1";
  await fs.unlink(join(dirname(work), "preparation.json"));
  state.slots[0].preparation.treeDigest = await writeLookupPreflight(a, { work, snapshot, record: {conversationId: "fictional-preflight"} }); await save();
  await expect(verifyLookupPreparation(a, state)).rejects.toThrow("lookup_preparation_invalid");
});

it("removes an existing nested read-only work tree without following links and reapplies snapshot modes", async () => {
  const nested = join(snapshot, "readonly/nested"); await fs.mkdir(nested, {recursive: true, mode: 0o700});
  await fs.writeFile(join(nested, "fictional.txt"), "verified fictional bytes", {mode: 0o400});
  await fs.chmod(nested, 0o500); await fs.chmod(dirname(nested), 0o500);
  await fs.unlink(join(dirname(work), "preparation.json"));
  state.slots[0].preparation.treeDigest = await writeLookupPreparation(a, {work, snapshot, record: {conversationId: "fictional-conversation"}}); await save();
  await fs.cp(snapshot, work, {recursive: true});
  const outside = join(root, "outside"); await fs.mkdir(outside, {mode: 0o500});
  await fs.symlink(outside, join(work, "external-link"));
  await restoreLookupPreparation(a);
  expect(await fs.readFile(join(work, "readonly/nested/fictional.txt"), "utf8")).toBe("verified fictional bytes");
  for (const path of [join(work, "readonly"), join(work, "readonly/nested"), outside]) expect((await fs.lstat(path)).mode & 0o777).toBe(0o500);
  await expect(fs.lstat(join(work, "external-link"))).rejects.toMatchObject({code: "ENOENT"});
});
it("dry restores the disjoint preflight domain with no normal boundary proof", async () => {
  a.slot.slotId = a.slotId;
  await fs.unlink(join(dirname(work), "preparation.json"));
  const treeDigest = await writeLookupPreflight(a, {work, snapshot, record: {conversationId: "fictional-conversation"}});
  state = {schema: "lookup-preflight-controller-v1", controller: {pid: process.pid, startIdentity: lookupProcessStartIdentity(process.pid)}, schedule: [a.slot],
    slots: [{worker: null, preparation: {...state.slots[0].preparation, schema: "lookup-preflight-record-v1", treeDigest}}]}; await save();
  expect(await restoreLookupPreflight(a)).toBeUndefined();
  expect(await fs.readFile(join(work, "history.json"), "utf8")).toBe("fictional-pristine");
  expect(lookupPreparedBoundary({preparation: {}}, armById("native-lookup"), work, "fictional-conversation")).toBe(false);
  await expect(restoreLookupPreparation(a)).rejects.toThrow("lookup_preparation_invalid");
});
