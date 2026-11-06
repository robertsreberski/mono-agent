import { expect, it } from "vitest";
import { digest } from "../lib/continuity-dataset.mjs";
import { LOOKUP_ASSUMPTIONS } from "../lib/continuity-lookup-guard.mjs";
import { estimateLookupPilot, lookupPilotDescriptor, validateLookupPilotRegistration, LOOKUP_FAUX_AUTHORIZATION_DOMAIN } from "../lib/continuity-lookup-pilot.mjs";
import { offlineCatalog } from "../continuity-lookup-estimate.mjs";
import { lookupPilotSchedule } from "../lib/continuity-lookup-pilot-state.mjs";
import { LOOKUP_ROLES, LOOKUP_PILOT_MEASURED_ROLES, externalPathFeasibility, referenceFeasibility } from "../lib/continuity-lookup.mjs";
import { fixtureLookupPolicy } from "./fixtures/holdout-synthetic.mjs";

async function fixture() {
  const selection = [{ id: "fictional-trace", probes: ["fictional-probe"] }];
  const source = { kind: "lookup-frozen-holdout", manifestSha256: "a".repeat(64), statisticalSpecSha256: "b".repeat(64) };
  const lookupSelection = { algorithm: "seeded-sha256-rank-v1", seed: 1, perGroup: 2, selectedIds: ["fictional-trace"] };
  const reader = { model: "openai-codex:gpt-6.1-sol", effort: "high" };
  const policy = await fixtureLookupPolicy({ source, selection, lookupSelection, reader });
  policy.budget.paths = LOOKUP_ROLES.map(r => ({ ...policy.budget.paths[0], role: r.id, arm: r.arm, traceId: selection[0].id,
    probeId: selection[0].probes[0], initialTokens: 10000, feasibility: { classification: "feasible", reasons: [] } }));
  for (const path of policy.budget.paths) {
    path.initialAdmission = referenceFeasibility({ calls: 0, bytes: 0, cumulativeBytes: 0, discovered: true }, policy.budget, path);
    path.feasibility = externalPathFeasibility(path, policy.budget);
  }
  const workload = { lookupSource: source, policy, lookupSelection, reader, repeats: 1, corpora: [{ source, traces: selection }], outputLimit: { tokens: 128000, source: "catalog_max" } };
  return { workload, catalog: await offlineCatalog(reader.model), capUSD: 4, scheduleSeed: 7, runDeadlineMs: 3600000 };
}
it("pins exact maximum-class reservation, headroom, ratio and scenario independently of legacy cap", async () => {
  const f = await fixture(), e = estimateLookupPilot(f);
  expect(e.rmaxUSD).toBe(3.92); expect(e.capUSD).toBe(4); expect(e.lastAdmissibleHeadroomUSD).toBe(.08);
  expect(e.fullUpfrontComparisonUSD).toBe(196); expect(e.capOverExpected).toBeCloseTo(4 / e.expectedUSD, 12);
  expect(e.scenario).toMatchObject({ cacheFraction: "1/2", lookups: 2, measurement: false });
  expect(e.authorizedSpend).toBe(false);
  expect(estimateLookupPilot({ ...f, capUSD: 3.92 }).lastAdmissibleHeadroomUSD).toBe(0);
});
it.each([0, -1, 3.919999999, 4.001, 4.000000000000001, 1e13, 9e13, 1e14, NaN, Infinity, undefined, "4"])("rejects invalid or below-Rmax C %s", async capUSD => {
  const f = await fixture();
  expect(() => estimateLookupPilot({ ...f, capUSD })).toThrow("lookup_cap_invalid");
});
it("reports null C/E when all slots are skipped", async () => {
  const f = await fixture(); f.workload.policy.budget.paths.forEach(p => {
    p.initialTokens = 1000000;
    p.initialAdmission = referenceFeasibility({ calls: 0, bytes: 0, cumulativeBytes: 0, discovered: true }, f.workload.policy.budget, p);
    p.feasibility = externalPathFeasibility(p, f.workload.policy.budget);
  });
  expect(estimateLookupPilot(f)).toMatchObject({ expectedUSD: 0, capOverExpected: null, fullUpfrontComparisonUSD: 0 });
});
it.each(["input", "output", "cacheRead", "cacheWrite"])("rejects missing and changed %s pricing", async key => {
  const f = await fixture(); delete f.catalog.cost[key];
  expect(() => estimateLookupPilot(f)).toThrow("lookup_catalog_binding_mismatch");
  f.catalog.cost[key] = 99;
  expect(() => estimateLookupPilot(f)).toThrow("lookup_catalog_binding_mismatch");
});
it("uses strictly applicable tiers, rejects maximum drift, missing tier rates and assumption substitution", async () => {
  const f = await fixture(), base = { ...f.catalog.cost }; delete base.tiers;
  f.catalog.cost.tiers = [{ ...base, inputTokensAbove: 272000, output: 999 }];
  expect(estimateLookupPilot(f).rmaxUSD).toBe(3.92); // threshold not exceeded at I
  f.catalog.cost.tiers[0].inputTokensAbove--;
  expect(() => estimateLookupPilot(f)).toThrow("lookup_catalog_binding_mismatch");
  delete f.catalog.cost.tiers[0].cacheWrite;
  expect(() => estimateLookupPilot(f)).toThrow("lookup_catalog_binding_mismatch");
  expect(() => estimateLookupPilot({ ...f, assumptions: { ...LOOKUP_ASSUMPTIONS, inputMax: 1 } })).toThrow("lookup_assumptions_mismatch");
});
it("registers complete policy, assumptions and deterministic schedule digests, not execution", async () => {
  const f = await fixture(), d = lookupPilotDescriptor(f);
  expect(LOOKUP_FAUX_AUTHORIZATION_DOMAIN).not.toBe("mono-agent/lookup-pilot/consumed-v1\0");
  expect(d).toMatchObject({ capPolicy: "cap-gated-v1", concurrency: 1, outputCap: "catalog_max_assumed", inputEnvelope: "assumed-v1",
    cacheKeyPolicy: "controller-issued-transport-key-v1", accounting: { lost: "incomplete", ownAbort: "incomplete", consecutiveLossLimit: 2, admission: "T+Rmax<=C" } });
  expect(d.assumptions).toEqual(LOOKUP_ASSUMPTIONS); expect(d.assumptionsSha256).toBe(digest(LOOKUP_ASSUMPTIONS));
  expect(d.scheduleSha256).toBe(digest(d.schedule)); expect(lookupPilotDescriptor(f)).toEqual(d);
  expect(lookupPilotDescriptor({ ...f, scheduleSeed: 8 }).scheduleSha256).not.toBe(d.scheduleSha256);
  expect(d.deadlines).toMatchObject({ runDeadlineMs: 3600000, childWatchdogMs: 720000 });
  expect(() => lookupPilotDescriptor({ ...f, runDeadlineMs: 0 })).toThrow("lookup_pilot_not_ready");
  await expect(validateLookupPilotRegistration({ schema: "continuity-lookup-pilot-faux-v1", descriptor: d })).rejects.toThrow("incompatible_lookup_registration");
});

