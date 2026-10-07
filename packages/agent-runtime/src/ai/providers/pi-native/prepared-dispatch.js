// @ts-check
import { createModels } from "@earendil-works/pi-ai";
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
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
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
    for (const child of Object.values(value)) freezeDispatchData(child);
    Object.freeze(value);
  }
  return value;
}

/** Resolve the actual Pi provider auth once, observing the credential selected
 * by that resolution (including refresh), then use a private pinned collection.
 * Secrets stay in closures, never in the returned host snapshot. No completion.
 * @param {any} models @param {any} model @param {AbortSignal|undefined} signal */
export async function prepareDispatchAuth(models, model, signal) {
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
  const resolution = await resolving.getAuth(model, { signal });
  if (!resolution) throw new Error("Prepared dispatch provider authentication is unavailable");
  signal?.throwIfAborted();
  const auth = copy(resolution);
  const probe = probeNativeAccountProvenance({ provider: model.provider, api: model.api, credential,
    dispatchApiKey: auth.auth.apiKey });
  const pinned = createModels();
  pinned.setProvider({ ...provider, getModels: () => [model], getAllModels: () => [model], auth: { apiKey: { resolve: async () => copy(auth) } } });
  return { models: pinned, model: freezeDispatchData(copy(model)), authSource: credential?.type === "oauth" && resolution.source === "OAuth" ? "oauth" : credential?.type === "api_key" ? "api_key" : "provider",
    provenance: { provider: model.provider, api: model.api, model: model.id, account: probe.supported ? probe.provenance.account : null } };
}

/** Suspend the real orchestrator after native preparation but before ANY session
 * resolution. Its original runState/tool closures and finally own resources.
 * Host must hold its concurrency permit until run/close settles. No fallback.
 * @param {(control: {ready: (snapshot: any) => Promise<any>}) => Promise<any>} execute
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
  let state = "preparing";
  const cancel = () => { if (state === "preparing" || state === "prepared") { state = "closed"; stop(signal?.reason ?? new Error("Prepared dispatch closed")); } };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const outcome = execute({ ready: async (snapshot) => {
    if (state === "closed") throw new Error("Prepared dispatch closed before readiness");
    state = "prepared";
    resolvePrepared({ snapshot: freezeDispatchData(snapshot),
      run: (input = {}) => {
        if (state !== "prepared") return Promise.reject(new Error("Prepared dispatch is no longer available"));
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !bindingKeys.has(key))) {
          return Promise.reject(new TypeError("Prepared dispatch accepts only host session binding fields"));
        }
        const frozen = snapshotNativeDispatchOptions(input);
        state = "running"; resume(frozen); return outcome;
      },
      close: async () => { cancel(); await outcome; },
    });
    return await binding;
  } });
  void outcome.then((result) => {
    if (state === "preparing" || state === "closed") rejectPrepared(new Error(result?.error ?? "Native dispatch preparation did not complete"));
  }, (error) => rejectPrepared(error)).finally(() => { state = "closed"; signal?.removeEventListener("abort", cancel); });
  return prepared;
}
