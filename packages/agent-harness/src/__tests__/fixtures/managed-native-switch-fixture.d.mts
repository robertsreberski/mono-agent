import type { createDurableHistoryStore, DurableHistoryStoreOptions } from "../../durable-history.js";
import type { RuntimeNativePreparationStorage } from "@mono-agent/agent-runtime/host/types";
import type { ModelSwitchState, HandoffReference } from "../../durable-model-switch-contract.js";
export const bucket: string;
export function openStore(base: string, nativePhase?: (phase: string) => Promise<void>, limits?: Partial<DurableHistoryStoreOptions>): {
  store: ReturnType<typeof createDurableHistoryStore>; native: RuntimeNativePreparationStorage;
};
export function fixture(base: string, id?: string, sourceProvenance?: { provider: string; api: string; model: string; account: string | null }): Promise<{ base: string; store: ReturnType<typeof createDurableHistoryStore>;
  native: RuntimeNativePreparationStorage; state: ModelSwitchState; budget: Record<string, unknown>;
  canonicalPath: string; nativePath: string; original: Buffer }>;
export function ready(f: Awaited<ReturnType<typeof fixture>>, extra?: Record<string, unknown>): Promise<HandoffReference>;
