import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateE2Deadlines } from "../lib/continuity-e2-registration.mjs";
import { e2Watchdog } from "../lib/continuity-e2-controller-policy.mjs";
import { guardedProtocol } from "../lib/continuity-guarded-protocols.mjs";
import * as policy from "../lib/continuity-e2-policy.mjs";
it("golden-pins the complete E2 policy export inventory, independent of lookup constants", async () => {
  const golden = JSON.parse(await readFile(new URL("./fixtures/continuity-e2-policy.json", import.meta.url)));
  const actual = JSON.parse(JSON.stringify(policy, (_, v) => typeof v === "bigint" ? v.toString() : v));
  expect(actual).toEqual(golden);
  expect(Object.keys(policy).filter(k => typeof policy[k] !== "function").sort()).toEqual(Object.keys(golden).sort());
  expect(Object.isFrozen(policy.E2_ASSUMPTIONS)).toBe(true); expect(Object.isFrozen(policy.E2_REGISTRY_LAYOUT[0])).toBe(true);
});
it("owns the E2 registry and schemas without inheriting a lookup request envelope", () => {
  expect(join("/Users/example", ...policy.E2_REGISTRY_LAYOUT.map(([part]) => part))).toBe("/Users/example/.local/state/mono-agent/lcc-e2/consumed-v1");
  expect(policy.USD_UNITS).toBe(1000000000n);
  expect(policy.E2_ASSUMPTIONS).not.toHaveProperty("rmax"); expect(policy.E2_ASSUMPTIONS).not.toHaveProperty("inputMax");
  expect(policy.E2_ASSUMPTIONS).not.toHaveProperty("outputMax"); expect(policy.E2_ASSUMPTIONS).not.toHaveProperty("rates");
  expect(policy.E2_ASSUMPTIONS.literalInput).toBe("max_serialized_bytes_over_3_and_engine_full_request");
  expect(policy.E2_ASSUMPTIONS.reservation).toBe("catalog-context-output-ceilings-with-conservative-cache-tier-rates");
  expect(policy.E2_BINDING_FIELDS).toEqual(["code", "build", "catalog", "protocol", "source", "probes", "keys", "soul", "schedule", "account", "tools", "deadlines", "capUnits"]);
});

it("validates four explicit E2 clocks and refuses legacy, overflowing or inverted bounds", () => {
  const valid = { requestDeadlineMs: 600000, phaseDeadlineMs: 72000000, childWatchdogMs: 72000000, runDeadlineMs: 86400000 };
  expect(() => validateE2Deadlines(valid)).not.toThrow();
  for (const change of [d => delete d.requestDeadlineMs, d => delete d.phaseDeadlineMs, d => d.deadlineMs = 600000,
    d => d.requestDeadlineMs = 600001, d => d.phaseDeadlineMs = 86400001, d => d.runDeadlineMs = 86400001,
    d => d.childWatchdogMs = d.phaseDeadlineMs + 1, d => d.phaseDeadlineMs = 599999,
    d => d.childWatchdogMs = 599999, d => d.runDeadlineMs = d.phaseDeadlineMs - 1, d => d.requestDeadlineMs = 1.5]) {
    const d = structuredClone(valid); change(d); expect(() => validateE2Deadlines(d)).toThrow("e2_deadlines_invalid");
  }
  expect(() => validateE2Deadlines({ deadlineMs: 600000, childWatchdogMs: 660000, runDeadlineMs: 7200000 })).toThrow("e2_deadlines_invalid");
});
it("uses E2's phase/child/run clocks without changing lookup's historical watchdog meaning", () => {
  const now = 1000000, lookup = guardedProtocol("lookup-pilot");
  expect(lookup.execution).toBeUndefined();
  for (const [authorization, deadlines, remaining, expected] of [
    [{}, { deadlineMs: 6000, childWatchdogMs: 7000 }, 10000, 6000],
    [{ timeoutMs: 4000 }, { deadlineMs: 6000, childWatchdogMs: 7000 }, 10000, 4000],
    [{}, { deadlineMs: 6000, childWatchdogMs: 7000 }, 2000, 2000],
  ]) expect(lookup.hooks.watchdog(authorization, deadlines, now + remaining, now)).toBe(expected);
  const d = { requestDeadlineMs: 1000, phaseDeadlineMs: 72000000, childWatchdogMs: 71000000, runDeadlineMs: 86400000 };
  expect(e2Watchdog({}, d, now + d.runDeadlineMs, now)).toBe(71000000);
  expect(e2Watchdog({}, d, now + 500, now)).toBe(500);
});
