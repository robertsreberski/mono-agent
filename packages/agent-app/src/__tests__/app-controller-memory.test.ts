import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createConfiguredMemory: vi.fn(),
}));

vi.mock("../configured-agent.js", () => ({
  createConfiguredMemory: mocks.createConfiguredMemory,
  createConfiguredMemoryForApp: vi.fn(),
}));

import { memoryStore } from "../app-controller-memory.js";
import type { MemoryControllerPort } from "../app-controller-memory.js";

function controller(trustedRuntimeReadRoots: readonly string[]): MemoryControllerPort {
  return {
    cwd: "/agent",
    logger: undefined,
    trustedRuntimeReadRoots,
    processJobsProtectionPosture: undefined,
    sharedMemory: undefined,
    sharedMemoryRetrieval: undefined,
    sharedMemoryBuilt: false,
    sharedMemoryBuild: undefined,
    observabilityContext: async () => ({}),
    recordExporterWarning() {},
    ensureSharedMemoryRetrieval: () => undefined,
  } as MemoryControllerPort;
}

describe("memory plugin resolution posture", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createConfiguredMemory.mockResolvedValue({});
  });

  it("keeps a snapshot-publishing unmanaged systemd worker on normal plugin resolution", async () => {
    await memoryStore(controller([]), {} as never);
    expect(mocks.createConfiguredMemory).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ preferAppPluginInstall: false }),
    );
  });

  it("prefers the app-owned plugin closure only for a verified managed runtime", async () => {
    await memoryStore(controller(["/managed/runtime"]), {} as never);
    expect(mocks.createConfiguredMemory).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ preferAppPluginInstall: true }),
    );
  });
});
