import { describe, expect, it, vi } from "vitest";

import { createRequestModelOverrideRuntimeExtension } from "../request-model-override.js";

function run(metadata: Record<string, unknown> | undefined, logger?: { warn: ReturnType<typeof vi.fn> }) {
  const extension = createRequestModelOverrideRuntimeExtension(logger);
  return extension({ request: { ...(metadata === undefined ? {} : { metadata }) } });
}

describe("createRequestModelOverrideRuntimeExtension", () => {
  it("applies a webhook model + effort override (executionMode is left to the harness)", async () => {
    const result = await run({ webhook: { model: "claude:claude-opus-4-8", effort: "high" } });
    expect(result.runtimeOptions).toEqual({
      model: expect.objectContaining({ sdk: "claude", model: "claude-opus-4-8" }),
      effort: "high",
    });
  });

  it("applies a cron model override without an effort", async () => {
    const result = await run({ cron: { model: "codex:gpt-5.5" } });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ sdk: "codex", model: "gpt-5.5" }));
    expect(result.runtimeOptions.effort).toBeUndefined();
  });

  it("prefers webhook metadata over cron metadata when both are present", async () => {
    const result = await run({
      webhook: { model: "claude:claude-opus-4-8" },
      cron: { model: "codex:gpt-5.5" },
    });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ sdk: "claude" }));
  });

  it("applies a tui per-session model + effort override", async () => {
    const result = await run({ tui: { model: "claude:claude-opus-4-8", effort: "low" } });
    expect(result.runtimeOptions).toEqual({
      model: expect.objectContaining({ sdk: "claude", model: "claude-opus-4-8" }),
      effort: "low",
    });
  });

  it("prefers cron metadata over tui metadata when both are present", async () => {
    const result = await run({
      cron: { model: "codex:gpt-5.5" },
      tui: { model: "claude:claude-opus-4-8" },
    });
    expect(result.runtimeOptions.model).toEqual(expect.objectContaining({ sdk: "codex" }));
  });

  it("warns and ignores an invalid model string (no override applied)", async () => {
    const logger = { warn: vi.fn() };
    const result = await run({ webhook: { model: "not a model" } }, logger);
    expect(result.runtimeOptions.model).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid per-request model"),
      expect.objectContaining({ model: "not a model" }),
    );
  });

  it("warns and ignores an invalid effort value", async () => {
    const logger = { warn: vi.fn() };
    const result = await run({ webhook: { effort: "turbo" } }, logger);
    expect(result.runtimeOptions.effort).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid per-request effort"),
      expect.objectContaining({ effort: "turbo" }),
    );
  });

  it("is a no-op for interactive turns (no cron/webhook metadata)", async () => {
    const result = await run(undefined);
    expect(result.runtimeOptions).toEqual({});
  });
});
