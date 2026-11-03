import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const mocks = vi.hoisted(() => ({ buildCheckpoint: vi.fn(), runProbe: vi.fn(), productionModules: vi.fn(), prepareLookupCodes: vi.fn(), workload: null, loaded: null }));
vi.mock("../lib/continuity-runner.mjs", () => mocks);
vi.mock("../lib/continuity-lookup-roles.mjs", async importOriginal => ({ ...await importOriginal(),
  prepareLookupCodes: mocks.prepareLookupCodes, lookupWorkload: async () => mocks.workload }));
vi.mock("../lib/continuity-dataset.mjs", async importOriginal => {
  const actual = await importOriginal(); return { ...actual, loadTraces: options => options?.lookupSource && mocks.loaded ? mocks.loaded : actual.loadTraces(options) };
});
import { loadTraces, makePlan } from "../lib/continuity-dataset.mjs";
import { LOOKUP_BUDGET, LOOKUP_MODE, FIXED_BUDGET_SHA256, sourceAnnotation } from "../lib/continuity-lookup.mjs";
import { measureBudget, measureFixedBudget, main } from "../continuity-lookup-budget.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url)), dirs = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.productionModules.mockResolvedValue({ conversation: { ToolHistoryReader: class {
    searchContinuity() { return { available: true, items: [] }; }
  } } });
});
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function scratch() {
  const base = join(root, ".worklab-tmp"); await mkdir(base, { recursive: true });
  const output = await mkdtemp(join(base, "lookup-sizing-failure-")); dirs.push(output); return output;
}

it.each(["", "   ", "\t\n"])("rejects an empty fixed-budget hash before workload/source checks (%j)", async hash => {
  for (const options of [[], ["--reader", ""], ["--corpus-manifest", ""], ["--selection-seed", "not-a-number"]]) {
    await expect(main(["--output", "/fictional/output", "--fixed-budget-sha256", hash, ...options]))
      .rejects.toMatchObject({ code: "lookup_empty_fixed_budget_sha256" });
  }
  expect(mocks.productionModules).not.toHaveBeenCalled();
  expect(mocks.buildCheckpoint).not.toHaveBeenCalled();
});

it("cleans partial checkpoint scratch when checkpoint creation throws", async () => {
  const output = await scratch(); let checkpointDir;
  mocks.buildCheckpoint.mockImplementation(async ({ dir }) => {
    checkpointDir = dir; await mkdir(dir, { recursive: true }); await writeFile(join(dir, "partial"), "fictional partial checkpoint");
    throw new Error("fictional_checkpoint_failure");
  });
  await expect(measureBudget({ output })).rejects.toThrow("fictional_checkpoint_failure");
  await expect(access(checkpointDir)).rejects.toMatchObject({ code: "ENOENT" });
  expect(mocks.runProbe).not.toHaveBeenCalled();
});

