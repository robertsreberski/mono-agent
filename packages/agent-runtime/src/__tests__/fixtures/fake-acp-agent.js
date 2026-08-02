import { appendFileSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const mode = process.env.FAKE_ACP_MODE || "normal";
const marker = process.env.FAKE_ACP_EXIT_FILE;
const promptLog = process.env.FAKE_ACP_PROMPT_FILE;

function markExit(value) {
  if (!marker) return;
  try { appendFileSync(marker, `${value}\n`); } catch { /* test diagnostic only */ }
}

process.once("exit", () => markExit("exit"));
process.once("SIGTERM", () => {
  markExit("sigterm");
  process.exit(0);
});

if (mode === "malformed" || mode === "oversize" || mode === "unterminated" || mode === "silent") {
  process.stdin.once("data", () => {
    if (mode === "malformed") process.stdout.write("{malformed}\n");
    if (mode === "oversize") process.stdout.write(`${"x".repeat(4096)}\n`);
    if (mode === "unterminated") {
      process.stdout.write('{"jsonrpc":"2.0","id":0,"result":{}}');
      process.stdout.end();
    }
    // silent deliberately keeps stdin open and never responds.
  });
} else {
  let booleanConfig = false;
  let cancelled = false;
  let cancelPrompt;
  const sessions = new Map();
  const modes = {
    currentModeId: "code",
    availableModes: [
      { id: "code", name: "Code" },
      { id: "ask", name: "Ask" },
    ],
  };
  const configOptions = () => [
    {
      type: "select",
      id: "model",
      name: "Model",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "fast", name: "Fast" },
      ],
    },
    ...(booleanConfig ? [{ type: "boolean", id: "verbose", name: "Verbose", currentValue: false }] : []),
  ];

  const app = agent({ name: "fake-acp-agent" })
    .onRequest(methods.agent.initialize, (ctx) => {
      booleanConfig = ctx.params.clientCapabilities?.session?.configOptions?.boolean != null;
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: {
          name: "fake-acp-agent",
          title: mode === "large-frame" ? "x".repeat(11 * 1024 * 1024) : "Fake ACP Agent",
          version: "1.0.0",
        },
        agentCapabilities: {
          loadSession: mode !== "no-resume",
          promptCapabilities: { image: true, audio: true, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: {
            list: {},
            delete: {},
            additionalDirectories: {},
            ...(mode !== "no-resume" ? { resume: {} } : {}),
            close: {},
          },
          auth: { logout: {} },
        },
        authMethods: [{ id: "fake-login", name: "Fake login" }],
      };
    })
    .onRequest(methods.agent.authenticate, () => ({}))
    .onRequest(methods.agent.logout, () => ({}))
    .onRequest(methods.agent.session.new, (ctx) => {
      const sessionId = process.env.FAKE_ACP_SESSION_ID || `session-${sessions.size + 1}`;
      sessions.set(sessionId, { sessionId, cwd: ctx.params.cwd, title: "Fake session" });
      return { sessionId, modes, configOptions: configOptions() };
    })
    .onRequest(methods.agent.session.load, (ctx) => {
      sessions.set(ctx.params.sessionId, {
        sessionId: ctx.params.sessionId,
        cwd: ctx.params.cwd,
        title: "Loaded fake session",
      });
      return { modes, configOptions: configOptions() };
    })
    .onRequest(methods.agent.session.resume, (ctx) => {
      sessions.set(ctx.params.sessionId, {
        sessionId: ctx.params.sessionId,
        cwd: ctx.params.cwd,
        title: "Resumed fake session",
      });
      return { modes, configOptions: configOptions() };
    })
    .onRequest(methods.agent.session.list, (ctx) => {
      if (mode === "privacy-list") {
        if (ctx.params.cursor === "raw-private-cursor-1") {
          return {
            sessions: [{
              sessionId: "raw-private-session-2",
              cwd: "/tmp/raw-private-session-2",
              title: "Second raw-private-session-2",
              _meta: { copiedSessionId: "raw-private-session-2" },
            }],
            nextCursor: null,
          };
        }
        return {
          sessions: [{
            sessionId: "raw-private-session-1",
            cwd: "/tmp/raw-private-session-1",
            title: "First raw-private-session-1",
            _meta: {
              copiedSessionId: "raw-private-session-1",
              nested: { sessionId: "raw-private-session-1" },
            },
          }],
          nextCursor: "raw-private-cursor-1",
        };
      }
      return {
        sessions: [...sessions.values()],
        nextCursor: null,
      };
    })
    .onRequest(methods.agent.session.delete, (ctx) => {
      sessions.delete(ctx.params.sessionId);
      return {};
    })
    .onRequest(methods.agent.session.close, () => ({}))
    .onRequest(methods.agent.session.setMode, () => ({}))
    .onRequest(methods.agent.session.setConfigOption, () => ({ configOptions: configOptions() }))
    .onNotification(methods.agent.session.cancel, async (ctx) => {
      cancelled = true;
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "cancelled tail" },
        },
      });
      cancelPrompt?.();
      cancelPrompt = undefined;
    })
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      if (promptLog) writeFileSync(promptLog, JSON.stringify(ctx.params.prompt));
      const text = ctx.params.prompt
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (text.includes("hang")) {
        await new Promise((resolve) => { cancelPrompt = resolve; });
        return { stopReason: cancelled ? "cancelled" : "end_turn" };
      }
      if (text.includes("permission")) {
        const permission = await ctx.client.request(methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: { toolCallId: "tool-1", title: "Fake tool", status: "pending" },
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
          ...(text.includes("privacy-copy") ? {
            _meta: { copiedSessionId: ctx.params.sessionId },
          } : {}),
        });
        const rawInput = text.includes("privacy-copy")
          ? {
              permission: permission.outcome.outcome,
              copiedSessionId: ctx.params.sessionId,
            }
          : { permission: permission.outcome.outcome };
        if (text.includes("prototype-copy")) {
          Object.defineProperty(rawInput, "__proto__", {
            value: { polluted: true, copiedSessionId: ctx.params.sessionId },
            enumerable: true,
          });
        }
        await ctx.client.notify(methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Fake tool",
            name: "fake_tool",
            status: "in_progress",
            rawInput,
            ...(text.includes("privacy-copy") ? {
              _meta: { copiedSessionId: ctx.params.sessionId },
            } : {}),
          },
        });
        await ctx.client.notify(methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-1",
            status: "completed",
            rawOutput: "done",
          },
        });
      }
      if (text.includes("oversize-update")) {
        const update = {
          toolCallId: "tool-oversize",
          title: "Oversize tool",
          status: "in_progress",
          rawInput: Array.from({ length: 5_000 }, (_, index) => ({ index })),
          sessionUpdate: "tool_call",
        };
        await ctx.client.notify(methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update,
        });
      }
      if (text.includes("elicit")) {
        await ctx.client.request(methods.client.elicitation.create, {
          sessionId: ctx.params.sessionId,
          mode: "form",
          message: "Need fake input",
          requestedSchema: {
            type: "object",
            properties: { answer: { type: "string" } },
          },
        });
      }
      if (text.includes("all-client-callbacks")) {
        const copiedMeta = { copiedSessionId: ctx.params.sessionId };
        await ctx.client.request(methods.client.fs.writeTextFile, {
          sessionId: ctx.params.sessionId,
          path: `/tmp/${ctx.params.sessionId}`,
          content: "callback content",
          _meta: copiedMeta,
        });
        await ctx.client.request(methods.client.fs.readTextFile, {
          sessionId: ctx.params.sessionId,
          path: `/tmp/${ctx.params.sessionId}`,
          _meta: copiedMeta,
        });
        const terminal = await ctx.client.request(methods.client.terminal.create, {
          sessionId: ctx.params.sessionId,
          command: `echo-${ctx.params.sessionId}`,
          args: [ctx.params.sessionId],
          _meta: copiedMeta,
        });
        const terminalRequest = {
          sessionId: ctx.params.sessionId,
          terminalId: terminal.terminalId,
          _meta: copiedMeta,
        };
        await ctx.client.request(methods.client.terminal.output, terminalRequest);
        await ctx.client.request(methods.client.terminal.waitForExit, terminalRequest);
        await ctx.client.request(methods.client.terminal.kill, terminalRequest);
        await ctx.client.request(methods.client.terminal.release, terminalRequest);
        await ctx.client.notify(methods.client.elicitation.complete, {
          elicitationId: "elicitation-1",
          _meta: copiedMeta,
        });
      }
      const resource = ctx.params.prompt.find((block) => block.type === "resource_link");
      const answer = process.env.ACP_SHOULD_NOT_LEAK
        ? "environment leaked"
        : resource ? `saw ${resource.uri}` : "fake answer";
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "thinking" },
        },
      });
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: answer },
        },
      });
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: 12,
          size: 1000,
        },
      });
      return { stopReason: "end_turn" };
    });

  const connection = app.connect(ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  ));
  await connection.closed;
}
