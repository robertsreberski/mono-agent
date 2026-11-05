// Offline feasibility only. No authorization, registry consumption or output writer lease.
import { mkdtemp, realpath, chmod, readdir, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { digest } from "./continuity-dataset.mjs";
import { durable } from "./continuity-holdout-workflow.mjs";
import { validateLookupPilotRegistration } from "./continuity-lookup-pilot.mjs";
import { verifyRegisteredCheckouts } from "./continuity-lookup-roles.mjs";
import { lookupPilotSchedule, pilotStatePath } from "./continuity-lookup-pilot-state.mjs";
import { lookupProcessStartIdentity } from "./continuity-process-identity.mjs";
import { LOOKUP_PREFLIGHT, LOOKUP_TREE_LIMITS, lookupPreparationStats } from "./continuity-lookup-preparation.mjs";
import { runLookupPreparationSlot } from "./continuity-lookup-controller.mjs";
import { lookupPilotWatchdog } from "./continuity-lookup-pilot-runtime.mjs";

const need = ok => { if (!ok) throw Object.assign(Error("lookup_preparation_invalid"), { code: "lookup_preparation_invalid" }); };
async function removeOwned(root) {
  const writable = async path => { const s = await lstat(path); if (s.isDirectory() && !s.isSymbolicLink()) {
    await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name));
  } };
  await writable(root); await rm(root, { recursive: true, force: true });
}
export async function runLookupPreparationPreflight(pilot) {
  pilot = structuredClone(pilot);
  await validateLookupPilotRegistration(pilot);
  await verifyRegisteredCheckouts(pilot.registration);
  const root = await realpath(await mkdtemp(join(tmpdir(), "lookup-preflight-"))); await chmod(root, 0o700);
  const schedule = lookupPilotSchedule(pilot), slots = [];
  const state = { schema: LOOKUP_PREFLIGHT, runId: randomUUID(), epoch: randomUUID(), binding: digest(pilot),
    controller: { pid: process.pid, startIdentity: lookupProcessStartIdentity(process.pid) }, schedule, stop: null, cursor: 0,
    slots: schedule.map(s => ({ slotId: s.slotId, worker: null, holds: [], preparation: null })) };
  const save = () => durable(pilotStatePath(root), state);
  let tail = Promise.resolve();
  const serial = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
  // This journal has no admission/consume/settle methods and no output lease.
  const journal = {
    snapshot: () => structuredClone(state),
    assignPreparation(index, worker) { return serial(async () => { need(state.cursor === index && !state.slots[index].preparation && worker.pid > 1 && worker.pid !== process.pid
        && typeof worker.startIdentity === "string" && worker.startIdentity.length > 0 && lookupProcessStartIdentity(worker.pid) === worker.startIdentity);
      state.slots[index].preparation = { schema: "lookup-preflight-record-v1", ...worker, exited: false }; await save(); }); },
    recordMembers(index, members) { return serial(async () => {
      const p = state.slots[index].preparation;
      p.members = [...new Map([...(p.members ?? []), ...members].map(m => [`${m.pid}:${m.startIdentity}`, m])).values()]; await save();
    }); },
    prepared(index, treeDigest) { return serial(async () => { state.slots[index].preparation = { ...state.slots[index].preparation, treeDigest, exited: true }; await save(); }); },
    stop(code) { return serial(async () => { state.stop ??= code; await save(); }); },
    finish() { return serial(save); },
  };
  let contained = true;
  try {
    need(typeof state.controller.startIdentity === "string" && state.controller.startIdentity.length > 0);
    for (let index = 0; index < schedule.length; index++) {
      const slot = schedule[index];
      state.cursor = index; state.stop = null; state.deadlineAt = Date.now() + pilot.descriptor.deadlines.childWatchdogMs; await save();
      const watchdogMs = lookupPilotWatchdog({ timeoutMs: pilot.descriptor.deadlines.childWatchdogMs }, pilot.descriptor.deadlines, state.deadlineAt);
      const began = performance.now();
      try { await runLookupPreparationSlot(journal, pilot, root, index); }
      catch (error) { if (error.code === "lookup_unreconciled_processes") contained = false; throw error; }
      const durationMs = Math.ceil(performance.now() - began), stats = await lookupPreparationStats(join(root, "work", slot.slotId, "checkpoint", "snapshot"));
      slots.push({ slotId: slot.slotId, eligible: slot.eligible, ...stats, durationMs, watchdogMs,
        feasible: state.stop === null && stats.rejectedEntries.length === 0 && durationMs <= watchdogMs,
        failure: state.stop ?? (durationMs > watchdogMs ? "lookup_preparation_timeout" : stats.rejectedEntries.length ? "lookup_preparation_invalid" : null) });
      // Do not retain another slot's potentially large snapshot or runtime workspace.
      await removeOwned(join(root, "work"));
    }
    return { schema: "lookup-preflight-report-v1", limits: LOOKUP_TREE_LIMITS, slots,
      feasible: slots.every(s => s.feasible) };
  } finally { if (contained) await removeOwned(root); }
}
