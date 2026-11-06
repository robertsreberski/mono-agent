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

it("pins ordinary A1 plan bytes in addition to the existing three recall-only digest tests", async () => {
  const plan = makePlan({ ...await loadTraces(), probeMode: LOOKUP_MODE, codeRevision: "a".repeat(40), profile: { judge: null } });
  expect(digest(plan)).toBe("48d89ea070e196d4c320041e451e79eb2bd0782dd1b36d41d00fce588d5db978");
  expect(plan.lookup).not.toHaveProperty("role");
});

it("pins the frozen post-routing S1 raw/core digests independently of future defaults, distinct from S0", async () => {
  const bytes = await readFile(join(ROOT, "scripts/fixtures/continuity-soul-v2.md"));
  expect(sha256(bytes.toString("utf8").replace(/\r\n?/gu, "\n").trim())).toBe(LOOKUP_SOULS.S1.coreSha256);
  expect(sha256(bytes)).toBe("e625bc0ddb256f336ec66bf94335d260396fa2c5139e37d44f8e0370fef808a9");
  expect(LOOKUP_SOULS.S1.coreSha256).toBe(LOOKUP_SOULS.S1.rawSha256);
  expect(LOOKUP_SOULS.S0.rawSha256).not.toBe(LOOKUP_SOULS.S1.rawSha256);
  const work = await scratch();
  const { installSoul } = await import("../lib/continuity-lookup.mjs");
  const { loadContextFromFiles } = await import("../../packages/conversation/dist/context/file-loader.js");
  await installSoul(work, LOOKUP_SOULS.S1); await writeFile(join(work, "IDENTITY.md"), "Fictional benchmark agent.");
  const context = await loadContextFromFiles({ identityPath: join(work, "IDENTITY.md"), soulPath: join(work, "BENCHMARK-SOUL.md"), userMessage: "Check." });
  expect(sha256(context.sections.find(s => s.id === "core").content)).toBe(LOOKUP_SOULS.S1.coreSha256);
});

it("fails module loading when the frozen S1 fixture bytes drift", async () => {
  const base = await scratch(); await mkdir(join(base, "lib")); await mkdir(join(base, "fixtures"));
  const module = join(base, "lib/continuity-lookup.mjs"); await cp(join(ROOT, "scripts/lib/continuity-lookup.mjs"), module);
  for (const file of ["continuity-soul-v1.md", "continuity-soul-v2.md", "continuity-lookup-budget-v1.json"]) await cp(join(ROOT, "scripts/fixtures", file), join(base, "fixtures", file));
  expect(spawnSync(process.execPath, [module]).status).toBe(0);
  const fixture = join(base, "fixtures/continuity-soul-v2.md"), original = await readFile(fixture, "utf8");
  for (const changed of [original + "\n", "Fictional drift\n" + original]) {
    await writeFile(fixture, changed);
    const child = spawnSync(process.execPath, [module], { encoding: "utf8" });
    expect(child.status).toBe(1); expect(child.stderr).toContain("lookup_soul_digest_mismatch");
  }
});

it("rejects checkout-local registration/run outputs through existing ancestors and symlinks before work", async () => {
  const base = await scratch(), r0 = join(base, "r0"), rpack = join(base, "rpack");
  await mkdir(r0); await mkdir(rpack); await symlink(r0, join(base, "alias"), "dir");
  const reg = await registrationFixture(); reg.codes.R0.path = r0; reg.codes.Rpack.path = rpack;
  const file = join(base, "registration.json"), bytes = JSON.stringify(reg); await writeFile(file, bytes);
  const args = ["register", "--r0", r0, "--r0-revision", reg.codes.R0.revision, "--rpack", rpack, "--rpack-revision", reg.codes.Rpack.revision];
  for (const output of [r0, join(r0, "new/missing/output"), join(rpack, "new"), join(base, "alias/new/missing/output")]) {
    await expect(compareMain([...args, "--output", output])).rejects.toThrow("lookup_output_inside_checkout");
    await expect(compareMain(["run", "--registration", file, "--sha256", sha256(bytes), "--output", output])).rejects.toThrow("lookup_output_inside_checkout");
  }
  const existing = join(base, "existing"); await mkdir(existing);
  // These are deliberately not Git checkouts: reaching registerLookup would fail differently.
  await expect(compareMain([...args, "--output", existing])).rejects.toThrow("lookup_output_exists");
  expect(await readdir(existing)).toEqual([]); expect(await readdir(r0)).toEqual([]); expect(await readdir(rpack)).toEqual([]);
  expect(await lookupOutputPath(join(base, "r0-sibling/new"), [r0, rpack])).toBe(join(base, "r0-sibling/new"));
});

