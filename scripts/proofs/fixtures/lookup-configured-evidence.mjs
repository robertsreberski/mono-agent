import assert from "node:assert/strict";
export const CONFIGURED_PROOF_CASES = Object.freeze(["rounds", "cap", "limit", "sdk", "empty", "tier", "kill", "late"]);
export function assertConfiguredEvidence(evidence) {
  assert.equal(evidence.schema, "lookup-configured-full-proof-v1");
  assert.equal(evidence.complete, true, "partial/debug evidence is not a complete proof");
  assert.equal(Object.hasOwn(evidence, "failure"), false, "failed evidence cannot verify");
  assert.equal(typeof evidence.ci, "boolean");
  assert.deepEqual(evidence.results.map(row => row.case), CONFIGURED_PROOF_CASES);
  for (const row of evidence.results) {
    assert.ok(row.arrivals.length > 0); assert.deepEqual(row.errors ?? [], []);
    assert.ok(row.arrivals.every(a => a.holdConsumed === true && a.bothMarkers === true));
    assert.ok(row.metrics.length > 0 && row.metrics.every(m => m.preparationToolCalls === 64 && m.nativeSessions.length > 0 && m.nativeSessions.every(s => s.hostReplayTurns === 80 && s.restoredAtOriginalRoot)));
    const slots = row.state.slots.filter(s => s.worker), holds = slots.flatMap(s => s.holds);
    assert.ok(slots.length > 0 && holds.length > 0);
    const expectedStop = {rounds: "completed", cap: "budget_admission", limit: "lookup_repeated_loss", sdk: "lookup_repeated_loss", empty: "invalid_unit_rate", tier: "lookup_unknown_tier", kill: null, late: "lookup_worker_timeout"};
    assert.equal(row.state.stop, expectedStop[row.case]);
    const counts = new Map(); for (const a of row.arrivals) counts.set(a.slotId, (counts.get(a.slotId) ?? 0) + 1);
    assert.ok([...counts.values()].every(n => n === (row.case === "rounds" ? 3 : row.case === "limit" ? 10 : 1)));
    if (row.case === "rounds") {
      assert.deepEqual([...new Set(row.metrics.map(m => m.role))].sort(), ["pack", "pack-only", "shipping", "soul-only"]);
      assert.ok(holds.every(h => h.settlement?.kind === "settled"));
      assert.ok(row.arrivals.filter(a => a.number === 3).every(a => a.priorToolOutputs >= 2));
    }
    if (row.case === "cap") assert.ok(slots.some(s => s.guardRefusal === "not_admitted_cap"));
    if (row.case === "empty") assert.ok(slots.some(s => s.terminal === "pilot_empty_final_output"));
    if (row.case === "sdk") assert.ok(holds.every(h => h.settlement?.kind === "lost"));
    if (row.case === "kill") assert.equal(row.finalReconciliation.unreconciledGroups, 0);
    if (["kill", "late"].includes(row.case)) assert.ok(holds.every(h => !h.settlement));
    if (row.case === "late") {
      assert.equal(row.lateAvailable, 1); assert.equal(row.lateAcceptedSettles, 0);
      assert.equal(row.lateDelivery.attempted, true); assert.equal(row.providerTerminalDelivered, 0);
      assert.equal(row.lateDelivery.delivered, false); assert.equal(typeof row.lateDelivery.callbackError, "string");
      assert.ok(row.providerLateAvailableAt >= row.outerCompletedAt);
      assert.ok(row.metrics.every(m => m.observedOuterMs >= 600000 && m.observedOuterMs < 630000));
    }
  }
}
export function assertConfiguredEvidencePair(evidences) {
  assert.equal(evidences.length, 2, "require distinct normal and CI evidence files");
  for (const evidence of evidences) assertConfiguredEvidence(evidence);
  assert.deepEqual(evidences.map(e => e.ci).sort(), [false, true]);
}
