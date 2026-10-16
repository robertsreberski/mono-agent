// @ts-check

import { assertEngineTurnModelRef } from "../providers/engine-turn/model-ref.js";
import { runtimeCapabilities } from "./capabilities.js";

/**
 * `RuntimeModelRef` is referenced inline (not aliased with a top-level
 * `@typedef`) so this barrel does not re-export a second `RuntimeModelRef`
 * type alongside model-refs.js's — that duplicate `export *` re-export is a
 * TS2308 ambiguity. The canonical export stays in model-refs.js/types.js.
 * @typedef {import("../../contracts/runtime.js").RuntimeBridge} RuntimeBridge
 * @typedef {import("../../contracts/runtime.js").RuntimeBridgeDescriptor} RuntimeBridgeDescriptor
 * @typedef {import("../../contracts/model.js").RuntimeBridgeId} RuntimeBridgeId
 */

/**
 * @returns {Array<RuntimeBridgeDescriptor>}
 */
export function listRuntimeBridges() {
  return [{ id: "pi", supports: () => true, capabilities: () => runtimeCapabilities() }];
}

/**
 * @param {import("../../contracts/model.js").RuntimeModelRef} modelRef
 * @returns {Promise<RuntimeBridge>}
 */
export async function resolveEngineTurnAdapter(modelRef) {
  assertEngineTurnModelRef(modelRef);
  const { engineTurnAdapter } = await import("../providers/engine-turn.js");
  return /** @type {RuntimeBridge} */ (engineTurnAdapter);
}

export { runtimeCapabilities } from "./capabilities.js";
