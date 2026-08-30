// Smoke every bridge the registry actually exposes. The expectation is
// derived from the descriptors so deleting a bridge cannot leave a stale
// hard-coded matrix that still claims the removed module loads.

import { describe, expect, it } from "vitest";
import {
  listRuntimeBridges,
  resolveRuntimeBridge,
  runtimeCapabilities,
} from "../../ai/runtime/registry.js";

describe("runtime smoke matrix", () => {
  it("loads every registered bridge through the public resolver", async () => {
    const descriptors = listRuntimeBridges();
    const resolved = await Promise.all(descriptors.map((descriptor) => resolveRuntimeBridge({
      provider: "openai",
      model: "gpt-5.5",
      reference: "openai:gpt-5.5",
    })));

    expect(resolved.map((bridge) => bridge.id))
      .toEqual(descriptors.map((descriptor) => descriptor.id));
    expect(resolved.every((bridge) => typeof bridge.execute === "function")).toBe(true);
    expect(resolved.every((bridge) => bridge.capabilities !== undefined)).toBe(true);
  });

  it("keeps descriptor and kernel capabilities aligned", () => {
    for (const descriptor of listRuntimeBridges()) {
      expect(descriptor.capabilities()).toEqual(runtimeCapabilities());
    }
  });

  it("cannot load a malformed reference", async () => {
    await expect(resolveRuntimeBridge({ provider: "", model: "x", reference: ":x" }))
      .rejects.toThrow("unsupported model reference: expected <provider>:<model>");
  });
});
