import { TOOL_POLICY_PROJECTED } from "./tool-policy.js";

const COMMON_CAPABILITIES = {
  streaming: true,
  structured_output: true,
  supports_session_resume: false,
  native_runtime_config: null as any,
  supports_mcp: true,
  supports_mcp_apps: false,
  supports_skills: true,
  supports_builtin_tools: true,
  supports_live_input: true,
  supports_native_subagents: true,
  supports_request_tool_environment: false,
};

const RUNTIME_CAPABILITIES = {
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
 * @returns {{kind: "pi"} & typeof RUNTIME_CAPABILITIES.pi}
 */
export function runtimeCapabilities(): { kind: "pi"; } & { supports_session_resume: boolean; supports_native_subagents: boolean; supports_request_tool_environment: boolean; supports_mcp_apps: boolean; tool_policy: "projected"; streaming: boolean; structured_output: boolean; native_runtime_config: any; supports_mcp: boolean; supports_skills: boolean; supports_builtin_tools: boolean; supports_live_input: boolean; runtime: string; } {
  // Capability lookup describes the sole runtime; it does not select a backend.
  return { kind: "pi", ...RUNTIME_CAPABILITIES.pi };
}
