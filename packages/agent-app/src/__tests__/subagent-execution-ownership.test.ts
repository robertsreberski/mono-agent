import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hasPendingSubagentPublication, hasSubagentObligation, hasUnresolvedSubagentOwnership,
  isSubagentExecutionOwnership, isSubagentOwnedCommand, type SubagentExecutionOwnership,
  type SubagentOwnedCommand } from "../subagent-execution-ownership.js";

const incarnation = { schema: "mono-agent.process-incarnation.v1" as const, bootSessionId: "boot", processStartId: "birth" };
const ownership = (): SubagentExecutionOwnership => ({ schemaVersion: 1, instanceIncarnation: randomUUID(), turnToken: randomUUID(),
  owner: { pid: 123, incarnation, settlement: "running" }, revoked: false,
  publication: { sequence: 1, state: "pending" }, seenCalls: [] });
const command = (): SubagentOwnedCommand => ({ id: randomUUID(), callKey: "attempt:call", tool: "Exec", state: "running",
  cwd: "/worktree", sandboxSettingsPath: null, pid: 456, pgid: 456, incarnation, deadlineAt: 170_000 });

describe("durable subagent ownership predicate", () => {
  it.each(["queued", "running", "succeeded", "timed_out", "cancelled", "interrupted"])("ignores reporting status %s and settled wake when U/P remain", (state) => {
    const held = { kind: "internal" as const, state, wake: { state: "delivered" }, subagentOwnership: ownership() };
    expect(hasUnresolvedSubagentOwnership(held)).toBe(true);
    expect(hasPendingSubagentPublication(held)).toBe(true);
    expect(hasSubagentObligation(held)).toBe(true);
    held.subagentOwnership.owner.settlement = "settled";
    held.subagentOwnership.revoked = true;
    expect(hasUnresolvedSubagentOwnership(held)).toBe(false);
    expect(hasSubagentObligation(held)).toBe(true);
    held.subagentOwnership.publication.state = "confirmed";
    expect(hasSubagentObligation(held)).toBe(false);
  });
  it.each(["running", "terminating", "cleanup_unknown"] as const)("pins a %s command after provider death and registry publication", (state) => {
    const value = ownership(); value.owner.settlement = "dead"; value.revoked = true;
    value.publication.state = "confirmed"; value.command = { ...command(), state }; value.seenCalls = [value.command.callKey];
    expect(isSubagentExecutionOwnership(value)).toBe(true);
    expect(hasSubagentObligation({ kind: "internal", subagentOwnership: value })).toBe(true);
    value.command.state = "released";
    expect(hasSubagentObligation({ kind: "internal", subagentOwnership: value })).toBe(false);
  });
  it("does not promote legacy childStillBusy to released or ordinary commands to child owners", () => {
    expect(hasSubagentObligation({ kind: "internal", childStillBusy: true })).toBe(true);
    expect(hasSubagentObligation({ kind: "internal", childStillBusy: false })).toBe(false);
    expect(hasSubagentObligation({})).toBe(false);
  });
});

describe("strict bounded ownership schema", () => {
  it("accepts pre-launch, active and released identities without raw command contents", () => {
    const value = ownership(); expect(isSubagentExecutionOwnership(value)).toBe(true);
    value.command = { ...command(), state: "preparing", pid: null, pgid: null, incarnation: null };
    value.seenCalls = [value.command.callKey]; expect(isSubagentExecutionOwnership(value)).toBe(true);
    value.command = command(); expect(isSubagentExecutionOwnership(value)).toBe(true);
    value.command.state = "released"; value.owner.settlement = "settled"; value.revoked = true;
    value.publication.state = "confirmed"; expect(isSubagentExecutionOwnership(value)).toBe(true);
  });
  it.each([
    { schemaVersion: 2 }, { instanceIncarnation: "reused-id" }, { turnToken: "" }, { unknown: true },
    { seenCalls: ["a", "a"] }, { seenCalls: ["é".repeat(257)] }, { seenCalls: Array.from({ length: 257 }, (_, i) => String(i)) },
    { seenCalls: Array.from({ length: 256 }, (_, i) => `${i}:${"x".repeat(130)}`) },
    { owner: { pid: 1, incarnation, settlement: "settled" } },
    { owner: { pid: 0, incarnation, settlement: "running" } },
    { owner: { pid: 1, incarnation: { ...incarnation, argv: "private" }, settlement: "running" } },
    { publication: { sequence: 0, state: "pending" } }, { publication: { sequence: 1, state: "acknowledged" } },
  ])("rejects malformed or over-bound private data: %j", (patch) => {
    expect(isSubagentExecutionOwnership({ ...ownership(), ...patch })).toBe(false);
  });
  it("requires the active command in the non-evicting call ledger", () => {
    const value = ownership(); value.command = command();
    expect(isSubagentExecutionOwnership(value)).toBe(false);
    value.seenCalls = [value.command.callKey]; expect(isSubagentExecutionOwnership(value)).toBe(true);
    value.owner.settlement = "not_started"; expect(isSubagentExecutionOwnership(value)).toBe(false);
  });
  it.each([{ pgid: 999 }, { pid: null, pgid: null }, { incarnation: null }, { state: "preparing" },
    { cwd: "/worktree/../other" }, { cwd: "relative" }, { cwd: "/worktree\0" }, { deadlineAt: Infinity },
    { sandboxSettingsPath: "/private/delete-me" }, { rawArgv: ["secret"] }, { id: "call" },
  ])("rejects unsafe process identities before signaling: %j", (patch) => {
    expect(isSubagentOwnedCommand({ ...command(), ...patch })).toBe(false);
  });
});
