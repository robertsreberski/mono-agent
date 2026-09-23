/**
 * Closed enum sets shared between the loader's `MONO_AGENT_*` validation and the
 * config-view builder's select options, so the two surfaces never drift.
 */

/**
 * Closed set of reasoning-effort hints, validated by the loader's
 * `MONO_AGENT_EFFORT` parsing and surfaced as the runtime effort options.
 */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** Built-in memory store implementation. */
export const MEMORY_BACKENDS = ["bujo"] as const;

/** Strict capability tiers for the built-in BuJo memory backend. */
export const MEMORY_MODES = ["lite", "journal", "bujo"] as const;

/** Supported memory persistence policies. */
export const MEMORY_WRITE_MODES = ["disabled", "append-host-summary", "capture"] as const;

/** Embedding providers supported by the built-in memory backend. */
export const MEMORY_EMBEDDINGS_PROVIDERS = ["ollama", "lmstudio", "openai"] as const;

/** Chat-LLM providers supported by BuJo capture. */
export const MEMORY_LLM_PROVIDERS = ["ollama", "agent-host"] as const;

/** Sentinel in tools.allowedTools meaning "all built-in tools" (an allow-all wildcard). */
export const ALLOW_ALL_TOOLS = "*";

/**
 * Built-in tools removed by a rename, mapped to their current name.
 *
 * Unlike the snake_case input aliases these names are NOT accepted: the old
 * name is not registered, so a policy entry that still uses it silently grants
 * nothing — and a stale deny entry silently stops denying the renamed tool.
 * Every tool-policy validator reports the rename instead of ignoring it.
 */
export const RENAMED_TOOL_NAMES: Readonly<Record<string, string>> = {
  AgentSend: "AgentManage",
};

/** The current name for a tool retired by a rename, or undefined when the name is not retired. */
export function renamedToolName(name: string): string | undefined {
  return Object.hasOwn(RENAMED_TOOL_NAMES, name) ? RENAMED_TOOL_NAMES[name] : undefined;
}

/** The shared migration diagnostic for one retired tool name in a policy list. */
export function renamedToolMessage(name: string, field: string): string {
  return `${field} lists ${name}, which was renamed to ${String(renamedToolName(name))}. `
    + `There is no alias: rename the entry to ${String(renamedToolName(name))}.`;
}
