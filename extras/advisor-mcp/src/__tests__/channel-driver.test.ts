import { describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";

import { createAdvisorChannelDriver, createChannelDriver } from "../channel-driver.js";
import { AdvisorContinuityCache } from "../continuity.js";
import type { StartAdvisorServerOptions } from "../server.js";

const responder: AgentResponder = {
  async respond() {
    return { text: "review" };
  },
};

const input = {
  env: {},
  cwd: "/workspace",
  configPath: "/workspace/mono-agent.config.json",
};

describe("advisor channel driver", () => {
  it("loads plugin-scoped config with environment precedence", async () => {
    const driver = createChannelDriver({
      config: {
        enabled: true,
        port: 4000,
        model: "claude:json-model",
        effort: "high",
      },
    });
    const config = await driver.loadConfig({
      ...input,
      env: { MONO_AGENT_ADVISOR_PORT: "0", MONO_AGENT_ADVISOR_MODEL: "claude:env-model" },
    });
    expect(config).toMatchObject({ enabled: true, port: 0, model: "claude:env-model", effort: "high" });
    expect(driver.id).toBe("advisor");
    expect(driver.label).toBe("Advisor MCP");
    expect(driver.disabledReason?.(config)).toBeUndefined();
  });

  it("redacts bearer config view fields and bounds displayed values", async () => {
    const driver = createAdvisorChannelDriver({
      id: "reviewer",
      label: "Reviewer",
      config: {
        enabled: false,
        bearerToken: "do-not-show",
        operatorPrompt: "x".repeat(400),
      },
    });
    const section = await driver.configView?.(input);
    expect(section).toMatchObject({ id: "reviewer", label: "Reviewer", status: "disabled" });
    const bearer = section?.fields.find((field) => field.id === "advisor.bearerToken");
    const prompt = section?.fields.find((field) => field.id === "advisor.operatorPrompt");
    expect(bearer).toMatchObject({ value: "set", redacted: true, source: "json" });
    expect(JSON.stringify(section)).not.toContain("do-not-show");
    expect(String(prompt?.value).length).toBeLessThanOrEqual(256);
  });

  it("starts the HTTP server with the host responder and stops it", async () => {
    const stop = vi.fn(async () => {});
    const continuity = new AdvisorContinuityCache({ maxSessions: 2, ttlMs: 100 });
    const serverFactory = vi.fn(async (_options: StartAdvisorServerOptions) => ({
      url: "http://127.0.0.1:4312/mcp",
      host: "127.0.0.1",
      port: 4312,
      path: "/mcp",
      continuity,
      stop,
    }));
    const driver = createAdvisorChannelDriver({
      config: { enabled: true, model: "claude:model", effort: "xhigh" },
      serverFactory,
    });
    const config = await driver.loadConfig(input);
    const running = await driver.start({
      config,
      coreConfig: {},
      responder,
      cwd: input.cwd,
      onFailure: vi.fn(),
    });
    expect(serverFactory).toHaveBeenCalledTimes(1);
    expect(serverFactory.mock.calls[0]?.[0]).toMatchObject({ config });
    expect(running.summary).toMatchObject({
      url: "http://127.0.0.1:4312/mcp",
      tool: "review_iteration",
      model: "claude:model",
      effort: "xhigh",
    });
    await running.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("reports typed config errors and disabled state", async () => {
    const malformed = createAdvisorChannelDriver({ config: { enabled: "yes" } });
    let error: unknown;
    try {
      await malformed.loadConfig(input);
    } catch (caught) {
      error = caught;
    }
    expect(malformed.isConfigError(error)).toBe(true);
    const disabled = createAdvisorChannelDriver({ config: {} });
    const config = await disabled.loadConfig(input);
    expect(disabled.disabledReason?.(config)).toBe("Advisor MCP is disabled.");
  });
});
