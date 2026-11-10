// Closed E2 identity, real adapter wiring and cross-domain authority boundaries.
import { afterEach, expect, it, vi } from "vitest";
import { readFile, mkdtemp, realpath, rm, mkdir, readdir } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { guardedProtocol } from "../lib/continuity-guarded-protocols.mjs";
import { guardedLease } from "../lib/continuity-guarded-lease.mjs";
import { guardedController } from "../lib/continuity-guarded-controller.mjs";
import { guardedState } from "../lib/continuity-guarded-state.mjs";
import { lookupProcessStartIdentity } from "../lib/continuity-process-identity.mjs";
import { E2_PROTOCOL_FILES, E2_TOOL_POLICIES } from "../lib/continuity-e2-registration.mjs";
const roots = [], leases = [];
afterEach(async () => { for (const l of leases.splice(0)) l.release(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); vi.unstubAllEnvs(); });
it("golden-pins the entire closed E2 descriptor, source file inventory and tool policies", async () => {
  const protocol = guardedProtocol("e2-validation");
  const json = JSON.stringify({ protocol, protocolFiles: E2_PROTOCOL_FILES, toolPolicies: E2_TOOL_POLICIES, errorClass: protocol.Error.name }, (_, v) => typeof v === "bigint" ? v.toString() : v instanceof RegExp ? v.toString() : v);
  expect(JSON.parse(json)).toEqual(JSON.parse(await readFile(new URL("./fixtures/continuity-e2-guarded-descriptor.json", import.meta.url))));
  expect(Object.keys(protocol.hooks).sort()).toEqual(["beforeSchedule", "slotRequest", "roleRequest", "forwardedObserver", "controllerBindings", "publicState", "cacheAssignment", "cacheIssuer", "watchdog", "validTimeout", "work", "verifyPhaseAssignment", "assertPayload", "assertResolvedSafety", "assertRoute", "authorizationBinds", "bodyBytes", "cacheKey", "checkoutPaths", "fauxBindings", "preflightBindings", "prepareController", "realModules", "validateAuthorization", "verifyRealAssignment"].sort());
  expect(Object.keys(protocol.execution).sort()).toEqual(["deadlines", "assertCacheHeaders", "cap", "admission", "contract", "guardRequest", "assertRoute", "assertPayload", "resultReceipt", "verifySettlement", "beforeAdmission", "compaction", "slotReceipt", "aggregateRun", "priceUsage", "assertBody", "verifyNativeBody"].sort());
  expect(Object.isFrozen(protocol.codes)).toBe(true); expect(Object.isFrozen(protocol.policy.MODEL_APIS)).toBe(true);
  expect(() => guardedProtocol({ id: "e2-validation" })).toThrow("guarded_protocol_unknown");
});
it("opens only assigned paid adapters, requiring authority and retaining the faux child refusal", async () => {
  const protocol = guardedProtocol("e2-validation"); expect(protocol.realRoute).toBe(true);
  expect(protocol.children.probe).toBe("scripts/lib/continuity-e2-phase-child.mjs");
  await expect(protocol.hooks.prepareController({})).rejects.toMatchObject({ code: "e2_authorization_required" });
  const modules = await protocol.hooks.realModules();
  expect(Object.keys(modules).sort()).toEqual(["assertRealPermitSource", "createIPC", "matchesAccount", "wrapModels"]);
  expect(() => protocol.hooks.assertResolvedSafety({})).toThrow("e2_pilot_capability_invalid");
  await expect(guardedController("e2-validation").runLookupPilot({ real: true })).rejects.toMatchObject({ code: "e2_pilot_not_ready" });
  await expect(guardedController("e2-validation").runLookupPilot({ real: false })).rejects.toMatchObject({ code: "e2_pilot_real_route_unavailable" });
});

for (const id of ["lookup-pilot", "fictional", "e2-validation"]) it(`${id}: every other protocol refuses its live lease identity`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "e2-descriptor-lease-"))); roots.push(root);
  const lease = await guardedLease(id).acquireLease(root); leases.push(lease);
  const controller = { pid: process.pid, startIdentity: lookupProcessStartIdentity(process.pid) };
  await expect(guardedLease(id).readLease(root, controller)).resolves.toMatchObject({ outputIdentity: expect.any(Object) });
  for (const other of ["lookup-pilot", "fictional", "e2-validation"].filter(p => p !== id)) {
    await expect(guardedLease(other).assertLease(lease, root, controller)).rejects.toThrow();
    await expect(guardedLease(other).readLease(root, controller)).rejects.toThrow();
  }
  await expect(guardedLease(id).assertLease(lease, root, controller)).resolves.toBeDefined();
  expect(guardedState(id).statePath(root)).toBe(join(root, guardedProtocol(id).journal));
});

it("fictional schedule refusal precedes even lease acquisition and faux authority burn", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fictional-closed-run-"))); roots.push(root);
  const outputRoot = join(root, "output"); await mkdir(outputRoot, { mode: 0o700 });
  await expect(guardedController("fictional").runLookupPilot({ outputRoot })).rejects.toMatchObject({ code: "fictional_pilot_real_route_unavailable" });
  expect(await readdir(outputRoot)).toEqual([]); expect(await readdir(root)).toEqual(["output"]);
});

it("real E2 controller refuses missing authority without creating a lease or registry entry", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "e2-no-authority-"))); roots.push(root);
  const home = join(root, "home"), outputRoot = join(root, "output");
  await mkdir(home, { mode: 0o700 }); await mkdir(outputRoot, { mode: 0o700 }); vi.stubEnv("HOME", home);
  const userInfo = os.userInfo;
  try {
    os.userInfo = () => ({ ...userInfo(), homedir: home }); syncBuiltinESMExports();
    await expect(guardedController("e2-validation").runLookupPilot({ real: true, outputRoot })).rejects.toMatchObject({ code: "e2_pilot_not_ready" });
    expect(await readdir(outputRoot)).toEqual([]); expect(await readdir(home)).toEqual([]);
    expect((await readdir(root)).sort()).toEqual(["home", "output"]);
  } finally { os.userInfo = userInfo; syncBuiltinESMExports(); }
});
