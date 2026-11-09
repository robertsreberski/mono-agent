// Lookup-only controller admission, scheduling and role assignment. No journal or money mutations.
import { assertLookupPilotArm } from "./continuity-lookup-preparation.mjs";
import { armById } from "./continuity-arms.mjs";
import { digest } from "./continuity-dataset.mjs";
import { externalDirectory } from "./continuity-holdout-files.mjs";
import { ROOT, verifyRegisteredCheckouts, roleBinding, rolePlan } from "./continuity-lookup-roles.mjs";
import { validateLookupPilotRegistration } from "./continuity-lookup-pilot.mjs";
import { pilotNeed } from "./continuity-lookup-pilot-accounting.mjs";
import { requireFauxPilot, lookupPilotSchedule } from "./continuity-lookup-pilot-state.mjs";
export async function prepareLookupController(options = {}) {
  const { pilot, authorization, outputRoot } = options;
  const real = authorization?.schema === "continuity-lookup-pilot-authorization-v1";
  if (real) {
    (await import("./continuity-lookup-pilot-entry.mjs")).assertLookupPilotEntry();
    pilotNeed(Object.keys(authorization).sort().join() === "authorizationPath,controllerRoot,credentialPath,registrationPath,registrationSha256,schema", "lookup_authorization_binding_mismatch");
    pilotNeed(!Object.hasOwn(process.env, "CI"), "paid_mode_refused_in_ci");
    pilotNeed(!Object.hasOwn(process.env, "CONTINUITY_DEBUG"), "lookup_debug_forbidden");
  }
  else requireFauxPilot(authorization);
  pilotNeed(Object.keys(options).sort().join() === "authorization,outputRoot,pilot", "lookup_pilot_faux_required");
  await validateLookupPilotRegistration(pilot);
  pilotNeed(pilot.registration.codes.R0.path === ROOT, "lookup_controller_checkout_mismatch");
  const auth = real ? await import("./continuity-lookup-authorization.mjs") : null;
  const authorizationHandle = real ? await auth.validateLookupAuthorization({ ...authorization, outputRoot }) : null;
  pilotNeed(!real || auth.lookupAuthorizationBindsPilot(authorizationHandle, pilot), "lookup_authorization_binding_mismatch");

  for (const role of pilot.registration.roles) assertLookupPilotArm(armById(role.arm));
  await verifyRegisteredCheckouts(pilot.registration);
  const schedule = lookupPilotSchedule(pilot);
  pilotNeed(!real || schedule.some(slot => slot.eligible), "lookup_pilot_no_eligible_slots");
  pilotNeed(await externalDirectory(outputRoot, false, Object.values(pilot.registration.codes).map(c => c.path)) === outputRoot, "lookup_receipt_invalid");
  return { pilot, authorization, outputRoot, real, authorizationHandle, schedule };
}
export async function lookupSlotRequest(pilot, slot) {
  const code = pilot.registration.codes[slot.code];
  const role = pilot.registration.roles.find(r => r.id === slot.roleId), corpus = pilot.registration.common.corpora.find(c => c.suite === slot.suite);
  const binding = roleBinding(pilot.registration, role, corpus), plan = await rolePlan(pilot.registration.common, binding);
  return { code, binding, plan };
}
