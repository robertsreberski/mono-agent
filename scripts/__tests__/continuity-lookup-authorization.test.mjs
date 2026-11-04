import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { userInfo, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { digest } from "../lib/continuity-dataset.mjs";
import { LOOKUP_ASSUMPTIONS } from "../lib/continuity-lookup-guard.mjs";

const sha = data => createHash("sha256").update(data).digest("hex");
const realUser = userInfo(), realRegistry = join(realUser.homedir, ".local/state/mono-agent/lookup-pilot/consumed-v1");
const identity = { runId: "fictional-run", controllerEpoch: "fictional-epoch",
  controller: { pid: process.pid, startIdentity: execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" }).trim() } };
let dir, home, auth, readiness, f, realBefore, refresh, network, fetch;
const runningUnderCI = Object.hasOwn(process.env, "CI");
let successfulConsumptions = 0;
const snapshot = async path => { try { const stat = await fs.lstat(path); return [stat.ino, stat.mtimeMs]; } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const save = (path, data) => fs.writeFile(path, JSON.stringify(data), { mode: 0o600 });
const token = (account, rotation = 1) => `fake.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account }, rotation })).toString("base64url")}.fictional`;
beforeEach(async () => {
  realBefore = await snapshot(realRegistry);
  dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lookup-authorization-test-")));
  await fs.chmod(dir, 0o700); home = join(dir, "home"); await fs.mkdir(home, { mode: 0o700 });
  refresh = vi.fn(() => { throw new Error("refresh_forbidden"); });
  vi.resetModules();
  network = vi.spyOn(Socket.prototype, "connect").mockImplementation(() => { throw new Error("test_egress_denied"); });
  fetch = vi.fn(() => { throw new Error("test_egress_denied"); });
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("test_egress_denied"); } });
  // In-process unit fixtures only; egress is denied and no production child is launched.
  vi.stubEnv("CI", undefined);
  vi.stubEnv("CONTINUITY_DEBUG", undefined);
  // Each test gets a new isolated graph. No production path/user override exists.
  vi.doMock("node:os", async original => ({ ...await original(), userInfo: () => ({ ...realUser, homedir: home }) }));
  vi.doMock("@mono-agent/turn", () => ({ createPiOAuthApiKeyResolver: ({ path }) => Object.assign(refresh, {
    readCredential: async provider => provider === "openai-codex" ? JSON.parse(await fs.readFile(path, "utf8")) : undefined,
  }) }));
  // Synthetic registrations are intentionally not production-valid. Only this graph accepts them.
  vi.doMock("../lib/continuity-lookup-pilot.mjs", () => ({ validateLookupPilotRegistration: async value => value }));
  auth = await import("../lib/continuity-lookup-authorization.mjs");
  ({ lookupPilotReadiness: readiness } = await import("../lib/continuity-lookup-roles.mjs"));
  f = await fixture();
});
afterEach(async () => {
  expect(refresh).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  // Suite-level witness: the real fixed registry was neither created nor changed.
  expect(await snapshot(realRegistry)).toEqual(realBefore);
  vi.doUnmock("node:os"); vi.doUnmock("@mono-agent/turn"); vi.doUnmock("../lib/continuity-lookup-pilot.mjs");
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true });
});
afterAll(() => {
  // No skip/conditional path: this witness must also pass in hosted CI.
  expect(successfulConsumptions).toBeGreaterThan(0);
  if (runningUnderCI) expect(Object.hasOwn(process.env, "CI")).toBe(true);
});
// The only real-schema fixture builder is test-local, synthetic and fictional.
async function fixture() {
  const roots = [join(dir, "r0"), join(dir, "rpack")], outputRoot = join(dir, "output"), credentialPath = join(dir, "fictional-credential.json");
  for (const path of [...roots, outputRoot]) await fs.mkdir(path, { mode: 0o700 });
  const catalog = { model: "openai-codex:gpt-6.1-sol", cost: { ...LOOKUP_ASSUMPTIONS.rates } };
  const descriptor = { capPolicy: "cap-gated-v1", assumptions: LOOKUP_ASSUMPTIONS, assumptionsSha256: digest(LOOKUP_ASSUMPTIONS),
    outputCap: "catalog_max_assumed", inputEnvelope: "assumed-v1", capUSD: 4, concurrency: 1,
    schedule: { version: "fictional-schedule", seed: 1 }, deadlines: { runDeadlineMs: 1000 }, cacheKeyPolicy: "controller-issued-transport-key-v1" };
  const codes = Object.fromEntries(["R0", "Rpack"].map((id, i) => [id, { path: roots[i], revision: "a".repeat(40), build: { outputSha256: "b".repeat(64) } }]));
  const common = { protocol: { version: "fictional-protocol" }, catalog, policy: { sha: "fictional-policy" }, lookupSource: { sha: "fictional-source" },
    lookupSelection: { seed: 1 }, reader: { model: catalog.model, effort: "high" } };
  const pilot = { schema: "continuity-lookup-pilot-registration-v1", registration: { schema: "continuity-lookup-registration-v2", common, codes }, descriptor };
  const registrationPath = join(dir, "registration.json"); await save(registrationPath, pilot);
  const registrationRawSha256 = sha(await fs.readFile(registrationPath));
  const salt = "c".repeat(64), account = "fictional-account";
  const artifact = { schema: auth.LOOKUP_AUTHORIZATION_SCHEMA, authorizationId: "fictional-authorization", salt,
    accountCommitment: sha(`mono-agent/lookup-pilot/account-v1\0${salt}\0${account}`), timestamp: "2030-01-01T00:00:00Z",
    approver: "Fictional Approver", numericApprovalReference: "fictional-cap-approval-4USD",
    bindings: { registrationRawSha256, registrationSha256: digest(pilot), controllerCheckout: codes.R0, codes, protocol: common.protocol,
      catalog, policy: common.policy, source: common.lookupSource, selection: common.lookupSelection, reader: common.reader, descriptor, outputRoot, credentialPath } };
  const authorizationPath = join(dir, "authorization.json"); await save(authorizationPath, artifact);
  await save(credentialPath, { type: "oauth", access: token(account), refresh: "fictional-refresh" });
  const args = { authorizationPath, registrationPath, registrationSha256: registrationRawSha256, outputRoot, credentialPath, controllerRoot: roots[0] };
  const entry = () => join(home, ".local/state/mono-agent/lookup-pilot/consumed-v1", sha(`mono-agent/lookup-pilot/consumed-v1\0${artifact.authorizationId}`));
  return { args, artifact, pilot, account, entry, marker: join(outputRoot, "authorization-consumed.json"), descriptor, catalog };
}
const validate = () => auth.validateLookupAuthorization(f.args);
it("consumes a complete private synced pair, exports only allowlisted content and refuses replay", async () => {
  const handle = await validate(); expect(JSON.stringify(handle)).toBe("{}");
  expect(await auth.consumeLookupAuthorization(handle, identity)).toEqual({ consumed: true, authorizationId: "fictional-authorization" });
  expect(await auth.verifyLookupConsumption(handle, identity)).toBe(true);
  successfulConsumptions++;
  expect((await fs.stat(f.entry())).mode & 0o777).toBe(0o700);
  for (const path of [f.marker, join(f.entry(), "claim.json")]) {
    const stat = await fs.stat(path); expect(stat.mode & 0o777).toBe(0o600); expect(stat.nlink).toBe(1);
  }
  await expect(auth.consumeLookupAuthorization(handle, identity)).rejects.toThrow("lookup_authorization_already_consumed");
  await expect(auth.verifyLookupConsumption(handle, { ...identity, controllerEpoch: "other" })).rejects.toThrow("lookup_authorization_consumption_incomplete");
});
it("allows only a validated attestation to extend diagnostic readiness, without dispatch authority", async () => {
  const args = { model: f.catalog.model, catalog: f.catalog, descriptor: f.descriptor, capPolicy: "cap-gated-v1" };
  expect(readiness({ ...args, authorization: {} })).toMatchObject({ ready: false, status: "awaiting_authorization",
    assumptions: { status: "ready" }, pricing: { status: "ready" }, blockers: ["lookup_authorization_required"] });
  const handle = await validate();
  expect(readiness({ ...args, authorization: handle }).ready).toBe(true);
  expect(readiness({ ...args, authorization: handle, capPolicy: undefined }).ready).toBe(false);
  expect(readiness({ ...args, authorization: handle, catalog: { ...f.catalog, cost: { input: 2 } } }).ready).toBe(false);
  expect(readiness({ ...args, authorization: handle, descriptor: { ...f.descriptor, concurrency: 2 } }).ready).toBe(false);
});
it("serializes concurrent claimers with exactly one winner", async () => {
  const handles = await Promise.all([validate(), validate()]);
  const result = await Promise.allSettled(handles.map(h => auth.consumeLookupAuthorization(h, identity)));
  expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(result.filter(r => r.status === "rejected")).toHaveLength(1);
  expect(await auth.verifyLookupConsumption(handles[0], identity)).toBe(true);
});
it("burns across output deletion/recreation and authorization rename", async () => {
  await auth.consumeLookupAuthorization(await validate(), identity);
  await fs.rm(f.args.outputRoot, { recursive: true }); await fs.mkdir(f.args.outputRoot, { mode: 0o700 });
  const renamed = join(dir, "renamed-authorization.json"); await fs.rename(f.args.authorizationPath, renamed); f.args.authorizationPath = renamed;
  await expect(auth.consumeLookupAuthorization(await validate(), identity)).rejects.toThrow("lookup_authorization_consumption_incomplete");
  expect(await fs.readdir(f.args.outputRoot)).toEqual([]);
});
it("rejects an alternate root, even when the artifact filename is changed", async () => {
  const alternate = join(dir, "alternate"); await fs.mkdir(alternate, { mode: 0o700 });
  await expect(auth.validateLookupAuthorization({ ...f.args, outputRoot: alternate })).rejects.toThrow("lookup_authorization_binding_mismatch");
});
it.each(["empty", "corrupt", "mismatched", "extra"])("never repairs a %s registry burn", async kind => {
  await fs.mkdir(f.entry(), { recursive: true, mode: 0o700 });
  if (kind !== "empty") await fs.writeFile(join(f.entry(), "claim.json"), kind === "corrupt" ? "{" : "{}", { mode: 0o600 });
  if (kind === "extra") await save(join(f.entry(), "extra.json"), {});
  const before = await fs.readdir(f.entry());
  await expect(auth.consumeLookupAuthorization(await validate(), identity)).rejects.toThrow("lookup_authorization_consumption_incomplete");
  expect(await fs.readdir(f.entry())).toEqual(before); expect(await snapshot(f.marker)).toBeNull();
});
it.each(["marker", "units", "old-state"])("rejects reused roots with %s", async kind => {
  if (kind === "units") await fs.mkdir(join(f.args.outputRoot, "units"));
  else await save(kind === "marker" ? f.marker : join(f.args.outputRoot, "old-state.json"), {});
  await expect(auth.consumeLookupAuthorization(await validate(), identity)).rejects.toThrow(kind === "marker" ? "lookup_authorization_consumption_incomplete" : "lookup_pilot_resume_forbidden");
  expect(await snapshot(f.entry())).toBeNull();
});
it.each(["symlink", "hardlink", "public", "directory"])("rejects unsafe %s authorization files", async kind => {
  const path = f.args.authorizationPath, other = join(dir, "other");
  if (kind === "symlink") { await fs.rename(path, other); await fs.symlink(other, path); }
  if (kind === "hardlink") await fs.link(path, other);
  if (kind === "public") await fs.chmod(path, 0o644);
  if (kind === "directory") { await fs.unlink(path); await fs.mkdir(path); }
  await expect(validate()).rejects.toThrow("lookup_unsafe_authorization_file");
});
it.each(["symlink", "hardlink", "public"])("rejects unsafe %s consumed markers without repairing", async kind => {
  const handle = await validate(); await auth.consumeLookupAuthorization(handle, identity);
  const path = join(f.entry(), "claim.json"), other = join(dir, "alias");
  if (kind === "symlink") { await fs.rename(path, other); await fs.symlink(other, path); }
  if (kind === "hardlink") await fs.link(path, other);
  if (kind === "public") await fs.chmod(path, 0o644);
  await expect(auth.verifyLookupConsumption(handle, identity)).rejects.toThrow("lookup_authorization_consumption_incomplete");
});
it.each(["symlink", "public"])("rejects unsafe %s registry ancestry", async kind => {
  const path = join(home, ".local");
  if (kind === "symlink") { const other = join(dir, "other"); await fs.mkdir(other); await fs.symlink(other, path); }
  else { await fs.mkdir(path); await fs.chmod(path, 0o777); }
  await expect(auth.consumeLookupAuthorization(await validate(), identity)).rejects.toThrow("lookup_authorization_registry_unsafe");
});
it("derives the fixed registry from userInfo rather than HOME/XDG", async () => {
  vi.stubEnv("HOME", join(dir, "untrusted-home")); vi.stubEnv("XDG_STATE_HOME", join(dir, "untrusted-state"));
  await auth.consumeLookupAuthorization(await validate(), identity);
  expect(await fs.readdir(f.entry())).toEqual(["claim.json"]);
  expect(await snapshot(join(dir, "untrusted-state"))).toBeNull();
});
it.each(["codes", "protocol", "catalog", "policy", "source", "selection", "reader", "descriptor", "registrationRawSha256", "registrationSha256", "credentialPath", "outputRoot", "controllerCheckout"])("rejects %s binding substitution", async field => {
  f.artifact.bindings[field] = "fictional-substitution"; await save(f.args.authorizationPath, f.artifact);
  await expect(validate()).rejects.toThrow("lookup_authorization_binding_mismatch");
});
it("rejects account substitution but allows same-account access token rotation without refresh", async () => {
  await save(f.args.credentialPath, { type: "oauth", access: token("different-fictional-account") });
  await expect(validate()).rejects.toThrow("lookup_account_mismatch");
  await save(f.args.credentialPath, { type: "oauth", access: token(f.account, 2), refresh: "rotated-fictional-refresh" });
  const handle = await validate(); await auth.consumeLookupAuthorization(handle, identity);
  await save(f.args.credentialPath, { type: "oauth", access: token(f.account, 3) });
  expect(await auth.verifyLookupConsumption(await validate(), identity)).toBe(true);
});
it("rejects faux artifacts and fabricated handles", async () => {
  f.artifact.schema = "continuity-lookup-pilot-faux-authorization-v1"; await save(f.args.authorizationPath, f.artifact);
  await expect(validate()).rejects.toThrow("lookup_authorization_invalid");
  await expect(auth.consumeLookupAuthorization({}, identity)).rejects.toThrow("lookup_authorization_required");
});
it.each(["CI", "CONTINUITY_DEBUG"])("refuses presence of %s even when empty", async key => {
  vi.stubEnv(key, ""); await expect(validate()).rejects.toThrow(key === "CI" ? "paid_mode_refused_in_ci" : "lookup_debug_forbidden");
});

