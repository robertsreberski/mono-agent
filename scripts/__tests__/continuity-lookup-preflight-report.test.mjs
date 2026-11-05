import { afterEach, expect, it, vi } from "vitest";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
const modules = ["pilot", "roles", "pilot-state", "controller"];
afterEach(() => { for (const name of modules) vi.doUnmock(`../lib/continuity-lookup-${name}.mjs`); vi.resetModules(); });
it.each(["lookup_preparation_invalid", "lookup_preparation_timeout"])("reports %s per slot and returns nonzero without authorizing", async code => {
  vi.resetModules();
  const pilot = {registration: {}, descriptor: {deadlines: {deadlineMs: 1000, childWatchdogMs: 2000, runDeadlineMs: 4000}}};
  vi.doMock("../lib/continuity-lookup-pilot.mjs", async original => ({...await original(), validateLookupPilotRegistration() {}, readLookupPilotRegistration: async () => pilot}));
  vi.doMock("../lib/continuity-lookup-roles.mjs", async original => ({...await original(), verifyRegisteredCheckouts() {}}));
  vi.doMock("../lib/continuity-lookup-pilot-state.mjs", async original => ({...await original(), lookupPilotSchedule: () => [{slotId: "fictional-slot", eligible: true}]}));
  // Unit boundary substitution only; full configured preparation is a separate process test.
  vi.doMock("../lib/continuity-lookup-controller.mjs", () => ({runLookupPreparationSlot: async (journal, _pilot, root) => {
    const snapshot = join(root, "work/fictional-slot/checkpoint/snapshot"); await mkdir(snapshot, {recursive: true});
    await writeFile(join(snapshot, "fictional-private-name"), "FICTIONAL_PRIVATE_CONTENT", {mode: code === "lookup_preparation_invalid" ? 0o622 : 0o600});
    if (code === "lookup_preparation_invalid") await chmod(join(snapshot, "fictional-private-name"), 0o622);
    await journal.stop(code); return false;
  }}));
  const {main} = await import("../continuity-lookup-compare.mjs"), stdout = vi.fn();
  expect(await main(["preflight", "--registration", "fictional.json", "--sha256", "a".repeat(64)], {stdout})).toBe(1);
  const report = JSON.parse(stdout.mock.calls[0][0]); expect(report.feasible).toBe(false);
  expect(report.slots).toHaveLength(1); expect(report.slots[0]).toMatchObject({fileCount: 1, failure: code, feasible: false});
  if (code === "lookup_preparation_invalid") expect(report.slots[0].rejectedEntries).toEqual([{kind: "writable_mode", count: 1}]);
  expect(stdout.mock.calls[0][0]).not.toContain("FICTIONAL_PRIVATE_CONTENT"); expect(stdout.mock.calls[0][0]).not.toContain("fictional-private-name");
});