it("rejects explicit empty reader and reader-effort instead of selecting defaults", async () => {
  const base = await scratch();
  for (const flag of ["--reader", "--reader-effort"]) for (const value of ["", " "]) {
    await expect(compareMain(["register", flag, value, "--output", join(base, "unused")])).rejects.toThrow("lookup_empty_reader_option");
  }
  await expect(access(join(base, "unused"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects wrong bound revisions, arms, builds, souls, receipts and protocol/lockfile bindings", async () => {
  const reg = await registrationFixture(), role = reg.roles.find(r => r.id === "shipping"), binding = roleBinding(reg, role, reg.common.corpora[0]);
  const loaded = await loadTraces();
  const dir = await scratch(), missing = join(dir, "missing-role.json"); await writeFile(missing, "null");
  await expect(benchmarkMain(["--probe-mode", LOOKUP_MODE, "--lookup-role", missing])).rejects.toThrow("lookup_role_request_mismatch");
  expect(() => makePlan({ ...loaded, probeMode: LOOKUP_MODE, lookupRole: binding, codeRevision: "e".repeat(40), arms: [role.arm] })).toThrow("lookup_role_scope_mismatch");
  expect(() => makePlan({ ...loaded, probeMode: LOOKUP_MODE, lookupRole: { ...binding, soul: LOOKUP_SOULS.S0 }, codeRevision: role.revision, arms: [role.arm] })).toThrow("lookup_role_binding_mismatch");
  expect(() => makePlan({ ...loaded, probeMode: LOOKUP_MODE, lookupRole: binding, codeRevision: role.revision, arms: ["native-lookup"] })).toThrow("lookup_role_arm_mismatch");
  const plan = await rolePlan(reg.common, binding), request = { schema: "lookup-role-request-v1", binding, common: reg.common, build: reg.codes.Rpack.build };
  await expect(verifyRoleRequest(ROOT, { ...request, build: { ...request.build, outputSha256: "d".repeat(64) } }, plan)).rejects.toThrow("lookup_build_binding_mismatch");
  const receipt = roleReceipt(request, plan), results = { plan, lookupReceipt: receipt, executionKind: "offline", qualityMeasured: false };
  expect(() => assertRoleReceipt(results, request, plan)).not.toThrow();
  for (const changed of [{ ...receipt, binding: { ...binding, revision: "d".repeat(40) } }, { ...receipt, binding: { ...binding, soul: LOOKUP_SOULS.S0 } }, { ...receipt, build: { ...request.build, outputSha256: "d".repeat(64) } }, null]) {
    expect(() => assertRoleReceipt({ ...results, lookupReceipt: changed }, request, plan)).toThrow("lookup_role_receipt_mismatch");
  }
  const wrong = structuredClone(reg); wrong.common.protocol.lockfileSha256 = "0".repeat(64);
  await expect(validateRegistration(wrong)).rejects.toThrow("lookup_registration_protocol_mismatch");
  const { validateRegistrationVersion } = await import("../lib/continuity-holdout-registration.mjs");
  expect(() => validateRegistrationVersion(reg)).toThrow("incompatible_holdout_registration_version");
  const badVersion = { ...reg, schema: "holdout-registration-v2" };
  await expect(validateRegistration(badVersion)).rejects.toThrow("incompatible_lookup_registration");
});

it("enforces the 14-file scope, runtime change and forward guidance witness, including modes, deletion and rename", async () => {
  expect(GUIDANCE_FILES).toHaveLength(14); expect(new Set(GUIDANCE_FILES).size).toBe(14);
  const base = await scratch(), baseline = { [RENDER]: "// Fictional pre-guidance render\n", [PACK]: "// Fictional pack\n", "docs/context/assembly.md": "Fictional docs\n" };
  const a = await tinyRepo(base, "r0", baseline), b = await tinyRepo(base, "rpack", baseline);
  expect(() => guidanceDiff(a, b)).toThrow("lookup_rpack_diff_out_of_scope");
  await appendFile(join(b, "docs/context/assembly.md"), "Fictional docs delta\n"); commit(b);
  expect(() => guidanceDiff(a, b)).toThrow("lookup_rpack_diff_out_of_scope");
  await writeFile(join(b, "docs/context/assembly.md"), baseline["docs/context/assembly.md"]);
  await chmod(join(b, PACK), 0o755); commit(b);
  expect(() => guidanceDiff(a, b)).toThrow("lookup_rpack_direction_invalid"); // Mode alone is not forward guidance.
  await writeFile(join(b, RENDER), guidance); commit(b);
  expect(guidanceDiff(a, b)).toEqual([PACK, RENDER]); // Includes the mode-only pack delta.
  expect(() => guidanceDiff(b, a)).toThrow("lookup_rpack_direction_invalid");
  await rm(join(b, PACK)); commit(b);
  expect(guidanceDiff(a, b)).toEqual([PACK, RENDER]); // Deletion is still a changed path.
  await mkdir(join(b, "docs/tools"), { recursive: true });
  git(b, ["mv", "docs/context/assembly.md", "docs/tools/mcp.md"]); commit(b);
  expect(guidanceDiff(a, b)).toEqual(["docs/context/assembly.md", "docs/tools/mcp.md", PACK, RENDER]);
  await rm(join(b, RENDER)); commit(b);
  expect(() => guidanceDiff(a, b)).toThrow("lookup_rpack_direction_invalid");
  await writeFile(join(b, "outside.txt"), "Fictional out-of-scope file"); commit(b);
  expect(() => guidanceDiff(a, b)).toThrow("lookup_rpack_diff_out_of_scope");
});

it("rejects hidden untracked edits, assume-unchanged and skip-worktree flags", async () => {
  const base = await scratch(), script = "scripts/continuity-benchmark.mjs", original = "// Fictional script\n";
  const path = await tinyRepo(base, "masked", { [script]: original }), revision = git(path, ["rev-parse", "HEAD"]);
  const options = { checkouts: { R0: { path, revision } }, suites: ["original"] };
  git(path, ["config", "status.showUntrackedFiles", "no"]); await writeFile(join(path, "untracked"), "Fictional hidden file");
  await expect(registerLookup(options)).rejects.toThrow("lookup_checkout_revision_or_dirt_mismatch");
  await rm(join(path, "untracked"));
  for (const flag of ["assume-unchanged", "skip-worktree"]) {
    git(path, ["update-index", `--${flag}`, script]); await writeFile(join(path, script), "// Fictional hidden edit\n");
    expect(git(path, ["status", "--porcelain=v1"])).toBe("");
    await expect(registerLookup(options)).rejects.toThrow("lookup_checkout_index_flags_unsafe");
    await writeFile(join(path, script), original); git(path, ["update-index", `--no-${flag}`, script]);
  }
});

it("keeps fixture Git hermetic against inherited config, GIT_* variables, signing and hooks", async () => {
  const base = await scratch(), global = join(base, "global-config"), hooks = join(base, "hooks");
  await mkdir(hooks); await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await writeFile(global, `[commit]\n  gpgsign = true\n[core]\n  hooksPath = ${hooks}\n`);
  for (const [key, value] of Object.entries({ GIT_DIR: "/fictional/not-a-git-dir", GIT_WORK_TREE: "/fictional/not-a-tree", GIT_INDEX_FILE: "/fictional/no-index",
    GIT_CONFIG_GLOBAL: global, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "true", GIT_AUTHOR_NAME: "Ignored inherited fixture identity" })) vi.stubEnv(key, value);
  const path = await tinyRepo(base, "hermetic", { "fiction.txt": "Fictional initial file\n" });
  git(path, ["config", "commit.gpgsign", "true"]); git(path, ["config", "core.hooksPath", hooks]);
  await appendFile(join(path, "fiction.txt"), "Fictional change\n");
  expect(commit(path)).toMatch(/^[a-f0-9]{40}$/u);
});

it("refuses a dirty/wrong checkout before building and old A1-only protocols explicitly", async () => {
  const base = await scratch(), path = await tinyRepo(base, "old", { "scripts/continuity-benchmark.mjs": "console.log(JSON.stringify({ version: 'old-A1-only' }));\n" });
  let revision = git(path, ["rev-parse", "HEAD"]);
  await expect(registerLookup({ checkouts: { R0: { path, revision: "a".repeat(40) } }, suites: ["original"] })).rejects.toThrow("lookup_checkout_revision_or_dirt_mismatch");
  await expect(registerLookup({ checkouts: { R0: { path, revision } }, suites: ["original"] })).rejects.toThrow("lookup_checkout_protocol_incompatible");
  await writeFile(join(path, "scripts/continuity-benchmark.mjs"), `console.log(${JSON.stringify(JSON.stringify(await lookupProtocol()))});`);
  revision = commit(path);
  await expect(registerLookup({ checkouts: { R0: { path, revision } }, suites: ["original"] })).rejects.toThrow("lookup_checkout_protocol_incompatible");
  await writeFile(join(path, "dirty"), "Fictional untracked file");
  await expect(registerLookup({ checkouts: { R0: { path, revision } }, suites: ["original"] })).rejects.toThrow("lookup_checkout_revision_or_dirt_mismatch");
});

it("keeps missing and duplicate role slots and reports failure-inclusive paired counts, not significance", async () => {
  const reg = await registrationFixture(), corpus = reg.common.corpora[0], trace = corpus.traces[0];
  const trial = (role, probe = 0, extra = {}) => ({ role, suite: corpus.suite, traceId: trace.id, probeId: trace.probes[probe], arm: reg.roles.find(r => r.id === role).arm, repeat: 1,
    status: "completed", lookup: { exactAccuracy: true, budgetFeasibility: { classification: "feasible" } }, ...extra });
  const result = await aggregateLookupRoles(reg, [trial("pack"), trial("pack-only", 0, { status: "failed" }), trial("pack", 1), trial("pack", 1)]);
  expect(result.coverage).toMatchObject({ planned: 12, completed: 1, blocked: 6, missing: 9, duplicate: 1, observations: 4 });
  expect(result.slots.find(s => s.role === "pack" && s.probeId === trace.probes[1])).toMatchObject({ status: "duplicate", occurrences: 2 });
  expect(result.roles.pack.exact).toMatchObject({ correct: 1, n: 1 });
  expect(result.roles["pack-only"]).toMatchObject({ exact: { n: 0 }, exactWithFailures: { correct: 0, n: 1 }, failedFeasible: 1 });
  expect(result.contrasts[0]).toMatchObject({ target: "pack-only", baseline: "pack", planned: 2, completedExact: { n: 0 }, exactWithFailures: { n: 1, baselineOnly: 1, delta: -1 } });
  expect(result.contrasts).toHaveLength(5); expect(result.purpose).toContain("not significance");
});

it("estimates offline per profile with unknown prices retained, repeated input and no spending authority", async () => {
  const reg = await registrationFixture();
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network allowed"));
  const unknown = await estimateLookup({ workload: reg.common });
  expect(unknown.workload.probes).toBe(12); expect(unknown.profiles.map(p => p.id)).toEqual(["sol", "luna", "opus"]);
  expect(unknown.profiles.every(p => p.priceStatus === "unknown_price" && p.scenarios.every(s => s.costSensitivityUSD.every(c => c.usd === null)))).toBe(true);
  expect(unknown).toMatchObject({ authorizedSpend: false, executionKind: "offline-estimate" });
  const known = await estimateLookup({ workload: reg.common, prices: { [ESTIMATE_PROFILES[0].model]: { input: 2, output: 8, cacheRead: null } } });
  const sol = known.profiles[0]; expect(sol.scenarios[0].costSensitivityUSD[0].usd).toBeGreaterThan(0);
  expect(sol.scenarios[0].costSensitivityUSD[1].usd).toBeNull();
  expect(sol.scenarios.at(-1).inputTokens).toBeGreaterThan(sol.scenarios[0].inputTokens * 8);
  await expect(estimateMain(["--real", "--registration", "/nonexistent"])).rejects.toThrow("lookup_real_not_authorized");
  await expect(compareMain(["run", "--real", "--registration", "/nonexistent"])).rejects.toThrow("lookup_real_not_authorized");
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps receipt-less post-aggregate failures missing with a reason, but rejects tampering and cross-role replay", async () => {
  const reg = await registrationFixture(), output = await scratch();
  const pack = await artifactRole(reg, output, "pack"), packOnly = await artifactRole(reg, output, "pack-only", false);
  const result = await aggregateRoleFiles(reg, output);
  expect(result.coverage).toMatchObject({ planned: 12, completed: 2, missing: 10 });
  expect(result.slots.filter(s => s.role === "pack-only").every(s => s.status === "missing" && s.missingReason === "lookup_role_receipt_missing")).toBe(true);
  expect(result.availability.find(a => a.role === "shipping").reason).toBe("lookup_role_results_missing");
  expect(await readFile(join(output, "summary.md"), "utf8")).toContain("pack-only/original: lookup_role_receipt_missing");
  await cp(join(pack, "results.json"), join(packOnly, "results.json"));
  await expect(aggregateRoleFiles(reg, output)).rejects.toThrow("lookup_role_receipt_mismatch");
  await artifactRole(reg, output, "pack-only");
  const changed = JSON.parse(await readFile(join(packOnly, "results.json"))); changed.lookupReceipt.build.outputSha256 = "0".repeat(64);
  await writeFile(join(packOnly, "results.json"), JSON.stringify(changed));
  await expect(aggregateRoleFiles(reg, output)).rejects.toThrow("lookup_role_receipt_mismatch");
});

it("uses the frozen conservative context and one-token-per-returned-byte replay bounds", async () => {
  const reg = await registrationFixture(), trace = (await loadTraces()).traces[0];
  const shape = traceTokenShape(trace), paths = LOOKUP_BUDGET.paths.filter(p => p.traceId === trace.id && p.arm === "continuity-pack-cold");
  const initial = Math.max(shape.cold + 12000, ...paths.map(p => Math.ceil(p.initialContextBytes / 3)), ...paths.map(p => p.initialTokens));
  const estimate = await estimateLookup({ workload: reg.common });
  expect(estimate.assumptions).toMatchObject({ packAllowanceTokens: 12000, soulDeltaTokens: 56 });
  expect(estimate.workload.roles.pack.initialTokens).toBe(initial * 2);
  expect(estimate.workload.roles["soul-only"].initialTokens - estimate.workload.roles.pack.initialTokens).toBe(56 * 2);
  const scenarios = estimate.profiles[0].scenarios, without = scenarios.find(s => s.lookupCallsPerProbe === 8 && s.returnedBytesPerProbe === 0), full = scenarios.at(-1);
  expect(full.inputTokens - without.inputTokens).toBe(estimate.workload.probes * 8 * LOOKUP_BUDGET.byteBudget);
  expect(full.inputCalls.reduce((sum, call) => sum + call.inputTokens * call.count, 0)).toBe(full.inputTokens);
  expect(full.inputTokens).toBeGreaterThanOrEqual(Object.values(estimate.workload.roles).reduce((sum, role) => sum + role.initialTokens * 9, 0)
    + estimate.workload.probes * (8 * LOOKUP_BUDGET.byteBudget + 81 * 300));
});

it("preserves catalog tiers and prices each call by its total input, including cached input", async () => {
  expect(ESTIMATE_PROFILES.find(p => p.id === "opus").model).toBe("anthropic:claude-opus-5-5");
  const prices = await offlinePrices(ESTIMATE_PROFILES);
  expect(prices[ESTIMATE_PROFILES[2].model]).toMatchObject({ input: 4, output: 20 });
  expect(prices[ESTIMATE_PROFILES[0].model].tiers[0].inputTokensAbove).toBe(272000);
  const price = { input: 2, output: 10, cacheRead: .1, tiers: [
    { inputTokensAbove: 400000, input: 6, output: 30, cacheRead: .3 },
    { inputTokensAbove: 272000, input: 4, output: 20, cacheRead: .2 },
  ] };
  expect(priceLookupCall(price, 272000, 300, 0)).toEqual({ usd: (272000 * 2 + 300 * 10) / 1e6, tierInputTokensAbove: null });
  expect(priceLookupCall(price, 272001, 300, 0)).toEqual({ usd: (272001 * 4 + 300 * 20) / 1e6, tierInputTokensAbove: 272000 });
  expect(priceLookupCall(price, 400001, 300, .5)).toEqual({ usd: (400001 * (3 + .15) + 300 * 30) / 1e6, tierInputTokensAbove: 400000 });
  const reg = await registrationFixture(), model = ESTIMATE_PROFILES[0].model;
  const result = await estimateLookup({ workload: reg.common, prices: { [model]: price } });
  const low = result.profiles[0].scenarios[0], high = result.profiles[0].scenarios.at(-1);
  expect(low.inputTokens).toBeGreaterThan(272000); // Aggregate input must NOT select a tier for every call.
  expect(low.costSensitivityUSD[0].tieredCalls).toBe(0);
  expect(high.costSensitivityUSD[0].tieredCalls).toBeGreaterThan(0);
  const expected = high.inputCalls.reduce((sum, call) => sum + priceLookupCall(price, call.inputTokens, call.outputTokens, 0).usd * call.count, 0);
  expect(high.costSensitivityUSD[0].usd).toBe(expected);
  const absent = { input: 2, output: 10, cacheRead: .1, tiers: [{ inputTokensAbove: 272000, output: 20 }] };
  expect(priceLookupCall(absent, 272001, 300, 0).usd).toBeNull();
});

it("overlays uncommitted deletions without copying nonexistent source files", async () => {
  const base = await scratch(), source = join(base, "source"), dest = join(base, "dest"); await mkdir(source); await mkdir(dest);
  await writeFile(join(source, "kept.txt"), "Fictional current text"); await writeFile(join(dest, "removed.txt"), "Fictional old text");
  await overlaySource(source, dest, ["kept.txt", "removed.txt"]);
  expect(await readFile(join(dest, "kept.txt"), "utf8")).toBe("Fictional current text");
  await expect(access(join(dest, "removed.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("prices eligible external slots with ten no-cache rounds, per-call tiers and one run-wide cap", async () => {
  const { estimateExternalLookup } = await import("../continuity-lookup-estimate.mjs");
  const fixture = await externalEstimateFixture(), result = estimateExternalLookup(fixture);
  expect(result).toMatchObject({ planned: 12, eligible: 8, skipped: 4, authorizedSpend: false });
  expect(result.roles.native).toMatchObject({ planned: 2, eligible: 0, skipped: 2, reservationUSD: 0 });
  expect(result.trials.filter(t => t.eligible).every(t => t.reservationTieredCalls === 10)).toBe(true);
  const perCall = priceLookupCall(fixture.catalog.cost, 300000, 10000, 0).usd;
  expect(result.reservationUSD).toBeCloseTo(8 * 10 * perCall, 10);
  expect(result.catalogCapUSD).toBe(Math.ceil(1.25 * result.reservationUSD * 100) / 100);
  expect(result.capOverExpected).toBe(result.catalogCapUSD / result.expectedUSD);
  expect(result.tokenEnvelope.roundsPerEligibleTrial).toBe(10);
  expect(result.roles.pack.expectedUSD).toBeCloseTo(result.trials.filter(t => t.role === "pack").reduce((s, t) => s + t.expectedUSD, 0));
  const altered = structuredClone(fixture);
  altered.workload.transportSpec = { design: { repeats: 2, shardCostCapUSD: 999999 }, gates: { arbitrary: true } };
  expect(estimateExternalLookup(altered)).toEqual(result);
  const enforced = structuredClone(fixture); enforced.outputLimit = { tokens: 1000, source: "enforced" };
  expect(estimateExternalLookup(enforced).reservationUSD).toBeLessThan(result.reservationUSD);
});

it("blocks external numerical approval on unknown slots, missing catalogs/limits/rates and ambiguous output bounds", async () => {
  const { estimateExternalLookup, offlineCatalog } = await import("../continuity-lookup-estimate.mjs");
  for (const mutate of [f => { f.catalog = null; }, f => { delete f.catalog.cost; }, f => { delete f.catalog.contextWindow; },
    f => { delete f.catalog.maxTokens; }, f => { delete f.catalog.cost.tiers[0].input; }, f => { f.catalog.cost.tiers = {}; },
    f => { delete f.catalog.cost.cacheRead; }, f => { f.outputLimit = null; }, f => { f.outputLimit.source = "hint"; },
    f => { f.outputLimit.tokens = 9999; }, f => { f.outputLimit.tokens = 10001; },

    f => { f.workload.policy.budget.paths.pop(); }, f => { f.workload.policy.budget.paths[2].initialTokens = 300001; }]) {
    const fixture = await externalEstimateFixture(); mutate(fixture); expect(() => estimateExternalLookup(fixture)).toThrow();
  }
  const unknown = await externalEstimateFixture();
  const path = unknown.workload.policy.budget.paths[0]; path.exhausted = "latency";
  path.feasibility = (await import("../lib/continuity-lookup.mjs")).externalPathFeasibility(path, unknown.workload.policy.budget);
  expect(() => estimateExternalLookup(unknown)).toThrow("lookup_inventory_unknown");
  const inconsistent = await externalEstimateFixture(); inconsistent.workload.policy.budget.paths[0].feasibility.classification = "unknown";
  expect(() => estimateExternalLookup(inconsistent)).toThrow("lookup_policy_feasibility_mismatch");
  await expect(offlineCatalog("fixture:reader", "/fictional/no-catalog")).rejects.toThrow("lookup_catalog_missing");
});

it("validates fixed policy hash, unchanged limits, complete role slots and independent source/selection bindings", async () => {
  const { assertExternalPolicy, FIXED_BUDGET_SHA256 } = await import("../lib/continuity-lookup.mjs");
  const fixture = await externalEstimateFixture(), policy = fixture.workload.policy;
  policy.fixedBudgetSha256 = FIXED_BUDGET_SHA256;
  const binding = { source: policy.source, selection: policy.selection };
  expect(assertExternalPolicy(policy, binding)).toBe(policy);
  for (const mutate of [p => { p.fixedBudgetSha256 = "a".repeat(64); }, p => { p.maxTurns = 9; }, p => { p.budget.callBudget++; },
    p => { p.budget.byteBudget++; }, p => { p.budget.paths.pop(); }, p => { p.budget.paths[0].role = "unregistered"; },
    p => { p.budget.paths[0].initialContextBytes = null; }, p => { p.selection[0].probes.pop(); }, p => { p.source.manifestSha256 = "a".repeat(64); }]) {
    const changed = structuredClone(policy); mutate(changed); expect(() => assertExternalPolicy(changed, binding)).toThrow();
  }
});

it("does not add a spurious cap cent when summing repeated fractional catalog reservations", async () => {
  const { estimateExternalLookup } = await import("../continuity-lookup-estimate.mjs");
  const f = await externalEstimateFixture();
  f.catalog = { ...f.catalog, contextWindow: 272000, maxTokens: 128000, cost: { input: 2, output: 10, cacheRead: .1 } };
  f.outputLimit = { tokens: 128000, source: "catalog_max" };
  f.workload.corpora[0].traces = Array.from({ length: 4 }, (_, i) => ({ id: `fixture-${i}`, probes: ["p01", "p02", "p03", "p04"] }));
  f.workload.policy = await (await import("./fixtures/holdout-synthetic.mjs")).fixtureLookupPolicy({ source: f.workload.corpora[0].source, selection: f.workload.corpora[0].traces });
  const result = estimateExternalLookup(f);
  expect(result.eligible).toBe(64); expect(result.reservationUSD).toBe(1167.36); expect(result.catalogCapUSD).toBe(1459.2);
});

it("refuses empty external options by presence instead of silently selecting legacy defaults", async () => {
  const groups = [
    [["--corpus-manifest", "--manifest-sha256", "--statistical-spec"], "lookup_empty_source_option"],
    [["--lookup-policy", "--lookup-policy-sha256"], "lookup_empty_policy_option"],
    [["--output-limit", "--output-limit-source"], "lookup_empty_output_limit_option"],
    [["--selection-seed", "--per-group"], "lookup_empty_selection_option"],
    [["--r0", "--rpack"], "lookup_empty_input_root_option"],
    [["--catalog-cap-usd"], "lookup_empty_catalog_cap_option"],
  ];
  for (const [flags, code] of groups) for (const flag of flags) for (const value of ["", " \t "]) {
    expect(() => workloadOptions({ [flag]: value })).toThrow(code);
  }
  for (const flag of ["--r0", "--rpack"]) expect(() => workloadOptions({ [flag]: "/fictional/checkout" })).toThrow("lookup_input_roots_required");
  expect(() => workloadOptions({ "--corpus-manifest": "/fictional/manifest.json" })).toThrow("lookup_source_required");
  const base = await scratch();
  await expect(compareMain(["register", "--corpus-manifest", "", "--manifest-sha256", "", "--statistical-spec", "", "--output", join(base, "unused")])).rejects.toThrow("lookup_empty_source_option");
  await expect(access(join(base, "unused"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(externalOnlyOptions)("refuses source-less %s across register, estimate, budget and launcher", async (flag, value) => {
  const base = await scratch(), output = join(base, "unused"), code = "lookup_external_flag_requires_source";
  expect(() => workloadOptions({ [flag]: value })).toThrow(code);
  await expect(compareMain(["register", flag, value, "--output", output])).rejects.toThrow(code);
  await expect(estimateMain([flag, value])).rejects.toThrow(code);
  for (const fixed of [[], ["--fixed-budget-sha256", "a".repeat(64)]]) {
    await expect(budgetMain(["--output", output, ...fixed, flag, value])).rejects.toThrow(code);
  }
  // Launch/aggregate accept only registered settings, never workload overrides.
  for (const command of ["run", "aggregate"]) {
    await expect(compareMain([command, "--registration", "/fictional/registration.json", flag, value, "--output", output])).rejects.toThrow("lookup_invalid_arguments");
  }
  await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps legacy registration checkout roots but refuses source-less estimator and budget roots", async () => {
  const flags = { "--r0": ROOT, "--rpack": ROOT };
  expect(workloadOptions(flags, { allowLegacyCheckoutRoots: true }).inputRoots).toEqual([ROOT, ROOT]);
  expect(() => workloadOptions(flags)).toThrow("lookup_external_flag_requires_source");
  await expect(estimateMain(["--r0", ROOT, "--rpack", ROOT])).rejects.toThrow("lookup_external_flag_requires_source");
  const base = await scratch();
  await expect(budgetMain(["--r0", ROOT, "--rpack", ROOT, "--output", join(base, "unused")])).rejects.toThrow("lookup_external_flag_requires_source");
  await expect(budgetMain(["--fixed-budget-sha256", "a".repeat(64), "--output", join(base, "unused")])).rejects.toThrow("lookup_external_flag_requires_source");
});

it("covers every workload flag and preserves a legacy estimate invocation", async () => {
  const legacyFlags = ["--suites", "--traces", "--repeats", "--probe-limit", "--reader", "--reader-effort"];
  expect([...WORKLOAD_FLAGS].sort()).toEqual([...externalOnlyOptions.map(([flag]) => flag), ...legacyFlags,
    "--r0", "--rpack", "--corpus-manifest", "--manifest-sha256", "--statistical-spec"].sort());
  const first = (await loadTraces()).traces[0], reader = "openai-codex:gpt-6.1-sol";
  let result;
  await estimateMain(["--suites", "original", "--traces", first.id, "--repeats", "2", "--probe-limit", "1", "--reader", reader, "--reader-effort", "low"],
    { stdout: text => { result = JSON.parse(text); } });
  expect(result.schema).toBe("continuity-lookup-estimate-v1");
  expect(result.workload.suites).toEqual(["original"]); expect(result.workload.repeats).toBe(2);
  expect(result.workload.probes).toBe(12); expect(result.registrationDigest).toBeNull();
  const expected = await lookupWorkload({ suites: ["original"], traceIds: [first.id], repeats: 2, probeLimit: 1, reader, readerEffort: "low" });
  expect(result.workloadDigest).toBe(digest(expected));
});

it("refuses even empty workload overrides before reading an estimator registration", async () => {
  for (const flag of WORKLOAD_FLAGS) await expect(estimateMain(["--registration", "/fictional/registration.json", "--sha256", "a".repeat(64), flag, ""])).rejects.toThrow("lookup_estimate_workload_conflict");
});

it("binds all present pilot artifact files, including guard assumptions, in the local protocol", async () => {
  const protocol = await lookupProtocol();
  expect(protocol.pilotSha256).toBe(digest(await Promise.all(LOOKUP_PILOT_PROTOCOL_FILES.map(async path => [path, sha256(await readFile(join(ROOT, path)))]))));
  expect(new Set(LOOKUP_PILOT_PROTOCOL_FILES).size).toBe(LOOKUP_PILOT_PROTOCOL_FILES.length);
  expect(LOOKUP_PILOT_PROTOCOL_FILES).toEqual([
    "scripts/lib/continuity-lookup-child-environment.mjs",
    "scripts/lib/continuity-lookup-faux-capability.mjs",
    "scripts/lib/continuity-lookup-preflight.mjs",
    "scripts/lib/continuity-lookup-preparation.mjs",
    "scripts/lib/continuity-lookup-preparation-child.mjs",
    "scripts/lib/continuity-lookup-pilot-runtime.mjs",
    "scripts/lib/continuity-lookup-real-capability.mjs",
    "scripts/lib/continuity-lookup-pilot-entry.mjs",
    "scripts/lib/continuity-lookup-pilot-probe.mjs",
    "scripts/lib/continuity-runner.mjs",
    "scripts/lib/continuity-lookup-controller.mjs",
    "scripts/lib/continuity-lookup-ipc.mjs",
    "scripts/lib/continuity-lookup-pilot-accounting.mjs",
    "scripts/lib/continuity-lookup-pilot-state.mjs",
    "scripts/lib/continuity-lookup-pilot-report.mjs",
    "scripts/lib/continuity-lookup-pilot-child.mjs",
    "scripts/lib/continuity-holdout-controller.mjs",
    "scripts/lib/continuity-lookup-guard.mjs", "scripts/lib/continuity-lookup-pilot.mjs",
    "scripts/lib/continuity-lookup-authorization.mjs", "scripts/continuity-lookup-estimate.mjs",
    "scripts/lib/continuity-lookup-lease.mjs", "scripts/lib/continuity-process-identity.mjs",
    "scripts/lib/continuity-holdout-workflow.mjs", "scripts/lib/continuity-holdout-files.mjs",
    "scripts/lib/continuity-holdout-registration.mjs", "scripts/continuity-holdout-freeze.mjs",
    "scripts/lib/continuity-holdout-statistics.mjs", "scripts/lib/continuity-holdout-generator.mjs",
    "scripts/lib/continuity-holdout-overlap.mjs", "scripts/continuity-holdout/statistical-spec.json",
    "scripts/lib/memory-e2e-build.mjs", "scripts/continuity-lookup-compare.mjs",
  ]);
});

it("rejects non-hex estimator hashes before reading files and null registrations with a fixed code", async () => {
  for (const hash of ["not-hex", "G".repeat(64)])
    await expect(estimateMain(["--registration", "/fictional/nonexistent.json", "--sha256", hash])).rejects.toThrow("lookup_registration_hash_required");
  const dir = await scratch(), file = join(dir, "null-registration.json"); await writeFile(file, "null");
  await expect(estimateMain(["--registration", file, "--sha256", sha256("null")])).rejects.toThrow("incompatible_lookup_registration");
});
