import { it, expect } from "vitest";
import { accountUnits, spendOf, stopReason } from "../lib/continuity-holdout-controller.mjs";
import { accountLookupPilot } from "../lib/continuity-lookup-pilot-accounting.mjs";
it("keeps legacy accounting/default stop bytes and enables only the explicit lookup adapter", () => {
  expect([accountUnits.length, spendOf.length, stopReason.length]).toEqual([2, 2, 2]);
  const bundle = { prices: {}, plan: { reader: { model: "fictional" }, upkeep: { model: "fictional" } } };
  expect(JSON.stringify(accountUnits([], bundle))).toBe('{"knownUSD":0,"unknownUSD":0,"unknownCalls":0,"unpriced":0,"invalidUnits":0,"authFailure":false,"degradedStages":0}');
  const chunks = [{ state: "lost", reservationUsd: 3.92, accounting: { knownUSD: 1 } }];
  expect(JSON.stringify(spendOf(chunks, 1))).toBe('{"knownUSD":1,"unknownUSD":0,"lostUSD":3.92,"activeUSD":0,"unknownCalls":0,"unpriced":0,"invalidUnits":1,"admittedUnits":1,"authFailure":false,"totalUSD":4.92}');
  expect(stopReason(spendOf(chunks, 1), 10)).toBe("invalid_unit_rate");
  const slots = [{ terminal: "completed", holds: [{ reservedUnits: "78400000", consumed: true, settlement: { kind: "settled", knownUnits: "20000000" } }] },
    { terminal: "lost", holds: [{ reservedUnits: "40000000", consumed: false, settlement: null }] }];
  const spend = accountLookupPilot(slots); expect(spend.totalUnits).toBe("60000000");
  expect(accountUnits(slots, null, { lookupPilot: true })).toEqual(spend);
  expect(spendOf(slots, null, { lookupPilot: true })).toEqual(spend);
  expect(stopReason(spend, 5, 2, { lookupPilot: true })).toBeNull();
  expect(stopReason(spend, 5, 2.01, { lookupPilot: true })).toBe("budget_admission");
});
