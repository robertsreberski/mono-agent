import { describe, expect, it } from "vitest";

import { defaultAnswers, composeWizardPlan } from "../wizard/answers.js";
import { runReadinessProbe } from "../readiness-probe.js";

describe("runReadinessProbe", () => {
  const plan = composeWizardPlan(defaultAnswers(), { dirBasename: "agent", skillsRootExists: false });

  it("runs against the selected model with a no-tool disposable config", async () => {
    let seen: { model: unknown; allowedTools: readonly string[]; workspace: string } | undefined;
    const result = await runReadinessProbe({
      plan,
      run: async ({ config, options }) => {
        seen = { model: config.runtime.model, allowedTools: options.allowedTools ?? [], workspace: config.runtime.workspace };
        expect(options).toMatchObject({ maxTurns: 1, allowedTools: [], disallowedTools: [], mcpServers: {}, sessionKeepAlive: false });
        expect(config.runtime.fallbackModels).toBeUndefined();
        expect(config.memory).toBeUndefined();
        expect(config.tools.allowedTools).toEqual([]);
        return { text: "ready" };
      },
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toMatchObject({ model: { reference: "codex:gpt-5.6-terra" }, allowedTools: [] });
    expect(seen?.workspace).toContain("mono-agent-readiness-");
  });

  it("surfaces an empty first response as not ready", async () => {
    await expect(runReadinessProbe({ plan, run: async () => ({ text: "" }) })).resolves.toMatchObject({ ok: false });
  });
});
