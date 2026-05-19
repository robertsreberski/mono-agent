import { describe, expect, it } from "vitest";

import {
  extractTrajectoryToolCalls,
  runtimeEventsToTrajectoryMessages,
  toolCallsToTrajectoryMessages,
} from "../index.js";

describe("runtimeEventsToTrajectoryMessages", () => {
  it("normalizes Mono runtime tool-use and tool-result events into trajectory messages", () => {
    const messages = runtimeEventsToTrajectoryMessages([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "ask_collaborator",
              input: { id: "researcher", message: "Find current status." },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-1",
              content: "Research report",
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "Final answer",
            },
          ],
        },
      },
    ]);

    expect(messages).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "ask_collaborator",
              arguments: JSON.stringify({ id: "researcher", message: "Find current status." }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        content: "Research report",
      },
      {
        role: "assistant",
        content: "Final answer",
      },
    ]);
    expect(extractTrajectoryToolCalls(messages)).toEqual([
      {
        id: "call-1",
        name: "ask_collaborator",
        arguments: { id: "researcher", message: "Find current status." },
      },
    ]);
  });

  it("builds reference trajectory messages from expected tool calls", () => {
    expect(toolCallsToTrajectoryMessages([
      { name: "Read", arguments: { file_path: "README.md" } },
      { name: "Grep" },
    ])).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "expected-1",
            type: "function",
            function: {
              name: "Read",
              arguments: JSON.stringify({ file_path: "README.md" }),
            },
          },
        ],
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "expected-2",
            type: "function",
            function: {
              name: "Grep",
              arguments: "{}",
            },
          },
        ],
      },
    ]);
  });
});
