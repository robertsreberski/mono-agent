import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { TuiAdapterOptions, TuiAdapterStartResult } from "@mono-agent/operator-adapter";

import { startChannel, type ChannelsControllerPort } from "../app-controller-channels.js";
import { createTuiChannelDriver } from "../channels.js";
import type { ChannelDriver, ChannelStartInput, ChannelStatus } from "../channels.js";
import type { ProcessJobsServiceHandle } from "../process-jobs-service.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("app channel capability composition", () => {
  it("injects provider auth into the zero-config TUI without inventing an operator API key", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-channel-provider-auth-"));
    fixtures.push(cwd);
    const configReadPath = join(cwd, "mono-agent.config.json");
    await writeFile(configReadPath, JSON.stringify({
      runtime: { model: "openai-codex:gpt-5.5", workspace: "." },
      context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
      tools: { allowedTools: [], disallowedTools: [] },
      artifacts: { dir: "./artifacts" },
    }));

    let captured: TuiAdapterOptions | undefined;
    const stop = vi.fn(async () => undefined);
    const driver = createTuiChannelDriver({
      adapterFactory: async (options): Promise<TuiAdapterStartResult> => {
        captured = options;
        return {
          url: "http://127.0.0.1:0",
          baseUrl: "http://127.0.0.1:0/gui",
          infoUrl: "http://127.0.0.1:0/gui/v1/info",
          turnsUrl: "http://127.0.0.1:0/gui/v1/turns",
          host: "127.0.0.1",
          port: 0,
          stop,
        };
      },
      discoverModels: async () => [],
      discoverProviders: async () => [],
    });
    const statuses = new Map<string, ChannelStatus>();
    const responder: AgentResponder = { respond: async () => ({}) };
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
      stopped: false,
      traceabilityStatusValue: {} as never,
      processJobsService: undefined,
      monitorsService: undefined,
      monitorsStateDir: undefined,
      processJobsDegradation: undefined,
      setStatus(channelId, channelStatus) {
        statuses.set(channelId, channelStatus);
        return channelStatus;
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

    try {
      await expect(startChannel(controller, driver, "test"))
        .resolves.toMatchObject({ kind: "running" });
      expect(captured?.providerAuth).toBeDefined();
      expect(captured).not.toHaveProperty("apiKey");
    } finally {
      await controller.running.get("tui")?.stop();
    }
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each(["slack", "third-party"])(
    "does not pass process-job service authority through the generic %s driver path",
    async (id) => {
      const cwd = await mkdtemp(join(tmpdir(), "mono-channel-capability-"));
      fixtures.push(cwd);
      const configReadPath = join(cwd, "mono-agent.config.json");
      await writeFile(configReadPath, JSON.stringify({
        runtime: { model: "openai-codex:gpt-5.5", workspace: "." },
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
        stopped: false,
        traceabilityStatusValue: {} as never,
        processJobsService,
        monitorsService: undefined,
        monitorsStateDir: undefined,
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
});
