import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
const mocks = vi.hoisted(() => ({ protocol: null, traces: [], source: null, build: vi.fn() }));
vi.mock("node:child_process", async original => {
  const actual = await original(); return { ...actual, execFileSync: (executable, args, options) =>
    args?.includes("--lookup-protocol") ? JSON.stringify(mocks.protocol) : actual.execFileSync(executable, args, options) };
});
vi.mock("../lib/memory-e2e-build.mjs", async original => ({ ...await original(), prepareRealBuild: mocks.build, verifyRealBuild: async () => {} }));
vi.mock("../lib/continuity-dataset.mjs", async original => {
  const actual = await original(); return { ...actual, loadTraces: async options => {
    if (!options?.lookupSource) return actual.loadTraces(options);
    const { selectLookupTraces } = await import("../lib/continuity-lookup.mjs");
    return { suite: "holdout", ...selectLookupTraces(mocks.traces, options.selectionSeed, options.perGroup),
      lookupSource: options.lookupSource, sha256: options.lookupSource.manifestSha256, source: mocks.source };
  } };
});
import { loadTraces, digest } from "../lib/continuity-dataset.mjs";
import { LOOKUP_ROLES, FIXED_BUDGET_SHA256, selectLookupFamilies, selectLookupTraces, assertExternalPolicy, externalPathFeasibility, sha256 } from "../lib/continuity-lookup.mjs";
import { ROOT, lookupProtocol, lookupWorkload, registerLookup, validateRegistration, validateExternalPricing,
  rolePlan, roleBinding, runLookupRoles, aggregateLookupRoles } from "../lib/continuity-lookup-roles.mjs";
