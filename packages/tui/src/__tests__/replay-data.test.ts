import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJsonlRunRecorder } from "@mono-agent/observability";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listReplayRuns, readReplayRun } from "../data/replay.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tui-replay-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("replay data", () => {
  it("lists recorded runs and reads a coalesced timeline with thinking + tools", async () => {
    const recorder = createJsonlRunRecorder({
      runId: "run-1",
      conversationId: "telegram:42",
      artifactDir: dir,
      userInput: "list my files",
    });
    recorder.onEvent({ type: "provider_request_started", sdk: "pi", model: "claude-fable-5" });
    recorder.onEvent({ type: "assistant", message: { content: [{ type: "thinking", text: "let me " }] } });
    recorder.onEvent({ type: "assistant", message: { content: [{ type: "thinking", text: "look" }] } });
    recorder.onEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }] } });
    recorder.onEvent({ type: "tool_update", tool_use_id: "t1", name: "bash", partial_result: "a.txt" });
    recorder.onEvent({ type: "tool_timing", tool_use_id: "t1", name: "bash", execution_ms: 5, is_error: false });
    recorder.onEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] } });
    recorder.onEvent({ type: "assistant", message: { content: [{ type: "text", text: "You have one file." }] } });
    recorder.onEvent({ type: "cost_accumulated", cumulativeUsd: 0.01, tokens: { input: 10, output: 5 } });
    await recorder.finish({ text: "You have one file.", model: "claude-fable-5", usage: { input: 10, output: 5 } });

    const { runs } = await listReplayRuns(dir);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: "run-1", conversationId: "telegram:42", status: "succeeded" });

    const replay = await readReplayRun(dir, "run-1");
    expect(replay).toBeDefined();
    const categories = replay!.timeline.map((item) => item.category);
    // Thinking deltas coalesce into ONE thinking item; the tool call and its
    // result stay visible; the answer is a message item.
    expect(categories).toContain("thinking");
    expect(categories).toContain("tool");
    expect(categories).toContain("message");
    const thinkingItems = replay!.timeline.filter((item) => item.category === "thinking");
    expect(thinkingItems).toHaveLength(1);
    expect(thinkingItems[0]?.sourceEventCount).toBe(2);
  });

  it("returns undefined for an unknown run id", async () => {
    await expect(readReplayRun(dir, "missing")).resolves.toBeUndefined();
  });
});
