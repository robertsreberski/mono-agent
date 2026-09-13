import type { MemoryStore } from "@mono-agent/agent-contracts";

import {
  installedOptionalPluginVersion,
  isOptionalPluginInstalled,
  loadOptionalPlugin,
  missingOptionalPluginMessage,
} from "./optional-plugin.js";
import type { OptionalPluginDefinition, OptionalPluginResolutionOptions } from "./optional-plugin.js";
export type { ImportOptionalPlugin, ResolveOptionalPlugin } from "./optional-plugin.js";

export const SUPERMEMORY_PLUGIN_PACKAGE = "@mono-agent/memory-supermemory";

export interface SupermemoryPluginStore extends MemoryStore {
  recall(
    query: string,
    options?: { readonly topK?: number; readonly trackAccess?: boolean },
  ): Promise<readonly {
    readonly score: number;
    readonly record: { readonly id: string; readonly text: string };
  }[]>;
  close(): Promise<void>;
}

export interface CreateSupermemoryPluginStoreOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly container: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly logger?: { warn(message: string): void };
}

export interface SupermemoryPluginModule {
  readonly createSupermemoryStore: (
    options: CreateSupermemoryPluginStoreOptions,
  ) => SupermemoryPluginStore;
  readonly validateSupermemoryConfig: (
    options: CreateSupermemoryPluginStoreOptions,
  ) => { readonly valid: boolean; readonly errors: readonly string[] };
}

export type SupermemoryPluginResolutionOptions = OptionalPluginResolutionOptions;

const definition: OptionalPluginDefinition<SupermemoryPluginModule> = {
  packageName: SUPERMEMORY_PLUGIN_PACKAGE,
  selector: "memory.backend 'supermemory'",
  expectedApi: "store and validation API",
  isModule: (value): value is SupermemoryPluginModule => typeof value === "object"
    && value !== null
    && typeof (value as { readonly createSupermemoryStore?: unknown }).createSupermemoryStore === "function"
    && typeof (value as { readonly validateSupermemoryConfig?: unknown }).validateSupermemoryConfig === "function",
};

export async function loadSupermemoryPlugin(
  options: SupermemoryPluginResolutionOptions = {},
): Promise<SupermemoryPluginModule> {
  return await loadOptionalPlugin(definition, options);
}

export function isSupermemoryPluginInstalled(
  options: Omit<SupermemoryPluginResolutionOptions, "importModule"> = {},
): boolean {
  return isOptionalPluginInstalled(SUPERMEMORY_PLUGIN_PACKAGE, options);
}

export function installedSupermemoryPluginVersion(
  options: Omit<SupermemoryPluginResolutionOptions, "importModule"> = {},
): string | undefined {
  return installedOptionalPluginVersion(SUPERMEMORY_PLUGIN_PACKAGE, options);
}

export function missingSupermemoryPluginMessage(): string {
  return missingOptionalPluginMessage(definition);
}
