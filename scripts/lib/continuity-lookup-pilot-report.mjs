import { LOOKUP_PRE_SEND_REFUSALS } from "./continuity-lookup-guard.mjs";
import { digest } from "./continuity-dataset.mjs";
import { accountLookupPilot, lookupDollars, pilotNeed, LOOKUP_PILOT_STOPS } from "./continuity-lookup-pilot-accounting.mjs";
import { LOOKUP_REAL_CONTROLLER, pilotHash, pilotId, samePilot } from "./continuity-lookup-pilot-state.mjs";

/** Explicit projection: no paths, path digests, commitments, requests, answers or errors. */
export function lookupPilotReceipt(state, index) {
  const slot = state.slots[index], planned = state.schedule[index];
  pilotNeed(pilotId(state.runId) && pilotHash(planned.slotId) && slot.slotId === planned.slotId && ["completed", "wrong", "lost", "own_abort_after_send", "pilot_empty_final_output", "store_degraded", "boundary_unverified", "pressure_unverified", "integrity_stop", "skipped", "unadmitted", "refused_pre_send", null].includes(slot.terminal)
    && [null, 0, 1].includes(slot.score) && (["completed", "wrong"].includes(slot.terminal) || slot.score === null), "lookup_receipt_invalid");
  const bindings = { ...state.publicBindings[planned.code], sourceSha256: state.publicSources[planned.suite] };
  pilotNeed(/^[a-f0-9]{40}$/u.test(bindings.revision)
    && ["buildSha256", "sourceSha256", "protocolSha256"].every(k => pilotHash(bindings[k])), "lookup_receipt_invalid");
  const a = accountLookupPilot([slot]), holds = slot.holds ?? [];
  const terminalCode = slot.admissionRefusal ?? slot.guardRefusal ?? holds.at(-1)?.settlement?.code ?? slot.terminal;
  pilotNeed(terminalCode === null || LOOKUP_PILOT_STOPS.includes(terminalCode) || LOOKUP_PRE_SEND_REFUSALS.includes(terminalCode)
    || ["wrong", "lost", "own_abort_after_send", "pilot_empty_final_output", "store_degraded", "boundary_unverified", "pressure_unverified", "integrity_stop", "skipped", "unadmitted", "refused_pre_send"].includes(terminalCode), "lookup_receipt_invalid");
  let input = 0, output = 0;
  for (const h of holds) { input += h.settlement?.rawUsage?.input_tokens ?? 0; output += h.settlement?.rawUsage?.output_tokens ?? 0; }
  const row = { schema: "lookup-pilot-slot-receipt-v1", runId: state.runId, slotId: planned.slotId, position: index, role: planned.roleId,
    binding: Object.fromEntries(["revision", "buildSha256", "sourceSha256", "protocolSha256"].map(key => [key, bindings[key]])), qualityMeasured: state.schema === LOOKUP_REAL_CONTROLLER, eligible: planned.eligible,
    admitted: holds.length > 0, terminal: slot.terminal, terminalCode, score: slot.score,
    calls: { admitted: holds.length, consumed: holds.filter(h => h.consumed).length, settled: holds.filter(h => h.settlement).length },
    usage: { inputTokens: input, outputTokens: output },
    costs: { completeUSD: lookupDollars(a.completeUnits), retainedUSD: lookupDollars(a.retainedUnits),
      activeUSD: lookupDollars(a.activeUnits), knownPartialUSD: lookupDollars(a.knownPartialUnits) },
    holds: holds.map(h => ({ permitId: h.permitId, consumed: h.consumed, retained: h.settlement?.kind !== "settled",
      reservationUSD: lookupDollars(h.reservedUnits), knownPartialUSD: lookupDollars(h.settlement?.knownUnits ?? "0") })) };
  return { ...row, sha256: digest(row) };
}
export function aggregateLookupPilot(state, receipts) {
  pilotNeed(Number.isSafeInteger(state.cursor) && state.cursor >= 0 && state.cursor <= state.schedule.length, "lookup_receipt_invalid");
  const visited = state.cursor + (state.slots[state.cursor]?.worker || state.slots[state.cursor]?.holds?.length ? 1 : 0);
  const seen = new Set();
  for (const row of receipts) {
    pilotNeed(Number.isSafeInteger(row?.position) && row.position >= 0 && row.position < visited && state.schedule[row.position]?.slotId === row.slotId && !seen.has(row.slotId)
      && samePilot(row, lookupPilotReceipt(state, row.position)), "lookup_receipt_invalid");
    seen.add(row.slotId);
  }
  pilotNeed(state.stop === null || LOOKUP_PILOT_STOPS.includes(state.stop), "lookup_receipt_invalid");
  const counts = { planned: state.schedule.length, eligible: state.schedule.filter(s => s.eligible).length,
    skipped: 0, unadmitted: 0, admitted: 0, completed: 0, incomplete: 0, invalid: 0, missing: 0 };
  for (let i = 0; i < visited; i++) {
    const planned = state.schedule[i], slot = state.slots[i];
    if (!seen.has(planned.slotId)) counts.missing++;
    if (!planned.eligible) { counts.skipped++; continue; }
    if (!slot.holds.length) { counts.unadmitted++; continue; }
    const a = accountLookupPilot([slot]); counts.admitted++; counts.completed += a.completed;
    counts.incomplete += a.incomplete + (slot.terminal ? 0 : 1); counts.invalid += a.invalid;
  }
  const blocks = new Map();
  for (const row of receipts) if (row.position < visited && ["completed", "wrong"].includes(row.terminal) && row.admitted) {
    const s = state.schedule[row.position], key = digest([s.suite, s.traceId, s.probeId]);
    if (!blocks.has(key)) blocks.set(key, new Set()); blocks.get(key).add(row.role);
  }
  const spend = accountLookupPilot(state.slots);
  return { schema: "lookup-pilot-report-v1", runId: state.runId, executionKind: state.schema === LOOKUP_REAL_CONTROLLER ? "authorized-pilot" : "faux-only", authorizedSpend: state.schema === LOOKUP_REAL_CONTROLLER, qualityMeasured: state.schema === LOOKUP_REAL_CONTROLLER, counts,
    pairedCoverage: { completeBlocks: [...blocks.values()].filter(v => v.size === state.roleCount).length },
    schedule: { visited, truncated: visited < state.schedule.length, remaining: state.schedule.length - visited },
    stop: state.stop, cost: { capUSD: state.capUSD, reservationUSD: state.rmaxUSD, totalUSD: lookupDollars(spend.totalUnits), knownPartialUSD: lookupDollars(spend.knownPartialUnits) },
    receipts: [...receipts].sort((a, b) => a.position - b.position) };
}
