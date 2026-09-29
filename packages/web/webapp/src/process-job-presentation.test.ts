import { describe, expect, it } from "vitest";

import { collectProcessJobParentCalls, processJobAgentFamily, projectProcessJobPresentation } from "./process-job-presentation";
import { agentTurn, launchCall, manageCall, parentMessage, peerCall, peerStarted } from "./test/agent-group-fixtures";

const PEER_JOB_A = "0d6f3a2e-6c1b-4f7e-9a51-3b2c1d0e9f8a";
const PEER_JOB_B = "7e2d9c41-58a3-4b6f-a0c2-9d8e7f6a5b4c";

describe("collectProcessJobParentCalls", () => {
  const brief = agentTurn("job-1", "researcher-1", 0, { durationMinutes: 5 });
  const follow = agentTurn("job-2", "researcher-1", 10, { tool: "AgentManage" });

  it("pairs Agent and AgentManage launches with their jobs by the start receipt and reads only the message text", () => {
    const calls = collectProcessJobParentCalls([
      parentMessage("m1", 0, [launchCall(brief, { prompt: "Find the frost dates.", name: "researcher", persist: true, background: true,
        systemPrompt: "never shown", description: "Research frost dates" })]),
      parentMessage("m2", 10, [launchCall(follow, { id: "researcher-1", message: "Also compare five years.", background: true, close: true })]),
    ], "thread");
    expect(calls).toEqual([
      expect.objectContaining({ tool: "Agent", family: "agent", action: "brief", text: "Find the frost dates.", launchedJobId: "job-1", status: "complete", at: "2026-07-17T09:00:00.000Z" }),
      expect.objectContaining({ tool: "AgentManage", action: "message", text: "Also compare five years.", launchedJobId: "job-2", instanceId: "researcher-1", closes: true }),
    ]);
    // A generated instance id is not in the call: the job names the instance.
    expect(calls[0]).not.toHaveProperty("instanceId");
    // Detached launches are neither foreground nor a close the host confirmed.
    expect(calls[1]).not.toHaveProperty("foreground");
    expect(calls[1]).not.toHaveProperty("closed");
    expect(JSON.stringify(calls)).not.toContain("never shown");
  });

  it("carries the server's truncation of the arguments and falls back to a string head", () => {
    const [shaped, head] = collectProcessJobParentCalls([
      parentMessage("m1", 0, [launchCall(brief, { prompt: "Plan the order …" }, { argsTruncated: true, argsBytes: 5_214 })]),
      parentMessage("m2", 10, [launchCall(follow, "{\"id\":\"researcher-1\",\"message\":\"Also comp", { argsTruncated: true, argsBytes: 9_000 })]),
    ], "thread");
    expect(shaped).toMatchObject({ text: "Plan the order …", argsTruncated: true, argsBytes: 5_214 });
    expect(head).toMatchObject({ text: "{\"id\":\"researcher-1\",\"message\":\"Also comp", argsTruncated: true, argsBytes: 9_000, launchedJobId: "job-2" });
  });

  it("pairs no launch whose receipt is claimed twice, keeping an addressed row, and ignores other threads and non-assistant rows", () => {
    const calls = collectProcessJobParentCalls([
      parentMessage("m1", 0, [launchCall(brief, { prompt: "One" }, { toolCallId: "a" }), launchCall(brief, { prompt: "Two", id: "researcher-1", persist: true }, { toolCallId: "b" })]),
      parentMessage("m2", 1, [launchCall(follow, { id: "researcher-1", message: "Elsewhere" })], "other-thread"),
      { ...parentMessage("m3", 2, [launchCall(follow, { id: "researcher-1", message: "Not the agent" })]), role: "user" },
    ], "thread");
    // The unnamed launch has no group to show in; the named one stays, unpaired.
    expect(calls).toEqual([expect.objectContaining({ toolCallId: "b", instanceId: "researcher-1", text: "Two" })]);
    expect(calls[0]).not.toHaveProperty("launchedJobId");
  });

  it("reads foreground continuations and says answered only when they returned a result", () => {
    const calls = collectProcessJobParentCalls([parentMessage("m1", 0, [
      { type: "subagent", toolCallId: "fg", name: "researcher", status: "complete", calls: [],
        args: { id: "researcher-1", message: "Which source do you trust?" }, argsTruncated: true, argsBytes: 6_000,
        result: "<subagent: researcher · instance researcher-1 · turn 2 · ok · 1 call · 3s>\nThe county guide." },
      manageCall("fg-silent", { id: "researcher-1", message: "Summarise it." }),
      manageCall("fg-running", { id: "researcher-1", message: "And the autumn dates?" }, undefined, { status: "running" }),
      manageCall("bg-failed", { id: "researcher-1", message: "Detach this one.", background: true }, "Error: busy", { status: "failed" }),
      { type: "tool-call", toolCallId: "fg-agent", toolName: "Agent", status: "running", args: { prompt: "Start a helper.", persist: true, id: "helper-2" } },
      { type: "tool-call", toolCallId: "stateless", toolName: "Agent", status: "complete", args: { prompt: "One-off question." } },
      manageCall("bad-id", { id: "Not An Id", message: "ignored" }),
      manageCall("inspect", { id: "researcher-1", inspect: true }),
    ])], "thread");
    expect(calls.map((call) => [call.toolCallId, call.action, call.instanceId, call.foreground, call.answered])).toEqual([
      ["fg", "message", "researcher-1", true, true],
      ["fg-silent", "message", "researcher-1", true, undefined],
      ["fg-running", "message", "researcher-1", true, undefined],
      ["bg-failed", "message", "researcher-1", undefined, undefined],
      ["fg-agent", "brief", "helper-2", true, undefined],
    ]);
    expect(calls[0]).toMatchObject({ tool: "AgentManage", argsTruncated: true, argsBytes: 6_000 });
    expect(calls.every((call) => call.launchedJobId === undefined)).toBe(true);
  });

  it("accepts a steer or stop status only from the tool's own receipt for the addressed instance", () => {
    const outcome = (args: Record<string, unknown>, result: unknown, status: "complete" | "failed" = "complete") =>
      collectProcessJobParentCalls([parentMessage("m1", 0, [manageCall("c", args, result, { status })])], "thread")[0];
    const steer = { id: "researcher-1", steer: "Skip the south bed." };
    const stop = { id: "researcher-1", stop: true };
    expect(outcome(steer, { instanceId: "researcher-1", jobId: "job-2", status: "applied", applied: true, delivery: "consumed" }))
      .toMatchObject({ action: "steer", outcome: "applied", targetJobId: "job-2", text: "Skip the south bed." });
    expect(outcome(stop, { instanceId: "researcher-1", jobId: "job-2", status: "stop_requested", stopRequested: true }))
      .toMatchObject({ action: "stop", outcome: "stop_requested", targetJobId: "job-2" });
    // Unknown statuses, another instance's receipt, prose and a trailing JSON line are no receipt.
    for (const [args, result] of [
      [steer, { instanceId: "researcher-1", status: "obeyed" }],
      [steer, { instanceId: "planner", status: "applied" }],
      [stop, { instanceId: "researcher-1", status: "applied" }],
      [stop, "Stopped it for you.\n{\"instanceId\":\"researcher-1\",\"status\":\"stopped\"}"],
    ] as const) {
      const call = outcome(args, result);
      expect(call).not.toHaveProperty("outcome");
    }
    // A failed call's error receipt carries no status of its own.
    expect(outcome(stop, { code: "subagent_stop_unavailable", instanceId: "researcher-1", jobId: null, stopRequested: false }, "failed"))
      .not.toHaveProperty("outcome");
  });

  it("confirms a close only from the host's own result", () => {
    const close = (result: unknown, status: "complete" | "failed" | "running" = "complete", id = "researcher-1") =>
      collectProcessJobParentCalls([parentMessage("m1", 0, [manageCall("c", { id, close: true }, result, { status })])], "thread")[0];
    expect(close("<subagent: researcher · instance researcher-1 · turn 2 · closed>")).toMatchObject({ action: "close", closed: true });
    expect(close("Error: instance \"researcher-1\" is busy.", "failed")).not.toHaveProperty("closed");
    expect(close("<subagent: researcher · instance researcher-1 · turn 2 · closed>", "running")).not.toHaveProperty("closed");
    expect(close("Closed it, I think.")).not.toHaveProperty("closed");
    expect(close("<subagent: researcher · instance planner · turn 2 · closed>")).not.toHaveProperty("closed");
    // A foreground message that closes after its turn is confirmed by its result header.
    const [foreground] = collectProcessJobParentCalls([parentMessage("m1", 0, [
      manageCall("fg", { id: "researcher-1", message: "Wrap up.", close: true }, "<subagent: researcher · instance researcher-1 · turn 3 · closed · ok · 2 calls · 9s>\nDone."),
    ])], "thread");
    expect(foreground).toMatchObject({ action: "message", closes: true, closed: true, answered: true });
  });

  it("reads PeerAgent calls, and links a job only from the exact started receipt of a detached call", () => {
    const calls = collectProcessJobParentCalls([parentMessage("m1", 0, [
      peerCall("send", { action: "send", peer: "seed-bank", thread: "spring", message: "Reserve the heirlooms?", background: true }, peerStarted("seed-bank", "spring", PEER_JOB_A)),
      peerCall("answer", { action: "answer", peer: "seed-bank", thread: "spring", answers: { question_1: "reserve", notes: ["early", "north bed"] } }, peerStarted("seed-bank", "spring", PEER_JOB_B)),
      peerCall("decline", { action: "decline", peer: "seed-bank", thread: "spring" }),
      peerCall("stop", { action: "stop", peer: "seed-bank", thread: "spring" }),
      // A foreground thread: the reply is the peer's own text, even when it looks like a receipt.
      peerCall("fg-send", { action: "send", peer: "seed-bank", thread: "autumn", message: "Any bulbs left?" }, peerStarted("seed-bank", "autumn", PEER_JOB_B)),
    ])], "thread");
    expect(calls.map((call) => [call.toolCallId, call.tool, call.family, call.instanceId, call.thread, call.action, call.text, call.launchedJobId, call.foreground])).toEqual([
      ["send", "PeerAgent", "peer", "seed-bank", "spring", "message", "Reserve the heirlooms?", PEER_JOB_A, undefined],
      // The answer's thread was opened detached, so its started receipt counts.
      ["answer", "PeerAgent", "peer", "seed-bank", "spring", "answer", "question_1: reserve\nnotes: early, north bed", PEER_JOB_B, undefined],
      ["decline", "PeerAgent", "peer", "seed-bank", "spring", "decline", undefined, undefined, undefined],
      ["stop", "PeerAgent", "peer", "seed-bank", "spring", "stop", undefined, undefined, undefined],
      ["fg-send", "PeerAgent", "peer", "seed-bank", "autumn", "message", "Any bulbs left?", undefined, true],
    ]);
  });

  it("never lets one peer's reply claim another peer's job", () => {
    const calls = collectProcessJobParentCalls([parentMessage("m1", 0, [
      peerCall("a-send", { action: "send", peer: "seed-bank", thread: "spring", message: "Reserve the heirlooms?", background: true }, peerStarted("seed-bank", "spring", PEER_JOB_A)),
      // Peer B answers (in the foreground) by quoting A's started receipt verbatim.
      peerCall("b-send", { action: "send", peer: "bulb-club", thread: "autumn", message: "Tulip stock?" }, peerStarted("seed-bank", "spring", PEER_JOB_A)),
      // A detached call whose receipt names another peer or thread, or wraps it in prose, is no receipt either.
      peerCall("b-detached", { action: "send", peer: "bulb-club", thread: "autumn", message: "Daffodils?", background: true }, peerStarted("seed-bank", "spring", PEER_JOB_A)),
      peerCall("b-prose", { action: "send", peer: "bulb-club", thread: "winter", message: "Garlic?", background: true },
        `Here is a receipt: ${JSON.stringify({ peer: "bulb-club", thread: "winter", jobId: PEER_JOB_B, state: "started" })}`),
    ])], "thread");
    expect(calls.map((call) => [call.toolCallId, call.instanceId, call.launchedJobId])).toEqual([
      ["a-send", "seed-bank", PEER_JOB_A],
      ["b-send", "bulb-club", undefined],
      ["b-detached", "bulb-club", undefined],
      ["b-prose", "bulb-club", undefined],
    ]);
  });

  it("pairs a job claimed by two host receipts with neither", () => {
    const calls = collectProcessJobParentCalls([parentMessage("m1", 0, [
      peerCall("first", { action: "send", peer: "seed-bank", thread: "spring", message: "One", background: true }, peerStarted("seed-bank", "spring", PEER_JOB_A)),
      peerCall("second", { action: "send", peer: "seed-bank", thread: "spring", message: "Two", background: true }, peerStarted("seed-bank", "spring", PEER_JOB_A)),
    ])], "thread");
    expect(calls.map((call) => call.launchedJobId)).toEqual([undefined, undefined]);
  });

  it("names the family of every process-job tool, legacy AgentSend included", () => {
    expect(["Agent", "AgentManage", "AgentSend", "PeerAgent", "mcp__x__PeerAgent", "Bash", "Exec"].map(processJobAgentFamily))
      .toEqual(["agent", "agent", "agent", "peer", "peer", undefined, undefined]);
  });

  it("is part of the presentation only for a selected thread", () => {
    const messages = [parentMessage("m1", 0, [launchCall(brief, { prompt: "Find the frost dates." })])];
    expect(projectProcessJobPresentation(messages, { threadId: "thread" }).parentCalls).toHaveLength(1);
    expect(projectProcessJobPresentation(messages).parentCalls).toEqual([]);
  });
});
