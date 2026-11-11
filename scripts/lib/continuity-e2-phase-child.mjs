// Literal assigned entry. A planned seed/resume is not an authorization recovery path.
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyE2Assignment, createE2PhaseAdapter } from "./continuity-e2-runtime.mjs";
import { guardedAuthorization } from "./continuity-guarded-authorization.mjs";
import { digest } from "./continuity-recorded-schema.mjs";
import { e2PhaseBase } from "./continuity-e2-lineage.mjs";
import { knownRefusalCode } from "./continuity-e2-diagnostics.mjs";
import { proofRefusalCode } from "./continuity-e2-checks.mjs";
import { E2_GUARD_STOPS, E2_GUARD_POLICY_REFUSALS, E2_PRE_SEND_REFUSALS } from "./continuity-e2-policy.mjs";
const need = ok => { if (!ok) throw Object.assign(Error("e2_ipc_invalid"), { code: "e2_ipc_invalid" }); };
async function boundJSON(binding, source = false) {
  const bytes = await guardedAuthorization("e2-validation").readArtifact(binding.path, "e2_registration_invalid", source ? 128 * 1024 * 1024 : 4 * 1024 * 1024);
  need(digest(bytes) === binding.sha256); return JSON.parse(bytes);
}
async function done(a, outcome) {
  await new Promise((resolve, reject) => {
    const cleanup = () => { process.off("message", ack); process.off("disconnect", lost); };
    const lost = () => { cleanup(); reject(Error("e2_ipc_disconnected")); };
    const ack = message => { cleanup(); try { need(message?.type === "done-ack" && message.epoch === a.epoch && message.slotId === a.slotId); resolve(); } catch (error) { reject(error); } };
    process.once("message", ack); process.once("disconnect", lost);
    process.send({ type: "done", epoch: a.epoch, slotId: a.slotId, ...outcome }, error => { if (error) { cleanup(); reject(error); } });
  });
  process.disconnect();
}
export async function runE2AssignedPhase(a) {
  await verifyE2Assignment(a, false);
  const go = new Promise(resolve => process.once("message", resolve)); process.send({ type: "ready", epoch: a.epoch, slotId: a.slotId });
  const start = await go; need(start?.type === "go" && start.epoch === a.epoch && start.slotId === a.slotId);
  const adapter = await createE2PhaseAdapter(a), base = e2PhaseBase(a.outputRoot, a.slot);
  let restore, outcome;
  try {
    if (a.slot.kind === "replay") {
      const r = a.pilot.registration, { runE2Sizing } = await import("./continuity-e2-replay.mjs");
      const result = await runE2Sizing({ source: await boundJSON(r.source, true), protocol: await boundJSON(r.protocol), questions: await boundJSON(r.probes),
        evaluator: await boundJSON(r.keys), output: base, summary: "real", paidAdapter: adapter });
      outcome = { terminal: result.score === 0 ? "wrong" : "completed", score: result.score, refusalCode: null };
    } else {
      await mkdir(base, { recursive: true, mode: 0o700 });
      const { proofEnvironment, installProofIsolation } = await import("./continuity-e2-isolation.mjs");
      restore = installProofIsolation(await proofEnvironment(join(base, "hermetic")));
      const { runProofPhase } = await import("./continuity-e2-proofs.mjs");
      const result = await runProofPhase({ base, arm: a.slot.arm, phase: a.slot.phase, variant: a.slot.variant, paidAdapter: adapter });
      await writeFile(join(base, `${a.slot.phase}.json`), `${JSON.stringify(result)}\n`, { flag: "wx", mode: 0o600 });
      outcome = { terminal: "completed", score: a.slot.phase === "seed" ? null : 1, refusalCode: null };
    }
    await adapter.flush();
  } catch (error) {
    // Unknown/runtime failures end the entire authorization, never a retry/fallback.
    const mapped = { E2_SUMMARY_NOT_AUTHORIZED: "e2_summary_not_authorized", E2_MODELS_METHOD_REFUSED: "e2_method_forbidden", E2_MODEL_UNREGISTERED: "e2_route_mismatch", E2_SUMMARY_OPTIONS_INVALID: "e2_option_forbidden" }[error?.code];
    const code = mapped ?? (E2_GUARD_STOPS.includes(error?.code) ? error.code : "e2_phase_failed");
    await adapter.stop(code);
    try { await mkdir(base, { recursive: true, mode: 0o700 }); await writeFile(join(base, `${a.slot.phase}-refusal.json`), JSON.stringify({ schema: "continuity-e2-phase-refusal-v1", code, causeCode: knownRefusalCode(error?.code) ?? proofRefusalCode(error?.code), nativeCause: adapter.failureCause(), progressGap: adapter.report().progressGap }), { flag: "wx", mode: 0o600 }); } catch { /* Stop remains durable even if private diagnostics cannot be written. */ }
    outcome = E2_GUARD_POLICY_REFUSALS.includes(code) || E2_PRE_SEND_REFUSALS.includes(code)
      ? { terminal: "refused_pre_send", score: null, refusalCode: code } : { terminal: "lost", score: null, refusalCode: null };
  } finally { try { restore?.(); } finally { adapter.close(); } }
  await done(a, outcome);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  need(process.send && process.connected);
  process.once("message", a => { void runE2AssignedPhase(a).catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); }); });
  process.send({ type: "loaded" });
}
