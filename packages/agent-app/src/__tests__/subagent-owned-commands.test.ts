import { emptySubagentCommandReceipts, isSubagentCommandReceipts, type SubagentCommandReceipts } from "../subagent-command-receipts.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { OwnedForegroundProcessRequest, ProcessJobProcessResult } from "@mono-agent/runtime-adapter";
import { createSubagentOwnedCommands } from "../subagent-owned-commands.js";
import { isSubagentExecutionOwnership, type SubagentExecutionOwnership } from "../subagent-execution-ownership.js";
const incarnation = { schema: "mono-agent.process-incarnation.v1" as const, bootSessionId: "boot", processStartId: "birth" };
const result: ProcessJobProcessResult = { code: 0, signal: null, stdout: "ok", stderr: "", aborted: false, timedOut: false,
  bufferExceeded: false, truncated: false, bytes: 2, storedBytes: 2, spawnError: null, durationMs: 1, groupExitConfirmed: true };
function fixture() {
  const owner: SubagentExecutionOwnership = { schemaVersion: 1, instanceIncarnation: randomUUID(), turnToken: randomUUID(),
    owner: { pid: 1, incarnation, settlement: "running" }, revoked: false, publication: { sequence: 1, state: "pending" }, seenCalls: [] };
  const receipts = emptySubagentCommandReceipts();
  const cleanup = vi.fn(async () => {});
  const release = vi.fn(async () => { expect(owner.command?.state).toBe("running"); });
  const cancel = vi.fn();
  let completion: Promise<ProcessJobProcessResult> = Promise.resolve(result);
  const request: OwnedForegroundProcessRequest = { tool: "Exec", callId: "call", timeoutMs: 10_000,
    prepared: { command: "/bin/echo", args: ["private-argument"], cwd: "/workspace", env: { PRIVATE: "private-value" }, sandboxed: true, cleanup },
    launch: vi.fn((options) => {
      expect(options?.timeoutMs).toBe(5000); expect(owner.command?.state).toBe("preparing");
      return { pid: 20, pgid: 20, startedAt: new Date(0).toISOString(), release, cancel, completion };
    }) };
  const mutate = vi.fn(async (operation: (value: SubagentExecutionOwnership, receipts: SubagentCommandReceipts) => void) => {
    const next = structuredClone(owner); const facts = structuredClone(receipts); operation(next, facts);
    expect(isSubagentExecutionOwnership(next)).toBe(true); expect(isSubagentCommandReceipts(facts)).toBe(true);
    Object.assign(owner, next); Object.assign(receipts, facts);
  });
  const commands = createSubagentOwnedCommands({ now: () => 1000, deadlineAt: 6000, maxOutputBytes: 1024,
    mutate, readIncarnation: async () => incarnation, changed: async () => {} });
  return { owner, receipts, request, commands, cleanup, release, cancel, mutate, setCompletion: (value: Promise<ProcessJobProcessResult>) => { completion = value; } };
}
describe("borrowed awaited command controller", () => {
  it("persists preparation and incarnation before release, bounds time, omits raw command/env and deduplicates calls", async () => {
    const f = fixture(); const attempt = f.commands.processes.forAttempt();
    expect(await attempt.run(f.request)).toBe(result);
    expect(f.cleanup).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
    expect(f.owner.command).toMatchObject({ state: "released", pid: 20, pgid: 20, incarnation });
    expect(JSON.stringify(f.owner)).not.toContain("private-");
    await expect(attempt.run(f.request)).rejects.toThrow("already executed");
    expect(f.request.launch).toHaveBeenCalledOnce();
    await f.commands.processes.forAttempt().run(f.request);
    expect(f.owner.seenCalls).toEqual(["1:call", "2:call"]);
    expect(f.receipts.commands).toHaveLength(2);
    expect(f.receipts.commands[0]).toMatchObject({ budgetMs: 5000, exitCode: 0, completion: "observed", cleanup: "confirmed" });
    expect(JSON.stringify(f.receipts)).not.toContain("private-");
  });
  it("refuses overlapping commands instead of waiting for a second scheduler slot", async () => {
    const f = fixture(); let finish!: (value: ProcessJobProcessResult) => void;
    f.setCompletion(new Promise((resolve) => { finish = resolve; }));
    const attempt = f.commands.processes.forAttempt(); const running = attempt.run(f.request);
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
    await expect(attempt.run({ ...f.request, callId: "other" })).rejects.toThrow("slot is unavailable");
    expect(f.request.launch).toHaveBeenCalledOnce();
    finish(result); await running;
  });
  it("never releases a gate if durable attestation fails", async () => {
    const f = fixture(); const ordinary = f.mutate.getMockImplementation()!;
    let writes = 0;
    f.mutate.mockImplementation(async (operation) => { if (++writes === 2) throw new Error("disk full"); await ordinary(operation); });
    await expect(f.commands.processes.forAttempt().run(f.request)).rejects.toThrow("disk full");
    expect(f.release).not.toHaveBeenCalled(); expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.owner.revoked).toBe(true);
  });
  it("withholds settings cleanup and holds unknown group ownership", async () => {
    const f = fixture(); f.setCompletion(Promise.resolve({ ...result, groupExitConfirmed: false }));
    await expect(f.commands.processes.forAttempt().run(f.request)).rejects.toThrow("cleanup remains unresolved");
    expect(f.cleanup).not.toHaveBeenCalled(); expect(f.owner.command?.state).toBe("cleanup_unknown");
    expect(f.receipts.commands[0]).toMatchObject({ exitCode: 0, cleanup: "unknown" });
    expect(() => f.commands.processes.forAttempt()).toThrow("revoked");
  });
  it("revokes even an already minted attempt before future commands can launch", async () => {
    const f = fixture(); const attempt = f.commands.processes.forAttempt(); f.commands.revoke();
    await expect(attempt.run(f.request)).rejects.toThrow("unavailable");
    expect(f.request.launch).not.toHaveBeenCalled(); expect(f.cleanup).toHaveBeenCalledOnce();
  });
});
