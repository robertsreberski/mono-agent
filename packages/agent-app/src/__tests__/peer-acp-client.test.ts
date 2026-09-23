import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
import { afterEach, describe, expect, it } from "vitest";

import { runPeerAcpTurn } from "../peer-acp-client.js";
import { verifyPeerOperatorHandoff } from "../peer-provenance.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(answer = "ok", askUser = false, incomplete = false, pending = false) {
  const temporary = await mkdtemp(join(tmpdir(), "mono-agent-peer-client-"));
  roots.push(temporary);
  const root = await realpath(temporary);
  const registry = join(root, "registry");
  const artifactDir = join(root, "artifacts");
  await mkdir(registry);
  await mkdir(artifactDir);
  const turns: Array<{ conversationId: string; metadata: Record<string, unknown>; text: string }> = [];
  let turnStarted!: () => void;
  const started = new Promise<void>((resolve) => { turnStarted = resolve; });
  const server = createServer(async (req, res) => {
    if (req.url === "/gui/v1/info") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ schema: 1, label: "Peer fixture", capabilities: askUser ? { askUser: true } : {} }));
    } else if (req.url === "/gui/v1/turns" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      turns.push(JSON.parse(body) as (typeof turns)[number]);
      turnStarted();
      res.setHeader("content-type", "application/x-ndjson");
      if (pending) {
        res.flushHeaders();
        // Hold the turn until the ACP cancellation closes its operator stream.
        await new Promise<void>((resolve) => res.once("close", resolve));
      } else if (askUser) {
        res.write(`${JSON.stringify({ kind: "event", event: {
          type: "tool_call_started", id: "ask-peer-1", name: "AskUser",
        } })}\n`);
        res.end();
      } else {
        res.end(incomplete ? `${JSON.stringify({ kind: "append", delta: answer })}\n`
          : `${JSON.stringify({ kind: "append", delta: answer })}\n${JSON.stringify({ kind: "finish", finalText: answer })}\n`);
      }
    } else if (askUser && req.url?.endsWith("/ask") && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ask: {
        interactionId: "interaction-1", message: "Approve?", questions: [{
          id: "q1", header: "Decision", question: "Proceed?",
          options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], multiSelect: false,
        }], answers: [], activeQuestionIndex: 0, status: "pending",
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      } }));
    } else { res.statusCode = 404; res.end(); }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture listener.");
  const now = new Date().toISOString();
  await writeFile(join(registry, "peer-test.json"), JSON.stringify({
    schema: "agent-runtime.trace-source.v1", sourceId: "peer-test", label: "Peer fixture", artifactDir,
    status: "running", startedAt: now, updatedAt: now,
    metadata: { channels: { tui: { kind: "running", baseUrl: `http://127.0.0.1:${address.port}/gui`,
      acpBridge: { schema: "mono-agent.acp-source.v1", bridgeVersion: 1, protocolVersion: 1,
        installedVersion: "0.24.0", workspacePath: root } } } },
  }));
  return { root, artifactDir, turns, started,
    turn: (sessionId?: string, signal = new AbortController().signal) => runPeerAcpTurn({
      sourceId: "peer-test", cliPath, env: { ...process.env, MONO_AGENT_TRACE_REGISTRY_DIR: registry },
      workspace: root, artifactDir, caller: "agent-test", conversation: "web:caller",
      depth: 1, text: "request text", ...(sessionId ? { sessionId } : {}),
      signal, onSession: async () => {},
    }),
  };
}

