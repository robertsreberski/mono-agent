import { COMMON_CAPABILITIES, runtimeCapabilities } from "./capabilities.js";

// CLI bridges are checked first when execution_mode='cli'. Without that flag
// the resolver falls through to the SDK bridges below, preserving the
// pre-Phase-2 behaviour for any agent that hasn't opted in.
const builtinBridgeSpecs = {
  "claude-code": {
    id: "claude-code",
    supports: (ref, options) => ref?.sdk === "claude" && options?.executionMode === "cli",
    // The claude CLI resumes prior sessions via `--resume <sessionId>`.
    capabilities: () => ({ kind: "claude-code", runtime: "cli", ...COMMON_CAPABILITIES, supports_session_resume: true }),
    load: async () => (await import("../providers/claude-cli.js")).claudeCodeRuntimeBridge,
  },
  "codex-app": {
    id: "codex-app",
    supports: (ref, options) => ref?.sdk === "codex" && options?.executionMode === "cli",
    // The codex-app bridge keeps the app-server subprocess + thread alive
    // across turns when options.sessionKeepAlive is set.
    capabilities: () => ({ kind: "codex-app", runtime: "cli", ...COMMON_CAPABILITIES, supports_session_resume: true }),
    load: async () => (await import("../providers/codex-app.js")).codexAppRuntimeBridge,
  },
  "opencode-app": {
    id: "opencode-app",
    supports: (ref, options) => ref?.sdk === "opencode" && options?.executionMode === "cli",
    capabilities: () => ({ kind: "opencode-app", runtime: "cli", ...COMMON_CAPABILITIES }),
    load: async () => (await import("../providers/opencode-app.js")).opencodeAppRuntimeBridge,
  },
  claude: {
    id: "claude",
    supports: (ref) => ref?.sdk === "claude",
    capabilities: () => runtimeCapabilities("claude"),
    load: async () => (await import("../providers/claude-sdk.js")).claudeRuntimeBridge,
  },
  pi: {
    id: "pi",
    supports: (ref) => ref?.sdk === "pi",
    capabilities: () => runtimeCapabilities("pi"),
    // The pi-native AgentHarness bridge is the sole pi runtime path. The
    // hand-rolled pi-sdk bridge was removed once native reached parity.
    load: async () => (await import("../providers/pi-native.js")).piNativeRuntimeBridge,
  },
};

export function listRuntimeBridges() {
  return Object.values(builtinBridgeSpecs).map((bridge) => ({
    id: bridge.id,
    supports: bridge.supports,
    capabilities: bridge.capabilities,
  }));
}

export async function resolveRuntimeBridge(modelRef, options = {}) {
  for (const spec of Object.values(builtinBridgeSpecs)) {
    if (spec.supports(modelRef, options)) return spec.load(options);
  }
  throw new Error(`unsupported sdk: ${modelRef?.sdk || "unknown"}`);
}

export { RUNTIME_CAPABILITIES, runtimeCapabilities } from "./capabilities.js";
