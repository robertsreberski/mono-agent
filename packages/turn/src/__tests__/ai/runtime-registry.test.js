import ts from "typescript";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  listRuntimeBridges,
  resolveEngineTurnAdapter,
  runtimeCapabilities,
} from "../../runtime/bridges.js";

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
    const { engineTurnAdapter } = await import("../../execution/pi/run.js");
    const model = { provider: "openai", model: "gpt-5.5", reference: "openai:gpt-5.5" };
    const bridge = await resolveEngineTurnAdapter(model);

    expect(bridge).toMatchObject({ id: "pi", execute: expect.any(Function) });
    expect(bridge.execute).toBe(engineTurnAdapter.execute);
  });

  it("rejects malformed references before loading the adapter", async () => {
    const load = vi.fn(() => { throw new Error("Malformed references must not load the adapter"); });
    vi.doMock("../../execution/pi/run.js", load);
    try {
      for (const resolve of [resolveEngineTurnAdapter]) {
        await expect(resolve({ model: "x", reference: "missing:x" })).rejects.toThrow("unsupported model reference: expected <provider>:<model>");
      }
      expect(load).not.toHaveBeenCalled();
    } finally { vi.doUnmock("../../execution/pi/run.js"); }
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

it("exports canonical adapter names only at the expert AI entry", async () => {
  for (const path of ["../../ai/index.js", "../../index.js"]) {
    const api = await import(path);
    expect(api).not.toHaveProperty("assertEngineTurnModelRef");
    expect(api).not.toHaveProperty("resolveRuntimeBridge");
    expect(api).not.toHaveProperty("generatePiNativeResponse");
    expect(api).not.toHaveProperty("piNativeRuntimeBridge");
    if (path === "../../index.js") {
      expect(api).not.toHaveProperty("engineTurnAdapter");
      expect(api).not.toHaveProperty("generateEngineTurnResponse");
      expect(api).not.toHaveProperty("resolveEngineTurnAdapter");
    } else {
      expect(api.engineTurnAdapter.execute).toBe(api.generateEngineTurnResponse);
      expect(await api.resolveEngineTurnAdapter({ provider: "faux", model: "fixture", reference: "faux:fixture" })).toBe(api.engineTurnAdapter);
    }
  }
});

it.each([
  {}, { provider: "", model: "x", reference: ":x" },
  { provider: "faux", model: "", reference: "faux:" },
  { provider: 1, model: "x", reference: "1:x" },
  { provider: "faux", model: 1, reference: "faux:1" },
  { provider: "faux", model: "x", reference: "different:x" },
])("preserves malformed-reference rejection for the canonical resolver (%j)", async (ref) => {
  for (const resolver of [resolveEngineTurnAdapter]) {
    await expect(resolver(ref)).rejects.toThrow("unsupported model reference: expected <provider>:<model>");
  }
});

it("omits retired aliases from freshly emitted declarations", () => {
  const files = ["runtime/bridges.ts", "execution/pi/run.ts"].map((file) => fileURLToPath(new URL(`../../${file}`, import.meta.url)));
  const program = ts.createProgram(files, { allowJs: true, declaration: true, emitDeclarationOnly: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  for (const path of files) {
    let declaration = "";
    const result = program.emit(program.getSourceFile(path), (_file, text) => { declaration = text; }, undefined, true);
    expect(result.emitSkipped).toBe(false);
    expect(result.diagnostics).toEqual([]);
    for (const name of ["resolveRuntimeBridge", "generatePiNativeResponse", "piNativeRuntimeBridge"]) {
      expect(declaration).not.toContain(name);
    }
  }
});
