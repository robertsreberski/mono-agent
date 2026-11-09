// Shared guarded-run mechanics. Historical authority identifiers remain visible to the exact source inventory.
import { mkdtemp, realpath, chmod, lstat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { digest } from "./continuity-dataset.mjs";
import { durable } from "./continuity-holdout-workflow.mjs";
import { lookupProcessStartIdentity } from "./continuity-process-identity.mjs";
import { guardedState } from "./continuity-guarded-state.mjs";
import { guardedSnapshot } from "./continuity-guarded-snapshot.mjs";
import { guardedController } from "./continuity-guarded-controller.mjs";
import { guardedProtocol } from "./continuity-guarded-protocols.mjs";
const instances = new Map();
export function guardedPreflight(protocolId) {
  const protocol = guardedProtocol(protocolId);
  if (!instances.has(protocol)) instances.set(protocol, bind(protocol, protocolId));
  return instances.get(protocol);
}
function bind(protocol, protocolId) {
  const { statePath: pilotStatePath } = guardedState(protocolId);
  const { lookupPreparationStats, removeLookupWorkTree, lookupRetainedBytes } = guardedSnapshot(protocolId);
  const { runLookupPreparationSlot } = guardedController(protocolId);
  const LOOKUP_PREFLIGHT = protocol.policy.PREFLIGHT, LOOKUP_TREE_LIMITS = protocol.policy.TREE_LIMITS;
  const { watchdog: lookupPilotWatchdog, validTimeout: validLookupPilotTimeout } = protocol.hooks;
  const need = ok => { if (!ok) throw Object.assign(Error(protocol.codes.preparation_invalid), { code: protocol.codes.preparation_invalid }); };
  async function freeSpace(outputRoot) {
    let path = outputRoot;
    for (;;) try {
      if (!(await lstat(path)).isDirectory()) throw Object.assign(Error("not_directory"), {code: "ENOTDIR"});
      const volume = await statfs(path, {bigint: true}), bytes = volume.bavail * volume.bsize;
      need(bytes >= 0n); return bytes;
    } catch (error) {
      if (error.code === "ENOENT" && dirname(path) !== path) { path = dirname(path); continue; }
      throw Object.assign(Error(protocol.codes.preflight_output_invalid), {code: protocol.codes.preflight_output_invalid});
    }
  }
  async function runLookupPreparationPreflight(pilot, {timeoutMs, outputRoot} = {}) {
    pilot = structuredClone(pilot);
    const bindings = await protocol.hooks.preflightBindings();
    await bindings.validateRegistration(pilot);
    if (!validLookupPilotTimeout(timeoutMs, pilot.descriptor.deadlines.childWatchdogMs) || typeof outputRoot !== "string" || !isAbsolute(outputRoot))
      throw Object.assign(Error(protocol.codes.registration_invalid), {code: protocol.codes.registration_invalid});
    await bindings.verifyCheckouts(pilot.registration);
    const realRequestedTimeoutMs = pilot.descriptor.deadlines.childWatchdogMs, realEquivalent = timeoutMs === realRequestedTimeoutMs;
    const freeBytes = await freeSpace(outputRoot);
    const effectiveTimeoutMs = Math.min(timeoutMs, pilot.descriptor.deadlines.deadlineMs), perSlotAllowanceMs = 5000;
    const root = await realpath(await mkdtemp(join(tmpdir(), protocol.preflightPrefix))); await chmod(root, 0o700);
    const schedule = bindings.schedule(pilot), slots = [], ineligibleSlots = [], beganRun = performance.now();
    const runDeadlineMs = pilot.descriptor.deadlines.runDeadlineMs, deadlineAt = Date.now() + runDeadlineMs;
    let preparationMs = 0, restoreMs = 0, retainedBytes = 0;
    const state = { schema: LOOKUP_PREFLIGHT, runId: randomUUID(), epoch: randomUUID(), binding: digest(pilot),
      controller: { pid: process.pid, startIdentity: lookupProcessStartIdentity(process.pid) }, schedule, stop: null, cursor: 0, deadlineAt, timeoutMs,
      slots: schedule.map(s => ({ slotId: s.slotId, worker: null, holds: [], preparation: null })) };
    const save = () => durable(pilotStatePath(root), state);
    let tail = Promise.resolve();
    const serial = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
    // This journal has no admission/consume/settle methods and no output lease.
    const journal = {
      snapshot: () => structuredClone(state),
      assignPreparation(index, worker) { return serial(async () => { need(state.cursor === index && !state.slots[index].preparation && worker.pid > 1 && worker.pid !== process.pid
          && typeof worker.startIdentity === "string" && worker.startIdentity.length > 0 && lookupProcessStartIdentity(worker.pid) === worker.startIdentity);
        state.slots[index].preparation = { schema: protocol.schemas.preflightRecord, ...worker, exited: false }; await save(); }); },
      recordMembers(index, members) { return serial(async () => {
        const p = state.slots[index].preparation;
        p.members = [...new Map([...(p.members ?? []), ...members].map(m => [`${m.pid}:${m.startIdentity}`, m])).values()]; await save();
      }); },
      prepared(index, treeDigest) { return serial(async () => { state.slots[index].preparation = { ...state.slots[index].preparation, treeDigest, exited: true }; await save(); }); },
      stop(code) { return serial(async () => { state.stop ??= code; await save(); }); },
      finish() { return serial(save); },
    };
    let contained = true, cleanupFailed = false, cleanupFailure = null, report;
    const cleanupAction = "resolve_containment_then_remove_owned_root";
    const cleanupCode = error => error.code === protocol.codes.preparation_unreadable_directory ? error.code : protocol.codes.preparation_invalid;
    try {
      need(typeof state.controller.startIdentity === "string" && state.controller.startIdentity.length > 0);
      for (let index = 0; index < schedule.length; index++) {
        const slot = schedule[index], empty = { fileCount: 0, totalBytes: 0, largestFileBytes: 0, rejectedEntries: [] };
        if (!slot.eligible) { ineligibleSlots.push({slotId: slot.slotId, eligible: false, skipped: true, reason: "ineligible"}); continue; }
        if (!contained || cleanupFailed || Date.now() >= deadlineAt) {
          slots.push({ slotId: slot.slotId, eligible: slot.eligible, ...empty, preparationMs: 0, restoreMs: 0, durationMs: 0,
            watchdogMs: 0, restoreWatchdogMs: 0, probeWatchdogMs: 0, realWatchdogMs: 0, probeRemainingRunMs: 0, feasible: false, skipped: true,
            failure: contained && !cleanupFailed ? protocol.codes.run_deadline : protocol.codes.preparation_invalid });
          continue;
        }
        state.cursor = index; state.stop = null; await save();
        const watchdog = () => lookupPilotWatchdog({ timeoutMs }, pilot.descriptor.deadlines, deadlineAt);
        const watchdogMs = watchdog(), began = performance.now(); let failure = null;
        try { await bindings.runPreparationSlot(journal, pilot, root, index); }
        catch (error) { if (error.code === protocol.codes.unreconciled_processes) contained = false; failure = protocol.codes.preparation_invalid; }
        const slotPreparationMs = Math.ceil(performance.now() - began);
        preparationMs += slotPreparationMs;
        const stats = contained ? await bindings.preparationStats(join(root, "work", slot.slotId, "checkpoint", "snapshot")) : empty;
        failure ??= state.stop ?? (stats.rejectedEntries.length ? protocol.codes.preparation_invalid : null);
        let slotRestoreMs = 0, restoreWatchdogMs = 0;
        if (!failure) {
          if (Date.now() >= deadlineAt) failure = protocol.codes.run_deadline;
          else {
            restoreWatchdogMs = watchdog(); const beganRestore = performance.now();
            try { await bindings.restorePreflight({ outputRoot: root, index, slotId: slot.slotId, slot }); }
            catch { failure = protocol.codes.preparation_invalid; }
            slotRestoreMs = Math.ceil(performance.now() - beganRestore); restoreMs += slotRestoreMs;
          }
        }
        failure ??= slotPreparationMs > watchdogMs || slotRestoreMs > restoreWatchdogMs ? protocol.codes.preparation_timeout
          : Date.now() >= deadlineAt ? protocol.codes.run_deadline : null;
        let retained = null;
        if (!failure) try { retained = await bindings.retainedBytes(join(root, "work", slot.slotId)); retainedBytes += retained.retainedBytes; }
        catch { failure = protocol.codes.preparation_invalid; }
        const now = Date.now(), probeRemainingRunMs = Math.max(0, deadlineAt - now);
        const probeWatchdogMs = probeRemainingRunMs > 0 ? lookupPilotWatchdog({timeoutMs}, pilot.descriptor.deadlines, deadlineAt, now) : 0;
        // Real-shaped options carry no timeoutMs; the same helper supplies the registered default.
        const realWatchdogMs = probeRemainingRunMs > 0 ? lookupPilotWatchdog({}, pilot.descriptor.deadlines, deadlineAt, now) : 0;
        const row = { retained, probeWatchdogMs, realWatchdogMs, probeRemainingRunMs, slotId: slot.slotId, eligible: slot.eligible, ...stats, preparationMs: slotPreparationMs, restoreMs: slotRestoreMs,
          durationMs: slotPreparationMs + slotRestoreMs, watchdogMs, restoreWatchdogMs, feasible: failure === null, failure };
        slots.push(row);
        // Never remove a root while a preparation group is unreconciled.
        if (contained) try { await bindings.removeWorkTree(join(root, "work")); }
        catch (error) { cleanupFailed = true; cleanupFailure = cleanupCode(error); row.feasible = false; row.failure = protocol.codes.preparation_invalid; }
      }
      const elapsedMs = Math.ceil(performance.now() - beganRun), preparationAndRestoreMs = preparationMs + restoreMs;
      const eligibleSlots = schedule.filter(s => s.eligible).length, slowestPreparationMs = Math.max(0, ...slots.map(s => s.preparationMs));
      const requiredTimeoutMs = Math.ceil(slowestPreparationMs * 1.5), probeReserveMs = eligibleSlots * effectiveTimeoutMs, controllerAllowanceMs = eligibleSlots * perSlotAllowanceMs;
      const requiredRunMs = Math.ceil(preparationAndRestoreMs * 1.5) + probeReserveMs + controllerAllowanceMs, requiredFreeBytes = Math.ceil(retainedBytes * 1.25);
      const timeFeasible = Number.isSafeInteger(requiredRunMs) && requiredRunMs <= runDeadlineMs && effectiveTimeoutMs >= requiredTimeoutMs && elapsedMs < runDeadlineMs;
      const diskFeasible = Number.isSafeInteger(requiredFreeBytes) && freeBytes >= BigInt(requiredFreeBytes);
      report = { schema: protocol.schemas.preflightReport, realRequestedTimeoutMs, realEquivalent,
        realEquivalence: realEquivalent ? "matches_real_run_timeout" : "timeout_does_not_match_real_run", limits: LOOKUP_TREE_LIMITS, slots, ineligibleSlots,
        timing: { timeoutMs, effectiveTimeoutMs, perSlotAllowanceMs, controllerAllowanceMs, eligibleSlots, preparationMs, restoreMs, preparationAndRestoreMs, elapsedMs, runDeadlineMs,
          probeTimeExcluded: true, margin: 1.5, slowestPreparationMs, requiredTimeoutMs, probeReserveMs, requiredRunMs, feasible: timeFeasible },
        disk: {eligibleRetainedBytes: retainedBytes, freeBytes: Number(freeBytes > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : freeBytes), requiredFreeBytes, margin: 1.25, feasible: diskFeasible},
        unreconciledProcesses: !contained, cleanupFailed, cleanupFailure, cleanupAction: !contained || cleanupFailed ? cleanupAction : null,
        feasible: eligibleSlots > 0 && slots.every(s => s.feasible) && timeFeasible && diskFeasible };

      return report;
    } finally {
      if (contained && !cleanupFailed) try { await bindings.removeWorkTree(root); }
      catch (error) { if (!report) throw error; report.cleanupFailed = true; report.cleanupFailure = cleanupCode(error); report.cleanupAction = cleanupAction; report.feasible = false; report.failure = protocol.codes.preparation_invalid; }
    }
  }
  return Object.freeze({ runLookupPreparationPreflight });
}
