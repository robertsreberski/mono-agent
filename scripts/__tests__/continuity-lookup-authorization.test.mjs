import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { fork, execFileSync } from "node:child_process";
import { userInfo, tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syntheticContext, fixtureLookupPolicy, fixtureCommit } from "./fixtures/holdout-synthetic.mjs";
import { ROOT as worktree } from "../lib/continuity-lookup-roles.mjs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { digest } from "../lib/continuity-dataset.mjs";
import { LOOKUP_ASSUMPTIONS } from "../lib/continuity-lookup-guard.mjs";

const sha = data => createHash("sha256").update(data).digest("hex");
const realUser = userInfo(), realRegistry = join(realUser.homedir, ".local/state/mono-agent/lookup-pilot/consumed-v1");
let identity, shared, base, suiteRealBefore;
let dir, home, auth, readiness, f, realBefore, network, fetch;
const runningUnderCI = Object.hasOwn(process.env, "CI");
let successfulConsumptions = 0;
const children = new Map();
const snapshot = async path => { try { const stat = await fs.lstat(path); return [stat.ino, stat.mtimeMs]; } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const save = (path, data) => fs.writeFile(path, JSON.stringify(data), { mode: 0o600 });
const token = (account, rotation = 1) => `fake.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account }, rotation })).toString("base64url")}.fictional`;
const credential = (account, rotation = 1) => ({ "openai-codex": {
  type: "oauth", access: token(account, rotation), refresh: "fictional-refresh", expires: 0,
} });
const local = name => import(/* @vite-ignore */ pathToFileURL(join(shared.repo, "scripts/lib", `${name}.mjs`)).href);
beforeAll(async () => {
  suiteRealBefore = await snapshot(realRegistry);
  base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lookup-authorization-source-")));
  const buildHome = join(base, "build-home"); await fs.mkdir(buildHome, { mode: 0o700 });
  vi.stubEnv("HOME", buildHome); vi.stubEnv("XDG_CONFIG_HOME", buildHome); vi.stubEnv("XDG_CACHE_HOME", buildHome);
  vi.stubEnv("COREPACK_ENABLE_NETWORK", "0"); vi.stubEnv("npm_config_offline", "true");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null"); vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  try {
    shared = await syntheticContext(base, { families: 4, conversationsPerFamily: 1, conversationsPerCorpus: 2, shards: 2, perCorpusPerShard: 1 });
    await fs.chmod(shared.repo, 0o700);
    // Real, tiny clean checkouts and real deterministic builds, not build/registration mocks.
    await fs.rm(join(shared.repo, "packages/app/dist")); // removes only the fixture's symlink
    await save(join(shared.repo, "package.json"), { name: "fictional-lookup-tooling", private: true });
    await fs.writeFile(join(shared.repo, "pnpm-workspace.yaml"), "packages:\n  - packages/app\n");
    await fs.writeFile(join(shared.repo, ".npmrc"), "offline=true\nverify-deps-before-run=false\nmanage-package-manager-versions=false\n");
    await save(join(shared.repo, "packages/app/package.json"), { name: "@mono-agent/app", version: "0.0.0", private: true,
      scripts: { build: `node --input-type=module -e "import{mkdirSync,writeFileSync}from'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/index.js','export const fictional = true;')"` } });
    await fs.writeFile(join(shared.repo, "packages/conversation/src/continuity/render-fit.ts"), "// Fictional no-guidance source\n");
    fixtureCommit(shared.repo);
    const pack = join(base, "rpack"); await fs.cp(shared.repo, pack, { recursive: true }); await fs.chmod(pack, 0o700);
    await fs.appendFile(join(pack, "packages/conversation/src/continuity/render-fit.ts"), '\nexport const PACK_RETRIEVAL_GUIDANCE = "Fictional fixture guidance";\n');
    fixtureCommit(pack);
    const revision = path => execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const checkouts = { R0: { path: shared.repo, revision: revision(shared.repo) }, Rpack: { path: pack, revision: revision(pack) } };
    const roles = await local("continuity-lookup-roles"), pilot = await local("continuity-lookup-pilot");
    const { codes, protocol } = await roles.prepareLookupCodes(checkouts);
    const options = { suites: ["holdout"], lookupSource: { manifestPath: shared.context.options.manifestPath,
      manifestSha256: shared.context.options.manifestSha256, statisticalSpecPath: shared.context.options.statisticalSpecPath },
      reader: "openai-codex:gpt-6.1-sol", readerEffort: "high", selectionSeed: 42, perGroup: 2, probeLimit: 1,
      outputLimit: { source: "catalog_max", tokens: 128000 } };
    const workload = await roles.lookupWorkload({ ...options, inputRoots: [shared.repo, pack] });
    const policy = await fixtureLookupPolicy({ source: workload.corpora[0].source, selection: workload.corpora[0].traces,
      lookupSelection: workload.lookupSelection, reader: workload.reader, codes, protocol });
    const policyPath = join(shared.inputs, "lookup-policy.json"); await save(policyPath, policy);
    shared.pilot = await pilot.registerLookupPilot({ ...options, policyPath, policySha256: sha(await fs.readFile(policyPath)),
      checkouts, capUSD: 4, scheduleSeed: 1, runDeadlineMs: 3600000 });
  } finally { vi.unstubAllEnvs(); }
}, 120000);
beforeEach(async () => {
  realBefore = await snapshot(realRegistry);
  dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lookup-authorization-test-")));
  await fs.chmod(dir, 0o700); home = join(dir, "home"); await fs.mkdir(home, { mode: 0o700 });
  vi.resetModules();
  network = vi.spyOn(Socket.prototype, "connect").mockImplementation(() => { throw new Error("test_egress_denied"); });
  fetch = vi.fn(() => { throw new Error("test_egress_denied"); });
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("WebSocket", class { constructor() { throw new Error("test_egress_denied"); } });
  // In-process unit fixtures only; no production child is launched with CI removed.
  vi.stubEnv("CI", undefined); vi.stubEnv("CONTINUITY_DEBUG", undefined);
  // This is the only module mock. All filesystem, credential and registration code is real.
  vi.doMock("node:os", async original => ({ ...await original(), userInfo: () => ({ ...realUser, homedir: home }) }));
  auth = await local("continuity-lookup-authorization");
  ({ lookupPilotReadiness: readiness } = await local("continuity-lookup-roles"));
  const { lookupProcessStartIdentity } = await local("continuity-process-identity");
  identity = { runId: "fictional-run", controllerEpoch: "fictional-epoch", controller: { pid: process.pid, startIdentity: lookupProcessStartIdentity(process.pid) } };
  f = await fixture();
});
afterEach(async () => {
  try {
    expect(network).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(await snapshot(realRegistry)).toEqual(realBefore);
  } finally {
    try {
      f?.lease?.release();
    } finally {
      for (const [child, exited] of children) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; }
      children.clear();
      vi.doUnmock("node:os"); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  }
});
afterAll(async () => {
  try {
    expect(successfulConsumptions).toBeGreaterThan(0);
    expect(await snapshot(realRegistry)).toEqual(suiteRealBefore);
    if (runningUnderCI) expect(Object.hasOwn(process.env, "CI")).toBe(true);
  } finally { if (base) await fs.rm(base, { recursive: true, force: true }); }
});
// The only real-schema fixture builder is test-local, synthetic and fictional.
async function fixture() {
  const outputRoot = join(dir, "output"), credentialPath = join(dir, "fictional-credential.json");
  await fs.mkdir(outputRoot, { mode: 0o700 });
  const pilot = structuredClone(shared.pilot), { descriptor } = pilot, { codes, common } = pilot.registration, { catalog } = common;
  const registrationPath = join(dir, "registration.json"); await save(registrationPath, pilot);
  const registrationRawSha256 = sha(await fs.readFile(registrationPath));
  const salt = "c".repeat(64), account = "fictional-account";
  const artifact = { schema: auth.LOOKUP_AUTHORIZATION_SCHEMA, authorizationId: "fictional-authorization", salt,
    accountCommitment: sha(`mono-agent/lookup-pilot/account-v1\0${salt}\0${account}`), timestamp: "2030-01-01T00:00:00Z",
    approver: "Fictional Approver", numericApprovalReference: "fictional-cap-approval-4USD",
    bindings: { registrationRawSha256, registrationSha256: digest(pilot), controllerCheckout: codes.R0, codes, protocol: common.protocol,
      catalog, policy: common.policy, source: common.lookupSource, selection: common.lookupSelection, reader: common.reader, descriptor, outputRoot, credentialPath } };
  const authorizationPath = join(dir, "authorization.json"); await save(authorizationPath, artifact);
  await save(credentialPath, credential(account));
  const args = { authorizationPath, registrationPath, registrationSha256: registrationRawSha256, outputRoot, credentialPath, controllerRoot: shared.repo };
  const entry = () => join(home, ".local/state/mono-agent/lookup-pilot/consumed-v1", sha(`mono-agent/lookup-pilot/consumed-v1\0${artifact.authorizationId}`));
  const { acquireLookupPilotLease } = await local("continuity-lookup-lease");
  const lease = await acquireLookupPilotLease(outputRoot);
  return { args, artifact, pilot, account, entry, lease, marker: join(outputRoot, "authorization-consumed.json"), descriptor, catalog };
}
async function credentialSnapshot() {
  const stat = await fs.stat(f.args.credentialPath);
  return { bytes: await fs.readFile(f.args.credentialPath), ino: stat.ino, mtime: stat.mtimeMs };
}
async function unchangedCredential(action) {
  const before = await credentialSnapshot();
  try { return await action(); } finally { expect(await credentialSnapshot()).toEqual(before); }
}
const validate = () => unchangedCredential(() => auth.validateLookupAuthorization(f.args));
const consume = (handle, ident = identity, lease = f.lease) => unchangedCredential(() => auth.consumeLookupAuthorization(handle, ident, lease));
const verify = (handle, ident = identity) => unchangedCredential(() => auth.verifyLookupConsumption(handle, ident));
it("consumes a complete private synced pair, exports only allowlisted content and refuses replay", async () => {
  const handle = await validate(); expect(JSON.stringify(handle)).toBe("{}");
  expect(await consume(handle, identity)).toEqual({ consumed: true, authorizationId: "fictional-authorization" });
  expect(await verify(handle, identity)).toBe(true);
  successfulConsumptions++;
  expect((await fs.stat(f.entry())).mode & 0o777).toBe(0o700);
  for (const path of [f.marker, join(f.entry(), "claim.json")]) {
    const stat = await fs.stat(path); expect(stat.mode & 0o777).toBe(0o600); expect(stat.nlink).toBe(1);
  }
  await expect(consume(handle, identity)).rejects.toThrow("lookup_authorization_already_consumed");
  await expect(verify(handle, { ...identity, controllerEpoch: "other" })).rejects.toThrow("lookup_authorization_consumption_incomplete");
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
  const result = await Promise.allSettled(handles.map(h => consume(h, identity)));
  expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(result.filter(r => r.status === "rejected")).toHaveLength(1);
  expect(await verify(handles[0], identity)).toBe(true);
});
it("burns across output deletion/recreation and authorization rename", async () => {
  await consume(await validate(), identity);
  await fs.rm(f.args.outputRoot, { recursive: true }); await fs.mkdir(f.args.outputRoot, { mode: 0o700 });
  f.lease.release(); f.lease = await (await local("continuity-lookup-lease")).acquireLookupPilotLease(f.args.outputRoot);
  const renamed = join(dir, "renamed-authorization.json"); await fs.rename(f.args.authorizationPath, renamed); f.args.authorizationPath = renamed;
  await expect(consume(await validate(), identity)).rejects.toThrow("lookup_authorization_consumption_incomplete");
  expect(await fs.readdir(f.args.outputRoot)).toEqual(["controller-lock.sqlite"]);
});
it("rejects an alternate root, even when the artifact filename is changed", async () => {
  const alternate = join(dir, "alternate"); await fs.mkdir(alternate, { mode: 0o700 });
  const copy = join(dir, "copied-authorization.json"); await fs.copyFile(f.args.authorizationPath, copy); f.args.authorizationPath = copy;
  await expect(auth.validateLookupAuthorization({ ...f.args, outputRoot: alternate })).rejects.toThrow("lookup_authorization_binding_mismatch");
});
it.each(["empty", "corrupt", "mismatched", "extra"])("never repairs a %s registry burn", async kind => {
  await fs.mkdir(f.entry(), { recursive: true, mode: 0o700 });
  if (kind !== "empty") await fs.writeFile(join(f.entry(), "claim.json"), kind === "corrupt" ? "{" : "{}", { mode: 0o600 });
  if (kind === "extra") await save(join(f.entry(), "extra.json"), {});
  const before = await fs.readdir(f.entry());
  await expect(consume(await validate(), identity)).rejects.toThrow("lookup_authorization_consumption_incomplete");
  expect(await fs.readdir(f.entry())).toEqual(before); expect(await snapshot(f.marker)).toBeNull();
});
it.each(["marker", "units", "old-state"])("rejects reused roots with %s", async kind => {
  if (kind === "units") await fs.mkdir(join(f.args.outputRoot, "units"));
  else await save(kind === "marker" ? f.marker : join(f.args.outputRoot, "old-state.json"), {});
  await expect(consume(await validate(), identity)).rejects.toThrow(kind === "marker" ? "lookup_authorization_consumption_incomplete" : "lookup_pilot_resume_forbidden");
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
  const handle = await validate(); await consume(handle, identity);
  const path = join(f.entry(), "claim.json"), other = join(dir, "alias");
  if (kind === "symlink") { await fs.rename(path, other); await fs.symlink(other, path); }
  if (kind === "hardlink") await fs.link(path, other);
  if (kind === "public") await fs.chmod(path, 0o644);
  await expect(verify(handle, identity)).rejects.toThrow("lookup_authorization_consumption_incomplete");
});
it.each(["symlink", "public"])("rejects unsafe %s registry ancestry", async kind => {
  const path = join(home, ".local");
  if (kind === "symlink") { const other = join(dir, "other"); await fs.mkdir(other); await fs.symlink(other, path); }
  else { await fs.mkdir(path); await fs.chmod(path, 0o777); }
  await expect(consume(await validate(), identity)).rejects.toThrow("lookup_authorization_registry_unsafe");
});
it("derives the fixed registry from userInfo rather than HOME/XDG", async () => {
  vi.stubEnv("HOME", join(dir, "untrusted-home")); vi.stubEnv("XDG_STATE_HOME", join(dir, "untrusted-state"));
  await consume(await validate(), identity);
  expect(await fs.readdir(f.entry())).toEqual(["claim.json"]);
  expect(await snapshot(join(dir, "untrusted-state"))).toBeNull();
});
it.each(["codes", "protocol", "catalog", "policy", "source", "selection", "reader", "descriptor", "registrationRawSha256", "registrationSha256", "credentialPath", "outputRoot", "controllerCheckout"])("rejects %s binding substitution", async field => {
  f.artifact.bindings[field] = "fictional-substitution"; await save(f.args.authorizationPath, f.artifact);
  await expect(validate()).rejects.toThrow("lookup_authorization_binding_mismatch");
});
it("rejects account substitution but allows same-account access token rotation without refresh", async () => {
  await save(f.args.credentialPath, credential("different-fictional-account"));
  await expect(validate()).rejects.toThrow("lookup_account_mismatch");
  await save(f.args.credentialPath, credential(f.account, 2));
  const handle = await validate(); await consume(handle, identity);
  await save(f.args.credentialPath, credential(f.account, 3));
  expect(await verify(await validate(), identity)).toBe(true);
});
it("rejects faux artifacts and fabricated handles", async () => {
  f.artifact.schema = "continuity-lookup-pilot-faux-authorization-v1"; await save(f.args.authorizationPath, f.artifact);
  await expect(validate()).rejects.toThrow("lookup_authorization_invalid");
  await expect(consume({}, identity)).rejects.toThrow("lookup_authorization_required");
});
it.each(["CI", "CONTINUITY_DEBUG"])("refuses presence of %s even when empty", async key => {
  vi.stubEnv(key, ""); await expect(validate()).rejects.toThrow(key === "CI" ? "paid_mode_refused_in_ci" : "lookup_debug_forbidden");
});

