import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveJsonMonoAgentConfig } from "@mono-agent/config";
import { createAgentResponder } from "@mono-agent/agent-harness";
import { createProcessJobsRuntimeExtension } from "../process-jobs-runtime.js";

import { PeerSessionGoneError, runPeerAcpTurn } from "../peer-acp-client.js";
import { verifyPeerOperatorHandoff } from "../peer-provenance.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(answer = "ok", askUser = false, incomplete = false, pending = false,
  onTurn?: (turn: { conversationId: string; metadata: Record<string, unknown>; text: string }) => Promise<void>) {
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
      await onTurn?.(turns[turns.length - 1]!);
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

  it("carries the real bridge prompt unchanged through the harness responder into verified runtime depth", async () => {
    const observations: Array<{ text: string; depth: number; caller: string }> = [];
    let f!: Awaited<ReturnType<typeof fixture>>;
    f = await fixture("ok", false, false, false, async (turn) => {
      const config = resolveJsonMonoAgentConfig({ cwd: f.root, json: {
        runtime: { model: "pi:openai-codex:gpt-5.5", workspace: f.root },
        context: { identityPath: "IDENTITY.md" }, artifacts: { dir: f.artifactDir },
      } });
      const generation = { id: "11111111-1111-4111-8111-111111111111", rootKeys: [] };
      const extension = createProcessJobsRuntimeExtension({
        coreConfig: config, baseModel: config.runtime.model, channelId: undefined,
        registry: { kind: "empty", generation } as never,
        ownership: { coordinator: { acquireRequestLease: () => ({ generation, releaseAfterSettlement: vi.fn() }) } } as never,
        attestRegistry: (async (snapshot: unknown) => snapshot) as never,
        service: { settings: { maxChainDepth: 4 }, controller: vi.fn() } as never,
        sandboxEngine: { id: "test", isAvailable: async () => true } as never,
      });
      const responder = createAgentResponder({ harness: { run: async (request: {
        conversationId: string; userMessage: string; metadata?: Record<string, unknown>;
      }) => {
        const runtime = await extension({ runId: "run", request, context: {} } as never);
        const peer = await verifyPeerOperatorHandoff(f.artifactDir, request.metadata?.peerHandoff,
          request.conversationId, request.userMessage, "peer-test");
        observations.push({ text: request.userMessage,
          depth: (runtime.runtimeOptions?.processJobsAvailability as { chainDepth?: number } | undefined)?.chainDepth ?? -1,
          caller: peer?.caller ?? "unverified" });
        await runtime.settleCleanup?.();
        return { text: "ok", metadata: { runId: "run", conversationId: request.conversationId,
          contextSources: [], contextSectionIds: [] } };
      } } as never });
      await responder.respond({ conversationId: turn.conversationId, text: turn.text,
        metadata: { ...turn.metadata, source: "acp" }, abortSignal: new AbortController().signal },
      { append: async () => undefined } as never);
      await responder.dispose();
    });
    await f.turn();
    expect(observations).toEqual([{ text: "request text", depth: 1, caller: "agent-test" }]);
  }, 30_000);

  it("reports a reset session without replay and permits an explicit new session", async () => {
    const f = await fixture();
    const first = await f.turn();
    await rm(join(f.root, "acp-sessions", `${createHash("sha256").update(first.sessionId).digest("hex")}.json`));
    await expect(f.turn(first.sessionId)).rejects.toBeInstanceOf(PeerSessionGoneError);
    expect(f.turns).toHaveLength(1);
    const fresh = await f.turn();
    expect(fresh.sessionId).not.toBe(first.sessionId);
    expect(f.turns).toHaveLength(2);
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
