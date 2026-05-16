import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "ink-testing-library";

import { TuiApp } from "../components/TuiApp.js";
import { createInMemoryTuiHistory } from "../agent/history.js";
import type {
  AgentMessageStreamLike,
  AgentRequestLike,
  AgentResponderLike,
  AgentResponseLike,
} from "../agent/responder.js";

afterEach(() => {
  cleanup();
});

const sleep = (ms = 30) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function echoResponder(): AgentResponderLike {
  return {
    async respond(
      request: AgentRequestLike,
      stream: AgentMessageStreamLike,
    ): Promise<AgentResponseLike> {
      const text = `echo: ${request.text}`;
      await stream.append(text);
      await stream.finish?.(text);
      return { text };
    },
  };
}

describe("TuiApp", () => {
  it("renders the chat pane by default and switches to history with tab", async () => {
    const history = createInMemoryTuiHistory();
    const { stdin, lastFrame } = render(
      <TuiApp
        responder={echoResponder()}
        history={history}
        title="Test Agent"
        exitOnCtrlC={false}
      />,
    );
    await sleep();
    expect(lastFrame() ?? "").toMatch(/Test Agent/);
    expect(lastFrame() ?? "").toMatch(/no messages yet/);
    expect(lastFrame() ?? "").toMatch(/chat/);

    stdin.write("\t");
    await sleep();
    expect(lastFrame() ?? "").toMatch(/history is empty/);
    expect(lastFrame() ?? "").toMatch(/switched to history/);
  });

  it("preserves transcript order across two sequential messages", async () => {
    const history = createInMemoryTuiHistory();
    const { stdin } = render(
      <TuiApp
        responder={echoResponder()}
        history={history}
        title="Test Agent"
        exitOnCtrlC={false}
      />,
    );
    await sleep();
    stdin.write("first");
    await sleep();
    stdin.write("\r");
    await sleep(120);
    stdin.write("second");
    await sleep();
    stdin.write("\r");
    await sleep(120);

    const list = history.list();
    expect(list.map((m) => m.text)).toEqual([
      "first",
      "echo: first",
      "second",
      "echo: second",
    ]);
  });

  it("toggles the help overlay with the ? key", async () => {
    const history = createInMemoryTuiHistory();
    const { stdin, lastFrame } = render(
      <TuiApp
        responder={echoResponder()}
        history={history}
        title="Test Agent"
        exitOnCtrlC={false}
      />,
    );
    await sleep();
    stdin.write("\t"); // jump to history first so chat input is unfocused and ? hits useInput
    await sleep();
    stdin.write("?");
    await sleep();
    expect(lastFrame() ?? "").toMatch(/cycle panes/);
    stdin.write("?");
    await sleep();
    expect(lastFrame() ?? "").not.toMatch(/cycle panes/);
  });

  it("hides the config tab when no config option is provided", async () => {
    const history = createInMemoryTuiHistory();
    const { lastFrame } = render(
      <TuiApp
        responder={echoResponder()}
        history={history}
        title="Test Agent"
        exitOnCtrlC={false}
      />,
    );
    await sleep();
    const frame = lastFrame() ?? "";
    // Status bar lists chat + history but no config tab.
    const statusLine = frame.split("\n").find((line) => line.includes("chat")) ?? "";
    expect(statusLine).toMatch(/history/);
    expect(statusLine).not.toMatch(/config/);
  });
});
