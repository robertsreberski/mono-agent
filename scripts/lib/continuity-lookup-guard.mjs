import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";

const freeze = value => { for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child); return Object.freeze(value); };
export const LOOKUP_ASSUMPTIONS = freeze({
  version: "assumed-v1",
  literalInput: "utf8_bytes_gte_tokens",
  framing: { base: 4096, inputItem: 256, reasoningItem: 1024, tool: 1024, schemaProperty: 256, instructions: 4096 },
  outputIncludesReasoning: true, restoredReasoningLteSettledOutput: true,
  inputMax: 272000, outputMax: 128000, tierMultiplierMax: 2,
  rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  rmax: 3.92,
});
export const LOOKUP_GUARD_CONTRACT = freeze({
  version: "lookup-guard-v1", provider: "openai-codex", model: "gpt-6.1-sol",
  api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", effort: "high",
  slotId: "", runId: "",
});
export const LOOKUP_OUTCOMES = freeze({
  refused_pre_send: { hold: "none", pilot: "continues" },
  own_abort_after_send: { hold: "retained", pilot: "continues_slot_terminal" },
  settled: { hold: "actual_cost", pilot: "continues" },
  lost: { hold: "retained", pilot: "continues_unless_run_dependency" },
  integrity_stop: { hold: "retained", pilot: "sticky_stop" },
});
export class LookupGuardError extends Error {
  constructor(code, outcome = "refused_pre_send", classification = code) {
    super(code); this.code = code; this.outcome = outcome; this.classification = classification;
  }
}
const refuse = (code, classification) => { throw new LookupGuardError(code, "refused_pre_send", classification); };
export const lookupBodyDigest = bytes => createHash("sha256").update(bytes).digest("hex");
function properties(value) {
  if (!value || typeof value !== "object") return 0;
  return (value.properties ? Object.keys(value.properties).length : 0) + Object.values(value).reduce((n, v) => n + properties(v), 0);
}
export function lookupInputEnvelope(payload, settledOutputTokens = [], assumptions = LOOKUP_ASSUMPTIONS) {
  const h = assumptions.framing;
  const input = payload.input ?? [], tools = payload.tools ?? [];
  const H = h.base + input.length * h.inputItem + input.filter(x => x.type === "reasoning").length * h.reasoningItem
    + tools.length * h.tool + properties(tools) * h.schemaProperty + (Object.hasOwn(payload, "instructions") ? h.instructions : 0);
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  return { bytes, H, U: bytes + settledOutputTokens.reduce((a, b) => a + b, 0) + H };
}

/** B2b must call at entry and again in each child, on resolved settings (not CLI flags). */
export function assertLookupAuxiliaryCallersOff({ plan, memory, subagents, upkeep, compaction, outputSchema }) {
  if (plan?.judge !== null || memory !== false || subagents !== false || upkeep !== false || compaction !== false || outputSchema != null)
    refuse("lookup_auxiliary_callers_forbidden");
}
export function assertLookupChildSafety(settings) { assertLookupAuxiliaryCallersOff(settings); }
export function assertRealLookupPermitSource(source) {
  if (!source || source.testOnly !== false || source.brand !== "lookup-controller-v1") refuse("lookup_faux_permit_forbidden");
}

export const LOOKUP_PERMIT_CONTRACT = freeze({
  version: "lookup-permit-v1",
  admissionFields: ["requestId", "slotId", "round", "payloadDigest", "rmax"],
  methods: ["admit", "consume", "settle", "stop"],
  outcomes: Object.keys(LOOKUP_OUTCOMES),
});

/**
 * @typedef {object} LookupPermitSource
 * @property {(request: {requestId: string, slotId: string, round: number, payloadDigest: string, rmax: number}) => any} admit
 * @property {(permit: any, bodyDigest: string) => void | Promise<void>} consume
 * @property {(permit: any, outcome: {kind: string, code?: string, cost?: number}, rawUsage: object | null, tier: unknown) => void | Promise<void>} settle
 * @property {(code: string) => void | Promise<void>} stop
 */

