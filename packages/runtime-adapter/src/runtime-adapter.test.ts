import { describe, expect, it } from "vitest";

import {
  assertExecutionModeCompatible,
  defaultExecutionModeForModel,
  parseMonoRuntimeModelReference,
  RuntimeAdapterError,
} from "./index.js";

describe("runtime adapter model references", () => {
  it("parses canonical Pi model references", () => {
    expect(parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.5")).toEqual({
      sdk: "pi",
      provider: "openai-codex",
      model: "gpt-5.5",
      reference: "pi:openai-codex:gpt-5.5",
    });
  });

  it("parses Codex model references and defaults them to CLI", () => {
    const model = parseMonoRuntimeModelReference("codex:gpt-5.5");
    expect(model).toEqual({ sdk: "codex", model: "gpt-5.5", reference: "codex:gpt-5.5" });
    expect(defaultExecutionModeForModel(model)).toBe("cli");
  });

  it("rejects raw or legacy-invalid model references with a stable error", () => {
    expect(() => parseMonoRuntimeModelReference("haiku")).toThrow(RuntimeAdapterError);
    try {
      parseMonoRuntimeModelReference("haiku");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_model_reference" });
    }
  });

  it("rejects incompatible execution modes before calling the runtime", () => {
    const model = parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.5");
    expect(() => assertExecutionModeCompatible(model, "cli")).toThrow(/only runs under SDK execution mode/u);
  });

  it("accepts compatible execution modes", () => {
    expect(() => assertExecutionModeCompatible(parseMonoRuntimeModelReference("claude:claude-sonnet-4-6"), "cli")).not.toThrow();
    expect(() => assertExecutionModeCompatible(parseMonoRuntimeModelReference("codex:gpt-5.5"), "cli")).not.toThrow();
  });
});
