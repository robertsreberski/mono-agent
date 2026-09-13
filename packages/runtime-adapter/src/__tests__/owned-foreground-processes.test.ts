import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createRuntime } from "@mono-agent/agent-runtime";
import { bridgeOwnedForegroundProcesses, type OwnedForegroundProcesses, type OwnedForegroundProcessRequest } from "../owned-foreground-processes.js";
import type { RuntimeRunOptions } from "../types.js";

type KernelOptions = Parameters<ReturnType<typeof createRuntime>["run"]>[1];
type KernelOwner = NonNullable<KernelOptions["ownedForegroundProcesses"]>;

describe("owned foreground process adapter bridge", () => {
  it("keeps the dependency-free kernel seam structurally equivalent", () => {
    expectTypeOf<OwnedForegroundProcesses>().toExtend<KernelOwner>();
    expectTypeOf<KernelOwner>().toExtend<OwnedForegroundProcesses>();
    expectTypeOf<RuntimeRunOptions["ownedForegroundProcesses"]>().toEqualTypeOf<OwnedForegroundProcesses | undefined>();
  });
  it("mints attempt-local closures and forwards exact prepared/launcher/signal identities", async () => {
    const result = { code: 0, signal: null, stdout: "ok", stderr: "", aborted: false, timedOut: false,
      bufferExceeded: false, truncated: false, bytes: 2, storedBytes: 2, spawnError: null, durationMs: 2 };
    const run = vi.fn(async (_request: OwnedForegroundProcessRequest) => result);
    const forAttempt = vi.fn(() => ({ run }));
    const bridge = bridgeOwnedForegroundProcesses({ forAttempt });
    const first = bridge.forAttempt(); const second = bridge.forAttempt();
    expect(first).not.toBe(second);
    expect(forAttempt).toHaveBeenCalledTimes(2);
    const request: OwnedForegroundProcessRequest = { tool: "Exec", callId: "call", timeoutMs: 130_000,
      prepared: { command: "/usr/bin/true", args: [], cwd: "/tmp", sandboxed: false },
      signal: new AbortController().signal, launch: vi.fn() };
    expect(await first.run(request)).toBe(result);
    expect(run.mock.calls[0]?.[0]).toBe(request);
  });
  it("rejects malformed identities/budgets before host execution and cleans rejected preparation", async () => {
    const run = vi.fn(); const cleanup = vi.fn(async () => {});
    const controller = bridgeOwnedForegroundProcesses({ forAttempt: () => ({ run }) }).forAttempt();
    for (const patch of [{ callId: "" }, { callId: "é".repeat(129) }, { timeoutMs: 0 }, { tool: "Monitor" }]) {
      await expect(controller.run({ tool: "Exec", callId: "call", timeoutMs: 1,
        prepared: { command: "unused", args: [], cwd: "/tmp", sandboxed: false, cleanup }, launch: vi.fn(),
        ...patch } as OwnedForegroundProcessRequest)).rejects.toThrow(/invalid/);
    }
    expect(run).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalledTimes(4);
  });
  it("rejects a broken owner or attempt instead of falling back", () => {
    expect(() => bridgeOwnedForegroundProcesses({} as never)).toThrow(/invalid/);
    expect(() => bridgeOwnedForegroundProcesses({ forAttempt: () => ({}) } as never).forAttempt()).toThrow(/invalid/);
  });
});
