// Offline golden contracts. No real registry, credential store or provider is opened.
import { afterEach, expect, it } from "vitest";
import { readFile, mkdtemp, realpath, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lookupPolicy from "../lib/continuity-lookup-guarded-policy.mjs";
import { guardedProtocol } from "../lib/continuity-guarded-protocols.mjs";
import { guardedAccounting } from "../lib/continuity-guarded-accounting.mjs";
import { guardedLease } from "../lib/continuity-guarded-lease.mjs";
import { guardedState } from "../lib/continuity-guarded-state.mjs";
import { accountLookupPilot, lookupMoney, priceLookupUsage, settleLookupHold } from "../lib/continuity-lookup-pilot-accounting.mjs";
import { lookupInputEnvelope, lookupSettledCost } from "../lib/continuity-lookup-guard.mjs";
import { lookupProcessStartIdentity } from "../lib/continuity-process-identity.mjs";

const roots = [], leases = [];
afterEach(async () => { for (const lease of leases.splice(0)) lease.release(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const json = value => JSON.parse(JSON.stringify(value, (_, child) => typeof child === "bigint" ? child.toString() : child));
it("pins every original lookup policy constant and refusal set to the pre-extraction golden", async () => {
  const golden = JSON.parse(await readFile(new URL("./fixtures/continuity-guarded-lookup-policy.json", import.meta.url)));
  expect(json(lookupPolicy)).toEqual(golden);
  expect(guardedProtocol("lookup-pilot").registryDomain).toBe("mono-agent/lookup-pilot/consumed-v1\0");
  expect(guardedProtocol("lookup-pilot").accountDomain).toBe("mono-agent/lookup-pilot/account-v1\0");
  expect(join("/Users/example", ...lookupPolicy.LOOKUP_REGISTRY_LAYOUT.map(([part]) => part))).toBe("/Users/example/.local/state/mono-agent/lookup-pilot/consumed-v1");
  expect(() => guardedProtocol({ id: "lookup-pilot" })).toThrow("guarded_protocol_unknown");
  expect(() => guardedProtocol("/fictional/protocol.mjs")).toThrow("guarded_protocol_unknown");
  expect(Object.isFrozen(guardedProtocol("lookup-pilot").policy.ASSUMPTIONS.rates)).toBe(true);
  const protocol = guardedProtocol("lookup-pilot");
  expect([protocol.requestLimit, protocol.lossLimit, protocol.invalidRateDenominator]).toEqual([10, 2, 10]);
  expect(protocol.schemas).toEqual({ slotReceipt: "lookup-pilot-slot-receipt-v1", report: "lookup-pilot-report-v1", fauxConsumption: "lookup-faux-consumption-v1", preparation: "lookup-preparation-v1", preflightSnapshot: "lookup-preflight-snapshot-v1", preparationRecord: "lookup-preparation-record-v1", preflightRecord: "lookup-preflight-record-v1", preflightReport: "lookup-preflight-report-v1" });
  expect(protocol.children).toEqual({ preparation: "scripts/lib/continuity-lookup-preparation-child.mjs", probe: "scripts/lib/continuity-lookup-pilot-child.mjs" });
});
it("pins the original envelope, exact reservation and tier prices through the lookup adapter", () => {
  const payload = { input: [{ type: "message", role: "user", content: "Fictional request." }], instructions: "Fictional instructions.", tools: [{ type: "function", name: "ReadFiction", parameters: { properties: { key: { type: "string" } } } }] };
  expect(lookupInputEnvelope(payload, [17, 23])).toEqual({ bytes: 221, H: 9728, U: 9989 });
  expect(lookupMoney(3.92)).toBe(78400000n);
  expect(lookupMoney(0.00000005)).toBe(1n);
  expect(() => lookupMoney(0.00000001)).toThrow("unpriced_reservation");
  const raw = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 }, output_tokens_details: { reasoning_tokens: 7 } };
  for (const [tier, units, cost] of [["flex", "3480", 0.000174], ["default", "6960", 0.000348], ["priority", "13920", 0.000696]]) {
    expect(priceLookupUsage(raw, tier)).toEqual({ invalid: false, units, rawUsage: raw, tier, sharedCost: cost });
    expect(lookupSettledCost(raw, tier)).toBe(cost);
  }
});
for (const id of ["lookup-pilot", "fictional"]) {
  it(`${id}: partitions settled, retained and active liabilities without double-counting partial spend`, () => {
    const core = guardedAccounting(id), reservedUnits = "78400000";
    const raw = { input_tokens: 100, output_tokens: 20 };
    const settled = core.settleHold({ consumed: true, reservedUnits }, { kind: "settled" }, raw, "default");
    const lost = core.settleHold({ consumed: true, reservedUnits }, { kind: "lost" }, raw, "default");
    const slots = [{ terminal: "completed", holds: [settled] }, { terminal: "lost", holds: [lost] }, { terminal: null, holds: [{ reservedUnits, consumed: false }] }];
    expect(core.accountRun(slots)).toEqual({ completeUnits: "8000", retainedUnits: "78400000", activeUnits: "78400000", knownPartialUnits: "16000", totalUnits: "156808000", admitted: 3, invalid: 0, incomplete: 1, completed: 1, consecutiveProviderLosses: 1 });
    if (id === "lookup-pilot") { expect(accountLookupPilot(slots)).toEqual(core.accountRun(slots)); expect(settleLookupHold({ consumed: true, reservedUnits }, { kind: "lost" }, raw, "default")).toEqual(lost); }
    expect(core.stopReason(core.accountRun(slots), "156808000", "1")).toBe("budget_admission");
    expect(core.stopReason(core.accountRun(slots), "156808000")).toBe(null);
    expect(core.stopReason({ ...core.accountRun(slots), invalid: 1, admitted: 10 }, "999999999")).toBe(null);
    expect(core.stopReason({ ...core.accountRun(slots), invalid: 1, admitted: 9 }, "999999999")).toBe("invalid_unit_rate");
    expect(core.stopReason({ ...core.accountRun(slots), consecutiveProviderLosses: 2 }, "999999999")).toBe(id === "lookup-pilot" ? "lookup_repeated_loss" : "fictional_repeated_loss");
    expect(() => core.settleHold({ consumed: false, reservedUnits }, { kind: "own_abort_after_send" }, null, null)).toThrow(id === "lookup-pilot" ? "lookup_permit_invalid" : "fictional_permit_invalid");
  });
  it(`${id}: selects incompatible journal/schema identity, and cannot fabricate a live writer lease`, async () => {
    const core = guardedLease(id), other = guardedLease(id === "lookup-pilot" ? "fictional" : "lookup-pilot");
    const root = await realpath(await mkdtemp(join(tmpdir(), "guarded-core-"))); roots.push(root);
    const lease = await core.acquireLease(root); leases.push(lease);
    const controller = { pid: process.pid, startIdentity: lookupProcessStartIdentity(process.pid) };
    const binding = await core.assertLease(lease, root, controller);
    expect(binding.outputIdentity).toEqual(expect.objectContaining({ dev: expect.any(Number), ino: expect.any(Number) }));
    await expect(other.assertLease(lease, root, controller)).rejects.toThrow();
    await expect(core.assertLease({}, root, controller)).rejects.toThrow();
    await expect(core.acquireLease(root)).rejects.toThrow();
    expect(guardedState(id).statePath(root)).toBe(join(root, id === "lookup-pilot" ? "lookup-pilot-controller.json" : "fictional-controller.json"));
    const moved = join(root, "renamed-live-inode"); await rename(join(root, "controller-lock.sqlite"), moved);
    // All protocols share the live-inode denial set: closing an alias could drop POSIX locks.
    expect(other.isLeaseFile(moved, binding.leaseIdentity)).toBe(true);
    expect(other.markLeaseCompromised(binding.leaseIdentity)).toBe(true);
    await expect(core.assertLease(lease, root, controller)).rejects.toThrow();
  });
}
