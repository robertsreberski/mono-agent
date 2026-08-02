import { describe, expect, it } from "vitest";
import cliFixture from "./fixtures/claude-cli-subagent-events.json";
import sdkFixture from "./fixtures/claude-sdk-subagent-events.json";
import { createClaudeSubagentActivityNormalizer } from "../../ai/providers/claude-subagent-activity.js";

function observeAll(normalizer, rawEvents) {
  return rawEvents.flatMap((raw) => normalizer.observe(raw).events);
}

describe("createClaudeSubagentActivityNormalizer", () => {
  it("normalizes the real Claude CLI background-agent shape without transcript replay", () => {
    const normalizer = createClaudeSubagentActivityNormalizer();
    const events = observeAll(normalizer, cliFixture);

    expect(events.map((event) => event.phase)).toEqual([
      "agent_started",
      "message",
      "message",
      "started",
      "started",
      "completed",
      "completed",
      "agent_completed",
    ]);
    expect(events.every((event) => event.type === "subagent_activity")).toBe(true);
    expect(events.every((event) => event.subagent.id === "toolu_cli_parent")).toBe(true);
    expect(events.every((event) => event.subagent.nativeId === "native-cli-1")).toBe(true);
    expect(events[0]).toMatchObject({
      phase: "agent_started",
      id: "agent:toolu_cli_parent",
      subagent: {
        id: "toolu_cli_parent",
        nativeId: "native-cli-1",
        name: "reviewer",
        label: "Review the diff",
      },
    });
    expect(events.filter((event) => event.phase === "message").map((event) => event.id)).toEqual([
      "agent:toolu_cli_parent:message:cli-child-assistant:0",
      "agent:toolu_cli_parent:message:cli-child-assistant:1",
    ]);
    expect(events.filter((event) => event.phase === "started").map((event) => event.id)).toEqual([
      "agent:toolu_cli_parent:toolu_cli_child_read",
      "agent:toolu_cli_parent:toolu_cli_child_grep",
    ]);
    expect(events.at(-1)).toMatchObject({
      phase: "agent_completed",
      id: "agent:toolu_cli_parent",
      isError: false,
      content: "Review complete",
      totalTokens: 123,
    });
    expect(normalizer.subagentInvoked()).toBe(true);
    expect(normalizer.nativeSubagentsUsed()).toEqual(["reviewer"]);
  });

  it("normalizes the real SDK foreground Task shape and finishes on its parent tool result", () => {
    const normalizer = createClaudeSubagentActivityNormalizer();
    const events = observeAll(normalizer, sdkFixture);

    expect(events.map((event) => event.phase)).toEqual([
      "agent_started",
      "message",
      "message",
      "started",
      "completed",
      "message",
      "agent_completed",
    ]);
    expect(events.every((event) => event.subagent.id === "toolu_sdk_parent")).toBe(true);
    expect(events.every((event) => !("nativeId" in event.subagent))).toBe(true);
    expect(events[0].subagent).toMatchObject({
      id: "toolu_sdk_parent",
      name: "code-reviewer",
      label: "Count exports",
    });
    expect(events.at(-1)).toMatchObject({
      phase: "agent_completed",
      id: "agent:toolu_sdk_parent",
      isError: false,
      content: "one export",
    });
    expect(normalizer.nativeSubagentsUsed()).toEqual(["code-reviewer"]);
  });

  it("suppresses duplicate child messages and semantic duplicate terminal notifications", () => {
    const normalizer = createClaudeSubagentActivityNormalizer();
    const parent = cliFixture[0];
    const started = cliFixture.find((event) => event.subtype === "task_started");
    const child = cliFixture.find((event) => event.uuid === "cli-child-assistant");
    const terminal = cliFixture.find((event) => event.subtype === "task_notification");

    normalizer.observe(parent);
    normalizer.observe(started);
    expect(normalizer.observe(child).events).toHaveLength(4);
    expect(normalizer.observe(child).events).toEqual([]);
    expect(normalizer.observe(terminal).events).toHaveLength(3);
    expect(normalizer.observe({ ...terminal, uuid: "different-terminal-uuid" }).events).toEqual([]);
  });

  it("consumes a background launch acknowledgement without completing the child", () => {
    const normalizer = createClaudeSubagentActivityNormalizer();
    const launchIndex = cliFixture.findIndex((event) => event.uuid === "cli-parent-launch-result");
    observeAll(normalizer, cliFixture.slice(0, launchIndex));

    expect(normalizer.observe(cliFixture[launchIndex])).toEqual({ consumed: true, events: [] });
    expect(normalizer.observe(cliFixture[launchIndex + 1]).events).toEqual([
      expect.objectContaining({
        phase: "agent_completed",
        id: "agent:toolu_cli_parent",
        isError: false,
      }),
    ]);
  });

  it("removes only a launch acknowledgement from a mixed root tool-result frame", () => {
    const normalizer = createClaudeSubagentActivityNormalizer();
    normalizer.observe(cliFixture[0]);
    const launch = cliFixture.find((event) => event.uuid === "cli-parent-launch-result");
    const unrelated = {
      type: "tool_result",
      tool_use_id: "toolu_unrelated",
      content: "unrelated result",
    };
    const mixed = {
      ...launch,
      message: { ...launch.message, content: [...launch.message.content, unrelated] },
    };

    expect(normalizer.observe(mixed)).toEqual({
      consumed: false,
      events: [],
      forwarded: {
        ...mixed,
        message: { ...mixed.message, content: [unrelated] },
      },
    });
  });

  it("does not suppress launch-like text for an uncorrelated tool result", () => {
    const normalizer = createClaudeSubagentActivityNormalizer();
    expect(normalizer.observe({
      type: "user",
      uuid: "unrelated-launch-like-result",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_unknown",
          content: "Async agent launched successfully. The agent is working in the background.",
        }],
      },
    })).toEqual({ consumed: false, events: [] });
  });

  it("does not treat incidental foreground result prose as a launch acknowledgement", () => {
    const normalizer = createClaudeSubagentActivityNormalizer();
    normalizer.observe({
      type: "assistant",
      uuid: "foreground-parent",
      message: {
        content: [{
          type: "tool_use",
          id: "toolu_foreground",
          name: "Task",
          input: { subagent_type: "reviewer", prompt: "Inspect the daemon" },
        }],
      },
    });
    expect(normalizer.observe({
      type: "system",
      subtype: "task_started",
      task_id: "native-foreground",
      tool_use_id: "toolu_foreground",
      task_type: "local_agent",
      subagent_type: "reviewer",
      uuid: "foreground-native-start",
    }).events).toEqual([
      expect.objectContaining({ phase: "agent_started", id: "agent:toolu_foreground" }),
    ]);
    const result = {
      type: "user",
      uuid: "foreground-result",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_foreground",
          content: "The daemon is running in the background and healthy; agentId: local-7",
        }],
      },
    };

    expect(normalizer.observe(result)).toEqual({
      consumed: false,
      events: [
        expect.objectContaining({
          phase: "agent_completed",
          id: "agent:toolu_foreground",
          isError: false,
        }),
      ],
    });
    expect(normalizer.drain()).toEqual([]);
  });

  it("delays a native-only start until a child frame reveals the canonical parent id", () => {
    const normalizer = createClaudeSubagentActivityNormalizer();
    const events = [];
    const started = normalizer.observe({
      type: "system",
      subtype: "task_started",
      task_id: "native-delayed",
      task_type: "local_agent",
      subagent_type: "reviewer",
      description: "Review the delayed task",
      uuid: "delayed-start",
    });
    events.push(...started.events);
    expect(started).toEqual({ consumed: true, events: [] });

    events.push(...normalizer.observe({
      type: "assistant",
      parent_tool_use_id: "toolu_delayed_parent",
      subagent_type: "reviewer",
      task_description: "Review the delayed task",
      uuid: "delayed-child",
      message: { content: [{ type: "text", text: "Reviewing now" }] },
    }).events);
    events.push(...normalizer.observe({
      type: "system",
      subtype: "task_notification",
      task_id: "native-delayed",
      status: "completed",
      output_file: "/tmp/native-delayed.output",
      summary: "Review complete",
      uuid: "delayed-done",
    }).events);

    expect(events.map((event) => event.phase)).toEqual([
      "agent_started",
      "message",
      "agent_completed",
    ]);
    expect(events.every((event) => event.subagent.id === "toolu_delayed_parent")).toBe(true);
    expect(events.every((event) => event.subagent.nativeId === "native-delayed")).toBe(true);
    expect(events.filter((event) => event.phase === "agent_started")).toHaveLength(1);
    expect(events.filter((event) => event.phase === "agent_completed")).toHaveLength(1);
    expect(normalizer.drain()).toEqual([]);
  });

  it("correlates concurrent unresolved native tasks without merging their groups", () => {
    const normalizer = createClaudeSubagentActivityNormalizer();
    const events = [];
    for (const [taskId, description] of [
      ["native-first", "Review the API"],
      ["native-second", "Review the UI"],
    ]) {
      expect(normalizer.observe({
        type: "system",
        subtype: "task_started",
        task_id: taskId,
        task_type: "local_agent",
        subagent_type: "reviewer",
        description,
        uuid: `${taskId}-start`,
      })).toEqual({ consumed: true, events: [] });
    }

    // Claude may interleave child frames independently from task_started. The
    // description disambiguates two otherwise-identical reviewer profiles.
    for (const [parentId, taskId, description] of [
      ["toolu_second", "native-second", "Review the UI"],
      ["toolu_first", "native-first", "Review the API"],
    ]) {
      events.push(...normalizer.observe({
        type: "assistant",
        parent_tool_use_id: parentId,
        subagent_type: "reviewer",
        task_description: description,
        uuid: `${taskId}-child`,
        message: { content: [{ type: "text", text: description }] },
      }).events);
      events.push(...normalizer.observe({
        type: "system",
        subtype: "task_notification",
        task_id: taskId,
        status: "completed",
        output_file: `/tmp/${taskId}.output`,
        summary: `${description} complete`,
        uuid: `${taskId}-done`,
      }).events);
    }

    const lifecycle = events.filter((event) => event.phase === "agent_started"
      || event.phase === "agent_completed");
    expect(lifecycle.map((event) => [
      event.phase,
      event.subagent.id,
      event.subagent.nativeId,
    ])).toEqual([
      ["agent_started", "toolu_second", "native-second"],
      ["agent_completed", "toolu_second", "native-second"],
      ["agent_started", "toolu_first", "native-first"],
      ["agent_completed", "toolu_first", "native-first"],
    ]);
    expect(new Set(lifecycle.map((event) => event.subagent.id))).toEqual(
      new Set(["toolu_first", "toolu_second"]),
    );
    expect(normalizer.drain()).toEqual([]);
  });

  it.each([
    ["without terminal parent ids", false],
    ["when terminal parent ids correct the provisional pairing", true],
  ])("settles metadata-identical concurrent tasks as a cohort %s", (_label, terminalHasParentIds) => {
    const normalizer = createClaudeSubagentActivityNormalizer();
    for (const taskId of ["native-first", "native-second"]) {
      expect(normalizer.observe({
        type: "system",
        subtype: "task_started",
        task_id: taskId,
        task_type: "local_agent",
        subagent_type: "reviewer",
        description: "Review the same area",
        uuid: `${taskId}-start`,
      })).toEqual({ consumed: true, events: [] });
    }

    const events = [];
    // Child frames for identical profiles can arrive in the opposite order and
    // omit task_description, leaving no truthful native-to-parent attribution.
    for (const parentId of ["toolu_second", "toolu_first"]) {
      events.push(...normalizer.observe({
        type: "assistant",
        parent_tool_use_id: parentId,
        subagent_type: "reviewer",
        uuid: `${parentId}-child`,
        message: { content: [{ type: "text", text: `work from ${parentId}` }] },
      }).events);
    }

    expect(normalizer.observe({
      type: "system",
      subtype: "task_notification",
      task_id: "native-second",
      ...(terminalHasParentIds ? { tool_use_id: "toolu_second" } : {}),
      status: "completed",
      output_file: "/tmp/native-second.output",
      summary: "Second complete",
      uuid: "native-second-done",
    }).events).toEqual([]);
    events.push(...normalizer.observe({
      type: "system",
      subtype: "task_notification",
      task_id: "native-first",
      ...(terminalHasParentIds ? { tool_use_id: "toolu_first" } : {}),
      status: "completed",
      output_file: "/tmp/native-first.output",
      summary: "First complete",
      uuid: "native-first-done",
    }).events);

    const lifecycle = events.filter((event) => event.phase === "agent_started"
      || event.phase === "agent_completed");
    expect(lifecycle.map((event) => [event.phase, event.subagent.id])).toEqual([
      ["agent_started", "toolu_second"],
      ["agent_started", "toolu_first"],
      ["agent_completed", "toolu_second"],
      ["agent_completed", "toolu_first"],
    ]);
    expect(lifecycle.every((event) => !("nativeId" in event.subagent))).toBe(true);
    expect(lifecycle.filter((event) => event.phase === "agent_completed").every(
      (event) => event.content === "2 concurrent subagents completed",
    )).toBe(true);
    expect(events.some((event) => event.subagent.id.startsWith("claude-task:"))).toBe(false);
    expect(normalizer.drain()).toEqual([]);
  });

  it("filters local_bash and skip_transcript background tasks", () => {
    const normalizer = createClaudeSubagentActivityNormalizer();
    const bashStart = {
      type: "system",
      subtype: "task_started",
      task_id: "bash-1",
      tool_use_id: "toolu_bash",
      description: "sleep",
      task_type: "local_bash",
      uuid: "bash-start",
      session_id: "session",
    };
    const bashDone = {
      type: "system",
      subtype: "task_notification",
      task_id: "bash-1",
      tool_use_id: "toolu_bash",
      status: "completed",
      output_file: "",
      summary: "Command completed",
      uuid: "bash-done",
      session_id: "session",
    };
    const ambientStart = {
      ...bashStart,
      task_id: "ambient-1",
      task_type: "local_agent",
      subagent_type: "maintenance",
      skip_transcript: true,
      uuid: "ambient-start",
    };

    expect(normalizer.observe(bashStart)).toEqual({ consumed: true, events: [] });
    expect(normalizer.observe(bashDone)).toEqual({ consumed: true, events: [] });
    expect(normalizer.observe(ambientStart)).toEqual({ consumed: true, events: [] });
    expect(normalizer.observe({
      ...bashDone,
      task_id: "bash-orphan",
      tool_use_id: "toolu_bash_orphan",
      uuid: "bash-orphan-done",
    })).toEqual({ consumed: true, events: [] });
    expect(normalizer.subagentInvoked()).toBe(false);
    expect(normalizer.nativeSubagentsUsed()).toEqual([]);
  });

  it("uses a stable native id for orphan notifications and the parent id when available", () => {
    const withoutParent = createClaudeSubagentActivityNormalizer();
    const orphan = withoutParent.observe({
      type: "system",
      subtype: "task_notification",
      task_id: "native-orphan",
      status: "completed",
      output_file: "/tmp/native-orphan.output",
      summary: "done",
      uuid: "orphan-done",
    }).events;
    expect(orphan.map((event) => event.subagent.id)).toEqual([
      "claude-task:native-orphan",
      "claude-task:native-orphan",
    ]);
    expect(orphan.every((event) => event.subagent.nativeId === "native-orphan")).toBe(true);

    const withParent = createClaudeSubagentActivityNormalizer();
    const correlated = withParent.observe({
      type: "system",
      subtype: "task_notification",
      task_id: "native-late",
      tool_use_id: "toolu_parent_late",
      status: "completed",
      output_file: "/tmp/native-late.output",
      summary: "done",
      uuid: "late-done",
    }).events;
    expect(correlated.every((event) => event.subagent.id === "toolu_parent_late")).toBe(true);
    expect(correlated.every((event) => event.subagent.nativeId === "native-late")).toBe(true);
  });

  it("drains open child tools and the child lifecycle once on cancellation", () => {
    const normalizer = createClaudeSubagentActivityNormalizer();
    normalizer.observe(sdkFixture[0]);
    normalizer.observe(sdkFixture[1]);
    normalizer.observe(sdkFixture[2]);

    const drained = normalizer.drain("subagent cancelled with the parent run");
    expect(drained).toEqual([
      expect.objectContaining({
        phase: "completed",
        id: "agent:toolu_sdk_parent:toolu_sdk_child",
        isError: true,
        content: "subagent cancelled with the parent run",
      }),
      expect.objectContaining({
        phase: "agent_completed",
        id: "agent:toolu_sdk_parent",
        isError: true,
        content: "subagent cancelled with the parent run",
      }),
    ]);
    expect(normalizer.drain("duplicate close")).toEqual([]);
  });
});
