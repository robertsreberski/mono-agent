// One phase actor: real paid requests use the shared guard and its sole send.
// Scripted setup is handled separately by createE2Models and never reaches here.
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPiOAuthApiKeyResolver } from "@mono-agent/turn";
import { guardedModels } from "./continuity-guarded-models.mjs";
import { guardedState } from "./continuity-guarded-state.mjs";
import { guardedAuthorization } from "./continuity-guarded-authorization.mjs";
import { E2_GUARD_CONTRACT, E2_GUARD_STOPS, E2GuardError, E2_GUARD_POLICY_REFUSALS, E2_PRE_SEND_REFUSALS } from "./continuity-e2-policy.mjs";
import { e2RequestPrice } from "./continuity-e2-pricing.mjs";
import { digest } from "./continuity-recorded-schema.mjs";
import { digest as canonicalDigest } from "./continuity-dataset.mjs";
import { e2PhaseWork, e2PhaseBase, validateE2Checkpoint } from "./continuity-e2-lineage.mjs";
import { e2FailureCause, e2ProviderCause, e2CandidateCause, E2_NONRETRY_PROVIDER_CLASSES, registerE2CauseObserver } from "./continuity-e2-cause.mjs";
import { effectiveE2Summaries, E2_RETRY_POLICY } from "./continuity-e2-retry.mjs";
import { e2ReplayArm, e2ProbeRequestCount, assertE2ReplayBinding } from "./continuity-e2-protocol.mjs";
import { isE2ProtectionRefusal } from "./continuity-e2-compaction.mjs";
const need = (ok, code = "e2_permit_invalid") => { if (!ok) throw Object.assign(Error(code), { code }); };
const core = () => guardedState("e2-validation"), artifacts = () => guardedAuthorization("e2-validation");
export async function createE2PaidModels(a, safety) {
  const { loadE2Estimators, sizeContext, isE2PaidDecorator } = await import("./continuity-e2-models.mjs");
  const estimators = await loadE2Estimators(), credential = await createPiOAuthApiKeyResolver({ path: a.authorization.credentialPath }).readCredential("openai-codex");
  need(credential?.type === "oauth" && typeof credential.access === "string", "e2_account_mismatch");
  const protocolBytes = await artifacts().readArtifact(a.pilot.registration.protocol.path, "e2_registration_invalid");
  need(digest(protocolBytes) === a.pilot.registration.protocol.sha256, "e2_registration_invalid");
  const protocol = JSON.parse(protocolBytes), baseline = e2ReplayArm(a.pilot.registration.replayArm) === "baseline";
  let send, native, config, position, active = false, probeRequests = 0, stopped = null, lifecycle = null, barrier = Promise.resolve();
  let failureCause = null, currentCall = null;
  registerE2CauseObserver(safety, value => {
    if (!currentCall || currentCall.completed) return;
    const { binding, ...observed } = value;
    if (binding) {
      if (binding.round !== currentCall.round || binding.role !== currentCall.role || binding.checkpoint !== currentCall.checkpoint) return;
      currentCall.payloadDigest = binding.payloadDigest;
    }
    const { providerClass, ...rest } = observed; Object.assign(currentCall, rest);
    if (providerClass && !E2_NONRETRY_PROVIDER_CLASSES.includes(currentCall.providerClass)) currentCall.providerClass = providerClass;
  }, capture);
  function capture(message, rejected = false, error) {
    if (!currentCall || currentCall.completed) return null;
    if (!rejected && !["error", "length", "aborted"].includes(message?.stopReason)
      && !(message?.stopReason === "stop" && !(message.content ?? []).some(p => p.type === "text" && p.text?.trim()))) return null;
    const c = currentCall;
    if (c.cancelForwarded && c.ownerSignal?.aborted) { failureCause = null; return null; }
    c.ownerCanceled = c.ownerSignal?.aborted === true || c.cancelForwarded === true;
    if (rejected && (error instanceof E2GuardError && error.outcome === "refused_pre_send" || [...E2_GUARD_POLICY_REFUSALS, ...E2_PRE_SEND_REFUSALS].includes(error?.code)) && !c.responseHeadersObserved) c.sourceStage = "guard_refused";
    if (rejected && c.providerClass === "unknown") c.providerClass = e2ProviderCause(error?.code);
    // The native boundary already verified the consumed hold and exact bytes.
    // Re-reading the atomically replaced controller journal here can refuse a
    // legitimate concurrent save and silently discard the original SDK cause.
    return failureCause = e2FailureCause({ round: c.round, role: c.role, checkpoint: c.checkpoint, payloadDigest: c.payloadDigest ?? null }, c, message, rejected);
  }
  const counts = { requests: 0, responses: 0, durable: 0, progressGap: 0 };
  function fail(code) { stopped ??= code; throw Object.assign(Error(stopped), { code: stopped }); }
  async function stop(code) {
    stopped ??= E2_GUARD_STOPS.includes(code) ? code : "e2_phase_failed";
    const permit = native?.permit ?? send?.permit; need(permit, "e2_stop_failed");
    // Persist before stop starts the controller's bounded settle/contain window.
    // Failure unwinding and its later refusal file may exceed that window under load.
    if (failureCause) try { await writeFile(join(e2PhaseBase(a.outputRoot, a.slot), "native-cause.json"), JSON.stringify(failureCause), { flag: "wx", mode: 0o600 }); } catch { /* Diagnostic I/O never replaces the stop. */ }
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
    const summaries = effectiveE2Summaries(slot.holds).filter(h => h.operationDigest === receipt.operationDigest), candidates = [];
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
      if (baseline) need(a.slot.kind === "replay" && a.slot.arm === "baseline" && value.runtime.session.continuity.enabled === false
        && value.runtime.compaction?.enabled === true && (value.tools?.allowedTools ?? []).length === 0, "e2_preparation_invalid");
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
          if (baseline) need(change.allowedTools?.length === 0 && !Object.hasOwn(change.mcpServers ?? {}, "mono-agent-conversation-history"), "e2_preparation_invalid");
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
      // Runtime observer fan-out swallows exceptions. Persist failure before
      // throwing so neither a corrected event nor flush can erase it.
      try {
        if (stopped) fail(stopped);
        if (event.status === "running") {
          need(!lifecycle && typeof event.operationId === "string" && position, "e2_compaction_invalid");
          lifecycle = { position: { ...position }, checkpoint: checkpoint(position), operationDigest: digest(event.operationId), begun: false };
        } else {
          const receipt = lifecycle; need(receipt && receipt.operationDigest === digest(event.operationId) && !active, "e2_compaction_invalid"); lifecycle = null;
          if (!receipt.begun && event.status === "skipped") return;
          enqueue(async () => {
            need(receipt.begun, "e2_compaction_invalid");
            if (isE2ProtectionRefusal(event)) {
              await native.permit.compaction({ kind: "rejected", operationDigest: receipt.operationDigest, checkpoint: receipt.checkpoint, reason: event.reason });
            } else { need(event.status === "succeeded", "e2_compaction_invalid"); await committed(receipt); }
          });
        }
      } catch { fail("e2_compaction_invalid"); }
    },
    stream(target, model, context, options, role) {
      if (stopped) fail(stopped); need(!active, "e2_concurrent_request"); need(position && ["summary", "probe", "continuation"].includes(role), "e2_method_forbidden");
      currentCall = null; active = true; const pos = { ...position }, probeRequest = a.slot.kind === "replay" && pos.probe ? ++probeRequests : undefined, receipt = role === "summary" ? lifecycle : null;
      let frozenPayload, measuredSize; const buffered = [];
      const attempt = async retrying => {
        await barrier; if (stopped) fail(stopped);
        if (probeRequest !== undefined) need(probeRequest <= e2ProbeRequestCount(protocol, a.pilot.registration.replayArm) && role === (probeRequest === 1 ? "probe" : "continuation"), "e2_request_limit");
        if (!native) { need(send); send.decorator(target); }
        if (role === "summary") {
          need(receipt && receipt === lifecycle, "e2_summary_not_authorized");
          if (!receipt.begun) { await native.permit.compaction({ kind: "begin", checkpoint: receipt.checkpoint, operationDigest: receipt.operationDigest }); receipt.begun = true; }
        } else need(!lifecycle, "e2_compaction_invalid");
        const state = await core().readPrivate(core().statePath(a.outputRoot)), round = state.slots[a.index].holds.length + 1;
        currentCall = { round, role, checkpoint: receipt?.checkpoint ?? checkpoint(pos), sourceStage: "request_setup", providerClass: "unknown", ownerSignal: options.signal, cancelForwarded: pos.cancelForwarded };
        const observed = currentCall;
        const modelName = `${model.provider}:${model.id}`, registered = a.pilot.registration.roles.find(r => r.role === role && r.model === modelName);
        need(registered, "e2_request_limit"); const size = measuredSize ??= sizeContext(context, estimators), catalog = a.pilot.registration.catalog.find(c => c.model === modelName);
        const reservationUnits = e2RequestPrice(catalog, { inputTokens: size.maximum, maxOutputTokens: registered.maxOutputTokens }).reservationUnits;
        const effort = options.reasoning ?? "off";
        const contract = { ...E2_GUARD_CONTRACT, provider: model.provider, model: model.id, api: model.api, baseUrl: model.baseUrl, effort,
          runId: a.runId, slotId: a.slotId, promptCacheKey: a.cacheKey, e2: { safety, pilot: a.pilot, planned: a.slot, outputRoot: a.outputRoot,
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
        const guarded = guardedModels("e2-validation").guardedLookupModels(readonly(target), { ...native, contract, onForwarded(context, round) { observed.sourceStage = "dispatch"; if (!retrying) return native.onForwarded?.(context, round); } }); counts.requests++;
        need(options.apiKey === undefined, "e2_option_forbidden");
        // Cache-off summaries omit the body cache key, not their assigned wire identity.
        const nativeModel = { ...model, headers: { ...model.headers, "session-id": a.cacheKey, "x-client-request-id": a.cacheKey } };
        return guarded.streamSimple(nativeModel, context, { ...sdkOptions, reasoning: effort, apiKey: credential.access, sessionId: a.cacheKey,
          onPayload: async (payload, selected) => {
            if (retrying) { need(frozenPayload, "e2_body_mismatch"); return JSON.parse(frozenPayload); }
            const projected = options.onPayload ? await options.onPayload(payload, selected) ?? payload : payload;
            frozenPayload = JSON.stringify(projected); return JSON.parse(frozenPayload);
          },
          onProviderStreamEvent: async (event, selected) => {
            if (["response.completed", "response.incomplete", "response.failed", "error"].includes(event?.type)) {
              observed.sourceStage = "provider_terminal";
              observed.terminalUsageObserved ||= Number.isSafeInteger(event.response?.usage?.input_tokens) && Number.isSafeInteger(event.response?.usage?.output_tokens);
              const classified = e2CandidateCause([event.error?.code, event.error?.type, event.response?.error?.code, event.response?.error?.type, event.code, event.type, event.response?.incomplete_details?.reason], true);
              if (classified !== "unknown" && !E2_NONRETRY_PROVIDER_CLASSES.includes(observed.providerClass)) observed.providerClass = classified;
            }
            await options.onProviderStreamEvent?.(event, selected);
          },
          onResponse: async response => { observed.sourceStage = "response_headers"; observed.responseHeadersObserved = true; observed.httpStatus = response.status;
            const classified = e2ProviderCause(undefined, response.status); if (classified !== "unknown" && !E2_NONRETRY_PROVIDER_CLASSES.includes(observed.providerClass)) observed.providerClass = classified; counts.responses++; if (role !== "summary") await pos.onNativeResponse?.(); await options.onResponse?.(response); } });
      };
      const result = (async () => {
        for (let number = 0; number <= E2_RETRY_POLICY.maxPerRequest; number++) {
          let physical, message, error; const events = [];
          try {
            physical = await attempt(number > 0);
            for await (const event of physical) events.push(event);
            message = await physical.result();
          } catch (caught) {
            error = caught;
            if (physical) try { message = await physical.result(); } catch (caughtResult) { error = caughtResult; }
          }
          const failed = error || ["error", "length"].includes(message?.stopReason) || message?.stopReason === "aborted" && !pos.cancelForwarded
            || message?.stopReason === "stop" && !(message.content ?? []).some(p => p.type === "text" && p.text?.trim());
          if (!failed) { currentCall.completed = true; failureCause = null; buffered.push(...events); return message; }
          capture(message, !!error, error);
          if (number < E2_RETRY_POLICY.maxPerRequest && currentCall && !options.signal?.aborted && !pos.cancelForwarded) {
            const decision = await native.permit.retry(currentCall.round, false);
            if (options.signal?.aborted || pos.cancelForwarded) {
              if (decision.allowed) await native.permit.retry(currentCall.round, true);
              capture(message, !!error, error);
            } else if (decision.allowed) continue;
          }
          const code = ["rate", "quota"].includes(currentCall?.providerClass) ? "e2_quota_exhausted" : error?.code ?? "e2_phase_failed";
          if (!pos.cancelForwarded || !options.signal?.aborted) await stop(code);
          if (error) throw error; fail(code);
        }
      })().finally(() => { active = false; });
      void result.catch(() => {});
      // Failed attempts cannot leak a terminal error or partial tool call into
      // the logical turn before the controller makes its single retry decision.
      return { result: () => result, async *[Symbol.asyncIterator]() { await result; for (const event of buffered) yield event; } };
    },
    async flush() { await barrier; need(!active && !lifecycle, "e2_compaction_invalid"); if (stopped) fail(stopped); },
    async stop(code) { await stop(code); },
    async assertReplay(values) {
      assertE2ReplayBinding(a.pilot.registration, { replayArm: values.replayArm, qualification: baseline ? false : undefined });
      if (values.report) assertE2ReplayBinding(a.pilot.registration, values.report);
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
    noteProgressGap() { return counts.progressGap = Math.min(4096, counts.progressGap + 1); },
    probeReceiptBinding: () => ({ registrationSha256: canonicalDigest(a.pilot), slotId: a.slotId }),
    async answerBinding() {
      const state = await core().readPrivate(core().statePath(a.outputRoot)), h = state.slots[a.index].holds.at(-1);
      need(h?.consumed && h.settlement?.kind === "settled" && ["probe", "continuation"].includes(h.paidRole), "e2_progress_binding_invalid");
      return { registrationSha256: canonicalDigest(a.pilot), slotId: a.slotId, checkpoint: h.checkpoint, round: h.round, payloadDigest: h.payloadDigest };
    },
    credentialPath: () => a.authorization.credentialPath,
    report: () => ({ ...counts }),
    close() { (native?.permit ?? send?.permit)?.close(); },
  };
  return Object.freeze(actor);
}
