import ts from "typescript";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
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

  it("rejects malformed references before loading the adapter", async () => {
    const load = vi.fn(() => { throw new Error("Malformed references must not load the adapter"); });
    vi.doMock("../../ai/providers/engine-turn.js", load);
    try {
      for (const resolve of [resolveEngineTurnAdapter, resolveRuntimeBridge]) {
        await expect(resolve({ model: "x", reference: "missing:x" })).rejects.toThrow("unsupported model reference: expected <provider>:<model>");
      }
      expect(load).not.toHaveBeenCalled();
    } finally { vi.doUnmock("../../ai/providers/engine-turn.js"); }
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

it("emits identity-preserving alias types with deprecation tags without prior build output", () => {
  const files = ["ai/runtime/registry.js", "ai/providers/engine-turn.js"].map((file) => fileURLToPath(new URL(`../../${file}`, import.meta.url)));
  const program = ts.createProgram(files, { allowJs: true, declaration: true, emitDeclarationOnly: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  for (const [file, aliases] of [
    ["ai/runtime/registry.d.ts", [["resolveRuntimeBridge", "resolveEngineTurnAdapter"]]],
    ["ai/providers/engine-turn.d.ts", [["generatePiNativeResponse", "generateEngineTurnResponse"], ["piNativeRuntimeBridge", "engineTurnAdapter"]]],
  ]) {
    let declaration = "";
    const source = program.getSourceFile(files.find((path) => path.endsWith(file.replace(".d.ts", ".js"))));
    const result = program.emit(source, (_file, text) => { declaration = text; }, undefined, true);
    expect(result.emitSkipped).toBe(false);
    expect(result.diagnostics).toEqual([]);
    for (const [oldName, canonical] of aliases) {
      expect(declaration).toContain(`@deprecated Use ${canonical}.`);
      expect(declaration).toContain(`export const ${oldName}: typeof ${canonical};`);
    }
  }
});
