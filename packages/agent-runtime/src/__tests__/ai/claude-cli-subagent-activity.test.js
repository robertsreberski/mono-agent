import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import cliFixture from "./fixtures/claude-cli-subagent-events.json";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: spawnMock,
}));

const { generateCliResponse } = await import("../../ai/providers/claude-cli.js");

function fakeChild(rawEvents, { waitForKill = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    child.stdout.end();
    child.stderr.end();
    queueMicrotask(() => child.emit("close", 143));
  });
  queueMicrotask(() => {
    for (const raw of rawEvents) child.stdout.write(`${JSON.stringify(raw)}\n`);
    if (!waitForKill) {
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", 0));
    }
  });
  return child;
}

function options(overrides = {}) {
  return {
    model: {
      sdk: "claude-code",
      model: "claude-sonnet-4-6",
      reference: "claude:claude-sonnet-4-6",
    },
    messages: [{ role: "user", content: "review it" }],
    cwd: "/tmp",
    ...overrides,
  };
}

beforeEach(() => spawnMock.mockReset());

describe("Claude CLI live subagent activity", () => {
  it("emits child records only as nested activity and reports observed capabilities", async () => {
    spawnMock.mockImplementationOnce(() => fakeChild(cliFixture));
    const emitted = [];

    const result = await generateCliResponse("system", options({ onEvent: (event) => emitted.push(event) }));

    expect(result).toMatchObject({
      text: "PARENT_DONE",
      error: null,
      providerSessionId: "cli-session",
      numTurns: 1,
      capabilitiesUsed: {
        subagent_invoked: true,
        native_subagents_used: ["reviewer"],
      },
    });
    const activity = result.events.filter((event) => event.type === "subagent_activity");
    expect(activity.map((event) => event.phase)).toEqual([
      "agent_started",
      "message",
      "message",
      "started",
      "started",
      "completed",
      "completed",
      "agent_completed",
    ]);
    expect(activity.every((event) => event.subagent.id === "toolu_cli_parent")).toBe(true);
    expect(result.events.some((event) => event.parent_tool_use_id === "toolu_cli_parent")).toBe(false);
    expect(result.events.some((event) => JSON.stringify(event).includes("I am inspecting the changes."))).toBe(true);
    expect(result.events.filter((event) => event.type === "assistant").flatMap(
      (event) => event.message?.content ?? [],
    ).some((block) => block?.text === "I am inspecting the changes.")).toBe(false);
    expect(emitted).toEqual(result.events);

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain("--forward-subagent-text");
  });

  it("drains an open child exactly once when the parent run is cancelled", async () => {
    const openEvents = cliFixture.slice(0, 4);
    let child;
    spawnMock.mockImplementationOnce(() => {
      child = fakeChild(openEvents, { waitForKill: true });
      return child;
    });
    const caller = new AbortController();
    const emitted = [];
    const pending = generateCliResponse("system", options({
      abortSignal: caller.signal,
      onEvent: (event) => emitted.push(event),
    }));

    await vi.waitFor(() => {
      expect(emitted.some((event) => event.phase === "started" && event.name === "reviewer▸Read")).toBe(true);
    });
    caller.abort();
    const result = await pending;

    expect(child.kill).toHaveBeenCalledOnce();
    expect(result.cancelled).toBe(true);
    expect(result.events.filter((event) => event.phase === "agent_completed")).toEqual([
      expect.objectContaining({ isError: true, content: "subagent cancelled with the parent run" }),
    ]);
    expect(result.events.filter((event) => event.phase === "completed")).toHaveLength(2);
  });
});
