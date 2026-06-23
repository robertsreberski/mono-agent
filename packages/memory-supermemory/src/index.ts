import { createSupermemoryHttpClient } from "./client.js";
import type { SupermemorySearchMode } from "./client.js";
import { SupermemoryMemoryStore } from "./store.js";

export { createSupermemoryHttpClient } from "./client.js";
export type {
  SupermemoryAddParams,
  SupermemoryClient,
  SupermemoryFetch,
  SupermemoryFetchResponse,
  SupermemoryHit,
  SupermemoryHttpClientConfig,
  SupermemoryMetadataValue,
  SupermemorySearchMode,
  SupermemorySearchParams,
} from "./client.js";
export { formatHitsAsBlock, SUPERMEMORY_SOURCE } from "./format.js";
export { SupermemoryMemoryStore } from "./store.js";
export type { SupermemoryRecallHit, SupermemoryStoreOptions } from "./store.js";

/** Config for the convenience factory that wires an HTTP client + store in one call. */
export interface CreateSupermemoryStoreConfig {
  readonly baseUrl: string;
  readonly apiKey?: string;
  /** Namespace tag scoping this agent's memories. */
  readonly container: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly searchLimit?: number;
  readonly searchMode?: SupermemorySearchMode;
  readonly threshold?: number;
  readonly rerank?: boolean;
  readonly logger?: { warn(message: string): void };
}

/** Build a {@link SupermemoryMemoryStore} over the REST client. The single entry point hosts use. */
export function createSupermemoryStore(config: CreateSupermemoryStoreConfig): SupermemoryMemoryStore {
  const client = createSupermemoryHttpClient({
    baseUrl: config.baseUrl,
    containerTag: config.container,
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.searchLimit === undefined ? {} : { searchLimit: config.searchLimit }),
    ...(config.searchMode === undefined ? {} : { searchMode: config.searchMode }),
    ...(config.threshold === undefined ? {} : { threshold: config.threshold }),
    ...(config.rerank === undefined ? {} : { rerank: config.rerank }),
  });
  return new SupermemoryMemoryStore(client, {
    ...(config.maxBytes === undefined ? {} : { maxBytes: config.maxBytes }),
    ...(config.searchLimit === undefined ? {} : { recallLimit: config.searchLimit }),
    ...(config.logger === undefined ? {} : { logger: config.logger }),
  });
}
