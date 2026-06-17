// Deprecated compatibility shim.
//
// `pi-sdk.js` was replaced by the unified pi-native bridge (pi is native-only).
// The package still exports the `./ai/*` subpath, so deep imports of
// `@mono-agent/agent-runtime/ai/providers/pi-sdk.js` must keep resolving instead
// of failing with ERR_MODULE_NOT_FOUND. This module re-exports the equivalent
// pi-native symbols under their legacy names. Prefer importing from
// `./pi-native.js` (or the public runtime registry) directly.

import { runtimeCapabilities } from "../runtime/capabilities.js";
import { generatePiNativeResponse, piNativeRuntimeBridge } from "./pi-native.js";

export { isContextLimitError, normalizePiErrorMessage } from "./pi-errors.js";

/** @deprecated Use `generatePiNativeResponse` from `./pi-native.js`. */
export const generatePiResponse = generatePiNativeResponse;

/** @deprecated Use `piNativeRuntimeBridge` from `./pi-native.js`. */
export const piRuntimeBridge = piNativeRuntimeBridge;

// All pi provider variants now route through the single native bridge.
const piBackend = {
  kind: "pi",
  capabilities: runtimeCapabilities("pi"),
  execute: generatePiNativeResponse,
};

/** @deprecated All pi backends now share the native bridge. */
export const piOpenAiBackend = piBackend;
/** @deprecated All pi backends now share the native bridge. */
export const piCodexBackend = piBackend;
/** @deprecated All pi backends now share the native bridge. */
export const piVercelBackend = piBackend;
/** @deprecated All pi backends now share the native bridge. */
export const piGenericBackend = piBackend;
