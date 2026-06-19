import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
import type { CronAdapterOptions, CronAdapterStartResult } from "@mono-agent/cron-adapter";
import { describe, expect, it, vi } from "vitest";

import { createCronChannelDriver } from "../channels.js";

describe("cron channel driver proactive-notify wiring", () => {
  it("maps job.notify and routes the scheduler's notify hook to the app router", async () => {
    let captured: CronAdapterOptions | undefined;
    const driver = createCronChannelDriver({
      adapterFactory: (options): CronAdapterStartResult => {
        captured = options;
        return { jobs: options.jobs, activeJobCount: 0, stop: () => undefined };
      },
    });
    const notifyDestination = vi.fn(async () => undefined);

    await driver.start({
      config: {
        jobs: [
          {
            id: "morning-brief",
            enabled: true,
            expression: "0 7 * * *",
            timezone: "UTC",
            prompt: "Compose the brief",
            notify: "telegram:5",
          },
        ],
      },
      coreConfig: {} as MonoAgentConfig,
      responder: { respond: vi.fn() } as unknown as AgentResponder,
      cwd: "/tmp",
      onFailure: () => undefined,
      notifyDestination,
    });

    expect(captured?.jobs[0]).toMatchObject({ id: "morning-brief", notify: "telegram:5" });
    expect(captured?.notify).toBeDefined();

    await captured?.notify?.({ conversationId: "telegram:5", text: "hi" });
    expect(notifyDestination).toHaveBeenCalledWith("telegram:5", "hi");
  });
});
