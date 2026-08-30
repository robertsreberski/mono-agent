import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createChannelUserCancelReason,
  isChannelUserCancelReason,
} from "@mono-agent/agent-contracts";

const sessionAuthorizationMock = vi.hoisted(() => ({
  beforeLoad: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("../acp-session-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acp-session-store.js")>();
  return {
    ...actual,
    async loadAcpSessionAuthorization(
      ...args: Parameters<typeof actual.loadAcpSessionAuthorization>
    ): ReturnType<typeof actual.loadAcpSessionAuthorization> {
      await sessionAuthorizationMock.beforeLoad?.();
      return await actual.loadAcpSessionAuthorization(...args);
    },
  };
});

import { runAcpBridge } from "../acp-bridge.js";

const cleanupRoots: string[] = [];
const cleanupServers: Server[] = [];

interface BridgeHarness {
  readonly send: (frame: unknown) => void;
  readonly next: () => Promise<Record<string, unknown>>;
  readonly close: () => Promise<void>;
}

afterEach(async () => {
  sessionAuthorizationMock.beforeLoad = undefined;
  await Promise.all(cleanupServers.splice(0).map(async (server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(cleanupRoots.splice(0).map(async (path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

function startBridgeHarness(options: {
  readonly sourceId: string;
  readonly registry: string;
}): BridgeHarness {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const lines = createInterface({ input: output, crlfDelay: Infinity });
  const frames = lines[Symbol.asyncIterator]();
  const bridge = runAcpBridge({
    sourceId: options.sourceId,
    env: { MONO_AGENT_TRACE_REGISTRY_DIR: options.registry },
    input,
    output,
    stderr,
  });
  return {
    send(frame: unknown): void {
      input.write(`${JSON.stringify(frame)}\n`);
    },
    async next(): Promise<Record<string, unknown>> {
      const frame = await frames.next();
      if (frame.done) throw new Error(`ACP bridge stdout closed: ${stderr.read()?.toString() ?? ""}`);
      return JSON.parse(frame.value) as Record<string, unknown>;
    },
    async close(): Promise<void> {
      input.end();
      const exitCode = await bridge;
      if (exitCode !== 0) throw new Error(`ACP bridge exited ${String(exitCode)}: ${stderr.read()?.toString() ?? ""}`);
    },
  };
}

async function startOperatorFixture(turnBodies: Array<Record<string, unknown>>): Promise<string> {
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/gui/v1/info") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ schema: 1, label: "Resume Fixture", capabilities: {} }));
      return;
    }
    if (request.method === "POST" && request.url === "/gui/v1/turns") {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      turnBodies.push(JSON.parse(raw) as Record<string, unknown>);
      response.setHeader("content-type", "application/x-ndjson");
      response.end([
        JSON.stringify({ kind: "append", delta: "resumed" }),
        JSON.stringify({ kind: "finish", finalText: "resumed" }),
        "",
      ].join("\n"));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanupServers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server did not bind TCP");
  return `http://127.0.0.1:${String(address.port)}/gui`;
}

async function startCancellationOperatorFixture(options: {
  readonly beforeCancelSettlement?: () => Promise<void>;
} = {}): Promise<{
  readonly baseUrl: string;
  readonly turnStarted: Promise<void>;
  readonly cancelStarted: Promise<void>;
  readonly firstCancellation: Promise<unknown>;
  readonly cancelRequests: () => number;
  readonly turnRequests: () => number;
  readonly events: () => readonly string[];
}> {
  let resolveTurnStarted!: () => void;
  const turnStarted = new Promise<void>((resolve) => { resolveTurnStarted = resolve; });
  let resolveCancelStarted!: () => void;
  const cancelStarted = new Promise<void>((resolve) => { resolveCancelStarted = resolve; });
  let resolveFirstCancellation!: (reason: unknown) => void;
  const firstCancellation = new Promise<unknown>((resolve) => { resolveFirstCancellation = resolve; });
  let settled = false;
  let cancelRequests = 0;
  let turnRequests = 0;
  const events: string[] = [];
  const settle = (reason: unknown): void => {
    if (settled) return;
    settled = true;
    resolveFirstCancellation(reason);
  };
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/gui/v1/info") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ schema: 1, label: "Cancellation Fixture", capabilities: {} }));
      return;
    }
    if (request.method === "POST" && request.url === "/gui/v1/turns") {
      turnRequests += 1;
      events.push("turn_started");
      for await (const _chunk of request) {
        // Consume the bounded request body before holding the response open.
      }
      response.setHeader("content-type", "application/x-ndjson");
      response.flushHeaders();
      response.once("close", () => settle(new Error("Operator turn stream disconnected.")));
      resolveTurnStarted();
      return;
    }
    if (request.method === "POST" && request.url?.endsWith("/cancel") === true) {
      cancelRequests += 1;
      events.push("cancel_started");
      resolveCancelStarted();
      if (options.beforeCancelSettlement === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      } else {
        await options.beforeCancelSettlement();
      }
      events.push("cancel_settled");
      settle(createChannelUserCancelReason("TUI"));
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanupServers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server did not bind TCP");
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/gui`,
    turnStarted,
    cancelStarted,
    firstCancellation,
    cancelRequests: () => cancelRequests,
    turnRequests: () => turnRequests,
    events: () => events,
  };
}

async function startActivePromptBridge(baseUrl: string): Promise<{
  readonly bridge: BridgeHarness;
  readonly sessionId: string;
  readonly promptRequestId: number;
}> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-acp-cancel-"));
  const canonicalRoot = await realpath(root);
  cleanupRoots.push(root);
  const registry = join(root, "registry");
  const artifactDir = join(root, "artifacts");
  await mkdir(registry);
  await mkdir(artifactDir);
  await writeSourceManifest({
    registry,
    artifactDir,
    workspace: canonicalRoot,
    baseUrl,
  });
  const bridge = startBridgeHarness({ sourceId: "personal-agent", registry });
  bridge.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "cancellation-test", version: "1" },
    },
  });
  await expect(bridge.next()).resolves.toMatchObject({ id: 1, result: { protocolVersion: 1 } });
  bridge.send({
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd: canonicalRoot, mcpServers: [] },
  });
  const created = await bridge.next();
  const sessionId = (created.result as { sessionId: string }).sessionId;
  const promptRequestId = 3;
  bridge.send({
    jsonrpc: "2.0",
    id: promptRequestId,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: "keep working" }] },
  });
  return { bridge, sessionId, promptRequestId };
}

async function writeSourceManifest(options: {
  readonly registry: string;
  readonly artifactDir: string;
  readonly workspace: string;
  readonly baseUrl: string;
  readonly sourceId?: string;
}): Promise<void> {
  const sourceId = options.sourceId ?? "personal-agent";
  const now = new Date().toISOString();
  await writeFile(join(options.registry, `${sourceId}.json`), JSON.stringify({
    schema: "agent-runtime.trace-source.v1",
    sourceId,
    label: "Personal Agent",
    artifactDir: options.artifactDir,
    status: "running",
    startedAt: now,
    updatedAt: now,
    metadata: {
      channels: {
        tui: {
          kind: "running",
          baseUrl: options.baseUrl,
          acpBridge: {
            schema: "mono-agent.acp-source.v1",
            bridgeVersion: 1,
            protocolVersion: 1,
            installedVersion: "0.20.10",
            workspacePath: options.workspace,
          },
        },
      },
    },
  }));
}

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
          ? { fs: { readTextFile: true, writeTextFile: true }, elicitation: { form: {} } }
          : { terminal: true, elicitation: { form: {} } },
        clientInfo: { name: "stock-acp-client", version: "1" },
      },
    });
    const initialized = await next();
    expect(initialized).toMatchObject({
      id: 0,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          sessionCapabilities: { resume: {} },
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

    send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: artifactDir, mcpServers: [] },
    });
    const advisoryCwdSession = await next();
    expect(advisoryCwdSession).toMatchObject({
      id: 2,
      result: {
        sessionId: expect.any(String),
        _meta: {
          agentSessionId: expect.any(String),
          "mono-agent": { workspace: { path: canonicalRoot, owner: "agent" } },
        },
      },
    });
    const advisoryCwdResult = advisoryCwdSession.result as {
      sessionId: string;
      _meta: { agentSessionId: string };
    };
    expect(advisoryCwdResult._meta.agentSessionId).toBe(advisoryCwdResult.sessionId);

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
    expect(created).toMatchObject({
      id: 5,
      result: {
        sessionId: expect.any(String),
        _meta: {
          agentSessionId: expect.any(String),
          "mono-agent": { workspace: { path: canonicalRoot, owner: "agent" } },
        },
      },
    });
    const createdResult = created.result as { sessionId: string; _meta: { agentSessionId: string } };
    const sessionId = createdResult.sessionId;
    expect(createdResult._meta.agentSessionId).toBe(sessionId);

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

  it("delivers session/cancel as explicit user cancellation before stream teardown", async () => {
    const fixture = await startCancellationOperatorFixture();
    const { bridge, sessionId } = await startActivePromptBridge(fixture.baseUrl);
    await fixture.turnStarted;

    bridge.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });

    const reason = await fixture.firstCancellation;
    expect(isChannelUserCancelReason(reason)).toBe(true);
    expect(fixture.cancelRequests()).toBe(1);
    await bridge.close();
  });

  it("keeps $/cancel_request as a separate explicit user-cancellation path", async () => {
    const fixture = await startCancellationOperatorFixture();
    const { bridge, promptRequestId } = await startActivePromptBridge(fixture.baseUrl);
    await fixture.turnStarted;

    bridge.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: promptRequestId } });

    const reason = await fixture.firstCancellation;
    expect(isChannelUserCancelReason(reason)).toBe(true);
    expect(fixture.cancelRequests()).toBe(1);
    await bridge.close();
  });

  it("lets a final deferred session/cancel claim provenance before adjacent EOF", async () => {
    let releaseCancellation!: () => void;
    const cancellationReleased = new Promise<void>((resolve) => { releaseCancellation = resolve; });
    const fixture = await startCancellationOperatorFixture({
      beforeCancelSettlement: async () => await cancellationReleased,
    });
    const { bridge, sessionId } = await startActivePromptBridge(fixture.baseUrl);
    await fixture.turnStarted;

    let teardownSettled = false;
    bridge.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    const closing = bridge.close().then(() => { teardownSettled = true; });
    try {
      await fixture.cancelStarted;
      await Promise.resolve();
      expect(teardownSettled).toBe(false);
      expect(fixture.events()).toEqual(["turn_started", "cancel_started"]);
      expect(fixture.cancelRequests()).toBe(1);
    } finally {
      releaseCancellation();
    }

    const [reason] = await Promise.all([fixture.firstCancellation, closing]);
    expect(isChannelUserCancelReason(reason)).toBe(true);
    expect(reason).toMatchObject({ channel: "TUI" });
    expect(fixture.cancelRequests()).toBe(1);
    expect(fixture.events()).toEqual(["turn_started", "cancel_started", "cancel_settled"]);
    expect(teardownSettled).toBe(true);
  });

  it("settles user cancellation before skipping a turn cancelled during authorization", async () => {
    let authorizationStarted!: () => void;
    const authorizationInFlight = new Promise<void>((resolve) => { authorizationStarted = resolve; });
    let releaseAuthorization!: () => void;
    const authorizationReleased = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
    sessionAuthorizationMock.beforeLoad = async () => {
      authorizationStarted();
      await authorizationReleased;
    };
    let releaseCancellation!: () => void;
    const cancellationReleased = new Promise<void>((resolve) => { releaseCancellation = resolve; });
    const fixture = await startCancellationOperatorFixture({
      beforeCancelSettlement: async () => await cancellationReleased,
    });
    const { bridge, promptRequestId } = await startActivePromptBridge(fixture.baseUrl);

    try {
      await authorizationInFlight;
      bridge.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: promptRequestId } });
      releaseAuthorization();
      await fixture.cancelStarted;

      expect(fixture.turnRequests()).toBe(0);
      expect(fixture.events()).toEqual(["cancel_started"]);

      releaseCancellation();
      const [reason, response] = await Promise.all([fixture.firstCancellation, bridge.next()]);
      expect(isChannelUserCancelReason(reason)).toBe(true);
      expect(reason).toMatchObject({ channel: "TUI" });
      expect(response).toMatchObject({ id: promptRequestId, result: { stopReason: "cancelled" } });
      expect(fixture.cancelRequests()).toBe(1);
      expect(fixture.turnRequests()).toBe(0);
      expect(fixture.events()).toEqual(["cancel_started", "cancel_settled"]);
    } finally {
      releaseAuthorization();
      releaseCancellation();
      await bridge.close();
    }
  });

  it("preserves pending user-cancel provenance when ACP connection shutdown races settlement", async () => {
    let releaseCancellation!: () => void;
    const cancellationReleased = new Promise<void>((resolve) => { releaseCancellation = resolve; });
    const fixture = await startCancellationOperatorFixture({
      beforeCancelSettlement: async () => await cancellationReleased,
    });
    const { bridge, promptRequestId } = await startActivePromptBridge(fixture.baseUrl);
    await fixture.turnStarted;

    let closing: Promise<void> | undefined;
    try {
      bridge.send({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: promptRequestId } });
      await fixture.cancelStarted;
      closing = bridge.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fixture.events()).toEqual(["turn_started", "cancel_started"]);
    } finally {
      releaseCancellation();
    }
    const [reason] = await Promise.all([fixture.firstCancellation, closing]);
    expect(isChannelUserCancelReason(reason)).toBe(true);
    expect(reason).toMatchObject({ channel: "TUI" });
    expect(fixture.cancelRequests()).toBe(1);
    expect(fixture.events()).toEqual(["turn_started", "cancel_started", "cancel_settled"]);
  });

  it("keeps ACP connection loss as generic stream cancellation", async () => {
    const fixture = await startCancellationOperatorFixture();
    const { bridge } = await startActivePromptBridge(fixture.baseUrl);
    await fixture.turnStarted;

    const [, reason] = await Promise.all([bridge.close(), fixture.firstCancellation]);

    expect(isChannelUserCancelReason(reason)).toBe(false);
    expect(fixture.cancelRequests()).toBe(0);
  });

  it("durably resumes the exact conversation after bridge and source restarts", async () => {
    const firstTurns: Array<Record<string, unknown>> = [];
    const secondTurns: Array<Record<string, unknown>> = [];
    const firstBaseUrl = await startOperatorFixture(firstTurns);
    const secondBaseUrl = await startOperatorFixture(secondTurns);
    const root = await mkdtemp(join(tmpdir(), "mono-agent-acp-resume-"));
    const canonicalRoot = await realpath(root);
    cleanupRoots.push(root);
    const registry = join(root, "registry");
    const artifactDir = join(root, "artifacts");
    await mkdir(registry);
    await mkdir(artifactDir);
    await writeSourceManifest({
      registry,
      artifactDir,
      workspace: canonicalRoot,
      baseUrl: firstBaseUrl,
    });

    const firstBridge = startBridgeHarness({ sourceId: "personal-agent", registry });
    firstBridge.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true }, terminal: true },
        clientInfo: { name: "acpx", version: "1" },
      },
    });
    await expect(firstBridge.next()).resolves.toMatchObject({
      id: 1,
      result: { agentCapabilities: { sessionCapabilities: { resume: {} } } },
    });
    firstBridge.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: tmpdir(), mcpServers: [] },
    });
    const created = await firstBridge.next();
    const createdResult = created.result as {
      sessionId: string;
      _meta: { agentSessionId: string; "mono-agent": { workspace: { path: string } } };
    };
    expect(createdResult._meta).toMatchObject({
      agentSessionId: createdResult.sessionId,
      "mono-agent": { workspace: { path: canonicalRoot } },
    });
    const sessionId = createdResult.sessionId;
    firstBridge.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "remember this first turn" }] },
    });
    await expect(firstBridge.next()).resolves.toMatchObject({
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { text: "resumed" } } },
    });
    await expect(firstBridge.next()).resolves.toMatchObject({ id: 3, result: { stopReason: "end_turn" } });
    await firstBridge.close();

    const authorizationRoot = join(root, "acp-sessions");
    const authorizationFiles = await readdir(authorizationRoot);
    expect(authorizationFiles).toHaveLength(1);
    const authorizationPath = join(authorizationRoot, authorizationFiles[0] as string);
    expect((await stat(authorizationRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(authorizationPath)).mode & 0o777).toBe(0o600);
    const authorization = JSON.parse(await readFile(authorizationPath, "utf8")) as Record<string, unknown>;
    expect(authorization).toMatchObject({
      schema: "mono-agent.acp-session.v1",
      sessionId,
      sourceId: "personal-agent",
      workspace: canonicalRoot,
      createdAt: expect.any(String),
    });

    await writeSourceManifest({
      registry,
      artifactDir,
      workspace: canonicalRoot,
      baseUrl: secondBaseUrl,
    });
    const resumedBridge = startBridgeHarness({ sourceId: "personal-agent", registry });
    resumedBridge.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "acpx", version: "1" },
      },
    });
    await expect(resumedBridge.next()).resolves.toMatchObject({ id: 1, result: { protocolVersion: 1 } });
    resumedBridge.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/resume",
      params: {
        sessionId: "acp:personal-agent:00000000-0000-4000-8000-000000000000",
        cwd: tmpdir(),
        mcpServers: [],
      },
    });
    await expect(resumedBridge.next()).resolves.toMatchObject({
      id: 2,
      error: { data: { code: "unknown_session_id" } },
    });
    resumedBridge.send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/resume",
      params: {
        sessionId: "acp:other-agent:00000000-0000-4000-8000-000000000000",
        cwd: tmpdir(),
        mcpServers: [],
      },
    });
    await expect(resumedBridge.next()).resolves.toMatchObject({
      id: 3,
      error: { data: { code: "invalid_session_id" } },
    });
    resumedBridge.send({
      jsonrpc: "2.0",
      id: 4,
      method: "session/resume",
      params: { sessionId, cwd: artifactDir, mcpServers: [] },
    });
    const resumed = await resumedBridge.next();
    expect(resumed).toMatchObject({
      id: 4,
      result: {
        _meta: {
          agentSessionId: sessionId,
          "mono-agent": { workspace: { path: canonicalRoot } },
        },
      },
    });
    resumedBridge.send({
      jsonrpc: "2.0",
      id: 5,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "continue the conversation" }] },
    });
    await expect(resumedBridge.next()).resolves.toMatchObject({
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { text: "resumed" } } },
    });
    await expect(resumedBridge.next()).resolves.toMatchObject({ id: 5, result: { stopReason: "end_turn" } });
    expect(firstTurns).toHaveLength(1);
    expect(firstTurns[0]).toMatchObject({ conversationId: sessionId, text: "remember this first turn" });
    expect(secondTurns).toHaveLength(1);
    expect(secondTurns[0]).toMatchObject({ conversationId: sessionId, text: "continue the conversation" });
    await resumedBridge.close();

    await writeFile(authorizationPath, `${JSON.stringify({ ...authorization, sourceId: "other-agent" })}\n`);
    const mismatchedBridge = startBridgeHarness({ sourceId: "personal-agent", registry });
    mismatchedBridge.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "acpx", version: "1" } },
    });
    await mismatchedBridge.next();
    mismatchedBridge.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/resume",
      params: { sessionId, cwd: canonicalRoot, mcpServers: [] },
    });
    await expect(mismatchedBridge.next()).resolves.toMatchObject({
      id: 2,
      error: { data: { code: "session_authorization_mismatch" } },
    });
    await mismatchedBridge.close();

    await writeFile(authorizationPath, "{not-json\n");
    const corruptBridge = startBridgeHarness({ sourceId: "personal-agent", registry });
    corruptBridge.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "acpx", version: "1" } },
    });
    await corruptBridge.next();
    corruptBridge.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/resume",
      params: { sessionId, cwd: canonicalRoot, mcpServers: [] },
    });
    await expect(corruptBridge.next()).resolves.toMatchObject({
      id: 2,
      error: { data: { code: "session_authorization_corrupt" } },
    });
    await corruptBridge.close();

    await rm(authorizationRoot, { recursive: true, force: true });
    const purgedBridge = startBridgeHarness({ sourceId: "personal-agent", registry });
    purgedBridge.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "acpx", version: "1" } },
    });
    await purgedBridge.next();
    purgedBridge.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/resume",
      params: { sessionId, cwd: canonicalRoot, mcpServers: [] },
    });
    await expect(purgedBridge.next()).resolves.toMatchObject({
      id: 2,
      error: { data: { code: "unknown_session_id" } },
    });
    await purgedBridge.close();

    if (process.platform !== "win32") {
      const redirectedRoot = join(root, "redirected-acp-sessions");
      await rm(authorizationRoot, { recursive: true, force: true });
      await mkdir(redirectedRoot, { mode: 0o700 });
      await writeFile(
        join(redirectedRoot, authorizationFiles[0] as string),
        `${JSON.stringify(authorization)}\n`,
        { mode: 0o600 },
      );
      await symlink(redirectedRoot, authorizationRoot, "dir");
      const redirectedBridge = startBridgeHarness({ sourceId: "personal-agent", registry });
      redirectedBridge.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "acpx", version: "1" } },
      });
      await redirectedBridge.next();
      redirectedBridge.send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/resume",
        params: { sessionId, cwd: canonicalRoot, mcpServers: [] },
      });
      await expect(redirectedBridge.next()).resolves.toMatchObject({
        id: 2,
        error: { data: { code: "session_authorization_corrupt" } },
      });
      await redirectedBridge.close();
    }
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
        response.once("close", settleOperator);
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
      expect(cancelCount).toBe(0);
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
      expect(cancelCount).toBe(0);
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
