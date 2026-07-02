import { describe, expect, it } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";

import { createInMemoryTuiHistory } from "../agent/history.js";
import { startMonoAgentTui } from "../runtime/start.js";
import { stripAnsi, TestTerminal } from "./test-terminal.js";

async function frame(): Promise<void> {
  // pi-tui coalesces renders (~16ms min interval); give it two frames.
  await new Promise((resolve) => setTimeout(resolve, 80));
}

function echoResponder(): AgentResponder {
  return {
    respond: async (request, stream) => {
      await stream.event?.({ type: "assistant_thought", text: "pondering the echo" });
      await stream.event?.({ type: "tool_call_started", id: "t1", name: "echo_tool", arguments: { text: request.text } });
      await stream.event?.({ type: "tool_call_completed", id: "t1", content: request.text, executionMs: 3 });
      await stream.append(`echo: ${request.text}`);
      return { text: `echo: ${request.text}` };
    },
  };
}

describe("MonoAgentTuiApp end-to-end (TestTerminal)", () => {
  it("boots, runs a full turn from keyboard input, and renders insight cells", async () => {
    const terminal = new TestTerminal(100, 30);
    const history = createInMemoryTuiHistory();
    const handle = startMonoAgentTui({
      terminal,
      responder: echoResponder(),
      title: "Test Agent",
      conversationId: "tui-test",
      history,
      flushIntervalMs: 0,
    });
    await frame();
    expect(stripAnsi(terminal.output())).toContain("Test Agent");

    for (const char of "hi there") {
      terminal.feed(char);
    }
    terminal.feed("\r");
    await frame();
    await frame();

    const output = stripAnsi(terminal.output());
    expect(output).toContain("you hi there");
    expect(output).toContain("echo_tool");
    expect(output).toContain("echo: hi there");
    expect(output).toContain("thought (");

    expect(history.list().map((message) => [message.role, message.status ?? "ok"])).toEqual([
      ["user", "ok"],
      ["assistant", "ok"],
    ]);

    await handle.stop();
  });

  it("cycles views with function keys and opens help via /help", async () => {
    const terminal = new TestTerminal(100, 30);
    const handle = startMonoAgentTui({
      terminal,
      responder: echoResponder(),
      flushIntervalMs: 0,
    });
    await frame();

    terminal.feed("\u001bOR"); // F3 (legacy SS3) → replay view
    await frame();
    expect(stripAnsi(terminal.output())).toContain("Run replay unavailable");

    terminal.feed("\u001bOS"); // F4 → config view
    await frame();
    expect(stripAnsi(terminal.output())).toContain("No config path available");

    await handle.stop();
  });

  it("records a cancelled turn when Esc aborts it", async () => {
    const terminal = new TestTerminal(100, 30);
    const history = createInMemoryTuiHistory();
    const responder: AgentResponder = {
      respond: async (request) => {
        await new Promise((resolve, reject) => {
          request.abortSignal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("cancelled"), { agentResponseCancelled: true })),
            { once: true },
          );
          setTimeout(resolve, 5_000).unref();
        });
        return { text: "never" };
      },
    };
    const handle = startMonoAgentTui({
      terminal,
      responder,
      history,
      flushIntervalMs: 0,
    });
    await frame();

    terminal.feed("x");
    terminal.feed("\r");
    await frame();
    terminal.feed("\u001b"); // Esc → cancel
    await frame();
    await frame();

    expect(stripAnsi(terminal.output())).toContain("Turn cancelled.");
    expect(history.list().at(-1)?.status).toBe("cancelled");

    await handle.stop();
  });

  it("requires exactly one connection mode", () => {
    expect(() => startMonoAgentTui({ terminal: new TestTerminal() })).toThrow(/exactly one/u);
    expect(() =>
      startMonoAgentTui({
        terminal: new TestTerminal(),
        responder: echoResponder(),
        connection: { baseUrl: "http://x" },
      }),
    ).toThrow(/exactly one/u);
  });
});
