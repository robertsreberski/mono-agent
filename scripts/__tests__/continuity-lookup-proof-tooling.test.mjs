import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm, truncate, link, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retainedSync } from "../proofs/fixtures/lookup-configured-retained.mjs";
import { lookupRetainedBytes } from "../lib/continuity-lookup-preparation.mjs";
import { lookupDependencyWitness } from "../lib/continuity-proof-tooling.mjs";
import { assertConfiguredEvidence, assertConfiguredEvidencePair, CONFIGURED_PROOF_CASES } from "../proofs/fixtures/lookup-configured-evidence.mjs";

function evidence(ci = false) {
  const stops = ["completed", "budget_admission", "lookup_repeated_loss", "lookup_repeated_loss", "invalid_unit_rate", "lookup_unknown_tier", null, "lookup_worker_timeout"];
  return {schema: "lookup-configured-full-proof-v1", complete: true, ci, ciValue: ci ? "1" : null, results: CONFIGURED_PROOF_CASES.map((name, index) => {
    const roles = name === "rounds" ? ["pack", "pack-only", "shipping", "soul-only"] : ["pack"];
    return {case: name, errors: [], state: {stop: stops[index], slots: roles.map(role => ({slotId: role, worker: {}, guardRefusal: "not_admitted_cap", terminal: "pilot_empty_final_output", holds: [{settlement: ["kill", "late"].includes(name) ? null : {kind: name === "sdk" ? "lost" : "settled"}}]}))},
      arrivals: roles.flatMap(role => Array.from({length: name === "rounds" ? 3 : name === "limit" ? 10 : 1}, (_, n) => ({slotId: role, number: n + 1, priorToolOutputs: n, holdConsumed: true, bothMarkers: true}))),
      metrics: roles.map(role => ({role, preparationToolCalls: 64, nativeSessions: [{hostReplayTurns: 80, restoredAtOriginalRoot: true}], observedOuterMs: 600100})),
      finalReconciliation: {unreconciledGroups: 0}, lateAvailable: 1, lateAcceptedSettles: 0, providerTerminalDelivered: 0,
      lateDelivery: {attempted: true, delivered: false, destroyedBeforeWrite: true, callbackError: "ERR_STREAM_DESTROYED"}, providerLateAvailableAt: 2, outerCompletedAt: 1};
  })};
}
it("requires complete successful evidence and distinct CI modes", () => {
  expect(() => assertConfiguredEvidencePair([evidence(), evidence(true)])).not.toThrow();
  for (const patch of [{schema: "other"}, {complete: false}, {failure: "fictional failure"}, {results: evidence().results.slice(-1)}, {results: []}]) {
    expect(() => assertConfiguredEvidence({...evidence(), ...patch})).toThrow();
  }
  expect(() => assertConfiguredEvidencePair([evidence()])).toThrow();
  expect(() => assertConfiguredEvidencePair([evidence(), evidence()])).toThrow();
  for (const mutate of [e => e.results[7].lateDelivery.attempted = false, e => e.results[0].metrics.pop(), e => e.results[3].state.stop = "completed"]) {
    const e = evidence(); mutate(e); expect(() => assertConfiguredEvidence(e)).toThrow();
  }
});
it.each(["other_error", null, undefined])("requires the observed destroyed-stream error, not %s", callbackError => {
  const e = evidence(); e.results[7].lateDelivery.callbackError = callbackError;
  expect(() => assertConfiguredEvidence(e)).toThrow();
});
it("requires the response to be destroyed before the late write", () => {
  const e = evidence(); e.results[7].lateDelivery.destroyedBeforeWrite = false;
  expect(() => assertConfiguredEvidence(e)).toThrow();
});
it.each(["0", "", "true", null, undefined])("rejects CI evidence with actual CI=%s", ciValue => {
  const e = evidence(true); e.ciValue = ciValue;
  expect(() => assertConfiguredEvidencePair([evidence(), e])).toThrow();
});
it.each(["0", "", "1"])("does not relabel a present CI=%s as normal", ciValue => {
  const e = evidence(); e.ciValue = ciValue;
  expect(() => assertConfiguredEvidence(e)).toThrow();
});
it.each(["true", 1, {}, undefined, false])("requires a boolean original-root restoration witness, not %j", restored => {
  const e = evidence(); e.results[0].metrics[0].nativeSessions[0].restoredAtOriginalRoot = restored;
  expect(() => assertConfiguredEvidence(e)).toThrow();
});
it.each(["foreign", "missing"])("binds arrival slot IDs to worker slots: %s", variant => {
  const e = evidence(), row = e.results[0];
  if (variant === "foreign") for (const arrival of row.arrivals) {if (arrival.slotId === "pack") arrival.slotId = "foreign-slot";}
  else row.arrivals = row.arrivals.filter(a => a.slotId !== "pack");
  expect(() => assertConfiguredEvidence(e)).toThrow();
});
it.each([[1, 2, 2], [1, 2, 4], [1, 1, 1], [0, 1, 2], ["1", "2", "3"]])("requires each slot's exact three round labels: %j/%j/%j", (...numbers) => {
  const e = evidence(), arrivals = e.results[0].arrivals.filter(a => a.slotId === "pack");
  arrivals.forEach((a, i) => a.number = numbers[i]);
  expect(() => assertConfiguredEvidence(e)).toThrow();
});
it("requires two prior tool outputs at the now-mandatory third round", () => {
  const e = evidence(); e.results[0].arrivals.find(a => a.slotId === "pack" && a.number === 3).priorToolOutputs = 1;
  expect(() => assertConfiguredEvidence(e)).toThrow();
});
it("accepts valid rounds regardless of arrival order", () => {
  const e = evidence(); e.results[0].arrivals.reverse();
  expect(() => assertConfiguredEvidence(e)).not.toThrow();
});
it("restores the fixture environment even when its cleanup snapshot assertion throws", async () => {
  const base = await mkdtemp(join(tmpdir(), "lookup-env-finally-")), original = {...process.env};
  process.env.FICTIONAL_FIXTURE_ORIGINAL = "before";
  const previous = {...process.env}, snapshot = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([["changed"]]);
  vi.resetModules();
  vi.doMock("./fixtures/lookup-leaf-witness.mjs", () => ({dependencyLeafSnapshot: snapshot}));
  vi.doMock("./fixtures/holdout-synthetic.mjs", () => ({
    syntheticContext: async () => {
      expect(process.env.HOME).toBe(join(base, "build-home"));
      delete process.env.FICTIONAL_FIXTURE_ORIGINAL; process.env.FICTIONAL_FIXTURE_ADDED = "during";
      throw Error("fictional_setup_failure");
    }, fixtureGit: vi.fn(), fixtureCommit: vi.fn(), fixtureLookupPolicy: vi.fn(),
  }));
  try {
    const {fullConfiguredFixture} = await import("../proofs/fixtures/lookup-configured-fixture.mjs");
    await expect(fullConfiguredFixture(join(base, "source"), base)).rejects.toThrow("fixture build mutated shared dependency leaves");
    expect(snapshot).toHaveBeenCalledTimes(2);
    // Compare without printing any inherited environment values on a failure.
    expect(Object.keys(process.env).sort()).toEqual(Object.keys(previous).sort());
    for (const [key, value] of Object.entries(previous)) expect(process.env[key] === value, "original environment value restored").toBe(true);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original);
    vi.doUnmock("./fixtures/lookup-leaf-witness.mjs"); vi.doUnmock("./fixtures/holdout-synthetic.mjs"); vi.resetModules();
    await rm(base, {recursive: true, force: true});
  }
});
it("pins synchronous retained accounting to async preflight accounting across every category", async () => {
  const base = await mkdtemp(join(tmpdir(), "lookup-retained-parity-")), slot = join(base, "slot");
  const directories = [["", "otherBytes"], ["checkpoint", "otherBytes"], ["checkpoint/snapshot", "snapshotBytes"], ["checkpoint/snapshot/deep", "snapshotBytes"], ["checkpoint/work", "workBytes"], ["checkpoint/lease-home", "homeBytes"], ["probe-home", "homeBytes"], ["checkpoint/snapshot-neighbor", "otherBytes"], ["checkpoint/work-neighbor", "otherBytes"], ["checkpoint/lease-home-neighbor", "otherBytes"], ["checkpoint-other", "otherBytes"]];
  const files = [["checkpoint/snapshot/deep/sparse", "snapshotBytes"], ["checkpoint/work/allocated", "workBytes"], ["checkpoint/lease-home/state", "homeBytes"], ["probe-home/state", "homeBytes"], ["receipt.json", "homeBytes"]];
  try {
    for (const [path] of directories) await mkdir(join(slot, path));
    for (const [path] of files) await writeFile(join(slot, path), Buffer.alloc(4097, 7));
    await truncate(join(slot, files[0][0]), 2 * 1024 * 1024);
    await link(join(slot, "checkpoint/work/allocated"), join(slot, "checkpoint/snapshot/linked"));
    await writeFile(join(base, "outside-target"), Buffer.alloc(65536, 7));
    await symlink(join(base, "outside-target"), join(slot, "probe-home/pointer"));
    const expected = {snapshotBytes: 0, workBytes: 0, homeBytes: 0, otherBytes: 0};
    for (const [path, field] of [...directories, ...files, ["checkpoint/snapshot/linked", "snapshotBytes"], ["probe-home/pointer", "homeBytes"]]) {
      const stat = await lstat(join(slot, path)); expected[field] += Math.max(stat.size, stat.blocks * 512);
    }
    expected.retainedBytes = Object.values(expected).reduce((a, b) => a + b, 0);
    expect(retainedSync(slot)).toEqual(expected); expect(await lookupRetainedBytes(slot)).toEqual(expected);
  } finally {await rm(base, {recursive: true, force: true});}
});
it("verifies dependency lock/importer/links read-only and rejects mismatches", async () => {
  const root = await mkdtemp(join(tmpdir(), "lookup-dependency-witness-"));
  try {
    await mkdir(join(root, "node_modules/.pnpm"), {recursive: true}); await mkdir(join(root, "fixture-dep"));
    const manifest = {dependencies: {"fictional-dep": "1.0.0"}};
    const lock = JSON.stringify({importers: {".": {dependencies: {"fictional-dep": {specifier: "1.0.0", version: "1.0.0"}}}}});
    await writeFile(join(root, "package.json"), JSON.stringify(manifest)); await writeFile(join(root, "pnpm-workspace.yaml"), "{}");
    await writeFile(join(root, "pnpm-lock.yaml"), lock); await writeFile(join(root, "node_modules/.pnpm/lock.yaml"), lock);
    await writeFile(join(root, "fixture-dep/package.json"), JSON.stringify({name: "fictional-dep", version: "1.0.0"}));
    await symlink(join(root, "fixture-dep"), join(root, "node_modules/fictional-dep"));
    const before = await lookupDependencyWitness(root); expect(await lookupDependencyWitness(root)).toEqual(before); expect(before.links).toHaveLength(1);
    const reordered = JSON.parse(lock); reordered.overrides = {"fictional-a": "1", "fictional-b": "2"};
    await writeFile(join(root, "pnpm-lock.yaml"), JSON.stringify(reordered)); await writeFile(join(root, "node_modules/.pnpm/lock.yaml"), JSON.stringify(reordered));
    await writeFile(join(root, "pnpm-workspace.yaml"), JSON.stringify({overrides: {"fictional-b": "2", "fictional-a": "1"}}));
    await expect(lookupDependencyWitness(root)).resolves.toHaveProperty("links");
    await writeFile(join(root, "fixture-dep/package.json"), JSON.stringify({name: "fictional-dep", version: "2.0.0"}));
    await expect(lookupDependencyWitness(root)).rejects.toThrow("lookup_dependency_lock_mismatch");
    await writeFile(join(root, "node_modules/.pnpm/lock.yaml"), "{}");
    await expect(lookupDependencyWitness(root)).rejects.toThrow("lookup_dependency_lock_mismatch");
  } finally {await rm(root, {recursive: true, force: true});}
});
