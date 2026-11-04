// Private local attestations, not authenticated approval. No issuer and no dispatch.
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, readdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { env } from "node:process";
import { digest } from "./continuity-dataset.mjs";
import { sha256 } from "./continuity-lookup.mjs";
import { ROOT, requireLookup } from "./continuity-lookup-roles.mjs";
import { validateLookupPilotRegistration } from "./continuity-lookup-pilot.mjs";
import { lookupProcessStartIdentity } from "./continuity-process-identity.mjs";
import { assertLookupPilotLease, readLookupPilotLease } from "./continuity-lookup-lease.mjs";
import { durable } from "./continuity-holdout-workflow.mjs";

export const LOOKUP_AUTHORIZATION_SCHEMA = "continuity-lookup-pilot-authorization-v1";
export const LOOKUP_CONSUMPTION_SCHEMA = "continuity-lookup-pilot-consumed-v1";
const MARKER = "authorization-consumed.json", CLAIM = "claim.json";
const REGISTRY_DOMAIN = "mono-agent/lookup-pilot/consumed-v1\0";
const ACCOUNT_DOMAIN = "mono-agent/lookup-pilot/account-v1\0";
const need = requireLookup, handles = new WeakMap();
const same = (a, b) => a !== undefined && b !== undefined && digest(a) === digest(b);
const hash = value => /^[a-f0-9]{64}$/u.test(value ?? "");
const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const inside = (a, b) => a === b || (!relative(b, a).startsWith(`..${sep}`) && relative(b, a) !== ".." && !isAbsolute(relative(b, a)));
const disjoint = (a, b) => !inside(a, b) && !inside(b, a);
const fail = code => { throw Object.assign(new Error(code), { code }); };
async function exists(path) { try { await lstat(path); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } }
/** Reject links and writable non-owner ancestors. Root-owned sticky system temp is allowed. */
async function safeDirectory(path, code, privateMode = false) {
  need(isAbsolute(path) && resolve(path) === path, code);
  const uid = userInfo().uid;
  for (let current = path; ; current = dirname(current)) {
    const stat = await lstat(current);
    need(stat.isDirectory() && (stat.uid === uid || stat.uid === 0), code);
    need((stat.mode & 0o022) === 0 || stat.uid === 0 && (stat.mode & 0o1000) !== 0, code);
    if (current === path && privateMode) need(stat.uid === uid && (stat.mode & 0o077) === 0, code);
    if (dirname(current) === current) break;
  }
  need(await realpath(path) === path, code);
  return path;
}
async function safeRead(path, code) {
  await safeDirectory(dirname(path), code);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    need(stat.isFile() && stat.uid === userInfo().uid && stat.nlink === 1 && (stat.mode & 0o077) === 0 && stat.size <= 4 * 1024 * 1024, code);
    const before = await lstat(path);
    need(before.dev === stat.dev && before.ino === stat.ino && !before.isSymbolicLink(), code);
    return await file.readFile();
  } finally { await file.close(); }
}
async function safeJson(path, code) {
  try { return JSON.parse((await safeRead(path, code)).toString("utf8")); }
  catch { fail(code); }
}
function context(handle) { const ctx = handles.get(handle); need(ctx, "lookup_authorization_required"); return ctx; }
/** Diagnostic only. A fabricated object cannot make ordinary readiness pass. */
export function lookupAuthorizationBinds(handle, descriptor, catalog) {
  const ctx = handles.get(handle);
  return Boolean(ctx && same(ctx.pilot.descriptor, descriptor) && same(ctx.pilot.registration.common.catalog, catalog));
}
export async function validateLookupAuthorization(args) {
  try { return await validateAuthorization(args); }
  catch (error) {
    // Never leak filesystem paths, credential parser text or arbitrary causes.
    const code = /^(lookup_[a-z_]+|paid_mode_refused_in_ci)$/u.test(error?.code ?? "") ? error.code : "lookup_authorization_invalid";
    fail(code);
  }
}
async function validateAuthorization({ authorizationPath, registrationPath, registrationSha256, outputRoot, credentialPath, controllerRoot }) {
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
    && controllerRoot === codes.R0.path && controllerRoot === ROOT, "lookup_authorization_binding_mismatch");
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
  need(credential.type === "oauth" && typeof account === "string" && account.length > 0
    && sha256(`${ACCOUNT_DOMAIN}${artifact.salt}\0${account}`) === artifact.accountCommitment, "lookup_account_mismatch");
  // Only an opaque handle leaves this module. Never export paths, commitments or credential material.
  const handle = Object.freeze({});
  handles.set(handle, { artifact, rawDigest: sha256(raw), outputRoot, pilot,
    args: { authorizationPath, registrationPath, registrationSha256, outputRoot, credentialPath, controllerRoot } });
  return handle;
}
async function revalidate(handle) {
  const ctx = context(handle), fresh = context(await validateLookupAuthorization(ctx.args));
  need(fresh.rawDigest === ctx.rawDigest && same(fresh.pilot, ctx.pilot), "lookup_authorization_binding_mismatch");
  return fresh;
}
async function syncDirectory(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
async function registry(ctx, create) {
  const code = "lookup_authorization_registry_unsafe";
  try {
    const home = userInfo().homedir;
    await safeDirectory(home, code);
    const fixed = join(home, ".local/state/mono-agent/lookup-pilot/consumed-v1");
    need(disjoint(fixed, ctx.outputRoot), code);
    for (const c of Object.values(ctx.pilot.registration.codes)) need(disjoint(fixed, await realpath(c.path)), code);
    let path = home;
    for (const segment of [".local", "state", "mono-agent", "lookup-pilot", "consumed-v1"]) {
      path = join(path, segment);
      if (create) {
        try { await mkdir(path, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
        await syncDirectory(dirname(path));
      }
      if (!create && !await exists(path)) return { absent: true };
      await safeDirectory(path, code, ["mono-agent", "lookup-pilot", "consumed-v1"].includes(segment));
    }
    need(disjoint(path, ctx.outputRoot), code);
    for (const c of Object.values(ctx.pilot.registration.codes)) need(disjoint(path, await realpath(c.path)), code);
    const key = createHash("sha256").update(REGISTRY_DOMAIN).update(ctx.artifact.authorizationId).digest("hex");
    return { path, entry: join(path, key) };
  } catch { fail(code); }
}
function claim(ctx, identity, binding) {
  need(id(identity?.runId) && id(identity?.controllerEpoch) && Number.isSafeInteger(identity?.controller?.pid) && identity.controller.pid > 1
    && typeof identity.controller.startIdentity === "string" && identity.controller.startIdentity.length > 0
    && lookupProcessStartIdentity(identity.controller.pid) === identity.controller.startIdentity, "lookup_authorization_invalid");
  return { schema: LOOKUP_CONSUMPTION_SCHEMA, authorizationId: ctx.artifact.authorizationId,
    authorizationSha256: ctx.rawDigest, outputRoot: ctx.outputRoot, ...binding,
    runId: identity.runId, controllerEpoch: identity.controllerEpoch, controller: { pid: identity.controller.pid, startIdentity: identity.controller.startIdentity } };
}
async function pair(ctx, entry, expected) {
  const code = "lookup_authorization_consumption_incomplete";
  try {
    await safeDirectory(entry, code, true);
    need(same((await readdir(entry)).sort(), [CLAIM]), code);
    const a = await safeJson(join(entry, CLAIM), code), b = await safeJson(join(ctx.outputRoot, MARKER), code);
    const binding = await readLookupPilotLease(ctx.outputRoot, a.controller);
    need(same(a, b) && a.schema === LOOKUP_CONSUMPTION_SCHEMA && a.authorizationId === ctx.artifact.authorizationId
      && a.authorizationSha256 === ctx.rawDigest && a.outputRoot === ctx.outputRoot
      && same(a.outputIdentity, binding.outputIdentity) && same(a.leaseIdentity, binding.leaseIdentity)
      && id(a.runId) && id(a.controllerEpoch) && Number.isSafeInteger(a.controller?.pid) && a.controller.pid > 1
      && typeof a.controller.startIdentity === "string" && (!expected || same(a, expected)), code);
  } catch { fail(code); }
}
/** Requires a live opaque SQLite lease; consume before launching children and retain the lease until shutdown. */
export async function consumeLookupAuthorization(handle, identity, lease) {
  try { return await consume(handle, identity, lease); }
  catch (error) { fail(/^(lookup_[a-z_]+|paid_mode_refused_in_ci)$/u.test(error?.code ?? "") ? error.code : "lookup_authorization_consumption_incomplete"); }
}
async function consume(handle, identity, lease) {
  const ctx = await revalidate(handle), expected = claim(ctx, identity);
  need(identity.controller.pid === process.pid, "lookup_authorization_invalid");
  Object.assign(expected, await assertLookupPilotLease(lease, ctx.outputRoot, identity.controller));
  const r = await registry(ctx, true);
  await safeDirectory(ctx.outputRoot, "lookup_authorization_binding_mismatch", true);
  if (await exists(r.entry)) {
    const prior = await safeJson(join(r.entry, CLAIM), "lookup_authorization_consumption_incomplete");
    if (prior.schema === LOOKUP_CONSUMPTION_SCHEMA && prior.authorizationId === ctx.artifact.authorizationId
      && hash(prior.authorizationSha256) && prior.authorizationSha256 !== ctx.rawDigest) fail("lookup_authorization_already_consumed");
    await pair(ctx, r.entry); fail("lookup_authorization_already_consumed");
  }
  need(!await exists(join(ctx.outputRoot, MARKER)), "lookup_authorization_consumption_incomplete");
  need(!await exists(join(ctx.outputRoot, "units")), "lookup_pilot_resume_forbidden");
  // The only permitted pre-setup file is the caller's lease. No reuse of an old run root.
  need((await readdir(ctx.outputRoot)).every(name => name === "controller-lock.sqlite"), "lookup_pilot_resume_forbidden");
  try { await mkdir(r.entry, { mode: 0o700 }); }
  catch (e) { if (e.code === "EEXIST") fail("lookup_authorization_already_consumed"); throw e; }
  // Persist the burn before either marker. No rollback, repair or identical-claim replay.
  await syncDirectory(r.path);
  try {
    await durable(join(ctx.outputRoot, MARKER), expected, true);
    await durable(join(r.entry, CLAIM), expected, true);
    await pair(ctx, r.entry, expected);
  } catch { fail("lookup_authorization_consumption_incomplete"); }
  return Object.freeze({ consumed: true, authorizationId: ctx.artifact.authorizationId });
}
/** Read-only child/setup prerequisite, never a grant or a way to repair partial writes. */
export async function verifyLookupConsumption(handle, identity) {
  try { return await verifyConsumption(handle, identity); }
  catch (error) { fail(/^(lookup_[a-z_]+|paid_mode_refused_in_ci)$/u.test(error?.code ?? "") ? error.code : "lookup_authorization_consumption_incomplete"); }
}
async function verifyConsumption(handle, identity) {
  const ctx = await revalidate(handle), r = await registry(ctx, false);
  need(!r.absent && await exists(r.entry), "lookup_authorization_consumption_incomplete");
  await safeDirectory(ctx.outputRoot, "lookup_authorization_consumption_incomplete", true);
  await pair(ctx, r.entry, claim(ctx, identity, await readLookupPilotLease(ctx.outputRoot, identity?.controller)));
  return true;
}
