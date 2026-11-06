import { afterEach, expect, it, vi } from "vitest";
import { mkdir, writeFile, chmod, access, mkdtemp, lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
const modules = ["pilot", "roles", "pilot-state", "controller", "preparation"];
afterEach(() => { vi.restoreAllMocks(); vi.doUnmock("node:fs/promises"); vi.doUnmock("../lib/continuity-process-identity.mjs"); for (const name of modules) vi.doUnmock(`../lib/continuity-lookup-${name}.mjs`); vi.resetModules(); });
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
  expect(await main(["preflight", "--registration", "fictional.json", "--sha256", "a".repeat(64), "--timeout-ms", "1000", "--output-root", "/fictional/output"], {stdout})).toBe(1);
  const report = JSON.parse(stdout.mock.calls[0][0]); expect(report.feasible).toBe(false);
  expect(report.slots).toHaveLength(1); expect(report.slots[0]).toMatchObject({fileCount: 1, failure: code, feasible: false});
  if (code === "lookup_preparation_invalid") expect(report.slots[0].rejectedEntries).toEqual([{kind: "writable_mode", count: 1}]);
  expect(stdout.mock.calls[0][0]).not.toContain("FICTIONAL_PRIVATE_CONTENT"); expect(stdout.mock.calls[0][0]).not.toContain("fictional-private-name");
});

