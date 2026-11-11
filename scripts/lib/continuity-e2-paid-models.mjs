// One phase actor: real paid requests use the shared guard and its sole send.
// Scripted setup is handled separately by createE2Models and never reaches here.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createPiOAuthApiKeyResolver } from "@mono-agent/turn";
import { guardedModels } from "./continuity-guarded-models.mjs";
import { guardedState } from "./continuity-guarded-state.mjs";
import { guardedAuthorization } from "./continuity-guarded-authorization.mjs";
import { E2_GUARD_CONTRACT, E2_GUARD_STOPS } from "./continuity-e2-policy.mjs";
import { e2RequestPrice } from "./continuity-e2-pricing.mjs";
import { digest } from "./continuity-recorded-schema.mjs";
import { digest as canonicalDigest } from "./continuity-dataset.mjs";
import { e2PhaseWork, e2PhaseBase, validateE2Checkpoint } from "./continuity-e2-lineage.mjs";
import { e2FailureCause, e2ProviderCause, registerE2CauseObserver } from "./continuity-e2-cause.mjs";
const need = (ok, code = "e2_permit_invalid") => { if (!ok) throw Object.assign(Error(code), { code }); };
const core = () => guardedState("e2-validation"), artifacts = () => guardedAuthorization("e2-validation");
export async function createE2PaidModels(a, safety) {
  const { loadE2Estimators, sizeContext, isE2PaidDecorator } = await import("./continuity-e2-models.mjs");
  const estimators = await loadE2Estimators(), credential = await createPiOAuthApiKeyResolver({ path: a.authorization.credentialPath }).readCredential("openai-codex");
  need(credential?.type === "oauth" && typeof credential.access === "string", "e2_account_mismatch");
  const protocolBytes = await artifacts().readArtifact(a.pilot.registration.protocol.path, "e2_registration_invalid");
  need(digest(protocolBytes) === a.pilot.registration.protocol.sha256, "e2_registration_invalid");
  const protocol = JSON.parse(protocolBytes);
  let send, native, config, position, active = false, probeRequests = 0, stopped = null, lifecycle = null, barrier = Promise.resolve();
  let failureCause = null, currentCall = null;
  registerE2CauseObserver(safety, value => { if (currentCall && !currentCall.completed) Object.assign(currentCall, value); });
  async function capture(message, rejected = false, error) {
    if (failureCause || !currentCall || currentCall.completed) return;
    const c = currentCall;
    if (rejected && c.providerClass === "unknown") c.providerClass = e2ProviderCause(error?.code);
    try {
      const state = await core().readPrivate(core().statePath(a.outputRoot)), h = state.slots[a.index].holds.find(h => h.round === c.round);
      if (c.providerClass === "unknown") c.providerClass = e2ProviderCause(state.stop);
      failureCause = e2FailureCause({ round: c.round, role: c.role, checkpoint: c.checkpoint, payloadDigest: h?.payloadDigest ?? null }, c, message, rejected);
    } catch { /* Diagnostics must never replace the original refusal or settlement. */ }
  }
  const counts = { requests: 0, responses: 0, durable: 0 };
  function fail(code) { stopped ??= code; throw Object.assign(Error(stopped), { code: stopped }); }
  async function stop(code) {
    stopped ??= E2_GUARD_STOPS.includes(code) ? code : "e2_phase_failed";
    const permit = native?.permit ?? send?.permit; need(permit, "e2_stop_failed");
    try { await permit.stop(stopped); }
    catch (cause) { throw Object.assign(Error("e2_stop_failed"), { code: "e2_stop_failed", cause }); }
  }
  const checkpoint = pos => {
    if (a.slot.kind === "proof") return Math.min(...a.slot.budgets.map(b => b.checkpoint));
    need([0, 1].includes(pos.branch), "e2_contract_mismatch");
    const branch = protocol.branches[pos.branch], offset = pos.branch ? protocol.branches[0].checkpoints.length : 0;
    let index = branch.checkpoints.findIndex(c => c.turn >= pos.turn); if (index < 0) index = branch.checkpoints.length - 1;
    return offset + index;
  };
  const readonly = target => new Proxy(target, { get(original, key, receiver) {
    // Never invoke the SDK's OAuth refresh/store mutation path or ambient auth.
    if (key === "getAuth") return async model => {
      need((typeof model === "string" ? model : model?.provider) === "openai-codex", "e2_account_mismatch");
      return { auth: { apiKey: credential.access } };
    };
    return Reflect.get(original, key, receiver);
  } });
  async function committed(receipt) {
    const state = await core().readPrivate(core().statePath(a.outputRoot)), slot = state.slots[a.index];
    const branch = a.slot.kind === "replay" ? receipt.position.branch : undefined, work = e2PhaseWork(a.outputRoot, a.slot, branch);
    const names = await readdir(join(work, "sessions", "journals")); need(names.length <= 8192, "e2_summary_receipt_invalid");
    const summaries = slot.holds.filter(h => h.operationDigest === receipt.operationDigest), candidates = [];
    for (const name of names.filter(n => /^[A-Za-z0-9_-]+\.jsonl$/u.test(n))) {
      const bytes = await artifacts().readArtifact(join(work, "sessions", "journals", name), "e2_summary_receipt_invalid", 128 * 1024 * 1024);
      const rows = bytes.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line)), record = rows.filter(r => r.kind === "compaction").at(-1);
      if (!record) continue;
      const reference = { journalId: name.slice(0, -6), checkpointId: record.id, checkpoint: receipt.checkpoint };
      try {
        await validateE2Checkpoint({ root: a.outputRoot, state: { ...state, pilot: a.pilot }, planned: a.slot, slot, summaries, reference,
          readPrivate: core().readPrivate, readArtifact: artifacts().readArtifact }); candidates.push(reference);
      } catch { /* Only the unique fully verified new checkpoint may receive an ACK. */ }
    }
    need(candidates.length === 1, "e2_summary_receipt_invalid");
    await native.permit.compaction({ kind: "durable", operationDigest: receipt.operationDigest, ...candidates[0] }); counts.durable++;
  }
  function enqueue(fn) { barrier = barrier.then(fn); void barrier.catch(() => {}); }
  const actor = {
    attach(value) { need(!send); send = value; },
    assertConfig(value) {
      need(value && value.memory == null && value.subagents?.enabled !== true && value.runtime?.session?.continuity?.upkeep?.enabled !== true
        && value.runtime?.session?.continuity?.ledgerEnabled !== true && value.runtime?.outputSchema == null && value.outputSchema == null,
        "e2_auxiliary_callers_forbidden");
      const workspaces = a.slot.kind === "replay" ? [0, 1].map(branch => e2PhaseWork(a.outputRoot, a.slot, branch)) : [e2PhaseWork(a.outputRoot, a.slot)];
      need(workspaces.includes(value.runtime.workspace) && (value.tools?.allowedTools ?? []).every(name => ["ConversationHistory", "ProofSentinel"].includes(name))
        && !value.tools?.mcpConfigPath, "e2_preparation_invalid");
      need((value.runtime.fallbacks ?? []).length === 0 && (value.runtime.retry?.primaryAttempts ?? 1) === 1
        && value.providers?.piNative?.transport === "sse" && value.providers.piNative.piMaxRetries === 0
        && value.providers.piAuthPath === a.authorization.credentialPath && !Object.keys(value.runtime.context1MModels ?? {}).length
        && !Object.keys(value.providers.local ?? {}).length, "e2_route_mismatch");
      for (const part of [value.runtime, value.runtime.retry ?? {}, value.providers.piNative]) for (const key of ["piRequestRetryBudgetMs", "retryBudgetMs", "retryProfile", "outageRetryProfile"])
        need(!Object.hasOwn(part, key), "e2_retry_profile_forbidden");
      config = value;
    },
    assertCurrentConfig() { if (send) { need(config, "e2_auxiliary_callers_forbidden"); actor.assertConfig(config); } },
    runtime(base, route, value) {
      actor.assertConfig(value);
      return new Proxy(base, { get(target, key) {
        if (key === "run") return async (prompt, options) => {
          actor.assertConfig(value);
          need(options.outputSchema == null && options.memory == null && options.subagents == null
            && !(options.fallbackChain ?? []).length && options.piTransport === "sse" && options.piMaxRetries === 0, "e2_auxiliary_callers_forbidden");
          for (const name of ["piResolvedModel", "piResolvedModels", "prepareRequest", "retry", "retryProfile", "piRequestRetryBudgetMs", "retryBudgetMs"])
            need(!Object.hasOwn(options, name), "e2_option_forbidden");
          const fields = ["sessionId", "providerSessionId", "messages", "nativeSessionAuthority", "nativeSessionProjection", "sessionTurn", "sessionRecovery", "detachedContext", "coldContext"];
          const identities = fields.map(name => options[name]), transcript = digest(JSON.stringify(options.messages ?? null)), change = await route(options);
          need(fields.every((name, i) => Object.is(options[name], identities[i])) && digest(JSON.stringify(options.messages ?? null)) === transcript,
            "e2_native_identity_forbidden");
          need(change && Object.keys(change).every(name => ["piModelsDecorator", "mcpServers", "observers", "allowedTools", "skills"].includes(name))
            && isE2PaidDecorator(change.piModelsDecorator) && change.skills?.length === 0, "e2_unguarded_dispatch");
          return target.run(prompt, { ...options, ...change });
        };
        if (typeof key === "symbol" || ["then", "toJSON"].includes(key)) return undefined;
        need(["sessionTurnReconciliation", "configureTools", "disposeAllSessions", "disposeSession", "invalidateSession", "retireDurableSession", "syncSession", "refreshSession", "recoverSession", "reconcileSessionTurn", "compact"].includes(key), "e2_method_forbidden");
        const method = Reflect.get(target, key, target); return typeof method === "function" ? method.bind(target) : method;
      } });
    },
    bind(_target, bindings) {
      need(!native && bindings.resolvedSafety === safety); native = bindings;
      return Object.freeze({}); // Bootstrap only; no unclassified dispatcher escapes.
    },
    setPosition(value) { if (stopped) fail(stopped); position = { ...value }; probeRequests = 0; },
    observe(event) {
      if (event?.type !== "context_compaction") return;
      if (event.status === "running") {
        need(!lifecycle && typeof event.operationId === "string" && position, "e2_compaction_invalid");
        lifecycle = { position: { ...position }, checkpoint: checkpoint(position), operationDigest: digest(event.operationId), begun: false };
      } else {
        const receipt = lifecycle; need(receipt && receipt.operationDigest === digest(event.operationId), "e2_compaction_invalid"); lifecycle = null;
        if (!receipt.begun && event.status === "skipped") return;
        enqueue(async () => { need(event.status === "succeeded" && receipt.begun, "e2_compaction_invalid"); await committed(receipt); });
      }
    },
    stream(target, model, context, options, role) {
      if (stopped) fail(stopped); need(!active, "e2_concurrent_request"); need(position && ["summary", "probe", "continuation"].includes(role), "e2_method_forbidden");
      currentCall = null; active = true; const pos = { ...position }, probeRequest = a.slot.kind === "replay" && pos.probe ? ++probeRequests : undefined, receipt = role === "summary" ? lifecycle : null;
      const pending = (async () => {
        await barrier; if (stopped) fail(stopped);
        if (probeRequest !== undefined) need(probeRequest <= protocol.probeLookupRounds + 1 && role === (probeRequest === 1 ? "probe" : "continuation"), "e2_request_limit");
        if (!native) { need(send); send.decorator(target); }
        if (role === "summary") {
          need(receipt && receipt === lifecycle, "e2_summary_not_authorized");
          if (!receipt.begun) { await native.permit.compaction({ kind: "begin", checkpoint: receipt.checkpoint, operationDigest: receipt.operationDigest }); receipt.begun = true; }
        } else need(!lifecycle, "e2_compaction_invalid");
        const state = await core().readPrivate(core().statePath(a.outputRoot)), round = state.slots[a.index].holds.length + 1;
        currentCall = { round, role, checkpoint: receipt?.checkpoint ?? checkpoint(pos), sourceStage: "request_setup", providerClass: "unknown" };
        const observed = currentCall;
        const modelName = `${model.provider}:${model.id}`, registered = a.pilot.registration.roles.find(r => r.role === role && r.model === modelName);
        need(registered, "e2_request_limit"); const size = sizeContext(context, estimators), catalog = a.pilot.registration.catalog.find(c => c.model === modelName);
        const reservationUnits = e2RequestPrice(catalog, { inputTokens: size.maximum, maxOutputTokens: registered.maxOutputTokens }).reservationUnits;
        const effort = options.reasoning ?? "off";
        const contract = { ...E2_GUARD_CONTRACT, provider: model.provider, model: model.id, api: model.api, baseUrl: model.baseUrl, effort,
          runId: a.runId, slotId: a.slotId, promptCacheKey: a.cacheKey, e2: { pilot: a.pilot, planned: a.slot, outputRoot: a.outputRoot,
            round, model: modelName, paidRole: role, ...(probeRequest === undefined ? {} : { probeRequest }), checkpoint: receipt?.checkpoint ?? checkpoint(pos), size, reservationUnits,
            ...(receipt ? { operationDigest: receipt.operationDigest } : {}) } };
        // AgentLoop carries host orchestration metadata through streamSimple.
        // Validate and remove it at this SDK boundary; never execute or forward
        // these host callbacks as provider options, and never drop unknown keys.
        const sdkOptions = { ...options };
        for (const name of ["model", "convertToLlm", "toolExecution", "getSteeringMessages", "getFollowUpMessages", "prepareRequest", "beforeToolCall"]) {
          if (!Object.hasOwn(sdkOptions, name)) continue;
          const value = sdkOptions[name];
          if (name === "model") need(value === undefined || ["provider", "id", "api", "baseUrl", "contextWindow", "maxTokens"].every(key => value[key] === model[key]), "e2_model_switch_forbidden");
          else if (name === "toolExecution") need(value === undefined || ["parallel", "sequential"].includes(value), "e2_option_forbidden");
          else need(value === undefined || typeof value === "function", "e2_option_forbidden");
          delete sdkOptions[name];
        }
        const guarded = guardedModels("e2-validation").guardedLookupModels(readonly(target), { ...native, contract, onForwarded(context, round) { observed.sourceStage = "dispatch"; return native.onForwarded?.(context, round); } }); counts.requests++;
        need(options.apiKey === undefined, "e2_option_forbidden");
        // Cache-off summaries omit the body cache key, not their assigned wire identity.
        const nativeModel = { ...model, headers: { ...model.headers, "session-id": a.cacheKey, "x-client-request-id": a.cacheKey } };
        return guarded.streamSimple(nativeModel, context, { ...sdkOptions, reasoning: effort, apiKey: credential.access, sessionId: a.cacheKey,
          onProviderStreamEvent: async (event, selected) => {
            if (["response.completed", "response.incomplete", "response.failed", "error"].includes(event?.type)) {
              observed.sourceStage = "provider_terminal";
              observed.terminalUsageObserved ||= Number.isSafeInteger(event.response?.usage?.input_tokens) && Number.isSafeInteger(event.response?.usage?.output_tokens);
              const classified = e2ProviderCause(event.response?.error?.code ?? event.error?.code ?? event.code);
              if (classified !== "unknown") observed.providerClass = classified;
            }
            await options.onProviderStreamEvent?.(event, selected);
          },
          onResponse: async response => { observed.sourceStage = "response_headers"; observed.responseHeadersObserved = true; observed.httpStatus = response.status;
            const classified = e2ProviderCause(undefined, response.status); if (classified !== "unknown") observed.providerClass = classified; counts.responses++; if (role !== "summary") await pos.onNativeResponse?.(); await options.onResponse?.(response); } });
      })();
      const result = pending.then(stream => stream.result()).then(async message => {
        if (["error", "length"].includes(message?.stopReason) || message?.stopReason === "aborted" && !pos.cancelForwarded
          || message?.stopReason === "stop" && !(message.content ?? []).some(p => p.type === "text" && p.text?.trim())) {
          await capture(message); await stop("e2_phase_failed"); fail("e2_phase_failed");
        }
        currentCall.completed = true; return message;
      }, async error => { await capture(null, true, error); if (!pos.cancelForwarded || !options.signal?.aborted) await stop(error.code); throw error; }).finally(() => { active = false; });
      void result.catch(() => {});
      return { result: () => result, async *[Symbol.asyncIterator]() { const stream = await pending; for await (const event of stream) yield event; await result; } };
    },
    async flush() { await barrier; need(!active && !lifecycle, "e2_compaction_invalid"); if (stopped) fail(stopped); },
    async stop(code) { await stop(code); },
    async assertReplay(values) {
      need(a.slot.kind === "replay" && values.output === e2PhaseBase(a.outputRoot, a.slot), "e2_preparation_invalid");
      for (const [key, binding] of [["source", a.pilot.registration.source], ["protocol", a.pilot.registration.protocol], ["questions", a.pilot.registration.probes], ["evaluator", a.pilot.registration.keys]]) {
        const bytes = await artifacts().readArtifact(binding.path, "e2_registration_invalid", key === "source" ? 128 * 1024 * 1024 : 4 * 1024 * 1024);
        need(digest(bytes) === binding.sha256 && canonicalDigest(JSON.parse(bytes)) === canonicalDigest(values[key]), "e2_registration_invalid");
      }
    },
    assertProof({ base, arm, phase, variant }) {
      need(a.slot.kind === "proof" && base === e2PhaseBase(a.outputRoot, a.slot) && arm === a.slot.arm && phase === a.slot.phase && variant === a.slot.variant, "e2_preparation_invalid");
    },
    failureCause: () => failureCause && structuredClone(failureCause),
    async answerBinding() {
      const state = await core().readPrivate(core().statePath(a.outputRoot)), h = state.slots[a.index].holds.at(-1);
      need(h?.consumed && h.settlement?.kind === "settled" && ["probe", "continuation"].includes(h.paidRole));
      return { registrationSha256: canonicalDigest(a.pilot), slotId: a.slotId, checkpoint: h.checkpoint, round: h.round, payloadDigest: h.payloadDigest };
    },
    credentialPath: () => a.authorization.credentialPath,
    report: () => ({ ...counts }),
    close() { (native?.permit ?? send?.permit)?.close(); },
  };
  return Object.freeze(actor);
}
