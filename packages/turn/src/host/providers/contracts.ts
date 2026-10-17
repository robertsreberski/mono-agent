// Host provider/discovery DTOs; no implementation imports.


export type LocalProviderType = "ollama" | "lmstudio" | "openai_compat";


export interface LocalProviderCapabilities {
  readonly tool_use?: boolean;
  readonly reasoning?: boolean;
  readonly reasoning_mode?: "none" | "toggle" | "effort" | string;
  readonly reasoning_levels?: readonly string[];
  readonly reasoning_disable_supported?: boolean;
  readonly vision?: boolean;
  readonly json_mode?: boolean;
  readonly context_window?: number;
  readonly num_ctx?: number;
  readonly max_tokens?: number;
  readonly family?: string;
  readonly advertised_capabilities?: readonly string[];
  readonly [key: string]: unknown;
}


export interface LocalProviderPricing {
  readonly input_per_million?: number;
  readonly cached_input_per_million?: number;
  readonly cache_write_per_million?: number;
  readonly output_per_million?: number;
  readonly [key: string]: unknown;
}


export interface LocalProviderModelDefinition {
  readonly name: string;
  readonly alias?: string;
  readonly displayName?: string;
  readonly enabled?: boolean;
  readonly capabilities?: LocalProviderCapabilities;
  readonly pricing?: LocalProviderPricing;
}


/** One provider selected into an agent's model catalog. */
export interface ProviderDefinition {
  readonly id: string;
  /** Present only for a self-hosted/OpenAI-compatible endpoint. */
  readonly type?: LocalProviderType;
  readonly baseUrl?: string;
  readonly enabled?: boolean;
  readonly trustPublicUrl?: boolean;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly models?: readonly LocalProviderModelDefinition[];
  /** Bound the provider's contribution to operator-facing model catalogs. */
  readonly maxAdvertisedModels?: number;
}


/** Backward-compatible narrowed shape for callers that require a local endpoint. */
export interface LocalProviderDefinition extends ProviderDefinition {
  readonly type: LocalProviderType;
}


export interface AgentRuntimeCustomProvider {
  readonly id: string;
  readonly provider_type: LocalProviderType;
  readonly base_url: string;
  readonly enabled: boolean;
  readonly trust_public_url: boolean;
  readonly api_key?: string;
}


export interface AgentRuntimeCustomModel {
  readonly provider_id: string;
  readonly model_name: string;
  readonly alias?: string;
  readonly display_name: string;
  readonly capabilities: LocalProviderCapabilities;
  readonly pricing: LocalProviderPricing;
  readonly enabled: boolean;
}


export interface LocalProviderRuntimeOptions {
  readonly customProvider?: AgentRuntimeCustomProvider;
  readonly customModel?: AgentRuntimeCustomModel;
  readonly modelCapabilities?: LocalProviderCapabilities;
  readonly isPrivateProvider?: boolean;
  readonly [key: string]: unknown;
}


/** One model discovered live from a local provider's OpenAI-compatible `/v1/models` endpoint. */
export interface DiscoveredLocalModel {
  readonly ref: string;
  readonly label: string;
  readonly providerId: string;
  /** Confirmed by native provider metadata, never inferred from the name. */
  readonly embeddingOnly?: boolean;
}


/** The effort-related facts the TUI needs to render a per-model reasoning/effort picker. */
export interface ModelEffortLevels {
  readonly reasoning: boolean;
  /**
   * How this model exposes reasoning: `"effort"` (graded levels, see
   * `effortLevels`), `"toggle"` (binary thinking on/off — the client renders
   * on/off, NOT graded levels), or `"none"` (no adjustable thinking). Absent
   * for cloud/unconfigured refs, where the client falls back to the global
   * effort enum.
   */
  readonly reasoningMode?: "none" | "toggle" | "effort" | string;
  readonly effortLevels?: readonly string[];
}


export interface DiscoveredProvider extends LocalProviderDefinition {
  readonly baseUrl: string;
  readonly models: readonly LocalProviderModelDefinition[];
}
