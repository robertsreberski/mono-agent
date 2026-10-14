import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  listRuntimeBridges,
  resolveEngineTurnAdapter,
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

  it("resolves Pi to the engine turn adapter", async () => {
    const { engineTurnAdapter } = await import("../../ai/providers/engine-turn.js");
    const model = { provider: "openai", model: "gpt-5.5", reference: "openai:gpt-5.5" };
    const bridge = await resolveEngineTurnAdapter(model);

    expect(bridge).toMatchObject({ id: "pi", execute: expect.any(Function) });
    expect(bridge.execute).toBe(engineTurnAdapter.execute);
  });

  it("rejects a malformed model reference before dispatch", async () => {
    await expect(resolveEngineTurnAdapter({ model: "x", reference: "missing:x" }))
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

it("keeps canonical and deprecated exports identical at both public barrels", async () => {
  for (const path of ["../../ai/index.js", "../../index.js"]) {
    const api = await import(path);
    expect(api).not.toHaveProperty("assertEngineTurnModelRef");
    expect(api.resolveRuntimeBridge).toBe(api.resolveEngineTurnAdapter);
    expect(api.generatePiNativeResponse).toBe(api.generateEngineTurnResponse);
    expect(api.piNativeRuntimeBridge).toBe(api.engineTurnAdapter);
    expect(api.engineTurnAdapter.execute).toBe(api.generateEngineTurnResponse);
    expect(await api.resolveEngineTurnAdapter({ provider: "faux", model: "fixture", reference: "faux:fixture" })).toBe(api.engineTurnAdapter);
  }
});

it.each([
  {}, { provider: "", model: "x", reference: ":x" },
  { provider: "faux", model: "", reference: "faux:" },
  { provider: 1, model: "x", reference: "1:x" },
  { provider: "faux", model: 1, reference: "faux:1" },
  { provider: "faux", model: "x", reference: "different:x" },
])("preserves malformed-reference rejection for both resolver names (%j)", async (ref) => {
  for (const resolver of [resolveEngineTurnAdapter, resolveRuntimeBridge]) {
    await expect(resolver(ref)).rejects.toThrow("unsupported model reference: expected <provider>:<model>");
  }
});

it("emits identity-preserving alias types with deprecation tags", () => {
  for (const [file, aliases] of [
    ["ai/runtime/registry.d.ts", [["resolveRuntimeBridge", "resolveEngineTurnAdapter"]]],
    ["ai/providers/engine-turn.d.ts", [["generatePiNativeResponse", "generateEngineTurnResponse"], ["piNativeRuntimeBridge", "engineTurnAdapter"]]],
  ]) {
    const declaration = readFileSync(new URL(`../../../types/${file}`, import.meta.url), "utf8");
    for (const [oldName, canonical] of aliases) {
      expect(declaration).toContain(`@deprecated Use ${canonical}.`);
      expect(declaration).toContain(`export const ${oldName}: typeof ${canonical};`);
    }
  }
});
