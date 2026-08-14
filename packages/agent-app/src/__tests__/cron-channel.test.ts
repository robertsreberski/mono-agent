import { describe, expect, it, vi } from "vitest";

import { MAX_CRON_OPERATOR_DEGRADED_REASON_BYTES, type AgentResponder } from "@mono-agent/agent-contracts";
import type {
  CronAdapterConfig,
  CronAdapterOptions,
  CronAdapterStartResult,
  CronFiringIdentity,
} from "@mono-agent/cron-adapter";

import type { ChannelStartInput, CronChannelOverrides } from "../channels.js";
import { createCronChannelDriver } from "../channels.js";
import type { CronControlStore } from "../cron-control-store.js";
import { CronOperatorRegistry } from "../cron-operator-service.js";

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
    controlInspection: { status: "absent" as const },
    effectiveEnabledByJobId: new Map([["j", true]]),
  },
} satisfies ChannelStartInput<CronAdapterConfig & {
  readonly controlInspection: { readonly status: "absent" };
  readonly effectiveEnabledByJobId: ReadonlyMap<string, boolean>;
}>;

const testControlStore: CronControlStore = {
  paths: { root: "/test", marker: "/test/marker", database: "/test/state", lease: "/test/lease" },
  overrides: () => new Map(),
  syncConfiguredJobs: () => {},
  knownJobIds: () => [],
  allocateFiring: (input) => firing(input.jobId, input.scheduledAt),
  replayRunNowAction: () => undefined,
  runNowAction: (input) => ({ firing: firing(input.jobId, input.observedAt), replayed: false }),
  replayEnabledAction: () => undefined,
  setEnabledAction: (input) => ({ enabled: input.enabled, replayed: false }),
  markStarted: () => {},
  appendEvent: () => {},
  recordResult: () => {},
  getRun: () => undefined,
  getRunSummary: () => undefined,
  lastRun: () => undefined,
  runs: () => ({ runs: [] }),
  audit: () => {},
  close: async () => {},
};

function firing(jobId: string, at: string): CronFiringIdentity {
  return {
    runId: `cron:${encodeURIComponent(jobId)}:${at}`,
    jobId,
    scheduledAt: at,
    orderedAt: at,
    sequence: 1,
    trigger: "scheduled",
  };
}

function adapterResult(options: CronAdapterOptions): CronAdapterStartResult {
  const enabled = new Map(options.jobs.map((job) => [job.id, job.enabled !== false]));
  const snapshots = () => options.jobs.map((job) => ({
    jobId: job.id,
    expression: job.expression,
    timezone: job.timezone ?? "UTC",
    effectiveEnabled: enabled.get(job.id) === true,
    conversationId: job.conversationId ?? `cron:${job.id}`,
  }));
  return {
    jobs: options.jobs,
    activeJobCount: 0,
    snapshots,
    runNow: (jobId, admitted) => admitted ?? firing(jobId, "2026-01-01T00:00:00.000Z"),
    setEffectiveEnabled: (jobId, value) => {
      enabled.set(jobId, value);
      const snapshot = snapshots().find((entry) => entry.jobId === jobId);
      if (snapshot === undefined) throw new Error(`Unknown job ${jobId}`);
      return snapshot;
    },
    stop: () => {},
  };
}

function cronOverrides(overrides: CronChannelOverrides = {}): CronChannelOverrides {
  return {
    openControlStore: async () => testControlStore,
    inspectControlStore: async () => ({ status: "absent" }),
    ...overrides,
  };
}

function succeededResult(text?: string, notifyConversationId?: string, jobId = "j") {
  const cronRunId = `cron:${encodeURIComponent(jobId)}:2026-01-01T00:00:00.000Z`;
  return {
    kind: "succeeded" as const,
    jobId,
    cronRunId,
    scheduledAt: "2026-01-01T00:00:00.000Z",
    orderedAt: "2026-01-01T00:00:00.000Z",
    sequence: 1,
    trigger: "scheduled" as const,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    ...(notifyConversationId === undefined ? {} : { notifyConversationId }),
    ...(text === undefined ? {} : { text }),
  };
}

function failedResult(
  error = "No API key for provider: openai-codex",
  failureKind = "provider_unavailable_exhausted",
  jobId = "j",
) {
  const cronRunId = `cron:${encodeURIComponent(jobId)}:2026-01-01T00:00:00.000Z`;
  return {
    kind: "failed" as const,
    jobId,
    cronRunId,
    scheduledAt: "2026-01-01T00:00:00.000Z",
    orderedAt: "2026-01-01T00:00:00.000Z",
    sequence: 1,
    trigger: "scheduled" as const,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    error,
    failureKind,
  };
}

