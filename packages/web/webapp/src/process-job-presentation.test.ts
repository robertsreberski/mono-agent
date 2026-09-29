import { describe, expect, it } from "vitest";

import { collectProcessJobParentCalls, processJobAgentFamily, projectProcessJobPresentation } from "./process-job-presentation";
import { agentTurn, launchCall, manageCall, parentMessage } from "./test/agent-group-fixtures";

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

  it("drops a launch whose receipt is claimed twice and ignores other threads and non-assistant rows", () => {
    const calls = collectProcessJobParentCalls([
      parentMessage("m1", 0, [launchCall(brief, { prompt: "One" }, { toolCallId: "a" }), launchCall(brief, { prompt: "Two" }, { toolCallId: "b" })]),
      parentMessage("m2", 1, [launchCall(follow, { id: "researcher-1", message: "Elsewhere" })], "other-thread"),
      { ...parentMessage("m3", 2, [launchCall(follow, { id: "researcher-1", message: "Not the agent" })]), role: "user" },
    ], "thread");
    expect(calls).toEqual([]);
  });

  it("reads foreground continuations, controls and their receipts by instance id", () => {
    const calls = collectProcessJobParentCalls([parentMessage("m1", 0, [
      { type: "subagent", toolCallId: "fg", name: "researcher", status: "complete", calls: [],
        args: { id: "researcher-1", message: "Which source do you trust?" }, argsTruncated: true, argsBytes: 6_000 },
      manageCall("fg-plain", { id: "researcher-1", message: "Summarise it." }),
      manageCall("steer", { id: "researcher-1", steer: "Skip the south bed." }, { instanceId: "researcher-1", jobId: "job-2", status: "applied" }),
      manageCall("stop", { id: "researcher-1", stop: true }, { instanceId: "researcher-1", jobId: "job-2", status: "stopped" }),
      manageCall("close", { id: "researcher-1", close: true }, "<subagent: researcher · instance researcher-1 · turn 2 · closed>"),
      manageCall("inspect", { id: "researcher-1", inspect: true }),
      manageCall("bad-id", { id: "Not An Id", message: "ignored" }),
      { type: "tool-call", toolCallId: "fg-agent", toolName: "Agent", status: "running", args: { prompt: "Start a helper.", persist: true, id: "helper-2" } },
      { type: "tool-call", toolCallId: "stateless", toolName: "Agent", status: "complete", args: { prompt: "One-off question." } },
    ])], "thread");
    expect(calls.map((call) => [call.toolCallId, call.action, call.instanceId, call.text, call.targetJobId, call.outcome])).toEqual([
      ["fg", "message", "researcher-1", "Which source do you trust?", undefined, undefined],
      ["fg-plain", "message", "researcher-1", "Summarise it.", undefined, undefined],
      ["steer", "steer", "researcher-1", "Skip the south bed.", "job-2", "applied"],
      ["stop", "stop", "researcher-1", undefined, "job-2", "stopped"],
      ["close", "close", "researcher-1", undefined, undefined, undefined],
      ["fg-agent", "brief", "helper-2", "Start a helper.", undefined, undefined],
    ]);
    expect(calls[0]).toMatchObject({ tool: "AgentManage", argsTruncated: true, argsBytes: 6_000 });
    expect(calls.every((call) => call.launchedJobId === undefined)).toBe(true);
  });

  it("reads PeerAgent sends, answers, declines and stops, with an MCP server prefix and a content-block result", () => {
    const peer = (toolCallId: string, args: Record<string, unknown>, jobId?: string) => ({
      type: "tool-call" as const, toolCallId, toolName: "mcp__mono-agent-peer-agent__PeerAgent", status: "complete" as const, args,
      ...(jobId === undefined ? {} : { result: [{ type: "text", text: JSON.stringify({ peer: "seed-bank", thread: "spring", jobId, state: "started" }) }] }),
    });
    const calls = collectProcessJobParentCalls([parentMessage("m1", 0, [
      peer("send", { action: "send", peer: "seed-bank", thread: "spring", message: "Reserve the heirlooms?", background: true }, "peer-job-1"),
      peer("answer", { action: "answer", peer: "seed-bank", thread: "spring", answers: { question_1: "reserve", notes: ["early", "north bed"] } }, "peer-job-2"),
      peer("decline", { action: "decline", peer: "seed-bank", thread: "spring" }),
      peer("stop", { action: "stop", peer: "seed-bank", thread: "spring" }),
    ])], "thread");
    expect(calls.map((call) => [call.tool, call.family, call.instanceId, call.action, call.text, call.launchedJobId])).toEqual([
      ["PeerAgent", "peer", "seed-bank", "message", "Reserve the heirlooms?", "peer-job-1"],
      ["PeerAgent", "peer", "seed-bank", "answer", "question_1: reserve\nnotes: early, north bed", "peer-job-2"],
      ["PeerAgent", "peer", "seed-bank", "decline", undefined, undefined],
      ["PeerAgent", "peer", "seed-bank", "stop", undefined, undefined],
    ]);
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
