import { assertLookupCacheAssignment } from "./continuity-lookup-pilot-runtime.mjs";
import { digest } from "./continuity-dataset.mjs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { LOOKUP_FAUX_AUTHORIZATION_DOMAIN } from "./continuity-lookup-pilot.mjs";
import { LOOKUP_PERMIT_CONTRACT } from "./continuity-lookup-guard.mjs";
import { lookupProcessStartIdentity } from "./continuity-process-identity.mjs";
import { readLookupPilotLease } from "./continuity-lookup-lease.mjs";
import { pilotNeed } from "./continuity-lookup-pilot-accounting.mjs";
import { LOOKUP_REAL_CONTROLLER, LOOKUP_FAUX_CONTROLLER, LOOKUP_PILOT_IPC, readPilotPrivate, pilotStatePath, samePilot, lookupPilotSchedule } from "./continuity-lookup-pilot-state.mjs";

/** An IPC pipe alone is not authority: also bind the durable live parent and this assigned PID. */
export async function verifyLookupPilotParent(assignment) {
  pilotNeed(!Object.hasOwn(process.env, "CONTINUITY_DEBUG"), "lookup_debug_forbidden");
  const state = await readPilotPrivate(pilotStatePath(assignment.outputRoot));
  if (state.schema === LOOKUP_REAL_CONTROLLER) {
    await (await import("./continuity-lookup-real-capability.mjs")).verifyLookupRealAssignment(assignment);
    return state;
  }
  const slot = state.slots[assignment.index];
  assertLookupCacheAssignment(state, assignment);
  pilotNeed(samePilot(state.schedule, lookupPilotSchedule(assignment.pilot)), "lookup_ipc_invalid");
  const parentStart = lookupProcessStartIdentity(process.ppid);
  pilotNeed(typeof parentStart === "string" && parentStart.length > 0 && state.controller.pid === process.ppid
    && parentStart === state.controller.startIdentity, "lookup_ipc_invalid");
  pilotNeed(digest(assignment.pilot) === state.binding
    && assignment.roleRequest.binding.id === assignment.slot.roleId
    && assignment.roleRequest.binding.registrationSha256 === digest(assignment.pilot.registration)
    && samePilot(assignment.roleRequest.build, assignment.pilot.registration.codes[assignment.slot.code].build), "lookup_ipc_invalid");
  pilotNeed(state.schema === LOOKUP_FAUX_CONTROLLER && state.epoch === assignment.epoch && state.runId === assignment.runId && process.connected
    && slot?.worker?.pid === process.pid && slot.worker.startIdentity === lookupProcessStartIdentity(process.pid)
    && slot.slotId === assignment.slotId && slot.cacheKey === assignment.cacheKey && samePilot(state.schedule[assignment.index], assignment.slot), "lookup_ipc_invalid");
  await readLookupPilotLease(assignment.outputRoot, state.controller);
  const consumed = await readPilotPrivate(join(assignment.outputRoot, "authorization-consumed.json"));
  const key = createHash("sha256").update(LOOKUP_FAUX_AUTHORIZATION_DOMAIN + consumed.authorizationId).digest("hex");
  const registry = await readPilotPrivate(join(dirname(assignment.outputRoot), ".lookup-faux-consumed-v1", key, "claim.json"));
  pilotNeed(consumed.schema === "lookup-faux-consumption-v1" && consumed.controllerEpoch === state.epoch
    && consumed.runId === state.runId && consumed.outputRoot === assignment.outputRoot && consumed.binding === state.binding
    && samePilot(consumed.controller, state.controller) && samePilot(consumed, registry), "lookup_ipc_invalid");
  return state;
}
/** Frozen four-method guard contract; one in-flight exchange, no retry or caller-supplied transport. */
export async function createLookupPilotIPC(assignment) {
  const initial = await verifyLookupPilotParent(assignment);
  let seq = 0, pending, failed = false;
  const grants = new WeakMap();
  const abort = () => { failed = true; if (pending) { clearTimeout(pending.timer); pending.reject(Object.assign(new Error("lookup_ipc_disconnected"), { code: "lookup_ipc_disconnected" })); pending = null; } if (process.connected) process.disconnect(); };
  process.on("disconnect", abort);
  const listener = async message => {
    if (message?.type !== "ack") return abort();
    const p = pending;
    if (!p || p.receiving || message.version !== LOOKUP_PILOT_IPC || message.epoch !== assignment.epoch || message.slotId !== assignment.slotId || message.seq !== p.seq) return abort();
    p.receiving = true; clearTimeout(p.timer);
    try {
      const state = await readPilotPrivate(pilotStatePath(assignment.outputRoot)), slot = state.slots[assignment.index];
      pilotNeed(state.epoch === assignment.epoch && state.revision >= message.revision
        && samePilot(slot?.lastAck, message), "lookup_persist_failed");
      pending = null;
      if (!message.ok) { failed = true; p.reject(Object.assign(new Error(message.code), { code: message.code })); }
      else p.resolve(message.result);
    } catch { abort(); }
  };
  process.on("message", listener);
  const request = (op, payload) => {
    pilotNeed(!failed && process.connected && !pending && LOOKUP_PERMIT_CONTRACT.methods.includes(op), "lookup_ipc_invalid");
    const number = seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { abort(); process.disconnect?.(); }, assignment.timeoutMs);
      pending = { seq: number, resolve, reject, timer };
      process.send({ version: LOOKUP_PILOT_IPC, epoch: assignment.epoch, slotId: assignment.slotId, seq: number, op, payload }, error => { if (error) abort(); });
    });
  };
  const token = permit => { const value = grants.get(permit); pilotNeed(value, "lookup_permit_invalid"); return value; };
  return Object.freeze({ brand: initial.schema === LOOKUP_REAL_CONTROLLER ? "lookup-controller-v1" : "lookup-faux-test-only-v1", testOnly: initial.schema !== LOOKUP_REAL_CONTROLLER, pilot: true,
    async admit(value) {
      const result = await request("admit", value);
      if (result.refused) return result;
      const permit = Object.freeze({}); grants.set(permit, result); return permit;
    },
    consume: (permit, bodyDigest) => request("consume", { permit: token(permit), bodyDigest }),
    settle: (permit, outcome, rawUsage, tier) => request("settle", { permit: token(permit), outcome, rawUsage, tier: tier ?? null }),
    stop: code => request("stop", { code }),
    close() { failed = true; process.off("message", listener); process.off("disconnect", abort); if (pending) { clearTimeout(pending.timer); abort(); } },
  });
}
