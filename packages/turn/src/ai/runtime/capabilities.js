import { TOOL_POLICY_PROJECTED } from "./tool-policy.js";

export const COMMON_CAPABILITIES = {
  streaming: true,
  structured_output: true,
  supports_session_resume: false,
  native_runtime_config: null,
  supports_mcp: true,
  supports_mcp_apps: false,
  supports_skills: true,
  supports_builtin_tools: true,
  supports_live_input: true,
  supports_native_subagents: true,
  supports_request_tool_environment: false,
};

export const RUNTIME_CAPABILITIES = {
  pi: {
    runtime: "pi-agent",
    ...COMMON_CAPABILITIES,
    // The engine owns native session evidence and resume projection.
    supports_session_resume: true,
    // Subagent orchestration remains host-owned, not engine-native.
    supports_native_subagents: false,
    supports_request_tool_environment: true,
    supports_mcp_apps: true,
    tool_policy: TOOL_POLICY_PROJECTED,
  },
};

/**
 * @param {*} [_legacySelection]
 * @returns {{kind: "pi"} & typeof RUNTIME_CAPABILITIES.pi}
 */
export function runtimeCapabilities(_legacySelection) {
  // Capability lookup no longer selects a backend. The ignored optional value
  // keeps the still-separate router migration type-safe without allowing its
  // legacy route ids to influence the sole surviving runtime contract.
  return { kind: "pi", ...RUNTIME_CAPABILITIES.pi };
}