it("estimates and schedules only the four measured roles even when every inventory path is feasible", async () => {
  const f = await fixture(), paths = f.workload.policy.budget.paths;
  expect(paths.every(p => p.feasibility.classification === "feasible")).toBe(true);
  const pilot = {registration: {common: f.workload, roles: LOOKUP_ROLES}, descriptor: lookupPilotDescriptor(f)};
  expect(lookupPilotSchedule(pilot).filter(s => s.eligible).map(s => s.roleId).sort()).toEqual([...LOOKUP_PILOT_MEASURED_ROLES].sort());
  expect(lookupPilotSchedule(pilot).filter(s => s.roleId.startsWith("native")).every(s => !s.eligible)).toBe(true);
  const estimate = estimateLookupPilot(f); expect(estimate).toMatchObject({eligible: 4, skipped: 2, fullUpfrontComparisonUSD: 196});
  for (const path of paths.filter(p => p.role.startsWith("native"))) {
    path.initialTokens += 1000;
    path.initialAdmission = referenceFeasibility({calls: 0, bytes: 0, cumulativeBytes: 0, discovered: true}, f.workload.policy.budget, path);
    path.feasibility = externalPathFeasibility(path, f.workload.policy.budget);
    expect(path.feasibility.classification).toBe("feasible");
  }
  expect(estimateLookupPilot(f)).toEqual(estimate);
});

it("excludes small native paths even at the 150000-token floor when their input bound is feasible", async () => {
  const f = await fixture(), pilot = {registration: {common: f.workload, roles: LOOKUP_ROLES}, descriptor: lookupPilotDescriptor(f)};
  for (const path of f.workload.policy.budget.paths.filter(p => p.role.startsWith("native"))) {
    Object.assign(path, {method: "identifier-reference", initialTokens: 150000, initialContextBytes: 200000, calls: 2, bytes: 100, cumulativeBytes: 150});
    path.initialAdmission = referenceFeasibility({calls: 0, bytes: 0, cumulativeBytes: 0, discovered: true}, f.workload.policy.budget, path);
    path.feasibility = externalPathFeasibility(path, f.workload.policy.budget);
    expect(path.feasibility.classification).toBe("feasible");
  }
  expect(lookupPilotSchedule(pilot).filter(s => s.roleId.startsWith("native")).every(s => s.eligible === false)).toBe(true);
});
