// Artifact/account policy only; opaque handles and consumption stay in the guarded core.
import { env } from "node:process";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { digest } from "./continuity-dataset.mjs";
import { digest as sha256 } from "./continuity-recorded-schema.mjs";
import { ROOT } from "./continuity-observation-input.mjs";
import { E2_AUTHORIZATION_SCHEMA, E2_PLAN_SCHEMA } from "./continuity-e2-policy.mjs";
import { validateE2Registration, validateE2Deadlines } from "./continuity-e2-registration.mjs";
export function e2AuthorizationBindings(pilot, registrationRawSha256, { outputRoot, credentialPath, salt, accountCommitment }) {
  if (pilot?.descriptor?.schema !== E2_PLAN_SCHEMA) throw Object.assign(Error("e2_deadlines_invalid"), { code: "e2_deadlines_invalid" });
  validateE2Deadlines(pilot.descriptor.deadlines);
  const r = pilot.registration;
  return { registrationRawSha256, registrationSha256: digest(pilot), code: r.code, build: r.build, catalog: r.catalog,
    protocol: r.protocol, source: r.source, probes: r.probes, keys: r.keys, soul: r.soul, roles: r.roles, schedule: r.schedule,
    account: { salt, commitment: accountCommitment }, tools: r.toolPolicies, deadlines: pilot.descriptor.deadlines,
    capUnits: pilot.descriptor.capUnits, descriptor: pilot.descriptor, outputRoot, credentialPath };
}
export async function validateE2GuardedAuthorization(args, helpers) {
  const { need, hash, id, safeRead, safeDirectory, fail, disjoint, same, matchesAccount } = helpers;
  const { authorizationPath, registrationPath, registrationSha256, outputRoot, credentialPath, controllerRoot } = args;
  need(typeof authorizationPath === "string", "e2_authorization_required");
  need(!Object.hasOwn(env, "CI"), "paid_mode_refused_in_ci");
  need(!Object.hasOwn(env, "CONTINUITY_DEBUG"), "e2_debug_forbidden");
  need(Object.keys(args).sort().join() === "authorizationPath,controllerRoot,credentialPath,outputRoot,registrationPath,registrationSha256", "e2_authorization_binding_mismatch");
  let raw, artifact, registrationBytes, pilot;
  try { raw = await safeRead(authorizationPath, "e2_unsafe_authorization_file"); }
  catch { fail("e2_unsafe_authorization_file"); }
  try { artifact = JSON.parse(raw); } catch { fail("e2_authorization_invalid"); }
  need(artifact?.schema === E2_AUTHORIZATION_SCHEMA && id(artifact.authorizationId) && hash(artifact.salt) && hash(artifact.accountCommitment)
    && typeof artifact.timestamp === "string" && Number.isFinite(Date.parse(artifact.timestamp))
    && [artifact.approver, artifact.numericApprovalReference].every(s => typeof s === "string" && s.trim() && !/[\u0000-\u001f]/u.test(s))
    && same(Object.keys(artifact).sort(), ["schema", "authorizationId", "salt", "accountCommitment", "timestamp", "approver", "numericApprovalReference", "bindings"].sort()), "e2_authorization_invalid");
  try { registrationBytes = await safeRead(registrationPath, "e2_authorization_binding_mismatch"); pilot = JSON.parse(registrationBytes); }
  catch { fail("e2_authorization_binding_mismatch"); }
  need(hash(registrationSha256) && sha256(registrationBytes) === registrationSha256, "e2_authorization_binding_mismatch");
  await validateE2Registration(pilot, helpers);
  need([outputRoot, credentialPath, controllerRoot].every(p => typeof p === "string" && isAbsolute(p)), "e2_authorization_binding_mismatch");
  await safeDirectory(outputRoot, "e2_authorization_binding_mismatch", true);
  need(controllerRoot === ROOT && pilot.registration.code.path === ROOT && await realpath(controllerRoot) === controllerRoot
    && await realpath(credentialPath) === credentialPath, "e2_authorization_binding_mismatch");
  for (const path of [ROOT, authorizationPath, registrationPath, credentialPath, pilot.registration.source.path,
    pilot.registration.protocol.path, pilot.registration.probes.path, pilot.registration.keys.path, ...pilot.registration.sizing.map(s => s.path)])
    need(disjoint(outputRoot, await realpath(path)), "e2_authorization_binding_mismatch");
  await safeRead(credentialPath, "e2_unsafe_authorization_file");
  need(same(artifact.bindings, e2AuthorizationBindings(pilot, sha256(registrationBytes), { outputRoot, credentialPath, salt: artifact.salt, accountCommitment: artifact.accountCommitment })), "e2_authorization_binding_mismatch");
  const { createPiOAuthApiKeyResolver } = await import("@mono-agent/turn");
  const credential = await createPiOAuthApiKeyResolver({ path: credentialPath }).readCredential("openai-codex");
  let account;
  try { account = JSON.parse(Buffer.from(credential.access.split(".")[1], "base64url").toString("utf8"))["https://api.openai.com/auth"].chatgpt_account_id; }
  catch { fail("e2_account_mismatch"); }
  need(credential.type === "oauth" && matchesAccount(artifact, account), "e2_account_mismatch");
  return { artifact, rawDigest: sha256(raw), outputRoot, registration: pilot, args: { ...args } };
}
