// Shared guarded-run mechanics; historical authority names remain visible to the exact inventory.
import { digest } from "./continuity-dataset.mjs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { lookupProcessStartIdentity } from "./continuity-process-identity.mjs";
import { guardedState } from "./continuity-guarded-state.mjs";
import { guardedLease } from "./continuity-guarded-lease.mjs";
import { guardedSnapshot } from "./continuity-guarded-snapshot.mjs";
import { guardedAccounting } from "./continuity-guarded-accounting.mjs";
import { guardedProtocol } from "./continuity-guarded-protocols.mjs";

const instances = new Map();
export function guardedIPC(protocolId) {
  const protocol = guardedProtocol(protocolId);
  if (!instances.has(protocol)) instances.set(protocol, bind(protocol, protocolId));
  return instances.get(protocol);
}
function bind(protocol, protocolId) {
  const { readPrivate: readPilotPrivate, statePath: pilotStatePath, sameRun: samePilot, runHash: pilotHash, runId: pilotId, requireFaux: requireFauxPilot } = guardedState(protocolId);
  const LOOKUP_REAL_CONTROLLER = protocol.policy.REAL_CONTROLLER, LOOKUP_FAUX_CONTROLLER = protocol.policy.FAUX_CONTROLLER, LOOKUP_PILOT_IPC = protocol.policy.PILOT_IPC;
  const { readLease: readLookupPilotLease } = guardedLease(protocolId), { verifyLookupPreparation } = guardedSnapshot(protocolId), { need: pilotNeed } = guardedAccounting(protocolId);
  const { cacheAssignment: assertLookupCacheAssignment, watchdog: lookupPilotWatchdog } = protocol.hooks;
  const LOOKUP_PERMIT_CONTRACT = protocol.policy.PERMIT_CONTRACT;
  async function verifyLookupPilotParent(assignment) {
    pilotNeed(!Object.hasOwn(process.env, "CONTINUITY_DEBUG"), protocol.codes.debug_forbidden);
    const state = await readPilotPrivate(pilotStatePath(assignment.outputRoot));
    if (state.schema === LOOKUP_REAL_CONTROLLER) {
      await protocol.hooks.verifyRealAssignment(assignment);
      return state;
    }
    pilotNeed(state.schema === LOOKUP_FAUX_CONTROLLER, protocol.codes.ipc_invalid);
    const slot = state.slots[assignment.index];
    assertLookupCacheAssignment(state, assignment);
    pilotNeed(samePilot(state.schedule, await protocol.hooks.schedule(assignment.pilot)), protocol.codes.ipc_invalid);
    const parentStart = lookupProcessStartIdentity(process.ppid);
    pilotNeed(typeof parentStart === "string" && parentStart.length > 0 && state.controller.pid === process.ppid
      && parentStart === state.controller.startIdentity, protocol.codes.ipc_invalid);
    pilotNeed(await protocol.hooks.fauxAssignmentMatches(assignment, state), protocol.codes.ipc_invalid);
    pilotNeed(state.schema === LOOKUP_FAUX_CONTROLLER && state.epoch === assignment.epoch && state.runId === assignment.runId && process.connected
      && slot?.worker?.pid === process.pid && slot.worker.startIdentity === lookupProcessStartIdentity(process.pid)
      && slot.slotId === assignment.slotId && slot.cacheKey === assignment.cacheKey && samePilot(state.schedule[assignment.index], assignment.slot), protocol.codes.ipc_invalid);
    await verifyLookupPreparation(assignment, state);
    await readLookupPilotLease(assignment.outputRoot, state.controller);
    const consumed = await readPilotPrivate(join(assignment.outputRoot, "authorization-consumed.json"));
    const key = createHash("sha256").update(protocol.fauxDomain + consumed.authorizationId).digest("hex");
    const registry = await readPilotPrivate(join(dirname(assignment.outputRoot), protocol.fauxRegistry, key, "claim.json"));
    pilotNeed(consumed.schema === protocol.schemas.fauxConsumption && consumed.controllerEpoch === state.epoch
      && consumed.runId === state.runId && consumed.outputRoot === assignment.outputRoot && consumed.binding === state.binding
      && samePilot(consumed.controller, state.controller) && samePilot(consumed, registry), protocol.codes.ipc_invalid);
    return state;
  }
  async function createLookupPilotIPC(assignment) {
    const initial = await verifyLookupPilotParent(assignment);
    const timeoutMs = lookupPilotWatchdog({ timeoutMs: assignment.timeoutMs }, assignment.pilot.descriptor.deadlines, initial.deadlineAt);
    let seq = 0, pending, failed = false;
    const grants = new WeakMap();
    const abort = () => { failed = true; if (pending) { clearTimeout(pending.timer); pending.reject(Object.assign(new Error(protocol.codes.ipc_disconnected), { code: protocol.codes.ipc_disconnected })); pending = null; } if (process.connected) process.disconnect(); };
    process.on("disconnect", abort);
    const listener = async message => {
      if (message?.type !== "ack") return abort();
      const p = pending;
      if (!p || p.receiving || message.version !== LOOKUP_PILOT_IPC || message.epoch !== assignment.epoch || message.slotId !== assignment.slotId || message.seq !== p.seq) return abort();
      p.receiving = true; clearTimeout(p.timer);
      try {
        const state = await readPilotPrivate(pilotStatePath(assignment.outputRoot)), slot = state.slots[assignment.index];
        pilotNeed(state.epoch === assignment.epoch && state.revision >= message.revision
          && samePilot(slot?.lastAck, message), protocol.codes.persist_failed);
        pending = null;
        if (!message.ok) { failed = true; p.reject(Object.assign(new Error(message.code), { code: message.code })); }
        else p.resolve(message.result);
      } catch { abort(); }
    };
    process.on("message", listener);
    const request = (op, payload) => {
      pilotNeed(!failed && process.connected && !pending && LOOKUP_PERMIT_CONTRACT.methods.includes(op), protocol.codes.ipc_invalid);
      const number = seq++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { abort(); process.disconnect?.(); }, timeoutMs);
        pending = { seq: number, resolve, reject, timer };
        process.send({ version: LOOKUP_PILOT_IPC, epoch: assignment.epoch, slotId: assignment.slotId, seq: number, op, payload }, error => { if (error) abort(); });
      });
    };
    const token = permit => { const value = grants.get(permit); pilotNeed(value, protocol.codes.permit_invalid); return value; };
    return Object.freeze({ brand: initial.schema === LOOKUP_REAL_CONTROLLER ? protocol.permitBrand : protocol.fauxBrand, testOnly: initial.schema !== LOOKUP_REAL_CONTROLLER, pilot: true,
      async admit(value) {
        const result = await request("admit", value);
        if (result.refused) return result;
        const permit = Object.freeze({}); grants.set(permit, result); return permit;
      },
      consume: (permit, bodyDigest) => request("consume", { permit: token(permit), bodyDigest }),
      settle: (permit, outcome, rawUsage, tier, evidence) => request("settle", { permit: token(permit), outcome, rawUsage, tier: tier ?? null, ...(evidence === undefined ? {} : { evidence }) }),
      ...(protocol.execution ? { compaction: value => request("compaction", value) } : {}),
      stop: code => request("stop", { code }),
      close() { failed = true; process.off("message", listener); process.off("disconnect", abort); if (pending) { clearTimeout(pending.timer); abort(); } },
    });
  }
  return Object.freeze({ verifyLookupPilotParent, createLookupPilotIPC });
}
