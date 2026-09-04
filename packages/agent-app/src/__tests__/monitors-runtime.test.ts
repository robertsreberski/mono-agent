import { describe, expect, it, vi } from "vitest";

import type { MonoAgentConfig } from "@mono-agent/config";

import { runWithMonitorWakeContext } from "../monitors-context.js";
import { createMonitorsRuntimeExtension, monitorsAvailableForRequest } from "../monitors-runtime.js";
import {
  processJobSteeringDepth,
  registerProcessJobSteeringTarget,
} from "../process-jobs-context.js";
import type { MonitorsServiceHandle } from "../monitors-service.js";

function service(overrides: Partial<MonitorsServiceHandle> = {}): MonitorsServiceHandle {
  return {
    settings: { maxChainDepth: 4 },
    operatorToken: "token",
    controller: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
    list: async () => [],
    get: async () => undefined,
    cancel: async () => { throw new Error("unused"); },
    activateWakes: async () => undefined,
    stop: async () => undefined,
    ...overrides,
  } as unknown as MonitorsServiceHandle;
}

function config(tools: { allowedTools?: string[]; disallowedTools?: string[] } = {}): MonoAgentConfig {
  return {
    tools: {
      allowedTools: tools.allowedTools ?? ["*"],
      disallowedTools: tools.disallowedTools ?? [],
    },
  } as unknown as MonoAgentConfig;
}

const HOST_WAKE_DELIVERY_METADATA = Symbol.for("mono-agent.process-job-wake.delivery-key.v1");

function wakeRequest(conversationId: string, deliveryKey: string) {
  return request(conversationId, {
    telegram: { chat: { id: 42 } },
    [HOST_WAKE_DELIVERY_METADATA]: deliveryKey,
  });
}

function request(conversationId: string, metadata: Record<string, unknown> = {}) {
  return {
    request: {
      conversationId,
      replyTo: { conversationId },
      userMessage: "hi",
      metadata,
    },
    runId: "run-1",
  } as never;
}

async function inject(options: {
  readonly service?: MonitorsServiceHandle | undefined;
  readonly channelId?: string;
  readonly conversationId?: string;
  readonly coreConfig?: MonoAgentConfig;
  readonly routesOnlyPiNative?: (metadata: Record<string, unknown> | undefined) => boolean;
} = {}): Promise<Record<string, unknown>> {
  const extension = createMonitorsRuntimeExtension({
    service: "service" in options ? options.service : service(),
    coreConfig: options.coreConfig ?? config(),
    channelId: (options.channelId ?? "telegram") as never,
    ...(options.routesOnlyPiNative === undefined ? {} : { routesOnlyPiNative: options.routesOnlyPiNative }),
  });
  const result = await extension(request(options.conversationId ?? "telegram:42"));
  await result.settleCleanup?.();
  return (result.runtimeOptions ?? {}) as Record<string, unknown>;
}

describe("monitors runtime extension", () => {
  it("injects the controller for a Pi-only Telegram turn without a legacy sdk discriminator", async () => {
    expect(await inject()).toHaveProperty("monitors");
  });

  it("injects nothing without a service", async () => {
    expect(await inject({ service: undefined })).not.toHaveProperty("monitors");
  });

  it("refuses a request whose reachable routes are not all Pi-native", async () => {
    await expect(inject({ routesOnlyPiNative: () => false })).rejects.toThrow(/Pi-native/u);
  });

  it("injects nothing for a web-console origin, which cannot receive monitor wakes", async () => {
    expect(await inject({ channelId: "tui", conversationId: "web:thread-1" })).not.toHaveProperty("monitors");
  });

  it("injects nothing for cron and webhook turns, which have no origin channel", async () => {
    expect(await inject({ channelId: "cron", conversationId: "cron:sweep" })).not.toHaveProperty("monitors");
    expect(await inject({ channelId: "webhook", conversationId: "webhook:req-1" })).not.toHaveProperty("monitors");
  });

  it("requires both Monitor and MonitorStop to be permitted", async () => {
    expect(await inject({ coreConfig: config({ allowedTools: ["Monitor", "MonitorStop"] }) }))
      .toHaveProperty("monitors");
    expect(await inject({ coreConfig: config({ allowedTools: ["Monitor"] }) }))
      .not.toHaveProperty("monitors");
    expect(await inject({ coreConfig: config({ disallowedTools: ["MonitorStop"] }) }))
      .not.toHaveProperty("monitors");
    expect(await inject({ coreConfig: config({ disallowedTools: ["monitor"] }) }))
      .not.toHaveProperty("monitors");
  });

  it("stops injecting once a real wake chain reaches the ceiling", async () => {
    // Depth is not a parameter the caller supplies; it comes from the wake that
    // raised the turn. Drive a real wake context so the ceiling is exercised
    // rather than asserted against the depth-zero happy path.
    const shallow = service({ settings: { maxChainDepth: 1 } } as never);
    const deliveryKey = "monitor:mon-1:1";
    const request = wakeRequest("telegram:42", deliveryKey);

    const admitted = await runWithMonitorWakeContext({ monitorId: "mon-1", chainDepth: 0 }, async () => {
      const extension = createMonitorsRuntimeExtension({
        service: shallow,
        coreConfig: config(),
        channelId: "telegram" as never,
      });
      const result = await extension(request);
      await result.settleCleanup?.();
      return result.runtimeOptions ?? {};
    }, deliveryKey);
    expect(admitted).toHaveProperty("monitors");

    // One level deeper the same request must be refused.
    const refused = await runWithMonitorWakeContext({ monitorId: "mon-1", chainDepth: 1 }, async () => {
      const extension = createMonitorsRuntimeExtension({
        service: shallow,
        coreConfig: config(),
        channelId: "telegram" as never,
      });
      const result = await extension(request);
      await result.settleCleanup?.();
      return result.runtimeOptions ?? {};
    }, deliveryKey);
    expect(refused).not.toHaveProperty("monitors");
  });

  it("does not register a second steering target, which would break process-job steering", async () => {
    // The steering registry admits a steer only when EXACTLY one candidate
    // matches the conversation. A monitor registration alongside the process-job
    // one would silently downgrade every job wake to a follow-up turn.
    const lease = registerProcessJobSteeringTarget({
      conversationId: "telegram:42",
      runId: "run-1",
      chainDepth: 0,
    });
    try {
      expect(processJobSteeringDepth("telegram:42")).toBe(0);
      await inject();
      expect(processJobSteeringDepth("telegram:42")).toBe(0);
    } finally {
      lease.release();
    }
    expect(processJobSteeringDepth("telegram:42")).toBeUndefined();
  });
});

describe("monitorsAvailableForRequest", () => {
  it("agrees with the injection gate so prompt guidance cannot drift", () => {
    const options = { service: service(), coreConfig: config(), channelId: "telegram" as never };
    expect(monitorsAvailableForRequest(request("telegram:42"), options)).toBe(true);
    expect(monitorsAvailableForRequest(request("web:thread-1"), { ...options, channelId: "tui" as never })).toBe(false);
    expect(monitorsAvailableForRequest(request("telegram:42"), { ...options, service: undefined })).toBe(false);
    expect(monitorsAvailableForRequest(request("telegram:42"), {
      ...options,
      routesOnlyPiNative: () => false,
    })).toBe(false);
  });
});
