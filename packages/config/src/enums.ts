/**
 * Closed enum sets shared between the loader's `MONO_AGENT_*` validation and the
 * config-view builder's select options, so the two surfaces never drift.
 */

/**
 * Closed set of reasoning-effort hints, validated by the loader's
 * `MONO_AGENT_EFFORT` parsing and surfaced as the runtime effort options.
 */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** How a mixed-provider fallback chain applies tool and sandbox policy. */
export const ROUTE_SAFETY_MODES = ["uniform", "per-route-native"] as const;

/**
 * Closed set of runtime permission modes, validated by the loader's
 * `MONO_AGENT_PERMISSION_MODE` parsing.
 */
export const PERMISSION_MODES = ["default", "plan", "acceptEdits", "bypassPermissions"] as const;

/** Sentinel in tools.allowedTools meaning "all built-in tools" (an allow-all wildcard). */
export const ALLOW_ALL_TOOLS = "*";