it("burns the same ID after reserialization and output deletion, even though its raw digest changes", async () => {
  await consume(await validate(), identity);
  await fs.rm(f.args.outputRoot, { recursive: true }); await fs.mkdir(f.args.outputRoot, { mode: 0o700 });
  f.lease.release(); f.lease = await (await local("continuity-lookup-lease")).acquireLookupPilotLease(f.args.outputRoot);
  await fs.writeFile(f.args.authorizationPath, `${JSON.stringify(f.artifact, null, 2)}\n`, { mode: 0o600 });
  await expect(consume(await validate(), identity)).rejects.toThrow("lookup_authorization_already_consumed");
  expect(await fs.readdir(f.args.outputRoot)).toEqual(["controller-lock.sqlite"]);
});
it("binds the live controller PID/start identity, and consumes before children can launch", async () => {
  const handle = await validate();
  await expect(consume(handle, { ...identity, controller: { ...identity.controller, startIdentity: "substituted" } })).rejects.toThrow("lookup_authorization_invalid");
  await consume(handle, identity);
  const claim = JSON.parse(await fs.readFile(f.marker, "utf8"));
  expect(claim.controller).toEqual(identity.controller); expect(claim).not.toHaveProperty("nonceCommitment");
});

it("runs the real pilot registration validator without a module substitute", async () => {
  const actual = await local("continuity-lookup-pilot");
  expect(await actual.validateLookupPilotRegistration(f.pilot)).toBe(f.pilot);
});
it.each(["output", "credential"])("rejects a symlinked %s location", async kind => {
  const key = kind === "output" ? "outputRoot" : "credentialPath", path = f.args[key], other = join(dir, "alias-target");
  await fs.rename(path, other); await fs.symlink(other, path);
  await expect(validate()).rejects.toThrow("lookup_authorization_binding_mismatch");
});
it("revalidates the attestation and account immediately before writing a burn", async () => {
  const handle = await validate();
  await save(f.args.credentialPath, credential("substituted-fictional-account"));
  await expect(consume(handle, identity)).rejects.toThrow("lookup_account_mismatch");
  expect(await snapshot(f.entry())).toBeNull();
});

