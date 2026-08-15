import { describe, expect, it, vi } from "vitest";

import { createSandboxPolicy } from "@mono-agent/runtime-adapter";

import { createProcessJobsRuntimeExtension } from "../process-jobs-runtime.js";

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
        network: { mode: "none" },
        protectedRoots: ["/agent/private"],
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

  it("protects the immediate private container for a custom state directory outside the workspace", async () => {
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
      protectedRoots: ["/host-private"],
    });
  });

  it("adds protection only on the same eligible Pi-native turns that receive the controller", async () => {
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
        sandboxPolicy: { protectedRoots: ["/agent/.mono-agent"] },
      },
    });
    await expect(extension({
      runId: "run-rejected",
      request: {
        conversationId: "slack:C1:1.1",
        text: "hello",
        metadata: { route: "direct-claude" },
      },
    } as never)).resolves.toEqual({ runtimeOptions: {}, cleanup: expect.any(Function) });
    expect(controller).toHaveBeenCalledOnce();
  });
});
