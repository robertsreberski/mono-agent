import { describe, expect, it, vi } from "vitest";

import { createSandboxPolicy, parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";

import {
  createProcessJobsRuntimeExtension,
  processJobsSandboxPolicy,
} from "../process-jobs-runtime.js";
import { requestModelOverrideTargetsPiNative } from "../request-model-override.js";

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

describe("process-job runtime sandbox protection", () => {
  it("makes a direct provider override ineligible while process-job private state is active", () => {
    const coreConfig = eligibleCoreConfig();
    const service = {
      settings: { maxChainDepth: 4, stateDir: "/agent/.mono-agent/process-jobs" },
      controller: vi.fn(),
    } as never;
    const policy = processJobsSandboxPolicy({
      service,
      coreConfig,
      channelId: "slack",
      targetsPiNative: () => true,
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
        coreConfig: eligibleCoreConfig(configuredPolicy === "off"
          ? createSandboxPolicy({ mode: "off", root: "/agent", network: { mode: "all" } })
          : undefined),
        channelId: "slack",
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
      coreConfig: eligibleCoreConfig(configured),
      channelId: "slack",
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
      coreConfig: eligibleCoreConfig(),
      channelId: "slack",
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
      coreConfig: eligibleCoreConfig(),
      channelId: "slack",
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
      coreConfig: {
        ...coreConfig,
        runtime: {
          ...coreConfig.runtime,
          workspace: "/agent/.mono-agent/workspace",
        },
      } as never,
      channelId: "slack",
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
});
