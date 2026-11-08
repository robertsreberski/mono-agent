import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
// Scripts-only, fail-closed policy. No credential resolution, provider or send factory.
const need = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code, outcome: "refused_pre_send" }); };
export const lookupCacheKey = key => typeof key === "string" && /^[\x21-\x7e]{1,64}$/u.test(key);
export const lookupPilotWork = a => join(a.outputRoot, "work", a.slotId, "checkpoint", "work");
export function issueLookupCacheKey(runId) {
  need(typeof runId === "string" && /^[A-Za-z0-9-]{1,36}$/u.test(runId), "lookup_cache_assignment_invalid");
  return `lk-${runId}-${randomBytes(12).toString("hex")}`;
}
export function assertLookupCacheAssignment(state, assignment) {
  const keys = state.slots.map(s => s.cacheKey);
  need(state.cacheKeysUnique === true && keys.every(lookupCacheKey) && new Set(keys).size === keys.length
    && Number.isInteger(assignment?.index) && assignment.index >= 0 && assignment.index < keys.length
    && lookupCacheKey(assignment.cacheKey) && keys[assignment.index] === assignment.cacheKey, "lookup_cache_assignment_invalid");
}
/** Check resolved values, not the flags used to request them. Repeated at every dispatch. */
export function assertResolvedLookupSafety({ plan, config, arm, captureUpkeepOutput, options, historyEndpoint, forwarded = false } = {}) {
  need(plan?.judge === null && config && arm, "lookup_auxiliary_callers_forbidden");
  need(config.memory == null && config.subagents?.enabled !== true
    && config.runtime?.session?.continuity?.upkeep?.enabled !== true
    && config.runtime?.session?.continuity?.ledgerEnabled !== true
    && config.runtime?.compaction?.enabled === false && config.runtime?.outputSchema == null
    && config.outputSchema == null, "lookup_auxiliary_callers_forbidden");
  need(arm.midCheckpoint === null && !arm.ledgerUpkeep && !captureUpkeepOutput, "lookup_preparation_forbidden");
  need(config.runtime.session?.modelSwitch?.enabled !== true, "lookup_model_switch_forbidden");
  const model = config.runtime.model, provider = config.providers?.piNative;
  need(model?.provider === "openai-codex" && model?.model === "gpt-6.1-sol"
    && !Object.keys(config.runtime.context1MModels ?? {}).length && !Object.keys(config.providers?.local ?? {}).length
    && (config.runtime.fallbacks ?? []).length === 0 && (config.runtime.retry?.primaryAttempts ?? 1) === 1
    && provider?.transport === "sse" && provider.piMaxRetries === 0, "lookup_route_mismatch");
  for (const value of [config.runtime, config.runtime.retry ?? {}, provider]) for (const key of ["piRequestRetryBudgetMs", "retryBudgetMs", "retryProfile", "outageRetryProfile"])
    need(!Object.hasOwn(value, key), "lookup_retry_profile_forbidden");
  if (historyEndpoint !== undefined) {
    let url; try { url = new URL(historyEndpoint); } catch {}
    need(url?.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) > 0 && !url.username && !url.password && !url.hash, "lookup_tools_forbidden");
  }
  const allowed = config.tools?.allowedTools ?? [];
  need(allowed.every(tool => tool === "ConversationHistory") && !config.tools?.mcpConfigPath, "lookup_tools_forbidden");
  if (options) {
    need(options.outputSchema == null && options.subagents == null && options.memory == null
      && options.compaction?.enabled === false, "lookup_auxiliary_callers_forbidden");
    const selected = options.model;
    need(selected?.provider === model.provider && (selected.model ?? selected.id) === model.model
      && options.piTransport === "sse" && options.piMaxRetries === 0
      && !(options.fallbackChain ?? []).length && !Object.keys(options.context1MModels ?? {}).length, "lookup_route_mismatch");
    for (const key of ["piRequestRetryBudgetMs", "retryBudgetMs", "retryProfile", "retry", "prepareRequest", "piResolvedModel", "piResolvedModels"])
      need(!Object.hasOwn(options, key), "lookup_retry_profile_forbidden");
    const servers = options.mcpServers ?? {};
    need(Object.keys(servers).every(key => key === "mono-agent-conversation-history"), "lookup_tools_forbidden");
    if (forwarded && Object.keys(servers).length) need(typeof historyEndpoint === "string" && servers["mono-agent-conversation-history"].url === historyEndpoint
      && servers["mono-agent-conversation-history"].type === "http"
      && Object.keys(servers["mono-agent-conversation-history"]).every(key => ["type", "url"].includes(key)), "lookup_tools_forbidden");
    need((options.allowedTools ?? []).every(tool => tool === "ConversationHistory"), "lookup_tools_forbidden");
  }
}
// All these methods only inspect/reconcile/retire local native state; none dispatches Models.
export const LOOKUP_RUNTIME_LIFECYCLE = Object.freeze(["configureTools", "disposeAllSessions", "disposeSession", "invalidateSession", "retireDurableSession", "syncSession", "refreshSession", "recoverSession", "reconcileSessionTurn"]);
export function controlledLookupRuntime(base, route, check, routeKind = "faux") {
  return new Proxy(base, { get(target, key) {
    if (typeof key === "symbol" || ["then", "toJSON"].includes(key)) return undefined;
    if (key === "run") return async (prompt, options) => {
      // Lazy binding avoids a static guard -> policy -> guard initialization cycle.
      const { isFauxLookupDecorator } = await import("./continuity-lookup-guard.mjs");
      const { isRealLookupDecorator } = await import("./continuity-lookup-real-capability.mjs");
      const fields = ["sessionId", "providerSessionId", "messages", "nativeSessionAuthority", "nativeSessionProjection", "sessionTurn", "sessionRecovery", "detachedContext", "coldContext"];
      const transcript = () => [options.messages?.length ?? null, createHash("sha256").update(JSON.stringify(options.messages ?? null)).digest("hex")];
      check(options); const native = fields.map(key => options[key]), before = transcript();
      const guarded = { ...await route(options) }; check(options);
      need(JSON.stringify(before) === JSON.stringify(transcript()) && native.every((value, i) => Object.is(value, options[fields[i]]))
        && Object.keys(guarded).every(key => ["piModelsDecorator", "mcpServers"].includes(key)), "lookup_native_identity_forbidden");
      need(routeKind === "real" ? isRealLookupDecorator(guarded.piModelsDecorator) : routeKind === "faux" && isFauxLookupDecorator(guarded.piModelsDecorator), "lookup_unguarded_dispatch");
      check({ ...options, ...guarded }, true);
      return target.run(prompt, { ...options, ...guarded });
    };
    if (key === "sessionTurnReconciliation") return target[key];
    need(LOOKUP_RUNTIME_LIFECYCLE.includes(key), "lookup_method_forbidden");
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
}
/** Auxiliary work can only be scripted and must receive a nonexistent credential path. */
export function lookupOfflineBoundary({ plan, arm, work, captureUpkeepOutput }) {
  need(plan?.judge === null && arm?.midCheckpoint === null && !arm.ledgerUpkeep && !captureUpkeepOutput, "lookup_preparation_forbidden");
  const authPath = `${work}/.lookup-no-credentials/absent.json`;
  for (const path of [authPath, dirname(authPath)]) {
    let absent = false;
    try { lstatSync(path); } catch (error) { absent = error.code === "ENOENT"; }
    need(absent, "lookup_preparation_forbidden");
  }
  return { mode: "offline", authPath };
}

/** Resolved settings of the local-only serializer, not a configured harness substitute. */
export function fauxLookupSafety(plan, arm) {
  return { plan, arm, config: { runtime: { model: { provider: "openai-codex", model: "gpt-6.1-sol" },
    compaction: { enabled: false }, session: { continuity: { ledgerEnabled: false, upkeep: { enabled: false } } }, retry: { primaryAttempts: 1 } },
    providers: { piNative: { transport: "sse", piMaxRetries: 0 } }, tools: { allowedTools: [] } } };
}

/** Project only known codes from SDK failure receipts; never return free-form text. */
export async function lookupPilotFailureCode(failure) {
  const [{ LOOKUP_PRE_SEND_REFUSALS }, { LOOKUP_PILOT_STOPS }] = await Promise.all([
    import("./continuity-lookup-guard.mjs"), import("./continuity-lookup-pilot-accounting.mjs"),
  ]);
  return [failure?.code, failure?.kind, failure?.message, failure?.details?.code, failure?.details?.message].find(value => LOOKUP_PILOT_STOPS.includes(value) || LOOKUP_PRE_SEND_REFUSALS.includes(value) || value === "pilot_empty_final_output");
}

/** One owned wire-byte snapshot for guard and transports; no implicit MIME metadata. */
export function lookupBodyBytes(body) {
  need(typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer, "lookup_body_type_forbidden");
  return Buffer.from(body instanceof ArrayBuffer ? new Uint8Array(body) : body);
}

export const validLookupPilotTimeout = (timeoutMs, childWatchdogMs) => Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= childWatchdogMs;

/** Bound timer values explicitly; never let timer coercion select a watchdog. */
export function lookupPilotWatchdog(authorization, deadlines, deadlineAt, now = Date.now()) {
  const requested = authorization.timeoutMs ?? deadlines.childWatchdogMs;
  const valid = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
  need([requested, deadlines.childWatchdogMs, deadlines.deadlineMs].every(valid)
    && requested <= deadlines.childWatchdogMs && Number.isSafeInteger(deadlineAt) && Number.isSafeInteger(now), "lookup_ipc_invalid");
  const timeout = Math.min(requested, deadlines.deadlineMs, Math.max(1, deadlineAt - now));
  need(valid(timeout), "lookup_ipc_invalid"); return timeout;
}
/** Set-once, synchronous observer of each request the guard hands to its single-shot send.
 * Observation only: a missing or throwing observer can never skip, delay or alter the send.
 */
export function lookupForwardedObserver() {
  let observer = null;
  return Object.freeze({
    register(fn) { need(typeof fn === "function" && observer === null, "lookup_pilot_capability_invalid"); observer = fn; },
    notify(context, round) {
      try {
        const value = observer?.(context, round);
        // Never awaited; a rejected thenable must not become an unhandled rejection.
        if (value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function") Promise.resolve(value).catch(() => {});
      } catch { /* Presence stays unknown. */ }
    },
  });
}
/** Pin to the forwarder's setup-owned endpoint, never to its rewrite output. */
export function createLookupPilotRoute({ pilot, forwarder, noteOffered }) {
  const historyEndpoint = forwarder?.historyEndpoint;
  if (forwarder) {
    need(typeof historyEndpoint === "string", "lookup_tools_forbidden");
    pilot.historyEndpoint = historyEndpoint;
  }
  return async options => {
    const forwarded = forwarder ? await forwarder.rewrite(options) : null;
    const server = forwarded?.mcpServers?.["mono-agent-conversation-history"];
    if (Object.hasOwn(forwarded?.mcpServers ?? {}, "mono-agent-conversation-history")) need(server?.url === historyEndpoint, "lookup_tools_forbidden");
    noteOffered(options);
    return { piModelsDecorator: pilot.send.decorator, ...(forwarded ? { mcpServers: forwarded.mcpServers } : {}) };
  };
}
