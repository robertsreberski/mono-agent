import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import { accountLookupPilot, priceLookupUsage, settleLookupHold, lookupMoney, lookupPilotStopReason } from "../lib/continuity-lookup-pilot-accounting.mjs";
import { lookupPilotReceipt, aggregateLookupPilot } from "../lib/continuity-lookup-pilot-report.mjs";
import { lookupPilotSchedule } from "../lib/continuity-lookup-controller.mjs";
const raw = { input_tokens: 100, output_tokens: 10 };
const hold = (kind = "lost", knownUnits = "0") => ({ permitId: "opaque-permit", reservedUnits: "78400000", consumed: true, revoked: false,
  settlement: { kind, knownUnits, rawUsage: raw, tier: null } });
const slot = terminal => ({ terminal, holds: [hold(terminal === "completed" ? "settled" : terminal === "integrity_stop" ? "integrity_stop" : "lost")], score: null });
it.each([
  [["lost", "lost"], "lookup_repeated_loss"],
  [["lost", "own_abort_after_send"], null],
  [["lost", "own_abort_after_send", "lost"], "lookup_repeated_loss"],
  [["own_abort_after_send", "own_abort_after_send", "own_abort_after_send"], null],
  [["lost", "completed", "lost"], null],
  [["lost", "skipped", "lost"], "lookup_repeated_loss"],
  [["lost", "unadmitted", "lost"], "lookup_repeated_loss"],
])("registers the provider-loss streak for %j", (terminals, stop) => {
  const slots = terminals.map(t => ["skipped", "unadmitted"].includes(t) ? { terminal: t, holds: [] } : slot(t));
  const a = accountLookupPilot(slots); expect(a.invalid).toBe(0);
  expect(lookupPilotStopReason(a, lookupMoney(100))).toBe(stop);
});
it("uses max, never sum, for known partial overlap with retained holds", () => {
  const a = accountLookupPilot([{ ...slot("lost"), holds: [hold("lost", "80000000")] }]);
  expect(a).toMatchObject({ totalUnits: "80000000", knownPartialUnits: "80000000", retainedUnits: "80000000", incomplete: 1, invalid: 0 });
});
it("prices every valid raw integrity outcome, retains unknown-tier 2x and validates shared claims", () => {
  const p = priceLookupUsage({ input_tokens: 272000, output_tokens: 1000000 }, null);
  expect(BigInt(p.units)).toBeGreaterThan(lookupMoney(3.92));
  expect(priceLookupUsage(raw, null).sharedCost).toBe(priceLookupUsage(raw, "default").sharedCost * 2);
  expect(() => settleLookupHold(hold(), { kind: "settled", cost: 0 }, raw, "default")).toThrow("lookup_hold_exceeded");
  expect(settleLookupHold(hold(), { kind: "integrity_stop", code: "lookup_output_envelope_violated" }, { input_tokens: 272000, output_tokens: 1000000 }, null).settlement.knownUnits).toBe(p.units);
});
it("stops strictly above ten percent invalid admitted slots, not at equality", () => {
  const slots = [slot("integrity_stop"), ...Array.from({ length: 9 }, () => slot("completed"))];
  expect(lookupPilotStopReason(accountLookupPilot(slots), lookupMoney(100))).toBeNull();
  expect(lookupPilotStopReason(accountLookupPilot(slots.slice(0, 9)), lookupMoney(100))).toBe("invalid_unit_rate");
});
function reportState() {
  const hash = "a".repeat(64), id = "b".repeat(64);
  return { runId: "fictional-run", capUSD: 100, rmaxUSD: 3.92, schedule: [{ slotId: id, eligible: true, roleId: "native", code: "R0", suite: "holdout", traceId: "fictional", probeId: "p01" }],
    slots: [{ ...slot("completed"), slotId: id }], publicBindings: { R0: { revision: "c".repeat(40), buildSha256: hash, sourceSha256: hash, protocolSha256: hash } },
    publicSources: { holdout: hash }, roleCount: 6, cursor: 1, stop: "completed" };
}
it("exports only the content-free projection, never request/answer/path/path-hash/commitment/stderr sentinels", () => {
  const s = reportState(), sentinels = ["fictional-answer-sentinel", "/fictional/private-path", createHash("sha256").update("/fictional/private-path").digest("hex"), "fictional-commitment-sentinel", "fictional-stderr-sentinel"];
  [s.answer, s.path, s.pathHash, s.commitment, s.stderr] = sentinels;
  s.slots[0].request = sentinels; s.publicBindings.R0.path = sentinels[1];
  const result = aggregateLookupPilot(s, [lookupPilotReceipt(s, 0)]), bytes = JSON.stringify(result);
  for (const value of sentinels) expect(bytes).not.toContain(value);
  expect(result.counts).toMatchObject({ planned: 1, admitted: 1, completed: 1, invalid: 0, missing: 0 });
});
it("refuses duplicate, tampered or unplanned receipts, and counts missing without fabricating invalid units", () => {
  const s = reportState(), r = lookupPilotReceipt(s, 0);
  for (const receipts of [[r, r], [{ ...r, score: 0 }], [{ ...r, position: 1 }], [{ ...r, stderr: "fictional" }]]) expect(() => aggregateLookupPilot(s, receipts)).toThrow("lookup_receipt_invalid");
  expect(aggregateLookupPilot(s, []).counts).toMatchObject({ admitted: 1, missing: 1, invalid: 0 });
});
it("freezes seeded pair blocks with interleaved roles and no trace substitution", () => {
  const roles = ["native", "shipping", "pack"].map(id => ({ id, code: "R0" }));
  const pilot = { descriptor: { schedule: { seed: 17 } }, registration: { roles, common: { corpora: [{ suite: "holdout", traces: [{ id: "fictional-a", probes: ["p01", "p02"] }, { id: "fictional-b", probes: ["p01"] }] }],
    policy: { budget: { paths: ["fictional-a", "fictional-b"].flatMap(traceId => ["p01", "p02"].flatMap(probeId => roles.map(r => ({ role: r.id, traceId, probeId, feasibility: { classification: "feasible" } })))) } } } } };
  const a = lookupPilotSchedule(pilot); expect(lookupPilotSchedule(pilot)).toEqual(a); expect(a).toHaveLength(9);
  for (let i = 0; i < a.length; i += roles.length) { const block = a.slice(i, i + roles.length); expect(new Set(block.map(r => `${r.traceId}/${r.probeId}`)).size).toBe(1); expect(new Set(block.map(r => r.roleId)).size).toBe(3); }
  pilot.descriptor.schedule.seed++; expect(lookupPilotSchedule(pilot)).not.toEqual(a);
});

