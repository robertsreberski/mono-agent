// Only mocked verification/lease graphs; no production registration, output or authority.
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { digest } from "../lib/continuity-dataset.mjs";
let entry, options, approved, lease, validate, consume;
const mocks = ["roles", "pilot", "authorization", "lease", "pilot-entry"];
beforeEach(async () => {
  vi.resetModules(); vi.stubEnv("CI", undefined); vi.stubEnv("CONTINUITY_DEBUG", undefined);
  vi.stubGlobal("fetch", () => { throw Error("test_egress_denied"); });
  approved = { registration: { roles: [{ id: "native", arm: "native-lookup" }], codes: { R0: { path: "/fictional/r0" } } }, descriptor: { capUSD: 100 } };
  options = { pilot: structuredClone(approved), outputRoot: "/fictional/output", authorization: {
    schema: "continuity-lookup-pilot-authorization-v1", authorizationPath: "/fictional/authorization", registrationPath: "/fictional/registration",
    registrationSha256: "a".repeat(64), credentialPath: "/fictional/credential", controllerRoot: "/fictional/r0",
  } };
  lease = vi.fn(async () => { throw Object.assign(Error("lookup_authorization_lease_invalid"), { code: "lookup_authorization_lease_invalid" }); });
  consume = vi.fn(async () => {});
  const handle = Object.freeze({}); validate = vi.fn(async () => handle);
  vi.doMock("../lib/continuity-lookup-pilot-entry.mjs", () => ({ assertLookupPilotEntry() {} }));
  vi.doMock("../lib/continuity-lookup-pilot.mjs", async original => ({ ...await original(), validateLookupPilotRegistration: vi.fn(async () => {}) }));
  vi.doMock("../lib/continuity-lookup-roles.mjs", async original => ({ ...await original(), ROOT: "/fictional/r0", verifyRegisteredCheckouts: vi.fn(async () => {}) }));
  vi.doMock("../lib/continuity-lookup-authorization.mjs", async original => ({ ...await original(), validateLookupAuthorization: validate, consumeLookupAuthorization: consume,
    lookupAuthorizationBindsPilot: (received, pilot) => received === handle && digest(pilot) === digest(approved) }));
  vi.doMock("../lib/continuity-lookup-lease.mjs", async original => ({ ...await original(), acquireLookupPilotLease: lease }));
  vi.doMock("../lib/continuity-holdout-files.mjs", async original => ({ ...await original(), externalDirectory: async path => path }));
  ({ createLookupPilotController: entry } = await import("../lib/continuity-lookup-controller.mjs"));
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  for (const name of mocks) vi.doUnmock(`../lib/continuity-lookup-${name}.mjs`);
  vi.doUnmock("../lib/continuity-holdout-files.mjs");
});
it("refuses a pilot differing only in cap before acquiring a lease", async () => {
  options.pilot.descriptor.capUSD *= 10;
  await expect(entry(options)).rejects.toThrow("lookup_authorization_binding_mismatch");
  expect(validate).toHaveBeenCalledTimes(1); expect(lease).not.toHaveBeenCalled();
});
it("lets a matching approved pilot reach only the mocked lease", async () => {
  await expect(entry(options)).rejects.toThrow("lookup_authorization_lease_invalid"); expect(lease).toHaveBeenCalledExactlyOnceWith(options.outputRoot);
});
it.each(["timeoutMs", "scenarios", "extra"])("refuses extra real authorization key %s before validation or lease", async key => {
  options.authorization[key] = key === "scenarios" ? [] : 1;
  await expect(entry(options)).rejects.toThrow("lookup_authorization_binding_mismatch"); expect(validate).not.toHaveBeenCalled(); expect(lease).not.toHaveBeenCalled();
});

it("refuses an unserved schedule before lease or consumption", async () => {
  approved.registration.roles[0].arm = "restart-switch-compact"; options.pilot = structuredClone(approved);
  await expect(entry(options)).rejects.toThrow("lookup_pilot_boundary_required"); expect(lease).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled();
});

it("snapshots accessor-backed pilot and authorization once before any validation await", async () => {
  const source = structuredClone(options), pilotRead = vi.fn(() => source.pilot), authRead = vi.fn(() => source.authorization);
  Object.defineProperties(options, { pilot: { enumerable: true, get: pilotRead }, authorization: { enumerable: true, get: authRead } });
  const original = validate.getMockImplementation();
  validate.mockImplementation(async received => { source.authorization.credentialPath = "/fictional/changed"; source.pilot.descriptor.capUSD *= 10;
    expect(received.credentialPath).toBe("/fictional/credential"); return original(received); });
  await expect(entry(options)).rejects.toThrow("lookup_authorization_lease_invalid");
  expect(pilotRead).toHaveBeenCalledOnce(); expect(authRead).toHaveBeenCalledOnce(); expect(lease).toHaveBeenCalledOnce();
});