describe("peer ACP client over a real spawned bridge", () => {
  it("initializes, creates, resumes without replay, and stamps verified source/depth", async () => {
    const f = await fixture();
    const first = await f.turn();
    const second = await f.turn(first.sessionId);
    expect(second.sessionId).toBe(first.sessionId);
    expect(first.answer).toMatch(/Untrusted peer answer[\s\S]*ok/u);
    expect(f.turns).toHaveLength(2);
    for (const turn of f.turns) {
      expect(turn.conversationId).toBe(first.sessionId);
      expect(turn.metadata).toHaveProperty("peerHandoff");
      expect(turn.metadata.peerHandoff).not.toHaveProperty("proof");
      expect(await verifyPeerOperatorHandoff(f.artifactDir, turn.metadata.peerHandoff, first.sessionId, turn.text, "peer-test"))
        .toMatchObject({ caller: "agent-test", conversation: "web:caller", sourceId: "peer-test", depth: 1 });
    }
    expect(await verifyPeerOperatorHandoff(f.artifactDir,
      { ...f.turns[0]!.metadata.peerHandoff as object, depth: 0 }, first.sessionId, "request text")).toBeUndefined();
    expect(await verifyPeerOperatorHandoff(f.artifactDir, f.turns[0]!.metadata.peerHandoff,
      first.sessionId, "request text", "wrong-target")).toBeUndefined();
  }, 30_000);

  it("rejects oversize peer output instead of returning a truncated success", async () => {
    const f = await fixture("x".repeat(35_000));
    await expect(f.turn()).rejects.toThrow(/exceeds 32 KiB/u);
  }, 30_000);

  it("rejects an oversized ACP frame", async () => {
    const f = await fixture("x".repeat(300_000));
    await expect(f.turn()).rejects.toThrow(/frame exceeds 256 KiB|transport failed/u);
  }, 30_000);

  it("refuses dispatch when stop races with the signed handoff", async () => {
    const f = await fixture();
    const controller = new AbortController();
    await expect(runPeerAcpTurn({
      sourceId: "peer-test", cliPath, workspace: f.root, artifactDir: f.artifactDir,
      caller: "agent-test", conversation: "web:caller", depth: 1, text: "request text",
      env: { ...process.env, MONO_AGENT_TRACE_REGISTRY_DIR: join(f.root, "registry") },
      signal: controller.signal, onSession: async () => {},
      onActive: () => controller.abort(),
    })).rejects.toThrow(/interrupted before dispatch/u);
    expect(f.turns).toHaveLength(0);
  }, 30_000);

  it("cancels an active ACP turn without returning a fabricated answer", async () => {
    const f = await fixture("ok", false, false, true);
    const controller = new AbortController();
    const turn = f.turn(undefined, controller.signal);
    await f.started;
    controller.abort();
    await expect(turn).rejects.toThrow(/interrupted|cancelled|transport failed/u);
    expect(f.turns).toHaveLength(1);
  }, 30_000);

  it("rejects an operator stream EOF without a completed turn", async () => {
    const f = await fixture("partial", false, true);
    await expect(f.turn()).rejects.toThrow(/failed|interrupted/u);
  }, 30_000);

  it("returns an explicit unsupported-interaction error for a peer AskUser", async () => {
    const f = await fixture("ok", true);
    await expect(f.turn()).rejects.toThrow(/AskUser interaction is unsupported.*interaction_required/u);
    expect(f.turns).toHaveLength(1);
  }, 30_000);

  it("rejects a child spawn failure without an uncaught process error", async () => {
    const f = await fixture();
    await expect(runPeerAcpTurn({
      sourceId: "peer-test", executable: join(f.root, "no-such-executable"), cliPath,
      workspace: f.root, artifactDir: f.artifactDir, caller: "agent-test", conversation: "web:caller",
      depth: 1, text: "request", signal: new AbortController().signal, onSession: async () => {},
    })).rejects.toThrow(/Peer ACP turn failed/u);
    expect(f.turns).toHaveLength(0);
  }, 30_000);

  it("fails closed when the bridge cannot find the configured source", async () => {
    const f = await fixture();
    await expect(runPeerAcpTurn({
      sourceId: "missing", cliPath, workspace: f.root, artifactDir: f.artifactDir,
      caller: "agent-test", conversation: "web:caller", depth: 1, text: "no",
      env: { ...process.env, MONO_AGENT_TRACE_REGISTRY_DIR: join(f.root, "registry") },
      signal: new AbortController().signal, onSession: async () => {},
    })).rejects.toThrow(/Peer ACP turn failed/u);
    expect(f.turns).toHaveLength(0);
  }, 30_000);
});
