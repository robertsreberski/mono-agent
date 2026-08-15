import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChannelDriver } from "../channels.js";
import type { ProcessJobStore } from "../process-jobs-store.js";

const processJobsHooks = vi.hoisted(() => ({
  decorateNextOpen: false,
  activationFailure: undefined as Error | undefined,
  lockHeld: false,
  lockReleases: 0,
}));

vi.mock("../process-jobs-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process-jobs-service.js")>();
  return {
    ...actual,
    openProcessJobsService: async (
      options: Parameters<typeof actual.openProcessJobsService>[0],
    ) => {
      const incarnation = {
        schema: "mono-agent.process-incarnation.v1" as const,
        bootSessionId: "startup-rollback-boot",
        processStartId: "startup-rollback-process",
      };
      const service = await actual.openProcessJobsService({
        ...options,
        currentIncarnation: async () => incarnation,
        readIncarnation: async () => incarnation,
        acquireLock: async () => {
          if (processJobsHooks.lockHeld) return undefined;
          processJobsHooks.lockHeld = true;
          return {
            path: join(options.settings.stateDir, ".test-owner"),
            ownerPid: process.pid,
            release: async () => {
              processJobsHooks.lockHeld = false;
              processJobsHooks.lockReleases += 1;
            },
          };
        },
      });
      if (!processJobsHooks.decorateNextOpen) return service;
      processJobsHooks.decorateNextOpen = false;
      const servicePort = service as unknown as { store: ProcessJobStore };
      const store = servicePort.store;
      let failActivationList = true;
      servicePort.store = {
        ...store,
        async list() {
          if (failActivationList) {
            failActivationList = false;
            throw processJobsHooks.activationFailure ?? new Error("Process-job storage failed.");
          }
          return await store.list();
        },
      };
      return service;
    },
  };
});

const { startMonoAgentApp } = await import("../app.js");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  processJobsHooks.decorateNextOpen = false;
  processJobsHooks.activationFailure = undefined;
  processJobsHooks.lockHeld = false;
  processJobsHooks.lockReleases = 0;
  await Promise.all(temporaryDirectories.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true })));
});

describe("mono-agent app startup rollback", () => {
  it("preserves an activation failure while stopping every started owner and permits a clean retry", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-agent-startup-rollback-"));
    temporaryDirectories.push(cwd);
    const configPath = join(cwd, "mono-agent.config.json");
    await writeFile(join(cwd, "IDENTITY.md"), "# Startup rollback test\n");
    await writeFile(configPath, `${JSON.stringify({
      runtime: {
        model: "pi:openai-codex:gpt-5.5",
        retry: { primaryAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
        workspace: ".",
      },
      context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
      tools: { allowedTools: [], disallowedTools: [] },
      artifacts: { dir: "./artifacts" },
      traceability: {
        registryDir: "./trace-sources",
        sourceId: "startup-rollback-test",
        sourceLabel: "Startup rollback test",
        globalDiscovery: false,
      },
      processJobs: { enabled: true },
    }, null, 2)}\n`);

    const channelStopFailure = new Error("channel transport cleanup failed");
    const channelStop = vi.fn(async () => {
      // The transport has released its owned resources before reporting its
      // cleanup diagnostic, matching real best-effort stop handles.
      throw channelStopFailure;
    });
    const responderDispose = vi.fn(async () => undefined);
    const driver: ChannelDriver = {
      id: "startup-rollback" as never,
      label: "Startup rollback",
      loadConfig: async () => ({ enabled: true }),
      isConfigError: () => false,
      async start(input) {
        (input.responder as { dispose?: () => Promise<void> }).dispose = responderDispose;
        return { summary: { transport: "startup-rollback" }, stop: channelStop };
      },
    };
    const warn = vi.fn();
    const activationFailure = new Error("Process-job storage failed.");
    processJobsHooks.activationFailure = activationFailure;
    processJobsHooks.decorateNextOpen = true;

    await expect(startMonoAgentApp({
      cwd,
      configPath,
      env: {},
      drivers: [driver],
      logger: { warn },
    })).rejects.toBe(activationFailure);

    expect(channelStop).toHaveBeenCalledOnce();
    expect(responderDispose).toHaveBeenCalledOnce();
    expect(processJobsHooks.lockHeld).toBe(false);
    expect(processJobsHooks.lockReleases).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      "Startup rollback channel did not stop cleanly.",
      { reason: "stop", error: channelStopFailure.message },
    );

    // A second controller can acquire the same process-job owner lock and
    // activate normally only if the rejected startup joined full teardown.
    const retried = await startMonoAgentApp({
      cwd,
      configPath,
      env: {},
      drivers: [],
    });
    try {
      expect((retried as unknown as { processJobsService?: unknown }).processJobsService).toBeDefined();
      expect(processJobsHooks.lockHeld).toBe(true);
      await expect(retried.listProcessJobs?.()).resolves.toEqual([]);
    } finally {
      await retried.stop();
    }
    expect(processJobsHooks.lockHeld).toBe(false);
    expect(processJobsHooks.lockReleases).toBe(2);
  });
});
