import { beforeEach, describe, expect, it, vi } from "vitest";

const kernelMocks = vi.hoisted(() => {
  const createKernelRuntime = () => ({
    run: vi.fn(),
    configureTools: vi.fn(),
  });
  return {
    createRuntime: vi.fn((_host?: unknown) => createKernelRuntime()),
    createRouterRuntime: vi.fn((_options?: unknown) => createKernelRuntime()),
  };
});

vi.mock("@mono-agent/agent-runtime", () => ({
  createPiOAuthApiKeyResolver: vi.fn(),
  createRuntime: kernelMocks.createRuntime,
  createRouterRuntime: kernelMocks.createRouterRuntime,
}));

import { createMonoRuntime } from "../runtime-adapter.js";
import type { CreateMonoRuntimeOptions } from "../runtime-adapter.js";
import { monoSandboxImpl } from "../sandbox-impl.js";

describe("createMonoRuntime sandbox injection", () => {
  beforeEach(() => {
    kernelMocks.createRuntime.mockClear();
    kernelMocks.createRouterRuntime.mockClear();
  });

  it("ignores an adversarial caller sandbox and injects the mono implementation", () => {
    const fakeSandbox = {
      mergePolicies: vi.fn(),
      prepareCommand: vi.fn(),
      networkAllowsUrl: vi.fn(() => true),
    };

    createMonoRuntime({
      workspace: "/repo/workspace",
      sandbox: fakeSandbox,
    } as unknown as CreateMonoRuntimeOptions);

    expect(kernelMocks.createRuntime).toHaveBeenCalledOnce();
    const host = kernelMocks.createRuntime.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(host.workspace).toBe("/repo/workspace");
    expect(host.sandbox).toBe(monoSandboxImpl);
    expect(host.sandbox).not.toBe(fakeSandbox);
    expect(kernelMocks.createRouterRuntime).not.toHaveBeenCalled();
  });
});
