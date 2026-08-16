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

const { MonoAgentAppController } = await import("../app-controller.js");
const { acquireAgentRootOwnership } = await import("../agent-root-coordinator.js");
const { startMonoAgentApp } = await import("../app.js");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  processJobsHooks.decorateNextOpen = false;
  processJobsHooks.activationFailure = undefined;
  processJobsHooks.lockHeld = false;
  processJobsHooks.lockReleases = 0;
  await Promise.all(temporaryDirectories.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
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

  it("joins and retires a slow channel start after another driver fails startup", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-agent-channel-start-rollback-"));
    temporaryDirectories.push(cwd);
    const configPath = join(cwd, "mono-agent.config.json");
    await writeFile(join(cwd, "IDENTITY.md"), "# Channel start rollback test\n");
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
        sourceId: "channel-start-rollback-test",
        sourceLabel: "Channel start rollback test",
        globalDiscovery: false,
      },
      processJobs: { enabled: false },
    }, null, 2)}\n`);

    const fastFailure = new Error("fast driver config failed");
    const slowStartEntered = deferred<void>();
    const releaseSlowStart = deferred<void>();
    const slowStartReturned = deferred<void>();
    let listenerActive = false;
    const slowStop = vi.fn(async () => { listenerActive = false; });
    const responderDispose = vi.fn(async () => undefined);
    const fastId = "startup-fast" as never;
    const slowId = "startup-slow" as never;
    const fastDriver: ChannelDriver = {
      id: fastId,
      label: "Startup fast",
      loadConfig: async () => {
        await slowStartEntered.promise;
        throw fastFailure;
      },
      isConfigError: () => false,
      start: async () => { throw new Error("fast driver start must not run"); },
    };
    const slowDriver: ChannelDriver = {
      id: slowId,
      label: "Startup slow",
      loadConfig: async () => ({ enabled: true }),
      isConfigError: () => false,
      async start(input) {
        (input.responder as { dispose?: () => Promise<void> }).dispose = responderDispose;
        listenerActive = true;
        slowStartEntered.resolve();
        await releaseSlowStart.promise;
        slowStartReturned.resolve();
        return { summary: { transport: "startup-slow" }, stop: slowStop };
      },
    };

    let controller: InstanceType<typeof MonoAgentAppController> | undefined;
    const originalStartChannel = MonoAgentAppController.prototype.startChannel;
    vi.spyOn(MonoAgentAppController.prototype, "startChannel").mockImplementation(function (
      this: InstanceType<typeof MonoAgentAppController>,
      driver,
      reason,
    ) {
      controller = this;
      return originalStartChannel.call(this, driver, reason);
    });

    const startup = startMonoAgentApp({
      cwd,
      configPath,
      env: {},
      drivers: [fastDriver, slowDriver],
    });
    const outcome = startup.then(
      (app) => ({ kind: "resolved" as const, app }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );

    await slowStartEntered.promise;
    try {
      await waitFor(() => controller?.stopped === true
        && controller.channelStartGenerations.has(slowId) === false);
      expect(listenerActive).toBe(true);
      expect(controller?.running.has(slowId)).toBe(false);
    } finally {
      releaseSlowStart.resolve();
    }
    await slowStartReturned.promise;
    const result = await outcome;
    await waitFor(() => controller?.startsInFlight.has(slowId) === false);

    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.error).toBe(fastFailure);
    expect(slowStop).toHaveBeenCalledOnce();
    expect(responderDispose).toHaveBeenCalledOnce();
    expect(listenerActive).toBe(false);
    expect(controller?.running.has(slowId)).toBe(false);
    expect(controller?.startsInFlight.has(slowId)).toBe(false);
    expect(controller?.channelStartGenerations.has(slowId)).toBe(false);
  });

  it("returns channel start after refresh but never joins a blocked refresh during stop", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-agent-channel-refresh-stop-"));
    temporaryDirectories.push(cwd);
    const configPath = join(cwd, "mono-agent.config.json");
    await writeFile(join(cwd, "IDENTITY.md"), "# Channel refresh stop test\n");
    await writeFile(configPath, `${JSON.stringify({
      runtime: {
        model: "pi:openai-codex:gpt-5.5",
        retry: { primaryAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
        workspace: ".",
      },
      context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
      tools: { allowedTools: [], disallowedTools: [] },
      artifacts: { dir: "./artifacts" },
      traceability: { globalDiscovery: false },
      processJobs: { enabled: false },
    }, null, 2)}\n`);

    const channelId = "refresh-stop" as never;
    let listenerActive = false;
    const channelStop = vi.fn(async () => { listenerActive = false; });
    const responderDispose = vi.fn(async () => undefined);
    const driver: ChannelDriver = {
      id: channelId,
      label: "Refresh stop",
      loadConfig: async () => ({ enabled: true }),
      isConfigError: () => false,
      async start(input) {
        (input.responder as { dispose?: () => Promise<void> }).dispose = responderDispose;
        listenerActive = true;
        return { summary: { transport: "refresh-stop" }, stop: channelStop };
      },
    };
    const ownerHome = await mkdtemp(join(tmpdir(), "mono-agent-channel-refresh-owner-"));
    temporaryDirectories.push(ownerHome);
    const agentRootOwnership = await acquireAgentRootOwnership(cwd, { homeDir: ownerHome });
    const controller = new MonoAgentAppController({
      cwd,
      agentRootOwnership,
      configPath,
      configReadPath: configPath,
      env: {},
      drivers: [driver],
      trustedRuntimeReadRoots: [],
    });
    const refreshEntered = deferred<void>();
    const releaseRefresh = deferred<void>();
    const refreshTraceSource = vi.spyOn(controller, "refreshTraceSource").mockImplementation(async () => {
      refreshEntered.resolve();
      await releaseRefresh.promise;
    });
    let startSettled = false;
    const starting = controller.startChannelIfConfigured(channelId, "blocked-refresh").then((status) => {
      startSettled = true;
      return status;
    });

    await refreshEntered.promise;
    await Promise.resolve();
    expect(startSettled).toBe(false);
    expect(controller.startsInFlight.has(channelId)).toBe(false);
    expect(listenerActive).toBe(true);

    let stopSettled = false;
    const stopping = controller.stop().then(() => { stopSettled = true; });
    try {
      await waitFor(() => stopSettled);
      expect(startSettled).toBe(false);
      expect(channelStop).toHaveBeenCalledOnce();
      expect(responderDispose).toHaveBeenCalledOnce();
      expect(listenerActive).toBe(false);
      expect(controller.running.has(channelId)).toBe(false);
    } finally {
      releaseRefresh.resolve();
    }

    const [status] = await Promise.all([starting, stopping.then(() => undefined)]);
    expect(status.kind).toBe("running");
    expect(startSettled).toBe(true);
    expect(refreshTraceSource).toHaveBeenCalledOnce();
  });
});

function deferred<T>(): { readonly promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: (value?: T) => { resolvePromise(value as T); } };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition did not settle");
}
