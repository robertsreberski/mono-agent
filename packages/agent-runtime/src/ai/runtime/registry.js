// @ts-check

import { assertEngineTurnModelRef } from "../providers/engine-turn/model-ref.js";
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
export async function resolveEngineTurnAdapter(modelRef) {
  assertEngineTurnModelRef(modelRef);
  const { engineTurnAdapter } = await import("../providers/engine-turn.js");
  return /** @type {RuntimeBridge} */ (engineTurnAdapter);
}


export { RUNTIME_CAPABILITIES, runtimeCapabilities } from "./capabilities.js";
