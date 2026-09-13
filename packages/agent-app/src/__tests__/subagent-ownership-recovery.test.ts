import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { reconcileSubagentExecutionOwnership, type SubagentOwnershipRecoveryCapabilities } from "../subagent-ownership-recovery.js";
import { hasSubagentObligation, hasUnresolvedSubagentOwnership, isSubagentExecutionOwnership, type SubagentExecutionOwnership } from "../subagent-execution-ownership.js";
const incarnation = { schema: "mono-agent.process-incarnation.v1" as const, bootSessionId: "boot", processStartId: "birth" };
function fixture() {
  const owner: SubagentExecutionOwnership = { schemaVersion: 1, instanceIncarnation: randomUUID(), turnToken: randomUUID(),
    owner: { pid: 123, incarnation, settlement: "running" }, revoked: false, publication: { sequence: 1, state: "confirmed" }, seenCalls: ["attempt:call"],
    command: { id: randomUUID(), callKey: "attempt:call", tool: "Exec", state: "running", cwd: "/worktree", sandboxSettingsPath: null,
      pid: 456, pgid: 456, incarnation, deadlineAt: 100_000 } };
  const capabilities = { currentIncarnation: incarnation,
    readIncarnation: vi.fn<SubagentOwnershipRecoveryCapabilities["readIncarnation"]>(async () => undefined),
    sameIncarnation: vi.fn(async () => true), groupAbsent: vi.fn(() => false), signalGroup: vi.fn(() => true),
    grace: vi.fn(async () => {}), waitForGroupExit: vi.fn(async () => true), cleanup: vi.fn(async () => true) };
  return { owner, capabilities };
}
describe("one bounded subagent owner reconciliation pass", () => {
  it("separately proves owner death and group exit, then pins registry publication", async () => {
    const { owner, capabilities } = fixture();
    const result = await reconcileSubagentExecutionOwnership(owner, capabilities);
    expect(result).toMatchObject({ owner: { settlement: "dead" }, revoked: true, command: { state: "released" }, publication: { sequence: 2, state: "pending" } });
    expect(capabilities.signalGroup.mock.calls).toEqual([[456, "SIGTERM"], [456, "SIGKILL"]]);
    expect(capabilities.cleanup).toHaveBeenCalledOnce();
    expect(hasUnresolvedSubagentOwnership({ kind: "internal", subagentOwnership: result })).toBe(false);
    expect(hasSubagentObligation({ kind: "internal", subagentOwnership: result })).toBe(true);
    expect(isSubagentExecutionOwnership(result)).toBe(true);
    expect(owner.owner.settlement).toBe("running");
    expect(await reconcileSubagentExecutionOwnership(result, capabilities)).toEqual(result);
  });
  it.each(["alive", "unreadable"])("does not signal or clean while provider is %s", async (state) => {
    const { owner, capabilities } = fixture();
    capabilities.readIncarnation.mockImplementation(async () => { if (state === "unreadable") throw new Error("EPERM"); return incarnation; });
    const result = await reconcileSubagentExecutionOwnership(owner, capabilities);
    expect(result.owner.settlement).toBe("unknown");
    expect(capabilities.signalGroup).not.toHaveBeenCalled(); expect(capabilities.cleanup).not.toHaveBeenCalled();
    expect(hasUnresolvedSubagentOwnership({ kind: "internal", subagentOwnership: result })).toBe(true);
  });
  it("never signals a reused leader or mistakes its absence for group absence", async () => {
    const { owner, capabilities } = fixture(); capabilities.sameIncarnation.mockResolvedValue(false);
    const result = await reconcileSubagentExecutionOwnership(owner, capabilities);
    expect(result.command?.state).toBe("cleanup_unknown");
    expect(capabilities.signalGroup).not.toHaveBeenCalled(); expect(capabilities.cleanup).not.toHaveBeenCalled();
  });
  it("can release a positively absent group without claiming leader identity", async () => {
    const { owner, capabilities } = fixture(); capabilities.sameIncarnation.mockResolvedValue(false); capabilities.groupAbsent.mockReturnValue(true);
    const result = await reconcileSubagentExecutionOwnership(owner, capabilities);
    expect(result.command?.state).toBe("released"); expect(capabilities.signalGroup).not.toHaveBeenCalled();
  });
  it("accepts proved OS reboot independently of unreadable/reused PIDs", async () => {
    const { owner, capabilities } = fixture(); capabilities.currentIncarnation = { ...incarnation, bootSessionId: "new-boot" };
    capabilities.readIncarnation.mockRejectedValue(new Error("EPERM"));
    const result = await reconcileSubagentExecutionOwnership(owner, capabilities);
    expect(result).toMatchObject({ owner: { settlement: "dead" }, command: { state: "released" } });
    expect(capabilities.readIncarnation).not.toHaveBeenCalled(); expect(capabilities.signalGroup).not.toHaveBeenCalled();
  });
  it("retains pre-attestation no-release proof when settings cleanup initially fails", async () => {
    const { owner, capabilities } = fixture(); Object.assign(owner.command!, { state: "preparing", pid: null, pgid: null, incarnation: null });
    capabilities.cleanup.mockResolvedValueOnce(false);
    const unresolved = await reconcileSubagentExecutionOwnership(owner, capabilities);
    expect(unresolved.command?.state).toBe("cleanup_unknown");
    const resolved = await reconcileSubagentExecutionOwnership(unresolved, capabilities);
    expect(resolved.command?.state).toBe("released"); expect(capabilities.signalGroup).not.toHaveBeenCalled();
  });
  it("does not promote failed group-exit proof to a released command", async () => {
    const { owner, capabilities } = fixture(); capabilities.waitForGroupExit.mockResolvedValue(false);
    const result = await reconcileSubagentExecutionOwnership(owner, capabilities);
    expect(result.command?.state).toBe("cleanup_unknown"); expect(capabilities.cleanup).not.toHaveBeenCalled();
  });
});
