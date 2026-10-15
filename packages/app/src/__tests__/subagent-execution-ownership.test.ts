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
  it.each([undefined, true])("pins confirmed managed release evidence until explicit receipt acknowledgement (%s)", (receiptPending) => {
    const value = ownership(); value.registryRoot = "/registered/children";
    value.owner.settlement = "settled"; value.revoked = true;
    value.disposition = { status: "ok", continuity: "retained" };
    value.publication = { sequence: 4, state: "confirmed", ...(receiptPending === undefined ? {} : { receiptPending }) };
    const record = { kind: "internal" as const, subagentOwnership: value };
    expect(isSubagentExecutionOwnership(value)).toBe(true);
    expect(hasUnresolvedSubagentOwnership(record)).toBe(false);
    expect(hasPendingSubagentPublication(record)).toBe(true); expect(hasSubagentObligation(record)).toBe(true);
    value.publication.receiptPending = false;
    expect(hasSubagentObligation(record)).toBe(false);
    expect(isSubagentExecutionOwnership({ ...value, publication: { ...value.publication, receiptPending: "false" } })).toBe(false);
  });
  it("does not promote legacy childStillBusy to released or ordinary commands to child owners", () => {
    expect(hasSubagentObligation({ kind: "internal", childStillBusy: true })).toBe(true);
    expect(hasSubagentObligation({ kind: "internal", childStillBusy: false })).toBe(false);
    expect(hasSubagentObligation({})).toBe(false);
  });
});

describe("strict bounded ownership schema", () => {
  it("loads old dispositions and restricts timeout certificates to retained settled timeouts", () => {
    const value = ownership(); value.owner.settlement = "settled"; value.revoked = true;
    value.disposition = { status: "timeout", reason: "timeout", continuity: "unknown" };
    expect(isSubagentExecutionOwnership(value)).toBe(true);
    value.disposition = { status: "timeout", reason: "timeout", continuity: "retained", certifiedTimeout: true };
    expect(isSubagentExecutionOwnership(value)).toBe(true);
    for (const disposition of [{ ...value.disposition, reason: "failed" }, { ...value.disposition, continuity: "unknown" },
      { ...value.disposition, status: "cancelled" }, { ...value.disposition, certifiedTimeout: false }]) {
      expect(isSubagentExecutionOwnership({ ...value, disposition })).toBe(false);
    }
  });
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


it("validates intentional stop certificates without weakening ownership or publication holds", () => {
  const value = ownership(); value.parentStopRequested = true;
  expect(isSubagentExecutionOwnership(value)).toBe(true);
  expect(isSubagentExecutionOwnership({ ...value, parentStopRequested: false })).toBe(false);
  value.disposition = { status: "cancelled", reason: "cancelled", continuity: "retained", resumeAfterStop: true };
  expect(isSubagentExecutionOwnership(value)).toBe(false); // still running
  value.owner.settlement = "settled"; value.revoked = true;
  expect(isSubagentExecutionOwnership(value)).toBe(true);
  expect(isSubagentExecutionOwnership({ ...value, parentStopRequested: undefined })).toBe(false);
  expect(isSubagentExecutionOwnership({ ...value, disposition: { ...value.disposition, continuity: "unknown" } })).toBe(false);
  expect(isSubagentExecutionOwnership({ ...value, disposition: { ...value.disposition, status: "timeout" } })).toBe(false);
  value.command = { ...command(), state: "cleanup_unknown" }; value.seenCalls = [value.command.callKey];
  expect(hasSubagentObligation({ kind: "internal", subagentOwnership: value })).toBe(true);
  value.command.state = "released";
  expect(hasSubagentObligation({ kind: "internal", subagentOwnership: value })).toBe(true); // pending publication
});
