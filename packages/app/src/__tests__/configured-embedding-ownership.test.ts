import type { MonoAgentConfig } from "@mono-agent/config";
import { afterEach, expect, it, vi } from "vitest";

import { wrapOwnedDirectEmbeddingProvider } from "../composition/runtime-ownership.js";

const seams = vi.hoisted(() => ({
  acquire: vi.fn(), assertWorkspace: vi.fn(), releaseRoot: vi.fn(), load: vi.fn(), attest: vi.fn(),
}));
vi.mock("../durable-state/agent-root-coordinator.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../durable-state/agent-root-coordinator.js")>(),
  acquireAgentRootOwnership: seams.acquire,
  assertAgentRootLeaseOutsideWorkspace: seams.assertWorkspace,
  releaseAgentRootOwnershipWhenIdle: seams.releaseRoot,
}));
vi.mock("../process-jobs/process-jobs-root-registry.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../process-jobs/process-jobs-root-registry.js")>(),
  loadProcessJobsRootRegistryProtection: seams.load,
  attestProcessJobsRootRegistrySnapshot: seams.attest,
}));
afterEach(() => { vi.resetAllMocks(); });

it.each([false, true])("acquires and holds the direct embedding generation lease through settlement (reject=%s)", async (reject) => {
  const order: string[] = [];
  const generation = { id: "fictional-generation", rootKeys: [] };
  const boundary = { generation };
  let grant!: (owner: unknown) => void;
  const acquisition = new Promise((resolve) => { grant = resolve; });
  seams.acquire.mockImplementation(async () => { order.push("acquire-root"); return await acquisition; });
  seams.assertWorkspace.mockImplementation(() => { order.push("check-workspace"); });
  seams.load.mockImplementation(async () => { order.push("load-generation"); return boundary; });
  seams.attest.mockImplementation(async (snapshot) => { order.push("attest-generation"); return snapshot; });
  seams.releaseRoot.mockImplementation(async () => { order.push("release-root"); return true; });
  const releaseAfterSettlement = vi.fn(() => { order.push("release-lease"); });
  const synchronizeGeneration = vi.fn(() => { order.push("synchronize-generation"); });
  const acquireRequestLease = vi.fn(() => { order.push("acquire-lease"); return { releaseAfterSettlement }; });
  const owner = { agentRoot: "/fictional/agent", coordinator: { synchronizeGeneration, acquireRequestLease } };
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let settle!: (value: number[][]) => void;
  let fail!: (reason: Error) => void;
  const result = new Promise<number[][]>((resolve, rejectResult) => { settle = resolve; fail = rejectResult; });
  const embed = vi.fn(async () => { order.push("embed"); enter(); return await result; });
  const provider = wrapOwnedDirectEmbeddingProvider({ id: "fictional:embedding", embed }, {
    runtime: { workspace: "/fictional/workspace" },
  } as MonoAgentConfig, "/fictional/agent");
  const pending = provider.embed(["fictional input"]);
  // A bypass mutant enters the provider immediately, rather than awaiting root acquisition.
  expect(seams.acquire).toHaveBeenCalledExactlyOnceWith("/fictional/agent");
  expect(embed).not.toHaveBeenCalled();
  grant(owner);
  await entered;
  expect(order).toEqual(["acquire-root", "check-workspace", "load-generation", "synchronize-generation",
    "attest-generation", "acquire-lease", "attest-generation", "embed"]);
  expect(seams.assertWorkspace).toHaveBeenCalledWith(owner, "/fictional/workspace");
  expect(seams.load).toHaveBeenCalledWith(owner.agentRoot, "/fictional/workspace");
  expect(synchronizeGeneration).toHaveBeenCalledWith(generation);
  expect(acquireRequestLease).toHaveBeenCalledExactlyOnceWith(generation);
  expect(seams.attest).toHaveBeenCalledTimes(2);
  expect(embed).toHaveBeenCalledExactlyOnceWith(["fictional input"]);
  expect(releaseAfterSettlement).not.toHaveBeenCalled();
  expect(seams.releaseRoot).not.toHaveBeenCalled();
  if (reject) {
    const rejection = expect(pending).rejects.toThrow("fictional embedding failure");
    fail(new Error("fictional embedding failure"));
    await rejection;
  } else {
    settle([[7]]);
    await expect(pending).resolves.toEqual([[7]]);
  }
  expect(order.slice(-2)).toEqual(["release-lease", "release-root"]);
  expect(releaseAfterSettlement).toHaveBeenCalledOnce();
  expect(seams.releaseRoot).toHaveBeenCalledExactlyOnceWith(owner);
});
