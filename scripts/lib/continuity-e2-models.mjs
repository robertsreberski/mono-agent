import { isE2ProtectionRefusal } from "./continuity-e2-compaction.mjs";
import { assertE2BaselineRequest } from "./continuity-e2-lineage.mjs";
// The only inference boundary in C1 is Pi's in-process faux provider.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fail } from "./continuity-observation-input.mjs";
import { digest } from "./continuity-recorded-schema.mjs";
import { assertE2ProbeLookupRounds, e2ReplayArm } from "./continuity-e2-protocol.mjs";
import { assertE2PhaseAdapter } from "./continuity-e2-runtime.mjs";

import { FACT, NEXT_ACTION } from "./continuity-e2-tools.mjs";

const paidDecorators = new WeakSet();
export const isE2PaidDecorator = value => paidDecorators.has(value);
export async function loadE2Estimators() {
  if (!existsSync(new URL("../../packages/turn/dist/agent/compaction.js", import.meta.url))) fail("E2_ESTIMATOR_BUILD_REQUIRED");
  try {
    const [{ estimateFixedOverheadTokens, resolveAgentCompactionPolicy }, engine] = await Promise.all([
      import(new URL("../../packages/turn/dist/agent/compaction.js", import.meta.url).href), import("@mono-agent/turn/engine"),
    ]);
    if (typeof estimateFixedOverheadTokens !== "function" || typeof resolveAgentCompactionPolicy !== "function" || typeof engine.estimateTokens !== "function") throw Error();
    return { estimateFixedOverheadTokens, resolveAgentCompactionPolicy, estimateTokens: engine.estimateTokens };
  } catch { fail("E2_ESTIMATOR_BUILD_REQUIRED"); }
}
export function sizeContext(context, estimators) {
  const serializedBytes = Buffer.byteLength(JSON.stringify(context));
  // Do not inherit stale faux/provider usage: estimate every actual message.
  const transcript = (context.messages ?? []).reduce((n, message) => n + estimators.estimateTokens(message), 0);
  const systemMessages = (context.messages ?? []).filter(m => m.role === "system");
  const systemPrompt = [context.systemPrompt, ...systemMessages.map(m => m.content)].filter(v => typeof v === "string").join("\n\n");
  const tools = [...(context.tools ?? []), ...systemMessages.flatMap(m => m.toolsAdded ?? [])];
  const overhead = estimators.estimateFixedOverheadTokens({ systemPrompt, tools });
  const engineFullRequest = transcript + overhead.fixedOverheadTokens;
  return { method: "intercepted-full-models-context", serializedBytes, serializedBytesOver3: Math.ceil(serializedBytes / 3), engineFullRequest,
    maximum: Math.max(Math.ceil(serializedBytes / 3), engineFullRequest), usage: "engine-estimate-not-provider-measurement" };
}
export async function shippingSoul() {
  const raw = await readFile(new URL("../../packages/conversation/src/context/default-soul.ts", import.meta.url), "utf8");
  const match = /^export const DEFAULT_SOUL_TEXT = `([^`]*)`;\s*$/s.exec(raw);
  if (!match) fail("E2_SOUL_MISMATCH");
  const text = match[1], normalized = text.replace(/\r\n/g, "\n").trim();
  // Deliberate pin: updating shipping guidance requires explicitly reviewing E2.
  if (digest(raw) !== SHIPPING_SOUL_RAW || digest(normalized) !== SHIPPING_SOUL_NORMALIZED) fail("E2_SOUL_MISMATCH");
  return { text, rawDigest: digest(raw), normalizedDigest: digest(normalized) };
}
export const SHIPPING_SOUL_RAW = "a1050836c51d4492977078f95bc96c297c9b5c48a2f1867037c158d73e7f9270";
export const SHIPPING_SOUL_NORMALIZED = "e625bc0ddb256f336ec66bf94335d260396fa2c5139e37d44f8e0370fef808a9";
export function assertEffectiveSoul(context, soul) {
  const header = "## Core Guardrails\n\n";
  const candidates = [context.systemPrompt, ...(context.messages ?? []).filter(m => m.role === "system").map(m => m.content)]
    .filter(v => typeof v === "string" && v.startsWith(header));
  if (!candidates.length || candidates.some(prompt => prompt.split("\n\n## ")[0] !== `${header}${soul.text}`)) fail("E2_SOUL_MISMATCH");
}
export function estimatedReply(pi, text, context, estimators, extra = {}) {
  const input = sizeContext(context, estimators).engineFullRequest;
  const output = estimators.estimateTokens({ role: "assistant", content: typeof text === "string" ? [{ type: "text", text }] : text });
  return pi.fauxAssistantMessage(text, { ...extra, usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
}

/** A lifecycle receipt is established by runtime events, not prompt contents. */
export function createE2Models({ pi, estimators, models, limits, summary = "faux-short", sourceReply, sourceContext = () => {}, soul, paidAdapter, probeLookupRounds, replayArm, sourceTools, onRequest = () => {} }) {
  if (probeLookupRounds !== undefined) assertE2ProbeLookupRounds(probeLookupRounds);
  if (summary === "real") assertE2PhaseAdapter(paidAdapter);
  else if (paidAdapter !== undefined) fail("E2_SUMMARY_ROUTE_INVALID");
  if (!["faux-short", "faux-max", "faux-faithful", "real"].includes(summary)) fail("E2_SUMMARY_ROUTE_INVALID");
  const baseline = e2ReplayArm(replayArm) === "baseline";
  const registered = new Set(models.map(m => m.model)), faux = new Map(), lifecycle = new Map();
  const report = { sourceRequests: 0, probeRequests: 0, summaryRequests: [], compactions: [], ...(summary === "real" ? { compactionRefusals: [] } : {}), requestSizing: [] };
  let position = null, sticky = null, positionRequests = 0;
  const refuse = code => { sticky ??= code; fail(sticky); };
  const check = () => { if (sticky) fail(sticky); };
  const sourceCodes = new Set(["E2_SOURCE_REQUEST_LIMIT", "E2_TOOL_CALL_MISMATCH", "E2_STEER_INVALID", "E2_STEER_REFUSED", "E2_STEER_NOT_DELIVERED"]);
  const keyOf = model => `${model?.provider}:${model?.id}`;
  function backend(model) {
    const key = keyOf(model);
    if (!registered.has(key)) refuse("E2_MODEL_UNREGISTERED");
    if (!faux.has(key)) {
      const provider = pi.fauxProvider({ provider: model.provider, api: `continuity-e2-${model.id}`, tokensPerSecond: undefined,
        models: [{ id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning }] });
      const collection = pi.createModels(); collection.setProvider(provider.provider);
      faux.set(key, { provider, collection, model: provider.getModel(model.id) });
    }
    return faux.get(key);
  }
  function validateModel(model, target) {
    if (keyOf(model) !== position?.model || !registered.has(keyOf(model))) refuse("E2_MODEL_UNREGISTERED");
    const catalog = target.getModel(model.provider, model.id);
    if (!catalog || ["provider", "id", "api", "baseUrl", "contextWindow", "maxTokens", "reasoning"].some(k => model[k] !== catalog[k])) refuse("E2_MODEL_UNREGISTERED");
  }
  const route = {
    setPosition(value) { check(); position = { ...value }; positionRequests = 0; paidAdapter?.setPosition(value); },
    observe(event) {
      check();
      if (event?.type !== "context_compaction") return;
      try { paidAdapter?.observe(event); }
      catch { refuse("E2_COMPACTION_LIFECYCLE_INVALID"); }
      if (event.status === "running") {
        if (!event.operationId || lifecycle.size || report.compactions.length + (report.compactionRefusals?.length ?? 0) >= limits.compactions) refuse("E2_COMPACTION_LIMIT");
        lifecycle.set(event.operationId, { ...position, trigger: event.trigger, requests: 0 });
      } else {
        const receipt = lifecycle.get(event.operationId);
        if (!receipt) refuse("E2_COMPACTION_LIFECYCLE_INVALID");
        lifecycle.delete(event.operationId);
        const rejected = summary === "real" && isE2ProtectionRefusal(event);
        if (event.status !== "succeeded" && !rejected) refuse("E2_COMPACTION_NOT_DURABLE");
        if (!receipt.requests) refuse("E2_COMPACTION_LIFECYCLE_INVALID");
        (rejected ? report.compactionRefusals : report.compactions).push({ turn: receipt.turn, message: receipt.message, trigger: receipt.trigger, requests: receipt.requests, durable: !rejected, ...(rejected ? { rejected: true, reason: event.reason } : {}),
          policy: Object.fromEntries(["contextWindow", "triggerTokens", "keepRecentTokens", "summaryMaxTokens", "compactionMinSavingsTokens"].map(k => [k, Number.isFinite(event.accounting?.policy?.[k]) ? event.accounting.policy[k] : null])) });
      }
    },
    decorator(target) {
      return new Proxy(target, { get(original, method) {
        if (method === "getModel") return (provider, id) => {
          check(); if (!registered.has(`${provider}:${id}`)) refuse("E2_MODEL_UNREGISTERED");
          return original.getModel(provider, id);
        };
        if (method === "streamSimple") return (model, context, options) => {
          check(); validateModel(model, original);
          if (baseline) {
            try { assertE2BaselineRequest(context, { kind: position.probe ? "probe" : "source", sourceTools }); } catch (error) { refuse(error.code); }
            if (position.probe && positionRequests >= 1) refuse("E2_PROBE_REQUEST_LIMIT");
          }
          if (!baseline && position.probe && probeLookupRounds !== undefined) {
            if (positionRequests >= probeLookupRounds + 1) refuse("E2_PROBE_REQUEST_LIMIT");
            // Build the model request, not the harness/tool executor. Prior tool
            // results stay intact, but the final funded request offers no tools.
            if (positionRequests === probeLookupRounds) {
              // Validate what the harness offered before withdrawing it.
              const offered = (context.tools ?? context.messages.flatMap(m => m.toolsAdded ?? [])).map(tool => tool.name);
              if (offered.length !== 1 || offered[0] !== "ConversationHistory") refuse("E2_PROBE_TOOLS_REFUSED");
              context = { ...context, tools: [],
                messages: context.messages.map(message => message.toolsAdded?.length ? { ...message, toolsAdded: [] } : message) };
            }
          }
          onRequest(model, context, options, "streamSimple");
          if (lifecycle.size) refuse("E2_SOURCE_REQUEST_LIMIT");
          if (position.probe) {
            if (++report.probeRequests > limits.probeRequests) refuse("E2_PROBE_REQUEST_LIMIT");
          } else if (++report.sourceRequests > limits.sourceRequests) refuse("E2_SOURCE_REQUEST_LIMIT");
          try { assertEffectiveSoul(context, soul); sourceContext(context); } catch (error) { refuse(error?.code === "E2_SOUL_MISMATCH" || ["E2_PROBE_REQUEST_LIMIT", "E2_PROBE_TOOLS_REFUSED", "E2_STEER_NOT_DELIVERED"].includes(error?.code) ? error.code : "E2_SOURCE_REPLY_REFUSED"); }
          const paidRole = position.probe ? (positionRequests++ === 0 ? "probe" : "continuation") : position.paidRole ?? null;
          report.requestSizing.push({ turn: position.turn, message: position.message, role: paidRole ?? "setup-scripted", paidRole,
            model: keyOf(model), maxOutputTokens: options?.maxTokens ?? model.maxTokens, size: sizeContext(context, estimators) });
          if (summary === "real" && paidRole !== null) return paidAdapter.stream(original, model, context, options, paidRole);
          const bound = backend(model); bound.provider.setResponses([async () => { try { return await sourceReply(context); } catch (error) { refuse(sourceCodes.has(error?.code) ? error.code : "E2_SOURCE_REPLY_REFUSED"); } }]);
          return bound.collection.streamSimple(bound.model, context, options);
        };
        if (method === "completeSimple") return async (model, context, options = {}) => {
          check(); validateModel(model, original);
          if (baseline) { try { assertE2BaselineRequest(context, { kind: "summary" }); } catch (error) { refuse(error.code); } }
          onRequest(model, context, options, "completeSimple");
          const receipt = [...lifecycle.values()][0];
          if (!receipt || lifecycle.size !== 1 || (context.tools?.length ?? 0) !== 0 || context.messages?.some(m => m.toolsAdded?.length)) refuse("E2_SUMMARY_NOT_AUTHORIZED");
          const outputCeiling = Math.min(model.maxTokens, estimators.resolveAgentCompactionPolicy({}, model).summaryMaxTokens + 8192);
          const allowed = ["maxTokens", "reasoning", "thinkingBudgets", "transport", "maxRetries", "signal", "telemetryContext", "cacheRetention", "sessionId"];
          if (Object.keys(options).some(k => !allowed.includes(k)) || options.transport !== "sse" || options.maxRetries !== 0
            || options.thinkingBudgets !== undefined || options.cacheRetention !== undefined && options.cacheRetention !== "none"
            || options.signal !== undefined && !(options.signal instanceof AbortSignal)
            || options.sessionId !== undefined && (typeof options.sessionId !== "string" || !/^[a-f0-9-]{36}$/.test(options.sessionId))
            || options.telemetryContext !== undefined && (options.telemetryContext === null || typeof options.telemetryContext !== "object")
            || !Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > outputCeiling
            || options.reasoning !== undefined && !["off", "low"].includes(options.reasoning)) refuse("E2_SUMMARY_OPTIONS_INVALID");
          if (report.summaryRequests.length >= limits.summaryRequests || receipt.requests >= limits.summaryRequestsPerCompaction) refuse("E2_SUMMARY_REQUEST_LIMIT");
          receipt.requests++;
          const measured = sizeContext(context, estimators);
          const sizing = { turn: position.turn, message: position.message, role: "summary", paidRole: "summary", model: keyOf(model), maxOutputTokens: options.maxTokens, size: measured };
          report.summaryRequests.push(sizing); report.requestSizing.push(sizing);
          if (summary === "real") return paidAdapter.stream(original, model, context, options, "summary").result();
          const bound = backend(model);
          // Deliberately adversarial to initial-absence proofs: faithfully preserve
          // both target literals whenever the actual summary input contains them.
          const text = summary === "faux-faithful" ? ["Faithful fictional summary.", ...[FACT, NEXT_ACTION].filter(value => JSON.stringify(context).includes(value))].join("\n") : summary === "faux-short" ? "Faux sizing summary; not a factual answer." : "s".repeat(options.maxTokens * 4);
          bound.provider.setResponses([() => estimatedReply(pi, text, context, estimators)]);
          return bound.collection.completeSimple(bound.model, context, options);
        };
        if (method === "then" || typeof method === "symbol") return undefined;
        return () => refuse("E2_MODELS_METHOD_REFUSED");
      } });
    },
    refusalCode() { return sticky; },
    assertSettled() { check(); if (lifecycle.size) refuse("E2_COMPACTION_NOT_DURABLE"); },
    report() { check(); return structuredClone(report); },
  };
  if (summary === "real") paidDecorators.add(route.decorator);
  return route;
}
