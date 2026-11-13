// Closed E2 accounting policy. Durable admission/consume/settle remain in the shared core.
import { join } from "node:path";
import { digest } from "./continuity-dataset.mjs";
import { digest as rawDigest } from "./continuity-recorded-schema.mjs";
import { e2RequestPrice, e2UsageUnits } from "./continuity-e2-pricing.mjs";
import { E2_PERMIT_CONTRACT, E2_GUARD_CONTRACT, E2_REAL_CONTROLLER } from "./continuity-e2-policy.mjs";
import { validateE2Sizing } from "./continuity-e2-estimate.mjs";
import { E2_PAID_ROLES } from "./continuity-e2-roles.mjs";
import { writeE2SummaryResult, verifyE2SummaryResult } from "./continuity-e2-summary-receipts.mjs";
import { assertE2BaselineRequest, bindE2Checkpoint, verifyE2NativeLineage, e2LineageScope, e2PhaseBase } from "./continuity-e2-lineage.mjs";
import { validE2FailureCause, observeE2NativeCause, captureE2NativeCause, e2ProviderCause, e2CandidateCause } from "./continuity-e2-cause.mjs";
import { readE2Progress, writeE2PartialScore } from "./continuity-e2-progress.mjs";
import { E2_RETRY_POLICY, authorizeE2Retry, effectiveE2Summaries, supersedingE2Summary, e2RetryCounts } from "./continuity-e2-retry.mjs";
import { e2ReplayArm } from "./continuity-e2-protocol.mjs";
import { E2_PROTECTION_REFUSALS, e2NativeCompactionSnapshot, e2RefusalCounts } from "./continuity-e2-compaction.mjs";
const fail = (code = "e2_permit_invalid") => { throw Object.assign(Error(code), { code }); };
const need = (ok, code) => { if (!ok) fail(code); };
const count = n => Number.isSafeInteger(n) && n >= 0;
const fieldsOnly = (v, names) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every(k => names.includes(k));
function textParts(parts, reasoning = false) {
  need(Array.isArray(parts), "e2_payload_forbidden");
  for (const p of parts) need(fieldsOnly(p, reasoning ? ["type", "text"] : ["type", "text", "annotations"])
    && (reasoning ? ["summary_text"] : ["input_text", "output_text"]).includes(p.type) && typeof p.text === "string"
    && (p.annotations === undefined || Array.isArray(p.annotations) && !p.annotations.length), "e2_payload_forbidden");
}
function validateBody(body) {
  need(fieldsOnly(body, ["model", "store", "stream", "instructions", "input", "text", "include", "prompt_cache_key", "tool_choice", "parallel_tool_calls", "temperature", "tools", "reasoning"])
    && Array.isArray(body.input) && (body.instructions === undefined || typeof body.instructions === "string")
    && (body.reasoning === undefined || fieldsOnly(body.reasoning, ["effort", "summary"])) && (body.text === undefined || fieldsOnly(body.text, ["verbosity"]))
    && (body.include === undefined || Array.isArray(body.include) && body.include.every(v => v === "reasoning.encrypted_content")), "e2_payload_forbidden");
  for (const t of body.tools ?? []) need(fieldsOnly(t, ["type", "name", "description", "parameters", "strict"]), "e2_payload_forbidden");
  for (const item of body.input) {
    if (item?.type === "reasoning") {
      need(fieldsOnly(item, ["type", "id", "summary", "encrypted_content", "status", "content"]), "e2_payload_forbidden");
      if (item.summary !== undefined) textParts(item.summary, true);
      if (item.content != null) {
        need(Array.isArray(item.content) && item.content.length <= 1, "e2_payload_forbidden");
        for (const p of item.content) need(fieldsOnly(p, ["type", "text"]) && p.type === "reasoning_text" && typeof p.text === "string", "e2_payload_forbidden");
      }
    } else if (item?.type === "function_call") need(fieldsOnly(item, ["type", "id", "call_id", "name", "arguments", "namespace", "status"]) && typeof item.arguments === "string", "e2_payload_forbidden");
    else if (item?.type === "function_call_output") need(fieldsOnly(item, ["type", "call_id", "output", "id", "status"]) && typeof item.output === "string", "e2_payload_forbidden");
    else {
      need(fieldsOnly(item, ["type", "role", "content", "id", "status", "phase"]) && [undefined, "message"].includes(item.type) && ["system", "developer", "user", "assistant"].includes(item.role), "e2_payload_forbidden");
      if (typeof item.content !== "string") textParts(item.content);
    }
  }
}
const sameFields = (p, names) => p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).sort().join() === [...names].sort().join();
// The validated registration mirrors protocol-owned R per checkpoint. Admission
// derives the ordinal independently from durable holds; the actor supplies its
// own ordinal to the pre-payload guard. Neither changes the IPC request shape.
function requestTools(pilot, planned, p, probeRequest) {
  const tools = pilot.registration.toolPolicies;
  if (p.paidRole === "summary") return tools.summary;
  if (planned.kind !== "replay") return planned.arm === "cancel" && p.paidRole === "continuation" ? tools.cancelContinuation : tools.proof;
  if (e2ReplayArm(pilot.registration.replayArm) === "baseline") {
    need(planned.arm === "baseline" && probeRequest === 1 && p.paidRole === "probe", "e2_request_limit");
    return tools.replayFinal;
  }
  const rounds = pilot.registration.probeCounts.find(c => c.checkpoint === p.checkpoint)?.lookupRounds;
  need(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 4, "e2_registration_invalid");
  need(Number.isSafeInteger(probeRequest) && probeRequest >= 1 && probeRequest <= rounds + 1
    && p.paidRole === (probeRequest === 1 ? "probe" : "continuation"), "e2_request_limit");
  return probeRequest === rounds + 1 ? tools.replayFinal : tools.replay;
}
// Funding is shared; only the controller owns live hold counts and lifecycle admission.
function requestFunding(pilot, planned, p, operationDigest, probeRequest) {
  need(sameFields(p, E2_PERMIT_CONTRACT.admissionFields) && E2_PAID_ROLES.includes(p.paidRole) && count(p.checkpoint) && count(p.inputTokens));
  const role = pilot.registration.roles.find(r => r.role === p.paidRole && r.model === p.model), catalog = pilot.registration.catalog.find(c => c.model === p.model);
  need(role && catalog && p.inputTokens <= role.maxInputTokens && p.inputTokens <= catalog.contextWindow, "not_admitted_input_envelope");
  const budget = planned.budgets.find(b => b.paidRole === p.paidRole && b.model === p.model && b.checkpoint === p.checkpoint);
  need(budget, "e2_request_limit");
  const reserve = e2RequestPrice(catalog, { inputTokens: p.inputTokens, maxOutputTokens: role.maxOutputTokens }).reservationUnits;
  need(p.reservationUnits === reserve);
  return { reserve: BigInt(reserve), metadata: { ...(pilot.registration.replayArm === "baseline" ? { replayArm: "baseline" } : {}), model: p.model, paidRole: p.paidRole, checkpoint: p.checkpoint, measuredInputTokens: p.inputTokens,
    ...(p.paidRole === "summary" ? { operationDigest } : {}), inputMax: catalog.contextWindow, outputMax: role.maxOutputTokens, catalog: structuredClone(catalog),
    ...(probeRequest === undefined ? {} : { probeRequest }),
    tools: [...requestTools(pilot, planned, p, probeRequest)] } };
}
export const e2ExecutionPolicy = Object.freeze({
  // E2-owned clocks; protocols without this seam retain their historical slot clock.
  deadlines: Object.freeze({
    phaseAt(deadlines, slot) { return slot.startedAt + deadlines.phaseDeadlineMs; },
    requestAt(deadlines, hold) {
      need(Number.isSafeInteger(hold?.admittedAt), "e2_permit_invalid");
      return hold.admittedAt + deadlines.requestDeadlineMs;
    },
  }),
  cap(pilot) {
    const value = pilot?.descriptor?.capUnits;
    need(typeof value === "string" && /^(0|[1-9][0-9]{0,29})$/u.test(value), "e2_registration_invalid"); return BigInt(value);
  },
  admission(pilot, planned, slot, p) {
    need(sameFields(p, E2_PERMIT_CONTRACT.admissionFields) && E2_PAID_ROLES.includes(p.paidRole) && count(p.checkpoint) && count(p.inputTokens));
    need(p.checkpoint >= (slot.holds.at(-1)?.checkpoint ?? 0));
    if (p.paidRole === "summary") need(slot.compaction && slot.compaction.checkpoint === p.checkpoint, "e2_summary_not_authorized");
    const pending = slot.retryPending && slot.holds.find(h => h.round === slot.retryPending);
    if (pending) {
      need(pending === slot.holds.at(-1) && pending.retryAuthorized
        && p.payloadDigest === pending.payloadDigest && p.model === pending.model && p.paidRole === pending.paidRole
        && p.checkpoint === pending.checkpoint && p.inputTokens === pending.measuredInputTokens && p.reservationUnits === pending.reservedUnits, "e2_request_limit");
      const funded = requestFunding(pilot, planned, p, pending.operationDigest, pending.probeRequest);
      funded.metadata.retryOf = pending.retryOf ?? pending.round; return funded;
    }
    const budget = planned.budgets.find(b => b.paidRole === p.paidRole && b.model === p.model && b.checkpoint === p.checkpoint);
    need(budget && slot.holds.filter(h => !h.retryOf && h.paidRole === p.paidRole && h.model === p.model && h.checkpoint === p.checkpoint).length < budget.maxRequests, "e2_request_limit");
    const previous = slot.holds.at(-1);
    const probeRequest = planned.kind === "replay" && p.paidRole !== "summary" ? p.paidRole === "probe" ? 1
      : previous?.checkpoint === p.checkpoint && Number.isSafeInteger(previous.probeRequest) ? previous.probeRequest + 1 : 0 : undefined;
    return requestFunding(pilot, planned, p, slot.compaction?.operationDigest, probeRequest);
  },
  retry(pilot, state, index, p) {
    need(pilot.descriptor.retryPolicy && digest(pilot.descriptor.retryPolicy) === digest(E2_RETRY_POLICY), "e2_registration_invalid");
    // The control admits exactly one physical model request per probe.
    // Shipping summary retries remain governed by the existing policy.
    if (pilot.registration?.replayArm === "baseline" && state.slots[index].holds.at(-1)?.paidRole !== "summary") return { allowed: false };
    return authorizeE2Retry(state, index, p);
  },
  failureEvidence(contract, message, error) { return captureE2NativeCause(contract.e2.safety, message, error); },
  deferNativeFailure(pilot, status, code) {
    const classified = Array.isArray(code) ? e2CandidateCause(code) : e2ProviderCause(code, status);
    const providerClass = classified === "unknown" ? e2ProviderCause(undefined, status) : classified;
    return pilot.descriptor.retryPolicy && digest(pilot.descriptor.retryPolicy) === digest(E2_RETRY_POLICY)
      && ["rate", "server", "stream"].includes(providerClass);
  },

  contract(contract) {
    need(["provider", "api", "baseUrl", "version"].every(k => contract?.[k] === E2_GUARD_CONTRACT[k]), "e2_contract_mismatch");
    const e2 = contract.e2;
    need(e2 && `${contract.provider}:${contract.model}` === e2.model && ["off", "low", "medium", "high", "xhigh"].includes(contract.effort)
      && count(e2.round) && e2.round > 0, "e2_contract_mismatch");
  },
  guardRequest(contract, context) {
    const e2 = contract.e2; this.contract(contract); validateE2Sizing(e2.size);
    need(e2.size.serializedBytes === Buffer.byteLength(JSON.stringify(context)), "e2_contract_mismatch");
    const p = { requestId: `${contract.runId}:${e2.round}`, slotId: contract.slotId, round: e2.round, payloadDigest: "0".repeat(64),
      reservationUnits: e2.reservationUnits, inputTokens: e2.size.maximum, model: e2.model, paidRole: e2.paidRole, checkpoint: e2.checkpoint };
    if (p.paidRole === "summary") need(/^[a-f0-9]{64}$/u.test(e2.operationDigest ?? ""), "e2_summary_not_authorized");
    const derived = requestFunding(e2.pilot, e2.planned, p, e2.operationDigest, e2.probeRequest);
    return { ...derived.metadata, reservationUnits: derived.reserve.toString(), request: p };
  },
  assertRoute(model, options, contract) {
    this.contract(contract);
    need(!Object.hasOwn(options, "fetch"), "e2_external_fetch_forbidden");
    need(model?.provider === contract.provider && model.id === contract.model && model.api === contract.api && model.baseUrl === contract.baseUrl
      && options.transport === "sse" && options.maxRetries === 0 && (options.piMaxRetries === undefined || options.piMaxRetries === 0)
      && options.reasoning === contract.effort, "e2_route_mismatch");
    need(Object.keys(options).every(k => ["maxTokens", "reasoning", "transport", "maxRetries", "piMaxRetries", "maxRetryDelayMs", "signal", "telemetryContext", "sessionId", "apiKey", "onPayload", "onProviderStreamEvent", "onResponse", "cacheRetention", "thinkingBudgets"].includes(k)), "e2_option_forbidden");
    need(options.maxRetryDelayMs === undefined || Number.isSafeInteger(options.maxRetryDelayMs) && options.maxRetryDelayMs >= 0, "e2_option_forbidden");
    need(options.thinkingBudgets === undefined && [undefined, "none"].includes(options.cacheRetention), "e2_option_forbidden");
  },
  assertPayload(body, _round, contract) {
    const role = contract.e2.pilot.registration.roles.find(r => r.role === contract.e2.paidRole && r.model === contract.e2.model);
    const allowed = requestTools(contract.e2.pilot, contract.e2.planned, contract.e2, contract.e2.probeRequest);
    this.assertBody(Buffer.from(JSON.stringify(body)), { model: contract.e2.model, tools: allowed, ...(contract.e2.probeRequest === undefined ? {} : { probeRequest: contract.e2.probeRequest }) });
    need(role && (contract.effort === "off" ? [undefined, "none"].includes(body.reasoning?.effort) : body.reasoning?.effort === contract.effort) && Array.isArray(body.input)
      && Object.keys(body).every(k => ["model", "store", "stream", "instructions", "input", "text", "include", "prompt_cache_key", "tool_choice", "parallel_tool_calls", "temperature", "tools", "reasoning"].includes(k)), "e2_payload_forbidden");
    // Shipping compaction deliberately disables body caching. Its authenticated
    // summary role still uses the controller phase identity in native headers.
    need((contract.e2.paidRole === "summary" && body.prompt_cache_key === undefined)
      || (contract.promptCacheKey === undefined && body.prompt_cache_key === undefined) || body.prompt_cache_key === contract.promptCacheKey, "e2_prompt_cache_key_forbidden");
  },
  assertCacheHeaders(headers, metadata, key) {
    const session = headers.get("session-id"), request = headers.get("x-client-request-id");
    need((session === key && request === key) || (session === null && request === null && key === undefined), "e2_prompt_cache_key_forbidden");
  },
  resultReceipt: writeE2SummaryResult,
  async verifySettlement(root, slotId, hold, evidence, readPrivate) {
    if (evidence?.schema === "continuity-e2-attempt-evidence-v1") {
      need(sameFields(evidence, ["schema", "nativeCause"]) && validE2FailureCause(evidence.nativeCause, { holds: [hold] }), "e2_receipt_invalid");
      hold.nativeCause = structuredClone(evidence.nativeCause); return;
    }
    if (hold.paidRole !== "summary" || hold.settlement.kind !== "settled") return;
    try { hold.summaryReceipt = await verifyE2SummaryResult(root, slotId, hold, evidence, readPrivate); }
    catch { fail("e2_summary_receipt_invalid"); }
  },
  async beforeAdmission(root, slotId, slot, p, readPrivate, state, pilot) {
    let scope, readArtifact;
    if (state?.schema === E2_REAL_CONTROLLER) {
      const { guardedAuthorization } = await import("./continuity-guarded-authorization.mjs");
      const planned = state.schedule[state.cursor];
      readArtifact = guardedAuthorization("e2-validation").readArtifact;
      scope = await e2LineageScope({ ...state, pilot }, planned, p.checkpoint, guardedAuthorization("e2-validation").readArtifact);
      slot.lineages ??= {};
      if (planned.kind === "proof" && planned.phase === "resume") {
        const previous = state.schedule[state.cursor - 1], seed = state.slots[state.cursor - 1];
        need(previous?.kind === "proof" && previous.phase === "seed" && previous.arm === planned.arm && previous.variant === planned.variant
          && ["completed", "own_abort_after_send"].includes(seed.terminal), "e2_compaction_invalid");
        if (!slot.lineages.proof && seed.lineages?.proof) slot.lineages.proof = structuredClone(seed.lineages.proof);
        need(!effectiveE2Summaries(seed.holds).length || slot.lineages.proof, "e2_summary_receipt_invalid");
      }
    }
    if (p.paidRole === "summary") return scope === undefined ? undefined : { lineageScope: scope, ...(slot.lineages[scope] ? { lineage: structuredClone(slot.lineages[scope]) } : {}) };
    need(!slot.compaction, "e2_compaction_invalid");
    // Rejected candidates remain authenticated paid evidence, never successors.
    for (const hold of slot.holds.filter(h => h.summaryReceipt?.rejected)) {
      need(hold.summaryReceipt.durable === false && E2_PROTECTION_REFUSALS.includes(hold.summaryReceipt.reason)
        && hold.summaryReceipt.verified && hold.consumed && hold.settlement?.kind === "settled", "e2_summary_receipt_invalid");
      try { await verifyE2SummaryResult(root, slotId, hold, { schema: hold.summaryReceipt.schema, sha256: hold.summaryReceipt.sha256 }, readPrivate); }
      catch { fail("e2_summary_receipt_invalid"); }
    }
    for (const hold of effectiveE2Summaries(slot.holds)) {
      const currentScope = state?.schema === E2_REAL_CONTROLLER && scope === await e2LineageScope({ ...state, pilot }, state.schedule[state.cursor], hold.checkpoint, readArtifact);
      need(hold.summaryReceipt?.verified && hold.summaryReceipt.durable && (!currentScope || slot.lineages?.[scope]), "e2_summary_receipt_invalid");
      try { await verifyE2SummaryResult(root, slotId, hold, { schema: hold.summaryReceipt.schema, sha256: hold.summaryReceipt.sha256 }, readPrivate); }
      catch { fail("e2_summary_receipt_invalid"); }
    }
    return scope === undefined ? undefined : { lineageScope: scope, ...(slot.lineages[scope] ? { lineage: structuredClone(slot.lineages[scope]) } : {}) };
  },
  async verifyNativeBody(bytes, hold, _state, _assignment, permit) {
    // The controller independently validates the final bytes and durably records
    // content-free presence before this gate can enter nativeFetch.
    need(permit?.verifyBody && bytes.length <= 12 * 1024 * 1024, "e2_summary_receipt_invalid");
    const result = await permit.verifyBody(hold.permitId, bytes.toString("base64"));
    need(!result?.refused, result?.code ?? "e2_summary_receipt_invalid");
  },
  observeAdmission(contract, payloadDigest) {
    const e = contract.e2; observeE2NativeCause(e.safety, "request_setup", null, undefined, { round: e.round, role: e.paidRole, checkpoint: e.checkpoint, payloadDigest });
  },
  observeNative(safety, stage, status, code, binding) { observeE2NativeCause(safety, stage, status, code, binding); },
  async diagnostics(root, state, index, pilot) {
    const { guardedAuthorization } = await import("./continuity-guarded-authorization.mjs");
    const read = guardedAuthorization("e2-validation").readArtifact, planned = state.schedule[index], base = e2PhaseBase(root, planned), result = {};
    let progressGap = 0;
    const gap = value => { if (Number.isSafeInteger(value) && value > 0 && value <= 4096) progressGap = Math.max(progressGap, value); };
    try {
      const cause = JSON.parse(await read(join(base, "native-cause.json"), "e2_receipt_invalid", 16384));
      if (validE2FailureCause(cause, state.slots[index])) result.nativeCause = cause;
    } catch { /* A bounded pre-stop cause survives forced child containment. */ }
    try {
      const refusal = JSON.parse(await read(join(base, `${planned.phase}-refusal.json`), "e2_receipt_invalid", 16384));
      if (validE2FailureCause(refusal.nativeCause, state.slots[index])) result.nativeCause = refusal.nativeCause;
      gap(refusal.progressGap);
    } catch { /* Diagnostic absence never changes stop/settlement/liability. */ }
    if (planned.kind === "replay") {
      for (const name of ["progress-gap.json", "replay.json"]) try { gap(JSON.parse(await read(join(base, name), "e2_receipt_invalid", 4 * 1024 * 1024)).progressGap); } catch { /* Bounded optional diagnostics only. */ }
      if (!["completed", "wrong"].includes(state.slots[index].terminal)) try {
        const registered = {};
        for (const [key, binding] of [["protocol", pilot.registration.protocol], ["questions", pilot.registration.probes]]) {
          const bytes = await read(binding.path, "e2_receipt_invalid", 4 * 1024 * 1024);
          need(rawDigest(bytes) === binding.sha256, "e2_receipt_invalid"); registered[key] = JSON.parse(bytes);
        }
        let answers;
        try { answers = await readE2Progress(base, state, index, read, registered); }
        catch { gap(1); } // Unreadable/invalid recovery evidence is an explicit gap, never a gate failure.
        if (answers || progressGap) {
          const binding = pilot.registration.keys, bytes = await read(binding.path, "e2_receipt_invalid", 4 * 1024 * 1024);
          need(rawDigest(bytes) === binding.sha256, "e2_receipt_invalid");
          try { result.partialQuality = await writeE2PartialScore(base, answers ?? { schema: "continuity-e2-answers-v1", answers: [] }, JSON.parse(bytes), read, progressGap); }
          catch (error) {
            if (error.code !== "E2_SCORING_INVALID") throw error;
            gap(1); result.partialQuality = await writeE2PartialScore(base, { schema: "continuity-e2-answers-v1", answers: [] }, JSON.parse(bytes), read, progressGap);
          }
        }
      } catch { /* Only independently bound progress can contribute informational counts. */ }
      if (progressGap) result.progressGap = progressGap;
    }
    return result;
  },
  async verifyBody(root, hold, state, index, p) {
    need(sameFields(p, ["permit", "body"]) && sameFields(p.permit, ["epoch", "permitId"]) && typeof p.body === "string" && p.body.length <= 16 * 1024 * 1024, "e2_summary_receipt_invalid");
    const bytes = Buffer.from(p.body, "base64");
    need(bytes.toString("base64") === p.body && rawDigest(bytes) === hold.payloadDigest, "e2_summary_receipt_invalid");
    this.assertBody(bytes, hold);
    const { guardedAuthorization } = await import("./continuity-guarded-authorization.mjs");
    hold.summaryPresence = await verifyE2NativeLineage(bytes, hold, state, { outputRoot: root, index }, guardedAuthorization("e2-validation").readArtifact);
  },
  async compaction(root, slotId, planned, slot, p, readPrivate, state, pilot) {
    const real = state?.schema === E2_REAL_CONTROLLER;
    need(sameFields(p, p?.kind === "rejected" ? ["kind", "operationDigest", "checkpoint", "reason"] : real && p?.kind === "durable" ? ["kind", "operationDigest", "checkpoint", "journalId", "checkpointId"] : ["kind", "operationDigest", "checkpoint"]) && /^[a-f0-9]{64}$/u.test(p.operationDigest ?? "")
      && count(p.checkpoint) && slot.holds.every(h => h.settlement) && !slot.terminal, "e2_compaction_invalid");
    if (p.kind === "begin") {
      need(!slot.compaction && !slot.holds.some(h => h.operationDigest === p.operationDigest) && planned.budgets.some(b => b.paidRole === "summary" && b.checkpoint === p.checkpoint), "e2_compaction_invalid");
      let nativeSnapshot;
      if (real) {
        const { guardedAuthorization } = await import("./continuity-guarded-authorization.mjs");
        nativeSnapshot = await e2NativeCompactionSnapshot(root, { ...state, pilot }, planned, p.checkpoint, guardedAuthorization("e2-validation").readArtifact);
      }
      slot.compaction = { operationDigest: p.operationDigest, checkpoint: p.checkpoint, firstRound: slot.holds.length + 1, ...(real ? { nativeSnapshot } : {}) };
    } else if (p.kind === "rejected") {
      const pending = slot.compaction;
      need(real && pending?.operationDigest === p.operationDigest && pending.checkpoint === p.checkpoint
        && E2_PROTECTION_REFUSALS.includes(p.reason) && !slot.retryPending && pending.nativeSnapshot, "e2_compaction_invalid");
      const candidates = slot.holds.slice(pending.firstRound - 1);
      const summaries = effectiveE2Summaries(candidates);
      need(summaries.length > 0 && candidates.every(h => h.paidRole === "summary" && h.operationDigest === p.operationDigest && h.checkpoint === p.checkpoint
        && h.consumed && !h.summaryReceipt?.durable && !h.summaryReceipt?.rejected
        && (summaries.includes(h) || supersedingE2Summary(candidates, h)))
        && summaries.every(h => h.settlement?.kind === "settled" && h.summaryReceipt?.verified && h.summaryReceipt.durable === false), "e2_summary_receipt_invalid");
      for (const h of summaries) {
        try { await verifyE2SummaryResult(root, slotId, h, { schema: h.summaryReceipt.schema, sha256: h.summaryReceipt.sha256 }, readPrivate); }
        catch { fail("e2_summary_receipt_invalid"); }
      }
      const { guardedAuthorization } = await import("./continuity-guarded-authorization.mjs");
      await e2NativeCompactionSnapshot(root, { ...state, pilot }, planned, p.checkpoint, guardedAuthorization("e2-validation").readArtifact, pending.nativeSnapshot);
      slot.compactionRefusals ??= [];
      slot.compactionRefusals.push({ operationDigest: p.operationDigest, checkpoint: p.checkpoint, reason: p.reason, rounds: candidates.map(h => h.round) });
      summaries.forEach(h => { h.summaryReceipt.rejected = true; h.summaryReceipt.reason = p.reason; });
      slot.compaction = null;
    } else {
      need(p.kind === "durable" && slot.compaction?.operationDigest === p.operationDigest && slot.compaction.checkpoint === p.checkpoint, "e2_compaction_invalid");
      const summaries = effectiveE2Summaries(slot.holds).filter(h => h.operationDigest === p.operationDigest);
      need(summaries.length > 0 && summaries.every(h => h.consumed && h.settlement.kind === "settled" && h.summaryReceipt?.verified && !h.summaryReceipt.durable), "e2_summary_receipt_invalid");
      for (const h of summaries) {
        try { await verifyE2SummaryResult(root, slotId, h, { schema: h.summaryReceipt.schema, sha256: h.summaryReceipt.sha256 }, readPrivate); }
        catch { fail("e2_summary_receipt_invalid"); }
      }
      if (real) {
        const { guardedAuthorization } = await import("./continuity-guarded-authorization.mjs");
        const lineage = await bindE2Checkpoint({ root, state: { ...state, pilot }, planned, slot, summaries, reference: p, readPrivate,
          readArtifact: guardedAuthorization("e2-validation").readArtifact });
        slot.lineages ??= {}; slot.lineages[lineage.scope] = lineage;
        slot.checkpoints ??= []; slot.checkpoints.push({ journalId: lineage.journalId, checkpointId: lineage.checkpointId });
      }
      summaries.forEach(h => { h.summaryReceipt.durable = true; }); slot.compaction = null;
    }
  },
  slotReceipt(state, index, accountRun, protocol) {
    const slot = state.slots[index], planned = state.schedule[index];
    need(slot && planned && slot.slotId === planned.slotId && [...protocol.policy.SLOT_TERMINALS, null].includes(slot.terminal)
      && [null, 0, 1].includes(slot.score), "e2_receipt_invalid");
    const spend = accountRun([slot]);
    const row = { ...(planned.arm === "baseline" ? { replayArm: "baseline", qualification: false } : {}), compactionRefusals: e2RefusalCounts([slot]), retries: e2RetryCounts([slot]), ...(slot.diagnostics && Object.keys(slot.diagnostics).length ? { diagnostics: slot.diagnostics } : {}), schema: protocol.schemas.slotReceipt, slotId: planned.slotId, position: index, terminal: slot.terminal,
      score: ["completed", "wrong"].includes(slot.terminal) ? slot.score : null,
      qualityMeasured: state.schema === protocol.policy.REAL_CONTROLLER && slot.holds.length > 0 && ["completed", "wrong"].includes(slot.terminal) && slot.score !== null,
      calls: { admitted: slot.holds.length, consumed: slot.holds.filter(h => h.consumed).length, settled: slot.holds.filter(h => h.settlement).length,
        verifiedSummaries: slot.holds.filter(h => h.summaryReceipt?.verified && h.summaryReceipt.durable).length },
      summaryPresence: { checked: slot.holds.filter(h => h.summaryPresence).length, unobserved: slot.holds.filter(h => !h.summaryPresence).length,
        native: slot.holds.filter(h => h.summaryPresence?.native > 0).length, branch: slot.holds.filter(h => h.summaryPresence?.branch > 0).length,
        pack: slot.holds.filter(h => h.summaryPresence?.pack > 0).length, none: slot.holds.filter(h => h.summaryPresence?.none).length },
      usage: { inputTokens: slot.holds.reduce((n, h) => n + (h.settlement?.rawUsage?.input_tokens ?? 0), 0), outputTokens: slot.holds.reduce((n, h) => n + (h.settlement?.rawUsage?.output_tokens ?? 0), 0) },
      costs: { completeUnits: spend.completeUnits, retainedUnits: spend.retainedUnits, activeUnits: spend.activeUnits, totalUnits: spend.totalUnits, knownPartialUnits: spend.knownPartialUnits } };
    return { ...row, sha256: digest(row) };
  },
  aggregateRun(state, receipts, accountRun, protocol) {
    need(count(state.cursor) && state.cursor <= state.schedule.length && (state.stop === null || protocol.policy.PILOT_STOPS.includes(state.stop)), "e2_receipt_invalid");
    const seen = new Set(), visited = state.cursor + (state.slots[state.cursor]?.worker || state.slots[state.cursor]?.holds.length ? 1 : 0);
    for (const r of receipts) {
      need(count(r.position) && r.position < visited && !seen.has(r.position) && digest(r) === digest(this.slotReceipt(state, r.position, accountRun, protocol)), "e2_receipt_invalid"); seen.add(r.position);
    }
    const spend = accountRun(state.slots);
    return { ...(state.schedule.some(p => p.arm === "baseline") ? { replayArm: "baseline", qualification: false } : {}), compactionRefusals: e2RefusalCounts(state.slots), retries: e2RetryCounts(state.slots), schema: protocol.schemas.report, authorization: state.schema === protocol.policy.REAL_CONTROLLER, executionKind: state.schema === protocol.policy.REAL_CONTROLLER ? "authorized-validation" : "faux-only",
      qualityMeasured: receipts.some(r => r.qualityMeasured), schedule: { planned: state.schedule.length, visited, missing: visited - seen.size, remaining: state.schedule.length - visited }, stop: state.stop,
      costs: { unitsPerUSD: protocol.policy.USD_UNITS.toString(), capUnits: state.capUnits, ...Object.fromEntries(Object.entries(spend).filter(([key]) => key.endsWith("Units"))) },
      phases: [...receipts].sort((a, b) => a.position - b.position).map(({ slotId: _slotId, sha256: _sha256, ...r }) => r) };
  },
  priceUsage: (raw, tier, hold) => { need(hold?.catalog, "e2_invalid_usage"); return e2UsageUnits(raw, tier, hold.catalog).toString(); },
  assertBody(bytes, hold) {
    let body; try { body = JSON.parse(bytes); } catch { fail("e2_body_mismatch"); }
    need(`${E2_GUARD_CONTRACT.provider}:${body.model}` === hold?.model && body.stream === true && body.store === false && body.service_tier === undefined, "e2_body_mismatch");
    need(Array.isArray(body.tools ?? []) && (body.tools ?? []).every(t => t.type === "function" && hold.tools.includes(t.name)), "e2_tools_forbidden");
    if (hold.probeRequest !== undefined) need((body.tools ?? []).length === hold.tools.length, "e2_tools_forbidden");
    if (hold.replayArm === "baseline") {
      const kind = hold.paidRole === "summary" ? "summary"
        : hold.probeRequest !== undefined || hold.paidRole === "probe" ? "probe" : "source";
      assertE2BaselineRequest(body, { kind, sourceTools: hold.tools });
    }
    validateBody(body);
  },
});
