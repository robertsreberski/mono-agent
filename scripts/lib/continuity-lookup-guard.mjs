import { assertResolvedLookupSafety, lookupCacheKey } from "./continuity-lookup-pilot-runtime.mjs";
import { isRealLookupSend, realLookupSendForGuard } from "./continuity-lookup-real-capability.mjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
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
  slotId: "", runId: "", piMaxRetries: 0, maxRetries: 0,
});
export const LOOKUP_OUTCOMES = freeze({
  refused_pre_send: { hold: "none", pilot: "capacity_continues_policy_stops" },
  own_abort_after_send: { hold: "retained", pilot: "continues_slot_terminal" },
  settled: { hold: "actual_cost", pilot: "continues" },
  lost: { hold: "retained", pilot: "continues_slot_terminal" },
  integrity_stop: { hold: "retained", pilot: "sticky_stop" },
});
// Only capacity/terminal refusals may continue a pilot; policy violations are sticky.
export const LOOKUP_PRE_SEND_REFUSALS = Object.freeze(["not_admitted_input_envelope", "lookup_request_limit", "not_admitted_cap", "lookup_stopped", "lookup_slot_terminal"]);
export const LOOKUP_GUARD_POLICY_REFUSALS = Object.freeze([
  "lookup_route_mismatch", "lookup_contract_mismatch", "lookup_option_forbidden", "lookup_external_fetch_forbidden",
  "lookup_headers_forbidden", "lookup_env_forbidden", "lookup_payload_forbidden", "lookup_initial_reasoning_forbidden",
  "lookup_prompt_cache_key_forbidden", "lookup_retry_profile_forbidden", "lookup_auxiliary_callers_forbidden",
  "lookup_method_forbidden", "lookup_model_switch_forbidden", "lookup_preparation_forbidden", "lookup_tools_forbidden",
  "lookup_concurrent_request", "lookup_permit_missing", "lookup_assumptions_mismatch", "lookup_single_shot_send_required",
  "lookup_faux_permit_forbidden", "lookup_settlement_invalid", "lookup_cache_assignment_invalid",
  "lookup_native_identity_forbidden", "lookup_unguarded_dispatch", "lookup_payload_repeated", "lookup_pilot_capability_invalid",
]);
export class LookupGuardError extends Error {
  constructor(code, outcome = "refused_pre_send", classification = code, cause) {
    super(code, cause === undefined ? undefined : { cause }); this.code = code; this.outcome = outcome; this.classification = classification;
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

/** The pilot controller must call at entry and again in each child, on resolved settings (not CLI flags). */
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

/** Frozen wire contract: all calls may be async. The pilot controller owns durability/epoch/IPC.
 * admit({requestId,slotId,round,payloadDigest,rmax}) => opaque permit | {refused:true,code}
 * consume(permit,bodyDigest): once for a dispatched permit, before single-shot send.
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

// buildBaseOptions (pi-ai simple-options.js) plus runAgentLoop's spread config.
// Fetch is deliberately absent: only the constructor's single-shot send may send.
const REQUEST_OPTION_KEYS = new Set([
  "temperature", "samplingParams", "maxTokens", "signal", "telemetryContext", "apiKey",
  "transport", "cacheRetention", "sessionId", "headers", "onPayload", "onResponse",
  "onProviderStreamEvent", "timeoutMs", "websocketConnectTimeoutMs", "maxRetries",
  "maxRetryDelayMs", "metadata", "env", "reasoning", "model", "piMaxRetries",
  "convertToLlm", "toolExecution", "getSteeringMessages", "getFollowUpMessages",
  "prepareRequest", "beforeToolCall", "getApiKey",
]);
function assertIdentity(model, contract) {
  if (model?.provider !== contract.provider || (model?.id ?? model?.model) !== contract.model
    || (model.api !== undefined && model.api !== contract.api) || (model.baseUrl !== undefined && model.baseUrl !== contract.baseUrl)
    || (model.contextWindow !== undefined && model.contextWindow !== 272000)
    || (model.maxTokens !== undefined && model.maxTokens > 128000)) refuse("lookup_route_mismatch");
}
function assertRoute(model, options, contract) {
  if (Object.hasOwn(options, "fetch")) refuse("lookup_external_fetch_forbidden");
  for (const key of Object.keys(options)) if (!REQUEST_OPTION_KEYS.has(key)) refuse("lookup_option_forbidden");
  if (options.headers != null) {
    let count;
    try { count = [...new Headers(options.headers)].length; } catch { refuse("lookup_headers_forbidden"); }
    if (count) refuse("lookup_headers_forbidden");
  }
  if (options.env != null && (typeof options.env !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(options.env)) || Object.keys(options.env).length)) refuse("lookup_env_forbidden");
  assertIdentity(model, contract);
  if (model?.api !== contract.api || model?.baseUrl !== contract.baseUrl
    || options.reasoning !== contract.effort || options.transport !== "sse" || options.maxRetries !== 0
    || (options.piMaxRetries !== undefined && options.piMaxRetries !== 0)) refuse("lookup_route_mismatch");
  if (options.model !== undefined) assertIdentity(options.model, contract);
}
function keysOnly(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) refuse("lookup_payload_forbidden");
}
function textParts(parts, reasoning = false) {
  if (!Array.isArray(parts)) refuse("lookup_payload_forbidden");
  for (const part of parts) {
    keysOnly(part, reasoning ? ["type", "text"] : ["type", "text", "annotations"]);
    if (!(reasoning ? ["summary_text"] : ["input_text", "output_text"]).includes(part.type) || typeof part.text !== "string") refuse("lookup_payload_forbidden");
    if (part.annotations !== undefined && (!Array.isArray(part.annotations) || part.annotations.length)) refuse("lookup_payload_forbidden");
  }
}
function assertPayload(payload, round, contract) {
  keysOnly(payload, ["model", "store", "stream", "instructions", "input", "text", "include", "prompt_cache_key", "tool_choice", "parallel_tool_calls", "temperature", "service_tier", "tools", "reasoning"]);
  if (payload.model !== contract.model || payload.reasoning?.effort !== contract.effort || payload.store !== false || payload.stream !== true
    || payload.service_tier !== undefined || !Array.isArray(payload.input)) refuse("lookup_payload_forbidden");
  if ((contract.promptCacheKey !== undefined || Object.hasOwn(payload, "prompt_cache_key")) && payload.prompt_cache_key !== contract.promptCacheKey) refuse("lookup_prompt_cache_key_forbidden");
  keysOnly(payload.reasoning, ["effort", "summary"]);
  if (payload.text !== undefined) keysOnly(payload.text, ["verbosity"]);
  if (payload.include !== undefined && (!Array.isArray(payload.include) || payload.include.some(x => x !== "reasoning.encrypted_content"))) refuse("lookup_payload_forbidden");
  if (payload.instructions !== undefined && typeof payload.instructions !== "string") refuse("lookup_payload_forbidden");
  if (payload.tools !== undefined && !Array.isArray(payload.tools)) refuse("lookup_payload_forbidden");
  for (const tool of payload.tools ?? []) {
    keysOnly(tool, ["type", "name", "description", "parameters", "strict"]);
    if (tool.type !== "function") refuse("lookup_payload_forbidden");
  }
  for (const item of payload.input) {
    if (item?.type === "reasoning") {
      keysOnly(item, ["type", "id", "summary", "encrypted_content", "status", "content"]);
      if (round === 1) refuse("lookup_initial_reasoning_forbidden");
      if (item.summary !== undefined) textParts(item.summary, true);
      if (item.content != null) {
        if (!Array.isArray(item.content) || item.content.length > 1) refuse("lookup_payload_forbidden");
        for (const part of item.content) {
          keysOnly(part, ["type", "text"]);
          if (part.type !== "reasoning_text" || typeof part.text !== "string") refuse("lookup_payload_forbidden");
        }
      }
    } else if (item?.type === "function_call") {
      keysOnly(item, ["type", "id", "call_id", "name", "arguments", "namespace", "status"]);
      if (typeof item.arguments !== "string") refuse("lookup_payload_forbidden");
    } else if (item?.type === "function_call_output") {
      keysOnly(item, ["type", "call_id", "output", "id", "status"]);
      if (typeof item.output !== "string") refuse("lookup_payload_forbidden");
    } else {
      keysOnly(item, ["type", "role", "content", "id", "status", "phase"]);
      if (![undefined, "message"].includes(item.type) || !["system", "developer", "user", "assistant"].includes(item.role)) refuse("lookup_payload_forbidden");
      if (typeof item.content !== "string") textParts(item.content);
    }
  }
}
const count = n => Number.isSafeInteger(n) && n >= 0;
export function lookupSettledCost(usage, tier) {
  const cached = usage.input_tokens_details?.cached_tokens ?? 0, written = usage.input_tokens_details?.cache_write_tokens ?? 0;
  // Accumulate integer tenths-of-a-microdollar; return floating-point dollars.
  const tenths = (usage.input_tokens - cached - written) * 20 + cached + written * 25 + usage.output_tokens * 100;
  return tenths * (tier === "flex" ? 0.5 : tier === "default" ? 1 : 2) / 10000000;
}

// Only this factory may brand a configured-pilot decorator. No public registration seam.
const pilotDecorators = new WeakSet();
export const isFauxLookupDecorator = value => pilotDecorators.has(value);
export async function createFauxLookupDecorator(options) {
  const bindings = { ...options, contract: Object.freeze({ ...options.contract }), permit: Object.freeze({ ...options.permit, pilot: true }) };
  if (bindings.permit.testOnly !== true) refuse("lookup_faux_permit_forbidden");
  if (!lookupCacheKey(bindings.contract.promptCacheKey)) refuse("lookup_prompt_cache_key_forbidden");
  assertResolvedLookupSafety(bindings.resolvedSafety);
  // A private serializer instance has only fictional in-memory OAuth data. Never
  // delegate to the configured Models or its credential store, even for auth.
  const sdk = new URL("../../packages/turn/node_modules/@earendil-works/pi-ai/", import.meta.url);
  const pkg = JSON.parse(await readFile(new URL("package.json", sdk), "utf8"));
  const entry = pkg.exports?.["."]?.import, providerEntry = pkg.exports?.["./providers/*"]?.import;
  if (typeof entry !== "string" || typeof providerEntry !== "string") refuse("lookup_unguarded_dispatch");
  const [pi, providers] = await Promise.all([import(new URL(entry, sdk).href), import(new URL(providerEntry.replace("*", "openai-codex"), sdk).href)]);
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url"), credentials = new pi.InMemoryCredentialStore();
  const access = `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "FAKE-TEST-ACCOUNT-NOT-REAL" } })}.FAKE-TEST-SIGNATURE`;
  await credentials.modify(LOOKUP_GUARD_CONTRACT.provider, () => ({ type: "oauth", refresh: "FAKE-TEST-REFRESH-NOT-REAL", expires: Number.MAX_SAFE_INTEGER, access }));
  const serializer = pi.createModels({ credentials }); serializer.setProvider(providers.openaiCodexProvider());
  const local = {
    getModel: serializer.getModel.bind(serializer), getProvider: serializer.getProvider.bind(serializer),
    getAuth: (model, overrides) => serializer.getAuth(model, { ...overrides, apiKey: access }),
    streamSimple: (model, context, options) => serializer.streamSimple(model, context, { ...options, apiKey: access }),
  };
  const wrapped = guardedLookupModels(local, bindings);
  const decorator = Object.freeze(_configuredModels => {
    if (!pilotDecorators.delete(decorator)) refuse("lookup_unguarded_dispatch");
    return wrapped;
  }); pilotDecorators.add(decorator); return decorator;
}

/** One wrapper per sequential probe run. Never share it between slots. No default fetch. */
export function guardedLookupModels(models, { contract, permit, send, assumptions = LOOKUP_ASSUMPTIONS, resolvedSafety }) {
  if (JSON.stringify(assumptions) !== JSON.stringify(LOOKUP_ASSUMPTIONS)) refuse("lookup_assumptions_mismatch");
  for (const key of ["provider", "model", "api", "baseUrl", "effort", "version"])
    if (contract?.[key] !== LOOKUP_GUARD_CONTRACT[key]) refuse("lookup_contract_mismatch");
  if (!contract.slotId || !contract.runId || contract.piMaxRetries !== 0 || contract.maxRetries !== 0) refuse("lookup_contract_mismatch");
  for (const key of ["piRequestRetryBudgetMs", "retryBudgetMs", "retryProfile", "retry"])
    if (Object.hasOwn(contract, key)) refuse("lookup_retry_profile_forbidden");
  const pilotSource = permit?.pilot === true || permit?.testOnly !== true;
  if (pilotSource && !lookupCacheKey(contract.promptCacheKey)) refuse("lookup_prompt_cache_key_forbidden");
  if (pilotSource && !resolvedSafety) refuse("lookup_auxiliary_callers_forbidden");
  if (Object.hasOwn(contract, "promptCacheKey") && !lookupCacheKey(contract.promptCacheKey)) refuse("lookup_prompt_cache_key_forbidden");
  if (resolvedSafety) assertResolvedLookupSafety(resolvedSafety);
  if (permit?.testOnly !== true || isRealLookupSend(send)) {
    assertRealLookupPermitSource(permit);
    if (!realLookupSendForGuard(send, permit, contract)) refuse("lookup_pilot_capability_invalid");
  }
  if (typeof send !== "function") refuse("lookup_single_shot_send_required");
  contract = Object.freeze({ ...contract });
  assumptions = LOOKUP_ASSUMPTIONS;
  const outputs = []; let rounds = 0, active = false, stopped = false, slotTerminal = false, finalizationBlocked = false;
  async function stopWithError(code, cause) {
    stopped = true;
    try { await permit.stop(code); }
    catch (ipcError) {
      const error = new LookupGuardError(code, "integrity_stop", code, ipcError);
      error.stopCode = "lookup_stop_failed";
      if (cause !== undefined) error.settleCause = cause;
      throw error;
    }
    throw new LookupGuardError(code, "integrity_stop", code, cause);
  }
  function streamSimple(model, context, options = {}) {
    if (stopped) refuse("lookup_stopped");
    if (active) refuse("lookup_concurrent_request");
    if (slotTerminal) refuse("lookup_slot_terminal");
    if (finalizationBlocked) refuse("pilot_empty_final_output", "failed/pilot_empty_final_output");
    if (rounds >= 10) refuse("lookup_request_limit");
    if (resolvedSafety) assertResolvedLookupSafety(resolvedSafety);
    assertRoute(model, options, contract);
    const round = rounds + 1;
    let admitted, admittedPayloadDigest, earlyStop, sent = false, fetchEntered = false, raw, tier, envelope, payloadSeen = false, terminalSeen = false, preRefusal, integrity;
    active = true;
    const finish = async (message, failure) => {
      try {
        if (earlyStop) await earlyStop;
        if (admitted) {
          let code, outcome = "lost", cost;
          if (integrity) { outcome = "integrity_stop"; code = integrity; }
          else if (raw) {
            if (tier != null && !["default", "flex", "priority"].includes(tier)) code = "lookup_unknown_tier";
            else if (raw.input_tokens > envelope.U) code = "lookup_input_envelope_violated";
            else if (raw.output_tokens > assumptions.outputMax) code = "lookup_output_envelope_violated";
            else if ((raw.output_tokens_details?.reasoning_tokens ?? 0) > raw.output_tokens) code = "lookup_reasoning_envelope_violated";
            else { cost = lookupSettledCost(raw, tier); if (cost > assumptions.rmax) code = "lookup_hold_exceeded"; }
            outcome = code ? "integrity_stop" : failure ? (sent && options.signal?.aborted ? "own_abort_after_send" : "lost") : "settled";
          } else if (sent && options.signal?.aborted) outcome = "own_abort_after_send";
          if (outcome !== "settled") slotTerminal = true;
          try {
            await permit.settle(admitted, { kind: outcome, ...(code ? { code } : {}), ...(cost !== undefined ? { cost } : {}) }, raw ?? null, ["default", "flex", "priority"].includes(tier) ? tier : null);
          } catch (cause) {
            slotTerminal = true;
            await stopWithError("lookup_settlement_failed", cause);
          }
          if (outcome === "settled") outputs.push(raw.output_tokens);
          if (outcome === "integrity_stop") await stopWithError(code);
        }
        if (message && (message.stopReason === "length" || (message.stopReason === "stop" && !(message.content ?? []).some(p => p.type === "text" && p.text?.trim())))) finalizationBlocked = true;
        if (preRefusal) throw preRefusal;
        if (failure) throw failure;
        return message;
      } finally { active = false; }
    };
    const wrapped = { ...options, ...(contract.promptCacheKey === undefined ? {} : { sessionId: contract.promptCacheKey }),
      onPayload: async (payload, selected) => {
        try {
          if (payloadSeen) { if (admitted) integrity = "lookup_payload_repeated"; refuse("lookup_payload_repeated"); } payloadSeen = true;
          const mutated = await options.onPayload?.(payload, selected) ?? payload;
          // Snapshot once: accessors/toJSON cannot change between sizing and digesting.
          const final = JSON.parse(JSON.stringify(mutated));
          if (resolvedSafety) assertResolvedLookupSafety(resolvedSafety);
          assertPayload(final, round, contract);
          envelope = lookupInputEnvelope(final, outputs, assumptions);
          if (envelope.U > assumptions.inputMax) refuse("not_admitted_input_envelope");
          const payloadDigest = lookupBodyDigest(Buffer.from(JSON.stringify(final)));
          const grant = await permit.admit({ requestId: `${contract.runId}:${round}`, slotId: contract.slotId, round, payloadDigest, rmax: assumptions.rmax });
          if (grant?.refused) refuse(grant.code ?? "not_admitted_cap");
          if (!grant) refuse("lookup_permit_missing");
          admitted = grant; admittedPayloadDigest = payloadDigest; rounds++;
          // Detach from all mutation hooks; fetch verifies these exact serialized bytes.
          return JSON.parse(JSON.stringify(final));
        } catch (error) { preRefusal = error; throw error; }
      },
      fetch: async (url, init) => {
        if (!admitted) {
          integrity = "lookup_permit_invalid";
          earlyStop ??= stopWithError(integrity);
          return await earlyStop;
        }
        if (fetchEntered) { integrity = "lookup_permit_invalid"; throw new LookupGuardError(integrity); }
        fetchEntered = true;
        let headers;
        try { headers = new Headers(init?.headers); }
        catch (cause) { integrity = "lookup_headers_forbidden"; throw new LookupGuardError(integrity, undefined, undefined, cause); }
        const allowedHeaders = new Set(["originator", "user-agent", "authorization", "chatgpt-account-id", "openai-beta",
          "accept", "content-type", "session-id", "x-client-request-id", "content-encoding"]);
        if ([...headers.keys()].some(name => !allowedHeaders.has(name))) {
          integrity = "lookup_headers_forbidden"; throw new LookupGuardError(integrity);
        }
        for (const key of ["session-id", "x-client-request-id"]) {
          if ((contract.promptCacheKey !== undefined || headers.has(key)) && headers.get(key) !== contract.promptCacheKey) {
            integrity = "lookup_prompt_cache_key_forbidden"; throw new LookupGuardError(integrity);
          }
        }
        const encoding = headers.get("content-encoding");
        if (String(url) !== `${contract.baseUrl}/codex/responses` || init?.method !== "POST" || ![null, "zstd"].includes(encoding)) {
          integrity = "lookup_send_mismatch"; throw new LookupGuardError(integrity);
        }
        try {
          const bytes = encoding === "zstd" ? zstdDecompressSync(init.body) : Buffer.from(init.body);
          const bodyDigest = lookupBodyDigest(bytes);
          if (bodyDigest !== admittedPayloadDigest) {
            integrity = "lookup_body_mismatch"; throw new LookupGuardError(integrity);
          }
          await permit.consume(admitted, bodyDigest);
        } catch (error) { integrity ??= "lookup_permit_invalid"; throw error; }
        if (integrity) throw new LookupGuardError(integrity);
        sent = true;
        return send(url, init);
      },
      onProviderStreamEvent: async (event, selected) => {
        if (event?.type === "response.failed") {
          raw = undefined; tier = event.response?.service_tier;
          if (tier != null && !["default", "flex", "priority"].includes(tier)) integrity = "lookup_unknown_tier";
        }
        if (["response.completed", "response.incomplete"].includes(event?.type)) {
          const usage = event.response?.usage;
          tier = event.response?.service_tier;
          if (tier != null && !["default", "flex", "priority"].includes(tier)) integrity = "lookup_unknown_tier";
          if (terminalSeen) integrity = "lookup_duplicate_terminal";
          terminalSeen = true;
          if (usage && Object.hasOwn(usage, "input_tokens") && (!count(usage.input_tokens) || usage.input_tokens < 1)) integrity = "lookup_invalid_usage";
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
    if (typeof key === "symbol" || key === "then" || key === "toJSON") return undefined;
    if (key === "streamSimple") return streamSimple;
    // Metadata/auth only; never expose a provider object capable of dispatch.
    if (key === "getModel" || key === "getAuth") return target[key].bind(target);
    if (key === "getProvider") return id => target.getProvider(id) ? Object.freeze({ id }) : undefined;
    if (["stream", "complete", "completeSimple", "streamDeferred", "fetchDeferred", "cancelDeferred", "setProvider"].includes(key) || typeof target[key] === "function")
      return () => refuse("lookup_method_forbidden", "failed/pilot_method_forbidden");
    return undefined;
  } });
}
