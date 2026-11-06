import {expect} from "vitest";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {pilotSuite, loadPilot, runOptions} from "./fixtures/lookup-pilot-process.mjs";
import {LOOKUP_PILOT_MEASURED_ROLES, LOOKUP_ROLES} from "../lib/continuity-lookup.mjs";

const suite = pilotSuite({scoped: true, fixtureOptions: {eligibleRoles: ["native", "native-soul"], nativeFeasible: true}}), it = suite.test;
it("skips feasible native inventory without preparation, a probe, any hold or spend", async () => {
  expect(Object.isFrozen(LOOKUP_PILOT_MEASURED_ROLES)).toBe(true);
  expect([...LOOKUP_PILOT_MEASURED_ROLES].sort()).toEqual(["pack", "pack-only", "shipping", "soul-only"]);
  const f = suite.fixture, options = await runOptions(f), paths = options.pilot.registration.common.policy.budget.paths;
  expect(options.pilot.registration.roles.map(r => r.id).sort()).toEqual(LOOKUP_ROLES.map(r => r.id).sort());
  expect(paths.filter(p => p.role.startsWith("native")).every(p => p.feasibility.classification === "feasible")).toBe(true);
  const {lookupPilotSchedule} = await loadPilot(f, "pilot-state"), schedule = lookupPilotSchedule(options.pilot);
  expect(schedule.length).toBeGreaterThan(0); expect(schedule.every(s => s.eligible === false)).toBe(true);
  const driver = await suite.spawn({options}), reply = await driver.reply; await driver.exit;
  expect(reply.failed).toBeUndefined(); expect(reply.result.cost.totalUSD).toBe(0);
  const state = JSON.parse(await readFile(join(options.outputRoot, "lookup-pilot-controller.json")));
  expect(state.slots.every(s => s.terminal === "skipped" && s.preparation == null && s.worker == null && s.holds.length === 0)).toBe(true);
  const {accountLookupPilot} = await loadPilot(f, "pilot-accounting");
  expect(accountLookupPilot(state.slots)).toMatchObject({activeUnits: "0", retainedUnits: "0", completeUnits: "0", totalUnits: "0"});
});
