import { mkdtemp, readFile, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { accountHomeDirectory } from "../host/account-home.js";
import { acquireAgentRootOwnership, agentRootLeasePath, releaseAgentRootOwnershipWhenIdle } from "../durable-state/agent-root-coordinator.js";

it("isolates default source and built leases before either graph can use the account home", async () => {
  const home = accountHomeDirectory();
  const builtHome = await import("../../dist/host/account-home.js");
  // These guards run BEFORE acquisition; a missing setup mock cannot touch the
  // real lease directory even when this regression test fails.
  expect(home).toBe(process.env.MONO_AGENT_TEST_LEASE_HOME);
  expect(home).not.toBe(userInfo().homedir);
  expect(builtHome.accountHomeDirectory()).toBe(home);
  const scratch = await mkdtemp(join(home, "ownership-"));
  try {
    async function verify<Owner extends { readonly agentRoot: string }>(coordinator: {
      acquireAgentRootOwnership(root: string): Promise<Owner>;
      agentRootLeasePath(root: string, homeDir: string): string;
      releaseAgentRootOwnershipWhenIdle(owner: Owner): Promise<boolean>;
    }): Promise<void> {
      const root = await mkdtemp(join(scratch, "agent-"));
      const ownership = await coordinator.acquireAgentRootOwnership(root);
      try {
        const record = JSON.parse(await readFile(coordinator.agentRootLeasePath(ownership.agentRoot, home) + "/owner.json", "utf8"));
        expect(record.pid).toBe(process.pid);
      } finally { await coordinator.releaseAgentRootOwnershipWhenIdle(ownership); }
    }
    await verify({ acquireAgentRootOwnership, agentRootLeasePath, releaseAgentRootOwnershipWhenIdle });
    await verify(await import("../../dist/durable-state/agent-root-coordinator.js"));
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

it("keeps the production account-home policy independent of HOME", async () => {
  const actual = await vi.importActual<typeof import("../host/account-home.js")>("../host/account-home.js");
  vi.stubEnv("HOME", "/home/example/shell");
  try { expect(actual.accountHomeDirectory()).toBe(userInfo().homedir); }
  finally { vi.unstubAllEnvs(); }
});

it("requires child fixtures to name an isolated home, never silently defaulting", async () => {
  // The helper loads the built graph, but must reject before any filesystem I/O.
  const { acquireTestAgentRootOwnership } = await import(new URL("./fixtures/test-agent-root-ownership.mjs", import.meta.url).href);
  const previous = process.env.MONO_AGENT_TEST_LEASE_HOME;
  delete process.env.MONO_AGENT_TEST_LEASE_HOME;
  try { await expect(acquireTestAgentRootOwnership("/unused/fictional-agent")).rejects.toThrow("isolated test lease home"); }
  finally { process.env.MONO_AGENT_TEST_LEASE_HOME = previous; }
});
