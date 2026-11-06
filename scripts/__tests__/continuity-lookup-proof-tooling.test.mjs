import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupDependencyWitness } from "../lib/continuity-proof-tooling.mjs";
import { assertConfiguredEvidence, assertConfiguredEvidencePair, CONFIGURED_PROOF_CASES } from "../proofs/fixtures/lookup-configured-evidence.mjs";

function evidence(ci = false) {
  const stops = ["completed", "budget_admission", "lookup_repeated_loss", "lookup_repeated_loss", "invalid_unit_rate", "lookup_unknown_tier", null, "lookup_worker_timeout"];
  return {schema: "lookup-configured-full-proof-v1", complete: true, ci, results: CONFIGURED_PROOF_CASES.map((name, index) => {
    const roles = name === "rounds" ? ["pack", "pack-only", "shipping", "soul-only"] : ["pack"];
    return {case: name, errors: [], state: {stop: stops[index], slots: roles.map(role => ({worker: {}, guardRefusal: "not_admitted_cap", terminal: "pilot_empty_final_output", holds: [{settlement: ["kill", "late"].includes(name) ? null : {kind: name === "sdk" ? "lost" : "settled"}}]}))},
      arrivals: roles.flatMap(role => Array.from({length: name === "rounds" ? 3 : name === "limit" ? 10 : 1}, (_, n) => ({slotId: role, number: n + 1, priorToolOutputs: n, holdConsumed: true, bothMarkers: true}))),
      metrics: roles.map(role => ({role, preparationToolCalls: 64, nativeSessions: [{hostReplayTurns: 80, restoredAtOriginalRoot: true}], observedOuterMs: 600100})),
      finalReconciliation: {unreconciledGroups: 0}, lateAvailable: 1, lateAcceptedSettles: 0, providerTerminalDelivered: 0,
      lateDelivery: {attempted: true, delivered: false, callbackError: "ERR_STREAM_DESTROYED"}, providerLateAvailableAt: 2, outerCompletedAt: 1};
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
    await writeFile(join(root, "fixture-dep/package.json"), JSON.stringify({name: "fictional-dep", version: "2.0.0"}));
    await expect(lookupDependencyWitness(root)).rejects.toThrow("lookup_dependency_lock_mismatch");
    await writeFile(join(root, "node_modules/.pnpm/lock.yaml"), "{}");
    await expect(lookupDependencyWitness(root)).rejects.toThrow("lookup_dependency_lock_mismatch");
  } finally {await rm(root, {recursive: true, force: true});}
});
