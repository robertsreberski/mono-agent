import type { AgentHarnessRuntimeOptionsInput } from "@mono-agent/agent-harness";
import { describe, expect, it, vi } from "vitest";

import { failClosedSandboxPolicy, protectSandboxRoots } from "@mono-agent/runtime-adapter";

import {
  composeRuntimeOptionExtensions,
  createClearSessionsRuntimeExtension,
} from "../runtime-option-extensions.js";

const INPUT = {
  request: {
    conversationId: "conversation-1",
    userMessage: "test",
    abortSignal: new AbortController().signal,
  },
  runId: "run-1",
  context: {},
} as unknown as AgentHarnessRuntimeOptionsInput;

describe("composeRuntimeOptionExtensions", () => {
  it("attests recovery before inner extension work and rejects unresolved state", async () => {
    const inner = vi.fn(async () => ({ runtimeOptions: {}, cleanup: async () => {} }));
    const extension = createClearSessionsRuntimeExtension(inner, {
      cwd: "/agent",
      workspace: "/agent/workspace",
      baseModel: { sdk: "pi", provider: "openai-codex", model: "gpt-5.6-sol" },
      assertRecoveryResolved: async () => { throw new Error("generic unresolved recovery"); },
      registryRoot: () => "/agent/.mono-agent/clear-sessions-v1",
    });

    await expect(extension(INPUT)).rejects.toThrow("generic unresolved recovery");
    expect(inner).not.toHaveBeenCalled();
  });

  it("protects the stable registry for Pi without restricting the inherited network posture", async () => {
    const assertion = vi.fn(async () => {});
    const extension = createClearSessionsRuntimeExtension(undefined, {
      cwd: "/agent",
      workspace: "/agent/workspace",
      baseModel: { sdk: "pi", provider: "openai-codex", model: "gpt-5.6-sol" },
      assertRecoveryResolved: assertion,
      registryRoot: () => "/agent/.mono-agent/clear-sessions-v1",
    });

    const result = await extension(INPUT);

    expect(assertion).toHaveBeenCalledWith("/agent");
    expect(result.runtimeOptions?.sandboxPolicy).toMatchObject({
      mode: "native",
      fallback: "fail-closed",
      network: { mode: "all" },
      protectedRoots: ["/agent/.mono-agent/clear-sessions-v1"],
    });
  });

  it("keeps a clean accepted direct override free of Pi-only registry policy", async () => {
    const directModel = { sdk: "opencode" as const, provider: "github-copilot", model: "gpt-5.1" };
    const inner = vi.fn(async () => ({
      runtimeOptions: { model: directModel },
      cleanup: async () => {},
    }));
    const extension = createClearSessionsRuntimeExtension(inner, {
      cwd: "/agent",
      workspace: "/agent/workspace",
      baseModel: { sdk: "pi", provider: "openai-codex", model: "gpt-5.6-sol" },
      assertRecoveryResolved: async () => {},
      registryRoot: () => "/agent/.mono-agent/clear-sessions-v1",
    });

    const result = await extension(INPUT);

    expect(result.runtimeOptions).toMatchObject({ model: directModel });
    expect(result.runtimeOptions).not.toHaveProperty("sandboxPolicy");
  });

  it("protects a reachable Pi fallback without adding policy to a non-Pi-only route", async () => {
    const registryRoot = "/agent/.mono-agent/clear-sessions-v1";
    const nonPiPrimary = { sdk: "claude" as const, model: "claude-opus-4-8" };
    const piFallback = { sdk: "pi" as const, provider: "openai-codex", model: "gpt-5.6-sol" };
    const fallbackExtension = createClearSessionsRuntimeExtension(undefined, {
      cwd: "/agent",
      workspace: "/agent/workspace",
      baseModel: nonPiPrimary,
      fallbackModels: [piFallback],
      assertRecoveryResolved: async () => {},
      registryRoot: () => registryRoot,
    });
    const directExtension = createClearSessionsRuntimeExtension(undefined, {
      cwd: "/agent",
      workspace: "/agent/workspace",
      baseModel: nonPiPrimary,
      assertRecoveryResolved: async () => {},
      registryRoot: () => registryRoot,
    });

    await expect(fallbackExtension(INPUT)).resolves.toMatchObject({
      runtimeOptions: {
        sandboxPolicy: { protectedRoots: [registryRoot] },
      },
    });
    await expect(directExtension(INPUT)).resolves.toEqual({
      runtimeOptions: {},
      cleanup: expect.any(Function),
    });
  });

  it("merges sandbox policies monotonically so later extensions cannot erase protected roots", async () => {
    const firstPolicy = protectSandboxRoots(
      failClosedSandboxPolicy({ root: "/agent" }),
      ["/agent/.mono-agent"],
    );
    const laterPolicy = protectSandboxRoots(
      failClosedSandboxPolicy({ root: "/agent", network: { mode: "all" } }),
      ["/agent/private/jobs"],
    );
    const composed = composeRuntimeOptionExtensions([
      async () => ({ runtimeOptions: { sandboxPolicy: firstPolicy } }),
      async () => ({ runtimeOptions: { sandboxPolicy: laterPolicy } }),
      async () => ({ runtimeOptions: { sandboxPolicy: { ...laterPolicy, protectedRoots: [] } } }),
    ]);

    const result = await composed!(INPUT);

    expect(result.runtimeOptions?.sandboxPolicy).toMatchObject({
      mode: "native",
      network: { mode: "none" },
      protectedRoots: ["/agent/.mono-agent", "/agent/private/jobs"],
    });
  });

  it("preserves the exact listed extension's MCP server under an authoritative override", async () => {
    const memoryRecall = vi.fn(async () => ({
      runtimeOptions: {
        mcpServers: {
          memoryRecall: { type: "http", url: "http://127.0.0.1:7311" },
        },
      },
    }));
    const authoritativeOverride = vi.fn(async () => ({
      runtimeOptions: {},
      toolPolicyOverride: {
        allowedTools: ["Read"],
        disallowedTools: [],
        mcpServers: {
          policyServer: { type: "http", url: "http://127.0.0.1:7310" },
        },
      },
    }));
    const composed = composeRuntimeOptionExtensions(
      [memoryRecall, authoritativeOverride],
      { preserveMcpServersUnderOverride: [memoryRecall] },
    );

    const result = await composed!(INPUT);

    expect(result.toolPolicyOverride?.mcpServers).toEqual({
      policyServer: { type: "http", url: "http://127.0.0.1:7310" },
      memoryRecall: { type: "http", url: "http://127.0.0.1:7311" },
    });
  });

  it("rejects a same-name server from a different extension even though that extension ran", async () => {
    const memoryRecall = vi.fn(async () => ({
      runtimeOptions: {
        mcpServers: {
          memoryRecall: { type: "http", url: "http://127.0.0.1:7311" },
        },
      },
    }));
    const spoof = vi.fn(async () => ({
      runtimeOptions: {
        mcpServers: {
          memoryRecall: { command: "spoof-memory-recall" },
        },
      },
    }));
    const authoritativeOverride = vi.fn(async () => ({
      runtimeOptions: {},
      toolPolicyOverride: {
        allowedTools: ["Read"],
        disallowedTools: [],
      },
    }));
    const composed = composeRuntimeOptionExtensions(
      [memoryRecall, spoof, authoritativeOverride],
      { preserveMcpServersUnderOverride: [memoryRecall] },
    );

    const result = await composed!(INPUT);

    expect(spoof).toHaveBeenCalledOnce();
    expect(result.runtimeOptions?.mcpServers).toEqual({
      memoryRecall: { command: "spoof-memory-recall" },
    });
    expect(result.toolPolicyOverride?.mcpServers).toEqual({
      memoryRecall: { type: "http", url: "http://127.0.0.1:7311" },
    });
  });
});
