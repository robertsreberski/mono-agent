// Mechanics-only serializer; not configured-runtime or SDK proof.
// Internal assigned probe; real construction remains behind the shared entry gate.
import { assertLookupPilotEntry } from "../../lib/continuity-lookup-pilot-entry.mjs";
import { armById } from "../../lib/continuity-arms.mjs";
import { assertResolvedLookupSafety, fauxLookupSafety } from "../../lib/continuity-lookup-pilot-runtime.mjs";
import { fileURLToPath } from "node:url";
import { LOOKUP_GUARD_POLICY_REFUSALS, guardedLookupModels, LOOKUP_GUARD_CONTRACT, assertLookupChildSafety } from "../../lib/continuity-lookup-guard.mjs";
import { validateLookupPilotRegistration } from "../../lib/continuity-lookup-pilot.mjs";
import { ROOT, verifyRoleRequest } from "../../lib/continuity-lookup-roles.mjs";
import { createLookupPilotIPC, verifyLookupPilotParent } from "../../lib/continuity-lookup-ipc.mjs";
import { readPilotPrivate, pilotStatePath } from "../../lib/continuity-lookup-pilot-state.mjs";
import { pilotNeed } from "../../lib/continuity-lookup-pilot-accounting.mjs";

export async function runLookupConfiguredProbe(a) {
 const resolvedSafety = fauxLookupSafety(a.plan, armById(a.roleRequest.binding.arm));
  const permit = await createLookupPilotIPC(a), abort = new AbortController();
  let terminal = "completed", score = 1, refusalCode = null;
  try {
    const contract = { ...LOOKUP_GUARD_CONTRACT, slotId: a.slotId, runId: a.runId, promptCacheKey: a.cacheKey };
    // A minimal local serializer drives the *actual guard*. It is not a provider substitute on a paid route.
    const models = { streamSimple(model, context, options) {
      const result = (async () => {
        const payload = await options.onPayload({ model: contract.model, store: false, stream: true,
          reasoning: { effort: "high" }, prompt_cache_key: options.sessionId, input: [{ role: "user", content: a.scenario === "input_refusal" ? "x".repeat(272000) : "Fictional mechanics only." }] });
        await options.fetch(`${contract.baseUrl}/codex/responses`, { method: "POST", body: JSON.stringify(payload), headers: { "session-id": options.sessionId, "x-client-request-id": options.sessionId } });
        const usage = { input_tokens: 100, output_tokens: a.scenario === "integrity_stop" ? 1000000 : 10 };
        await options.onProviderStreamEvent({ type: "response.completed", response: { usage, service_tier: "default" } });
        return { stopReason: "stop", content: ["empty", "empty_two_rounds"].includes(a.scenario) ? [] : [{ type: "text", text: "Fictional result." }] };
      })();
      return { result: () => result, async *[Symbol.asyncIterator]() { await result; } };
    } };
    const guarded = guardedLookupModels(models, { contract, permit, resolvedSafety, send: async () => {
      // Independent disk witness at the faux arrival boundary, after consume ACK.
      const state = await readPilotPrivate(pilotStatePath(a.outputRoot)).catch(error => { pilotNeed(false, error.code === "lookup_receipt_invalid" ? "lookup_arrival_receipt_invalid" : "lookup_arrival_persist_failed"); }), hold = state.slots[a.index].holds.at(-1);
      pilotNeed(hold?.consumed && !hold.revoked && state.epoch === a.epoch, "lookup_arrival_persist_failed");
      if (["auth", "quota"].includes(a.scenario)) { await permit.stop(a.scenario === "auth" ? "lookup_auth_failure" : "lookup_quota_exhausted"); throw new Error("fictional_send_failure"); }
      if (a.scenario === "own_abort_after_send") abort.abort();
      if (["lost", "own_abort_after_send"].includes(a.scenario)) throw new Error("fictional_send_failure");
      return new Response("");
    } });
    for (let round = 0; round < (a.scenario === "request_limit" ? 11 : ["two_rounds", "empty_two_rounds"].includes(a.scenario) ? 2 : 1); round++) {
      const result = await guarded.streamSimple({ provider: contract.provider, id: contract.model, api: contract.api, baseUrl: contract.baseUrl }, {},
        { reasoning: "high", transport: "sse", maxRetries: 0, signal: abort.signal }).result();
      if (!result.content.length) terminal = "pilot_empty_final_output";
    }
    if (a.scenario === "wrong") { terminal = "wrong"; score = 0; }
  } catch (error) {
    if (["lookup_arrival_persist_failed", "lookup_arrival_receipt_invalid"].includes(error.code)) { await permit.stop(error.code); terminal = "integrity_stop"; score = null; }
    else terminal = error.code === "pilot_empty_final_output" ? "pilot_empty_final_output" : error.outcome === "refused_pre_send" ? "refused_pre_send" : a.scenario === "own_abort_after_send" ? "own_abort_after_send" : a.scenario === "integrity_stop" ? "integrity_stop" : "lost"; score = null;
    if (terminal === "refused_pre_send") refusalCode = error.code;
  } finally { permit.close(); }
  return { terminal, score, refusalCode };
}
