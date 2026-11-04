import { expect, it } from "vitest";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { main } from "../continuity-lookup-compare.mjs";
import { createLookupPilotController, runLookupPilot } from "../lib/continuity-lookup-controller.mjs";
import { LOOKUP_PILOT_REAL_ROUTE_ENABLED } from "../lib/continuity-lookup-pilot-entry.mjs";
it("keeps the explicit pilot entry closed before artifact reads or output setup", async () => {
  expect(LOOKUP_PILOT_REAL_ROUTE_ENABLED).toBe(false);
  const output = join(tmpdir(), `fictional-closed-pilot-${randomUUID()}`);
  await expect(main(["pilot", "--registration", "/home/example/registration.json", "--sha256", "a".repeat(64),
    "--authorization", "/home/example/authorization.json", "--credentials", "/home/example/credentials.json", "--output", output])).rejects.toMatchObject({ code: "lookup_pilot_real_route_unavailable" });
  await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each([createLookupPilotController, runLookupPilot])("also refuses a valid-looking real locator at every controller entry before a lease", async entry => {
  const outputRoot = join(tmpdir(), `fictional-closed-controller-${randomUUID()}`);
  await expect(entry({ outputRoot, pilot: { schema: "continuity-lookup-pilot-registration-v1" }, authorization: {
    schema: "continuity-lookup-pilot-authorization-v1", authorizationPath: "/home/example/authorization.json",
    registrationPath: "/home/example/registration.json", registrationSha256: "a".repeat(64), credentialPath: "/home/example/credentials.json",
    controllerRoot: "/home/example/checkout",
  } })).rejects.toMatchObject({ code: "lookup_pilot_real_route_unavailable" });
  await expect(lstat(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps direct production verification and mint behind the same gate", async () => {
  const { verifyLookupRealAssignment, createLookupRealSend } = await import("../lib/continuity-lookup-real-capability.mjs");
  await expect(verifyLookupRealAssignment(null)).rejects.toMatchObject({ code: "lookup_pilot_real_route_unavailable" });
  await expect(createLookupRealSend({}, {})).rejects.toMatchObject({ code: "lookup_pilot_real_route_unavailable" });
});

it("pins neutral IPC while retaining the deliberately incompatible faux identity", async () => {
  const { LOOKUP_PILOT_IPC, LOOKUP_FAUX_CONTROLLER, LOOKUP_REAL_CONTROLLER } = await import("../lib/continuity-lookup-pilot-state.mjs");
  expect(LOOKUP_PILOT_IPC).toBe("lookup-pilot-ipc-v1"); expect(LOOKUP_FAUX_CONTROLLER).toBe("continuity-lookup-faux-controller-v1");
  expect(LOOKUP_REAL_CONTROLLER).toBe("continuity-lookup-controller-v1");
});
