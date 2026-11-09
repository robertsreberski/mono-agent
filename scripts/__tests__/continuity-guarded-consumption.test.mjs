// A second, incompatible protocol exercises the real generic burn implementation, never paid authority.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, readFile, writeFile, readdir, unlink, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
let root, home, outputRoot, sourceRoot, args, auth, leases, lease, protocol, identity, fetch;
const osUser = userInfo();
beforeEach(async () => {
  vi.resetModules();
  root = await realpath(await mkdtemp(join(tmpdir(), "guarded-consumption-")));
  home = join(root, "home"); outputRoot = join(root, "output"); sourceRoot = join(root, "source");
  for (const path of [home, outputRoot, sourceRoot]) await mkdir(path, { mode: 0o700 });
  vi.doMock("node:os", async original => ({ ...await original(), userInfo: () => ({ ...osUser, homedir: home }) }));
  fetch = vi.fn(() => { throw Error("fictional_network_forbidden"); }); vi.stubGlobal("fetch", fetch);
  protocol = (await import("../lib/continuity-guarded-protocols.mjs")).guardedProtocol("fictional");
  auth = (await import("../lib/continuity-guarded-authorization.mjs")).guardedAuthorization("fictional");
  leases = (await import("../lib/continuity-guarded-lease.mjs")).guardedLease("fictional");
  const start = (await import("../lib/continuity-process-identity.mjs")).lookupProcessStartIdentity(process.pid);
  identity = { runId: "fictional-run", controllerEpoch: "fictional-epoch", controller: { pid: process.pid, startIdentity: start } };
  args = { authorizationPath: join(root, "attestation.json"), outputRoot, sourceRoot };
  await writeFile(args.authorizationPath, JSON.stringify({ schema: protocol.policy.AUTHORIZATION_SCHEMA, authorizationId: "fictional-approval", outputRoot, sourceRoot }), { mode: 0o600 });
  lease = await leases.acquireLease(outputRoot);
});
afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { lease?.release(); vi.doUnmock("node:os"); vi.doUnmock("../lib/continuity-lookup-real-capability.mjs"); vi.doUnmock("../lib/continuity-lookup-ipc.mjs"); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); } });
const registry = () => join(home, ...protocol.policy.REGISTRY_LAYOUT.map(([name]) => name));
const entry = () => join(registry(), createHash("sha256").update(protocol.registryDomain).update("fictional-approval").digest("hex"));
it("uses the selected domain and private home, persists both markers and has exactly one concurrent winner", async () => {
  const handle = await auth.validate(args);
  const outcomes = await Promise.allSettled([auth.consumeAuthorization(handle, identity, lease), auth.consumeAuthorization(handle, identity, lease)]);
  expect(outcomes.filter(row => row.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(row => row.status === "rejected")).toHaveLength(1);
  const outer = JSON.parse(await readFile(join(outputRoot, "authorization-consumed.json")));
  expect(JSON.parse(await readFile(join(entry(), "claim.json")))).toEqual(outer);
  expect(outer).toMatchObject({ schema: "fictional-consumed-v1", runId: identity.runId, controllerEpoch: identity.controllerEpoch, outputRoot });
  expect(await readdir(registry())).toEqual([entry().split("/").at(-1)]);
  await expect(auth.verifyConsumption(handle, identity)).resolves.toBe(true);
  await expect(auth.consumeAuthorization(handle, identity, lease)).rejects.toThrow("fictional_authorization_already_consumed");
});
it("read verification cannot repair a missing marker, and the burn remains non-reusable", async () => {
  const handle = await auth.validate(args); await auth.consumeAuthorization(handle, identity, lease);
  const claim = await readFile(join(entry(), "claim.json"));
  await unlink(join(outputRoot, "authorization-consumed.json"));
  await expect(auth.verifyConsumption(handle, identity)).rejects.toThrow("fictional_authorization_consumption_incomplete");
  await expect(auth.consumeAuthorization(handle, identity, lease)).rejects.toThrow("fictional_authorization_consumption_incomplete");
  expect(await readFile(join(entry(), "claim.json"))).toEqual(claim);
  expect(await readdir(outputRoot)).not.toContain("authorization-consumed.json");
});
it("an opaque fictional attestation or fabricated handle cannot mint the native real capability", async () => {
  const handle = await auth.validate(args);
  await expect(auth.consumeAuthorization({}, identity, lease)).rejects.toThrow("fictional_authorization_required");
  const capability = (await import("../lib/continuity-guarded-real-capability.mjs")).guardedRealCapability("fictional");
  await expect(capability.createLookupRealSend({ authorization: handle }, {})).rejects.toThrow("fictional_pilot_capability_invalid");
  expect(capability.isRealLookupSend(() => {})).toBe(false);
  expect(await readdir(outputRoot)).toEqual(["controller-lock.sqlite"]);
});

it("recognizes a lookup real send in every guard, without granting foreign protocol authority", async () => {
  // Mint through the real core with offline assignment/IPC attestations; never invoke the native send.
  const plan = { judge: null }, arm = { id: "native-lookup", midCheckpoint: null, ledgerUpkeep: false };
  const permit = Object.freeze({ testOnly: false, brand: "lookup-controller-v1" });
  vi.doMock("../lib/continuity-lookup-real-capability.mjs", () => ({ verifyLookupRealAssignment: async () => ({ handle: Object.freeze({}) }) }));
  vi.doMock("../lib/continuity-lookup-ipc.mjs", () => ({ createLookupPilotIPC: async () => permit }));
  const { guardedRealCapability, isAnyGuardedRealSend } = await import("../lib/continuity-guarded-real-capability.mjs");
  const { guardedModels } = await import("../lib/continuity-guarded-models.mjs");
  const safety = (await import("../lib/continuity-lookup-pilot-runtime.mjs")).fauxLookupSafety(plan, arm);
  const lookup = guardedRealCapability("lookup-pilot"), assignment = { outputRoot, epoch: "epoch", slotId: "slot", runId: "run", cacheKey: "assigned", plan, roleRequest: { binding: { arm: arm.id } } };
  const send = await lookup.createLookupRealSend(assignment, safety);
  expect(isAnyGuardedRealSend(send)).toBe(true); expect(isAnyGuardedRealSend(() => {})).toBe(false);
  expect(lookup.isRealLookupSend(send)).toBe(true); expect(guardedRealCapability("fictional").isRealLookupSend(send)).toBe(false);
  for (const id of ["lookup-pilot", "fictional"]) {
    const core = guardedModels(id), descriptor = (await import("../lib/continuity-guarded-protocols.mjs")).guardedProtocol(id);
    const contract = { ...descriptor.policy.GUARD_CONTRACT, runId: "run", slotId: "slot" };
    expect(() => core.guardedLookupModels({}, { contract, permit: core.createTestOnlyLookupPermitSource(), send })).toThrow(descriptor.codes.faux_permit_forbidden);
  }
  const foreign = guardedModels("fictional"), contract = { ...protocol.policy.GUARD_CONTRACT, runId: "run", slotId: "slot", promptCacheKey: "assigned" };
  expect(() => foreign.guardedLookupModels({}, { contract, permit: { testOnly: false, brand: protocol.permitBrand }, send, resolvedSafety: safety })).toThrow("fictional_pilot_capability_invalid");
});
it.each([undefined, null, { malformed: true }, "not-a-build"])("pins lookup_ipc_invalid for malformed faux assignment build %j", async build => {
  const { digest } = await import("../lib/continuity-dataset.mjs");
  const { lookupPilotSchedule } = await import("../lib/continuity-lookup-pilot-state.mjs");
  const { lookupProcessStartIdentity } = await import("../lib/continuity-process-identity.mjs");
  const registration = { roles: [{ id: "reader", code: "R0" }], codes: { R0: { build: { expected: true } } }, common: {
    corpora: [{ suite: "fictional", traces: [{ id: "source", probes: ["probe"] }] }],
    policy: { budget: { paths: [{ role: "reader", traceId: "source", probeId: "probe", feasibility: { classification: "feasible" } }] } },
  } };
  const pilot = { registration, descriptor: { schedule: { seed: "fictional" } } }, schedule = lookupPilotSchedule(pilot), slot = schedule[0];
  const state = { schema: "continuity-lookup-faux-controller-v1", binding: digest(pilot), schedule, cacheKeysUnique: true,
    controller: { pid: process.ppid, startIdentity: lookupProcessStartIdentity(process.ppid) }, slots: [{ cacheKey: "assigned" }] };
  await writeFile(join(outputRoot, "lookup-pilot-controller.json"), JSON.stringify(state), { mode: 0o600 });
  const assignment = { outputRoot, index: 0, cacheKey: "assigned", pilot, slot,
    roleRequest: { binding: { id: slot.roleId, registrationSha256: digest(registration) }, build } };
  const ipc = (await import("../lib/continuity-guarded-ipc.mjs")).guardedIPC("lookup-pilot");
  await expect(ipc.verifyLookupPilotParent(assignment)).rejects.toMatchObject({ code: "lookup_ipc_invalid" });
});