it("refuses an unverified retained reference before it can influence frozen maxima", async () => {
  const output = await scratch(); let checkpointDir;
  mocks.buildCheckpoint.mockImplementation(async ({ dir }) => {
    checkpointDir = dir; await mkdir(dir, { recursive: true });
    return { work: join(dir, "work"), snapshot: join(dir, "snapshot"), record: { conversationId: "web:fiction", continuity: { records: 1 } } };
  });
  mocks.runProbe.mockResolvedValue({ failure: null, store: { healthy: true }, lookup: { exhausted: null, source: { availability: "retained" }, sourceReturned: false } });
  await expect(measureBudget({ output })).rejects.toThrow("inventory_source_digest_unverified");
  expect(mocks.runProbe).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(join(output, "inventory-progress.json"), "utf8")).paths).toEqual([]);
  await expect(access(join(output, "budget.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(checkpointDir)).rejects.toMatchObject({ code: "ENOENT" });
});

it("inventories every selected slot per role without deriving limits, isolating spare traces and cleaning scratch", async () => {
  const base = await scratch(), trace = (await loadTraces()).traces[0];
  const lookupSource = { manifestPath: "/fictional/manifest.json", manifestSha256: "d".repeat(64), statisticalSpecPath: "/fictional/spec.json" };
  const source = { kind: "lookup-frozen-holdout", manifestSha256: lookupSource.manifestSha256 };
  const selected = makePlan({ ...await loadTraces(), traces: [trace], probeMode: LOOKUP_MODE, probeLimit: 4 }).corpus.traces;
  mocks.loaded = { suite: "holdout", lookupSelection: { algorithm: "seeded-sha256-rank-v1", seed: 42, perGroup: 1, selectedIds: ["fixture-family"] }, traces: [trace, { ...trace, id: "fixture-sealed-spare" }], sha256: lookupSource.manifestSha256, source, lookupSource };
  mocks.workload = { lookupSource, lookupSelection: mocks.loaded.lookupSelection, reader: { model: "openai-codex:gpt-6.1-sol", effort: "low" }, probeLimit: 4, corpora: [{ traces: selected, source }] };
  mocks.prepareLookupCodes.mockResolvedValue({ codes: { R0: { path: root }, Rpack: { path: root } }, protocol: { fixture: true } });
  mocks.buildCheckpoint.mockImplementation(async ({ dir }) => { await mkdir(dir, { recursive: true }); return { work: dir, snapshot: dir, record: { conversationId: "web:fiction" } }; });
  mocks.runProbe.mockImplementation(async ({ probe, arm }) => ({ failure: null, store: { healthy: true }, lookup: {
    initialContextBytes: arm.id === "native-lookup" ? 900000 : 12000, initiallyPresent: false, exhausted: null,
    source: { availability: probe.score.kind === "identifier" ? "retained" : "unknown", sha256: "b".repeat(64) },
    sourceReturned: probe.score.kind === "identifier", reference: { discovered: true }, calls: 2, bytes: 100,
    cumulativeBytes: 150, responseBytes: [50, 50] } }));
  const fixed = join(base, "missing", "parent", "fixed");
  const result = await measureFixedBudget({ output: fixed, fixedBudgetSha256: FIXED_BUDGET_SHA256, sourceAnnotation });
  expect(result.budget.callBudget).toBe(8); expect(result.budget.byteBudget).toBe(126976); expect(result.maxTurns).toBe(10);
  expect(result.budget.paths).toHaveLength(24); expect(mocks.buildCheckpoint).toHaveBeenCalledTimes(6);
  expect(mocks.runProbe).toHaveBeenCalledTimes(24);
  expect(result.budget.paths.every(p => p.traceId === trace.id)).toBe(true);
  expect(result.budget.paths.filter(p => p.probeId === "p04").every(p => p.method === "conservative-full-budget" && p.sourceAvailability === "unknown")).toBe(true);
  expect(result.budget.paths.filter(p => p.arm === "native-lookup").every(p => p.initialAdmission.classification === "budget-infeasible")).toBe(true);
  expect(result.budget.paths.filter(p => p.arm !== "native-lookup").every(p => p.feasibility.classification === "feasible")).toBe(true);
  for (const { plan } of mocks.runProbe.mock.calls.map(([arg]) => arg)) { expect(plan.lookup.budget).toEqual({ ...LOOKUP_BUDGET, paths: [] }); expect(plan.lookup.maxTurns).toBe(10); }
  const bytes = await readFile(join(fixed, "budget.json"), "utf8");
  await expect(measureFixedBudget({ output: fixed, fixedBudgetSha256: FIXED_BUDGET_SHA256 })).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(join(fixed, "budget.json"), "utf8")).toBe(bytes);
  expect(bytes).not.toContain(trace.probes[0].question); expect(bytes).not.toContain(trace.probes[0].score.accept[0]);
  await expect(access(join(fixed, "scratch"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(measureFixedBudget({ output: join(base, "bad"), fixedBudgetSha256: "a".repeat(64) })).rejects.toThrow("lookup_fixed_budget_hash_mismatch");
  const external = await mkdtemp(join(tmpdir(), "lookup-fixed-cli-")); dirs.push(external);
  const initialProbe = mocks.runProbe.getMockImplementation();
  const identifiers = trace.probes.slice(0, 4).filter(p => sourceAnnotation(trace, p).availability === "annotated").length;
  for (const exhausted of ["calls", "bytes", "latency", "other_failure"]) {
    mocks.runProbe.mockImplementation(async args => {
      const trial = await initialProbe(args);
      if (sourceAnnotation(args.trace, args.probe).availability === "annotated") trial.lookup.exhausted = exhausted;
      return trial;
    });
    let summary;
    await main(["--output", join(external, exhausted), "--fixed-budget-sha256", FIXED_BUDGET_SHA256,
      "--r0", root, "--rpack", root, "--corpus-manifest", "/fictional/manifest.json", "--manifest-sha256", "d".repeat(64),
      "--statistical-spec", "/fictional/spec.json", "--selection-seed", "42", "--per-group", "1"], { stdout: text => { summary = JSON.parse(text); } });
    expect(summary.planned).toBe(24);
    expect(summary.unknown).toBe(["calls", "bytes"].includes(exhausted) ? 0 : 6 * identifiers);
    expect(summary.infeasible).toBe(["calls", "bytes"].includes(exhausted) ? 8 + 4 * identifiers : 8 - 2 * identifiers);
    const artifact = JSON.parse(await readFile(join(external, exhausted, "budget.json"), "utf8"));
    const path = artifact.budget.paths.find(p => p.method === "identifier-reference" && p.arm !== "native-lookup");
    expect(path.feasibility.reasons).toContain(`reference_${exhausted}`);
  }
  await writeFile(join(external, "inventory.json"), "{}");
  const failed = spawnSync(process.execPath, [join(root, "scripts/continuity-lookup-budget.mjs"), "--output", external], { encoding: "utf8" });
  expect(failed.status).toBe(1); expect(failed.stderr).toContain("inventory_already_exists");

});
