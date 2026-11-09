// Pure/offline preparation: no authorization, provider, model or registry is used.
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseE2Args } from "../continuity-e2.mjs";
import { normalizeE2Sizing, estimateE2SizingSet, E2_MAX_SIZING_RECORDS } from "../lib/continuity-e2-sizing.mjs";
import { protocolDigest } from "../lib/continuity-e2-protocol.mjs";
import { loadE2Catalog } from "../lib/continuity-e2-pricing.mjs";
const roots = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const fixture = async () => JSON.parse(await readFile(new URL("./fixtures/continuity-e2-cap-sizing.json", import.meta.url)));
function replay(f, summary = "faux-short") {
  return { schema: "continuity-e2-sizing-v1", sourceDigest: "a".repeat(64), protocolDigest: protocolDigest(f.protocol), summary,
    semanticQualification: false, usage: "estimated-not-measured", branches: f.protocol.branches.map((branch, index) => ({ branch: index,
      requestSizing: [f.sizing.variants[0].requests[1], f.sizing.variants[0].requests[3], f.sizing.variants[0].requests[2]].map(row => ({ ...row, turn: branch.checkpoints[0].turn, message: branch.checkpoints[0].message })) })) };
}
it("normalizes the new C1 and C2 paid-role evidence without copying private labels", async () => {
  const f = await fixture();
  expect(normalizeE2Sizing(f.protocol, f.sizing).requests).toHaveLength(5);
  expect(normalizeE2Sizing(f.protocol, replay(f)).requests).toHaveLength(6);
  const legacy = replay(f); delete legacy.branches[0].requestSizing;
  expect(() => normalizeE2Sizing(f.protocol, legacy)).toThrow("E2_SIZING_PAID_ROLE_REQUIRED");
  delete f.sizing.variants[0].requests[0].paidRole;
  expect(() => normalizeE2Sizing(f.protocol, f.sizing)).toThrow("E2_SIZING_PAID_ROLE_REQUIRED");
});
it("binds C1 sizing to the protocol and refuses inconsistent scenarios or duplicate proof arms", async () => {
  const f = await fixture(), catalog = await loadE2Catalog(), record = replay(f);
  record.protocolDigest = "b".repeat(64);
  expect(() => normalizeE2Sizing(f.protocol, record)).toThrow("E2_ESTIMATE_INVALID");
  expect(() => estimateE2SizingSet({ ...f, records: [f.sizing, f.sizing], catalog })).toThrow("E2_ESTIMATE_INVALID");
});
it("treats short/max replay sizing as alternative draws and expands explicit planned probe counts", async () => {
  const f = await fixture(), catalog = await loadE2Catalog(), records = [replay(f), replay(f, "faux-max")];
  const probeCounts = [0, 1, 2, 3].map(checkpoint => ({ checkpoint, questions: 2 }));
  const report = estimateE2SizingSet({ ...f, catalog, records, probeCounts });
  expect(report.scenarios).toHaveLength(2); expect(report.scenarios.map(s => s.totals.requests)).toEqual([10, 10]);
  expect(report.plannedReplayQuestions).toBe(8); expect(report.authorization).toBe(false);
  expect(report.worstCaseCapUnits).toBe(report.scenarios[0].totals.maximumUnits); // not the sum of alternative draws
  expect(() => estimateE2SizingSet({ ...f, catalog, records })).toThrow("E2_PROBE_COUNTS_REQUIRED");
});
it("exercises --estimate with private exclusive artifacts and only fixed content-free output", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "e2-estimator-cli-"))); roots.push(root);
  const f = await fixture(), protocol = join(root, "protocol.json"), sizing = join(root, "sizing.json"), limits = join(root, "limits.json"), output = join(root, "report");
  // Arbitrary private source strings are never copied from protocol metadata into the report.
  f.protocol.branches[0].checkpoints[0].name = "FICTIONAL-ESTIMATE-CANARY";
  for (const [path, value] of [[protocol, f.protocol], [sizing, f.sizing], [limits, { schema: "continuity-e2-estimate-limits-v1", roles: f.roles, probeCounts: [] }]]) await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  const calls = [], errors = [], io = { stdout: s => calls.push(s), stderr: s => errors.push(s) };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("network forbidden"); });
  const args = ["--estimate", "--protocol", protocol, "--limits", limits, "--sizing", sizing, "--output", output];
  expect(await main(args, io)).toBe(0); expect(fetch).not.toHaveBeenCalled(); expect(errors).toEqual([]);
  const report = JSON.parse(calls.join("")); expect(report.forecastMinimumCapUnits).toBe("4105809000"); expect(report.worstCaseCapUnits).toBe("11956000000");
  expect(await readFile(join(output, "estimate.json"), "utf8")).toBe(calls.join(""));
  expect((await stat(output)).mode & 0o777).toBe(0o700); expect((await stat(join(output, "estimate.json"))).mode & 0o777).toBe(0o600);
  for (const value of [root, "FICTIONAL-ESTIMATE-CANARY", "sourceDigest", "fileSha256", "accountCommitment"]) expect(calls.join("")).not.toContain(value);
  expect(await main(args, io)).toBe(1); expect(errors.pop()).toBe("EEXIST\n");
});
it("emits the specific legacy-sizing and unenforced-limit refusals before creating output", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "e2-estimator-refusal-"))); roots.push(root);
  const f = await fixture(), paths = ["protocol", "sizing", "limits"].map(n => join(root, `${n}.json`));
  const run = async () => {
    for (const [path, value] of paths.map((p, i) => [p, [f.protocol, f.sizing, { schema: "continuity-e2-estimate-limits-v1", roles: f.roles, probeCounts: [] }][i]])) await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    const errors = []; expect(await main(["--estimate", "--protocol", paths[0], "--sizing", paths[1], "--limits", paths[2], "--output", join(root, "absent")], { stdout: () => { throw Error("unexpected report"); }, stderr: s => errors.push(s) })).toBe(1);
    await expect(stat(join(root, "absent"))).rejects.toMatchObject({ code: "ENOENT" }); return errors;
  };
  delete f.sizing.variants[0].requests[0].paidRole; expect(await run()).toEqual(["E2_SIZING_PAID_ROLE_REQUIRED\n"]);
  f.sizing.variants[0].requests[0].paidRole = null; f.roles[0].maxOutputTokens = 4096; f.roles[0].expectedOutputTokens = 1024;
  expect(await run()).toEqual(["E2_OUTPUT_LIMIT_UNENFORCED\n"]);
});
it("accepts repeated sizing files only on the estimate entry", () => {
  expect(parseE2Args(["--estimate", "--protocol", "p", "--limits", "l", "--sizing", "a", "--sizing", "b", "--output", "o"]).sizing).toEqual(["a", "b"]);
  expect(() => parseE2Args(["size", "--source", "s", "--source", "t", "--protocol", "p", "--output", "o"])).toThrow("E2_ARGUMENTS_INVALID");
});

