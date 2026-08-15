import { describe, expect, it, vi } from "vitest";

import { createSandboxPolicy, parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";

import {
  createProcessJobsRuntimeExtension,
  processJobsSandboxPolicy,
} from "../process-jobs-runtime.js";
import {
  requestModelOverrideRoutesOnlyPiNative,
  requestModelOverrideTargetsPiNative,
} from "../request-model-override.js";

function eligibleCoreConfig(sandbox?: ReturnType<typeof createSandboxPolicy>): never {
  return {
    runtime: {
      workspace: "/agent",
      model: { sdk: "pi", provider: "openai-codex", model: "gpt-5.6-sol" },
      executionMode: "sdk",
    },
    tools: { allowedTools: ["Exec", "Bash"], disallowedTools: [] },
    ...(sandbox === undefined ? {} : { sandbox }),
  } as never;
}

function eligibleInput(): never {
  return {
    runId: "run-protected",
    request: { conversationId: "slack:C1:1.1", text: "hello" },
  } as never;
}

const availableSandboxEngine = {
  id: "process-jobs-test",
  async isAvailable() { return true; },
  async prepareCommand(command: unknown) { return command; },
} as never;

describe("process-job runtime sandbox protection", () => {
  it("rejects a mixed configured fallback chain before composing private-state policy", async () => {
    const coreConfig = eligibleCoreConfig();
    const controller = vi.fn();
    const service = {
      settings: { maxChainDepth: 4, stateDir: "/agent/.mono-agent/process-jobs" },
      controller,
    } as never;
    const policy = processJobsSandboxPolicy({
      coreConfig,
      stateDir: "/agent/.mono-agent/process-jobs",
    });
    const extension = createProcessJobsRuntimeExtension({
      service,
      stateDir: "/agent/.mono-agent/process-jobs",
      coreConfig,
      channelId: "slack",
      sandboxEngine: availableSandboxEngine,
      targetsPiNative: (metadata) => requestModelOverrideRoutesOnlyPiNative(metadata, {
        baseModel: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.6-sol"),
        fallbackModels: [parseMonoRuntimeModelReference("claude:claude-opus-4-8")],
        sandboxPolicy: policy,
      }),
    });

    await expect(extension(eligibleInput())).rejects.toThrow(
      "Process-job private state requires a Pi-native runtime.",
    );
    expect(controller).not.toHaveBeenCalled();
  });

  it("makes a direct provider override ineligible while process-job private state is active", () => {
    const coreConfig = eligibleCoreConfig();
    const service = {
      settings: { maxChainDepth: 4, stateDir: "/agent/.mono-agent/process-jobs" },
      controller: vi.fn(),
    } as never;
    const policy = processJobsSandboxPolicy({
      coreConfig,
      stateDir: "/agent/.mono-agent/process-jobs",
    });

    expect(requestModelOverrideTargetsPiNative(
      { tui: { model: "opencode:github-copilot:gpt-5.1" } },
      {
        baseModel: parseMonoRuntimeModelReference("pi:openai-codex:gpt-5.6-sol"),
        sandboxPolicy: policy,
        toolPolicy: { allowedTools: ["*"], disallowedTools: [] },
      },
    )).toBe(true);
  });

  it.each(["absent", "off"] as const)(
    "synthesizes fail-closed native protection when configured sandbox policy is %s",
    async (configuredPolicy) => {
      const extension = createProcessJobsRuntimeExtension({
        service: {
          settings: { maxChainDepth: 4, stateDir: "/agent/private/process-jobs" },
          controller: vi.fn(() => ({ start: vi.fn() })),
        } as never,
        stateDir: "/agent/private/process-jobs",
        coreConfig: eligibleCoreConfig(configuredPolicy === "off"
          ? createSandboxPolicy({ mode: "off", root: "/agent", network: { mode: "all" } })
          : undefined),
        channelId: "slack",
        sandboxEngine: availableSandboxEngine,
        targetsPiNative: () => true,
      });

      const result = await extension(eligibleInput());

      expect(result.runtimeOptions?.sandboxPolicy).toMatchObject({
        mode: "native",
        fallback: "fail-closed",
        unsafeAllowHostProcess: false,
        network: { mode: "all" },
        protectedRoots: ["/agent/private/process-jobs"],
      });
      expect(result.runtimeOptions?.processJobs).toEqual(expect.any(Object));
    },
  );

  it("retains a configured native policy while adding narrow process-job protection", async () => {
    const configured = createSandboxPolicy({
      root: "/agent",
      readableRoots: ["/agent"],
      writableRoots: ["/agent/work"],
      network: { mode: "localhost" },
      fallback: "unsafe-host-process",
      unsafeAllowHostProcess: true,
    });
    const extension = createProcessJobsRuntimeExtension({
      service: {
        settings: { maxChainDepth: 4, stateDir: "/agent/process-jobs" },
        controller: vi.fn(() => ({ start: vi.fn() })),
      } as never,
      stateDir: "/agent/process-jobs",
      coreConfig: eligibleCoreConfig(configured),
      channelId: "slack",
      sandboxEngine: availableSandboxEngine,
      targetsPiNative: () => true,
    });

    const result = await extension(eligibleInput());

    expect(result.runtimeOptions?.sandboxPolicy).toMatchObject({
      writableRoots: ["/agent/work"],
      network: { mode: "localhost" },
      fallback: "fail-closed",
      unsafeAllowHostProcess: false,
      // A direct child uses itself; protecting /agent would block the workspace.
      protectedRoots: ["/agent/process-jobs"],
    });
  });

  it("protects only the exact custom state directory outside the workspace", async () => {
    const extension = createProcessJobsRuntimeExtension({
      service: {
        settings: { maxChainDepth: 4, stateDir: "/host-private/process-jobs" },
        controller: vi.fn(() => ({ start: vi.fn() })),
      } as never,
      stateDir: "/host-private/process-jobs",
      coreConfig: eligibleCoreConfig(),
      channelId: "slack",
      sandboxEngine: availableSandboxEngine,
      targetsPiNative: () => true,
    });

    const result = await extension(eligibleInput());

    expect(result.runtimeOptions?.sandboxPolicy).toMatchObject({
      network: { mode: "all" },
      protectedRoots: ["/host-private/process-jobs"],
    });
  });

  it("protects every Pi-native turn independently of controller eligibility", async () => {
    const controller = vi.fn(() => ({ start: vi.fn() }));
    const extension = createProcessJobsRuntimeExtension({
      service: {
        settings: { maxChainDepth: 4, stateDir: "/agent/.mono-agent/process-jobs" },
        controller,
      } as never,
      stateDir: "/agent/.mono-agent/process-jobs",
      coreConfig: eligibleCoreConfig(),
      channelId: "slack",
      sandboxEngine: availableSandboxEngine,
      targetsPiNative: (metadata) => metadata?.route !== "direct-claude",
    });

    await expect(extension(eligibleInput())).resolves.toMatchObject({
      runtimeOptions: {
        processJobs: expect.any(Object),
        sandboxPolicy: { protectedRoots: ["/agent/.mono-agent/process-jobs"] },
      },
    });
    await expect(extension({
      runId: "run-without-origin",
      request: { conversationId: "cron:job", text: "hello" },
    } as never)).resolves.toMatchObject({
      runtimeOptions: {
        sandboxPolicy: { protectedRoots: ["/agent/.mono-agent/process-jobs"] },
      },
    });
    await expect(extension({
      runId: "run-rejected",
      request: {
        conversationId: "slack:C1:1.1",
        text: "hello",
        metadata: { route: "direct-claude" },
      },
    } as never)).rejects.toThrow("Process-job private state requires a Pi-native runtime.");
    expect(controller).toHaveBeenCalledOnce();
  });

  it("keeps a workspace nested beside the state directory readable", async () => {
    const coreConfig = eligibleCoreConfig() as unknown as {
      runtime: Record<string, unknown>;
    };
    const extension = createProcessJobsRuntimeExtension({
      service: {
        settings: { maxChainDepth: 4, stateDir: "/agent/.mono-agent/process-jobs" },
        controller: vi.fn(() => ({ start: vi.fn() })),
      } as never,
      stateDir: "/agent/.mono-agent/process-jobs",
      coreConfig: {
        ...coreConfig,
        runtime: {
          ...coreConfig.runtime,
          workspace: "/agent/.mono-agent/workspace",
        },
      } as never,
      channelId: "slack",
      sandboxEngine: availableSandboxEngine,
      targetsPiNative: () => true,
    });

    await expect(extension(eligibleInput())).resolves.toMatchObject({
      runtimeOptions: {
        sandboxPolicy: {
          readableRoots: ["/agent/.mono-agent/workspace"],
          protectedRoots: ["/agent/.mono-agent/process-jobs"],
        },
      },
    });
  });

  it("protects configured private state even when the durable service is unavailable", async () => {
    const extension = createProcessJobsRuntimeExtension({
      service: undefined,
      stateDir: "/agent/.mono-agent/process-jobs",
      coreConfig: eligibleCoreConfig(),
      channelId: "slack",
      sandboxEngine: availableSandboxEngine,
      targetsPiNative: () => true,
    });

    const result = await extension(eligibleInput());
    expect(result).toMatchObject({
      runtimeOptions: {
        sandboxEngine: availableSandboxEngine,
        sandboxPolicy: {
          readableRoots: ["/agent"],
          protectedRoots: ["/agent/.mono-agent/process-jobs"],
        },
      },
    });
    expect(result.runtimeOptions?.processJobs).toBeUndefined();
  });

  it.each([
    ["missing", undefined],
    ["unavailable", {
      id: "unavailable-process-jobs-test",
      async isAvailable() { return false; },
      async prepareCommand(command: unknown) { return command; },
    } as never],
  ] as const)("fails the turn closed when the real sandbox engine is %s", async (_label, sandboxEngine) => {
    const extension = createProcessJobsRuntimeExtension({
      service: undefined,
      stateDir: "/agent/.mono-agent/process-jobs",
      coreConfig: eligibleCoreConfig(),
      channelId: "slack",
      sandboxEngine,
      targetsPiNative: () => true,
    });

    await expect(extension(eligibleInput())).rejects.toThrow(
      "Process-job private state protection is unavailable.",
    );
  });
});
