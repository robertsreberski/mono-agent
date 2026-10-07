import type { createDurableHistoryStore, DurableHistoryStoreOptions } from "../../durable-history.js";
import type { RuntimeNativePreparationStorage } from "@mono-agent/runtime-adapter";
import type { ModelSwitchState, HandoffReference } from "../../durable-model-switch-contract.js";
export const bucket: string;
export function openStore(base: string, nativePhase?: (phase: string) => Promise<void>, limits?: Partial<DurableHistoryStoreOptions>): {
  store: ReturnType<typeof createDurableHistoryStore>; native: RuntimeNativePreparationStorage;
};
export function fixture(base: string, id?: string): Promise<{ base: string; store: ReturnType<typeof createDurableHistoryStore>;
  native: RuntimeNativePreparationStorage; state: ModelSwitchState; budget: Record<string, unknown>;
  canonicalPath: string; nativePath: string; original: Buffer }>;
export function ready(f: Awaited<ReturnType<typeof fixture>>): Promise<HandoffReference>;
