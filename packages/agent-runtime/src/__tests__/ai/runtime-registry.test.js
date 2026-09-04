import { describe, expect, it } from "vitest";
import {
  listRuntimeBridges,
  resolveRuntimeBridge,
  runtimeCapabilities,
} from "../../ai/runtime/registry.js";

describe("AI runtime bridge registry", () => {
  it("exposes one self-consistent built-in bridge descriptor", () => {
    const descriptors = listRuntimeBridges();

    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      id: "pi",
      supports: expect.any(Function),
      capabilities: expect.any(Function),
    });
    expect(descriptors[0].capabilities()).toEqual(runtimeCapabilities());
  });

  it("resolves Pi to the native AgentHarness bridge", async () => {
    const { piNativeRuntimeBridge } = await import("../../ai/providers/pi-native.js");
    const model = { provider: "openai", model: "gpt-5.5", reference: "openai:gpt-5.5" };
    const bridge = await resolveRuntimeBridge(model);

    expect(bridge).toMatchObject({ id: "pi", execute: expect.any(Function) });
    expect(bridge.execute).toBe(piNativeRuntimeBridge.execute);
  });

  it("rejects a malformed model reference before loading the sole bridge", async () => {
    await expect(resolveRuntimeBridge({ model: "x", reference: "missing:x" }))
      .rejects.toThrow("unsupported model reference: expected <provider>:<model>");
  });

  it("exposes Pi-owned capabilities", () => {
    expect(runtimeCapabilities()).toMatchObject({
      kind: "pi",
      runtime: "pi-agent",
      structured_output: true,
      supports_session_resume: true,
      supports_mcp: true,
      supports_builtin_tools: true,
      supports_request_tool_environment: true,
      tool_policy: "projected",
    });
  });
});
