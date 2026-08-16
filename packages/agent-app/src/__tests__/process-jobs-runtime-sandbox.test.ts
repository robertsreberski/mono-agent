import { describe, expect, it, vi } from "vitest";

import { createSandboxPolicy } from "@mono-agent/runtime-adapter";

import {
  PROCESS_JOBS_PI_NATIVE_REQUIRED_ERROR,
  PROCESS_JOBS_PROTECTION_UNAVAILABLE_ERROR,
  createProcessJobsRuntimeExtension,
  processJobsSandboxPolicy,
} from "../process-jobs-runtime.js";
import { PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR } from "../process-jobs-root-registry.js";

const PI_MODEL = { sdk: "pi", provider: "openai-codex", model: "gpt-5.6-sol" } as const;
const CLAUDE_MODEL = { sdk: "claude", provider: "anthropic", model: "claude-opus-4-8" } as const;
const ROOTS = [
  "/agent/.mono-agent/.process-jobs-roots-v1.lock",
  "/agent/.mono-agent/process-jobs-roots-v1",
  "/agent/.state/old-jobs",
  "/agent/.state/process-jobs",
] as const;

const availableSandboxEngine = {
  id: "process-jobs-test",
  async isAvailable() { return true; },
  async prepareCommand(command: unknown) { return command; },
} as never;

function eligibleCoreConfig(
  sandbox?: ReturnType<typeof createSandboxPolicy>,
  workspace = "/agent",
): never {
  return {
    runtime: {
      workspace,
      model: PI_MODEL,
      executionMode: "sdk",
    },
    tools: { allowedTools: ["Exec", "Bash"], disallowedTools: [] },
    ...(sandbox === undefined ? {} : { sandbox }),
  } as never;
}

function eligibleInput(conversationId = "slack:C1:1.1"): never {
  return {
    runId: "run-protected",
    request: { conversationId, text: "hello" },
  } as never;
}

