import { describe, expect, it } from "vitest";

import type { ChannelDriver, ChannelId, RunningChannel } from "../channels.js";
import { listChannelAvailability } from "../channels.js";

const input = { env: {}, cwd: "/tmp", configPath: "/tmp/mono-agent.config.json" };

function fakeDriver(id: ChannelId, behavior: Partial<ChannelDriver>): ChannelDriver {
  return {
    id,
    label: id,
    async loadConfig() {
      return {};
    },
    isConfigError() {
      return false;
    },
    async start(): Promise<RunningChannel> {
      return { summary: {}, stop: async () => undefined };
    },
    ...behavior,
  };
}

describe("listChannelAvailability", () => {
  it("reports each channel's state from config without starting it", async () => {
    const drivers: ChannelDriver[] = [
      fakeDriver("telegram", {}), // enabled (no disabled/waiting reason)
      fakeDriver("slack", { disabledReason: () => "Slack is disabled." }),
      fakeDriver("a2a", { waitingReason: () => "A2A provider requires agent and skill configuration." }),
      fakeDriver("whatsapp", {
        async loadConfig() {
          throw new Error("incomplete whatsapp config");
        },
        isConfigError: () => true,
      }),
    ];

    const result = await listChannelAvailability(input, drivers);

    expect(result).toEqual([
      { id: "telegram", label: "telegram", state: "enabled" },
      { id: "slack", label: "slack", state: "disabled", reason: "Slack is disabled." },
      { id: "a2a", label: "a2a", state: "waiting", reason: "A2A provider requires agent and skill configuration." },
      { id: "whatsapp", label: "whatsapp", state: "waiting", reason: "incomplete whatsapp config" },
    ]);
  });

  it("rethrows a non-config-error from loadConfig", async () => {
    const drivers: ChannelDriver[] = [
      fakeDriver("telegram", {
        async loadConfig() {
          throw new Error("unexpected boom");
        },
        isConfigError: () => false,
      }),
    ];

    await expect(listChannelAvailability(input, drivers)).rejects.toThrow(/unexpected boom/u);
  });
});
