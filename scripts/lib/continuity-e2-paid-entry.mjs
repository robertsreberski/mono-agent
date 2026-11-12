// Paid entry selects only the closed E2 descriptor and the entire frozen schedule.
import { resolve } from "node:path";
import { ROOT } from "./continuity-observation-input.mjs";
import { digest } from "./continuity-recorded-schema.mjs";
import { guardedAuthorization } from "./continuity-guarded-authorization.mjs";
import { guardedController } from "./continuity-guarded-controller.mjs";
import { E2_AUTHORIZATION_SCHEMA } from "./continuity-e2-policy.mjs";
import { assertE2Entry } from "./continuity-e2-runtime.mjs";
import { e2ReplayArm } from "./continuity-e2-protocol.mjs";
const need = (ok, code = "e2_registration_invalid") => { if (!ok) throw Object.assign(Error(code), { code }); };
export async function runE2Paid(options) {
  assertE2Entry();
  need(options && Object.keys(options).filter(k => k !== "replayArm").sort().join() === "authorizationPath,command,credentialPath,outputRoot,registrationPath,registrationSha256");
  const { command, registrationPath, registrationSha256, authorizationPath, credentialPath, outputRoot } = options;
  need(["run", "proofs"].includes(command));
  need(typeof registrationSha256 === "string" && /^[a-f0-9]{64}$/u.test(registrationSha256));
  for (const path of [registrationPath, authorizationPath, credentialPath, outputRoot]) need(typeof path === "string" && path === resolve(path), "e2_authorization_binding_mismatch");
  const raw = await guardedAuthorization("e2-validation").readArtifact(registrationPath, "e2_registration_invalid");
  need(digest(raw) === registrationSha256); const pilot = JSON.parse(raw);
  need(e2ReplayArm(options.replayArm) === e2ReplayArm(pilot.registration.replayArm), "e2_authorization_binding_mismatch");
  // Selection refusal is intentionally before controller setup, lease or burn.
  need(Array.isArray(pilot?.registration?.schedule) && (command !== "proofs" || pilot.registration.schedule.every(s => s?.kind === "proof")));
  return guardedController("e2-validation").runLookupPilot({ real: true, pilot, outputRoot, authorization: {
    schema: E2_AUTHORIZATION_SCHEMA, authorizationPath, registrationPath, registrationSha256, credentialPath, controllerRoot: ROOT,
  } });
}
export const reconcileE2Paid = outputRoot => guardedController("e2-validation").reconcileLookupPilot(outputRoot);