it("burns the same ID after reserialization and output deletion, even though its raw digest changes", async () => {
  await auth.consumeLookupAuthorization(await validate(), identity);
  await fs.rm(f.args.outputRoot, { recursive: true }); await fs.mkdir(f.args.outputRoot, { mode: 0o700 });
  await fs.writeFile(f.args.authorizationPath, `${JSON.stringify(f.artifact, null, 2)}\n`, { mode: 0o600 });
  await expect(auth.consumeLookupAuthorization(await validate(), identity)).rejects.toThrow("lookup_authorization_already_consumed");
  expect(await fs.readdir(f.args.outputRoot)).toEqual([]);
});
it("binds the live controller PID/start identity, and consumes before children can launch", async () => {
  const handle = await validate();
  await expect(auth.consumeLookupAuthorization(handle, { ...identity, controller: { ...identity.controller, startIdentity: "substituted" } })).rejects.toThrow("lookup_authorization_invalid");
  await auth.consumeLookupAuthorization(handle, identity);
  const claim = JSON.parse(await fs.readFile(f.marker, "utf8"));
  expect(claim.controller).toEqual(identity.controller); expect(claim).not.toHaveProperty("nonceCommitment");
});

it("keeps synthetic real-schema fixtures invalid in the normal registration graph", async () => {
  const actual = await vi.importActual("../lib/continuity-lookup-pilot.mjs");
  await expect(actual.validateLookupPilotRegistration(f.pilot)).rejects.toThrow("lookup_registration_protocol_mismatch");
});
it.each(["output", "credential"])("rejects a symlinked %s location", async kind => {
  const key = kind === "output" ? "outputRoot" : "credentialPath", path = f.args[key], other = join(dir, "alias-target");
  await fs.rename(path, other); await fs.symlink(other, path);
  await expect(validate()).rejects.toThrow("lookup_authorization_binding_mismatch");
});
it("revalidates the attestation and account immediately before writing a burn", async () => {
  const handle = await validate();
  await save(f.args.credentialPath, { type: "oauth", access: token("substituted-fictional-account") });
  await expect(auth.consumeLookupAuthorization(handle, identity)).rejects.toThrow("lookup_account_mismatch");
  expect(await snapshot(f.entry())).toBeNull();
});