it("keeps conservative numeric partial spend for inconsistent integrity counters", () => {
  const usage = { input_tokens: 100, output_tokens: 1000000, input_tokens_details: { cached_tokens: 200 } };
  const priced = priceLookupUsage(usage, null); expect(priced.invalid).toBe(true);
  const settled = settleLookupHold(hold(), { kind: "integrity_stop", code: "lookup_invalid_usage" }, usage, null);
  expect(BigInt(settled.settlement.knownUnits)).toBeGreaterThan(lookupMoney(3.92));
});

it("keeps the smallest flex cache quantum exact and refuses non-integrity invalid usage", () => {
  expect(priceLookupUsage({ input_tokens: 1, output_tokens: 0, input_tokens_details: { cached_tokens: 1 } }, "flex").units).toBe("1");
  expect(() => settleLookupHold(hold(), { kind: "settled", cost: 0 }, { input_tokens: 0, output_tokens: 0 }, null)).toThrow("lookup_invalid_usage");
});

it("counts only visited slots, leaving unvisited inventory solely in truncation", () => {
  const s = reportState(); s.schedule.push({ ...s.schedule[0], slotId: "d".repeat(64) }, { ...s.schedule[0], slotId: "e".repeat(64), eligible: false });
  s.slots.push({ terminal: null, holds: [], score: null }, { terminal: null, holds: [], score: null });
  const report = aggregateLookupPilot(s, [lookupPilotReceipt(s, 0)]);
  expect(report.counts).toMatchObject({ planned: 3, eligible: 2, admitted: 1, unadmitted: 0, skipped: 0, missing: 0 });
  expect(report.schedule).toEqual({ visited: 1, remaining: 2, truncated: true });
});
it("binds every receipt to its own suite source", () => {
  const s = reportState(); s.publicSources.other = "f".repeat(64);
  s.schedule.push({ ...s.schedule[0], suite: "other", slotId: "d".repeat(64) }); s.slots.push(structuredClone(s.slots[0]));
  expect(lookupPilotReceipt(s, 0).binding.sourceSha256).toBe("a".repeat(64));
  expect(lookupPilotReceipt(s, 1).binding.sourceSha256).toBe("f".repeat(64));
});
it("counts later pre-send refusal as incomplete, never as invalid or a provider loss", () => {
  const s = reportState(); s.slots[0] = { ...slot("refused_pre_send"), holds: [hold("settled", "6000")], admissionRefusal: "budget_admission" };
  const row = lookupPilotReceipt(s, 0), report = aggregateLookupPilot(s, [row]);
  expect(row).toMatchObject({ terminal: "refused_pre_send", terminalCode: "budget_admission", admitted: true });
  expect(report.counts).toMatchObject({ admitted: 1, incomplete: 1, invalid: 0, completed: 0 });
  expect(accountLookupPilot([slot("lost"), s.slots[0]]).consecutiveProviderLosses).toBe(0);
});

it.each([-1, .5, 2])("refuses an invalid classification cursor %s", cursor => {
  const s = reportState(); s.cursor = cursor; expect(() => aggregateLookupPilot(s, [])).toThrow("lookup_receipt_invalid");
});
