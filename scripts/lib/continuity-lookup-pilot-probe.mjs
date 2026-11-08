import { readPilotPrivate, pilotStatePath, LOOKUP_REAL_CONTROLLER, LOOKUP_FAUX_CONTROLLER } from "./continuity-lookup-pilot-state.mjs";
import { createLookupFauxSend } from "./continuity-lookup-faux-capability.mjs";
// Configured probe with a one-use prepared-boundary proof, never JSON enablement.
import { armById, mergePatch } from "./continuity-arms.mjs";
import { LOOKUP_PRE_SEND_REFUSALS, LOOKUP_GUARD_POLICY_REFUSALS } from "./continuity-lookup-guard.mjs";
import { loadTraces } from "./continuity-dataset.mjs";
import { productionModules, runProbe, createJudge, configJson, lookupConfig, pilotDispatchConfig } from "./continuity-runner.mjs";
import { lookupPilotWork, lookupOfflineBoundary } from "./continuity-lookup-pilot-runtime.mjs";
import { assertLookupPilotArm, restoreLookupPreparation } from "./continuity-lookup-preparation.mjs";
import { createLookupRealSend } from "./continuity-lookup-real-capability.mjs";
import { writeLookupSlotRecord } from "./continuity-lookup-slot-record.mjs";

export async function runLookupConfiguredProbe(a) {
  const arm = armById(a.roleRequest.binding.arm), common = a.roleRequest.common, root = a.pilot.registration.codes[a.slot.code].path;
  assertLookupPilotArm(arm);
  let state;
  try { state = await readPilotPrivate(pilotStatePath(a.outputRoot)); }
  catch { throw Object.assign(Error("lookup_preparation_invalid"), { code: "lookup_preparation_invalid" }); }
  if (![LOOKUP_REAL_CONTROLLER, LOOKUP_FAUX_CONTROLLER].includes(state.schema)) throw Object.assign(Error("lookup_preparation_invalid"), { code: "lookup_preparation_invalid" });
  const real = state.schema === LOOKUP_REAL_CONTROLLER;
  const prepared = await restoreLookupPreparation(a);
  const modules = await productionModules(root), work = lookupPilotWork(a), authPath = real ? a.authorization.credentialPath : lookupOfflineBoundary({ plan: a.plan, arm, work }).authPath;
  const configPatch = lookupConfig(work, a.plan, pilotDispatchConfig(mergePatch(arm.sessionConfig ?? {}, arm.probeConfig)), true);
  const config = modules.config.resolveJsonMonoAgentConfig({ json: configJson({ work, authPath, model: a.plan.reader.model,
    effort: a.plan.reader.effort, tools: false, configPatch }), cwd: work });
  const send = await (real ? createLookupRealSend : createLookupFauxSend)(a, { plan: a.plan, arm, config });
  const pilot = { routeKind: real ? "real" : "faux", authorization: real ? undefined : { schema: "continuity-lookup-faux-authorization-v1" }, plan: a.plan, arm, send, preparation: prepared.proof };
  try {
    const loaded = await loadTraces({ suite: a.slot.suite, lookupSource: common.lookupSource, selectionSeed: common.lookupSelection.seed,
      perGroup: common.lookupSelection.perGroup, inputRoots: common.inputRoots });
    const trace = loaded.traces.find(t => t.id === a.slot.traceId), probe = trace?.probes.find(p => p.id === a.slot.probeId);
    if (!probe) throw Object.assign(new Error("lookup_pilot_capability_invalid"), { code: "lookup_pilot_capability_invalid" });
    const judge = createJudge({ modules, plan: a.plan, mode: "offline", workspace: work, authPath, pilot });
    if (judge !== null) throw Object.assign(new Error("lookup_auxiliary_callers_forbidden"), { code: "lookup_auxiliary_callers_forbidden" });
    const trial = await runProbe({ modules, trace, arm, repeat: 1, probe, checkpointWork: prepared.work,
      checkpointContinuity: prepared.manifest.continuity, checkpointConversationId: prepared.manifest.conversationId,
      forkDir: prepared.work,
      plan: a.plan, mode: "paid", authPath, root, pilot });
    // Before any outcome branch, so completed, wrong, lost and failed trials all keep
    // their content-free evidence. Evidence only: synchronous and unsynced, so it never
    // delays done past a stop's containment grace; a write failure leaves no record
    // (missing, never zero) and cannot reclassify a slot that may already have spent.
    if (trial.lookup) try { writeLookupSlotRecord(a, trial.lookup); } catch { /* Missing evidence. */ }
    if (LOOKUP_GUARD_POLICY_REFUSALS.includes(trial.failure)) {
      await send.permit.stop(trial.failure); return { terminal: "refused_pre_send", score: null, refusalCode: trial.failure };
    }
    if (LOOKUP_PRE_SEND_REFUSALS.includes(trial.failure)) return { terminal: "refused_pre_send", score: null, refusalCode: trial.failure };
    if (trial.failure === "lookup_account_mismatch") return { terminal: "integrity_stop", score: null };
    if (["pilot_empty_final_output", "store_degraded", "boundary_unverified", "pressure_unverified"].includes(trial.failure ?? trial.status)) return { terminal: trial.failure ?? trial.status, score: null };
    return { terminal: trial.status === "completed" ? trial.score?.pass ? "completed" : "wrong" : "lost",
      score: trial.status === "completed" ? Number(trial.score?.pass === true) : null };
  } finally { send.permit.close(); }
}
