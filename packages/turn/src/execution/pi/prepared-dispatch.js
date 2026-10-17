// @ts-check

export { copy as copyDispatchData };

/** Validate and copy before consuming either a direct or routed lease.
 * @param {any} [input] @returns {any} */
export function prepareNativeDispatchBinding(input = {}) {
  if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).some((key) => typeof key !== "string" || !bindingKeys.has(key))) {
    throw new TypeError("Prepared dispatch accepts only host session binding fields");
  }
  return snapshotNativeDispatchOptions(input);
}

/** @typedef {import("../../contracts/runtime.js").NativeDispatchBinding} NativeDispatchBinding */
/** @typedef {import("../../contracts/runtime.js").NativePreparedDispatch} NativePreparedDispatch */

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

/** Check ordinary provider availability without retaining credentials. Every
 * actual summary/turn request resolves auth through the original Models collection.
 * @param {any} models @param {any} model @param {AbortSignal|undefined} signal */
export async function prepareDispatchAuth(models, model, signal) {
  model = freezeDispatchData(copy(model));
  if (!models.getProvider(model.provider)) throw new Error("Prepared dispatch provider is unavailable");
  const selected = models.getModel(model.provider, model.id);
  if (!selected || selected.provider !== model.provider || selected.id !== model.id || selected.api !== model.api) throw new Error("Prepared dispatch model disagrees with provider collection");
  if (!await models.getAuth(model, { signal })) throw new Error("Prepared dispatch provider authentication is unavailable");
  signal?.throwIfAborted();
  return { models, model,
    provenance: { provider: model.provider, api: model.api, model: model.id, account: null } };
}

/** Suspend the real orchestrator after native preparation but before ANY session
 * resolution. Its original runState/tool closures and finally own resources.
 * Host must hold its concurrency permit until run/close settles. No fallback.
 * @param {(control: {ready: (snapshot: any, producer?: {assertReady: () => void, check: (input: any) => any, run: (input: any) => Promise<any>}) => Promise<any>}) => Promise<any>} execute
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
  let state = "preparing", producerUsed = false, producerBusy = false;
  /** @type {Promise<any>|undefined} */ let producerWork;
  const cancel = () => { if (state === "preparing" || state === "prepared") { state = "closed"; const finish = () => stop(signal?.reason ?? new Error("Prepared dispatch closed"));
    if (producerBusy) void producerWork?.catch(() => {}).then(finish); else finish(); } };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const outcome = execute({ ready: async (snapshot, producer) => {
    if (state === "closed") throw new Error("Prepared dispatch closed before readiness");
    state = "prepared";
    const producerInput = (input) => {
      if (state !== "prepared" || producerUsed) throw new Error("Prepared handoff producer is no longer available");
      if (!input || typeof input !== "object" || Object.keys(input).some((key) => !["prepared", "outputReserve"].includes(key))) throw new TypeError("Invalid prepared handoff producer request");
      return structuredClone(input);
    };
    resolvePrepared({ snapshot: freezeDispatchData(snapshot),
      ...(producer ? {
        assertReady: () => { if (state !== "prepared" || producerBusy) throw new Error("Prepared dispatch is no longer available"); producer.assertReady(); },
        checkHandoffSummary: (input) => producer.check(producerInput(input)),
        produceHandoffSummary: (input) => {
          let captured;
          try { captured = producerInput(input); } catch (error) { return Promise.reject(error); }
          let fit; try { fit = producer.check(captured); } catch (error) { return Promise.reject(error); } if (fit.status !== "ready") return Promise.resolve(fit);
          producerUsed = true; producerBusy = true;
          producerWork = Promise.resolve().then(() => { if (state !== "prepared") throw new Error("Prepared producer closed before dispatch"); return producer.run(captured); }).finally(() => { producerBusy = false; });
          return producerWork;
        },
      } : {}),
      run: (input = {}) => {
        if (state !== "prepared") return Promise.reject(new Error("Prepared dispatch is no longer available"));
        if (producerBusy) return Promise.reject(new Error("Prepared handoff producer is still running"));
        let frozen;
        try { frozen = prepareNativeDispatchBinding(input); } catch (error) { return Promise.reject(error); }
        state = "running"; resume(frozen); return outcome;
      },
      close: async () => { cancel(); await producerWork?.catch(() => {}); await outcome.catch(() => {}); },
    });
    return await binding;
  } });
  void outcome.then((result) => {
    if (state === "preparing" || state === "closed") rejectPrepared(new Error(result?.error ?? "Native dispatch preparation did not complete"));
  }, (error) => rejectPrepared(error)).finally(() => { state = "closed"; signal?.removeEventListener("abort", cancel); });
  return prepared;
}
