// @ts-check

import { runtimeCapabilities } from "./capabilities.js";

/**
 * `RuntimeModelRef` is referenced inline (not aliased with a top-level
 * `@typedef`) so this barrel does not re-export a second `RuntimeModelRef`
 * type alongside model-refs.js's — that duplicate `export *` re-export is a
 * TS2308 ambiguity. The canonical export stays in model-refs.js/types.js.
 * @typedef {import('../types.js').RuntimeBridge} RuntimeBridge
 * @typedef {import('../types.js').RuntimeBridgeDescriptor} RuntimeBridgeDescriptor
 * @typedef {import('../types.js').RuntimeBridgeId} RuntimeBridgeId
 */

/**
 * @returns {Array<RuntimeBridgeDescriptor>}
 */
export function listRuntimeBridges() {
  return [{ id: "pi", supports: () => true, capabilities: () => runtimeCapabilities() }];
}

/**
 * @param {import('../types.js').RuntimeModelRef} modelRef
 * @returns {Promise<RuntimeBridge>}
 */
export async function resolveRuntimeBridge(modelRef) {
  // Direct kernel callers may bypass the parser, so malformed references must
  // still fail before the sole bridge receives them.
  if (
    typeof modelRef?.provider !== "string"
    || modelRef.provider.length === 0
    || typeof modelRef.model !== "string"
    || modelRef.model.length === 0
    || modelRef.reference !== `${modelRef.provider}:${modelRef.model}`
  ) {
    throw new Error("unsupported model reference: expected <provider>:<model>");
  }
  const { piNativeRuntimeBridge } = await import("../providers/pi-native.js");
  return /** @type {RuntimeBridge} */ (piNativeRuntimeBridge);
}

export { RUNTIME_CAPABILITIES, runtimeCapabilities } from "./capabilities.js";