/** Frozen wire contract: all calls may be async. B2b owns durability/epoch/IPC.
 * admit({requestId,slotId,round,payloadDigest,rmax}) => opaque permit | {refused:true,code}
 * consume(permit,bodyDigest): exactly once immediately before injected fetch.
 * settle(permit,outcome,rawUsage,tier): exactly once; outcome includes code/cost.
 * stop(code): sticky, revokes unconsumed permits. No raw bodies cross this API.
 */
export function createTestOnlyLookupPermitSource() {
  const states = new Map(), events = []; let stopped = false;
  return Object.freeze({ brand: "lookup-faux-test-only-v1", testOnly: true, events,
    admit(request) {
      if (stopped) return { refused: true, code: "lookup_stopped" };
      const permit = Object.freeze({ ...request }); states.set(permit, { used: false, settled: false });
      events.push({ type: "admit", ...request }); return permit;
    },
    consume(permit, bodyDigest) {
      const state = states.get(permit);
      if (stopped || !state || state.used || state.settled || permit.payloadDigest !== bodyDigest) refuse("lookup_permit_invalid");
      state.used = true; events.push({ type: "consume", requestId: permit.requestId });
    },
    settle(permit, outcome, rawUsage, tier) {
      const state = states.get(permit);
      if (!state || state.settled) refuse("lookup_settlement_invalid");
      state.settled = true; events.push({ type: "settle", requestId: permit.requestId, outcome, rawUsage, tier });
    },
    stop(code) { stopped = true; events.push({ type: "stop", code }); },
  });
}

function assertRoute(model, options, contract) {
  if (model?.provider !== contract.provider || model?.id !== contract.model || model?.api !== contract.api || model?.baseUrl !== contract.baseUrl
    || (model.contextWindow !== undefined && model.contextWindow !== 272000)
    || (model.maxTokens !== undefined && model.maxTokens > 128000)
    || options.reasoning !== contract.effort || options.transport !== "sse" || options.maxRetries !== 0)
    refuse("lookup_route_mismatch");
  for (const key of ["context1MModels", "model", "effort", "fallbacks", "requestModelOverride", "baseUrl", "serviceTier", "contextWindow", "provider", "api", "context1M", "outputSchema"])
    if (options[key] !== undefined) refuse("lookup_override_forbidden");
}
function assertPayload(payload, round, contract) {
  if (payload.model !== contract.model || payload.reasoning?.effort !== contract.effort || payload.store !== false || payload.stream !== true
    || payload.response_format !== undefined || payload.text?.format !== undefined
    || payload.previous_response_id !== undefined || payload.service_tier !== undefined || !Array.isArray(payload.input)) refuse("lookup_payload_forbidden");
  if ((payload.tools ?? []).some(tool => tool.type !== "function") || (payload.instructions !== undefined && typeof payload.instructions !== "string")) refuse("lookup_payload_forbidden");
  for (const item of payload.input) {
    if (item.type === "reasoning") { if (round === 1) refuse("lookup_initial_reasoning_forbidden"); continue; }
    if (![undefined, "message", "function_call", "function_call_output"].includes(item.type)) refuse("lookup_payload_forbidden");
    if (item.type === undefined && !["system", "developer", "user", "assistant"].includes(item.role)) refuse("lookup_payload_forbidden");
    if (Array.isArray(item.content) && item.content.some(part => !["input_text", "output_text"].includes(part.type))) refuse("lookup_payload_forbidden");
    if (item.type === "function_call_output" && typeof item.output !== "string") refuse("lookup_payload_forbidden");
    if (item.content !== undefined && typeof item.content !== "string" && !Array.isArray(item.content)) refuse("lookup_payload_forbidden");
  }
}
const count = n => Number.isSafeInteger(n) && n >= 0;
export function lookupSettledCost(usage, tier) {
  const cached = usage.input_tokens_details?.cached_tokens ?? 0, written = usage.input_tokens_details?.cache_write_tokens ?? 0;
  // Integer microdollars; rates expressed as tenths to avoid binary rounding at the hold.
  const tenths = (usage.input_tokens - cached - written) * 20 + cached + written * 25 + usage.output_tokens * 100;
  return tenths * (tier === "flex" ? 0.5 : tier === "default" ? 1 : 2) / 10000000;
}

