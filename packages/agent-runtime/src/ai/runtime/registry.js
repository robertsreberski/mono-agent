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
 * @typedef {Object} BridgeSpec
 * @property {RuntimeBridgeId} id
 * @property {(ref: (import('../types.js').RuntimeModelRef|undefined), options?: Object) => boolean} supports
 * @property {(ref?: import('../types.js').RuntimeModelRef) => Object} capabilities
 * @property {(options?: Object) => Promise<RuntimeBridge>} load
 */

/** @type {Object<string, BridgeSpec>} */
const builtinBridgeSpecs = {
  pi: {
    id: "pi",
    supports: () => true,
    capabilities: () => runtimeCapabilities(),
    load: async () => {
      const { piNativeRuntimeBridge } = await import("../providers/pi-native.js");
      // JavaScript widens the bridge object's `id` property to string. Keep the
      // literal-safe registry contract here so the Pi provider module remains
      // untouched by this bridge-removal work package.
      return /** @type {RuntimeBridge} */ (piNativeRuntimeBridge);
    },
  },
};

/**
 * @returns {Array<RuntimeBridgeDescriptor>}
 */
export function listRuntimeBridges() {
  return Object.values(builtinBridgeSpecs).map((bridge) => ({
    id: bridge.id,
    supports: bridge.supports,
    capabilities: bridge.capabilities,
  }));
}

/**
 * @param {import('../types.js').RuntimeModelRef} modelRef
 * @param {Object} [options]
 * @returns {Promise<RuntimeBridge>}
 */
export async function resolveRuntimeBridge(modelRef, options = {}) {
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
  for (const spec of Object.values(builtinBridgeSpecs)) {
    if (spec.supports(modelRef, options)) return spec.load(options);
  }
  throw new Error(`unsupported model reference: ${modelRef.reference}`);
}

export { RUNTIME_CAPABILITIES, runtimeCapabilities } from "./capabilities.js";
