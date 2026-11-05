import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { constants } from "node:fs";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { access, appendFile, cp, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { digest, loadTraces, makePlan, traceTokenShape } from "../lib/continuity-dataset.mjs";
import { BUILD_POLICY, verifyRealBuild } from "../lib/memory-e2e-build.mjs";
import { LOOKUP_MODE, LOOKUP_ROLES, LOOKUP_SOULS, LOOKUP_BUDGET, sha256 } from "../lib/continuity-lookup.mjs";
import { ROOT, GUIDANCE_FILES, LOOKUP_PILOT_PROTOCOL_FILES, lookupProtocol, lookupWorkload, registerLookup, validateRegistration, guidanceDiff, roleBinding, rolePlan,
  verifyRoleRequest, roleReceipt, assertRoleReceipt, aggregateLookupRoles, aggregateRoleFiles, runLookupRoles, runLookupRoleChild, verifyRegisteredCheckouts } from "../lib/continuity-lookup-roles.mjs";
import { main as benchmarkMain } from "../continuity-benchmark.mjs";
import { main as compareMain, lookupOutputPath, workloadOptions, WORKLOAD_FLAGS } from "../continuity-lookup-compare.mjs";
import { main as budgetMain } from "../continuity-lookup-budget.mjs";
import { main as estimateMain, estimateLookup, ESTIMATE_PROFILES, offlinePrices, priceLookupCall } from "../continuity-lookup-estimate.mjs";

import { dependencySnapshot } from "./fixtures/lookup-dependency-witness.mjs";
const dirs = [];
let suiteModulesBefore;
beforeAll(async () => { suiteModulesBefore = await dependencySnapshot(ROOT); expect(suiteModulesBefore).toMatchObject({ directory: true, vitest: true }); });
afterAll(async () => { expect(await dependencySnapshot(ROOT)).toEqual(suiteModulesBefore); });
beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) vi.stubEnv(key, undefined);
  for (const prefix of ["npm_config", "pnpm_config"]) {
    vi.stubEnv(`${prefix}_offline`, "true"); vi.stubEnv(`${prefix}_verify_deps_before_run`, "false");
    vi.stubEnv(`${prefix}_manage_package_manager_versions`, "false");
  }
  vi.stubEnv("COREPACK_ENABLE_NETWORK", "0");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null"); vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("NODE_OPTIONS", `${process.env.NODE_OPTIONS ?? ""} --import=${join(ROOT, "scripts/__tests__/fixtures/reject-account-home.mjs")}`);
});
// Removing two built synthetic checkouts can exceed the default hook budget on loaded runners.
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); }, 120_000);
const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fictional Fixture", GIT_AUTHOR_EMAIL: "fiction@example.invalid",
  GIT_COMMITTER_NAME: "Fictional Fixture", GIT_COMMITTER_EMAIL: "fiction@example.invalid" });
