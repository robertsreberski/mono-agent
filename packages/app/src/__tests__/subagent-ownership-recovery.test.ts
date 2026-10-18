import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { reconcileSubagentExecutionOwnership, type SubagentOwnershipRecoveryCapabilities } from "../subagents/subagent-ownership-recovery.js";
import { hasSubagentObligation, hasUnresolvedSubagentOwnership, isSubagentExecutionOwnership } from "../subagents/subagent-execution-ownership.js";
import { type SubagentExecutionOwnership } from "../subagents/types.js";
import type { ProcessIncarnation } from "@mono-agent/conversation/process-incarnation";
const incarnation: ProcessIncarnation = { schema: "mono-agent.process-incarnation.v1", bootSessionId: "boot", processStartId: "birth" };
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

describe("Darwin stable-incarnation transition (#1264)", () => {
  const stable = { schema: "mono-agent.process-incarnation.v2" as const, bootSessionId: "darwin-uuid:fictional-boot", processStartId: "posix-utc-lstart:Mon Jan 5 12:34:56 2026" };
  it("a probe timeout leaves a v2 provider unknown, never dead", async () => {
    const { owner, capabilities } = fixture(); owner.owner.incarnation = stable; capabilities.currentIncarnation = stable;
    capabilities.readIncarnation.mockRejectedValue(Object.assign(new Error("Fictional probe timeout"), { killed: true, signal: "SIGKILL" }));
    const result = await reconcileSubagentExecutionOwnership(owner, capabilities);
    expect(result.owner.settlement).toBe("unknown");
    expect(capabilities.signalGroup).not.toHaveBeenCalled(); expect(capabilities.cleanup).not.toHaveBeenCalled();
    expect(result.command?.state).toBe("running");
  });
  it("a live legacy v1 provider is unknown: its calendar boot id is never compared with a v2 boot-session id", async () => {
    const { owner, capabilities } = fixture(); capabilities.currentIncarnation = stable;
    capabilities.readIncarnation.mockResolvedValue({ ...stable, processStartId: "posix-utc-lstart:Tue Jan 6 08:00:00 2026" });
    const result = await reconcileSubagentExecutionOwnership(owner, capabilities);
    expect(result.owner.settlement).toBe("unknown");
    expect(capabilities.readIncarnation).toHaveBeenCalledWith(123);
    expect(capabilities.signalGroup).not.toHaveBeenCalled(); expect(result.command?.state).toBe("running");
  });
  it("a dead legacy provider (ESRCH) is still dead, but its v1 command is never certified released by a cross-schema boot id", async () => {
    const { owner, capabilities } = fixture(); capabilities.currentIncarnation = stable; capabilities.sameIncarnation.mockResolvedValue(false);
    const result = await reconcileSubagentExecutionOwnership(owner, capabilities);
    expect(result.owner.settlement).toBe("dead");
    expect(result.command?.state).toBe("cleanup_unknown");
    expect(capabilities.signalGroup).not.toHaveBeenCalled(); expect(capabilities.cleanup).not.toHaveBeenCalled();
  });
  it("same-schema v2 evidence still proves reboot and PID reuse", async () => {
    const rebooted = fixture(); rebooted.owner.owner.incarnation = stable; rebooted.owner.command!.incarnation = stable;
    rebooted.capabilities.currentIncarnation = { ...stable, bootSessionId: "darwin-uuid:fictional-next-boot" };
    expect(await reconcileSubagentExecutionOwnership(rebooted.owner, rebooted.capabilities)).toMatchObject({ owner: { settlement: "dead" }, command: { state: "released" } });
    expect(rebooted.capabilities.signalGroup).not.toHaveBeenCalled();
    const reused = fixture(); reused.owner.owner.incarnation = stable; reused.capabilities.currentIncarnation = stable;
    reused.capabilities.readIncarnation.mockResolvedValue({ ...stable, processStartId: "posix-utc-lstart:Tue Jan 6 08:00:00 2026" });
    expect((await reconcileSubagentExecutionOwnership(reused.owner, reused.capabilities)).owner.settlement).toBe("dead");
  });
  it("ownership records accept v2 evidence with the same exact keys and bounds", () => {
    const { owner } = fixture(); owner.owner.incarnation = stable; owner.command!.incarnation = stable;
    expect(isSubagentExecutionOwnership(owner)).toBe(true);
    expect(isSubagentExecutionOwnership({ ...owner, owner: { ...owner.owner, incarnation: { ...stable, extra: 1 } } })).toBe(false);
    expect(isSubagentExecutionOwnership({ ...owner, owner: { ...owner.owner, incarnation: { ...stable, schema: "mono-agent.process-incarnation.v3" } } })).toBe(false);
  });
});
