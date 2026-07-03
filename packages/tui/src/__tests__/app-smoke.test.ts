import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import { startTuiAdapter } from "@mono-agent/tui-adapter";

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

    terminal.feed("OQ"); // F2 -> back to chat, where /help is handled
    await frame();
    for (const char of "/help") {
      terminal.feed(char);
    }
    terminal.feed("\r");
    await frame();
    // Collapse whitespace (including the overlay's own word-wrap line breaks)
    // so a phrase split across wrapped rows still reads as one contiguous
    // string -- the overlay wraps at word boundaries, so this is safe.
    const helpText = stripAnsi(terminal.output()).replace(/\s+/gu, " ");
    expect(helpText).toContain("f2/f3/f4/f5");
    // Replay list + detail keybindings (D5): new-keys check for the run-list
    // filters and the detail hint's "esc layers back" wording.
    expect(helpText).toContain("s source filter · x status filter · r refresh");
    expect(helpText).toContain("t/o/m/y/e/a filter");
    expect(helpText).toContain("esc layers back");

    await handle.stop();
  });

  it("tab cycles views from chat only when the editor is empty; typed text keeps tab in the editor", async () => {
    const terminal = new TestTerminal(100, 30);
    const handle = startMonoAgentTui({
      terminal,
      responder: echoResponder(),
      flushIntervalMs: 0,
    });
    await frame();

    // Empty editor: tab cycles chat -> replay.
    terminal.feed("\t");
    await frame();
    expect(stripAnsi(terminal.output())).toContain("Run replay unavailable");

    terminal.feed("OQ"); // F2 -> back to chat
    await frame();

    // Typed (unsubmitted) text: tab must stay in the editor, not cycle views.
    // `terminal.output()` is cumulative (it already contains the replay
    // render from above), so isolate what is written from here on.
    const sinceIndex = terminal.writes.length;
    for (const char of "abc") {
      terminal.feed(char);
    }
    terminal.feed("\t");
    await frame();
    const output = stripAnsi(terminal.writes.slice(sinceIndex).join(""));
    expect(output).not.toContain("Run replay unavailable");
    expect(output).toContain("abc");

    await handle.stop();
  });

  it("? opens help from chat only when the editor is empty; typed text keeps ? in the editor", async () => {
    const terminal = new TestTerminal(100, 30);
    const handle = startMonoAgentTui({
      terminal,
      responder: echoResponder(),
      flushIntervalMs: 0,
    });
    await frame();

    // Empty editor: ? opens the help overlay.
    terminal.feed("?");
    await frame();
    expect(stripAnsi(terminal.output())).toContain("mono-agent tui");

    terminal.feed("z"); // any key closes the overlay
    await frame();

    // Typed (unsubmitted) text: ? must stay in the editor, not open help.
    // Isolate writes from here on (see the tab test above for why).
    const sinceIndex = terminal.writes.length;
    for (const char of "abc") {
      terminal.feed(char);
    }
    terminal.feed("?");
    await frame();
    const output = stripAnsi(terminal.writes.slice(sinceIndex).join(""));
    expect(output).not.toContain("mono-agent tui");
    expect(output).toContain("abc?");

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

  it("Esc aborts the in-flight turn even after a second message was queued", async () => {
    const terminal = new TestTerminal(100, 30);
    const abortedSignals: boolean[] = [];
    const responder: AgentResponder = {
      respond: async (request) => {
        const index = abortedSignals.push(false) - 1;
        await new Promise((resolve, reject) => {
          request.abortSignal.addEventListener(
            "abort",
            () => {
              abortedSignals[index] = true;
              reject(Object.assign(new Error("cancelled"), { agentResponseCancelled: true }));
            },
            { once: true },
          );
          setTimeout(resolve, 5_000).unref();
        });
        return { text: "never" };
      },
    };
    const handle = startMonoAgentTui({ terminal, responder, flushIntervalMs: 0 });
    await frame();

    terminal.feed("a");
    terminal.feed("\r"); // turn 1 (in flight)
    await frame();
    terminal.feed("b");
    terminal.feed("\r"); // turn 2 (concurrent respond call)
    await frame();
    terminal.feed("\u001b"); // Esc must abort BOTH, not just the latest
    await frame();
    await frame();

    expect(abortedSignals).toEqual([true, true]);

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

async function writeTraceSourceManifest(
  dir: string,
  sourceId: string,
  baseUrl: string,
  updatedAt: string,
): Promise<void> {
  await writeFile(
    join(dir, `${sourceId}.json`),
    JSON.stringify({
      schema: "agent-runtime.trace-source.v1",
      sourceId,
      label: sourceId,
      artifactDir: join(dir, `${sourceId}-artifacts`),
      pid: process.pid,
      status: "running",
      startedAt: updatedAt,
      updatedAt,
      transports: ["tui"],
      metadata: { channels: { tui: { kind: "running", baseUrl } } },
    }),
  );
}

describe("MonoAgentTuiApp applies /v1/info effort (C4)", () => {
  it("shows the connected agent's effort on connect, and clears it when switching to an agent with none", async () => {
    const withEffort = await startTuiAdapter({
      responder: { respond: async () => ({ text: "ok" }) },
      info: { label: "agent-with-effort", model: "claude-fable-5", effort: "high" },
    });
    const withoutEffort = await startTuiAdapter({
      responder: { respond: async () => ({ text: "ok" }) },
      info: { label: "agent-no-effort", model: "claude-fable-mini" },
    });
    const dir = await mkdtemp(join(tmpdir(), "tui-effort-switch-"));
    try {
      // Same updatedAt so listTraceSources' tie-break (sourceId ascending) makes
      // the ordering deterministic: agent-1 first, agent-2 second.
      const updatedAt = new Date().toISOString();
      await writeTraceSourceManifest(dir, "agent-1-with-effort", withEffort.baseUrl, updatedAt);
      await writeTraceSourceManifest(dir, "agent-2-no-effort", withoutEffort.baseUrl, updatedAt);

      const terminal = new TestTerminal(100, 30);
      const handle = startMonoAgentTui({ terminal, discovery: { registryDir: dir }, flushIntervalMs: 0 });
      await frame();
      await frame(); // discovery's refreshInstances() is async; give it time to populate

      // Discovery opens on the picker with the first instance selected; enter connects.
      terminal.feed("\r");
      await frame();
      await frame();
      expect(stripAnsi(terminal.output())).toContain("effort:high");

      // Switch to the second (no-effort) agent. `connectTo` sets identity
      // synchronously but applies model/effort only once `info()` resolves, so
      // there's a legitimate transient render with the new identity but the
      // PREVIOUS agent's model/effort still showing. Asserting on the whole
      // (cumulative) write log would catch that transient, not the final
      // state — so isolate the last full status-bar line instead.
      terminal.feed("\x1b[15~"); // F5 -> back to the picker (already-populated list)
      await frame();
      terminal.feed("\x1b[B"); // down arrow -> second instance
      await frame();
      terminal.feed("\r"); // connect
      await frame();
      await frame();

      const statusBarRenders = terminal.writes
        .map(stripAnsi)
        .filter((write) => write.includes("agent-2-no-effort") && write.includes("tab views"));
      const finalStatusBarRender = statusBarRenders.at(-1) ?? "";
      expect(finalStatusBarRender).toContain("claude-fable-mini");
      expect(finalStatusBarRender).not.toContain("effort:");

      await handle.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
      await withEffort.stop();
      await withoutEffort.stop();
    }
  });
});
