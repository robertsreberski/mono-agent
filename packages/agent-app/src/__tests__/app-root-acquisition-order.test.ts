import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const order = vi.hoisted(() => [] as string[]);
const releaseOwnership = vi.hoisted(() => vi.fn());
const releaseOwnershipWhenIdle = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../agent-root-coordinator.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../agent-root-coordinator.js")>(),
  acquireAgentRootOwnership: async (cwd: string) => {
    order.push("ownership");
    return {
      agentRoot: resolve(cwd),
      coordinator: {
        synchronizeGeneration() {},
        publishGeneration() {},
      },
      release: releaseOwnership,
    };
  },
  releaseAgentRootOwnershipWhenIdle: releaseOwnershipWhenIdle,
  assertAgentRootLeaseOutsideWorkspace() {},
}));

vi.mock("../channels.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../channels.js")>(),
  resolveChannelDrivers: async () => {
    order.push("driver-resolution");
    return [];
  },
}));

vi.mock("../app-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app-config.js")>();
  return {
    ...actual,
    loadAppCoreConfig: async (...args: Parameters<typeof actual.loadAppCoreConfig>) => {
      order.push("core-config");
      return await actual.loadAppCoreConfig(...args);
    },
  };
});

const { startMonoAgentApp } = await import("../app.js");

const temporaryDirectories: string[] = [];

afterEach(async () => {
  order.length = 0;
  releaseOwnership.mockClear();
  releaseOwnershipWhenIdle.mockReset();
  releaseOwnershipWhenIdle.mockResolvedValue(true);
  await Promise.all(temporaryDirectories.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true })));
});

describe("full app agent-root acquisition order", () => {
  it("owns the canonical root before driver, service/config, or provider composition", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-app-root-order-"));
    temporaryDirectories.push(dir);
    await mkdir(join(dir, "artifacts"), { mode: 0o700 });
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    await writeFile(join(dir, "mono-agent.config.json"), JSON.stringify({
      runtime: { model: "pi:openai-codex:gpt-5.6-sol", workspace: "." },
      context: { identityPath: "./IDENTITY.md", selectedSkills: [] },
      tools: { allowedTools: [], disallowedTools: [] },
      artifacts: { dir: "./artifacts" },
      traceability: { registryDir: "./trace", globalDiscovery: false },
      processJobs: { enabled: false },
    }));

    const app = await startMonoAgentApp({ cwd: dir, env: {} });
    expect(order[0]).toBe("ownership");
    expect(order.indexOf("ownership")).toBeLessThan(order.indexOf("driver-resolution"));
    expect(order.indexOf("ownership")).toBeLessThan(order.indexOf("core-config"));

    let finishRelease!: (released: boolean) => void;
    releaseOwnershipWhenIdle.mockImplementationOnce(async () =>
      await new Promise<boolean>((resolvePromise) => { finishRelease = resolvePromise; }));
    const stopping = app.stop();
    await vi.waitFor(() => expect(releaseOwnershipWhenIdle).toHaveBeenCalledOnce());
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishRelease(true);
    await stopping;
    expect(stopped).toBe(true);
    expect(releaseOwnership).not.toHaveBeenCalled();
  });
});
