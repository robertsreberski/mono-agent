// Shared guarded-run mechanics. Historical authority identifiers remain visible to the exact source inventory.
import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { guardedAccounting } from "./continuity-guarded-accounting.mjs";
import { guardedRealCapability, isAnyGuardedRealSend } from "./continuity-guarded-real-capability.mjs";
import { guardedProtocol } from "./continuity-guarded-protocols.mjs";
const instances = new Map();
export function guardedModels(protocolId) {
  const protocol = guardedProtocol(protocolId);
  if (!instances.has(protocol)) instances.set(protocol, bind(protocol, protocolId));
  return instances.get(protocol);
}
function bind(protocol, protocolId) {
  const LOOKUP_ASSUMPTIONS = protocol.policy.ASSUMPTIONS, LOOKUP_GUARD_CONTRACT = protocol.policy.GUARD_CONTRACT, LookupGuardError = protocol.Error;
  const { assertResolvedSafety: assertResolvedLookupSafety, cacheKey: lookupCacheKey, bodyBytes: lookupBodyBytes, assertRoute, assertPayload } = protocol.hooks;
  const { realLookupSendForGuard } = guardedRealCapability(protocolId);
  const lookupSettledCost = guardedAccounting(protocolId).settledCost;
  const refuse = (code, classification) => { throw new LookupGuardError(code, "refused_pre_send", classification); };
  const lookupBodyDigest = bytes => createHash("sha256").update(bytes).digest("hex");
  function properties(value) {
    if (!value || typeof value !== "object") return 0;
    return (value.properties ? Object.keys(value.properties).length : 0) + Object.values(value).reduce((n, v) => n + properties(v), 0);
  }
  function lookupInputEnvelope(payload, settledOutputTokens = [], assumptions = LOOKUP_ASSUMPTIONS) {
    const h = assumptions.framing;
    const input = payload.input ?? [], tools = payload.tools ?? [];
    const H = h.base + input.length * h.inputItem + input.filter(x => x.type === "reasoning").length * h.reasoningItem
      + tools.length * h.tool + properties(tools) * h.schemaProperty + (Object.hasOwn(payload, "instructions") ? h.instructions : 0);
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    return { bytes, H, U: bytes + settledOutputTokens.reduce((a, b) => a + b, 0) + H };
  }
  function assertRealLookupPermitSource(source) {
    if (!source || source.testOnly !== false || source.brand !== protocol.permitBrand) refuse(protocol.codes.faux_permit_forbidden);
  }
  function createTestOnlyLookupPermitSource() {
    const states = new Map(), events = []; let stopped = false;
    return Object.freeze({ brand: protocol.fauxBrand, testOnly: true, events,
      admit(request) {
        if (stopped) return { refused: true, code: protocol.codes.stopped };
        const permit = Object.freeze({ ...request }); states.set(permit, { used: false, settled: false });
        events.push({ type: "admit", ...request }); return permit;
      },
      consume(permit, bodyDigest) {
        const state = states.get(permit);
        if (stopped || !state || state.used || state.settled || permit.payloadDigest !== bodyDigest) refuse(protocol.codes.permit_invalid);
        state.used = true; events.push({ type: "consume", requestId: permit.requestId });
      },
      settle(permit, outcome, rawUsage, tier) {
        const state = states.get(permit);
        if (!state || state.settled) refuse(protocol.codes.settlement_invalid);
        state.settled = true; events.push({ type: "settle", requestId: permit.requestId, outcome, rawUsage, tier });
      },
      stop(code) { stopped = true; events.push({ type: "stop", code }); },
    });
  }
  const count = n => Number.isSafeInteger(n) && n >= 0;
  function guardedLookupModels(models, { contract, permit, send, assumptions = LOOKUP_ASSUMPTIONS, resolvedSafety, onForwarded }) {
    if (JSON.stringify(assumptions) !== JSON.stringify(LOOKUP_ASSUMPTIONS)) refuse(protocol.codes.assumptions_mismatch);
    if (protocol.execution) protocol.execution.contract(contract);
    else for (const key of ["provider", "model", "api", "baseUrl", "effort", "version"])
      if (contract?.[key] !== LOOKUP_GUARD_CONTRACT[key]) refuse(protocol.codes.contract_mismatch);
    if (!contract.slotId || !contract.runId || contract.piMaxRetries !== 0 || contract.maxRetries !== 0) refuse(protocol.codes.contract_mismatch);
    for (const key of ["piRequestRetryBudgetMs", "retryBudgetMs", "retryProfile", "retry"])
      if (Object.hasOwn(contract, key)) refuse(protocol.codes.retry_profile_forbidden);
    const pilotSource = permit?.pilot === true || permit?.testOnly !== true;
    if (pilotSource && !lookupCacheKey(contract.promptCacheKey)) refuse(protocol.codes.prompt_cache_key_forbidden);
    if (pilotSource && !resolvedSafety) refuse(protocol.codes.auxiliary_callers_forbidden);
    if (Object.hasOwn(contract, "promptCacheKey") && !lookupCacheKey(contract.promptCacheKey)) refuse(protocol.codes.prompt_cache_key_forbidden);
    if (resolvedSafety) assertResolvedLookupSafety(resolvedSafety);
    if (permit?.testOnly !== true || isAnyGuardedRealSend(send)) {
      assertRealLookupPermitSource(permit);
      if (!realLookupSendForGuard(send, permit, contract)) refuse(protocol.codes.pilot_capability_invalid);
    }
    if (typeof send !== "function") refuse(protocol.codes.single_shot_send_required);
    if (onForwarded !== undefined && typeof onForwarded !== "function") refuse(protocol.codes.pilot_capability_invalid);
    contract = Object.freeze({ ...contract });
    assumptions = LOOKUP_ASSUMPTIONS;
    const outputs = []; let rounds = 0, active = false, stopped = false, slotTerminal = false, finalizationBlocked = false;
    async function stopWithError(code, cause) {
      stopped = true;
      try { await permit.stop(code); }
      catch (ipcError) {
        const error = new LookupGuardError(code, "integrity_stop", code, ipcError);
        error.stopCode = protocol.codes.stop_failed;
        if (cause !== undefined) error.settleCause = cause;
        throw error;
      }
      throw new LookupGuardError(code, "integrity_stop", code, cause);
    }
    function streamSimple(model, context, options = {}) {
      if (stopped) refuse(protocol.codes.stopped);
      if (active) refuse(protocol.codes.concurrent_request);
      if (slotTerminal) refuse(protocol.codes.slot_terminal);
      if (finalizationBlocked) refuse("pilot_empty_final_output", "failed/pilot_empty_final_output");
      if (rounds >= protocol.requestLimit) refuse(protocol.codes.request_limit);
      if (resolvedSafety) assertResolvedLookupSafety(resolvedSafety);
      assertRoute(model, options, contract);
      const funding = protocol.execution?.guardRequest(contract, context);
      if (funding && rounds) refuse(protocol.codes.request_limit);
      const round = funding ? contract.e2.round : rounds + 1;
      const payloads = [];
      let admitted, admittedPayloadDigest, earlyStop, sent = false, fetchEntered = false, raw, tier, envelope, payloadSeen = false, terminalSeen = false, preRefusal, integrity, finishing = false;
      active = true;
      const finish = async (message, failure) => {
        finishing = true;
        try {
          // Every finish (success or failure) drains already-started payload/admission work.
          if (payloads.length) await Promise.allSettled(payloads);
          if (earlyStop) try { await earlyStop; } catch (error) { failure ??= error; }
          if (admitted) {
            let code, outcome = "lost", cost;
            if (integrity) { outcome = "integrity_stop"; code = integrity; }
            else if (raw) {
              if (tier != null && !["default", "flex", "priority"].includes(tier)) code = protocol.codes.unknown_tier;
              else if (raw.input_tokens > envelope.U) code = protocol.codes.input_envelope_violated;
              else if (raw.output_tokens > (funding?.outputMax ?? assumptions.outputMax)) code = protocol.codes.output_envelope_violated;
              else if ((raw.output_tokens_details?.reasoning_tokens ?? 0) > raw.output_tokens) code = protocol.codes.reasoning_envelope_violated;
              else if (funding) { cost = protocol.execution.priceUsage(raw, tier, funding); if (BigInt(cost) > BigInt(funding.reservationUnits)) code = protocol.codes.hold_exceeded; }
              else { cost = lookupSettledCost(raw, tier); if (cost > assumptions.rmax) code = protocol.codes.hold_exceeded; }
              outcome = code ? "integrity_stop" : failure ? (sent && options.signal?.aborted ? "own_abort_after_send" : "lost") : "settled";
            } else if (sent && options.signal?.aborted) outcome = "own_abort_after_send";
            let evidence;
            if (funding && outcome === "settled") {
              try { const recorded = await protocol.execution.resultReceipt(contract, message, raw, tier, admittedPayloadDigest); message = recorded.message; evidence = recorded.evidence; }
              catch { outcome = "integrity_stop"; code = protocol.codes.summary_receipt_invalid; }
            }
            if (outcome !== "settled") slotTerminal = true;
            try {
              await permit.settle(admitted, { kind: outcome, ...(code ? { code } : {}), ...(cost !== undefined ? funding ? { costUnits: cost } : { cost } : {}) }, raw ?? null, ["default", "flex", "priority"].includes(tier) ? tier : null, ...(evidence === undefined ? [] : [evidence]));
            } catch (cause) {
              slotTerminal = true;
              await stopWithError(protocol.codes.settlement_failed, cause);
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
      const refuseFinishing = () => {
        integrity = protocol.codes.permit_invalid;
        earlyStop ??= stopWithError(integrity); void earlyStop.catch(() => {});
        return earlyStop;
      };
      const wrapped = { ...options, ...(contract.promptCacheKey === undefined ? {} : { sessionId: contract.promptCacheKey }),
        onPayload: (payload, selected) => {
          const pending = (async () => {
            try {
              if (finishing) return await refuseFinishing();
              if (payloadSeen) { if (admitted) integrity = protocol.codes.payload_repeated; refuse(protocol.codes.payload_repeated); } payloadSeen = true;
              const mutated = options.onPayload ? await options.onPayload(payload, selected) ?? payload : payload;
              if (finishing) return await refuseFinishing();
              // Snapshot once: accessors/toJSON cannot change between sizing and digesting.
              const final = JSON.parse(JSON.stringify(mutated));
              if (resolvedSafety) assertResolvedLookupSafety(resolvedSafety);
              assertPayload(final, round, contract);
              envelope = funding ? { U: funding.inputMax } : lookupInputEnvelope(final, outputs, assumptions);
              if (envelope.U > (funding?.inputMax ?? assumptions.inputMax)) refuse("not_admitted_input_envelope");
              const payloadDigest = lookupBodyDigest(Buffer.from(JSON.stringify(final)));
              const grant = await permit.admit(funding ? { ...funding.request, payloadDigest } : { requestId: `${contract.runId}:${round}`, slotId: contract.slotId, round, payloadDigest, rmax: assumptions.rmax });
              if (grant?.refused) refuse(grant.code ?? "not_admitted_cap");
              if (!grant) refuse(protocol.codes.permit_missing);
              admitted = grant; admittedPayloadDigest = payloadDigest; rounds++;
              // Detach from all mutation hooks; fetch verifies these exact serialized bytes.
              return JSON.parse(JSON.stringify(final));
            } catch (error) { preRefusal = error; throw error; }
          })();
          payloads.push(pending); void pending.catch(() => {}); return pending;
        },
        fetch: async (url, init) => {
          if (finishing) return await refuseFinishing();
          if (!admitted) {
            integrity = protocol.codes.permit_invalid;
            earlyStop ??= stopWithError(integrity);
            return await earlyStop;
          }
          if (fetchEntered) { integrity = protocol.codes.permit_invalid; throw new LookupGuardError(integrity); }
          fetchEntered = true;
          let headers;
          try { headers = new Headers(init?.headers); }
          catch (cause) { integrity = protocol.codes.headers_forbidden; throw new LookupGuardError(integrity, undefined, undefined, cause); }
          const allowedHeaders = new Set(["originator", "user-agent", "authorization", "chatgpt-account-id", "openai-beta",
            "accept", "content-type", "session-id", "x-client-request-id", "content-encoding"]);
          if ([...headers.keys()].some(name => !allowedHeaders.has(name))) {
            integrity = protocol.codes.headers_forbidden; throw new LookupGuardError(integrity);
          }
          if (protocol.execution?.assertCacheHeaders) {
            try { protocol.execution.assertCacheHeaders(headers, contract.e2, contract.promptCacheKey); }
            catch (cause) { integrity = protocol.codes.prompt_cache_key_forbidden; throw new LookupGuardError(integrity, undefined, undefined, cause); }
          }
          else for (const key of ["session-id", "x-client-request-id"]) {
            if ((contract.promptCacheKey !== undefined || headers.has(key)) && headers.get(key) !== contract.promptCacheKey) {
              integrity = protocol.codes.prompt_cache_key_forbidden; throw new LookupGuardError(integrity);
            }
          }
          const encoding = headers.get("content-encoding");
          if (String(url) !== `${contract.baseUrl}/codex/responses` || init?.method !== "POST" || ![null, "zstd"].includes(encoding)) {
            integrity = protocol.codes.send_mismatch; throw new LookupGuardError(integrity);
          }
          try {
            init = {...init, body: lookupBodyBytes(init.body)};
            const bytes = encoding === "zstd" ? zstdDecompressSync(init.body) : init.body;
            const bodyDigest = lookupBodyDigest(bytes);
            if (bodyDigest !== admittedPayloadDigest) {
              integrity = protocol.codes.body_mismatch; throw new LookupGuardError(integrity);
            }
            await permit.consume(admitted, bodyDigest);
          } catch (error) { integrity ??= error.code === protocol.codes.body_type_forbidden ? error.code : protocol.codes.permit_invalid; throw error; }
          if (finishing) return await refuseFinishing();
          if (integrity) throw new LookupGuardError(integrity);
          sent = true;
          // Content-free witness of the forwarded context: synchronous, after the
          // persisted consume and before the one send; it can never skip or alter it.
          try {
            const observed = onForwarded?.(context, round);
            if (observed !== null && (typeof observed === "object" || typeof observed === "function") && typeof observed.then === "function") Promise.resolve(observed).catch(() => {});
          } catch { /* Observation only. */ }
          try { return await send(url, init); }
          catch (error) {
            if (error?.outcome === "integrity_stop" && protocol.policy.INTEGRITY_STOPS.includes(error.code)) integrity = error.code;
            throw error;
          }
        },
        onProviderStreamEvent: async (event, selected) => {
          if (event?.type === "response.failed") {
            raw = undefined; tier = event.response?.service_tier;
            if (tier != null && !["default", "flex", "priority"].includes(tier)) integrity = protocol.codes.unknown_tier;
          }
          if (["response.completed", "response.incomplete"].includes(event?.type)) {
            const usage = event.response?.usage;
            tier = event.response?.service_tier;
            if (tier != null && !["default", "flex", "priority"].includes(tier)) integrity = protocol.codes.unknown_tier;
            if (terminalSeen) integrity = protocol.codes.duplicate_terminal;
            terminalSeen = true;
            if (usage && Object.hasOwn(usage, "input_tokens") && (!count(usage.input_tokens) || usage.input_tokens < 1)) integrity = protocol.codes.invalid_usage;
            if (sent && count(usage?.input_tokens) && count(usage?.output_tokens)) {
              const details = usage.input_tokens_details;
              if (![details?.cached_tokens ?? 0, details?.cache_write_tokens ?? 0, usage.output_tokens_details?.reasoning_tokens ?? 0].every(count)
                || (details?.cached_tokens ?? 0) + (details?.cache_write_tokens ?? 0) > usage.input_tokens) integrity = protocol.codes.invalid_usage;
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
      let observed;
      try { observed = Promise.resolve(source.result()); }
      catch (error) { observed = Promise.reject(error); }
      const result = observed.then(m => finish(m), e => finish(undefined, e));
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
        return () => refuse(protocol.codes.method_forbidden, "failed/pilot_method_forbidden");
      return undefined;
    } });
  }
  return Object.freeze({ lookupBodyDigest, lookupInputEnvelope, assertRealLookupPermitSource, createTestOnlyLookupPermitSource, guardedLookupModels });
}
