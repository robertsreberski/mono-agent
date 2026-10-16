// Public entry for the agent-runtime package.
//
// Most consumers should reach for `createRuntime` (see runtime.js) — it
// binds the host integration callbacks once and returns a `.run()` method.
// The named exports below remain available for advanced use cases (direct
// provider invocation and explicit tool contexts).

export { createRuntime } from "./runtime.js";
export { createPiOAuthApiKeyResolver } from "./pi-auth.js";
export { createRouterRuntime } from "./ai/runtime/router.js";
export {
  DEFAULT_RUNTIME_BRAND,
  resolveRuntimeBrand,
} from "./runtime-brand.js";

export * from "./ai/index.js";
export { resolveEngineTurnAdapter, generateEngineTurnResponse, engineTurnAdapter } from "./ai/index.js";
export * from "./agent/index.js";

export { produceNativeHandoffSummary } from "./ai/providers/engine-turn/handoff-producer.js";
export { detachDurableNativeSession } from "./engine/session-lifecycle.js";

// Administrative storage factory; never forwarded through runtime run options.
export { createManagedNativeJournalStorage } from "./ai/providers/engine-turn/native-journal-storage.js";
export { NativeEvidenceCapacityError } from "./engine/native-journal-storage.js";
