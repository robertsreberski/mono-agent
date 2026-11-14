import { expect, it, vi } from "vitest";
import { registerTraceSource } from "@mono-agent/observability";
import { startTraceability } from "../host/app-controller-traceability.js";

vi.mock("@mono-agent/observability", async (original) => ({
  ...await original<typeof import("@mono-agent/observability")>(),
  registerTraceSource: vi.fn(async () => ({})),
  pruneTraceSources: vi.fn(async () => undefined),
}));
vi.mock("../composition/app-config.js", async (original) => ({
  ...await original<typeof import("../composition/app-config.js")>(),
  resolveAppTraceRegistryDir: async () => "/synthetic/registry",
  resolveAppArtifactDir: async () => "/synthetic/artifacts",
  resolveAppTraceSourceId: async () => "synthetic-source",
  resolveAppTraceSourceLabel: async () => "Synthetic agent",
  resolveAppTraceHeartbeatMs: async () => 60000,
  resolveAppTraceGlobalDiscovery: async () => true,
  resolveGlobalTraceRegistryDir: () => "/synthetic/global-registry",
  resolveTraceTmpdirRoot: () => "/synthetic/tmp",
  shouldMirrorTraceSourceGlobally: () => true,
}));
it("publishes the action's full process identity in both local and global discovery", async () => {
  const controller = {
    stopped: false, env: {}, cwd: "/synthetic", configPath: "/synthetic/config.json", configReadPath: "/synthetic/frozen.json",
    refreshSelectedSkillsSnapshot: vi.fn(async () => undefined),
    refreshMemoryHealthSnapshot: vi.fn(async () => undefined),
    activeTransports: () => [], traceMetadata: () => ({}),
    startMemoryHealthRefreshLoop: vi.fn(), clearMemoryHealthRefreshTimer: vi.fn(),
    restartArtifactRetentionScheduler: vi.fn(),
  } as unknown as Parameters<typeof startTraceability>[0];
  expect(await startTraceability(controller, "synthetic-start")).toMatchObject({ kind: "running" });
  expect(registerTraceSource).toHaveBeenCalledTimes(2);
  for (const [options] of vi.mocked(registerTraceSource).mock.calls) {
    expect(options).toMatchObject({ pid: process.pid, startedAt: new Date(performance.timeOrigin).toISOString() });
  }
});
