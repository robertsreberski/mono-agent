// Closed E2 accounting policy. Durable admission/consume/settle remain in the shared core.
import { digest } from "./continuity-dataset.mjs";
import { e2RequestPrice, e2UsageUnits } from "./continuity-e2-pricing.mjs";
import { E2_PERMIT_CONTRACT, E2_GUARD_CONTRACT, E2_REAL_CONTROLLER } from "./continuity-e2-policy.mjs";
import { validateE2Sizing } from "./continuity-e2-estimate.mjs";
import { E2_PAID_ROLES } from "./continuity-e2-roles.mjs";
import { writeE2SummaryResult, verifyE2SummaryResult } from "./continuity-e2-summary-receipts.mjs";
import { bindE2Checkpoint, verifyE2NativeLineage, e2LineageScope } from "./continuity-e2-lineage.mjs";
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
// Funding is shared; only the controller owns live hold counts and lifecycle admission.
function requestFunding(pilot, planned, p, operationDigest) {
  need(sameFields(p, E2_PERMIT_CONTRACT.admissionFields) && E2_PAID_ROLES.includes(p.paidRole) && count(p.checkpoint) && count(p.inputTokens));
  const role = pilot.registration.roles.find(r => r.role === p.paidRole && r.model === p.model), catalog = pilot.registration.catalog.find(c => c.model === p.model);
  need(role && catalog && p.inputTokens <= role.maxInputTokens && p.inputTokens <= catalog.contextWindow, "not_admitted_input_envelope");
  const budget = planned.budgets.find(b => b.paidRole === p.paidRole && b.model === p.model && b.checkpoint === p.checkpoint);
  need(budget, "e2_request_limit");
  const reserve = e2RequestPrice(catalog, { inputTokens: p.inputTokens, maxOutputTokens: role.maxOutputTokens }).reservationUnits;
  need(p.reservationUnits === reserve);
  return { reserve: BigInt(reserve), metadata: { model: p.model, paidRole: p.paidRole, checkpoint: p.checkpoint, measuredInputTokens: p.inputTokens,
    ...(p.paidRole === "summary" ? { operationDigest } : {}), inputMax: catalog.contextWindow, outputMax: role.maxOutputTokens, catalog: structuredClone(catalog),
    tools: [...(p.paidRole === "summary" ? pilot.registration.toolPolicies.summary : planned.kind === "replay" ? pilot.registration.toolPolicies.replay
    : planned.arm === "cancel" && p.paidRole === "continuation" ? pilot.registration.toolPolicies.cancelContinuation : pilot.registration.toolPolicies.proof)] } };
}
export const e2ExecutionPolicy = Object.freeze({
  cap(pilot) {
    const value = pilot?.descriptor?.capUnits;
    need(typeof value === "string" && /^(0|[1-9][0-9]{0,29})$/u.test(value), "e2_registration_invalid"); return BigInt(value);
  },
  admission(pilot, planned, slot, p) {
    need(sameFields(p, E2_PERMIT_CONTRACT.admissionFields) && E2_PAID_ROLES.includes(p.paidRole) && count(p.checkpoint) && count(p.inputTokens));
    need(p.checkpoint >= (slot.holds.at(-1)?.checkpoint ?? 0));
    if (p.paidRole === "summary") need(slot.compaction && slot.compaction.checkpoint === p.checkpoint, "e2_summary_not_authorized");
    const budget = planned.budgets.find(b => b.paidRole === p.paidRole && b.model === p.model && b.checkpoint === p.checkpoint);
    need(budget && slot.holds.filter(h => h.paidRole === p.paidRole && h.model === p.model && h.checkpoint === p.checkpoint).length < budget.maxRequests, "e2_request_limit");
    return requestFunding(pilot, planned, p, slot.compaction?.operationDigest);
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
    const derived = requestFunding(e2.pilot, e2.planned, p, e2.operationDigest);
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
    const tools = contract.e2.pilot.registration.toolPolicies;
    const allowed = contract.e2.paidRole === "summary" ? tools.summary : contract.e2.planned.kind === "replay" ? tools.replay
      : contract.e2.planned.arm === "cancel" && contract.e2.paidRole === "continuation" ? tools.cancelContinuation : tools.proof;
    this.assertBody(Buffer.from(JSON.stringify(body)), { model: contract.e2.model, tools: allowed });
    need(role && (contract.effort === "off" ? [undefined, "none"].includes(body.reasoning?.effort) : body.reasoning?.effort === contract.effort) && Array.isArray(body.input)
      && Object.keys(body).every(k => ["model", "store", "stream", "instructions", "input", "text", "include", "prompt_cache_key", "tool_choice", "parallel_tool_calls", "temperature", "tools", "reasoning"].includes(k)), "e2_payload_forbidden");
    // Shipping compaction deliberately disables body caching. Its authenticated
    // summary role still uses the controller phase identity in native headers.
    need((contract.e2.paidRole === "summary" && body.prompt_cache_key === undefined)
      || (contract.promptCacheKey === undefined && body.prompt_cache_key === undefined) || body.prompt_cache_key === contract.promptCacheKey, "e2_prompt_cache_key_forbidden");
  },
  assertCacheHeaders(headers, metadata, key) {
    const session = headers.get("session-id"), request = headers.get("x-client-request-id");
    need((session === key && request === key) || (session === null && request === null && (key === undefined || metadata.paidRole === "summary")), "e2_prompt_cache_key_forbidden");
  },
  resultReceipt: writeE2SummaryResult,
  async verifySettlement(root, slotId, hold, evidence, readPrivate) {
    if (hold.paidRole !== "summary" || hold.settlement.kind !== "settled") return;
    try { hold.summaryReceipt = await verifyE2SummaryResult(root, slotId, hold, evidence, readPrivate); }
    catch { fail("e2_summary_receipt_invalid"); }
  },
  async beforeAdmission(root, slotId, slot, p, readPrivate, state, pilot) {
    if (p.paidRole === "summary") return;
    need(!slot.compaction, "e2_compaction_invalid");
    let scope;
    if (state?.schema === E2_REAL_CONTROLLER) {
      const { guardedAuthorization } = await import("./continuity-guarded-authorization.mjs");
      const planned = state.schedule[state.cursor];
      scope = await e2LineageScope({ ...state, pilot }, planned, p.checkpoint, guardedAuthorization("e2-validation").readArtifact);
      slot.lineages ??= {};
      if (planned.kind === "proof" && planned.phase === "resume" && !slot.lineages.proof) {
        const previous = state.schedule[state.cursor - 1], seed = state.slots[state.cursor - 1];
        need(previous?.kind === "proof" && previous.phase === "seed" && previous.arm === planned.arm && previous.variant === planned.variant
          && ["completed", "own_abort_after_send"].includes(seed.terminal), "e2_compaction_invalid");
        if (seed.lineages?.proof) slot.lineages.proof = structuredClone(seed.lineages.proof);
        need(!seed.holds.some(h => h.paidRole === "summary") || slot.lineages.proof, "e2_summary_receipt_invalid");
      }
    }
    for (const hold of slot.holds.filter(h => h.paidRole === "summary")) {
      need(hold.summaryReceipt?.verified && hold.summaryReceipt.durable && (state?.schema !== E2_REAL_CONTROLLER || slot.lineages), "e2_summary_receipt_invalid");
      try { await verifyE2SummaryResult(root, slotId, hold, { schema: hold.summaryReceipt.schema, sha256: hold.summaryReceipt.sha256 }, readPrivate); }
      catch { fail("e2_summary_receipt_invalid"); }
    }
    return scope === undefined ? undefined : { lineageScope: scope, ...(slot.lineages[scope] ? { lineage: structuredClone(slot.lineages[scope]) } : {}) };
  },
  async verifyNativeBody(bytes, hold, state, assignment) {
    const { guardedAuthorization } = await import("./continuity-guarded-authorization.mjs");
    if (hold.paidRole !== "summary") await verifyE2NativeLineage(bytes, hold, state, assignment, guardedAuthorization("e2-validation").readArtifact);
  },
  async compaction(root, slotId, planned, slot, p, readPrivate, state, pilot) {
    const real = state?.schema === E2_REAL_CONTROLLER;
    need(sameFields(p, real && p?.kind === "durable" ? ["kind", "operationDigest", "checkpoint", "journalId", "checkpointId"] : ["kind", "operationDigest", "checkpoint"]) && /^[a-f0-9]{64}$/u.test(p.operationDigest ?? "")
      && count(p.checkpoint) && slot.holds.every(h => h.settlement) && !slot.terminal, "e2_compaction_invalid");
    if (p.kind === "begin") {
      need(!slot.compaction && !slot.holds.some(h => h.operationDigest === p.operationDigest) && planned.budgets.some(b => b.paidRole === "summary" && b.checkpoint === p.checkpoint), "e2_compaction_invalid");
      slot.compaction = { operationDigest: p.operationDigest, checkpoint: p.checkpoint };
    } else {
      need(p.kind === "durable" && slot.compaction?.operationDigest === p.operationDigest && slot.compaction.checkpoint === p.checkpoint, "e2_compaction_invalid");
      const summaries = slot.holds.filter(h => h.operationDigest === p.operationDigest);
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
    const row = { schema: protocol.schemas.slotReceipt, slotId: planned.slotId, position: index, terminal: slot.terminal,
      score: ["completed", "wrong"].includes(slot.terminal) ? slot.score : null,
      qualityMeasured: state.schema === protocol.policy.REAL_CONTROLLER && slot.holds.length > 0 && ["completed", "wrong"].includes(slot.terminal) && slot.score !== null,
      calls: { admitted: slot.holds.length, consumed: slot.holds.filter(h => h.consumed).length, settled: slot.holds.filter(h => h.settlement).length,
        verifiedSummaries: slot.holds.filter(h => h.summaryReceipt?.verified && h.summaryReceipt.durable).length },
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
    return { schema: protocol.schemas.report, authorization: state.schema === protocol.policy.REAL_CONTROLLER, executionKind: state.schema === protocol.policy.REAL_CONTROLLER ? "authorized-validation" : "faux-only",
      qualityMeasured: receipts.some(r => r.qualityMeasured), schedule: { planned: state.schedule.length, visited, missing: visited - seen.size, remaining: state.schedule.length - visited }, stop: state.stop,
      costs: { unitsPerUSD: protocol.policy.USD_UNITS.toString(), capUnits: state.capUnits, ...Object.fromEntries(Object.entries(spend).filter(([key]) => key.endsWith("Units"))) },
      phases: [...receipts].sort((a, b) => a.position - b.position).map(({ slotId: _slotId, sha256: _sha256, ...r }) => r) };
  },
  priceUsage: (raw, tier, hold) => { need(hold?.catalog, "e2_invalid_usage"); return e2UsageUnits(raw, tier, hold.catalog).toString(); },
  assertBody(bytes, hold) {
    let body; try { body = JSON.parse(bytes); } catch { fail("e2_body_mismatch"); }
    need(`${E2_GUARD_CONTRACT.provider}:${body.model}` === hold?.model && body.stream === true && body.store === false && body.service_tier === undefined, "e2_body_mismatch");
    need(Array.isArray(body.tools ?? []) && (body.tools ?? []).every(t => t.type === "function" && hold.tools.includes(t.name)), "e2_tools_forbidden");
    validateBody(body);
  },
});
