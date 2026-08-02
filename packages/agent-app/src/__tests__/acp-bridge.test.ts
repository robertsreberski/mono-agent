import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    await expect(next()).resolves.toMatchObject({
      id: 1,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });

    send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: root, mcpServers: [] },
    });
    const created = await next();
    expect(created).toMatchObject({ id: 2, result: { sessionId: expect.any(String) } });
    const sessionId = (created.result as { sessionId: string }).sessionId;

    send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId,
        prompt: [{ type: "text", text: "work from Multica" }],
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
      id: 3,
      result: { stopReason: "end_turn" },
    });

    expect(turnBody).toMatchObject({
      conversationId: sessionId,
      text: "work from Multica",
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
});
