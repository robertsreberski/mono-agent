import { describe, expect, it } from "vitest";

import { access, stat } from "node:fs/promises";

import { defaultAnswers, composeWizardPlan } from "../wizard/answers.js";
import { readinessProbeEnvironment, runReadinessProbe } from "../readiness-probe.js";

describe("runReadinessProbe", () => {
  const plan = composeWizardPlan(defaultAnswers(), { dirBasename: "agent", skillsRootExists: false });

  it("runs against the selected model with a no-tool disposable config", async () => {
    let seen: { model: unknown; allowedTools: readonly string[]; workspace: string; identityPath: string } | undefined;
    const result = await runReadinessProbe({
      plan,
      run: async ({ config, options }) => {
        seen = {
          model: config.runtime.model,
          allowedTools: options.allowedTools ?? [],
          workspace: config.runtime.workspace,
          identityPath: config.context.identityPath,
        };
        expect(options).toMatchObject({ maxTurns: 1, allowedTools: [], disallowedTools: [], mcpServers: {}, sessionKeepAlive: false });
        expect(config.runtime.fallbackModels).toBeUndefined();
        expect(config.memory).toBeUndefined();
        expect(config.tools.allowedTools).toEqual([]);
        await expect(access(config.context.identityPath)).resolves.toBeUndefined();
        await expect(stat(config.runtime.workspace)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
        return { text: "ready" };
      },
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toMatchObject({ model: { reference: "codex:gpt-5.6-terra" }, allowedTools: [] });
    expect(seen?.workspace).toContain("mono-agent-readiness-");
    expect(seen?.identityPath).toContain("mono-agent-readiness-");
  });

  it("ignores ambient MONO_AGENT overrides while retaining the selected in-memory secret overlay", async () => {
    const secretValues = { PROVIDER_SECRET: "selected-in-memory-secret" };
    const hostEnv = {
      PATH: "/usr/bin:/bin",
      PROVIDER_SECRET: "ambient-secret",
      MONO_AGENT_MODEL: "pi:openai-codex:not-the-selected-model",
      MONO_AGENT_FALLBACK_MODELS: "pi:openai-codex:not-the-selected-fallback",
      MONO_AGENT_MEMORY_PATH: "/tmp/ambient-memory",
      MONO_AGENT_MEMORY_BACKEND: "supermemory",
      MONO_AGENT_SESSION_MODE: "per-message",
      MONO_AGENT_PI_SESSIONS_ROOT: "/tmp/ambient-sessions",
    };
    expect(readinessProbeEnvironment(hostEnv, secretValues)).toEqual({
      PATH: "/usr/bin:/bin",
      PROVIDER_SECRET: "selected-in-memory-secret",
    });
    await expect(runReadinessProbe({
      plan,
      hostEnv,
      secretValues,
      run: async ({ config, options }) => {
        expect(config.runtime.model).toMatchObject({ reference: "codex:gpt-5.6-terra" });
        expect(config.runtime.fallbackModels).toBeUndefined();
        expect(config.memory).toBeUndefined();
        expect(config.runtime.session).toMatchObject({ mode: "continuous" });
        expect(config.providers?.piNative?.piSessionsRoot).toBeUndefined();
        expect(options.sessionKeepAlive).toBe(false);
        return { text: "ready" };
      },
    })).resolves.toEqual({ ok: true });
  });

  it("surfaces an empty first response as not ready", async () => {
    await expect(runReadinessProbe({ plan, run: async () => ({ text: "" }) })).resolves.toMatchObject({ ok: false });
  });
});