/** One wrapper per sequential probe run. Never share it between slots. No default fetch. */
export function guardedLookupModels(models, { contract, permit, assumptions = LOOKUP_ASSUMPTIONS }) {
  if (JSON.stringify(assumptions) !== JSON.stringify(LOOKUP_ASSUMPTIONS)) refuse("lookup_assumptions_mismatch");
  for (const key of ["provider", "model", "api", "baseUrl", "effort", "version"])
    if (contract?.[key] !== LOOKUP_GUARD_CONTRACT[key]) refuse("lookup_contract_mismatch");
  if (!contract.slotId || !contract.runId) refuse("lookup_contract_mismatch");
  contract = Object.freeze({ ...contract });
  assumptions = LOOKUP_ASSUMPTIONS;
  const outputs = []; let rounds = 0, active = false, stopped = false, dependencyLost = false, finalizationBlocked = false;
  async function stop(code) { stopped = true; await permit.stop(code); }
  function streamSimple(model, context, options = {}) {
    if (stopped) refuse("lookup_stopped");
    if (active) refuse("lookup_concurrent_request");
    if (dependencyLost) { stopped = true; void Promise.resolve().then(() => permit.stop("lookup_unsettled_dependency")).catch(() => {}); throw new LookupGuardError("lookup_unsettled_dependency", "integrity_stop"); }
    if (finalizationBlocked) refuse("pilot_empty_final_output", "failed/pilot_empty_final_output");
    if (rounds >= 10) refuse("lookup_request_limit");
    assertRoute(model, options, contract);
    if (typeof options.fetch !== "function") refuse("lookup_injected_fetch_required");
    const round = rounds + 1;
    let admitted, sent = false, raw, tier, envelope, payloadSeen = false, preRefusal, integrity;
    active = true;
    const finish = async (message, failure) => {
      try {
        if (admitted) {
          let code, outcome = "lost", cost;
          if (integrity) { outcome = "integrity_stop"; code = integrity; }
          else if (raw) {
            if (tier !== undefined && !["default", "flex", "priority"].includes(tier)) code = "lookup_unknown_tier";
            else if (raw.input_tokens > envelope.U) code = "lookup_input_envelope_violated";
            else if (raw.output_tokens > assumptions.outputMax) code = "lookup_output_envelope_violated";
            else if ((raw.output_tokens_details?.reasoning_tokens ?? 0) > raw.output_tokens) code = "lookup_reasoning_envelope_violated";
            else { cost = lookupSettledCost(raw, tier); if (cost > assumptions.rmax) code = "lookup_hold_exceeded"; }
            outcome = code ? "integrity_stop" : failure ? (sent && options.signal?.aborted ? "own_abort_after_send" : "lost") : "settled";
          } else if (sent && options.signal?.aborted) outcome = "own_abort_after_send";
          if (outcome !== "settled") dependencyLost = true;
          try {
            await permit.settle(admitted, { kind: outcome, ...(code ? { code } : {}), ...(cost !== undefined ? { cost } : {}) }, raw ?? null, ["default", "flex", "priority"].includes(tier) ? tier : null);
          } catch {
            stopped = true; dependencyLost = true;
            try { await permit.stop("lookup_settlement_failed"); } catch { /* Local admission is already closed. */ }
            throw new LookupGuardError("lookup_settlement_failed", "integrity_stop");
          }
          if (outcome === "settled") outputs.push(raw.output_tokens);
          if (outcome === "integrity_stop") { await stop(code); throw new LookupGuardError(code, outcome); }
        }
        if (message && (message.stopReason === "length" || (message.stopReason === "stop" && !(message.content ?? []).some(p => p.type === "text" && p.text?.trim())))) finalizationBlocked = true;
        if (preRefusal) throw preRefusal;
        if (failure) throw failure;
        return message;
      } finally { active = false; }
    };
    const wrapped = { ...options,
      onPayload: async (payload, selected) => {
        try {
          if (payloadSeen) refuse("lookup_payload_repeated"); payloadSeen = true;
          const mutated = await options.onPayload?.(payload, selected) ?? payload;
          // Snapshot once: accessors/toJSON cannot change between sizing and digesting.
          const final = JSON.parse(JSON.stringify(mutated));
          assertPayload(final, round, contract);
          envelope = lookupInputEnvelope(final, outputs, assumptions);
          if (envelope.U > assumptions.inputMax) refuse("not_admitted_input_envelope");
          const payloadDigest = lookupBodyDigest(Buffer.from(JSON.stringify(final)));
          const grant = await permit.admit({ requestId: `${contract.runId}:${round}`, slotId: contract.slotId, round, payloadDigest, rmax: assumptions.rmax });
          if (grant?.refused) refuse(grant.code ?? "not_admitted_cap");
          if (!grant) refuse("lookup_permit_missing");
          admitted = grant; rounds++;
          // Detach from all mutation hooks; fetch verifies these exact serialized bytes.
          return JSON.parse(JSON.stringify(final));
        } catch (error) { preRefusal = error; throw error; }
      },
      fetch: async (url, init) => {
        if (!admitted || sent) { integrity = "lookup_permit_invalid"; throw new LookupGuardError(integrity); }
        const encoding = new Headers(init?.headers).get("content-encoding");
        if (String(url) !== `${contract.baseUrl}/codex/responses` || init?.method !== "POST" || ![null, "zstd"].includes(encoding)) {
          integrity = "lookup_send_mismatch"; throw new LookupGuardError(integrity);
        }
        try {
          const bytes = encoding === "zstd" ? zstdDecompressSync(init.body) : Buffer.from(init.body);
          await permit.consume(admitted, lookupBodyDigest(bytes));
        } catch (error) { integrity = "lookup_permit_invalid"; throw error; }
        sent = true;
        return options.fetch(url, init);
      },
      onProviderStreamEvent: async (event, selected) => {
        if (event?.type === "response.failed") raw = undefined;
        if (["response.completed", "response.incomplete"].includes(event?.type)) {
          const usage = event.response?.usage;
          tier = event.response?.service_tier;
          if (tier !== undefined && !["default", "flex", "priority"].includes(tier)) integrity = "lookup_unknown_tier";
          if (raw) integrity = "lookup_duplicate_terminal";
          if (sent && count(usage?.input_tokens) && count(usage?.output_tokens)) {
            const details = usage.input_tokens_details;
            if (![details?.cached_tokens ?? 0, details?.cache_write_tokens ?? 0, usage.output_tokens_details?.reasoning_tokens ?? 0].every(count)
              || (details?.cached_tokens ?? 0) + (details?.cache_write_tokens ?? 0) > usage.input_tokens) integrity = "lookup_invalid_usage";
            // Only numeric usage leaves the guard; never forward arbitrary event fields.
            raw = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
            const inputDetails = Object.fromEntries(["cached_tokens", "cache_write_tokens"]
              .filter(key => count(details?.[key])).map(key => [key, details[key]]));
            if (Object.keys(inputDetails).length) raw.input_tokens_details = inputDetails;
            if (count(usage.output_tokens_details?.reasoning_tokens))
              raw.output_tokens_details = { reasoning_tokens: usage.output_tokens_details.reasoning_tokens };
          }
        }
        await options.onProviderStreamEvent?.(event, selected);
      },
    };
    let source;
    try { source = models.streamSimple(model, context, wrapped); }
    catch (error) { active = false; throw error; }
    // Start result observation immediately, even when the consumer abandons iteration.
    const result = Promise.resolve(source.result()).then(m => finish(m), e => finish(undefined, e));
    void result.catch(() => {});
    return { result: () => result, async *[Symbol.asyncIterator]() {
      for await (const event of source) {
        if (["done", "error"].includes(event.type)) await result;
        yield event;
      }
      await result;
    } };
  }
  return new Proxy(models, { get(target, key) {
    if (key === "streamSimple") return streamSimple;
    // Metadata/auth only; never expose a provider object capable of dispatch.
    if (key === "getModel" || key === "getAuth") return target[key].bind(target);
    if (key === "getProvider") return id => target.getProvider(id) ? Object.freeze({ id }) : undefined;
    if (typeof key === "symbol") return undefined;
    return () => refuse("lookup_method_forbidden", "failed/pilot_method_forbidden");
  } });
}
