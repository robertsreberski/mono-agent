import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MonoAgentConfig } from "@mono-agent/config";
import type { MonoRuntimeLike, RuntimeRunOptions } from "@mono-agent/turn/host/types";

// The wrapper acquires through the account home; keep it inside a temporary folder.
const accountHome = vi.hoisted(() => ({ path: "" }));
vi.mock("../host/account-home.js", () => ({ accountHomeDirectory: () => accountHome.path }));
vi.mock("@mono-agent/conversation/process-incarnation", async (importOriginal) => ({
  ...await importOriginal<typeof import("@mono-agent/conversation/process-incarnation")>(),
  currentProcessIncarnation: async () => ({
    schema: "mono-agent.process-incarnation.v1" as const,
    bootSessionId: "test-boot",
    processStartId: "vitest-runtime-ownership-retry",
  }),
  isSameProcessIncarnation: () => true,
  isProcessIncarnationLive: () => true,
}));

const { wrapOwnedConfiguredRuntime } = await import("../composition/runtime-ownership.js");
const { AGENT_ROOT_COORDINATION_BUSY_ERROR, AGENT_ROOT_LEASE_MUTATION_GATE } = await import(
  "../durable-state/agent-root-coordinator.js"
);

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("configured runtime ownership after a transient acquisition failure", () => {
  it("does not cache a coordination-busy rejection, so the next run acquires once the gate frees", async () => {
    const parent = await mkdtemp(join(tmpdir(), "mono-agent-runtime-ownership-retry-"));
    temporaryDirectories.push(parent);
    const root = join(parent, "agent");
    const workspace = join(root, "workspace");
    accountHome.path = join(parent, "home");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const leaseRoot = join(accountHome.path, ".mono-agent", "agent-root-leases");
    await mkdir(leaseRoot, { recursive: true, mode: 0o700 });
    const gatePath = join(leaseRoot, AGENT_ROOT_LEASE_MUTATION_GATE);
    await (await open(gatePath, "wx", 0o600)).close();

    const holder = spawn(process.execPath, ["--no-warnings", "--input-type=module", "--eval", `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(${JSON.stringify(gatePath)}, { timeout: 0 });
      db.exec("PRAGMA journal_mode=MEMORY");
      db.exec("BEGIN EXCLUSIVE");
      process.stdout.write("held\\n");
      process.stdin.once("data", () => { db.exec("ROLLBACK"); db.close(); process.exit(0); });
    `], { stdio: ["pipe", "pipe", "inherit"] });
    const exited = new Promise<void>((resolvePromise) => holder.once("exit", () => resolvePromise()));
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        holder.stdout.once("data", (chunk) => String(chunk).includes("held")
          ? resolvePromise()
          : rejectPromise(new Error(`unexpected holder output: ${String(chunk)}`)));
        holder.once("exit", () => rejectPromise(new Error("gate holder exited early")));
      });

      const run = vi.fn(async () => ({ text: "fictional result" }));
      const runtime = wrapOwnedConfiguredRuntime(
        { run } as unknown as MonoRuntimeLike,
        { runtime: { workspace: await realpath(workspace) } } as unknown as MonoAgentConfig,
        root,
        undefined,
      );
      const options = { cwd: workspace } as unknown as RuntimeRunOptions;

      await expect(runtime.run("system", options)).rejects.toThrow(AGENT_ROOT_COORDINATION_BUSY_ERROR);
      expect(run).not.toHaveBeenCalled();

      holder.stdin.write("release\n");
      await exited;
      await expect(runtime.run("system", options)).resolves.toMatchObject({ text: "fictional result" });
      expect(run).toHaveBeenCalledOnce();
      await runtime.disposeAllSessions!();
      await vi.waitFor(async () => {
        expect(await readdir(leaseRoot)).toEqual([AGENT_ROOT_LEASE_MUTATION_GATE]);
      }, { timeout: 5_000, interval: 10 });
    } finally {
      holder.kill("SIGKILL");
    }
  }, 20_000);
});