it("refuses a foreign live PID even with a real local lease", async () => {
  const { lookupProcessStartIdentity } = await local("continuity-process-identity");
  await expect(consume(await validate(), { ...identity, controller: { pid: process.ppid, startIdentity: lookupProcessStartIdentity(process.ppid) } })).rejects.toThrow("lookup_authorization_invalid");
});
it("refuses verification before any consumption", async () => {
  await expect(verify(await validate())).rejects.toThrow("lookup_authorization_consumption_incomplete");
});
it("requires the controller checkout actually executing the module, not a caller-selected checkout", async () => {
  for (const controllerRoot of [worktree, f.pilot.registration.codes.Rpack.path, dir])
    await expect(auth.validateLookupAuthorization({ ...f.args, controllerRoot })).rejects.toThrow("lookup_authorization_binding_mismatch");
});
it("refuses an output inside either registered checkout before inspecting its contents", async () => {
  for (const code of Object.values(f.pilot.registration.codes))
    await expect(auth.validateLookupAuthorization({ ...f.args, outputRoot: code.path })).rejects.toThrow("lookup_authorization_binding_mismatch");
});
it("refuses registry/output overlap before creating any registry segments", async () => {
  // The mocked home is temporary; this cannot target the real user's registry.
  home = f.args.outputRoot;
  await expect(consume(await validate())).rejects.toThrow("lookup_authorization_registry_unsafe");
  expect(await snapshot(join(home, ".local"))).toBeNull();
});
it.each(["marker-two-links", "pending"])("never adopts a crash leftover: %s", async kind => {
  if (kind === "marker-two-links") {
    await consume(await validate());
    await fs.link(f.marker, join(f.args.outputRoot, "authorization-consumed.json.fictional.pending"));
    await expect(verify(await validate())).rejects.toThrow("lookup_authorization_consumption_incomplete");
  } else await save(join(f.args.outputRoot, "authorization-consumed.json.fictional.pending"), {});
  await expect(consume(await validate())).rejects.toThrow(kind === "pending" ? "lookup_pilot_resume_forbidden" : "lookup_authorization_consumption_incomplete");
});
it("ties verification to the original root and lease inodes even if the marker is copied back", async () => {
  const handle = await validate(); await consume(handle);
  const marker = await fs.readFile(f.marker), directory = await fs.open(f.args.outputRoot, "r");
  try {
    await fs.rm(f.args.outputRoot, { recursive: true }); await fs.mkdir(f.args.outputRoot, { mode: 0o700 });
    f.lease.release(); f.lease = await (await local("continuity-lookup-lease")).acquireLookupPilotLease(f.args.outputRoot);
    await fs.writeFile(f.marker, marker, { mode: 0o600 });
    await expect(verify(await validate())).rejects.toThrow("lookup_authorization_consumption_incomplete");
  } finally { await directory.close(); }
});
it.each(["absent", "fabricated", "released"])("refuses a %s lease handle", async kind => {
  const handle = await validate();
  if (kind === "released") f.lease.release();
  await expect(consume(handle, identity, kind === "absent" ? null : kind === "fabricated" ? {} : f.lease)).rejects.toThrow("lookup_authorization_lease_invalid");
  expect(await snapshot(f.entry())).toBeNull();
});
it.each(["empty", "unrelated"])("does not treat an %s lock filename as a held lease", async kind => {
  f.lease.release(); await fs.unlink(join(f.args.outputRoot, "controller-lock.sqlite"));
  await fs.writeFile(join(f.args.outputRoot, "controller-lock.sqlite"), kind === "empty" ? "" : "unrelated file", { mode: 0o600 });
  const { acquireLookupPilotLease } = await local("continuity-lookup-lease");
  await expect(acquireLookupPilotLease(f.args.outputRoot)).rejects.toThrow("lookup_authorization_lease_invalid");
  await expect(consume(await validate(), identity, {})).rejects.toThrow("lookup_authorization_lease_invalid");
});
it("uses a locale/time-zone-independent lookup process identity", async () => {
  const { lookupProcessStartIdentity } = await local("continuity-process-identity");
  const expected = lookupProcessStartIdentity(process.pid);
  vi.stubEnv("TZ", "Pacific/Honolulu"); vi.stubEnv("LC_ALL", "fictional_invalid_locale");
  expect(lookupProcessStartIdentity(process.pid)).toBe(expected);
});
it("reads and validates a real pilot registration through its public reader", async () => {
  const { readLookupPilotRegistration, registerLookupPilot } = await local("continuity-lookup-pilot");
  expect(await readLookupPilotRegistration(f.args.registrationPath, f.args.registrationSha256)).toEqual(f.pilot);
  await expect(readLookupPilotRegistration(f.args.registrationPath, "a".repeat(64))).rejects.toThrow("lookup_registration_hash_mismatch");
  await expect(registerLookupPilot({ suites: ["original"], capUSD: 4, scheduleSeed: 1, runDeadlineMs: 1000 })).rejects.toThrow("incompatible_lookup_registration");
});

