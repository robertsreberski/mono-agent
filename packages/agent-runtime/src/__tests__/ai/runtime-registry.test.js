import { describe, expect, it } from "vitest";
import {
  listRuntimeBridges,
  resolveRuntimeBridge,
  runtimeCapabilities,
} from "../../ai/runtime/registry.js";

describe("AI runtime bridge registry", () => {
  it("registers SDK and CLI bridges for both provider families", () => {
    expect(listRuntimeBridges().map((bridge) => bridge.id).sort())
      .toEqual(["claude", "claude-code", "codex-app", "opencode-app", "pi"]);
  });

  it("resolves canonical Pi and Claude model references to SDK bridges by default", async () => {
    await expect(resolveRuntimeBridge({ sdk: "pi", provider: "openai", model: "gpt-5.5" }))
      .resolves.toMatchObject({ id: "pi" });
    await expect(resolveRuntimeBridge({ sdk: "claude", model: "claude-sonnet-4-6" }))
      .resolves.toMatchObject({ id: "claude" });
    await expect(resolveRuntimeBridge({ sdk: "codex", model: "gpt-5.5" }))
      .rejects.toThrow(/unsupported sdk/i);
  });

  it("keeps the legacy pi-sdk bridge as the default and opts into pi-native only with piEngine='native'", async () => {
    const legacy = await resolveRuntimeBridge({ sdk: "pi", provider: "openai", model: "gpt-5.5" });
    expect(legacy).toMatchObject({ id: "pi", execute: expect.any(Function) });

    const legacyExplicit = await resolveRuntimeBridge(
      { sdk: "pi", provider: "openai", model: "gpt-5.5" },
      { piEngine: "legacy" },
    );
    expect(legacyExplicit.execute).toBe(legacy.execute);

    const native = await resolveRuntimeBridge(
      { sdk: "pi", provider: "openai", model: "gpt-5.5" },
      { piEngine: "native" },
    );
    expect(native).toMatchObject({ id: "pi", execute: expect.any(Function) });
    // The native bridge must be a distinct implementation from the legacy default.
    expect(native.execute).not.toBe(legacy.execute);
  });

  it("routes to CLI bridges when execution_mode='cli'", async () => {
    await expect(resolveRuntimeBridge({ sdk: "claude", model: "claude-sonnet-4-6" }, { executionMode: "cli" }))
      .resolves.toMatchObject({ id: "claude-code" });
    await expect(resolveRuntimeBridge({ sdk: "codex", model: "gpt-5.5" }, { executionMode: "cli" }))
      .resolves.toMatchObject({ id: "codex-app" });
    await expect(resolveRuntimeBridge({ sdk: "pi", provider: "openai-codex", model: "gpt-5.5" }, { executionMode: "cli" }))
      .resolves.toMatchObject({ id: "pi" });
  });

  it("rejects unrecognized sdk values regardless of execution mode", async () => {
    await expect(resolveRuntimeBridge({ sdk: "claude-code", model: "claude-sonnet-4-6" }))
      .rejects.toThrow(/unsupported sdk/i);
    await expect(resolveRuntimeBridge({ sdk: "claude-code", model: "claude-sonnet-4-6" }, { executionMode: "cli" }))
      .rejects.toThrow(/unsupported sdk/i);
  });

  it("exposes bridge-owned capabilities", () => {
    expect(runtimeCapabilities("pi")).toMatchObject({ kind: "pi", runtime: "pi-agent" });
    expect(runtimeCapabilities("claude")).toMatchObject({ kind: "claude", runtime: "sdk" });
  });
});