it("refuses unordered or same-turn checkpoints before positional sizing association", async () => {
  for (const equal of [false, true]) {
    const f = await fixture();
    if (equal) f.protocol.branches[0].checkpoints[1].turn = f.protocol.branches[0].checkpoints[0].turn;
    else f.protocol.branches[0].checkpoints.reverse();
    expect(() => normalizeE2Sizing(f.protocol, f.sizing)).toThrow("E2_CHECKPOINT_ORDER_INVALID");
  }
});
it("funds the registered maximum role budgets across alternatives, not just the largest single scenario", async () => {
  const f = await fixture(), catalog = await loadE2Catalog(), records = [replay(f), replay(f, "faux-max")];
  for (const branch of records[1].branches) {
    const old = branch.requestSizing[0]; branch.requestSizing[0] = { ...f.sizing.variants[0].requests[4], turn: old.turn, message: old.message };
  }
  const probeCounts = [0, 1, 2, 3].map(checkpoint => ({ checkpoint, questions: 1 }));
  const report = estimateE2SizingSet({ ...f, catalog, records, probeCounts });
  expect(BigInt(report.worstCaseCapUnits)).toBe(BigInt(report.scenarios[0].worstCaseCapUnits) + 2n * 196000000n);
  expect(report.fundedSchedule.totals.requests).toBe(8);
  expect(report.forecastMinimumCapUnits).toBe(report.fundedSchedule.forecastMinimumCapUnits);
});

it("projects the specific checkpoint-order refusal at the CLI without creating output", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "e2-estimator-order-"))); roots.push(root);
  const f = await fixture(); f.protocol.branches[0].checkpoints.reverse();
  const protocol = join(root, "protocol.json"), sizing = join(root, "sizing.json"), limits = join(root, "limits.json"), output = join(root, "absent");
  for (const [path, value] of [[protocol, f.protocol], [sizing, f.sizing], [limits, { schema: "continuity-e2-estimate-limits-v1", roles: f.roles, probeCounts: [] }]]) await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  const errors = [];
  expect(await main(["--estimate", "--protocol", protocol, "--sizing", sizing, "--limits", limits, "--output", output], { stdout: () => { throw Error("unexpected_report"); }, stderr: value => errors.push(value) })).toBe(1);
  expect(errors).toEqual(["E2_CHECKPOINT_ORDER_INVALID\n"]); await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
});

it("shares the sizing-record cap between argument parsing and estimation", async () => {
  const args = count => ["--estimate", "--protocol", "protocol.json", "--limits", "limits.json", "--output", "output", ...Array.from({ length: count }, (_, i) => ["--sizing", `sizing-${i}.json`]).flat()];
  expect(parseE2Args(args(E2_MAX_SIZING_RECORDS)).sizing).toHaveLength(E2_MAX_SIZING_RECORDS);
  expect(() => parseE2Args(args(E2_MAX_SIZING_RECORDS + 1))).toThrow("E2_ARGUMENTS_INVALID");
  const f = await fixture(), catalog = await loadE2Catalog();
  expect(() => estimateE2SizingSet({ ...f, records: Array.from({ length: E2_MAX_SIZING_RECORDS + 1 }, () => f.sizing), catalog })).toThrow("E2_ESTIMATE_INVALID");
});
it("refuses an over-budget proof aggregate by policy, not the engine argument limit", async () => {
  const f = await fixture(), catalog = await loadE2Catalog(), row = f.sizing.variants[0].requests[0];
  f.sizing.variants = ["ceiling", "restart"].map(variant => ({ variant, requests: Array.from({ length: 100000 }, (_, ordinal) => ({ ...row, ordinal })) }));
  expect(normalizeE2Sizing(f.protocol, f.sizing).requests).toHaveLength(200000);
  expect(() => estimateE2SizingSet({ ...f, records: [f.sizing], catalog })).toThrow("E2_ESTIMATE_INVALID");
});