function boundary(options: {
  protectedRoots?: readonly string[];
  coreConfig?: ReturnType<typeof eligibleCoreConfig>;
  service?: unknown;
  next?: (input: never) => unknown;
  baseModel?: typeof PI_MODEL | typeof CLAUDE_MODEL;
  sandboxEngine?: unknown;
  failed?: boolean;
} = {}) {
  const protectedRoots = options.protectedRoots ?? ROOTS;
  const rootKeys = protectedRoots.filter((root) => root.includes(".state/"));
  const generation = Object.freeze({ id: "11111111-1111-4111-8111-111111111111", rootKeys });
  const releaseAfterSettlement = vi.fn();
  const acquireRequestLease = vi.fn(() => ({ generation, releaseAfterSettlement }));
  const registry = options.failed
    ? {
        kind: "failed",
        generation: { id: "mono-agent.process-jobs-roots.failed", rootKeys: [] },
        protectedRoots: ROOTS.slice(0, 2),
        error: PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR,
      }
    : protectedRoots.length === 0
      ? {
          kind: "empty",
          generation: { id: "mono-agent.process-jobs-roots.absent", rootKeys: [] },
          protectedRoots: [],
        }
      : { kind: "ready", generation, protectedRoots };
  const extension = createProcessJobsRuntimeExtension({
    ownership: { coordinator: { acquireRequestLease } } as never,
    registry: registry as never,
    service: options.service as never,
    coreConfig: options.coreConfig ?? eligibleCoreConfig(),
    baseModel: options.baseModel ?? PI_MODEL,
    channelId: "slack",
    sandboxEngine: (Object.hasOwn(options, "sandboxEngine")
      ? options.sandboxEngine
      : availableSandboxEngine) as never,
    ...(options.next === undefined ? {} : { next: options.next as never }),
    attestRegistry: async (snapshot) => {
      if (options.failed) throw new Error(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
      return snapshot as never;
    },
  });
  return { extension, acquireRequestLease, releaseAfterSettlement };
}

describe("process-job registry runtime protection", () => {
  it("preserves legitimate non-Pi routing while the durable registry is empty", async () => {
    const providerExtension = vi.fn(async () => ({ runtimeOptions: { model: CLAUDE_MODEL } }));
    const { extension, releaseAfterSettlement } = boundary({
      protectedRoots: [],
      baseModel: CLAUDE_MODEL,
      next: providerExtension,
    });

    const result = await extension(eligibleInput());
    expect(providerExtension).toHaveBeenCalledOnce();
    expect(result.runtimeOptions).toEqual({ model: CLAUDE_MODEL });
    expect(result.runtimeOptions?.sandboxPolicy).toBeUndefined();
    await result.settleCleanup?.();
    expect(releaseAfterSettlement).toHaveBeenCalledOnce();
  });

  it("rejects a reachable non-Pi primary, fallback, override, or child route before provider invocation", async () => {
    const providerExtension = vi.fn(async () => ({ runtimeOptions: { model: CLAUDE_MODEL } }));
    const { extension, acquireRequestLease, releaseAfterSettlement } = boundary({ next: providerExtension });

    await expect(extension(eligibleInput())).rejects.toThrow(PROCESS_JOBS_PI_NATIVE_REQUIRED_ERROR);
    expect(providerExtension).toHaveBeenCalledOnce();
    expect(acquireRequestLease).toHaveBeenCalledOnce();
    expect(releaseAfterSettlement).toHaveBeenCalledOnce();
  });

  it.each(["absent", "off"] as const)(
    "synthesizes fail-closed native policy for every retained root when configured sandbox is %s",
    async (configuredPolicy) => {
      const { extension } = boundary({
        coreConfig: eligibleCoreConfig(configuredPolicy === "off"
          ? createSandboxPolicy({ mode: "off", root: "/agent", network: { mode: "all" } })
          : undefined),
      });

      const result = await extension(eligibleInput());
      expect(result.runtimeOptions?.sandboxPolicy).toMatchObject({
        mode: "native",
        fallback: "fail-closed",
        unsafeAllowHostProcess: false,
        network: { mode: "all" },
        protectedRoots: ROOTS,
      });
      await result.settleCleanup?.();
    },
  );

  it("retains a configured native policy while sealing registry and dormant roots", async () => {
    const configured = createSandboxPolicy({
      root: "/agent",
      readableRoots: ["/agent"],
      writableRoots: ["/agent/work"],
      network: { mode: "localhost" },
      fallback: "unsafe-host-process",
      unsafeAllowHostProcess: true,
    });
    const { extension } = boundary({ coreConfig: eligibleCoreConfig(configured) });

    const result = await extension(eligibleInput());
    expect(result.runtimeOptions?.sandboxPolicy).toMatchObject({
      writableRoots: ["/agent/work"],
      network: { mode: "localhost" },
      fallback: "fail-closed",
      unsafeAllowHostProcess: false,
      protectedRoots: ROOTS,
    });
    await result.settleCleanup?.();
  });

  it("seals retained roots on direct turns even when the optional service is unavailable", async () => {
    const { extension } = boundary({ service: undefined });
    const result = await extension(eligibleInput("cron:direct"));

    expect(result.runtimeOptions).toMatchObject({
      sandboxEngine: availableSandboxEngine,
      sandboxPolicy: { protectedRoots: ROOTS },
    });
    expect(result.runtimeOptions?.processJobs).toBeUndefined();
    await result.settleCleanup?.();
  });

  it.each([
    ["missing", undefined],
    ["unavailable", {
      id: "unavailable-process-jobs-test",
      async isAvailable() { return false; },
      async prepareCommand(command: unknown) { return command; },
    }],
  ] as const)("fails provider-zero when the real sandbox engine is %s", async (_label, sandboxEngine) => {
    const { extension } = boundary({ sandboxEngine });
    await expect(extension(eligibleInput())).rejects.toThrow(PROCESS_JOBS_PROTECTION_UNAVAILABLE_ERROR);
  });

  it("fails malformed registry provider-zero before resource extension or provider work", async () => {
    const downstream = vi.fn();
    const { extension, acquireRequestLease } = boundary({ failed: true, next: downstream });

    await expect(extension(eligibleInput())).rejects.toThrow(PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR);
    expect(acquireRequestLease).not.toHaveBeenCalled();
    expect(downstream).not.toHaveBeenCalled();
  });

  it("releases the generation only through settleCleanup, never ordinary cleanup", async () => {
    const downstreamCleanup = vi.fn(async () => undefined);
    const downstreamSettle = vi.fn(async () => undefined);
    const { extension, releaseAfterSettlement } = boundary({
      next: async () => ({ cleanup: downstreamCleanup, settleCleanup: downstreamSettle }),
    });
    const result = await extension(eligibleInput());

    await result.cleanup?.();
    expect(downstreamCleanup).toHaveBeenCalledOnce();
    expect(releaseAfterSettlement).not.toHaveBeenCalled();
    await result.settleCleanup?.();
    expect(downstreamSettle).toHaveBeenCalledOnce();
    expect(releaseAfterSettlement).toHaveBeenCalledOnce();
  });
});

describe("processJobsSandboxPolicy overlap boundary", () => {
  it.each([
    ["the default process-jobs leaf", "/agent", "/agent/.mono-agent/process-jobs"],
    ["a custom private descendant", "/agent/workspace", "/agent/workspace/.private/jobs"],
  ])("allows %s inside the workspace", (_label, workspace, protectedRoot) => {
    expect(processJobsSandboxPolicy({
      coreConfig: eligibleCoreConfig(undefined, workspace),
      protectedRoots: [protectedRoot],
    }).protectedRoots).toEqual([protectedRoot]);
  });

  it.each([
    ["equals", "/agent/workspace", "/agent/workspace"],
    ["contains", "/agent/private/workspace", "/agent/private"],
  ])("rejects a private root that %s the model workspace", (_label, workspace, protectedRoot) => {
    expect(() => processJobsSandboxPolicy({
      coreConfig: eligibleCoreConfig(undefined, workspace),
      protectedRoots: [protectedRoot],
    })).toThrow("cannot contain the model workspace");
  });
});
