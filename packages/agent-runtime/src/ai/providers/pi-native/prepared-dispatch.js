// @ts-check
import { createModels, ModelsError } from "@earendil-works/pi-ai";

export { copy as copyDispatchData };
export const PREPARED_DISPATCH_MAX_AGE_MS = 5 * 60_000;
const OAUTH_REQUEST_RESERVE_MS = 5 * 60_000;

/** Validate and copy before consuming either a direct or routed lease.
 * @param {any} [input] @returns {any} */
export function prepareNativeDispatchBinding(input = {}) {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).some((key) => typeof key !== "string" || !bindingKeys.has(key))) {
    throw new TypeError("Prepared dispatch accepts only host session binding fields");
  }
  return snapshotNativeDispatchOptions(input);
}
import { probeNativeAccountProvenance } from "./account-provenance.js";

/** @typedef {import('../../types.js').NativeDispatchBinding} NativeDispatchBinding */
/** @typedef {import('../../types.js').NativePreparedDispatch} NativePreparedDispatch */

const bindingKeys = new Set(["sessionId", "providerSessionId", "providerAttributionSessionId", "sessionKeepAlive",
  "sessionIdleTimeoutMs", "sessionTurn", "sessionRecovery", "nativeSessionAuthority", "nativeSessionProjection"]);
const dataKeys = ["model", "messages", "outputSchema", "mcpServers", "skills", "allowedTools", "disallowedTools",
  "toolLimits", "compaction", "sandboxPolicy", "toolEnvironment", "hostCapabilities", "toolExposure", "piResolvedModel",
  "context1MModels", "customProvider", "additionalReadRoots", "additionalWriteRoots", "toolRiskTiers", "approvalAlwaysAllowTools", "processJobsAvailability",
  "webSearchConfig", "webFetchConfig", "subagents", "prompts", ...bindingKeys];

/** Copy plain data while preserving privileged callback/controller identity.
 * @param {any} value @returns {any} */
