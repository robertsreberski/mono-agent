import { afterEach, beforeEach, expect, vi } from "vitest";
import { lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import * as pilotModule from "../lib/continuity-lookup-pilot.mjs";
import {pilotSuite} from "./fixtures/lookup-pilot-process.mjs";
import { main } from "../continuity-lookup-compare.mjs";
import { createLookupPilotController, runLookupPilot } from "../lib/continuity-lookup-controller.mjs";
import { LOOKUP_PILOT_REAL_ROUTE_ENABLED, assertLookupPilotEntry } from "../lib/continuity-lookup-pilot-entry.mjs";

const suite = pilotSuite({scoped: true}), it = suite.test;
let base, network, fetch;
beforeEach(async () => {
  // Units select their own CI/debug case; production forks retain these variables.
  vi.stubEnv("CI", undefined); vi.stubEnv("CONTINUITY_DEBUG", undefined);
  base = await mkdtemp(join(tmpdir(), "fictional-open-pilot-"));
  network = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {throw Error("test_network_forbidden");});
  fetch = vi.fn(() => {throw Error("test_fetch_forbidden");}); vi.stubGlobal("fetch", fetch);
});
afterEach(async () => {
  try {expect(network).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();}
  finally {vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(base, {recursive: true, force: true});}
});
const realOptions = () => ({outputRoot: join(base, "output"), pilot: {schema: "continuity-lookup-pilot-registration-v1"}, authorization: {
  schema: "continuity-lookup-pilot-authorization-v1", authorizationPath: join(base, "authorization.json"), registrationPath: join(base, "registration.json"),
  registrationSha256: "a".repeat(64), credentialPath: join(base, "credential.json"), controllerRoot: join(base, "checkout"),
}});

it("opens the pilot command but still verifies the registration before output setup", async () => {
  expect(LOOKUP_PILOT_REAL_ROUTE_ENABLED).toBe(true); expect(() => assertLookupPilotEntry()).not.toThrow();
  const options = realOptions(); await writeFile(options.authorization.registrationPath, "{}");
  await expect(main(["pilot", "--registration", options.authorization.registrationPath, "--sha256", "a".repeat(64),
    "--authorization", options.authorization.authorizationPath, "--credentials", options.authorization.credentialPath, "--output", options.outputRoot]))
    .rejects.toMatchObject({code: "lookup_registration_hash_mismatch"});
  await expect(lstat(options.outputRoot)).rejects.toMatchObject({code: "ENOENT"});
});
it.each([createLookupPilotController, runLookupPilot])("requires the registration validator at the open controller entry before a lease", async entry => {
  const options = {...realOptions(), pilot: structuredClone(suite.fixture.pilot)};
  // Full registration structure, with exactly the schema discriminator invalidated.
  options.pilot.registration.schema = "fictional-invalid-registration";
  const validation = vi.spyOn(pilotModule, "validateLookupPilotRegistration");
  await expect(entry(options)).rejects.toMatchObject({code: "lookup_pilot_not_ready"});
  expect(validation).toHaveBeenCalledExactlyOnceWith(options.pilot);
  await expect(validation.mock.results[0].value).rejects.toMatchObject({code: "incompatible_lookup_registration"});
  await expect(lstat(options.outputRoot)).rejects.toMatchObject({code: "ENOENT"});
});
it.each([undefined, {schema: "fictional-authorization"}, {schema: "continuity-lookup-pilot-authorization-v1"}])("refuses missing or malformed authorization without output setup: %j", async authorization => {
  const options = {...realOptions(), authorization};
  await expect(runLookupPilot(options)).rejects.toMatchObject({code: authorization?.schema === "continuity-lookup-pilot-authorization-v1" ? "lookup_authorization_binding_mismatch" : "lookup_pilot_faux_required"});
  await expect(lstat(options.outputRoot)).rejects.toMatchObject({code: "ENOENT"});
});
it.each(["", "0", "1"])("refuses CI presence at open controller/verification/mint entries (CI=%s)", async value => {
  vi.stubEnv("CI", value);
  const {verifyLookupRealAssignment, createLookupRealSend} = await import("../lib/continuity-lookup-real-capability.mjs");
  for (const call of [() => createLookupPilotController(realOptions()), () => runLookupPilot(realOptions()), () => verifyLookupRealAssignment(null), () => createLookupRealSend({}, {})])
    await expect(call()).rejects.toMatchObject({code: "paid_mode_refused_in_ci"});
  expect(await readdir(base)).toEqual([]);
});
it.each(["", "1"])("refuses debug presence at open controller/verification/mint entries (debug=%s)", async value => {
  vi.stubEnv("CONTINUITY_DEBUG", value);
  const {verifyLookupRealAssignment, createLookupRealSend} = await import("../lib/continuity-lookup-real-capability.mjs");
  for (const call of [() => createLookupPilotController(realOptions()), () => runLookupPilot(realOptions()), () => verifyLookupRealAssignment(null), () => createLookupRealSend({}, {})])
    await expect(call()).rejects.toMatchObject({code: "lookup_debug_forbidden"});
  expect(await readdir(base)).toEqual([]);
});
// Structurally valid verification/mint authorization witnesses live in real-capability.test.mjs.
it("pins neutral IPC while retaining the deliberately incompatible faux identity", async () => {
  const {LOOKUP_PILOT_IPC, LOOKUP_FAUX_CONTROLLER, LOOKUP_REAL_CONTROLLER} = await import("../lib/continuity-lookup-pilot-state.mjs");
  expect(LOOKUP_PILOT_IPC).toBe("lookup-pilot-ipc-v1"); expect(LOOKUP_FAUX_CONTROLLER).toBe("continuity-lookup-faux-controller-v1");
  expect(LOOKUP_REAL_CONTROLLER).toBe("continuity-lookup-controller-v1");
});