const git = (root, args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-C", root, ...args],
  { env: gitEnv(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
const RENDER = "packages/conversation/src/continuity/render-fit.ts", PACK = "packages/conversation/src/continuity/pack.ts";
const guidance = 'export const PACK_RETRIEVAL_GUIDANCE = "Fictional guidance";\n';
async function scratch() { const base = join(ROOT, ".worklab-tmp"); await mkdir(base, { recursive: true }); const dir = await mkdtemp(join(base, "lookup-roles-")); dirs.push(dir); return dir; }
function commit(root) { git(root, ["add", "--all"]); git(root, ["-c", "user.name=Fictional Fixture", "-c", "user.email=fiction@example.invalid", "commit", "-m", "test: fictional checkout"]); return git(root, ["rev-parse", "HEAD"]); }
async function tinyRepo(base, name, files) {
  const root = join(base, name); await mkdir(root); git(root, ["init"]);
  for (const [path, value] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value); }
  commit(root); return root;
}
async function registrationFixture() {
  const first = (await loadTraces()).traces[0];
  const common = { protocol: await lookupProtocol(), ...await lookupWorkload({ suites: ["original"], traceIds: [first.id], probeLimit: 2 }) };
  const build = revision => ({ policy: BUILD_POLICY, sourceHead: revision, command: ["pnpm", "--filter", "@mono-agent/app...", "run", "build"],
    packages: ["packages/app"], outputRoots: ["packages/app/dist"], outputSha256: "c".repeat(64), node: process.version });
  const codes = { R0: { path: "/fictional/r0", revision: "a".repeat(40), build: build("a".repeat(40)) }, Rpack: { path: "/fictional/rpack", revision: "b".repeat(40), build: build("b".repeat(40)) } };
  return { schema: "continuity-lookup-registration-v1", purpose: "offline-mechanics-only-not-ledger-qualification", common, codes, diffFiles: [RENDER],
    roles: LOOKUP_ROLES.map(def => ({ id: def.id, arm: def.arm, code: def.code, revision: codes[def.code].revision, buildHash: codes[def.code].build.outputSha256, soul: LOOKUP_SOULS[def.soul] })) };
}

async function artifactRole(reg, output, id, receipt = true) {
  const role = reg.roles.find(r => r.id === id), corpus = reg.common.corpora[0], trace = corpus.traces[0];
  const binding = roleBinding(reg, role, corpus), plan = await rolePlan(reg.common, binding);
  const dir = join(output, id, corpus.suite); await mkdir(join(dir, "units"), { recursive: true });
  const unit = { confirmation: plan.confirmation, executionKind: "offline", arm: role.arm, repeat: 1, traceId: trace.id,
    manifest: { codeRevision: role.revision, dirty: false, buildPolicy: BUILD_POLICY, lookupRole: binding },
    trials: trace.probes.map(probeId => ({ traceId: trace.id, probeId, arm: role.arm, repeat: 1, status: "completed", lookup: { exactAccuracy: true } })) };
  const bytes = JSON.stringify(unit); await writeFile(join(dir, "units/unit.json"), bytes);
  const request = { binding, build: reg.codes[role.code].build };
  const results = { plan, executionKind: "offline", qualityMeasured: false, ...(receipt ? { lookupReceipt: roleReceipt(request, plan, [sha256(bytes)]) } : {}) };
  await writeFile(join(dir, "results.json"), JSON.stringify(results)); return dir;
}

async function overlaySource(source, dest, paths) {
  for (const path of paths) {
    try { await lstat(join(source, path)); }
    catch (error) { if (error.code !== "ENOENT") throw error; await rm(join(dest, path), { recursive: true, force: true }); continue; }
    await mkdir(dirname(join(dest, path)), { recursive: true }); await cp(join(source, path), join(dest, path));
  }
}

// Private installation metadata and workspace links; immutable third-party package
// leaves may be read through links. Builds never install or mutate these leaves.
async function linkDependencies(source, dest) {
  async function copyModules(rel) {
    const from = join(source, rel), to = join(dest, rel);
    try { await access(from); } catch { return; }
    expect((await lstat(from)).isDirectory()).toBe(true);
    await mkdir(to, {recursive: true});
    for (const name of await readdir(from)) {
      if ([".cache", ".vite"].includes(name)) continue;
      if (name === ".pnpm") {
        await mkdir(join(to, name));
        for (const leaf of await readdir(join(from, name))) {
          const input = join(from, name, leaf), output = join(to, name, leaf);
          if (leaf !== "node_modules" && (await lstat(input)).isDirectory()) await symlink(input, output);
          else await cp(input, output, {recursive: true, dereference: false, verbatimSymlinks: true});
        }
      } else await cp(join(from, name), join(to, name), {recursive: true, dereference: false, verbatimSymlinks: true});
    }
  }
  await copyModules("node_modules");
  for (const parent of ["packages", "extras"]) for (const name of await readdir(join(source, parent))) await copyModules(join(parent, name, "node_modules"));
  await copyModules("packages/web/webapp/node_modules");
}

async function externalEstimateFixture() {
  const selection = [{ id: "fixture-selected", family: "long", toolRecords: 64, probes: ["p01", "p04"] }];
  const source = { kind: "lookup-frozen-holdout", manifestSha256: "d".repeat(64), statisticalSpecSha256: "e".repeat(64) };
  const { fixtureLookupPolicy } = await import("./fixtures/holdout-synthetic.mjs");
  const policy = await fixtureLookupPolicy({ source, selection });
  const workload = { lookupSource: { manifestPath: "/fictional/manifest.json", manifestSha256: source.manifestSha256, statisticalSpecPath: "/fictional/spec.json" },
    policy, reader: { model: "fixture:reader", effort: "low" }, repeats: 1, corpora: [{ suite: "holdout", source, traces: selection }] };
  const catalog = { model: workload.reader.model, fileSha256: "c".repeat(64), contextWindow: 300000, maxTokens: 10000,
    cost: { input: 2, output: 10, cacheRead: .2, tiers: [{ inputTokensAbove: 272000, input: 4, output: 20, cacheRead: .4 }] } };
  return { workload, catalog, outputLimit: { tokens: 10000, source: "catalog_max" } };
}

const externalOnlyOptions = [
  ["--selection-seed", "42"], ["--per-group", "2"],
  ["--lookup-policy", "/fictional/policy.json"], ["--lookup-policy-sha256", "a".repeat(64)],
  ["--output-limit", "300"], ["--output-limit-source", "enforced"], ["--catalog-cap-usd", "10"],
];

it("runs all six faux/real-loopback roles across two clean synthetic checkouts with fresh builds and bound receipts", async () => {
  const base = await scratch(), r0 = join(base, "r0"), rpack = join(base, "rpack");
  const home = join(base, "home"); await mkdir(home, { mode: 0o700 });
  vi.stubEnv("XDG_DATA_HOME", join(base, "fictional-host-data"));
  for (const key of ["HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) vi.stubEnv(key, home);
  expect(process.env.XDG_DATA_HOME).toBe(home);
  git(ROOT, ["clone", "--shared", "--quiet", ROOT, r0]);
  // Include this uncommitted implementation in the synthetic source commit; never change ROOT HEAD.
  const overlay = new Set([...git(ROOT, ["diff", "--name-only", "HEAD"]).split("\n"), ...git(ROOT, ["ls-files", "--others", "--exclude-standard"]).split("\n")].filter(Boolean));
  await overlaySource(ROOT, r0, overlay);
  // Synthetic R0 has no retrieval clause; Rpack restores the actual runtime guidance.
  const shippedRender = await readFile(join(ROOT, RENDER), "utf8"), shippedPack = await readFile(join(ROOT, PACK), "utf8");
  await writeFile(join(r0, RENDER), shippedRender.replace(/^export const PACK_RETRIEVAL_GUIDANCE = .*;$/mu, 'export const SYNTHETIC_NO_GUIDANCE = "";'));
  await writeFile(join(r0, PACK), shippedPack.replaceAll("PACK_RETRIEVAL_GUIDANCE", "SYNTHETIC_NO_GUIDANCE"));
  // Already-installed private dependencies suffice; never run an install in a test build.
  const webPackagePath = join(r0, "packages/web/package.json"), webPackage = JSON.parse(await readFile(webPackagePath, "utf8"));
  expect(webPackage.scripts.build.startsWith("pnpm --dir webapp install --frozen-lockfile && ")).toBe(true);
  webPackage.scripts.build = webPackage.scripts.build.replace("pnpm --dir webapp install --frozen-lockfile && ", "");
  await writeFile(webPackagePath, JSON.stringify(webPackage, null, 2) + "\n");
  // Both build workspaces forbid dependency verification/install, even under pnpm 11.
  await writeFile(join(r0, ".npmrc"), "offline=true\nverify-deps-before-run=false\nmanage-package-manager-versions=false\n");
  const r0Revision = commit(r0);
  git(ROOT, ["clone", "--shared", "--quiet", r0, rpack]);
  await writeFile(join(rpack, RENDER), shippedRender); await writeFile(join(rpack, PACK), shippedPack); const rpackRevision = commit(rpack);
  await linkDependencies(ROOT, r0); await linkDependencies(ROOT, rpack);
  const trace = (await loadTraces()).traces[0];
  const registration = await registerLookup({ checkouts: { R0: { path: r0, revision: r0Revision }, Rpack: { path: rpack, revision: rpackRevision } },
    suites: ["original"], traceIds: [trace.id], probeLimit: 1 });
  expect(registration.diffFiles).toEqual([PACK, RENDER]);
  expect(() => guidanceDiff(rpack, r0)).toThrow("lookup_rpack_direction_invalid");
  expect(registration.codes.R0.build.policy).toBe(BUILD_POLICY);
  const output = join(base, "run"); let dispatches = 0;
  const launch = async (root, args, timeoutMs, first) => {
    if (!first) return runLookupRoleChild(root, args, timeoutMs);
    // A real nonzero process exit AFTER main emitted a valid receipt must not stop later roles.
    const program = `const {main} = await import(${JSON.stringify(new URL("scripts/continuity-benchmark.mjs", `file://${root}/`).href)}); await main(${JSON.stringify(args)}); process.exit(1);`;
    const wrapper = join(base, "nonzero-after-receipt.mjs"); await writeFile(wrapper, program);
    // Match the launcher's file/async process shape; eval/synchronous invocation
    // interferes with native in-place replay and is not the production entry path.
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [wrapper], { cwd: root, stdio: ["ignore", "ignore", "pipe"] }); child.stderr.resume();
      let timedOut = false; const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); resolve({ code, timedOut }); });
    });
  };
  const jobs = new Map(); let result;
  try {
    result = await runLookupRoles(registration, output, {dispatch: async (root, args, timeoutMs) => {
      dispatches++;
      if (!jobs.size) {
        const requestPath = args[args.indexOf("--lookup-role") + 1], firstOutput = args[args.indexOf("--output") + 1];
        const original = JSON.parse(await readFile(requestPath));
        for (const role of registration.roles) {
          const binding = roleBinding(registration, role, registration.common.corpora[0]);
          const code = registration.codes[role.code], parent = join(output, role.id);
          await mkdir(parent, {recursive: true, mode: 0o700});
          const path = join(parent, `${binding.scope.suite}-request.json`), dir = join(parent, binding.scope.suite);
          const request = {...original, binding, build: code.build}; await writeFile(path, JSON.stringify(request));
          const argv = args.map(value => value === requestPath ? path : value === firstOutput ? dir : value === original.binding.arm ? role.arm : value);
          const plan = await rolePlan(registration.common, binding), deadline = plan.limits.maxLiveTurns * plan.lookup.childWatchdogMs + 300000;
          const outcome = launch(code.path, argv, deadline, role.id === registration.roles[0].id).catch(error => ({error}));
          jobs.set(role.id, {root: code.path, argv, deadline, request, outcome});
        }
      }
      const request = JSON.parse(await readFile(args[args.indexOf("--lookup-role") + 1])), job = jobs.get(request.binding.id);
      expect(request).toEqual(job.request);
      expect({root, args, timeoutMs}).toEqual({root: job.root, args: job.argv, timeoutMs: job.deadline});
      const outcome = await job.outcome; if (outcome.error) throw outcome.error; return outcome;
    }});
  } finally {await Promise.allSettled([...jobs.values()].map(job => job.outcome));}
  expect(dispatches).toBe(6);
  expect(result.launches[0]).toMatchObject({ role: "native", exitCode: 1, receiptVerified: true, reason: null });
  expect(result.coverage, JSON.stringify(result.slots)).toEqual({ planned: 6, completed: 6, skipped: 0, blocked: 0, missing: 0, duplicate: 0, observations: 6 });
  expect(result.slots.map(s => s.role)).toEqual(LOOKUP_ROLES.map(r => r.id));
  expect(result.slots.every(s => s.calls > 0 && s.bytes > 0)).toBe(true);
  for (const role of registration.roles) {
    const aggregate = JSON.parse(await readFile(join(output, role.id, "original/results.json")));
    expect(aggregate.inventory.traces.map(row => row.id)).toEqual([trace.id]);
    expect(aggregate.coverage).toEqual({ unitsComplete: 1, unitsExpected: 1 });
    expect(aggregate.summary.lookup.arms[role.arm]).toMatchObject({ planned: 1, statuses: { completed: 1 } });
    expect(aggregate.summary.lookup.slots.map(slot => [slot.traceId, slot.probeId])).toEqual([[trace.id, trace.probes[0].id]]);
  }
  const request = JSON.parse(await readFile(join(output, "native/original-request.json")));
  for (const [mutate, code] of [
    [r => { r.binding.revision = "0".repeat(40); }, "lookup_role_scope_mismatch"],
    [r => { r.build.outputSha256 = "0".repeat(64); }, "lookup_build_binding_mismatch"],
    [r => { r.binding.soul = LOOKUP_SOULS.S1; }, "lookup_role_binding_mismatch"],
    [r => { r.binding.arm = "continuity-pack-cold"; }, "lookup_role_binding_mismatch"],
  ]) {
    const changed = structuredClone(request); mutate(changed);
    const path = join(base, "rejected-request.json"); await writeFile(path, JSON.stringify(changed));
    const rejected = spawnSync(process.execPath, [join(r0, "scripts/continuity-benchmark.mjs"), "--probe-mode", LOOKUP_MODE, "--lookup-role", path,
      "--arms", "native-lookup", "--no-judge", "--probe-limit", "1", "--output", join(base, "must-not-dispatch")], { cwd: r0, encoding: "utf8" });
    expect(rejected.status).toBe(1); expect(rejected.stderr).toContain(code);
    await expect(access(join(base, "must-not-dispatch"))).rejects.toMatchObject({ code: "ENOENT" });
  }
  const unitDir = join(output, "pack", "original", "units"), [name] = await readdir(unitDir);
  const original = await readFile(join(unitDir, name));
  await writeFile(join(unitDir, "duplicate.json"), original);
  const duplicated = await aggregateRoleFiles(registration, output);
  expect(duplicated.coverage.duplicate).toBe(1);
  await rm(join(unitDir, "duplicate.json"));
  const wrong = JSON.parse(original); wrong.manifest.codeRevision = "0".repeat(40);
  await writeFile(join(unitDir, name), JSON.stringify(wrong));
  await expect(aggregateRoleFiles(registration, output)).rejects.toThrow("lookup_role_unit_receipt_mismatch");
  await writeFile(join(unitDir, name), original);
  const changedPayload = JSON.parse(original); changedPayload.trials[0].lookup.calls += 1;
  await writeFile(join(unitDir, name), JSON.stringify(changedPayload));
  await expect(aggregateRoleFiles(registration, output)).rejects.toThrow("lookup_role_unit_digest_mismatch");
  await writeFile(join(unitDir, name), original);
  const appDist = join(r0, "packages/app/dist/index.js"), saved = await readFile(appDist);
  await appendFile(appDist, "\n// Fictional stale build\n");
  await expect(verifyRegisteredCheckouts(registration)).rejects.toThrow("build_output_changed");
  await writeFile(appDist, saved); await verifyRealBuild(r0, registration.codes.R0.build);
  // Explicit missing role: never silently substitute a different checkout or role.
  await rm(join(output, "shipping"), { recursive: true });
  expect((await aggregateRoleFiles(registration, output)).coverage.missing).toBe(1);
}, 900000);
