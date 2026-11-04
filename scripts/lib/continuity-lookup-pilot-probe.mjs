// Configured probe plumbing; minting precedes runtime construction, never JSON mode flags.
import { join } from "node:path";
import { armById, mergePatch } from "./continuity-arms.mjs";
import { LOOKUP_PRE_SEND_REFUSALS, LOOKUP_GUARD_POLICY_REFUSALS } from "./continuity-lookup-guard.mjs";
import { loadTraces } from "./continuity-dataset.mjs";
import { productionModules, buildCheckpoint, runProbe, createJudge, configJson, lookupConfig, pilotDispatchConfig } from "./continuity-runner.mjs";
import { lookupPilotWork } from "./continuity-lookup-pilot-runtime.mjs";
import { createLookupRealSend } from "./continuity-lookup-real-capability.mjs";

export async function runLookupConfiguredProbe(a) {
  const arm = armById(a.roleRequest.binding.arm), common = a.roleRequest.common, root = a.pilot.registration.codes[a.slot.code].path;
  const modules = await productionModules(root), work = lookupPilotWork(a), authPath = a.authorization.credentialPath;
  const configPatch = lookupConfig(work, a.plan, pilotDispatchConfig(mergePatch(arm.sessionConfig ?? {}, arm.probeConfig)), true);
  const config = modules.config.resolveJsonMonoAgentConfig({ json: configJson({ work, authPath, model: a.plan.reader.model,
    effort: a.plan.reader.effort, tools: false, configPatch }), cwd: work });
  const send = await createLookupRealSend(a, { plan: a.plan, arm, config });
  const pilot = { routeKind: "real", plan: a.plan, arm, send };
  try {
    const loaded = await loadTraces({ suite: a.slot.suite, lookupSource: common.lookupSource, selectionSeed: common.lookupSelection.seed,
      perGroup: common.lookupSelection.perGroup, inputRoots: common.inputRoots });
    const trace = loaded.traces.find(t => t.id === a.slot.traceId), probe = trace?.probes.find(p => p.id === a.slot.probeId);
    if (!probe) throw Object.assign(new Error("lookup_pilot_capability_invalid"), { code: "lookup_pilot_capability_invalid" });
    const judge = createJudge({ modules, plan: a.plan, mode: "offline", workspace: work, authPath, pilot });
    if (judge !== null) throw Object.assign(new Error("lookup_auxiliary_callers_forbidden"), { code: "lookup_auxiliary_callers_forbidden" });
    const checkpoint = await buildCheckpoint({ modules, trace, arm, repeat: 1, dir: join(a.outputRoot, "work", a.slotId, "checkpoint"),
      plan: a.plan, mode: "offline", authPath, pilot });
    const trial = await runProbe({ modules, trace, arm, repeat: 1, probe, checkpointWork: checkpoint.work,
      checkpointSnapshot: checkpoint.snapshot ?? null, checkpointContinuity: checkpoint.record.continuity ?? null,
      checkpointConversationId: checkpoint.record.conversationId, forkDir: join(a.outputRoot, "work", a.slotId, "probe"),
      plan: a.plan, mode: "paid", authPath, root, pilot });
    if (LOOKUP_GUARD_POLICY_REFUSALS.includes(trial.failure)) {
      await send.permit.stop(trial.failure); return { terminal: "refused_pre_send", score: null, refusalCode: trial.failure };
    }
    if (LOOKUP_PRE_SEND_REFUSALS.includes(trial.failure)) return { terminal: "refused_pre_send", score: null, refusalCode: trial.failure };
    if (trial.failure === "lookup_account_mismatch") return { terminal: "integrity_stop", score: null };
    return { terminal: trial.status === "completed" ? trial.score?.pass ? "completed" : "wrong" : "lost",
      score: trial.status === "completed" ? Number(trial.score?.pass === true) : null };
  } finally { send.permit.close(); }
}
