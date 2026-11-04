// Enable only after the separately reviewed two-process proof is complete.
export const LOOKUP_PILOT_REAL_ROUTE_ENABLED = false;
export function assertLookupPilotEntry() {
  if (!LOOKUP_PILOT_REAL_ROUTE_ENABLED) throw Object.assign(new Error("lookup_pilot_real_route_unavailable"), { code: "lookup_pilot_real_route_unavailable" });
}
export async function runLookupPilotCommand(argv, stdout) {
  assertLookupPilotEntry(); // Before argument-driven reads, lease acquisition or output creation.
  const { parseLookupOptions } = await import("../continuity-lookup-compare.mjs");
  const { readLookupPilotRegistration } = await import("./continuity-lookup-pilot.mjs");
  const { runLookupPilot } = await import("./continuity-lookup-controller.mjs");
  const flags = parseLookupOptions(argv, ["--registration", "--sha256", "--authorization", "--credentials", "--output"]);
  const pilot = await readLookupPilotRegistration(flags["--registration"], flags["--sha256"]);
  const result = await runLookupPilot({ pilot, outputRoot: flags["--output"], authorization: {
    schema: "continuity-lookup-pilot-authorization-v1", authorizationPath: flags["--authorization"], registrationPath: flags["--registration"],
    registrationSha256: flags["--sha256"], credentialPath: flags["--credentials"], controllerRoot: pilot.registration.codes.R0.path,
  } });
  stdout(JSON.stringify(result)); return result.stop === "completed" ? 0 : 1;
}
