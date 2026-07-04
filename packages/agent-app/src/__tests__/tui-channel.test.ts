import { describe, expect, it } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { TuiAdapterConfig, TuiAdapterOptions, TuiAdapterStartResult } from "@mono-agent/tui-adapter";

import type { ChannelStartInput } from "../channels.js";
import { createTuiChannelDriver } from "../channels.js";

const noopResponder: AgentResponder = {
  async respond() {
    return {};
  },
};

const baseConfig: TuiAdapterConfig = {
  enabled: true,
  host: "127.0.0.1",
  port: 0,
  basePath: "/tui",
  allowNonLoopback: false,
};

function baseInput(
  effort?: string,
  fallbackModels?: readonly { sdk: string; model: string; reference?: string }[],
): ChannelStartInput<TuiAdapterConfig> {
  return {
    coreConfig: {
      runtime: {
        model: { sdk: "claude-sdk", model: "claude-fable-5" },
        ...(effort === undefined ? {} : { effort }),
        ...(fallbackModels === undefined ? {} : { fallbackModels }),
      },
    } as never,
    responder: noopResponder,
    cwd: "/tmp",
    onFailure: () => {},
    config: baseConfig,
  };
}

async function startCapturingTui(
  effort?: string,
  fallbackModels?: readonly { sdk: string; model: string; reference?: string }[],
): Promise<TuiAdapterOptions> {
  let captured: TuiAdapterOptions | undefined;
  const driver = createTuiChannelDriver({
    adapterFactory: (options): Promise<TuiAdapterStartResult> => {
      captured = options;
      return Promise.resolve({
        url: "http://127.0.0.1:0",
        baseUrl: "http://127.0.0.1:0/tui",
        infoUrl: "http://127.0.0.1:0/tui/v1/info",
        turnsUrl: "http://127.0.0.1:0/tui/v1/turns",
        host: "127.0.0.1",
        port: 0,
        stop: () => Promise.resolve(),
      });
    },
  });

  await driver.start(baseInput(effort, fallbackModels));
  if (captured === undefined) {
    throw new Error("TUI adapter was not started.");
  }
  return captured;
}

describe("tui channel driver — info composition", () => {
  it("passes the configured runtime effort through to the adapter's info", async () => {
    const captured = await startCapturingTui("high");

    expect(captured.info).toEqual({
      model: "claude-sdk:claude-fable-5",
      effort: "high",
      models: ["claude-sdk:claude-fable-5"],
    });
  });

  it("omits effort from info when the runtime has none configured", async () => {
    const captured = await startCapturingTui(undefined);

    expect(captured.info).toEqual({
      model: "claude-sdk:claude-fable-5",
      models: ["claude-sdk:claude-fable-5"],
    });
  });

  it("lists the primary then fallback models as candidate models, de-duplicated", async () => {
    const captured = await startCapturingTui(undefined, [
      { sdk: "codex", model: "gpt-5.5" },
      { sdk: "claude-sdk", model: "claude-fable-5" },
    ]);

    expect(captured.info?.models).toEqual(["claude-sdk:claude-fable-5", "codex:gpt-5.5"]);
  });
});