function copy(value) {
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(Reflect.ownKeys(value).map((key) => [key, copy(value[key])]));
  }
  return value;
}
/** Snapshot synchronously, before tool/MCP/auth awaits. @param {any} options */
export function snapshotNativeDispatchOptions(options) {
  const output = { ...options };
  for (const key of dataKeys) if (key in options) output[key] = copy(options[key]);
  if (options.toolContext) output.toolContext = { ...options.toolContext,
    additionalReadRoots: copy(options.toolContext.additionalReadRoots), additionalWriteRoots: copy(options.toolContext.additionalWriteRoots),
    sandboxPolicy: copy(options.toolContext.sandboxPolicy), toolEnvironment: copy(options.toolContext.toolEnvironment) };
  return output;
}
/** @param {any} value @returns {any} */
export function freezeDispatchData(value) {
  if (value && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) freezeDispatchData(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** Resolve the actual Pi provider auth once, observing the credential selected
 * by that resolution (including refresh), then use a private pinned collection.
 * Secrets stay in closures, never in the returned host snapshot. No completion.
 * @param {any} models @param {any} model @param {AbortSignal|undefined} signal */
export async function prepareDispatchAuth(models, model, signal) {
  model = freezeDispatchData(copy(model));
  const provider = models.getProvider(model.provider);
  if (!provider) throw new Error("Prepared dispatch provider is unavailable");
  const selected = models.getModel(model.provider, model.id);
  if (!selected || selected.provider !== model.provider || selected.id !== model.id || selected.api !== model.api) throw new Error("Prepared dispatch model disagrees with provider collection");
  /** @type {any} */ let credential;
  const store = models.credentials;
  // A custom Models collection without a visible credential store can resolve
  // auth, but cannot establish an account. Never infer it from host credentials.
  const resolving = store ? createModels({ credentials: {
    read: async (...args) => { const value = await store.read(...args); credential = copy(value); return value; },
    modify: async (...args) => { const value = await store.modify(...args); credential = copy(value); return value; },
    delete: (...args) => store.delete(...args),
    list: (...args) => store.list(...args),
  }, authContext: models.authContext }) : models;
  if (store) resolving.setProvider(provider);
  const resolution = await resolving.getAuth(model, { signal, minOAuthValidityMs: PREPARED_DISPATCH_MAX_AGE_MS + OAUTH_REQUEST_RESERVE_MS });
  if (!resolution) throw new Error("Prepared dispatch provider authentication is unavailable");
  signal?.throwIfAborted();
  let auth = copy(resolution);
  const probe = probeNativeAccountProvenance({ provider: model.provider, api: model.api, credential,
    dispatchApiKey: auth.auth.apiKey });
  const preparedAt = Date.now();
  const expiresAt = preparedAt + PREPARED_DISPATCH_MAX_AGE_MS;
  const assertValid = (starting = false, remainingStartMs = 0) => {
    if (!Number.isSafeInteger(remainingStartMs) || remainingStartMs < 0) throw new RangeError("Invalid prepared start allowance");
    if (starting && (Date.now() >= expiresAt || expiresAt - Date.now() < remainingStartMs)) throw new ModelsError("auth", "Prepared dispatch lease expired or has insufficient start allowance; prepare again before dispatch");
  };
  // Do not rely on an optional SDK override: enforce the entire idle age plus
  // one request reserve here even if a custom resolver ignores it.
  if (resolution.source === "OAuth" && (!Number.isFinite(credential?.expires)
    || credential.expires - Date.now() < PREPARED_DISPATCH_MAX_AGE_MS + OAUTH_REQUEST_RESERVE_MS)) {
    throw new ModelsError("oauth", "Prepared OAuth authentication expires too soon; prepare again before dispatch");
  }
  const oauth = provider.auth?.oauth;
  const refused = () => new ModelsError("oauth", "Prepared credential refresh refused: original account or validity could not be retained");
  const sameAccount = (value, derived) => {
    const currentModel = models.getModel(model.provider, model.id);
    const next = probeNativeAccountProvenance({ provider: provider.id, api: currentModel?.api, credential: value, dispatchApiKey: derived?.apiKey });
    return probe.supported && next.supported && next.provenance.account === probe.provenance.account
      && next.provenance.provider === probe.provenance.provider && next.provenance.api === probe.provenance.api;
  };
  const requestAuth = async () => {
    if (resolution.source === "OAuth" && (!Number.isFinite(credential?.expires) || credential.expires - Date.now() < OAUTH_REQUEST_RESERVE_MS)) {
      if (!store?.modify || !oauth || !probe.supported) throw refused();
      try {
        // Serialize against ALL users of the original credential id/store.
        // Recheck under its lock, using the current rotating refresh token, not
        // our stale pin. A refreshed credential is persisted even if its account
        // changed: the old token may already be revoked; this lease then refuses.
        const post = await store.modify(model.provider, async (current) => {
          if (current?.type !== "oauth" || !sameAccount(current, await oauth.toAuth(current))) throw refused();
          if (Number.isFinite(current.expires) && current.expires - Date.now() >= OAUTH_REQUEST_RESERVE_MS) return undefined;
          return await oauth.refresh(current, AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]));
        }, { signal });
        const derived = post?.type === "oauth" ? await oauth.toAuth(post) : undefined;
        if (!sameAccount(post, derived) || !Number.isFinite(post?.expires) || post.expires - Date.now() < OAUTH_REQUEST_RESERVE_MS) throw refused();
        credential = copy(post); auth = { auth: copy(derived), source: "OAuth" };
      } catch { throw refused(); }
    }
    return copy(auth);
  };
  assertValid(true);
  const pinned = createModels();
  // Forward methods/getters with the original receiver, including prototype or
  // private-field implementations. Do not flatten a provider by object spread.
  const overrides = { getModels: () => [model], getAllModels: () => [model], auth: { apiKey: { resolve: requestAuth } },
    stream: provider.stream?.bind(provider), streamSimple: provider.streamSimple?.bind(provider) };
  pinned.setProvider(/** @type {any} */ (new Proxy(overrides, { get: (target, key) => {
    if (Object.hasOwn(target, key)) return Reflect.get(target, key);
    const value = Reflect.get(provider, key, provider);
    return typeof value === "function" ? value.bind(provider) : value;
  } })));
  const getAuth = pinned.getAuth.bind(pinned);
  pinned.getAuth = async (requested, options) => {
    if (typeof requested === "string" ? requested !== model.provider
      : requested.provider !== model.provider || requested.id !== model.id || requested.api !== model.api) {
      throw new ModelsError("provider", "Prepared dispatch cannot select another model");
    }
    return getAuth(requested, options);
  };
  return { models: pinned, assertValid, expiresAt, model: freezeDispatchData(copy(model)), authSource: credential?.type === "oauth" && resolution.source === "OAuth" ? "oauth" : credential?.type === "api_key" ? "api_key" : "provider",
    provenance: { provider: model.provider, api: model.api, model: model.id, account: probe.supported ? probe.provenance.account : null } };
}