async function startCapturingCron(
  input: unknown,
  overrides: CronChannelOverrides = {},
): Promise<CronAdapterOptions> {
  let captured: CronAdapterOptions | undefined;
  const driver = createCronChannelDriver(cronOverrides({
    ...overrides,
    adapterFactory: (options): CronAdapterStartResult => {
      captured = options;
      return adapterResult(options);
    },
  }));

  await driver.start(input as never);
  if (captured === undefined) {
    throw new Error("Cron adapter was not started.");
  }
  return captured;
}

describe("cron channel driver — run watchdog", () => {
  it("passes a default maxRunMs so a hung run is reclaimed instead of blocking the job forever", async () => {
    let captured: CronAdapterOptions | undefined;
    const driver = createCronChannelDriver(cronOverrides({
      adapterFactory: (options): CronAdapterStartResult => {
        captured = options;
        return adapterResult(options);
      },
    }));

    await driver.start(baseInput);

    expect(captured?.maxRunMs).toBe(20 * 60 * 1000);
    expect(captured?.overlap).toBe("skip");
  });

  it("honors an explicit maxRunMs override", async () => {
    let captured: CronAdapterOptions | undefined;
    const driver = createCronChannelDriver(cronOverrides({
      maxRunMs: 5_000,
      adapterFactory: (options): CronAdapterStartResult => {
        captured = options;
        return adapterResult(options);
      },
    }));

    await driver.start(baseInput);

    expect(captured?.maxRunMs).toBe(5_000);
  });

  it("passes job-specific maxRunMs values through to the cron adapter", async () => {
    let captured: CronAdapterOptions | undefined;
    const driver = createCronChannelDriver(cronOverrides({
      adapterFactory: (options): CronAdapterStartResult => {
        captured = options;
        return adapterResult(options);
      },
    }));
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
        enabled: true,
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
        enabled: true,
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
    expect(notifyDestination).toHaveBeenCalledWith("telegram:42", "Morning brief", {
      verbatim: true,
      deliveryContext: {
        kind: "cron",
        jobId: "j",
        runId: "cron:j:2026-01-01T00:00:00.000Z",
      },
    });
    const deliveredText = (notifyDestination.mock.calls[0] as [string, string, unknown] | undefined)?.[1];
    expect(deliveredText).toBe("Morning brief");
    expect(deliveredText).not.toContain("Do not call tools");
  });

  it("adds stable success and failure delivery keys only for web:new", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const captured = await startCapturingCron({
      ...baseInput,
      notifyDestination,
      config: {
        jobs: [{
          id: "daily brief",
          expression: "* * * * *",
          timezone: "UTC",
          prompt: "p",
          enabled: true,
          notify: true,
          notifyConversationId: "web:new",
        }],
      },
    });

    await captured.onResult?.(succeededResult("Morning brief", undefined, "daily brief"));
    await vi.waitFor(() => expect(notifyDestination).toHaveBeenCalledTimes(1));
    expect(notifyDestination).toHaveBeenLastCalledWith("web:new", "Morning brief", {
      verbatim: true,
      deliveryKey: "cron:daily%20brief:2026-01-01T00:00:00.000Z:success",
      deliveryContext: {
        kind: "cron",
        jobId: "daily brief",
        runId: "cron:daily%20brief:2026-01-01T00:00:00.000Z",
      },
    });

    await captured.onResult?.(failedResult(undefined, undefined, "daily brief"));
    await vi.waitFor(() => expect(notifyDestination).toHaveBeenCalledTimes(2));
    const failureCall = notifyDestination.mock.calls[1] as unknown as [string, string, unknown];
    expect(failureCall[2]).toEqual({
      verbatim: true,
      deliveryKey: "cron:daily%20brief:2026-01-01T00:00:00.000Z:failure:provider_unavailable_exhausted",
      deliveryContext: {
        kind: "cron",
        jobId: "daily brief",
        runId: "cron:daily%20brief:2026-01-01T00:00:00.000Z",
      },
    });
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

    expect(captured.jobs[0]).not.toHaveProperty("notifyFallbackConversationId");
    const notifyConversationId = await captured.resolveNotifyFallbackConversationId?.();
    expect(notifyConversationId).toBe("slack:C1");

    await captured.onResult?.(succeededResult("Digest", notifyConversationId));

    await vi.waitFor(() =>
      expect(notifyDestination).toHaveBeenCalledWith("slack:C1", "Digest", {
        verbatim: true,
        deliveryContext: {
          kind: "cron",
          jobId: "j",
          runId: "cron:j:2026-01-01T00:00:00.000Z",
        },
      }),
    );
  });

  it("re-resolves inferred destinations per run and delivers only on the route bound to that run", async () => {
    const warn = vi.fn();
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    let candidates = [
      { conversationId: "slack:C1", channelId: "slack" as const },
    ];
    const listNotifyDestinations = vi.fn(async () => candidates);
    const captured = await startCapturingCron({
      ...baseInput,
      logger: { warn },
      notifyDestination,
      listNotifyDestinations,
      config: {
        jobs: [{
          id: "j",
          expression: "* * * * *",
          timezone: "UTC",
          prompt: "p",
          enabled: true,
          notify: true,
        }],
      },
    });

    expect(listNotifyDestinations).not.toHaveBeenCalled();
    const firstRoute = await captured.resolveNotifyFallbackConversationId?.();
    candidates = [
      { conversationId: "slack:C1", channelId: "slack" as const },
      { conversationId: "slack:C2", channelId: "slack" as const },
    ];
    // The first run keeps the route it resolved before starting even though a
    // second candidate appears before completion; replyTo and delivery cannot drift.
    await captured.onResult?.(succeededResult("First digest", firstRoute));
    await vi.waitFor(() =>
      expect(notifyDestination).toHaveBeenCalledWith("slack:C1", "First digest", {
        verbatim: true,
        deliveryContext: {
          kind: "cron",
          jobId: "j",
          runId: "cron:j:2026-01-01T00:00:00.000Z",
        },
      }),
    );

    const secondRoute = await captured.resolveNotifyFallbackConversationId?.();
    expect(secondRoute).toBeUndefined();
    await captured.onResult?.(succeededResult("Second digest", secondRoute));
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    expect(notifyDestination).toHaveBeenCalledTimes(1);
    expect(listNotifyDestinations).toHaveBeenCalledTimes(2);
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

  it("skips native delivery, and warns, when a model narrates before the sentinel", async () => {
    // Regression: a cron run that failed over to another vendor's model wrote its
    // whole assessment before the marker. Whole-string matching delivered all of
    // it to a shared channel. Suppression is right, but silence about it is not —
    // the warning is what makes an off-contract model visible.
    const warn = vi.fn();
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
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

    await captured.onResult?.(succeededResult("Checked every topic.\n\n- No active rows.\n\nNOTHING_TO_REPORT"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifyDestination).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("NOTHING_TO_REPORT"), { jobId: "j" });
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

  it("delivers one verbatim model-exhaustion failure notice and rate-limits repeats", async () => {
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

    const result = failedResult("No API key for provider: openai-codex\nretry failed");
    await captured.onResult?.(result);
    await captured.onResult?.(result);

    await vi.waitFor(() => expect(notifyDestination).toHaveBeenCalledTimes(1));
    expect(notifyDestination).toHaveBeenCalledWith(
      "telegram:42",
      'Cron job "j" failed: all configured models failed. Latest error: No API key for provider: openai-codex retry failed',
      {
        verbatim: true,
        deliveryContext: {
          kind: "cron",
          jobId: "j",
          runId: "cron:j:2026-01-01T00:00:00.000Z",
        },
      },
    );
    const deliveredText = (notifyDestination.mock.calls[0] as [string, string, unknown] | undefined)?.[1];
    expect(deliveredText).not.toContain("\n");
  });

  it("does not consume the failure notice cooldown when delivery throws", async () => {
    const warn = vi.fn();
    const notifyDestination = vi.fn()
      .mockRejectedValueOnce(new Error("transport offline"))
      .mockResolvedValueOnce({ delivered: true });
    let now = new Date("2026-01-01T00:00:00.000Z");
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
            notifyFailureCooldownHours: 1,
          },
        ],
      },
    }, { now: () => now });

    await captured.onResult?.(failedResult());
    await vi.waitFor(() => expect(notifyDestination).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      "Cron failure notice failed.",
      expect.objectContaining({ jobId: "j", reason: "transport offline" }),
    ));

    now = new Date("2026-01-01T00:05:00.000Z");
    await captured.onResult?.(failedResult());

    await vi.waitFor(() => expect(notifyDestination).toHaveBeenCalledTimes(2));
  });

  it("uses a job-specific failure notice cooldown", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    let now = new Date("2026-01-01T00:00:00.000Z");
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
            notifyFailureCooldownHours: 1,
          },
        ],
      },
    }, { now: () => now });

    await captured.onResult?.(failedResult());
    await vi.waitFor(() => expect(notifyDestination).toHaveBeenCalledTimes(1));

    now = new Date("2026-01-01T00:59:00.000Z");
    await captured.onResult?.(failedResult());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notifyDestination).toHaveBeenCalledTimes(1);

    now = new Date("2026-01-01T01:01:00.000Z");
    await captured.onResult?.(failedResult());
    await vi.waitFor(() => expect(notifyDestination).toHaveBeenCalledTimes(2));
  });

  it("does not send failure notices for non-exhausted failures or missing explicit destinations", async () => {
    const notifyDestination = vi.fn(async () => ({ delivered: true }));
    const listNotifyDestinations = vi.fn(async () => [
      { conversationId: "telegram:42", channelId: "telegram" as const },
    ]);
    const nonExhausted = await startCapturingCron({
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
    await nonExhausted.onResult?.(failedResult("provider unavailable", "provider_unavailable"));

    const missingDestination = await startCapturingCron({
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
    await missingDestination.onResult?.(failedResult());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifyDestination).not.toHaveBeenCalled();
  });
});

describe("cron channel driver — durable effective state", () => {
  it("starts an inert first-run adapter when controls can enable config-disabled jobs", async () => {
    let captured: CronAdapterOptions | undefined;
    const driver = createCronChannelDriver({
      inspectControlStore: async () => ({ status: "absent" }),
      openControlStore: async () => testControlStore,
      adapterFactory: (options) => {
        captured = options;
        return adapterResult(options);
      },
    });
    const config = {
      jobs: [{ id: "j", expression: "* * * * *", timezone: "UTC", prompt: "p", enabled: false }],
      operatorActionsEnabled: true,
      controlInspection: { status: "absent" as const },
      effectiveEnabledByJobId: new Map([["j", false]]),
    };

    expect(driver.disabledReason?.(config)).toBeUndefined();
    const running = await driver.start({ ...baseInput, config });

    expect(captured?.jobs).toEqual([expect.objectContaining({ id: "j", enabled: false })]);
    expect(running.summary).toEqual({ jobs: 0, configuredJobs: 1 });
  });

  it("starts a config-disabled job when the agent-owned runtime override enables it", async () => {
    let captured: CronAdapterOptions | undefined;
    const overriddenStore: CronControlStore = {
      ...testControlStore,
      overrides: () => new Map([["j", true]]),
    };
    const driver = createCronChannelDriver({
      inspectControlStore: async () => ({ status: "ready", overrides: new Map([["j", true]]) }),
      openControlStore: async () => overriddenStore,
      adapterFactory: (options) => {
        captured = options;
        return adapterResult(options);
      },
    });
    const config = {
      jobs: [{ id: "j", expression: "* * * * *", timezone: "UTC", prompt: "p", enabled: false }],
      controlInspection: { status: "ready" as const, overrides: new Map([["j", true]]) },
      effectiveEnabledByJobId: new Map([["j", true]]),
    };

    expect(driver.disabledReason?.(config)).toBeUndefined();
    const running = await driver.start({ ...baseInput, config });

    expect(captured?.jobs).toEqual([expect.objectContaining({ id: "j", enabled: true })]);
    expect(running.summary).toEqual({ jobs: 1, configuredJobs: 1 });
  });

  it("publishes an immutable replacement summary after an effective-enable action", async () => {
    const registry = new CronOperatorRegistry();
    const onSummaryChanged = vi.fn();
    const driver = createCronChannelDriver({
      inspectControlStore: async () => ({ status: "absent" }),
      openControlStore: async () => testControlStore,
      adapterFactory: adapterResult,
    }, registry);
    const config = {
      jobs: [{ id: "j", expression: "* * * * *", timezone: "UTC", prompt: "p", enabled: true }],
      operatorActionsEnabled: true,
      controlInspection: { status: "absent" as const },
      effectiveEnabledByJobId: new Map([["j", true]]),
    };
    const running = await driver.start({ ...baseInput, config, onSummaryChanged });

    const confirmation = registry.setEffectiveEnabled("j", false, { idempotencyKey: "disable-summary" });
    if (confirmation instanceof Promise || confirmation.kind !== "confirmation_required") {
      throw new Error("confirmation required");
    }
    expect(registry.setEffectiveEnabled("j", false, {
      idempotencyKey: "disable-summary",
      confirmationToken: confirmation.confirmation.token,
    })).toMatchObject({ kind: "completed", value: { job: { effectiveEnabled: false } } });

    expect(onSummaryChanged).toHaveBeenCalledWith({ jobs: 0, configuredJobs: 1 });
    expect(running.summary).toEqual({ jobs: 1, configuredJobs: 1 });
  });

  it("disables operator actions immediately when the running scheduler degrades", async () => {
    let captured: CronAdapterOptions | undefined;
    const onDegraded = vi.fn();
    const registry = new CronOperatorRegistry();
    const driver = createCronChannelDriver({
      inspectControlStore: async () => ({ status: "absent" }),
      openControlStore: async () => testControlStore,
      adapterFactory: (options) => {
        captured = options;
        return adapterResult(options);
      },
    }, registry);
    const config = {
      jobs: [{ id: "j", expression: "* * * * *", timezone: "UTC", prompt: "p", enabled: true }],
      operatorActionsEnabled: true,
      controlInspection: { status: "absent" as const },
      effectiveEnabledByJobId: new Map([["j", true]]),
    };
    await driver.start({ ...baseInput, config, onDegraded });
    expect(registry.overview()).toMatchObject({ actionsEnabled: true, jobs: [{ health: "unknown" }] });

    const runtimeReason = `runtime store failed: ${"x".repeat(MAX_CRON_OPERATOR_DEGRADED_REASON_BYTES * 2)}`;
    captured?.onDegraded?.(runtimeReason);

    const degraded = registry.overview();
    if (degraded instanceof Promise) throw new Error("synchronous registry expected");
    expect(degraded).toMatchObject({
      actionsEnabled: false,
      degradedReason: expect.stringContaining("runtime store failed"),
      jobs: [{ health: "unknown" }],
    });
    expect(Buffer.byteLength(degraded.degradedReason!, "utf8"))
      .toBeLessThanOrEqual(MAX_CRON_OPERATOR_DEGRADED_REASON_BYTES);
    expect(() => registry.runNow("j", { idempotencyKey: "degraded-runtime" }))
      .toThrowError(expect.objectContaining({
        code: "actions_disabled",
        message: expect.stringContaining("runtime store failed"),
      }));
    expect(onDegraded).toHaveBeenCalledWith(runtimeReason);
  });

  it("halts every job, logs at error level, and exposes degraded operator state on control corruption", async () => {
    const error = vi.fn();
    const onDegraded = vi.fn();
    let captured: CronAdapterOptions | undefined;
    const registry = new CronOperatorRegistry();
    const driver = createCronChannelDriver({
      inspectControlStore: async () => ({ status: "degraded", reason: "state marker is corrupt" }),
      openControlStore: async () => { throw new Error("state marker is corrupt"); },
      adapterFactory: (options) => {
        captured = options;
        return adapterResult(options);
      },
    }, registry);
    const config = {
      jobs: [{ id: "j", expression: "* * * * *", timezone: "UTC", prompt: "p", enabled: true }],
      controlInspection: { status: "degraded" as const, reason: "state marker is corrupt" },
      effectiveEnabledByJobId: new Map([["j", false]]),
    };

    expect(driver.configIssues?.(config)).toContain("Cron control state is unavailable: state marker is corrupt");
    const running = await driver.start({
      ...baseInput,
      config,
      logger: { error },
      onDegraded,
    });

    expect(captured?.jobs).toEqual([expect.objectContaining({ id: "j", enabled: false })]);
    expect(running.summary).toEqual({ jobs: 0, configuredJobs: 1 });
    expect(onDegraded).toHaveBeenCalledWith("state marker is corrupt");
    captured?.onDegraded?.("runtime store failed");
    expect(onDegraded).toHaveBeenLastCalledWith("runtime store failed");
    expect(error).toHaveBeenCalledWith(
      "Cron control state is unavailable; no cron jobs will be armed.",
      { reason: "state marker is corrupt" },
    );
    expect(registry.overview()).toMatchObject({
      actionsEnabled: false,
      degradedReason: "runtime store failed",
      jobs: [{ jobId: "j", effectiveEnabled: false, health: "unknown" }],
    });
  });
});
