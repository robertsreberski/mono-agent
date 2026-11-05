import { afterEach, expect, it, vi } from "vitest";
import { mkdir, writeFile, chmod, access } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
const modules = ["pilot", "roles", "pilot-state", "controller", "preparation"];
afterEach(() => { vi.restoreAllMocks(); vi.doUnmock("../lib/continuity-process-identity.mjs"); for (const name of modules) vi.doUnmock(`../lib/continuity-lookup-${name}.mjs`); vi.resetModules(); });
it.each(["lookup_preparation_invalid", "lookup_preparation_timeout"])("reports %s per slot and returns nonzero without authorizing", async code => {
  vi.resetModules();
  const pilot = {registration: {}, descriptor: {deadlines: {deadlineMs: 1000, childWatchdogMs: 2000, runDeadlineMs: 4000}}};
  vi.doMock("../lib/continuity-lookup-pilot.mjs", async original => ({...await original(), validateLookupPilotRegistration() {}, readLookupPilotRegistration: async () => pilot}));
  vi.doMock("../lib/continuity-lookup-roles.mjs", async original => ({...await original(), verifyRegisteredCheckouts() {}}));
  vi.doMock("../lib/continuity-lookup-pilot-state.mjs", async original => ({...await original(), lookupPilotSchedule: () => [{slotId: "fictional-slot", eligible: true}]}));
  // Unit boundary substitution only; full configured preparation is a separate process test.
  vi.doMock("../lib/continuity-lookup-controller.mjs", () => ({runLookupPreparationSlot: async (journal, _pilot, root) => {
    const snapshot = join(root, "work/fictional-slot/checkpoint/snapshot"); await mkdir(snapshot, {recursive: true, mode: 0o700});
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

async function scenario({count = 2, runDeadlineMs = 1000000, prepare, restore, cleanup} = {}) {
  vi.resetModules();
  const pilot = {registration: {}, descriptor: {deadlines: {deadlineMs: 720000, childWatchdogMs: 600000, runDeadlineMs}}};
  const schedule = Array.from({length: count}, (_, i) => ({slotId: `fictional-${i}`, traceId: `trace-${i}`, eligible: i === 0}));
  vi.doMock("../lib/continuity-lookup-pilot.mjs", async original => ({...await original(), validateLookupPilotRegistration() {}, readLookupPilotRegistration: async () => pilot}));
  vi.doMock("../lib/continuity-lookup-roles.mjs", async original => ({...await original(), verifyRegisteredCheckouts() {}}));
  vi.doMock("../lib/continuity-lookup-pilot-state.mjs", async original => ({...await original(), lookupPilotSchedule: () => schedule}));
  const preparer = vi.fn(async (journal, _pilot, root, index) => {
    const slot = schedule[index], snapshot = join(root, "work", slot.slotId, "checkpoint/snapshot");
    await mkdir(snapshot, {recursive: true, mode: 0o700}); await writeFile(join(snapshot, "fictional"), "Fictional bytes.", {mode: 0o600});
    return prepare?.({journal, root, index, slot, snapshot});
  });
  vi.doMock("../lib/continuity-lookup-controller.mjs", () => ({runLookupPreparationSlot: preparer}));
  if (restore) vi.doMock("../lib/continuity-lookup-preparation.mjs", async original => ({...await original(), restoreLookupPreflight: restore, ...(cleanup ? {removeLookupWorkTree: cleanup} : {})}));
  const stdout = vi.fn(), {main} = await import("../continuity-lookup-compare.mjs");
  const status = await main(["preflight", "--registration", "fictional.json", "--sha256", "a".repeat(64)], {stdout});
  return {status, report: JSON.parse(stdout.mock.calls[0][0]), preparer};
}
it("records a throwing slot with a fixed code and retains the full report", async () => {
  const {status, report, preparer} = await scenario({prepare: ({index}) => {if (!index) throw Object.assign(Error("FICTIONAL_PRIVATE_PATH"), {code: "ENOENT"});}, restore: async () => {}});
  expect(status).toBe(1); expect(preparer).toHaveBeenCalledTimes(2);
  expect(report.slots.map(s => s.failure)).toEqual(["lookup_preparation_invalid", null]);
  expect(report.slots.map(s => s.feasible)).toEqual([false, true]); expect(JSON.stringify(report)).not.toContain("FICTIONAL_PRIVATE_PATH");
});
it("emits an infeasible report but retains the root and starts no more slots after unproven containment", async () => {
  let retained;
  try {
    const {report, status, preparer} = await scenario({prepare: ({root}) => {retained = root; throw Object.assign(Error("fictional"), {code: "lookup_unreconciled_processes"});}, restore: async () => {}});
    expect(status).toBe(1); expect(preparer).toHaveBeenCalledOnce(); expect(report.unreconciledProcesses).toBe(true);
    expect(report.slots).toHaveLength(2); expect(report.slots.every(s => !s.feasible && s.failure === "lookup_preparation_invalid")).toBe(true);
    await expect(access(join(retained, "lookup-pilot-controller.json"))).resolves.toBeUndefined();
    expect(JSON.stringify(report)).not.toContain(retained);
  } finally {
    // No actual processes were launched by this unit boundary mock.
    if (retained) await (await import("../lib/continuity-lookup-preparation.mjs")).removeLookupWorkTree(retained);
  }
});
it("models cumulative preparation and restore time with the real remaining-time watchdog", async () => {
  let clock = 0; vi.spyOn(Date, "now").mockImplementation(() => 1000000000 + clock); vi.spyOn(performance, "now").mockImplementation(() => clock);
  const {status, report, preparer} = await scenario({count: 4,
    prepare: ({index}) => {clock += [400000, 400000, 100000][index];}, restore: async a => {clock += [20000, 20000, 100000][a.index];}});
  expect(status).toBe(1); expect(preparer).toHaveBeenCalledTimes(3);
  expect(report.slots.map(s => s.watchdogMs)).toEqual([600000, 580000, 160000, 0]);
  expect(report.slots.map(s => s.restoreWatchdogMs)).toEqual([600000, 180000, 60000, 0]);
  expect(report.slots.map(s => s.failure)).toEqual([null, null, "lookup_preparation_timeout", "lookup_run_deadline"]);
  expect(report.timing).toEqual({preparationMs: 900000, restoreMs: 140000, preparationAndRestoreMs: 1040000, elapsedMs: 1040000, runDeadlineMs: 1000000, probeTimeExcluded: true});
  expect(report.feasible).toBe(false);
});
it("uses the production dry restore and reports an actual removal failure as infeasible", async () => {
  let exited = false;
  vi.doMock("../lib/continuity-process-identity.mjs", async original => ({...await original(), lookupProcessStartIdentity: pid => pid === process.pid ? "fictional-controller" : exited ? null : "fictional-preparer"}));
  const {status, report} = await scenario({count: 1, prepare: async ({journal, root, index, slot, snapshot}) => {
    const {writeLookupPreflight} = await import("../lib/continuity-lookup-preparation.mjs");
    const work = join(root, "work", slot.slotId, "checkpoint/work"); await mkdir(work, {mode: 0o700});
    await writeFile(join(work, "obsolete"), "Fictional old bytes.", {mode: 0o600});
    await journal.assignPreparation(index, {pid: 2147483647, startIdentity: "fictional-preparer"});
    const treeDigest = await writeLookupPreflight({outputRoot: root, index, slotId: slot.slotId, slot}, {work, snapshot, record: {conversationId: "fictional"}});
    exited = true; await journal.prepared(index, treeDigest); await chmod(join(work, ".."), 0o500);
  }});
  expect(status).toBe(1); expect(report.slots[0]).toMatchObject({fileCount: 1, rejectedEntries: [], feasible: false, failure: "lookup_preparation_invalid"});
});
it.each([[], ["--registration", "fictional.json"], ["--sha256", "a".repeat(64)], ["--registration", "fictional.json", "--sha256", "bad"]].map(flags => [flags]))("requires preflight registration flags before filesystem reads: %j", async flags => {
  const {main} = await import("../continuity-lookup-compare.mjs");
  await expect(main(["preflight", ...flags])).rejects.toThrow("lookup_registration_invalid");
});

it.each(["work", "root"])("emits the fixed infeasible report when %s cleanup fails", async stage => {
  let retained; const original = await vi.importActual("../lib/continuity-lookup-preparation.mjs");
  try {
    const {status, report} = await scenario({restore: async () => {}, prepare: ({root}) => {retained = root;},
      cleanup: async path => {if (path === (stage === "root" ? retained : join(retained, "work"))) throw Object.assign(Error("fictional"), {code: "EACCES"}); return original.removeLookupWorkTree(path);}});
    expect(status).toBe(1); expect(report).toMatchObject({feasible: false, cleanupFailed: true});
    expect(report.slots).toHaveLength(2); await expect(access(retained)).resolves.toBeUndefined();
  } finally { if (retained) await original.removeLookupWorkTree(retained); }
});
