import { describe, expect, it } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { CronAdapterOptions, CronAdapterStartResult } from "@mono-agent/cron-adapter";

import { createCronChannelDriver } from "../channels.js";

const noopResponder: AgentResponder = {
  async respond() {
    return {};
  },
};

const baseInput = {
  coreConfig: {} as never,
  responder: noopResponder,
  cwd: "/tmp",
  onFailure: () => {},
  config: {
    jobs: [{ id: "j", expression: "* * * * *", timezone: "UTC", prompt: "p", enabled: true }],
  },
} as never;

describe("cron channel driver — run watchdog", () => {
  it("passes a default maxRunMs so a hung run is reclaimed instead of blocking the job forever", async () => {
    let captured: CronAdapterOptions | undefined;
    const driver = createCronChannelDriver({
      adapterFactory: (options): CronAdapterStartResult => {
        captured = options;
        return { jobs: options.jobs, activeJobCount: 0, stop: () => {} };
      },
    });

    await driver.start(baseInput);

    expect(captured?.maxRunMs).toBe(20 * 60 * 1000);
    expect(captured?.overlap).toBe("skip");
  });

  it("honors an explicit maxRunMs override", async () => {
    let captured: CronAdapterOptions | undefined;
    const driver = createCronChannelDriver({
      maxRunMs: 5_000,
      adapterFactory: (options): CronAdapterStartResult => {
        captured = options;
        return { jobs: options.jobs, activeJobCount: 0, stop: () => {} };
      },
    });

    await driver.start(baseInput);

    expect(captured?.maxRunMs).toBe(5_000);
  });
});