async function leaseChild(mode, { outputRoot = f.args.outputRoot, controller = identity.controller } = {}) {
  const child = fork(fileURLToPath(new URL("./fixtures/continuity-lookup-lease-child.mjs", import.meta.url)), [], {
    cwd: shared.repo, execArgv: ["--no-warnings"], env: { ...process.env, CI: "1", HOME: home }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let exitedResolve, replyResolve, replyReject, receiptSeen = false;
  const exited = new Promise(resolve => { exitedResolve = resolve; });
  const reply = new Promise((resolve, reject) => { replyResolve = resolve; replyReject = reject; });
  const watchdog = setTimeout(() => { child.kill("SIGKILL"); replyReject(new Error("lease_child_watchdog")); }, 7500);
  children.set(child, exited);
  child.once("error", error => { replyReject(error); exitedResolve(); clearTimeout(watchdog); });
  child.once("exit", (code, signal) => {
    clearTimeout(watchdog); exitedResolve({ code, signal });
    if (!receiptSeen) replyReject(new Error("lease_child_exited_before_receipt"));
  });
  child.on("message", message => {
    if (message.ready) child.send({ mode, moduleRoot: shared.repo, outputRoot, controller });
    else { receiptSeen = true; replyResolve(message); }
  });
  const receipt = await reply;
  expect(receipt).toMatchObject({ egressDenied: true, egressAttempts: 0 });
  if (mode !== "hold") expect(await exited).toEqual({ code: 0, signal: null });
  return { child, exited, receipt };
}
it("preserves the OS writer lock after consumption and repeated assertions, visible to real child processes", async () => {
  const handle = await validate(); await consume(handle);
  const lease = await local("continuity-lookup-lease");
  for (let i = 0; i < 4; i++) await lease.assertLookupPilotLease(f.lease, f.args.outputRoot, identity.controller);
  const reader = await leaseChild("read");
  const claim = JSON.parse(await fs.readFile(f.marker, "utf8"));
  expect(reader.receipt).toMatchObject({ ok: true, binding: { outputIdentity: claim.outputIdentity, leaseIdentity: claim.leaseIdentity } });
  expect((await leaseChild("probe")).receipt).toMatchObject({ ok: true, busy: true });
  await verify(handle);
  expect((await leaseChild("probe")).receipt).toMatchObject({ ok: true, busy: true });
});
it("refuses child reads and parent verification after the live controller releases its writer transaction", async () => {
  const handle = await validate(); await consume(handle); f.lease.release();
  expect((await leaseChild("read")).receipt).toMatchObject({ ok: false, code: "lookup_authorization_lease_invalid" });
  await expect(verify(handle)).rejects.toThrow("lookup_authorization_lease_invalid");
  expect((await leaseChild("probe")).receipt).toMatchObject({ ok: true, busy: false });
});
it("refuses lease reads after a real controller child is killed and reaped", async () => {
  const outputRoot = join(dir, "child-controller"); await fs.mkdir(outputRoot, { mode: 0o700 });
  const holder = await leaseChild("hold", { outputRoot }); expect(holder.receipt.ok).toBe(true);
  const controller = holder.receipt.controller;
  expect((await leaseChild("read", { outputRoot, controller })).receipt.ok).toBe(true);
  holder.child.kill("SIGKILL"); expect(await holder.exited).toEqual({ code: null, signal: "SIGKILL" });
  expect((await leaseChild("read", { outputRoot, controller })).receipt).toMatchObject({ ok: false, code: "lookup_authorization_lease_invalid" });
});
it("refuses a valid-schema crash-leftover SQLite lease naming a known dead child PID", async () => {
  const identityChild = await leaseChild("identity"), controller = identityChild.receipt.controller;
  const outputRoot = join(dir, "crash-leftover"); await fs.mkdir(outputRoot, { mode: 0o700 });
  const path = join(outputRoot, "controller-lock.sqlite"), db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE lookup_controller (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, start_identity TEXT NOT NULL)");
    db.prepare("INSERT INTO lookup_controller VALUES (1, ?, ?)").run(controller.pid, controller.startIdentity);
  } finally { db.close(); }
  await fs.chmod(path, 0o600);
  expect((await leaseChild("read", { outputRoot, controller })).receipt).toMatchObject({ ok: false, code: "lookup_authorization_lease_invalid" });
});
it.each(["named", "hardlink", "renamed"])("rejects %s lease aliases before authorization reads without dropping the OS lock", async kind => {
  await consume(await validate());
  const path = join(f.args.outputRoot, "controller-lock.sqlite"), alias = join(dir, "lease-alias.json");
  if (kind === "hardlink") await fs.link(path, alias);
  if (kind === "renamed") await fs.rename(path, alias);
  await expect(auth.validateLookupAuthorization({ ...f.args, authorizationPath: kind === "named" ? path : alias })).rejects.toThrow("lookup_unsafe_authorization_file");
  if (kind === "hardlink") await fs.unlink(alias);
  if (kind === "renamed") await fs.rename(alias, path);
  expect((await leaseChild("probe")).receipt).toMatchObject({ ok: true, busy: true });
});
