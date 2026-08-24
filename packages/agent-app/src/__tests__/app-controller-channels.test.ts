import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";

import {
  applyResult,
  startChannel,
  stopChannel,
  type ChannelsControllerPort,
} from "../app-controller-channels.js";
import type { ChannelDriver, ChannelStartInput, ChannelStatus } from "../channels.js";
import { MemoryResponderAdmissionGate } from "../memory-operator-lifecycle.js";
import type { ProcessJobsServiceHandle } from "../process-jobs-service.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("app channel capability composition", () => {
  it.each(["slack", "third-party"])(
    "does not pass process-job service authority through the generic %s driver path",
    async (id) => {
      const cwd = await mkdtemp(join(tmpdir(), "mono-channel-capability-"));
      fixtures.push(cwd);
      const configReadPath = join(cwd, "mono-agent.config.json");
      await writeFile(configReadPath, JSON.stringify({
        runtime: { model: "pi:openai-codex:gpt-5.5", workspace: "." },
        context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
        tools: { allowedTools: [], disallowedTools: [] },
        artifacts: { dir: "./artifacts" },
      }));

      let captured: ChannelStartInput<unknown> | undefined;
      const driver: ChannelDriver = {
        id,
        label: id,
        loadConfig: async () => ({}),
        isConfigError: () => false,
        start: async (input) => {
          captured = input;
          return { summary: {}, stop: async () => undefined };
        },
      };
      const processJobsService = {
        operatorToken: "owner-token-must-not-leak",
        list: vi.fn(async () => []),
        get: vi.fn(async () => undefined),
        cancel: vi.fn(async () => { throw new Error("must not run"); }),
      } as unknown as ProcessJobsServiceHandle;
      const statuses = new Map<string, ChannelStatus>();
      const responder: AgentResponder = { respond: async () => ({}) };
      const controller: ChannelsControllerPort = {
        env: {},
        cwd,
        configReadPath,
        logger: undefined,
        drivers: [driver],
        driversById: new Map([[id, driver]]),
        statuses,
        running: new Map(),
        channelStartGenerations: new Map(),
        startsInFlight: new Map(),
        memoryResponderGate: new MemoryResponderAdmissionGate(),
        stopped: false,
        traceabilityStatusValue: {} as never,
        processJobsService,
        processJobsDegradation: undefined,
        setStatus(channelId, status) {
          statuses.set(channelId, status);
          return status;
        },
        rememberSelectedSkills: () => undefined,
        ensureInteractionBridge: async () => undefined,
        ensureContinuationService: async () => undefined,
        buildResponder: async () => responder,
        notifyDestination: async () => ({ delivered: false }),
        listNotifyDestinations: async () => [],
        observabilityContext: async () => ({}),
        refreshTraceSource: async () => undefined,
        activeTransports: () => [],
      };

      await expect(startChannel(controller, driver, "test"))
        .resolves.toMatchObject({ kind: "running" });
      expect(captured).toBeDefined();
      expect(Reflect.has(captured!, "processJobs")).toBe(false);
      expect(Object.values(captured!)).not.toContain(processJobsService);
      expect(JSON.stringify(captured)).not.toContain("owner-token-must-not-leak");
      expect(processJobsService.list).not.toHaveBeenCalled();
      expect(processJobsService.get).not.toHaveBeenCalled();
      expect(processJobsService.cancel).not.toHaveBeenCalled();
    },
  );

  it("publishes a channel as degraded when memory integrity fails before running publication", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-channel-memory-integrity-"));
    fixtures.push(cwd);
    const configReadPath = join(cwd, "mono-agent.config.json");
    await writeFile(configReadPath, JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.5", workspace: "." },
      context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
      tools: { allowedTools: [], disallowedTools: [] },
      artifacts: { dir: "./artifacts" },
    }));

    const gate = new MemoryResponderAdmissionGate();
    let recoverTransport: (() => void) | undefined;
    const driver: ChannelDriver = {
      id: "tui",
      label: "TUI",
      loadConfig: async () => ({}),
      isConfigError: () => false,
      start: async (input) => {
        recoverTransport = input.onRecovered;
        // Models the synchronous constructor callback before startChannel has
        // published the returned transport in controller.running.
        gate.degradeForIntegrityFailure("Memory action integrity failed; reload required.");
        return { summary: { baseUrl: "http://127.0.0.1:1" }, stop: async () => undefined };
      },
    };
    const statuses = new Map<string, ChannelStatus>();
    const controller: ChannelsControllerPort = {
      env: {},
      cwd,
      configReadPath,
      logger: undefined,
      drivers: [driver],
      driversById: new Map([[driver.id, driver]]),
      statuses,
      running: new Map(),
      channelStartGenerations: new Map(),
      startsInFlight: new Map(),
      memoryResponderGate: gate,
      stopped: false,
      traceabilityStatusValue: {} as never,
      processJobsService: undefined,
      processJobsDegradation: undefined,
      setStatus(channelId, status) {
        statuses.set(channelId, status);
        return status;
      },
      rememberSelectedSkills: () => undefined,
      ensureInteractionBridge: async () => undefined,
      ensureContinuationService: async () => undefined,
      buildResponder: async () => ({ respond: async () => ({}) }),
      notifyDestination: async () => ({ delivered: false }),
      listNotifyDestinations: async () => [],
      observabilityContext: async () => ({}),
      refreshTraceSource: async () => undefined,
      activeTransports: () => [],
    };

    await expect(startChannel(controller, driver, "startup")).resolves.toEqual({
      kind: "degraded",
      reason: "Memory action integrity failed; reload required.",
    });
    expect(controller.running.has("tui")).toBe(true);
    expect(statuses.get("tui")).toMatchObject({ kind: "degraded" });
    recoverTransport?.();
    expect(statuses.get("tui")).toMatchObject({ kind: "degraded" });
  });

  it("reports a failed live apply while process-wide memory admission is degraded", () => {
    const gate = new MemoryResponderAdmissionGate();
    gate.degradeForIntegrityFailure("Memory action integrity failed; reload required.");

    expect(applyResult({
      memoryResponderGate: gate,
      statuses: new Map([["tui", {
        kind: "degraded",
        reason: "Memory action integrity failed; reload required.",
      }]]),
      traceabilityStatusValue: { kind: "running", summary: {} },
      activeTransports: () => ["tui"],
    } as never)).toEqual({
      kind: "failed",
      message: "Saved config, but live apply failed: Memory action integrity failed; reload required.",
      transports: ["tui"],
    });
  });

  it("starts responder disposal before awaiting a transport that joins its active handler", async () => {
    let releaseTransport!: () => void;
    const transportReleased = new Promise<void>((resolve) => { releaseTransport = resolve; });
    const order: string[] = [];
    const driver = { id: "tui", label: "TUI" } as never;
    const running = new Map([["tui", {
      summary: {},
      stop: async () => {
        order.push("transport:stop");
        await transportReleased;
        order.push("transport:stopped");
      },
      dispose: async () => {
        order.push("responder:dispose");
        releaseTransport();
      },
    }]]);

    await expect(stopChannel({
      driversById: new Map([["tui", driver]]),
      running,
      startsInFlight: new Map(),
      channelStartGenerations: new Map([["tui", Symbol("running")]]),
      statuses: new Map(),
      stopped: false,
      logger: undefined,
      setStatus: () => ({ kind: "waiting_for_config", reason: "stopped" }),
    } as never, "tui", "reload")).resolves.toBeUndefined();

    expect(order).toEqual([
      "transport:stop",
      "responder:dispose",
      "transport:stopped",
    ]);
    expect(running.has("tui")).toBe(false);
  });
});
