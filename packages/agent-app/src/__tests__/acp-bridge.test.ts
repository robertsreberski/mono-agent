import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { runAcpBridge } from "../acp-bridge.js";

const cleanupRoots: string[] = [];
const cleanupServers: Server[] = [];

afterEach(async () => {
  await Promise.all(cleanupServers.splice(0).map(async (server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(cleanupRoots.splice(0).map(async (path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("ACP bridge", () => {
  it("rejects a running source that publishes an unsupported bridge version", async () => {
    const root = await mkdtemp(join(tmpdir(), "mono-agent-acp-version-"));
    const canonicalRoot = await realpath(root);
    cleanupRoots.push(root);
    const registry = join(root, "registry");
    const artifactDir = join(root, "artifacts");
    await mkdir(registry);
    await mkdir(artifactDir);
    const now = new Date().toISOString();
    await writeFile(join(registry, "older-agent.json"), JSON.stringify({
      schema: "agent-runtime.trace-source.v1",
      sourceId: "older-agent",
      label: "Older Agent",
      artifactDir,
      status: "running",
      startedAt: now,
      updatedAt: now,
      metadata: {
        channels: {
          tui: {
            kind: "running",
            baseUrl: "http://127.0.0.1:9/gui",
            acpBridge: {
              schema: "mono-agent.acp-source.v1",
              bridgeVersion: 2,
              protocolVersion: 1,
              installedVersion: "0.16.0",
              workspacePath: canonicalRoot,
            },
          },
        },
      },
    }));
    const stderr = new PassThrough();

    await expect(runAcpBridge({
      sourceId: "older-agent",
      env: { MONO_AGENT_TRACE_REGISTRY_DIR: registry },
      input: new PassThrough(),
      output: new PassThrough(),
      stderr,
    })).resolves.toBe(1);
    expect(stderr.read()?.toString()).toMatch(/compatible ACP bridge.*bridge 2/u);
  });

  it.each([
    {
      name: "forwards only the request tool environment when advertised",
      advertisesToolEnvironment: true,
      requireToolEnvironment: true,
    },
    {
      name: "omits the request tool environment for an older operator",
      advertisesToolEnvironment: false,
      requireToolEnvironment: false,
    },
  ])("$name", async ({ advertisesToolEnvironment, requireToolEnvironment }) => {
    let turnBody: Record<string, unknown> | undefined;
    const server = createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/gui/v1/info") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          schema: 1,
          label: "Bridge Fixture",
          capabilities: advertisesToolEnvironment ? { toolEnvironment: true } : {},
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/gui/v1/turns") {
        let raw = "";
        for await (const chunk of request) raw += String(chunk);
        turnBody = JSON.parse(raw) as Record<string, unknown>;
        response.setHeader("content-type", "application/x-ndjson");
        response.end([
          JSON.stringify({ kind: "status", text: "Thinking about the imported task" }),
          JSON.stringify({
            kind: "event",
            event: {
              type: "usage_update",
              model: "fixture-model",
              cumulativeUsd: 0.01,
              tokens: { input: 10, output: 3, cacheRead: 2, cacheCreation: 1 },
            },
          }),
          JSON.stringify({ kind: "append", delta: "hello" }),
          JSON.stringify({ kind: "finish", finalText: "hello" }),
          "",
        ].join("\n"));
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanupServers.push(server);

    const root = await mkdtemp(join(tmpdir(), "mono-agent-acp-bridge-"));
    const canonicalRoot = await realpath(root);
    cleanupRoots.push(root);
    const registry = join(root, "registry");
    const artifactDir = join(root, "artifacts");
    await mkdir(registry);
    await mkdir(artifactDir);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fixture server did not bind TCP");
    const now = new Date().toISOString();
    await writeFile(join(registry, "personal-agent.json"), JSON.stringify({
      schema: "agent-runtime.trace-source.v1",
      sourceId: "personal-agent",
      label: "Personal Agent",
      artifactDir,
      status: "running",
      startedAt: now,
      updatedAt: now,
      metadata: {
        channels: {
          tui: {
            kind: "running",
            baseUrl: `http://127.0.0.1:${String(address.port)}/gui`,
            acpBridge: {
              schema: "mono-agent.acp-source.v1",
              bridgeVersion: 1,
              protocolVersion: 1,
              installedVersion: "0.17.0",
              workspacePath: canonicalRoot,
            },
          },
        },
      },
    }));

    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = new PassThrough();
    const lines = createInterface({ input: output, crlfDelay: Infinity });
    const frames = lines[Symbol.asyncIterator]();
    const bridge = runAcpBridge({
      sourceId: "personal-agent",
      requireToolEnvironment,
      env: {
        MONO_AGENT_TRACE_REGISTRY_DIR: registry,
        MULTICA_TOKEN: "task-token",
        MULTICA_AGENT_ID: "agent-1",
        UNRELATED_SECRET: "must-not-forward",
        PATH: `${artifactDir}${delimiter}${process.env.PATH ?? ""}`,
      },
      input,
      output,
      stderr,
    });
    const send = (frame: unknown): void => {
      input.write(`${JSON.stringify(frame)}\n`);
    };
    const next = async (): Promise<Record<string, unknown>> => {
      const frame = await frames.next();
      if (frame.done) throw new Error(`ACP bridge stdout closed: ${stderr.read()?.toString() ?? ""}`);
      return JSON.parse(frame.value) as Record<string, unknown>;
    };

    send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: advertisesToolEnvironment
          ? { fs: { readTextFile: true } }
          : { terminal: true },
        clientInfo: { name: "unsupported-client", version: "1" },
      },
    });
    await expect(next()).resolves.toMatchObject({
      id: 0,
      error: {
        data: {
          code: advertisesToolEnvironment
            ? "client_filesystem_unsupported"
            : "client_terminal_unsupported",
        },
      },
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    const initialized = await next();
    expect(initialized).toMatchObject({
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        _meta: {
          "mono-agent": {
            schema: "mono-agent.acp-source.v1",
            bridgeVersion: 1,
            protocolVersion: 1,
            installedVersion: "0.17.0",
            sourceId: "personal-agent",
            workspace: { path: canonicalRoot, owner: "agent" },
          },
        },
      },
    });
    expect((initialized.result as { agentCapabilities: unknown }).agentCapabilities)
      .not.toHaveProperty("loadSession");
    expect((initialized.result as { agentCapabilities: unknown }).agentCapabilities)
      .not.toHaveProperty("sessionCapabilities.resume");

    send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: artifactDir, mcpServers: [] },
    });
    await expect(next()).resolves.toMatchObject({
      id: 2,
      error: { data: { code: "workspace_mismatch" } },
    });

    send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/new",
      params: {
        cwd: root,
        mcpServers: [{ name: "client-mcp", command: "/usr/bin/true", args: [], env: [] }],
      },
    });
    await expect(next()).resolves.toMatchObject({
      id: 3,
      error: { data: { code: "client_mcp_unsupported" } },
    });

    send({
      jsonrpc: "2.0",
      id: 4,
      method: "session/new",
      params: { cwd: root, mcpServers: [], additionalDirectories: [artifactDir] },
    });
    await expect(next()).resolves.toMatchObject({
      id: 4,
      error: { data: { code: "additional_directories_unsupported" } },
    });

    send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/new",
      params: { cwd: root, mcpServers: [] },
    });
    const created = await next();
    expect(created).toMatchObject({ id: 5, result: { sessionId: expect.any(String) } });
    const sessionId = (created.result as { sessionId: string }).sessionId;

    send({
      jsonrpc: "2.0",
      id: 6,
      method: "session/prompt",
      params: {
        sessionId: "acp:personal-agent:00000000-0000-4000-8000-000000000000",
        prompt: [{ type: "text", text: "invented session" }],
      },
    });
    await expect(next()).resolves.toMatchObject({
      id: 6,
      error: { data: { code: "unknown_session_id" } },
    });

    send({
      jsonrpc: "2.0",
      id: 7,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [
          { type: "text", text: "work from Worklab" },
          {
            type: "resource_link",
            name: "Task brief",
            title: "Imported task brief",
            uri: "https://worklab.example/tasks/42",
            description: "The exact source context",
            mimeType: "text/html",
          },
        ],
      },
    });
    await expect(next()).resolves.toMatchObject({
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Thinking about the imported task" },
        },
      },
    });
    await expect(next()).resolves.toMatchObject({
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: 16,
          size: 16,
          cost: { amount: 0.01, currency: "USD" },
        },
      },
    });
    await expect(next()).resolves.toMatchObject({
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    });
    await expect(next()).resolves.toMatchObject({
      id: 7,
      result: { stopReason: "end_turn" },
    });

    expect(turnBody).toMatchObject({
      conversationId: sessionId,
      text: "work from Worklab\n[ACP resource link]\n" + JSON.stringify({
        name: "Task brief",
        uri: "https://worklab.example/tasks/42",
        title: "Imported task brief",
        description: "The exact source context",
        mimeType: "text/html",
      }),
      client: "acp",
      metadata: {},
    });
    if (advertisesToolEnvironment) {
      expect(turnBody).toMatchObject({
        toolEnvironment: {
          schema: 1,
          values: {
            MULTICA_TOKEN: "task-token",
            MULTICA_AGENT_ID: "agent-1",
          },
          pathPrepend: [artifactDir],
        },
      });
    } else {
      expect(turnBody).not.toHaveProperty("toolEnvironment");
    }
    expect(JSON.stringify(turnBody)).not.toContain("UNRELATED_SECRET");

    input.end();
    await expect(bridge).resolves.toBe(0);
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    }));
    cleanupServers.splice(cleanupServers.indexOf(server), 1);
  });

  it.each([
    { action: "accept" as const, expectedStopReason: "end_turn" },
    { action: "decline" as const, expectedStopReason: "refusal" },
    { action: "cancel" as const, expectedStopReason: "cancelled" },
    { action: "no-form" as const, expectedStopReason: undefined },
    { action: "invalid" as const, expectedStopReason: undefined },
  ])("handles AskUser through ACP form elicitation ($action)", async ({ action, expectedStopReason }) => {
    let conversationId = "";
    let submission: Record<string, unknown> | undefined;
    let cancelCount = 0;
    let settleOperator!: () => void;
    const operatorSettled = new Promise<void>((resolve) => { settleOperator = resolve; });
    const ask = {
      interactionId: "interaction-1",
      message: "Choose how to proceed",
      questions: [
        {
          id: "q1",
          header: "Decision",
          question: "Should the task proceed?",
          options: [
            { id: "approve", label: "Approve", description: "Continue the task." },
            { id: "stop", label: "Stop", description: "Do not continue." },
          ],
          multiSelect: false,
        },
        {
          id: "q2",
          header: "Notes",
          question: "Which notes should be included?",
          options: [{ id: "risk", label: "Risk", description: "Include risk." }],
          multiSelect: true,
        },
      ],
      answers: [],
      activeQuestionIndex: 0,
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const server = createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/gui/v1/info") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          schema: 1,
          label: "Interactive Bridge Fixture",
          capabilities: { askUser: true },
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/gui/v1/turns") {
        let raw = "";
        for await (const chunk of request) raw += String(chunk);
        conversationId = (JSON.parse(raw) as { conversationId: string }).conversationId;
        response.setHeader("content-type", "application/x-ndjson");
        response.flushHeaders();
        response.write(`${JSON.stringify({
          kind: "event",
          event: { type: "tool_call_started", id: "ask-tool-1", name: "AskUser" },
        })}\n`);
        await operatorSettled;
        if (action === "accept") {
          response.write(`${JSON.stringify({
            kind: "event",
            event: {
              type: "tool_call_completed",
              id: "ask-tool-1",
              name: "AskUser",
              content: "answered",
            },
          })}\n`);
          response.write(`${JSON.stringify({ kind: "append", delta: "continued" })}\n`);
          response.end(`${JSON.stringify({ kind: "finish", finalText: "continued" })}\n`);
        } else {
          response.end();
        }
        return;
      }
      if (request.url?.endsWith("/ask") === true && request.method === "GET") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ask }));
        return;
      }
      if (request.url?.endsWith("/ask") === true && request.method === "POST") {
        let raw = "";
        for await (const chunk of request) raw += String(chunk);
        submission = JSON.parse(raw) as Record<string, unknown>;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ accepted: true, snapshot: { ...ask, status: "answered" } }));
        settleOperator();
        return;
      }
      if (request.url?.endsWith("/cancel") === true && request.method === "POST") {
        cancelCount += 1;
        response.statusCode = 204;
        response.end();
        settleOperator();
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanupServers.push(server);

    const root = await mkdtemp(join(tmpdir(), "mono-agent-acp-ask-"));
    const canonicalRoot = await realpath(root);
    cleanupRoots.push(root);
    const registry = join(root, "registry");
    const artifactDir = join(root, "artifacts");
    await mkdir(registry);
    await mkdir(artifactDir);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fixture server did not bind TCP");
    const now = new Date().toISOString();
    await writeFile(join(registry, "personal-agent.json"), JSON.stringify({
      schema: "agent-runtime.trace-source.v1",
      sourceId: "personal-agent",
      label: "Personal Agent",
      artifactDir,
      status: "running",
      startedAt: now,
      updatedAt: now,
      metadata: {
        channels: {
          tui: {
            kind: "running",
            baseUrl: `http://127.0.0.1:${String(address.port)}/gui`,
            acpBridge: {
              schema: "mono-agent.acp-source.v1",
              bridgeVersion: 1,
              protocolVersion: 1,
              installedVersion: "0.17.0",
              workspacePath: canonicalRoot,
            },
          },
        },
      },
    }));

    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = new PassThrough();
    const lines = createInterface({ input: output, crlfDelay: Infinity });
    const frames = lines[Symbol.asyncIterator]();
    const bridge = runAcpBridge({
      sourceId: "personal-agent",
      env: { MONO_AGENT_TRACE_REGISTRY_DIR: registry },
      input,
      output,
      stderr,
    });
    const send = (frame: unknown): void => { input.write(`${JSON.stringify(frame)}\n`); };
    const next = async (): Promise<Record<string, unknown>> => {
      const frame = await frames.next();
      if (frame.done) throw new Error(`ACP bridge stdout closed: ${stderr.read()?.toString() ?? ""}`);
      return JSON.parse(frame.value) as Record<string, unknown>;
    };

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: action === "no-form" ? {} : { elicitation: { form: {} } },
        clientInfo: { name: "worklab", version: "1" },
      },
    });
    await expect(next()).resolves.toMatchObject({ id: 1, result: { protocolVersion: 1 } });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: canonicalRoot, mcpServers: [] },
    });
    const created = await next();
    const sessionId = (created.result as { sessionId: string }).sessionId;
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "Ask before continuing" }] },
    });
    await expect(next()).resolves.toMatchObject({
      method: "session/update",
      params: { update: { sessionUpdate: "tool_call", toolCallId: "ask-tool-1" } },
    });
    if (action === "no-form") {
      await expect(next()).resolves.toMatchObject({
        id: 3,
        error: { data: { code: "interaction_required" } },
      });
      expect(submission).toBeUndefined();
      expect(cancelCount).toBeGreaterThan(0);
      input.end();
      await expect(bridge).resolves.toBe(0);
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      }));
      cleanupServers.splice(cleanupServers.indexOf(server), 1);
      return;
    }
    const elicitation = await next();
    expect(elicitation).toMatchObject({
      method: "elicitation/create",
      params: {
        mode: "form",
        sessionId,
        toolCallId: "ask-tool-1",
        message: "Choose how to proceed",
        requestedSchema: {
          type: "object",
          required: ["question_1", "question_2"],
          properties: {
            question_1: { type: "string", title: "Decision" },
            question_1_other: { type: "string" },
            question_2: { type: "array", title: "Notes", minItems: 1 },
            question_2_other: { type: "string" },
          },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: elicitation.id,
      result: action === "accept"
        ? {
            action,
            content: {
              question_1: "approve",
              question_2: ["risk", "__mono_agent_custom__"],
              question_2_other: "Mention schedule",
            },
          }
        : action === "invalid"
          ? { action: "accept", content: { question_1: "not-an-option", question_2: ["risk"] } }
        : { action },
    });

    if (action === "invalid") {
      await expect(next()).resolves.toMatchObject({
        id: 3,
        error: { data: { code: "invalid_elicitation_response" } },
      });
      expect(submission).toBeUndefined();
      expect(cancelCount).toBeGreaterThan(0);
      input.end();
      await expect(bridge).resolves.toBe(0);
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      }));
      cleanupServers.splice(cleanupServers.indexOf(server), 1);
      return;
    }

    if (action === "accept") {
      await expect(next()).resolves.toMatchObject({
        method: "session/update",
        params: { update: { sessionUpdate: "tool_call_update", status: "completed" } },
      });
      await expect(next()).resolves.toMatchObject({
        method: "session/update",
        params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "continued" } } },
      });
      expect(submission).toEqual({
        interactionId: "interaction-1",
        answers: [
          { questionId: "q1", selectedOptionIds: ["approve"] },
          { questionId: "q2", selectedOptionIds: ["risk"], customReply: "Mention schedule" },
        ],
      });
      expect(cancelCount).toBe(0);
    }
    await expect(next()).resolves.toMatchObject({
      id: 3,
      result: { stopReason: expectedStopReason },
    });
    if (action !== "accept") {
      expect(submission).toBeUndefined();
      expect(cancelCount).toBeGreaterThan(0);
    }
    expect(conversationId).toBe(sessionId);

    input.end();
    await expect(bridge).resolves.toBe(0);
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    }));
    cleanupServers.splice(cleanupServers.indexOf(server), 1);
  });
});
