// Offline preparation only: no permit, send factory or credential-bearing assignment.
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { assertLookupPilotEntry } from "./continuity-lookup-pilot-entry.mjs";
import { ROOT, verifyRoleRequest } from "./continuity-lookup-roles.mjs";
import { armById } from "./continuity-arms.mjs";
import { loadTraces, digest } from "./continuity-dataset.mjs";
import { lookupProcessStartIdentity } from "./continuity-process-identity.mjs";
import { readLookupPilotLease } from "./continuity-lookup-lease.mjs";
import { readPilotPrivate, pilotStatePath, LOOKUP_REAL_CONTROLLER, LOOKUP_FAUX_CONTROLLER, samePilot } from "./continuity-lookup-pilot-state.mjs";
import { productionModules, buildCheckpoint } from "./continuity-runner.mjs";
import { lookupPilotWork, lookupOfflineBoundary } from "./continuity-lookup-pilot-runtime.mjs";
import { assertLookupPilotArm, writeLookupPreparation } from "./continuity-lookup-preparation.mjs";
const need = ok => { if (!ok) throw Object.assign(new Error("lookup_preparation_invalid"), { code: "lookup_preparation_invalid" }); };
export async function prepareLookupCheckpoint(a) {
  need(!Object.hasOwn(process.env, "CONTINUITY_DEBUG"));
  const state = await readPilotPrivate(pilotStatePath(a.outputRoot)), preparing = state.slots[a.index]?.preparation;
  if (state.schema === LOOKUP_REAL_CONTROLLER) {
    assertLookupPilotEntry(); need(!Object.hasOwn(process.env, "CI"));
  } else need(state.schema === LOOKUP_FAUX_CONTROLLER);
  need(a.authorization === undefined && process.connected && state.stop === null && state.cursor === a.index
    && state.binding === digest(a.pilot) && state.runId === a.runId && state.epoch === a.epoch
    && state.controller.pid === process.ppid && state.controller.startIdentity === lookupProcessStartIdentity(process.ppid)
    && preparing?.pid === process.pid && preparing.startIdentity === lookupProcessStartIdentity(process.pid) && preparing.exited === false
    && ROOT === a.pilot.registration.codes[a.slot.code]?.path && a.roleRequest.binding.id === a.slot.roleId
    && a.roleRequest.binding.registrationSha256 === digest(a.pilot.registration) && samePilot(a.roleRequest.common, a.pilot.registration.common)
    && samePilot(state.schedule[a.index], a.slot) && state.slots[a.index].worker === null && !state.slots[a.index].holds.length);
  await readLookupPilotLease(a.outputRoot, state.controller);
  await verifyRoleRequest(ROOT, a.roleRequest, a.plan);
  const arm = armById(a.roleRequest.binding.arm); assertLookupPilotArm(arm);
  const common = a.roleRequest.common, work = lookupPilotWork(a);
  const { mode, authPath } = lookupOfflineBoundary({ plan: a.plan, arm, work });
  const loaded = await loadTraces({ suite: a.slot.suite, lookupSource: common.lookupSource, selectionSeed: common.lookupSelection.seed,
    perGroup: common.lookupSelection.perGroup, inputRoots: common.inputRoots });
  const trace = loaded.traces.find(t => t.id === a.slot.traceId); need(trace);
  const modules = await productionModules(ROOT);
  const checkpoint = await buildCheckpoint({ modules, trace, arm, repeat: 1, dir: dirname(work), plan: a.plan, mode, authPath });
  const treeDigest = await writeLookupPreparation(a, checkpoint);
  return treeDigest;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.send || !process.connected) throw Error("lookup_ipc_invalid");
  process.once("message", a => { void (async () => {
    const go = new Promise(resolve => process.once("message", resolve));
    process.send({ type: "ready", epoch: a.epoch, slotId: a.slotId });
    const start = await go; need(start?.type === "go" && start.epoch === a.epoch && start.slotId === a.slotId);
    const treeDigest = await prepareLookupCheckpoint(a);
    const ack = new Promise(resolve => process.once("message", resolve));
    process.send({ type: "prepared", epoch: a.epoch, slotId: a.slotId, treeDigest });
    const done = await ack; need(done?.type === "done-ack" && done.epoch === a.epoch && done.slotId === a.slotId);
    process.disconnect();
  })().catch(() => { process.exitCode = 1; process.disconnect?.(); }); });
  process.send({ type: "loaded" });
}
