// Public surface of the provider layer.

export * from "./runtime/model-refs.js";
export * from "./runtime/registry.js";
export {
  createSessionRegistry,
  disposeAllProviderSessions,
  disposeProviderSession,
  invalidateProviderSession,
  refreshProviderSession,
  syncProviderSession,
} from "./runtime/sessions.js";
export { createMetricsObserver, createObserverHub } from "./observer.js";
export { generatePiNativeResponse, piNativeRuntimeBridge } from "./providers/pi-native.js";
// Re-exported with `export *` so the JSDoc-declared snapshot types
// (PiBuiltinModelSnapshot, PiBuiltinProviderSnapshot, …) travel with the
// functions; runtime-adapter re-exports these for host-side catalog builders.
export * from "./pi-interop.js";
export {
  buildCapabilitiesUsed,
  toolCompactionAppliedFromWarnings,
  UNKNOWN_CAPABILITY,
} from "./runtime/capabilities-used.js";
