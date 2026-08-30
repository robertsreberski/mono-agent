// @ts-check

/** @type {"projected"} */
export const TOOL_POLICY_PROJECTED = "projected";

/**
 * True when a tool policy is semantically unrestricted.
 *
 * An omitted allowlist and any allowlist containing the global `"*"` sentinel
 * both mean allow-all. A denylist still makes the policy restrictive.
 *
 * @param {*} allowedTools
 * @param {*} disallowedTools
 * @returns {boolean}
 */
export function isAllowAllToolPolicy(allowedTools, disallowedTools) {
  const allowAll = !Array.isArray(allowedTools) || allowedTools.includes("*");
  const hasDeniedTools = Array.isArray(disallowedTools) && disallowedTools.length > 0;
  return allowAll && !hasDeniedTools;
}
