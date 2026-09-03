import { afterEach, describe, expect, it } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { TuiAdapterConfig } from "@mono-agent/operator-adapter";
import { OperatorClient } from "@mono-agent/web";

import type { ChannelStartInput, RunningChannel } from "../channels.js";
import { createTuiChannelDriver } from "../channels.js";

/**
 * The `/v1/info` producer and its console consumer, wired end to end over a
 * real loopback HTTP server.
 *
 * Every other `/v1/info` test in this package stops at the producer's info
 * builder. That is exactly the seam the previous round's provider test missed:
 * it constructed the 71-provider shape that breaks and passed, because nothing
 * ever parsed the body the way the console does. A wire contract is only proven
 * where both halves meet, so these cases go through `startTuiAdapter` and a
 * real `OperatorClient`.
 */

const noopResponder: AgentResponder = {
  async respond() {
    return {};
  },
};

interface WireOptions {
  readonly fallbackModels?: readonly { provider: string; model: string }[];
  readonly providerEntries?: readonly { id: string }[];
}

function wireInput(options: WireOptions): ChannelStartInput<TuiAdapterConfig> {
  return {
    coreConfig: {
      runtime: {
        model: { provider: "anthropic", model: "claude-fable-5", reference: "anthropic:claude-fable-5" },
        workspace: "/tmp",
        ...(options.fallbackModels === undefined ? {} : {
          fallbacks: options.fallbackModels.map((model) => ({
            model: { ...model, reference: `${model.provider}:${model.model}` },
          })),
        }),
      },
      context: { identityPath: "/tmp/IDENTITY.md", selectedSkills: [] },
      tools: { disallowedTools: [] },
      ...(options.providerEntries === undefined ? {} : { providers: { entries: options.providerEntries } }),
    } as never,
    responder: noopResponder,
    cwd: "/tmp",
    onFailure: () => {},
    config: {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      basePath: "/gui",
      allowNonLoopback: false,
    },
  };
}

const running: RunningChannel[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop();
});

/**
 * Start the REAL adapter and read `/v1/info` twice: once as bytes on the wire,
 * once through the REAL console client. Both halves of every assertion below
 * come from the same running server.
 */
async function readInfoOverTheWire(options: WireOptions) {
  const driver = createTuiChannelDriver({
    discoverModels: async () => [],
    discoverProviders: async () => [],
  });
  const channel = await driver.start(wireInput(options));
  running.push(channel);
  const baseUrl = channel.summary?.baseUrl;
  if (typeof baseUrl !== "string") throw new Error("The TUI adapter reported no base URL.");
  const text = await (await fetch(`${baseUrl}/v1/info`)).text();
  const bodyBytes = Buffer.byteLength(text, "utf8");
  const sent = JSON.parse(text) as { readonly providers?: readonly { readonly id: string }[] };
  const sentProviderIds = (sent.providers ?? []).map((provider) => provider.id);
  const info = await new OperatorClient({ baseUrl }).info();
  return { info, bodyBytes, sentProviderIds };
}

describe("/v1/info over the real producer -> consumer wire", () => {
  it("delivers a long but valid configured fallback to the console", async () => {
    // The model-reference grammar has no length bound, so this names a route a
    // turn really would run. The complete body stays far under the 1 MiB wire
    // cap, so no budget has any business dropping it.
    const model = "m".repeat(70_000);
    const { info, bodyBytes } = await readInfoOverTheWire({
      fallbackModels: [{ provider: "openrouter", model }],
    });

    expect(info.models).toContain(`openrouter:${model}`);
    // It really did ride the wire rather than being shed at the fence, and the
    // complete body is still nowhere near the cap that would show the agent
    // offline. (Measured on the parent of the budget commit: 140,731 bytes.)
    expect(bodyBytes).toBeGreaterThan(140_000);
    expect(bodyBytes).toBeLessThan(1024 * 1024);
  });

  it("delivers the configured route's provider when the catalog overflows the console's window", async () => {
    // 70 declared vendors plus the route provider the catalog appends last:
    // 71 entries, comfortably inside every byte budget, and one past the
    // console's 64-entry parse window. A producer that emits in catalog order
    // hands the console 64 vendors and no `anthropic`.
    const providerEntries = Array.from({ length: 70 }, (_unused, index) => ({
      id: `vendor-${String(index).padStart(5, "0")}`,
    }));

    const { info, sentProviderIds } = await readInfoOverTheWire({ providerEntries });

    // Guard against the case going vacuous: the producer must still be sending
    // more entries than the console will parse, or this proves nothing.
    expect(sentProviderIds.length).toBeGreaterThan(64);
    expect(sentProviderIds).toContain("anthropic");
    expect(info.providers?.map((provider) => provider.id)).toContain("anthropic");
  });

  it("agrees with the console on how long a provider id may be", async () => {
    // 129 bytes: one over the console's id bound, well inside the producer's.
    // Either both halves publish it or neither does; a slot spent on an entry
    // the consumer throws away is a provider the operator silently loses.
    const longId = `vendor-${"i".repeat(122)}`;
    expect(Buffer.byteLength(longId, "utf8")).toBe(129);

    const { info, sentProviderIds } = await readInfoOverTheWire({
      providerEntries: [{ id: longId }],
    });

    expect(sentProviderIds).toContain(longId);
    // Nothing the producer put inside the window is discarded on arrival.
    expect(info.providers?.map((provider) => provider.id)).toEqual(sentProviderIds);
  });
});
