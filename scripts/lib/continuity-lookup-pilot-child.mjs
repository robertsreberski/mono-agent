// Internal assigned probe; real construction remains behind the shared entry gate.
import { assertLookupPilotEntry } from "./continuity-lookup-pilot-entry.mjs";
import { armById } from "./continuity-arms.mjs";
import { assertResolvedLookupSafety, fauxLookupSafety } from "./continuity-lookup-pilot-runtime.mjs";
import { fileURLToPath } from "node:url";
import { LOOKUP_GUARD_POLICY_REFUSALS, assertLookupChildSafety } from "./continuity-lookup-guard.mjs";
import { validateLookupPilotRegistration } from "./continuity-lookup-pilot.mjs";
import { ROOT, verifyRoleRequest } from "./continuity-lookup-roles.mjs";
import { verifyLookupPilotParent } from "./continuity-lookup-ipc.mjs";
import { readPilotPrivate, pilotStatePath, LOOKUP_REAL_CONTROLLER, LOOKUP_FAUX_CONTROLLER } from "./continuity-lookup-pilot-state.mjs";
import { pilotNeed } from "./continuity-lookup-pilot-accounting.mjs";

export async function runLookupPilotChild(a) {
  let state;
  try { state = await readPilotPrivate(pilotStatePath(a.outputRoot)); }
  catch { throw Object.assign(Error("lookup_preparation_invalid"), { code: "lookup_preparation_invalid" }); }
  pilotNeed([LOOKUP_REAL_CONTROLLER, LOOKUP_FAUX_CONTROLLER].includes(state.schema), "lookup_ipc_invalid");
  const real = state.schema === LOOKUP_REAL_CONTROLLER;
  if (real) assertLookupPilotEntry();
  pilotNeed(!Object.hasOwn(process.env, "CONTINUITY_DEBUG"), "lookup_debug_forbidden");
  if (real) await (await import("./continuity-lookup-real-capability.mjs")).verifyLookupRealAssignment(a, false);
  else await verifyLookupPilotParent(a);
  await validateLookupPilotRegistration(a.pilot);
  await verifyRoleRequest(ROOT, a.roleRequest, a.plan);
  assertLookupChildSafety({ plan: a.plan, memory: false, subagents: false, upkeep: false, compaction: false, outputSchema: null });
  const resolvedSafety = fauxLookupSafety(a.plan, armById(a.roleRequest.binding.arm)); assertResolvedLookupSafety(resolvedSafety);
  const go = new Promise(resolve => process.once("message", resolve));
  process.send({ type: "ready", epoch: a.epoch, slotId: a.slotId });
  const start = await go;
  pilotNeed(start?.type === "go" && start.epoch === a.epoch && start.slotId === a.slotId, "lookup_ipc_invalid");
  let outcome;
  try { outcome = await (await import("./continuity-lookup-pilot-probe.mjs")).runLookupConfiguredProbe(a); }
  catch (error) { outcome = refusal(error); }
  await finish(a, outcome);
}
function refusal(error) {
  return { terminal: "refused_pre_send", score: null,
    refusalCode: LOOKUP_GUARD_POLICY_REFUSALS.includes(error.code) ? error.code : "lookup_pilot_capability_invalid" };
}

async function finish(a, outcome) {
  await new Promise((resolve, reject) => {
    const cleanup = () => { process.off("message", ack); process.off("disconnect", disconnected); };
    const disconnected = () => { cleanup(); reject(Object.assign(new Error("lookup_ipc_disconnected"), { code: "lookup_ipc_disconnected" })); };
    const ack = message => {
      cleanup();
      try { pilotNeed(message?.type === "done-ack" && message.epoch === a.epoch && message.slotId === a.slotId, "lookup_ipc_invalid"); resolve(); }
      catch (error) { reject(error); }
    };
    process.once("message", ack); process.once("disconnect", disconnected);
    process.send({ type: "done", epoch: a.epoch, slotId: a.slotId, ...outcome }, error => { if (error) { cleanup(); reject(error); } });
  });
  process.disconnect();
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.send || !process.connected) throw new Error("lookup_ipc_invalid");
  process.once("message", a => { void runLookupPilotChild(a).catch(async error => {
    if (error.code === "lookup_preparation_invalid") try { await finish(a, refusal(error)); return; } catch {}
    process.exitCode = 1; if (process.connected) process.disconnect();
  }); });
  process.send({ type: "loaded" });
}