async function scenario({count = 2, runDeadlineMs = 1000000, prepare, restore, cleanup, timeoutMs = 600000, eligible = () => true, freeBytes, retained, outputRoot = "/fictional/output", deadlineMs = 720000, childWatchdogMs = 600000, requireRealEquivalent = false} = {}) {
  vi.resetModules();
  const pilot = {registration: {}, descriptor: {deadlines: {deadlineMs, childWatchdogMs, runDeadlineMs}}};
  const schedule = Array.from({length: count}, (_, i) => ({slotId: `fictional-${i}`, traceId: `trace-${i}`, eligible: eligible(i)}));
  vi.doMock("../lib/continuity-lookup-pilot.mjs", async original => ({...await original(), validateLookupPilotRegistration() {}, readLookupPilotRegistration: async () => pilot}));
  vi.doMock("../lib/continuity-lookup-roles.mjs", async original => ({...await original(), verifyRegisteredCheckouts() {}}));
  vi.doMock("../lib/continuity-lookup-pilot-state.mjs", async original => ({...await original(), lookupPilotSchedule: () => schedule}));
  if (freeBytes !== undefined) vi.doMock("node:fs/promises", async original => ({...await original(), statfs: async () => ({bavail: BigInt(freeBytes), bsize: 1n})}));
  const preparer = vi.fn(async (journal, _pilot, root, index) => {
    const slot = schedule[index], snapshot = join(root, "work", slot.slotId, "checkpoint/snapshot");
    await mkdir(snapshot, {recursive: true, mode: 0o700}); await writeFile(join(snapshot, "fictional"), "Fictional bytes.", {mode: 0o600});
    return prepare?.({journal, root, index, slot, snapshot});
  });
  vi.doMock("../lib/continuity-lookup-controller.mjs", () => ({runLookupPreparationSlot: preparer}));
  if (restore) vi.doMock("../lib/continuity-lookup-preparation.mjs", async original => ({...await original(), restoreLookupPreflight: restore, ...(cleanup ? {removeLookupWorkTree: cleanup} : {}), ...(retained ? {lookupRetainedBytes: async () => retained} : {})}));
  const stdout = vi.fn(), {main} = await import("../continuity-lookup-compare.mjs");
  const status = await main(["preflight", "--registration", "fictional.json", "--sha256", "a".repeat(64), "--timeout-ms", String(timeoutMs), "--output-root", outputRoot, ...(requireRealEquivalent ? ["--require-real-equivalent"] : [])], {stdout});
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
  expect(report.timing).toMatchObject({preparationMs: 900000, restoreMs: 140000, preparationAndRestoreMs: 1040000, elapsedMs: 1040000, runDeadlineMs: 1000000, probeTimeExcluded: true});
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
  expect(status).toBe(1); expect(report.slots[0].restoreWatchdogMs).toBeGreaterThan(0); expect(report.slots[0]).toMatchObject({fileCount: 1, rejectedEntries: [], feasible: false, failure: "lookup_preparation_invalid"});
});
it.each([[], ["--registration", "fictional.json"], ["--sha256", "a".repeat(64), "--timeout-ms", "600000", "--output-root", "/fictional/output"], ["--registration", "fictional.json", "--sha256", "bad"]].map(flags => [flags]))("requires preflight registration flags before filesystem reads: %j", async flags => {
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

const footprint = {snapshotBytes: 10, workBytes: 10, homeBytes: 4, otherBytes: 0, retainedBytes: 24};
it.each([[10850, 200, true], [10849, 200, false], [10850, 149, false]])("applies the time margins to deadline=%s timeout=%s", async (runDeadlineMs, timeoutMs, feasible) => {
  let clock = 0; vi.spyOn(Date, "now").mockImplementation(() => 1000000000 + clock); vi.spyOn(performance, "now").mockImplementation(() => clock);
  const {report} = await scenario({runDeadlineMs, timeoutMs, prepare: () => {clock += 100;}, restore: async () => {clock += 50;}, freeBytes: 10000, retained: footprint});
  expect(report.feasible).toBe(feasible); expect(report.timing).toMatchObject({margin: 1.5, requiredTimeoutMs: 150, preparationAndRestoreMs: 300, probeReserveMs: 2 * timeoutMs, requiredRunMs: 10450 + 2 * timeoutMs, timeoutMs});
});
it.each([[60, true], [59, false]])("requires the retained eligible bytes plus 25 percent with free=%s", async (freeBytes, feasible) => {
  const {report} = await scenario({runDeadlineMs: 2000000, restore: async () => {}, freeBytes, retained: footprint});
  expect(report.disk).toEqual({eligibleRetainedBytes: 48, freeBytes, requiredFreeBytes: 60, margin: 1.25, feasible}); expect(report.feasible).toBe(feasible);
});
it("separates ineligible slots without charging their disk, time or watchdog", async () => {
  const {report, preparer} = await scenario({count: 3, eligible: i => i === 1, restore: async () => {}, freeBytes: 30, retained: footprint});
  expect(preparer).toHaveBeenCalledOnce(); expect(preparer.mock.calls[0][3]).toBe(1);
  expect(report.slots).toHaveLength(1); expect(report.ineligibleSlots.map(s => s.slotId)).toEqual(["fictional-0", "fictional-2"]);
  expect(report.disk.eligibleRetainedBytes).toBe(24); expect(report.timing.eligibleSlots).toBe(1); expect(report.feasible).toBe(true);
});
it("times preparation with the requested timeout instead of the child watchdog", async () => {
  let clock = 0; vi.spyOn(Date, "now").mockImplementation(() => 1000000000 + clock); vi.spyOn(performance, "now").mockImplementation(() => clock);
  const {report} = await scenario({count: 1, timeoutMs: 300, prepare: () => {clock += 420;}, restore: async () => {}, retained: footprint});
  expect(report.slots[0]).toMatchObject({watchdogMs: 300, failure: "lookup_preparation_timeout", feasible: false}); expect(report.timing.timeoutMs).toBe(300);
});
it.each([undefined, 0, -1, 1.5, 600001, Number.MAX_SAFE_INTEGER])("refuses invalid requested timeout %s", async timeoutMs => {
  vi.doMock("../lib/continuity-lookup-pilot.mjs", async original => ({...await original(), validateLookupPilotRegistration() {}}));
  const verify = vi.fn(); vi.doMock("../lib/continuity-lookup-roles.mjs", async original => ({...await original(), verifyRegisteredCheckouts: verify}));
  const {runLookupPreparationPreflight} = await import("../lib/continuity-lookup-preflight.mjs");
  // Validation occurs before any output-space read or temporary-root construction.
  await expect(runLookupPreparationPreflight({descriptor: {deadlines: {childWatchdogMs: 600000}}}, {timeoutMs, outputRoot: "/fictional/output"})).rejects.toThrow("lookup_registration_invalid"); expect(verify).not.toHaveBeenCalled();
});
it.each([["--registration", "--sha256", "a".repeat(64)], ["--unknown", "value"], ["--timeout-ms"]])("normalizes parser failure %j", async (...flags) => {
  const {main} = await import("../continuity-lookup-compare.mjs"); await expect(main(["preflight", ...flags])).rejects.toThrow("lookup_registration_invalid");
});

it("reads the proposed output volume without creating or changing the output path", async () => {
  const parent = await mkdtemp(join(tmpdir(), "lookup-output-volume-"));
  try {
    await writeFile(join(parent, "fictional-sentinel"), "Fictional output remains unchanged.", {mode: 0o600});
    const before = await lstat(parent, {bigint: true}), names = await readdir(parent);
    const {report} = await scenario({count: 1, runDeadlineMs: 2000000, restore: async () => {}, retained: footprint, outputRoot: join(parent, "missing/output")});
    expect(report.disk.freeBytes).toBeGreaterThan(0); expect(await readdir(parent)).toEqual(names);
    const after = await lstat(parent, {bigint: true}); expect([after.ino, after.mtimeNs, after.ctimeNs]).toEqual([before.ino, before.mtimeNs, before.ctimeNs]);
    await expect(access(join(parent, "missing"))).rejects.toMatchObject({code: "ENOENT"});
    expect(JSON.stringify(report)).not.toContain(parent);
  } finally {await rm(parent, {recursive: true, force: true});}
});
it.each([
  ["--registration", "fictional", "--sha256", "a".repeat(64), "--output-root", "/fictional/output"],
  ["--registration", "fictional", "--sha256", "a".repeat(64), "--timeout-ms", "1000"],
  ["--registration", "fictional", "--sha256", "a".repeat(64), "--timeout-ms", "1.5", "--output-root", "/fictional/output"],
])("requires explicit timeout and output flags: %j", async (...flags) => {
  const {main} = await import("../continuity-lookup-compare.mjs"); await expect(main(["preflight", ...flags])).rejects.toThrow("lookup_registration_invalid");
});

it.each([[600000, false, true, 0], [100000, false, false, 0], [100000, true, false, 1], [600000, true, true, 0]])("reports real equivalence for timeout=%s require=%s", async (timeoutMs, requireRealEquivalent, realEquivalent, status) => {
  const result = await scenario({count: 1, runDeadlineMs: 2000000, timeoutMs, requireRealEquivalent, restore: async () => {}, retained: footprint});
  expect(result.status).toBe(status); expect(result.report.feasible).toBe(true);
  expect(result.report).toMatchObject({realRequestedTimeoutMs: 600000, realEquivalent, realEquivalentRequired: requireRealEquivalent,
    realEquivalence: realEquivalent ? "matches_real_run_timeout" : "timeout_does_not_match_real_run"});
});
it.each([20000, 100])("uses real-shaped effective watchdogs and reserves the effective probe time for run=%s", async runDeadlineMs => {
  vi.spyOn(Date, "now").mockReturnValue(1000000000); vi.spyOn(performance, "now").mockReturnValue(0);
  const {report} = await scenario({count: 2, timeoutMs: 600000, deadlineMs: 200, runDeadlineMs, restore: async () => {}, retained: footprint});
  const {lookupPilotWatchdog} = await import("../lib/continuity-lookup-pilot-runtime.mjs");
  const realOptions = {schema: "continuity-lookup-pilot-authorization-v1", authorizationPath: "/fictional/authorization", controllerRoot: "/fictional/output", credentialPath: "/fictional/credential", registrationPath: "/fictional/registration", registrationSha256: "a".repeat(64)};
  const effective = lookupPilotWatchdog(realOptions, {deadlineMs: 200, childWatchdogMs: 600000}, 1000000000 + runDeadlineMs, 1000000000);
  expect(report.realEquivalent).toBe(true);
  for (const row of report.slots) expect(row).toMatchObject({watchdogMs: effective, restoreWatchdogMs: effective, probeWatchdogMs: effective, realWatchdogMs: effective, probeRemainingRunMs: runDeadlineMs});
  expect(report.timing).toMatchObject({effectiveTimeoutMs: 200, perSlotAllowanceMs: 5000, controllerAllowanceMs: 10000, probeReserveMs: 400, requiredRunMs: 10400});
  expect(report.feasible).toBe(10400 <= runDeadlineMs);
});
it.each([["--require-real-equivalent", "--require-real-equivalent"], ["--require-real-equivalent", "true"], ["--registration", "--require-real-equivalent", "fictional"]])("rejects malformed real-equivalence switch %j", async (...flags) => {
  const {main} = await import("../continuity-lookup-compare.mjs"); await expect(main(["preflight", ...flags])).rejects.toThrow("lookup_registration_invalid");
});

it.each([[470000, false], [400000, true], [400001, false]])("compares the preparation margin to the effective kill point for prep=%s", async (ms, feasible) => {
  let clock = 0; vi.spyOn(Date, "now").mockImplementation(() => 1000000000 + clock); vi.spyOn(performance, "now").mockImplementation(() => clock);
  const {report} = await scenario({count: 1, timeoutMs: 720000, childWatchdogMs: 720000, deadlineMs: 600000, runDeadlineMs: 3000000, prepare: () => {clock += ms;}, restore: async () => {}, retained: footprint});
  expect(report.realEquivalent).toBe(true); expect(report.feasible).toBe(feasible);
  expect(report.timing).toMatchObject({timeoutMs: 720000, effectiveTimeoutMs: 600000, requiredTimeoutMs: Math.ceil(ms * 1.5), probeReserveMs: 600000, controllerAllowanceMs: 5000});
});
it("compares very large free space as bigint and saturates only its JSON number", async () => {
  const {report} = await scenario({count: 1, restore: async () => {}, retained: footprint, freeBytes: 2n ** 100n});
  expect(report.feasible).toBe(true); expect(report.disk.freeBytes).toBe(Number.MAX_SAFE_INTEGER); expect(report.disk.requiredFreeBytes).toBe(30);
});
it.each([null, 1, {}, []].map(value => [value]))("refuses non-string direct outputRoot %j with the fixed code", async outputRoot => {
  vi.doMock("../lib/continuity-lookup-pilot.mjs", async original => ({...await original(), validateLookupPilotRegistration() {}}));
  const {runLookupPreparationPreflight} = await import("../lib/continuity-lookup-preflight.mjs");
  await expect(runLookupPreparationPreflight({descriptor: {deadlines: {childWatchdogMs: 600000}}}, {timeoutMs: 600000, outputRoot})).rejects.toMatchObject({code: "lookup_registration_invalid"});
});
it.each(["--real", "--real=value"])("preserves the explicit real refusal for %s", async flag => {
  const {main} = await import("../continuity-lookup-compare.mjs"); await expect(main(["preflight", flag])).rejects.toMatchObject({code: "lookup_real_not_authorized"});
});
it("retains a failed tree with an unreadable directory and names the safe cleanup step", async () => {
  let retainedRoot, unreadable;
  try {
    const {report, preparer, status} = await scenario({prepare: async ({root, slot}) => {
      retainedRoot = root; unreadable = join(root, "work", slot.slotId, "unreadable"); await mkdir(unreadable, {mode: 0});
      throw Object.assign(Error("fictional_partial_preparation"), {code: "lookup_preparation_invalid"});
    }, restore: async () => {}});
    expect(status).toBe(1); expect(preparer).toHaveBeenCalledOnce();
    expect(report).toMatchObject({feasible: false, cleanupFailed: true, cleanupFailure: "lookup_preparation_unreadable_directory", cleanupAction: "resolve_containment_then_remove_owned_root"});
    expect(report.slots.every(s => !s.feasible)).toBe(true); expect((await lstat(unreadable)).mode & 0o777).toBe(0);
    await expect(access(join(retainedRoot, "lookup-pilot-controller.json"))).resolves.toBeUndefined(); expect(JSON.stringify(report)).not.toContain(retainedRoot);
  } finally {if (unreadable) await chmod(unreadable, 0o700); if (retainedRoot) await rm(retainedRoot, {recursive: true, force: true});}
});

it("refuses an existing file output root before preparation instead of using its volume", async () => {
  const root = await mkdtemp(join(tmpdir(), "lookup-output-user-")), file = join(root, "not-a-directory");
  try {
    await writeFile(file, "Fictional output marker", {mode: 0o600});
    await expect(scenario({outputRoot: file, restore: async () => {}})).rejects.toMatchObject({code: "lookup_preflight_output_invalid"});
    expect((await import("../lib/continuity-lookup-controller.mjs")).runLookupPreparationSlot).not.toHaveBeenCalled();
    await expect(scenario({outputRoot: join(file, "missing"), restore: async () => {}})).rejects.toMatchObject({code: "lookup_preflight_output_invalid"});
    expect((await import("../lib/continuity-lookup-controller.mjs")).runLookupPreparationSlot).not.toHaveBeenCalled();
    expect((await lstat(file)).isFile()).toBe(true);
  } finally { await rm(root, {recursive: true, force: true}); }
});
it("uses the nearest existing directory for a missing output root without creating it", async () => {
  const root = await mkdtemp(join(tmpdir(), "lookup-output-user-")), outputRoot = join(root, "missing/deeper");
  try {
    const {status, report} = await scenario({count: 1, outputRoot, restore: async () => {}, retained: footprint});
    expect(status).toBe(0); expect(report.feasible).toBe(true);
    await expect(access(outputRoot)).rejects.toMatchObject({code: "ENOENT"}); expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, {recursive: true, force: true}); }
});