import { BUILD_POLICY } from "../lib/memory-e2e-build.mjs";
import { estimateExternalLookup, offlineCatalog } from "../continuity-lookup-estimate.mjs";
import { measureFixedBudget } from "../continuity-lookup-budget.mjs";
import { fixtureLookupPolicy } from "./fixtures/holdout-synthetic.mjs";
const dirs = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); vi.clearAllMocks(); });
const git = (root, args) => execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const render = "packages/conversation/src/continuity/render-fit.ts", pack = "packages/conversation/src/continuity/pack.ts";
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lookup-external-fixture-"))); dirs.push(dir);
  const roots = [join(dir, "r0"), join(dir, "rpack")];
  const files = ["pnpm-lock.yaml", "scripts/continuity-benchmark.mjs", ...["lookup-roles", "dataset", "generator", "lookup", "runner", "probe-child", "arms", "tools", "score", "lookup-score"].map(n => `scripts/lib/continuity-${n}.mjs`),
    ...["continuity-lookup-budget-v1.json", "continuity-soul-v1.md", "continuity-soul-v2.md"].map(n => `scripts/fixtures/${n}`)];
  for (const [i, root] of roots.entries()) {
    await mkdir(root); git(root, ["init", "-q"]);
    for (const name of files) { await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), await readFile(join(ROOT, name))); }
    for (const name of [pack, render]) { await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), name === render && i === 1 ? 'export const PACK_RETRIEVAL_GUIDANCE = "Fixture guidance";\n' : "// Fixture source\n"); }
    await writeFile(join(root, ".gitignore"), "private/\n"); git(root, ["add", "."]); git(root, ["commit", "-qm", "test: synthetic checkout"]);
  }
  const checkouts = Object.fromEntries(["R0", "Rpack"].map((id, i) => [id, { path: roots[i], revision: git(roots[i], ["rev-parse", "HEAD"]) }]));
  mocks.protocol = await lookupProtocol();
  mocks.build.mockImplementation(async (root, revision) => ({ policy: BUILD_POLICY, sourceHead: revision,
    outputSha256: sha256(await readFile(join(root, render))), command: ["pnpm", "--filter", "@mono-agent/app...", "run", "build"],
    packages: ["packages/app"], outputRoots: ["packages/app/dist"], node: process.version }));
  const codes = {};
  for (const [id, c] of Object.entries(checkouts)) codes[id] = { ...c, build: await mocks.build(c.path, c.revision) };
  const original = (await loadTraces()).traces[0];
  mocks.traces = Array.from({ length: 8 }, (_, i) => ({ ...original, id: `fixture-trace-${i}`, generated: { group: i < 4 ? "ordinary" : "distractor", scenario: `fixture-family-${i}` } }));
  mocks.source = { kind: "lookup-frozen-holdout", manifestSha256: "d".repeat(64), statisticalSpecSha256: "e".repeat(64) };
  const inputs = join(dir, "inputs"); await mkdir(inputs);
  const lookupSource = { manifestPath: join(inputs, "manifest.json"), manifestSha256: mocks.source.manifestSha256, statisticalSpecPath: join(inputs, "statistics.json") };
  await writeFile(lookupSource.manifestPath, "{}"); await writeFile(lookupSource.statisticalSpecPath, "{}");
  const options = { suites: ["holdout"], lookupSource, selectionSeed: 42, perGroup: 2, probeLimit: 2, inputRoots: roots };
  const workload = await lookupWorkload(options);
  const policy = await fixtureLookupPolicy({ source: mocks.source, selection: workload.corpora[0].traces, lookupSelection: workload.lookupSelection,
    reader: workload.reader, codes, protocol: mocks.protocol });
  const policyPath = join(inputs, "budget.json");
  const bindPolicy = async (p = policy) => { const bytes = JSON.stringify(p); await writeFile(policyPath, bytes); return sha256(bytes); };
  options.policyPath = policyPath; options.policySha256 = await bindPolicy(); options.outputLimit = { tokens: 128000, source: "catalog_max" };
  const catalog = await offlineCatalog(workload.reader.model);
  options.catalogCapUSD = estimateExternalLookup({ workload: { ...workload, policy }, catalog, outputLimit: options.outputLimit }).catalogCapUSD;
  return { dir, roots, checkouts, codes, options, policy, policyPath, bindPolicy };
}
it("selects balanced sealed families deterministically, rejects explicit spares and binds selection", async () => {
  const groups = { ordinary: ["aa", "bb", "cc", "dd"], distractor: ["ee", "ff", "gg", "hh"] };
  const selected = selectLookupFamilies(groups, 42);
  expect(selected).toEqual(selectLookupFamilies({ distractor: [...groups.distractor].reverse(), ordinary: [...groups.ordinary].reverse() }, 42));
  expect(selected.algorithm).toBe("seeded-sha256-rank-v1");
  expect(selected.selectedIds.filter(id => groups.ordinary.includes(id))).toHaveLength(2);
  expect(selected.selectedIds.filter(id => groups.distractor.includes(id))).toHaveLength(2);
  expect(() => selectLookupFamilies(groups, NaN)).toThrow("lookup_invalid_selection");
  const f = await fixture();
  const selectedTraces = selectLookupTraces(mocks.traces, 42).traces;
  const spare = mocks.traces.find(t => !selectedTraces.includes(t));
  await expect(lookupWorkload({ ...f.options, traceIds: [spare.id] })).rejects.toThrow("lookup_explicit_selection_refused");
  await expect(lookupWorkload({ ...f.options, selectionSeed: 43 })).rejects.toThrow("lookup_policy_selection_mismatch");
  const policy = structuredClone(f.policy); policy.lookupSelection.seed++;
  await expect(lookupWorkload({ ...f.options, policySha256: await f.bindPolicy(policy) })).rejects.toThrow("lookup_policy_selection_mismatch");
});
it("round-trips v2 registration and rejects every bound-field mutation with specific codes", async () => {
  const f = await fixture();
  const r = await registerLookup({ ...f.options, checkouts: f.checkouts });
  expect(r.schema).toBe("continuity-lookup-registration-v2"); expect(await validateRegistration(r)).toBe(r);
  expect(mocks.build).toHaveBeenCalledTimes(4);
  await validateExternalPricing(r.common, r.codes, r.common.protocol);
  for (const [change, code] of [
    [r => { r.common.catalog.cost.input++; }, "lookup_catalog_binding_mismatch"],
    [r => { r.common.catalogCapUSD++; }, "lookup_catalog_cap_mismatch"],
    [r => { r.common.outputLimit.tokens--; }, "lookup_output_limit_required"],
    [r => { r.schema = "continuity-lookup-registration-v1"; }, "incompatible_lookup_registration"],
    [r => { delete r.common.lookupSource; }, "incompatible_lookup_registration"],
    [r => { r.common.lookupSelection.seed++; }, "lookup_policy_selection_mismatch"],
  ]) { const changed = structuredClone(r); change(changed); await expect(validateRegistration(changed)).rejects.toThrow(code); }
  for (const [change, code] of [
    [p => { p.codes.R0.build.outputSha256 = "a".repeat(64); }, "lookup_policy_code_mismatch"],
    [p => { p.protocol.readerSha256 = "b".repeat(64); }, "lookup_policy_protocol_mismatch"],
    [p => { p.reader.effort = "high"; }, "lookup_policy_reader_mismatch"],
  ]) {
    const changed = structuredClone(r), policy = structuredClone(f.policy); change(policy);
    changed.common.policy = policy; changed.common.policySha256 = await f.bindPolicy(policy);
    await expect(validateRegistration(changed)).rejects.toThrow(code);
  }
  await f.bindPolicy();
  const missing = { ...r.common, catalogCapUSD: undefined };
  await expect(validateExternalPricing(missing, r.codes, r.common.protocol)).rejects.toThrow("lookup_external_pricing_required");
});
it("filters policy paths in plans and aggregates, and forwards source/policy/seed to every child", async () => {
  const f = await fixture(), r = await registerLookup({ ...f.options, checkouts: f.checkouts });
  for (const role of r.roles) {
    const plan = await rolePlan(r.common, roleBinding(r, role, r.common.corpora[0]));
    expect(plan.lookup.budget.paths).toHaveLength(8); expect(plan.lookup.budget.paths.every(p => p.role === role.id)).toBe(true);
    expect(plan.lookup.selection).toEqual(r.common.lookupSelection);
  }
  const observations = r.roles.flatMap(role => r.common.corpora[0].traces.flatMap(t => t.probes.map(probeId => ({ role: role.id, arm: role.arm, suite: "holdout", traceId: t.id, probeId, repeat: 1, status: "failed" }))));
  const aggregated = await aggregateLookupRoles(r, observations);
  expect(aggregated.roles.native.failedFeasible).toBe(0); expect(aggregated.roles.pack.failedFeasible).toBe(8);
  const dispatch = vi.fn(async (root, args) => {
    const flag = key => args[args.indexOf(key) + 1];
    expect(flag("--corpus-manifest")).toBe(f.options.lookupSource.manifestPath);
    expect(flag("--statistical-spec")).toBe(f.options.lookupSource.statisticalSpecPath);
    expect(flag("--manifest-sha256")).toBe(f.options.lookupSource.manifestSha256);
    expect(flag("--lookup-policy")).toBe(f.policyPath); expect(flag("--lookup-policy-sha256")).toBe(f.options.policySha256);
    expect(flag("--selection-seed")).toBe("42"); expect(flag("--per-group")).toBe("2");
    return { code: 0, timedOut: false };
  });
  const result = await runLookupRoles(r, join(f.dir, "run"), { dispatch });
  expect(dispatch).toHaveBeenCalledTimes(6); expect(result.coverage).toMatchObject({ planned: 48, missing: 48 });
});
it("rejects inputs hidden or symlinked inside either checkout before measuring or registering", async () => {
  const f = await fixture();
  for (const root of f.roots) {
    const hidden = join(root, "private"); await mkdir(hidden); await writeFile(join(hidden, "manifest.json"), "{}");
    const alias = join(f.dir, `alias-${f.roots.indexOf(root)}`); await symlink(hidden, alias);
    for (const base of [hidden, alias]) for (const field of ["manifestPath", "statisticalSpecPath", "policyPath"]) {
      const options = structuredClone(f.options);
      if (field === "policyPath") options.policyPath = join(base, "manifest.json");
      else options.lookupSource[field] = join(base, "manifest.json");
      await expect(registerLookup({ ...options, checkouts: f.checkouts })).rejects.toThrow("path_must_be_outside_checkout");
      await expect(measureFixedBudget({ ...options, checkouts: f.checkouts, fixedBudgetSha256: FIXED_BUDGET_SHA256, output: join(f.dir, "unused") })).rejects.toThrow("path_must_be_outside_checkout");
    }
  }
  expect(mocks.build).toHaveBeenCalledTimes(2);
});
it("recomputes policy geometry and refuses classification/reason tampering, while unknown blocks estimates", async () => {
  const f = await fixture();
  assertExternalPolicy(f.policy, { source: mocks.source, selection: f.policy.selection, lookupSelection: f.policy.lookupSelection });
  for (const mutate of [p => { p.feasibility = { classification: "budget-infeasible", reasons: [] }; },
    p => { p.calls = 100; }, p => { p.initialTokens = 999999; }, p => { p.feasibility.reasons = ["fabricated"]; }]) {
    const changed = structuredClone(f.policy); mutate(changed.budget.paths.find(p => p.arm !== "native-lookup"));
    expect(() => assertExternalPolicy(changed, { source: mocks.source })).toThrow("lookup_policy_feasibility_mismatch");
  }
  const unknown = structuredClone(f.policy), path = unknown.budget.paths.find(p => p.arm !== "native-lookup");
  path.exhausted = "latency"; path.feasibility = externalPathFeasibility(path, unknown.budget);
  assertExternalPolicy(unknown, { source: mocks.source });
  const flipped = structuredClone(unknown); flipped.budget.paths.find(p => p.exhausted === "latency").feasibility = { classification: "budget-infeasible", reasons: ["reader_context"] };
  expect(() => assertExternalPolicy(flipped, { source: mocks.source })).toThrow("lookup_policy_feasibility_mismatch");
  const conservative = structuredClone(f.policy); conservative.budget.paths.find(p => p.method === "conservative-full-budget").bytes--;
  expect(() => assertExternalPolicy(conservative, { source: mocks.source })).toThrow("lookup_policy_feasibility_mismatch");
  const workload = await lookupWorkload({ ...f.options, policySha256: await f.bindPolicy(unknown) });
  expect(() => estimateExternalLookup({ workload, catalog: { model: workload.reader.model, fileSha256: "a".repeat(64), contextWindow: 272000, maxTokens: 128000, cost: { input: 2, output: 10, cacheRead: .1 } }, outputLimit: f.options.outputLimit })).toThrow("lookup_inventory_unknown");
});
