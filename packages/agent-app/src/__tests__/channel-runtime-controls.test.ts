import { describe, expect, it } from "vitest";

import type { MonoAgentConfig } from "@mono-agent/config";

import { buildChannelRuntimeControls } from "../channel-runtime-controls.js";

function configWith(providers: unknown): MonoAgentConfig {
  return {
    runtime: {
      model: {
        provider: "anthropic",
        model: "claude-fable-5",
        reference: "anthropic:claude-fable-5",
      },
      workspace: "/tmp",
      effort: "medium",
    },
    context: { identityPath: "/tmp/IDENTITY.md", selectedSkills: [] },
    tools: { disallowedTools: [] },
    ...(providers === undefined ? {} : { providers }),
  } as unknown as MonoAgentConfig;
}

describe("channel runtime controls", () => {
  it("offers the declared effort ladder for a provider-widened local model", () => {
    // Regression: catalog rows for a custom/local provider carry no capability
    // metadata, so building `efforts` straight off the row left the Slack and
    // Telegram model menus with NO effort choices for a local model that
    // declares graded reasoning.
    const controls = buildChannelRuntimeControls(configWith({
      local: [{
        id: "workstation",
        type: "openai_compat",
        baseUrl: "http://localhost:9000",
        enabled: true,
        models: [{
          name: "reasoner-1",
          capabilities: {
            reasoning: true,
            reasoning_mode: "effort",
            reasoning_levels: ["low", "medium", "high"],
          },
        }],
      }],
    }));

    const widened = controls.models.find((model) => model.value === "workstation:reasoner-1");
    expect(widened).toBeDefined();
    expect(widened?.efforts.map((effort) => effort.value)).toEqual(["low", "medium", "high"]);
  });

  it("offers a thinking toggle for a provider-widened local toggle model", () => {
    const controls = buildChannelRuntimeControls(configWith({
      local: [{
        id: "workstation",
        type: "openai_compat",
        baseUrl: "http://localhost:9000",
        enabled: true,
        models: [{
          name: "toggler-1",
          capabilities: { reasoning: true, reasoning_mode: "toggle" },
        }],
      }],
    }));

    const widened = controls.models.find((model) => model.value === "workstation:toggler-1");
    expect(widened?.efforts.map((effort) => effort.value)).toEqual(["high", "none"]);
  });

  it("offers no effort choices for a provider-widened non-reasoning local model", () => {
    const controls = buildChannelRuntimeControls(configWith({
      local: [{
        id: "workstation",
        type: "openai_compat",
        baseUrl: "http://localhost:9000",
        enabled: true,
        models: [{
          name: "plain-1",
          capabilities: { reasoning: false, reasoning_mode: "none" },
        }],
      }],
    }));

    const widened = controls.models.find((model) => model.value === "workstation:plain-1");
    expect(widened).toBeDefined();
    expect(widened?.efforts).toEqual([]);
  });

  it("keeps the configured primary route first with its own effort ladder", () => {
    const controls = buildChannelRuntimeControls(configWith(undefined));

    expect(controls.defaultModel).toBe("anthropic:claude-fable-5");
    expect(controls.defaultEffort).toBe("medium");
    expect(controls.models[0]?.value).toBe("anthropic:claude-fable-5");
    expect(controls.models[0]?.efforts.map((effort) => effort.value))
      .toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});
