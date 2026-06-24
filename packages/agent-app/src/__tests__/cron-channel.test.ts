import { describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { CronAdapterConfig, CronAdapterOptions, CronAdapterStartResult } from "@mono-agent/cron-adapter";

import type { ChannelStartInput } from "../channels.js";
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
} satisfies ChannelStartInput<CronAdapterConfig>;

function succeededResult(text?: string) {
  return {
    kind: "succeeded" as const,
    jobId: "j",
    scheduledAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    ...(text === undefined ? {} : { text }),
  };
}

async function startCapturingCron(input: unknown): Promise<CronAdapterOptions> {
  let captured: CronAdapterOptions | undefined;
  const driver = createCronChannelDriver({
    adapterFactory: (options): CronAdapterStartResult => {
      captured = options;
      return { jobs: options.jobs, activeJobCount: 0, stop: () => {} };
    },
  });

  await driver.start(input as never);
  if (captured === undefined) {
    throw new Error("Cron adapter was not started.");
  }
  return captured;
}

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

  it("passes job-specific maxRunMs values through to the cron adapter", async () => {
    let captured: CronAdapterOptions | undefined;
    const driver = createCronChannelDriver({
      adapterFactory: (options): CronAdapterStartResult => {
        captured = options;
        return { jobs: options.jobs, activeJobCount: 0, stop: () => {} };
      },
    });
    const input = {
      ...baseInput,
      config: {
        jobs: [
          {
            id: "bills",
            expression: "0 9 * * *",
            timezone: "Europe/Rome",
            prompt: "p",
            enabled: true,
            maxRunMs: 2_700_000,
          },
        ],
      },
    } as never;

    await driver.start(input);

    expect(captured?.jobs).toEqual([
      {
        id: "bills",
        expression: "0 9 * * *",
        timezone: "Europe/Rome",
        prompt: "p",
        maxRunMs: 2_700_000,
      },
    ]);
  });
});

describe("cron channel driver — native notification delivery", () => {
  it("passes native notify settings through to the cron adapter", async () => {
    const captured = await startCapturingCron({
      ...baseInput,
      config: {
        jobs: [
          {
            id: "j",
            expression: "* * * * *",
            timezone: "UTC",
            prompt: "p",
            enabled: true,
            notify: true,
            notifyConversationId: "telegram:42",
          },
        ],
      },
    });

    expect(captured.jobs).toEqual([
      {
        id: "j",
        expression: "* * * * *",
        timezone: "UTC",
        prompt: "p",
        notify: true,
        notifyConversationId: "telegram:42",
      },
    ]);
  });

  it("delivers successful native notify jobs to the configured destination", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const captured = await startCapturingCron({
      ...baseInput,
      notifyDestination,
      config: {
        jobs: [
          {
            id: "j",
            expression: "* * * * *",
            timezone: "UTC",
            prompt: "p",
            enabled: true,
            notify: true,
            notifyConversationId: "telegram:42",
          },
        ],
      },
    });

    await captured.onResult?.(succeededResult("Morning brief"));

    await vi.waitFor(() => expect(notifyDestination).toHaveBeenCalledOnce());
    // Verbatim delivery: the final answer is posted as-is (no echo-turn wrapper).
    expect(notifyDestination).toHaveBeenCalledWith("telegram:42", "Morning brief", { verbatim: true });
    const deliveredText = (notifyDestination.mock.calls[0] as [string, string, unknown] | undefined)?.[1];
    expect(deliveredText).toBe("Morning brief");
    expect(deliveredText).not.toContain("Do not call tools");
  });

  it("infers a single notify destination when no destination is configured", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const listNotifyDestinations = vi.fn(async () => [
      { conversationId: "slack:C1", channelId: "slack" as const },
    ]);
    const captured = await startCapturingCron({
      ...baseInput,
      notifyDestination,
      listNotifyDestinations,
      config: {
        jobs: [
          {
            id: "j",
            expression: "* * * * *",
            timezone: "UTC",
            prompt: "p",
            enabled: true,
            notify: true,
          },
        ],
      },
    });

    await captured.onResult?.(succeededResult("Digest"));

    await vi.waitFor(() =>
      expect(notifyDestination).toHaveBeenCalledWith("slack:C1", "Digest", { verbatim: true }),
    );
  });

  it("skips native delivery for blank final text", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const captured = await startCapturingCron({
      ...baseInput,
      notifyDestination,
      config: {
        jobs: [
          {
            id: "j",
            expression: "* * * * *",
            timezone: "UTC",
            prompt: "p",
            enabled: true,
            notify: true,
            notifyConversationId: "telegram:42",
          },
        ],
      },
    });

    await captured.onResult?.(succeededResult("   "));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifyDestination).not.toHaveBeenCalled();
  });

  it("skips native delivery when the final text is the NOTHING_TO_REPORT sentinel", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const captured = await startCapturingCron({
      ...baseInput,
      notifyDestination,
      config: {
        jobs: [
          {
            id: "j",
            expression: "* * * * *",
            timezone: "UTC",
            prompt: "p",
            enabled: true,
            notify: true,
            notifyConversationId: "telegram:42",
          },
        ],
      },
    });

    await captured.onResult?.(succeededResult("  nothing_to_report  "));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifyDestination).not.toHaveBeenCalled();
  });

  it("skips and warns when destination inference has zero or multiple candidates", async () => {
    const warn = vi.fn();
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const listNotifyDestinations = vi.fn(async () => [
      { conversationId: "telegram:42", channelId: "telegram" as const },
      { conversationId: "slack:C1", channelId: "slack" as const },
    ]);
    const captured = await startCapturingCron({
      ...baseInput,
      logger: { warn },
      notifyDestination,
      listNotifyDestinations,
      config: {
        jobs: [
          {
            id: "j",
            expression: "* * * * *",
            timezone: "UTC",
            prompt: "p",
            enabled: true,
            notify: true,
          },
        ],
      },
    });

    await captured.onResult?.(succeededResult("Digest"));

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(notifyDestination).not.toHaveBeenCalled();
  });

  it("logs delivery failures without failing the cron result path", async () => {
    const warn = vi.fn();
    const notifyDestination = vi.fn(async () => ({ delivered: false, reason: "blocked" }));
    const captured = await startCapturingCron({
      ...baseInput,
      logger: { warn },
      notifyDestination,
      config: {
        jobs: [
          {
            id: "j",
            expression: "* * * * *",
            timezone: "UTC",
            prompt: "p",
            enabled: true,
            notify: true,
            notifyConversationId: "telegram:42",
          },
        ],
      },
    });

    expect(() => captured.onResult?.(succeededResult("Digest"))).not.toThrow();

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls.at(-1)?.[1]).toMatchObject({ jobId: "j", reason: "blocked" });
  });
});
