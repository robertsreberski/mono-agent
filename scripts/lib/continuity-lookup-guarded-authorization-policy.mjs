// Lookup artifact/account policy only. No handles, consumption, registry writes or dispatch.
import { env } from "node:process";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { digest } from "./continuity-dataset.mjs";
import { sha256 } from "./continuity-lookup.mjs";
import { ROOT } from "./continuity-lookup-roles.mjs";
import { validateLookupPilotRegistration } from "./continuity-lookup-pilot.mjs";
import { LOOKUP_AUTHORIZATION_SCHEMA } from "./continuity-lookup-guarded-policy.mjs";
export async function validateLookupGuardedAuthorization({ authorizationPath, registrationPath, registrationSha256, outputRoot, credentialPath, controllerRoot }, { need, hash, id, safeRead, safeDirectory, fail, disjoint, same, matchesAccount }) {
  need(typeof authorizationPath === "string", "lookup_authorization_required");
  need(!Object.hasOwn(env, "CI"), "paid_mode_refused_in_ci");
  need(!Object.hasOwn(env, "CONTINUITY_DEBUG"), "lookup_debug_forbidden");
  let raw, artifact, registrationBytes, pilot;
  try { raw = await safeRead(authorizationPath, "lookup_unsafe_authorization_file"); }
  catch { fail("lookup_unsafe_authorization_file"); }
  try { artifact = JSON.parse(raw); } catch { fail("lookup_authorization_invalid"); }
  need(artifact?.schema === LOOKUP_AUTHORIZATION_SCHEMA && id(artifact.authorizationId)
    && hash(artifact.salt) && hash(artifact.accountCommitment)
    && typeof artifact.timestamp === "string" && Number.isFinite(Date.parse(artifact.timestamp))
    && [artifact.approver, artifact.numericApprovalReference].every(s => typeof s === "string" && s.trim().length > 0 && !/[\u0000-\u001f]/u.test(s)), "lookup_authorization_invalid");
  try { registrationBytes = await safeRead(registrationPath, "lookup_authorization_binding_mismatch"); pilot = JSON.parse(registrationBytes); }
  catch { fail("lookup_authorization_binding_mismatch"); }
  need(hash(registrationSha256) && sha256(registrationBytes) === registrationSha256, "lookup_authorization_binding_mismatch");
  await validateLookupPilotRegistration(pilot);
  const { registration, descriptor } = pilot, { common, codes } = registration;
  need(isAbsolute(outputRoot ?? "") && isAbsolute(credentialPath ?? "") && isAbsolute(controllerRoot ?? ""), "lookup_authorization_binding_mismatch");
  await safeDirectory(outputRoot, "lookup_authorization_binding_mismatch", true);
  need(await realpath(credentialPath) === credentialPath && await realpath(controllerRoot) === controllerRoot
    && controllerRoot === codes.R0.path && Object.values(codes).some(code => code.path === ROOT), "lookup_authorization_binding_mismatch");
  // Check permissions without ever resolving/refreshing a credential.
  await safeRead(credentialPath, "lookup_unsafe_authorization_file");
  for (const code of Object.values(codes)) need(disjoint(outputRoot, await realpath(code.path)), "lookup_authorization_binding_mismatch");
  const expected = { registrationRawSha256: sha256(registrationBytes), registrationSha256: digest(pilot), controllerCheckout: codes.R0,
    codes, protocol: common.protocol, catalog: common.catalog, policy: common.policy, source: common.lookupSource,
    selection: common.lookupSelection, reader: common.reader, descriptor, outputRoot, credentialPath };
  need(same(artifact.bindings, expected) && same(Object.keys(artifact).sort(), ["schema", "authorizationId", "salt", "accountCommitment", "timestamp", "approver", "numericApprovalReference", "bindings"].sort()), "lookup_authorization_binding_mismatch");
  const { createPiOAuthApiKeyResolver } = await import("@mono-agent/turn");
  const resolver = createPiOAuthApiKeyResolver({ path: credentialPath });
  const credential = await resolver.readCredential("openai-codex");
  let account;
  try { account = JSON.parse(Buffer.from(credential.access.split(".")[1], "base64url").toString("utf8"))["https://api.openai.com/auth"].chatgpt_account_id; }
  catch { fail("lookup_account_mismatch"); }
  need(credential.type === "oauth" && matchesAccount(artifact, account), "lookup_account_mismatch");
  return { artifact, rawDigest: sha256(raw), outputRoot, registration: pilot,
    args: { authorizationPath, registrationPath, registrationSha256, outputRoot, credentialPath, controllerRoot } };
}
