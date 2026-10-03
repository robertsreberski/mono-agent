import type { EmbeddingProvider } from "./types.js";

/**
 * Named embedding instruction presets. A preset is part of the index identity:
 * changing it changes the vectors, so it requires the safe memory rebuild.
 * Presets are versioned by name; never change the text of an existing preset.
 */
export const EMBEDDING_INSTRUCTION_PRESETS = ["search", "none", "query", "qwen3"] as const;
export type EmbeddingInstructionPreset = (typeof EMBEDDING_INSTRUCTION_PRESETS)[number];
/** `auto` selects the preset for the model when an index is built. */
export type EmbeddingInstructionsSetting = "auto" | EmbeddingInstructionPreset;

export interface EmbeddingPrefixes {
  readonly query: string;
  readonly document: string;
}

const PRESET_PREFIXES: Readonly<Record<EmbeddingInstructionPreset, EmbeddingPrefixes>> = {
  // Nomic-style task prefixes; the historical default for every model.
  search: { query: "search_query: ", document: "search_document: " },
  none: { query: "", document: "" },
  query: { query: "query: ", document: "" },
  qwen3: {
    query: "Instruct: Given a question, retrieve memory notes that answer it\nQuery:",
    document: "",
  },
};

const IDENTITY_SUFFIX = "#instructions=";

export function isEmbeddingInstructionsSetting(value: unknown): value is EmbeddingInstructionsSetting {
  return value === "auto" || (EMBEDDING_INSTRUCTION_PRESETS as readonly unknown[]).includes(value);
}

/** Preset trained for a model name; unknown models keep the historical `search` prefixes. */
export function modelInstructionPreset(model: string): EmbeddingInstructionPreset {
  const base = (model.trim().toLowerCase().split("/").at(-1) ?? "").replace(/:[^:]*$/u, "");
  if (base === "bge-m3") return "none";
  if (base === "snowflake-arctic-embed2" || /^snowflake-arctic-embed-[ml]-v2\.0$/u.test(base)) return "query";
  if (base.startsWith("qwen3-embedding")) return "qwen3";
  return "search";
}

export function resolveEmbeddingInstructionPreset(
  model: string,
  setting: EmbeddingInstructionsSetting = "auto",
): EmbeddingInstructionPreset {
  return setting === "auto" ? modelInstructionPreset(model) : setting;
}

/**
 * Index identity for a provider/model and preset. The historical `search`
 * preset keeps the bare `provider:model` identity so existing indexes match.
 */
export function embeddingIdentity(baseId: string, preset: EmbeddingInstructionPreset): string {
  return preset === "search" ? baseId : `${baseId}${IDENTITY_SUFFIX}${preset}`;
}

/** Prefixes encoded by an index identity (legacy `search` when no suffix is present). */
export function embeddingPrefixesForIdentity(identity: string): EmbeddingPrefixes {
  const index = identity.lastIndexOf(IDENTITY_SUFFIX);
  if (index < 0) return PRESET_PREFIXES.search;
  const preset = identity.slice(index + IDENTITY_SUFFIX.length);
  if (!(EMBEDDING_INSTRUCTION_PRESETS as readonly string[]).includes(preset) || preset === "search") {
    throw new Error(`memory-search: unsupported embedding instructions in identity "${identity}".`);
  }
  return PRESET_PREFIXES[preset as EmbeddingInstructionPreset];
}

export interface EmbeddingIdentityConfig {
  readonly provider: string;
  readonly model: string;
  readonly instructions?: EmbeddingInstructionsSetting;
}

/** Identity a new or rebuilt index receives for this configuration. */
export function configuredEmbeddingIdentity(config: EmbeddingIdentityConfig): string {
  return embeddingIdentity(
    `${config.provider}:${config.model}`,
    resolveEmbeddingInstructionPreset(config.model, config.instructions),
  );
}

/**
 * Pre-preset identity an existing index may keep using. Only `auto` accepts it:
 * upgrading never forces a rebuild, and the model preset is adopted by the next
 * deliberate rebuild. An explicit setting always requires its own identity.
 */
export function legacyEmbeddingIdentity(config: EmbeddingIdentityConfig): string | undefined {
  const identity = configuredEmbeddingIdentity(config);
  const legacy = `${config.provider}:${config.model}`;
  return (config.instructions ?? "auto") === "auto" && identity !== legacy ? legacy : undefined;
}

/** The identity this configuration serves for an existing index identity. */
export function effectiveEmbeddingIdentity(
  config: EmbeddingIdentityConfig,
  activeIdentity: string | undefined,
): string {
  const legacy = legacyEmbeddingIdentity(config);
  return legacy !== undefined && activeIdentity === legacy ? legacy : configuredEmbeddingIdentity(config);
}

/**
 * Serve an existing pre-preset index with its original prefixes. Returns the
 * provider unchanged unless the index identity is exactly the provider's legacy
 * identity.
 */
export function adoptEmbeddingIndexIdentity<T extends EmbeddingProvider>(
  provider: T,
  indexIdentity: string | undefined,
): T | EmbeddingProvider {
  if (provider.legacyId === undefined || indexIdentity === undefined || indexIdentity !== provider.legacyId) {
    return provider;
  }
  return { id: provider.legacyId, embed: async (texts) => await provider.embed(texts) };
}
