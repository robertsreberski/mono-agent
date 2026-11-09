// Shared guarded-run mechanics; policy is selected only by a closed protocol id.
import { digest } from "./continuity-dataset.mjs";
import { guardedProtocol } from "./continuity-guarded-protocols.mjs";
import { guardedAccounting } from "./continuity-guarded-accounting.mjs";
import { guardedState } from "./continuity-guarded-state.mjs";
const instances = new Map();
export function guardedReport(id) {
  const protocol = guardedProtocol(id);
  if (!instances.has(protocol)) instances.set(protocol, bind(protocol, id));
  return instances.get(protocol);
}
function bind(protocol, id) {
  const { need, accountRun, dollars } = guardedAccounting(id);
  const { runHash, runId, sameRun } = guardedState(id);
  function slotReceipt(state, index) {
    const slot = state.slots[index], planned = state.schedule[index];
    need(runId(state.runId) && runHash(planned.slotId) && slot.slotId === planned.slotId && [...protocol.policy.SLOT_TERMINALS, null].includes(slot.terminal)
      && [null, 0, 1].includes(slot.score) && (["completed", "wrong"].includes(slot.terminal) || slot.score === null), protocol.codes.receipt_invalid);
    const bindings = { ...state.publicBindings[planned.code], sourceSha256: state.publicSources[planned.suite] };
    need(/^[a-f0-9]{40}$/u.test(bindings.revision)
      && ["buildSha256", "sourceSha256", "protocolSha256"].every(k => runHash(bindings[k])), protocol.codes.receipt_invalid);
    const a = accountRun([slot]), holds = slot.holds ?? [];
    const terminalCode = slot.admissionRefusal ?? slot.guardRefusal ?? holds.at(-1)?.settlement?.code ?? slot.terminal;
    need(terminalCode === null || protocol.policy.PILOT_STOPS.includes(terminalCode) || protocol.policy.PRE_SEND_REFUSALS.includes(terminalCode)
      || protocol.policy.SLOT_TERMINALS.includes(terminalCode), protocol.codes.receipt_invalid);
    let input = 0, output = 0;
    for (const h of holds) { input += h.settlement?.rawUsage?.input_tokens ?? 0; output += h.settlement?.rawUsage?.output_tokens ?? 0; }
    const row = { schema: "lookup-pilot-slot-receipt-v1", runId: state.runId, slotId: planned.slotId, position: index, role: planned.roleId,
      binding: Object.fromEntries(["revision", "buildSha256", "sourceSha256", "protocolSha256"].map(key => [key, bindings[key]])), qualityMeasured: state.schema === protocol.policy.REAL_CONTROLLER && holds.length > 0 && ["completed", "wrong"].includes(slot.terminal) && [0, 1].includes(slot.score), eligible: planned.eligible,
      admitted: holds.length > 0, terminal: slot.terminal, terminalCode, score: slot.score,
      calls: { admitted: holds.length, consumed: holds.filter(h => h.consumed).length, settled: holds.filter(h => h.settlement).length },
      usage: { inputTokens: input, outputTokens: output },
      costs: { completeUSD: dollars(a.completeUnits), retainedUSD: dollars(a.retainedUnits),
        activeUSD: dollars(a.activeUnits), knownPartialUSD: dollars(a.knownPartialUnits) },
      holds: holds.map(h => ({ permitId: h.permitId, consumed: h.consumed, retained: h.settlement?.kind !== "settled",
        reservationUSD: dollars(h.reservedUnits), knownPartialUSD: dollars(h.settlement?.knownUnits ?? "0") })) };
    return { ...row, sha256: digest(row) };
  }
  function aggregateRun(state, receipts) {
    need(Number.isSafeInteger(state.cursor) && state.cursor >= 0 && state.cursor <= state.schedule.length, protocol.codes.receipt_invalid);
    const visited = state.cursor + (state.slots[state.cursor]?.preparation || state.slots[state.cursor]?.worker || state.slots[state.cursor]?.holds?.length ? 1 : 0);
    const seen = new Set();
    for (const row of receipts) {
      need(Number.isSafeInteger(row?.position) && row.position >= 0 && row.position < visited && state.schedule[row.position]?.slotId === row.slotId && !seen.has(row.slotId)
        && sameRun(row, slotReceipt(state, row.position)), protocol.codes.receipt_invalid);
      seen.add(row.slotId);
    }
    need(state.stop === null || protocol.policy.PILOT_STOPS.includes(state.stop), protocol.codes.receipt_invalid);
    const counts = { planned: state.schedule.length, eligible: state.schedule.filter(s => s.eligible).length,
      skipped: 0, unadmitted: 0, admitted: 0, completed: 0, incomplete: 0, invalid: 0, missing: 0 };
    for (let i = 0; i < visited; i++) {
      const planned = state.schedule[i], slot = state.slots[i];
      if (!seen.has(planned.slotId)) counts.missing++;
      if (!planned.eligible) { counts.skipped++; continue; }
      if (!slot.holds.length) { counts.unadmitted++; continue; }
      const a = accountRun([slot]); counts.admitted++; counts.completed += a.completed;
      counts.incomplete += a.incomplete + (slot.terminal ? 0 : 1); counts.invalid += a.invalid;
    }
    const blocks = new Map();
    for (const row of receipts) if (row.position < visited && ["completed", "wrong"].includes(row.terminal) && row.admitted) {
      const s = state.schedule[row.position], key = digest([s.suite, s.traceId, s.probeId]);
      if (!blocks.has(key)) blocks.set(key, new Set()); blocks.get(key).add(row.role);
    }
    const spend = accountRun(state.slots);
    return { schema: "lookup-pilot-report-v1", runId: state.runId, executionKind: state.schema === protocol.policy.REAL_CONTROLLER ? "authorized-pilot" : "faux-only", authorizedSpend: state.schema === protocol.policy.REAL_CONTROLLER, qualityMeasured: receipts.some(row => row.qualityMeasured), counts,
      pairedCoverage: { completeBlocks: [...blocks.values()].filter(v => v.size === state.roleCount).length },
      schedule: { visited, truncated: visited < state.schedule.length, remaining: state.schedule.length - visited },
      stop: state.stop, cost: { capUSD: state.capUSD, reservationUSD: state.rmaxUSD, totalUSD: dollars(spend.totalUnits), knownPartialUSD: dollars(spend.knownPartialUnits) },
      receipts: [...receipts].sort((a, b) => a.position - b.position) };
  }
  return Object.freeze({ slotReceipt, aggregateRun });
}
