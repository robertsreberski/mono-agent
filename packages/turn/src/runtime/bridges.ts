// @ts-check

import { assertEngineTurnModelRef } from "../execution/pi/model-ref.js";
import { runtimeCapabilities } from "./capabilities.js";

export function listRuntimeBridges(): RuntimeBridgeDescriptor[] {
  return [{ id: "pi", supports: () => true, capabilities: () => runtimeCapabilities() }];
}

export async function resolveEngineTurnAdapter(modelRef: import("../contracts/model.js").RuntimeModelRef): Promise<RuntimeBridge> {
  assertEngineTurnModelRef(modelRef);
  const { engineTurnAdapter } = await import("../execution/pi/run.js");
  return ((engineTurnAdapter) as unknown as RuntimeBridge);
}

export { runtimeCapabilities } from "./capabilities.js";

/**
 * `RuntimeModelRef` is referenced inline (not aliased with a top-level
 * `@typedef`) so this barrel does not re-export a second `RuntimeModelRef`
 * type alongside runtime/model-reference.js's — that duplicate `export *` re-export is a
 * TS2308 ambiguity. The canonical declaration lives in contracts/model.js.
 */
export type RuntimeBridge = import("../contracts/runtime.js").RuntimeBridge;

/**
 * `RuntimeModelRef` is referenced inline (not aliased with a top-level
 * `@typedef`) so this barrel does not re-export a second `RuntimeModelRef`
 * type alongside runtime/model-reference.js's — that duplicate `export *` re-export is a
 * TS2308 ambiguity. The canonical declaration lives in contracts/model.js.
 */
export type RuntimeBridgeDescriptor = import("../contracts/runtime.js").RuntimeBridgeDescriptor;

export type { RuntimeBridgeId } from "../contracts/model.js";
