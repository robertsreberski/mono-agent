import { describe, expect, it } from "vitest";
import {
  createClaudeSubagentTracker,
  readSubagentTranscript,
  subagentActivityFromTranscript,
} from "../../ai/providers/claude-subagent-transcript.js";

/** Shapes below mirror a real Claude Code 2.1.x subagent transcript line. */
function assistantLine(content, uuid = "u1", timestamp = "2026-08-02T10:00:00.000Z") {
  return { type: "assistant", uuid, timestamp, message: { role: "assistant", content } };
}
function userLine(content, uuid = "u2", timestamp = "2026-08-02T10:00:01.500Z") {
  return { type: "user", uuid, timestamp, message: { role: "user", content } };
}

function stubIo(files) {
  return {
    readFile: (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
    statFile: (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return { size: Buffer.byteLength(files[p]) };
    },
  };
}

describe("readSubagentTranscript", () => {
  it("parses JSONL and skips malformed lines without failing", () => {
    const io = stubIo({ "/t.jsonl": '{"type":"assistant"}\nnot json\n\n{"type":"user"}\n' });
    expect(readSubagentTranscript("/t.jsonl", io)).toEqual([{ type: "assistant" }, { type: "user" }]);
  });

  it("returns nothing for an unreadable file rather than throwing", () => {
    expect(readSubagentTranscript("/missing.jsonl", stubIo({}))).toEqual([]);
  });

  it("refuses a transcript over the byte cap", () => {
    const io = stubIo({ "/big.jsonl": '{"type":"assistant"}\n' });
    expect(readSubagentTranscript("/big.jsonl", { ...io, maxBytes: 3 })).toEqual([]);
  });
});

describe("subagentActivityFromTranscript", () => {
  const context = { taskId: "task-1", subagentType: "reviewer" };

  it("pairs the child's tool calls and namespaces ids by task", () => {
    const events = subagentActivityFromTranscript([
      assistantLine([{ type: "tool_use", id: "toolu_a", name: "Grep", input: { pattern: "x" } }]),
      userLine([{ type: "tool_result", tool_use_id: "toolu_a", content: "3 matches" }]),
    ], context);

    expect(events).toEqual([
      { phase: "started", id: "agent:task-1:toolu_a", name: "reviewer▸Grep", arguments: { pattern: "x" } },
      {
        phase: "completed",
        id: "agent:task-1:toolu_a",
        name: "reviewer▸Grep",
        isError: false,
        executionMs: 1500,
        content: "3 matches",
      },
    ]);
  });

  it("forwards the child's thinking and text, which the parent stream never carries", () => {
    const events = subagentActivityFromTranscript([
      assistantLine([{ type: "thinking", thinking: "weighing options" }, { type: "text", text: "Found 3 issues" }]),
    ], context);

    expect(events.map((e) => [e.phase, e.kind, e.content])).toEqual([
      ["message", "thinking", "weighing options"],
      ["message", "text", "Found 3 issues"],
    ]);
  });

  it("closes a tool the child never finished so a host does not spin forever", () => {
    const events = subagentActivityFromTranscript([
      assistantLine([{ type: "tool_use", id: "toolu_b", name: "Bash", input: {} }]),
    ], context);

    expect(events.at(-1)).toMatchObject({
      phase: "completed",
      id: "agent:task-1:toolu_b",
      isError: true,
      content: "subagent ended before this tool returned",
    });
  });

  it("marks an errored tool result", () => {
    const events = subagentActivityFromTranscript([
      assistantLine([{ type: "tool_use", id: "t", name: "Read", input: {} }]),
      userLine([{ type: "tool_result", tool_use_id: "t", content: "boom", is_error: true }]),
    ], context);
    expect(events.at(-1)).toMatchObject({ isError: true, content: "boom" });
  });
});

describe("createClaudeSubagentTracker", () => {
  const started = {
    type: "system",
    subtype: "task_started",
    task_id: "a700",
    tool_use_id: "toolu_parent",
    description: "Review the diff",
    subagent_type: "reviewer",
    prompt: "review it",
  };

  it("ignores events that are not per-task system events", () => {
    const tracker = createClaudeSubagentTracker();
    expect(tracker.observe({ type: "assistant", message: { content: [] } })).toEqual([]);
    expect(tracker.observe({ type: "system", subtype: "init" })).toEqual([]);
    expect(tracker.observe({ type: "system", subtype: "task_updated", task_id: "a700" })).toEqual([]);
  });

  it("bookends a delegation and replays the child transcript between the bookends", () => {
    const transcript = [
      JSON.stringify(assistantLine([{ type: "tool_use", id: "toolu_a", name: "Read", input: { file: "a.js" } }])),
      JSON.stringify(userLine([{ type: "tool_result", tool_use_id: "toolu_a", content: "ok" }])),
    ].join("\n");
    const tracker = createClaudeSubagentTracker(stubIo({ "/out.jsonl": transcript }));

    const open = tracker.observe(started);
    expect(open).toEqual([{
      type: "subagent_activity",
      subagent: { id: "a700", name: "reviewer", callIndex: 0, label: "Review the diff" },
      phase: "agent_started",
      id: "agent:a700",
      name: "Agent(reviewer)",
      arguments: { name: "reviewer", description: "Review the diff", prompt: "review it" },
    }]);

    const done = tracker.observe({
      type: "system",
      subtype: "task_notification",
      task_id: "a700",
      tool_use_id: "toolu_parent",
      status: "completed",
      output_file: "/out.jsonl",
      summary: "PONG",
      usage: { total_tokens: 37035, tool_uses: 1, duration_ms: 1853 },
    });

    expect(done.map((e) => e.phase)).toEqual(["started", "completed", "agent_completed"]);
    expect(done.every((e) => e.type === "subagent_activity")).toBe(true);
    expect(done.at(-1)).toMatchObject({
      phase: "agent_completed",
      id: "agent:a700",
      isError: false,
      executionMs: 1853,
      content: "PONG",
      totalTokens: 37035,
    });
  });

  it("reports a failed delegation as an error even with no transcript", () => {
    const tracker = createClaudeSubagentTracker(stubIo({}));
    tracker.observe(started);
    const [done] = tracker.observe({
      type: "system",
      subtype: "task_notification",
      task_id: "a700",
      status: "failed",
      output_file: "/gone.jsonl",
      usage: { tool_uses: 0 },
    });
    expect(done).toMatchObject({ phase: "agent_completed", isError: true, content: "failed · 0 tool calls" });
  });

  it("still reports a notification for a task it never saw start", () => {
    const tracker = createClaudeSubagentTracker(stubIo({}));
    const [done] = tracker.observe({
      type: "system",
      subtype: "task_notification",
      task_id: "orphan",
      status: "completed",
      summary: "done",
    });
    expect(done).toMatchObject({ phase: "agent_completed", id: "agent:orphan", name: "Agent(orphan)" });
  });

  it("gives concurrent delegations distinct ids so hosts cannot collapse them", () => {
    const tracker = createClaudeSubagentTracker(stubIo({}));
    const [first] = tracker.observe({ ...started, task_id: "a1", subagent_type: "reviewer" });
    const [second] = tracker.observe({ ...started, task_id: "a2", subagent_type: "reviewer" });
    expect(first.id).toBe("agent:a1");
    expect(second.id).toBe("agent:a2");
    expect(second.subagent.callIndex).toBe(1);
  });
});
