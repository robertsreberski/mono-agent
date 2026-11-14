// Key-blind local inference only; four alternatives are not four paid runs.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registrationTrace } from "./fixtures/continuity-e2-registration.mjs";
import * as sizingModels from "../lib/continuity-e2-models.mjs";
import { e2SizingIdentity, assertE2SizingIdentity } from "../lib/continuity-e2-sizing-identity.mjs";
import { productionModules } from "../lib/continuity-runner.mjs";
import { ROOT } from "../lib/continuity-observation-input.mjs";
import { runE2Sizing } from "../lib/continuity-e2-replay.mjs";
import { E2_REPLAY_SCENARIOS, E2_PROTECTED_SIZING, E2_PROTECTED_TEXT, protectedE2Reply } from "../lib/continuity-e2-protected.mjs";
import { normalizeE2Sizing, requireProtectedE2Sizing, estimateE2SizingSet, E2_MAX_SIZING_RECORDS } from "../lib/continuity-e2-sizing.mjs";
import { e2PhaseSchedule } from "../lib/continuity-e2-registration.mjs";
import { loadE2Catalog } from "../lib/continuity-e2-pricing.mjs";
import { parseE2Args } from "../continuity-e2.mjs";
import { historicalTuples } from "../../packages/turn/dist/engine/compaction-kit/historical-preservation.js";
vi.mock("../lib/continuity-e2-sizing-identity.mjs", async original => {
  const actual = await original(); return { ...actual, e2SizingIdentity: vi.fn(actual.e2SizingIdentity) };
});
const roots = [];
afterAll(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("keeps literal fictional framing and duplicate blocks, and drops exactly one tuple", () => {
  const blocks = historicalTuples(E2_PROTECTED_TEXT), context = { messages: [{ role: "user", content: `<protected-historical-tuples>\n${JSON.stringify(blocks)}\n</protected-historical-tuples>` }] };
  expect(historicalTuples(protectedE2Reply(context))).toEqual(blocks);
  expect(historicalTuples(protectedE2Reply(context, true))).toEqual(blocks.slice(0, -1));
  expect(blocks.at(-1)).toBe(blocks.at(-2));
  expect(protectedE2Reply(context)).toContain("```text\nFictional literal framing; marker m4.\n```");
  for (const summary of E2_REPLAY_SCENARIOS) expect(parseE2Args(["size", "--source", "fictional", "--protocol", "fictional", "--output", "fictional", "--summary", summary]).summary).toBe(summary);
  expect(() => parseE2Args(["run", "--summary", "protected-exact", "--registration", "fictional", "--sha256", "fictional", "--authorization", "fictional", "--credentials", "fictional", "--output", "fictional"])).toThrow("E2_ARGUMENTS_INVALID");
});
it("compares every source, code, build and runtime identity component", () => {
  const identity = { sourceHead: "a".repeat(40), sourceDirty: false, codeSha256: "b".repeat(64), buildOutputSha256: "c".repeat(64), node: process.version };
  expect(() => assertE2SizingIdentity(identity, { ...identity })).not.toThrow();
  for (const key of Object.keys(identity)) expect(() => assertE2SizingIdentity(identity, { ...identity, [key]: key === "sourceDirty" ? true : "different" })).toThrow("E2_PROTECTED_SIZING_INVALID");
});
describe.sequential("four replay alternatives", () => {
  const records = []; let root, source, protocol;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "e2-protected-sizing-")); roots.push(root); vi.stubEnv("HOME", root);
    const snapshots = join(root, "snapshots"); await mkdir(snapshots);
    ({ source, protocol } = await registrationTrace(snapshots)); protocol.probeLookupRounds = 3;
    for (const branch of protocol.branches) { branch.limits.probeRequests = 64; branch.exclusions.coverage = source.coverage.flatMap((gap, i) => gap.tier === "replay" ? [i] : []); }
    // Source tooling is existing loopback-only replay; fetch must never leave it.
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (url, ...args) => { const u = new URL(typeof url === "string" ? url : url.url ?? url); if (u.hostname !== "127.0.0.1") throw Error("External network forbidden"); return nativeFetch(url, ...args); });
  });
  // Separate bounded cases keep a long sequence from timing out under the full
  // suite's parallel CPU load; no timeout or product retry allowance is raised.
  it.each(E2_REPLAY_SCENARIOS)("produces %s through local shipping paths", async summary => {
    records.push(await runE2Sizing({ source, protocol, output: join(root, summary), summary }));
  }, 180000);
  it("funds the count/size union within eight files", async () => {
    expect(records.map(r => r.summary)).toEqual(E2_REPLAY_SCENARIOS);
    expect(records.every(r => r.schema === "continuity-e2-sizing-v3" && r.qualification === true)).toBe(true);
    for (const record of records.slice(2)) {
      expect(record.schema).toBe("continuity-e2-sizing-v3");
      expect(record.protectedSizing.contract).toBe(E2_PROTECTED_SIZING);
      expect(record.protectedSizing.controls).toHaveLength(8);
      expect(record.protectedSizing.identity).toMatchObject({ codeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u), buildOutputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u), sourceHead: expect.stringMatching(/^[a-f0-9]{40}$/u), node: process.version });
      for (const c of record.protectedSizing.controls) {
        expect(c.committed).toBe(true);
        if (record.summary === "protected-refusal" && !c.fallback) expect(c).toMatchObject({ noncommitObserved: true, unchangedRefusalSuppressed: true, growthQualified: true });
        for (const row of c.requests) expect(row).toMatchObject({ role: row.paidRole === null ? "setup-scripted" : "summary", paidRole: row.paidRole, size: { method: "intercepted-full-models-context", serializedBytes: expect.any(Number) } });
      }
    }
    expect(() => requireProtectedE2Sizing(records)).not.toThrow();
    expect(() => requireProtectedE2Sizing(records.slice(0, 2))).toThrow("E2_ESTIMATE_INVALID");
    const { roles, sizing } = JSON.parse(await readFile(new URL("./fixtures/continuity-e2-cap-sizing.json", import.meta.url))), catalog = await loadE2Catalog();
    for (const role of roles) role.maxInputTokens = 272000;
    const probeCounts = protocol.branches.flatMap(b => b.checkpoints).map((_, checkpoint) => ({ checkpoint, questions: 1 }));
    const normal = records.map(r => normalizeE2Sizing(protocol, r)), schedule = e2PhaseSchedule(protocol, records, probeCounts);
    expect(schedule).toHaveLength(1);
    for (const budget of schedule[0].budgets) expect(budget.maxRequests).toBe(Math.max(...normal.map(n => n.requests.filter(r => r.checkpoint === budget.checkpoint && r.paidRole === budget.paidRole && r.model === budget.model).length)));
    const estimate = estimateE2SizingSet({ protocol, records, roles, catalog, probeCounts });
    expect(estimate.scenarios).toHaveLength(4); expect(estimate.plannedReplayQuestions).toBe(4);
    const proofRecords = ["switch", "cancel", "idle", "pressure"].map(arm => ({ ...structuredClone(sizing), arm }));
    expect([...records, ...proofRecords]).toHaveLength(E2_MAX_SIZING_RECORDS);
    expect(() => estimateE2SizingSet({ protocol, records: [...records, ...proofRecords], roles, catalog, probeCounts })).not.toThrow();
    // Replacing one protected observation by a larger full request must increase
    // the union forecast, without changing its request counts or adding paid runs.
    const larger = structuredClone(records), row = larger[3].protectedSizing.controls[0].requests.find(r => r.paidRole === "summary");
    row.size.serializedBytes = 600000; row.size.serializedBytesOver3 = 200000; row.size.maximum = Math.max(200000, row.size.engineFullRequest);
    const inflated = estimateE2SizingSet({ protocol, records: larger, roles, catalog, probeCounts });
    expect(BigInt(inflated.forecastNoCacheMinimumCapUnits)).toBeGreaterThan(BigInt(estimate.forecastNoCacheMinimumCapUnits));
    expect(inflated.fundedSchedule.totals.requests).toBe(estimate.fundedSchedule.totals.requests);
    const identity = records[2].protectedSizing.identity, registration = { code: { revision: identity.sourceHead, sha256: identity.codeSha256 }, build: { outputSha256: identity.buildOutputSha256, node: identity.node } };
    const bound = structuredClone(records); for (const r of bound) { r.sizingIdentity.sourceDirty = false; if (r.protectedSizing) r.protectedSizing.identity.sourceDirty = false; }
    expect(() => requireProtectedE2Sizing(bound, registration)).not.toThrow();
    for (const index of [0, 1, 2, 3]) for (const field of ["sourceHead", "codeSha256", "buildOutputSha256", "node"]) {
      const bad = structuredClone(bound); bad[index].sizingIdentity[field] = "f".repeat(field === "sourceHead" ? 40 : 64);
      if (bad[index].protectedSizing) bad[index].protectedSizing.identity[field] = bad[index].sizingIdentity[field];
      expect(() => requireProtectedE2Sizing(bad, registration)).toThrow("E2_ESTIMATE_INVALID");
    }
    const legacy = structuredClone(records);
    for (const r of legacy) { r.schema = r.summary.startsWith("protected-") ? "continuity-e2-sizing-v2" : "continuity-e2-sizing-v1"; delete r.sizingIdentity; delete r.qualification; }
    expect(() => estimateE2SizingSet({ protocol, records: legacy, roles, catalog, probeCounts })).not.toThrow();
    expect(() => requireProtectedE2Sizing([legacy[0], ...bound.slice(1)], registration)).toThrow("E2_ESTIMATE_INVALID");
    // Emit content-free maxima for the delivery's local cost forecast evidence.
    console.log(JSON.stringify(records.map(r => ({ scenario: r.summary, maxima: Object.fromEntries(["summary", "probe", "continuation"].map(role => {
      const rows = normalizeE2Sizing(protocol, r).requests.filter(row => row.paidRole === role);
      return [role, { maximum: Math.max(0, ...rows.map(row => row.size.maximum)), serializedBytes: Math.max(0, ...rows.map(row => row.size.serializedBytes)) }];
    })) }))));
  }, 180000);
  it("refuses a rebuild identity change during real protected measurements", async () => {
    const identity = await e2SizingIdentity(), output = join(root, "identity-race"); let observed = 0;
    const calls = vi.mocked(e2SizingIdentity).mock.calls.length, originalLoader = sizingModels.loadE2Estimators;
    const loader = vi.spyOn(sizingModels, "loadE2Estimators").mockImplementation(async (...args) => {
      expect(vi.mocked(e2SizingIdentity).mock.calls).toHaveLength(calls + 1); return originalLoader(...args);
    });
    vi.mocked(e2SizingIdentity).mockResolvedValueOnce(identity).mockResolvedValueOnce({ ...identity, buildOutputSha256: "f".repeat(64) });
    try {
      await expect(runE2Sizing({ source, protocol, output, summary: "protected-exact", onContext: () => { observed++; } })).rejects.toThrow("E2_PROTECTED_SIZING_INVALID");
      expect(observed).toBeGreaterThan(0); expect(loader).toHaveBeenCalled(); await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { loader.mockRestore(); }
  }, 180000);
  it("marks injected product modules non-qualifying and refuses registration", async () => {
    const record = await runE2Sizing({ source, protocol, output: join(root, "injected"), summary: "protected-exact", modules: await productionModules(ROOT) });
    expect(record.qualification).toBe(false);
    expect(() => requireProtectedE2Sizing([...records.slice(0, 2), record, records[3]])).toThrow("E2_ESTIMATE_INVALID");
  }, 180000);

});