/** Suspend the real orchestrator after native preparation but before ANY session
 * resolution. Its original runState/tool closures and finally own resources.
 * Host must hold its concurrency permit until run/close settles. No fallback.
 * @param {(control: {ready: (snapshot: any, producer?: {assertReady: (remainingStartMs?: number) => void, check: (input: any) => any, run: (input: any) => Promise<any>}) => Promise<any>}) => Promise<any>} execute
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<NativePreparedDispatch>} */
export function createPreparedDispatchLease(execute, signal) {
  /** @type {(value: NativePreparedDispatch) => void} */ let resolvePrepared;
  /** @type {(error: any) => void} */ let rejectPrepared;
  const prepared = new Promise((resolve, reject) => { resolvePrepared = resolve; rejectPrepared = reject; });
  /** @type {(value: any) => void} */ let resume;
  /** @type {(error: any) => void} */ let stop;
  const binding = new Promise((resolve, reject) => { resume = resolve; stop = reject; });
  // Cancellation during async initialization may reject before ready awaits it.
  void binding.catch(() => {});
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let expiryTimer;
  let expired = false;
  let state = "preparing", producerUsed = false, producerBusy = false;
  /** @type {Promise<any>|undefined} */ let producerWork;
  const cancel = () => { if (state === "preparing" || state === "prepared") { state = "closed"; clearTimeout(expiryTimer); const finish = () => stop(signal?.reason ?? new Error("Prepared dispatch closed"));
    if (producerBusy) void producerWork?.catch(() => {}).then(finish); else finish(); } };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const outcome = execute({ ready: async (snapshot, producer) => {
    if (state === "closed") throw new Error("Prepared dispatch closed before readiness");
    state = "prepared";
    expiryTimer = setTimeout(() => { expired = true; if (state === "prepared" && !producerBusy) cancel(); },
      Math.max(0, Math.min(PREPARED_DISPATCH_MAX_AGE_MS, (snapshot.expiresAt ?? Date.now() + PREPARED_DISPATCH_MAX_AGE_MS) - Date.now())));
    expiryTimer.unref();
    const producerInput = (input) => {
      if (state !== "prepared" || producerUsed) throw new Error("Prepared handoff producer is no longer available");
      if (!input || typeof input !== "object" || Object.keys(input).some((key) => !["prepared", "outputReserve"].includes(key))) throw new TypeError("Invalid prepared handoff producer request");
      return structuredClone(input);
    };
    resolvePrepared({ snapshot: freezeDispatchData(snapshot),
      ...(producer ? {
        assertReady: (remainingStartMs = 0) => { if (state !== "prepared" || producerBusy) throw new Error("Prepared dispatch is no longer available"); producer.assertReady(remainingStartMs); },
        checkHandoffSummary: (input) => producer.check(producerInput(input)),
        produceHandoffSummary: (input) => {
          let captured;
          try { captured = producerInput(input); } catch (error) { return Promise.reject(error); }
          let fit; try { fit = producer.check(captured); } catch (error) { return Promise.reject(error); } if (fit.status !== "ready") return Promise.resolve(fit);
          producerUsed = true; producerBusy = true;
          producerWork = Promise.resolve().then(() => { if (state !== "prepared") throw new Error("Prepared producer closed before dispatch"); return producer.run(captured); }).finally(() => { producerBusy = false; if (expired && state === "prepared") cancel(); });
          return producerWork;
        },
      } : {}),
      run: (input = {}) => {
        if (state !== "prepared") return Promise.reject(new Error("Prepared dispatch is no longer available"));
        if (producerBusy) return Promise.reject(new Error("Prepared handoff producer is still running"));
        let frozen;
        try { frozen = prepareNativeDispatchBinding(input); } catch (error) { return Promise.reject(error); }
        state = "running"; clearTimeout(expiryTimer); resume(frozen); return outcome;
      },
      close: async () => { cancel(); await producerWork?.catch(() => {}); await outcome.catch(() => {}); },
    });
    return await binding;
  } });
  void outcome.then((result) => {
    if (state === "preparing" || state === "closed") rejectPrepared(new Error(result?.error ?? "Native dispatch preparation did not complete"));
  }, (error) => rejectPrepared(error)).finally(() => { state = "closed"; clearTimeout(expiryTimer); signal?.removeEventListener("abort", cancel); });
  return prepared;
}
