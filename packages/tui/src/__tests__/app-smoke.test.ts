import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import { startTuiAdapter } from "@mono-agent/operator-adapter";

import { createInMemoryTuiHistory } from "../agent/history.js";
import { startMonoAgentTui } from "../runtime/start.js";
import { stripAnsi, TestTerminal } from "./test-terminal.js";

async function frame(): Promise<void> {
  // pi-tui coalesces renders (~16ms min interval); give it two frames.
  await new Promise((resolve) => setTimeout(resolve, 80));
}

const ESC = String.fromCharCode(27);
const UP = `${ESC}[A`;
const PAGE_DOWN = `${ESC}[6~`;

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
  it("runs the hidden configuration invitation, marks one operator response, and confirms out of band", async () => {
    const requests: Array<{ text: string; conversationId: string; metadata?: Record<string, unknown> }> = [];
    let takeCount = 0;
    let approved = 0;
    const terminal = new TestTerminal(110, 34);
    const responder: AgentResponder = {
      respond: async (request) => {
        requests.push({
          text: request.text,
          conversationId: request.conversationId,
          ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        });
        return {
          text: requests.length === 1
            ? "This temporary configuration conversation is for your Role (IDENTITY.md → ## Role), behavior, memory, skills, tools, or channels. Do not enter secrets. Nothing changes without separate host approval. Reply done or no changes to finish without edits; after your reply and any decision, ordinary chat starts. /quit closes only the console and sends no background stop; the agent remains running unless restart or recovery reports failure. How would you like to configure me further?"
            : "I prepared a safe proposal.",
        };
      },
    };
    const handle = startMonoAgentTui({
      terminal,
      responder,
      flushIntervalMs: 0,
      conversationId: "ordinary-chat",
      configuration: {
        sessionId: "11111111-2222-4333-8444-555555555555",
        conversationId: "configuration-chat",
        roleLocation: "IDENTITY.md → ## Role",
        initialPrompt: "begin configuration",
        prompt: "begin configuration",
        operatorPrompt: "act on the reply; do not ask again",
        takeProposal: async () => {
          takeCount += 1;
          return takeCount === 1
            ? { id: "p1", title: "Agent configuration proposal", rationale: "Be concise", details: ["replace /agent/name = \"Concise\""] }
            : undefined;
        },
        approve: async () => {
          approved += 1;
          return { kind: "applied", message: "Configuration applied and the background agent restarted successfully. Ordinary chat is now active." };
        },
        reject: async () => ({ message: "Rejected" }),
        abandon: async () => undefined,
      },
    });
    try {
      await frame();
      await frame();
      expect(requests[0]?.text).toBe("begin configuration");
      expect(requests[0]?.metadata).toMatchObject({
        source: "tui",
        tui: {
          configuration: true,
          configurationSessionId: "11111111-2222-4333-8444-555555555555",
          configurationPhase: "invitation",
        },
      });
      expect(requests[0]?.conversationId).toBe("configuration-chat-1-invitation");
      const firstOutput = stripAnsi(terminal.output()).replace(/\s+/gu, " ");
      expect(firstOutput).toContain("Role (IDENTITY.md → ## Role)");
      expect(firstOutput).toContain("Reply done or no changes");
      expect(firstOutput).toContain("sends no background stop");
      expect(firstOutput).toContain("How would you like to configure me further?");
      expect(firstOutput).toContain("Nothing changes without separate host approval");
      expect(firstOutput).toContain("/quit closes only the console");
      expect(firstOutput).not.toContain("you begin configuration");
      expect(takeCount).toBe(0); // Hidden invitation never consumes/checks a proposal sink.

      terminal.feed("\x1b[15~"); // F5 cannot switch agents while this owner capability is active.
      await frame();
      expect(stripAnsi(terminal.output())).toContain("pinned to its background agent");
      expect(requests).toHaveLength(1);

      for (const char of "make the name concise") terminal.feed(char);
      terminal.feed("\r");
      await frame();
      await frame();
      expect(requests[1]?.metadata).toMatchObject({
        tui: { configuration: true, configurationPhase: "operator" },
      });
      expect(requests[1]?.conversationId).toBe("configuration-chat-1-operator");
      expect(requests[1]?.text).toContain("act on the reply; do not ask again");
      expect(requests[1]?.text).toContain("The operator replied:\n\nmake the name concise");
      expect(requests[1]?.text).not.toContain("begin configuration");
      expect(stripAnsi(terminal.output())).toContain("Agent configuration proposal");
      expect(stripAnsi(terminal.output())).toContain("Approve, restart, and verify");

      terminal.feed(UP); // Default selection is Reject; approval is deliberately one key away.
      terminal.feed("\r");
      await frame();
      expect(approved).toBe(1);
      expect(stripAnsi(terminal.output())).toContain("background agent restarted successfully");

      for (const char of "do an ordinary task") terminal.feed(char);
      terminal.feed("\r");
      await frame();
      expect(requests[2]?.conversationId).toBe("ordinary-chat");
      expect(requests[2]?.metadata?.tui).toBeUndefined();
      expect(takeCount).toBe(1);

      for (const char of "/configure") terminal.feed(char);
      terminal.feed("\r");
      await frame();
      expect(requests[3]).toMatchObject({ text: "begin configuration" });
      expect(requests[3]?.conversationId).toBe("configuration-chat-2-invitation");
      expect(requests[3]?.metadata).toMatchObject({
        tui: { configuration: true, configurationPhase: "invitation" },
      });
    } finally {
      await handle.stop();
    }
  });

  it("handles explicit done and an ordinary-task reply as no-change handoffs, including re-entry", async () => {
    const terminal = new TestTerminal(110, 34);
    let takeCount = 0;
    let abandoned = 0;
    let wouldPropose = true;
    const requests: Array<{ conversationId: string; metadata?: Record<string, unknown> }> = [];
    const handle = startMonoAgentTui({
      terminal,
      responder: {
        respond: async (request) => {
          requests.push({
            conversationId: request.conversationId,
            ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
          });
          return { text: "No configuration change is needed." };
        },
      },
      conversationId: "ordinary",
      flushIntervalMs: 0,
      configuration: {
        sessionId: "11111111-2222-4333-8444-555555555555",
        conversationId: "configuration",
        roleLocation: "IDENTITY.md → ## Role",
        initialPrompt: "open configuration",
        prompt: "open configuration",
        operatorPrompt: "act on the reply once",
        takeProposal: async () => {
          takeCount += 1;
          return wouldPropose
            ? { id: "unexpected", title: "Must not be shown", rationale: "done is host-owned", details: [] }
            : undefined;
        },
        approve: async () => ({ message: "unused" }),
        reject: async () => ({ message: "unused" }),
        abandon: async () => { abandoned += 1; },
      },
    });
    try {
      await frame();
      await frame();
      expect(takeCount).toBe(0);
      expect(stripAnsi(terminal.output())).not.toContain("Configuration mode finished");

      for (const char of "done") terminal.feed(char);
      terminal.feed("\r");
      await frame();
      await frame();
      expect(takeCount).toBe(0);
      expect(abandoned).toBe(1);
      expect(requests).toHaveLength(1); // No proposal-capable operator model turn ran.
      expect(stripAnsi(terminal.output())).toContain(
        "Configuration mode finished; no changes were requested. Ordinary chat is now active.",
      );
      expect(stripAnsi(terminal.output())).not.toContain("Must not be shown");

      wouldPropose = false;
      for (const char of "/configure") terminal.feed(char);
      terminal.feed("\r");
      await frame();
      await frame();
      expect(requests[1]?.conversationId).toBe("configuration-2-invitation");

      // This is an ordinary task, not configuration intent. The temporary
      // request must produce no proposal and hand control to ordinary chat.
      for (const char of "summarize today's notes") terminal.feed(char);
      terminal.feed("\r");
      await frame();
      await frame();
      expect(takeCount).toBe(1);
      expect(requests[2]?.conversationId).toBe("configuration-2-operator");
      expect(requests[2]?.metadata).toMatchObject({
        tui: { configuration: true, configurationPhase: "operator" },
      });

      for (const char of "now do that ordinary task") terminal.feed(char);
      terminal.feed("\r");
      await frame();
      expect(requests[3]?.conversationId).toBe("ordinary");
      expect(requests[3]?.metadata?.tui).toBeUndefined();
    } finally {
      await handle.stop();
    }
  });

  it("revokes a failed invitation attempt before returning to ordinary chat", async () => {
    const terminal = new TestTerminal(110, 34);
    let abandoned = 0;
    const requests: Array<{ conversationId: string; metadata?: Record<string, unknown> }> = [];
    const handle = startMonoAgentTui({
      terminal,
      responder: {
        respond: async (request) => {
          requests.push({
            conversationId: request.conversationId,
            ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
          });
          if (requests.length === 1) {
            throw new Error("Direct OpenCode cannot receive the host-owned proposal MCP capability.");
          }
          return { text: "ordinary turn resumed" };
        },
      },
      conversationId: "ordinary",
      flushIntervalMs: 0,
      configuration: {
        sessionId: "11111111-2222-4333-8444-555555555555",
        conversationId: "configuration",
        roleLocation: "IDENTITY.md → ## Role",
        initialPrompt: "open configuration",
        prompt: "open configuration",
        operatorPrompt: "act on the reply once",
        takeProposal: async () => undefined,
        approve: async () => ({ message: "unused" }),
        reject: async () => ({ message: "unused" }),
        abandon: async () => { abandoned += 1; },
      },
    });
    try {
      await frame();
      await frame();
      expect(abandoned).toBe(1);
      expect(stripAnsi(terminal.output())).toContain("cannot receive the host-owned proposal MCP capability");

      for (const char of "resume ordinary work") terminal.feed(char);
      terminal.feed("\r");
      await frame();
      expect(requests[1]?.conversationId).toBe("ordinary");
      expect(requests[1]?.metadata?.tui).toBeUndefined();
      expect(stripAnsi(terminal.output())).toContain("ordinary turn resumed");
    } finally {
      await handle.stop();
    }
  });

  it("rejects a proposal out of band and hands off to ordinary chat with no files changed", async () => {
    let rejected = 0;
    const terminal = new TestTerminal(110, 34);
    const handle = startMonoAgentTui({
      terminal,
      responder: { respond: async () => ({ text: "Configuration response." }) },
      flushIntervalMs: 0,
      configuration: {
        sessionId: "11111111-2222-4333-8444-555555555555",
        conversationId: "configuration",
        roleLocation: "IDENTITY.md → ## Role",
        initialPrompt: "open configuration",
        prompt: "open configuration",
        operatorPrompt: "act on this reply once",
        takeProposal: async () => ({
          id: "p1",
          title: "Agent configuration proposal",
          rationale: "Test rejection",
          details: ["replace /agent/name"],
          role: {
            location: "IDENTITY.md → ## Role",
            proposedBody: "Give exact,  evidence-led answers.\n  Keep changes reviewable.",
          },
        }),
        approve: async () => ({ message: "unused" }),
        reject: async () => {
          rejected += 1;
          return {
            kind: "rejected",
            message: "Proposal rejected; no files changed. Ordinary chat is now active.",
          };
        },
        abandon: async () => undefined,
      },
    });
    try {
      await frame();
      await frame();
      for (const char of "change it") terminal.feed(char);
      terminal.feed("\r");
      await frame();
      await frame();
      const review = stripAnsi(terminal.output());
      expect(review).toContain("Exact proposed Role body (IDENTITY.md → ## Role)");
      expect(review).toContain("Give exact,  evidence-led answers.");
      expect(review).toContain("  Keep changes reviewable.");
      terminal.feed(ESC); // Escape is an explicit host-side rejection.
      await frame();
      expect(rejected).toBe(1);
      expect(stripAnsi(terminal.output())).toContain(
        "Proposal rejected; no files changed. Ordinary chat is now active.",
      );
    } finally {
      await handle.stop();
    }
  });

  it("pages through a near-limit Role review while keeping the decision controls reachable", async () => {
    const roleLines = Array.from(
      { length: 120 },
      (_, index) => `ROLE-LINE-${String(index + 1).padStart(3, "0")} ${"reviewable ".repeat(4)}`,
    );
    const longRole = roleLines.join("\n");
    expect(longRole.length).toBeLessThan(8_000);
    let approved = 0;
    const terminal = new TestTerminal(110, 34);
    const handle = startMonoAgentTui({
      terminal,
      responder: { respond: async () => ({ text: "Configuration response." }) },
      flushIntervalMs: 0,
      configuration: {
        sessionId: "11111111-2222-4333-8444-555555555555",
        conversationId: "configuration",
        roleLocation: "IDENTITY.md → ## Role",
        initialPrompt: "open configuration",
        prompt: "open configuration",
        operatorPrompt: "act on this reply once",
        takeProposal: async () => ({
          id: "p-long-role",
          title: "Agent configuration proposal",
          rationale: "Review the complete Role before deciding.",
          details: ["replace IDENTITY.md → ## Role"],
          role: { location: "IDENTITY.md → ## Role", proposedBody: longRole },
        }),
        approve: async () => {
          approved += 1;
          return { kind: "applied", message: "Long Role approved." };
        },
        reject: async () => ({ kind: "rejected", message: "Long Role rejected." }),
        abandon: async () => undefined,
      },
    });
    try {
      await frame();
      await frame();
      for (const char of "replace the Role") terminal.feed(char);
      terminal.feed("\r");
      await frame();
      await frame();

      const firstPage = stripAnsi(terminal.output());
      expect(firstPage).toContain(roleLines[0]);
      expect(firstPage).not.toContain(roleLines.at(-1));
      expect(firstPage).toContain("review lines 1-");
      expect(firstPage).toContain("Approve, restart, and verify");
      expect(firstPage).toContain("Reject; change nothing");

      for (let page = 0; page < 20; page += 1) terminal.feed(PAGE_DOWN);
      await frame();
      expect(stripAnsi(terminal.output())).toContain(roleLines.at(-1));

      terminal.feed(UP);
      terminal.feed("\r");
      await frame();
      expect(approved).toBe(1);
      expect(stripAnsi(terminal.output())).toContain("Long Role approved.");
    } finally {
      await handle.stop();
    }
  });

  it("rejects an unsafe review card without rendering its terminal-control payload", async () => {
    let rejected = 0;
    const terminal = new TestTerminal(110, 34);
    const handle = startMonoAgentTui({
      terminal,
      responder: { respond: async () => ({ text: "Configuration response." }) },
      flushIntervalMs: 0,
      configuration: {
        sessionId: "11111111-2222-4333-8444-555555555555",
        conversationId: "configuration",
        roleLocation: "IDENTITY.md → ## Role",
        initialPrompt: "open configuration",
        prompt: "open configuration",
        operatorPrompt: "act on this reply once",
        takeProposal: async () => ({
          id: "p-unsafe-review",
          title: "Agent configuration proposal",
          rationale: "Visible rationale.\u0007RATIONALE-SPOOF",
          details: ["replace IDENTITY.md → ## Role"],
          role: {
            location: "IDENTITY.md → ## Role",
            proposedBody: "Visible Role text.\n\u001b[2JROLE-SPOOF",
          },
        }),
        approve: async () => ({ kind: "applied", message: "must not approve" }),
        reject: async () => {
          rejected += 1;
          return { kind: "rejected", message: "Unsafe proposal rejected." };
        },
        abandon: async () => undefined,
      },
    });
    try {
      await frame();
      await frame();
      for (const char of "change the Role") terminal.feed(char);
      terminal.feed("\r");
      await frame();
      await frame();

      expect(rejected).toBe(1);
      expect(terminal.output()).not.toContain("\u0007RATIONALE-SPOOF");
      expect(terminal.output()).not.toContain("\u001b[2JROLE-SPOOF");
      expect(stripAnsi(terminal.output())).not.toContain("RATIONALE-SPOOF");
      expect(stripAnsi(terminal.output())).not.toContain("ROLE-SPOOF");
      expect(stripAnsi(terminal.output())).toContain(
        "Configuration proposal review text contained unsafe terminal or bidi controls and was not displayed.",
      );
      expect(stripAnsi(terminal.output())).toContain("Unsafe proposal rejected.");
    } finally {
      await handle.stop();
    }
  });

  it("queues a fast ordinary message until approval swaps to the fresh background endpoint", async () => {
    const oldRequests: string[] = [];
    const freshRequests: string[] = [];
    const oldAgent = await startTuiAdapter({
      responder: {
        respond: async (request) => {
          oldRequests.push(request.text);
          return { text: oldRequests.length === 1 ? "What should change?" : "Proposal ready." };
        },
      },
    });
    const freshAgent = await startTuiAdapter({
      responder: {
        respond: async (request) => {
          freshRequests.push(request.text);
          return { text: "fresh endpoint handled it" };
        },
      },
    });
    let releaseApproval: (() => void) | undefined;
    let markApprovalStarted: (() => void) | undefined;
    const approvalGate = new Promise<void>((resolve) => { releaseApproval = resolve; });
    const approvalStarted = new Promise<void>((resolve) => { markApprovalStarted = resolve; });
    const terminal = new TestTerminal(110, 34);
    const handle = startMonoAgentTui({
      terminal,
      connection: { baseUrl: oldAgent.baseUrl },
      conversationId: "ordinary",
      flushIntervalMs: 0,
      configuration: {
        sessionId: "11111111-2222-4333-8444-555555555555",
        conversationId: "configuration",
        roleLocation: "IDENTITY.md → ## Role",
        initialPrompt: "open configuration",
        prompt: "open configuration",
        operatorPrompt: "act on this reply once",
        takeProposal: async () => ({
          id: "p1",
          title: "Agent configuration proposal",
          rationale: "Test endpoint swap",
          details: ["replace /agent/name"],
        }),
        approve: async () => {
          markApprovalStarted?.();
          await approvalGate;
          return {
            kind: "applied",
            connection: { baseUrl: freshAgent.baseUrl },
            message: "Configuration applied and the background agent restarted successfully. Ordinary chat is now active.",
          };
        },
        reject: async () => ({ message: "unused" }),
        abandon: async () => undefined,
      },
    });
    try {
      await frame();
      await frame();
      for (const char of "change the name") terminal.feed(char);
      terminal.feed("\r");

      // Submit before the operator turn can settle and paint its review card.
      // This ordinary turn must already be behind the attempt-wide gate.
      for (const char of "run ordinary work") terminal.feed(char);
      terminal.feed("\r");
      await frame();
      await frame();
      expect(oldRequests).toHaveLength(2);
      expect(freshRequests).toEqual([]);

      terminal.feed(UP);
      terminal.feed("\r");
      await approvalStarted;
      await frame();
      expect(oldRequests).toHaveLength(2);
      expect(freshRequests).toEqual([]);

      releaseApproval?.();
      await frame();
      await frame();
      expect(oldRequests).toHaveLength(2);
      expect(freshRequests).toEqual(["run ordinary work"]);
      expect(stripAnsi(terminal.output())).toContain("fresh endpoint handled it");
    } finally {
      releaseApproval?.();
      await handle.stop();
      await oldAgent.stop();
      await freshAgent.stop();
    }
  });

  it("cancels a queued ordinary message when apply and recovery return no verified endpoint", async () => {
    const oldRequests: string[] = [];
    const oldAgent = await startTuiAdapter({
      responder: {
        respond: async (request) => {
          oldRequests.push(request.text);
          return { text: oldRequests.length === 1 ? "What should change?" : "Proposal ready." };
        },
      },
    });
    let releaseApproval: (() => void) | undefined;
    let markApprovalStarted: (() => void) | undefined;
    const approvalGate = new Promise<void>((resolve) => { releaseApproval = resolve; });
    const approvalStarted = new Promise<void>((resolve) => { markApprovalStarted = resolve; });
    const terminal = new TestTerminal(110, 34);
    const handle = startMonoAgentTui({
      terminal,
      connection: { baseUrl: oldAgent.baseUrl },
      conversationId: "ordinary",
      flushIntervalMs: 0,
      configuration: {
        sessionId: "11111111-2222-4333-8444-555555555555",
        conversationId: "configuration",
        roleLocation: "IDENTITY.md → ## Role",
        initialPrompt: "open configuration",
        prompt: "open configuration",
        operatorPrompt: "act on this reply once",
        takeProposal: async () => ({
          id: "p1",
          title: "Agent configuration proposal",
          rationale: "Test failed endpoint recovery",
          details: ["replace /agent/name"],
        }),
        approve: async () => {
          markApprovalStarted?.();
          await approvalGate;
          return {
            kind: "error",
            message:
              "The approved files were restored, but the previous background agent failed to restart. Manual recovery is required.",
          };
        },
        reject: async () => ({ message: "unused" }),
        abandon: async () => undefined,
      },
    });
    try {
      await frame();
      await frame();
      for (const char of "change the name") terminal.feed(char);
      terminal.feed("\r");
      for (const char of "must not reach stale endpoint") terminal.feed(char);
      terminal.feed("\r");
      await frame();
      await frame();
      expect(oldRequests).toHaveLength(2);

      terminal.feed(UP);
      terminal.feed("\r");
      await approvalStarted;
      releaseApproval?.();
      await frame();
      await frame();

      expect(oldRequests).toHaveLength(2);
      const output = stripAnsi(terminal.output());
      const normalizedOutput = output.replace(/\s+/gu, " ");
      expect(normalizedOutput).toContain("Manual recovery is required");
      expect(normalizedOutput).toContain("1 ordinary message was cancelled");
      expect(output).not.toContain("echo: must not reach stale endpoint");

      for (const char of "also must not reach stale endpoint") terminal.feed(char);
      terminal.feed("\r");
      await frame();
      expect(oldRequests).toHaveLength(2);
      expect(stripAnsi(terminal.output())).toContain("Not connected to an agent");
    } finally {
      releaseApproval?.();
      await handle.stop();
      await oldAgent.stop();
    }
  });

  it("defers /quit until an in-flight approval transaction settles", async () => {
    let releaseApproval: (() => void) | undefined;
    let markApprovalStarted: (() => void) | undefined;
    const approvalGate = new Promise<void>((resolve) => { releaseApproval = resolve; });
    const approvalStarted = new Promise<void>((resolve) => { markApprovalStarted = resolve; });
    const terminal = new TestTerminal(110, 34);
    const handle = startMonoAgentTui({
      terminal,
      responder: { respond: async () => ({ text: "Configuration response." }) },
      flushIntervalMs: 0,
      configuration: {
        sessionId: "11111111-2222-4333-8444-555555555555",
        conversationId: "configuration",
        roleLocation: "IDENTITY.md → ## Role",
        initialPrompt: "open configuration",
        prompt: "open configuration",
        operatorPrompt: "act on this reply once",
        takeProposal: async () => ({
          id: "p1",
          title: "Agent configuration proposal",
          rationale: "Test quit boundary",
          details: ["replace /agent/name"],
        }),
        approve: async () => {
          markApprovalStarted?.();
          await approvalGate;
          return { kind: "applied", message: "Configuration applied." };
        },
        reject: async () => ({ message: "unused" }),
        abandon: async () => undefined,
      },
    });
    await frame();
    await frame();
    for (const char of "change it") terminal.feed(char);
    terminal.feed("\r");
    await frame();
    await frame();
    terminal.feed(UP);
    terminal.feed("\r");
    await approvalStarted;

    let exited = false;
    void handle.waitUntilExit().then(() => { exited = true; });
    for (const char of "/quit") terminal.feed(char);
    terminal.feed("\r");
    await frame();
    expect(exited).toBe(false);
    expect(stripAnsi(terminal.output()).replace(/\s+/gu, " ")).toContain(
      "will close after the host transaction settles",
    );

    releaseApproval?.();
    await handle.waitUntilExit();
    expect(exited).toBe(true);
  });

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
