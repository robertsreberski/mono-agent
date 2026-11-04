// Internal faux probe only: no real Models, credentials, network transport or capability factory.
import { armById } from "./continuity-arms.mjs";
import { assertResolvedLookupSafety, fauxLookupSafety } from "./continuity-lookup-pilot-runtime.mjs";
import { fileURLToPath } from "node:url";
import { guardedLookupModels, LOOKUP_GUARD_CONTRACT, assertLookupChildSafety } from "./continuity-lookup-guard.mjs";
import { validateLookupPilotRegistration } from "./continuity-lookup-pilot.mjs";
import { ROOT, verifyRoleRequest } from "./continuity-lookup-roles.mjs";
import { createLookupPilotIPC, verifyLookupPilotParent } from "./continuity-lookup-ipc.mjs";
import { readPilotPrivate, pilotStatePath } from "./continuity-lookup-pilot-state.mjs";
import { pilotNeed } from "./continuity-lookup-pilot-accounting.mjs";

async function main(a) {
  pilotNeed(!Object.hasOwn(process.env, "CONTINUITY_DEBUG"), "lookup_debug_forbidden");
  await verifyLookupPilotParent(a);
  await validateLookupPilotRegistration(a.pilot);
  await verifyRoleRequest(ROOT, a.roleRequest, a.plan);
  assertLookupChildSafety({ plan: a.plan, memory: false, subagents: false, upkeep: false, compaction: false, outputSchema: null });
  const resolvedSafety = fauxLookupSafety(a.plan, armById(a.roleRequest.binding.arm)); assertResolvedLookupSafety(resolvedSafety);
  const go = new Promise(resolve => process.once("message", resolve));
  process.send({ type: "ready", epoch: a.epoch, slotId: a.slotId });
  const start = await go;
  pilotNeed(start?.type === "go" && start.epoch === a.epoch && start.slotId === a.slotId, "lookup_ipc_invalid");
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
  await new Promise((resolve, reject) => {
    const cleanup = () => { process.off("message", ack); process.off("disconnect", disconnected); };
    const disconnected = () => { cleanup(); reject(Object.assign(new Error("lookup_ipc_disconnected"), { code: "lookup_ipc_disconnected" })); };
    const ack = message => {
      cleanup();
      try { pilotNeed(message?.type === "done-ack" && message.epoch === a.epoch && message.slotId === a.slotId, "lookup_ipc_invalid"); resolve(); }
      catch (error) { reject(error); }
    };
    process.once("message", ack); process.once("disconnect", disconnected);
    process.send({ type: "done", epoch: a.epoch, slotId: a.slotId, terminal, score, refusalCode }, error => { if (error) { cleanup(); reject(error); } });
  });
  process.disconnect();
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.send || !process.connected) throw new Error("lookup_ipc_invalid");
  process.once("message", a => { void main(a).catch(() => { process.exitCode = 1; process.disconnect?.(); }); });
  process.send({ type: "loaded" });
}
