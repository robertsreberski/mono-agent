import { createServer, type Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveJsonMonoAgentConfig } from "@mono-agent/config";
import { isPeerProcessJobQuestion } from "@mono-agent/agent-contracts";
import type { InternalProcessJobRequest } from "../process-jobs-internal.js";
import type { ProcessJobsServiceHandle } from "../process-jobs-service.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAgentResponder } from "@mono-agent/agent-harness";
import { createProcessJobsRuntimeExtension } from "../process-jobs-runtime.js";

const discovery = vi.hoisted(() => ({ enabled: false, root: "", artifactDir: "", callerArtifactDir: "" }));
vi.mock("@mono-agent/web", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mono-agent/web")>();
  return { ...original,
    discoverAcpBridgeAgents: async () => discovery.enabled ? { sources: [{ sourceId: "peer-test", health: "running",
      compatible: true, workspace: { path: discovery.root } }] } : await original.discoverAcpBridgeAgents(),
    discoverOperatorAgents: async () => discovery.enabled ? [
      { source: { sourceId: "agent-a", health: "running", artifactDir: discovery.callerArtifactDir } },
      { source: { sourceId: "peer-test", health: "running", artifactDir: discovery.artifactDir } },
    ] : await original.discoverOperatorAgents(),
  };
});

import { createPeerAgentRuntimeExtension } from "../peer-agent.js";
import { PeerSessionGoneError, runPeerAcpTurn } from "../peer-acp-client.js";
import { verifyPeerOperatorHandoff } from "../peer-provenance.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  discovery.enabled = false;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(answer = "ok", askUser: boolean | "sensitive" | "long" = false, incomplete = false, pending = false,
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
  let finishAsk!: () => void;
  const askSettled = new Promise<void>((resolve) => { finishAsk = resolve; });
  let submission: unknown;
  let askGets = 0;
  let responseClosed = false;
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
        res.once("close", () => { responseClosed = true; finishAsk(); });
        await askSettled;
        if (!res.destroyed) res.end(`${JSON.stringify({ kind: "append", delta: answer })}\n${JSON.stringify({ kind: "finish", finalText: answer })}\n`);
      } else {
        res.end(incomplete ? `${JSON.stringify({ kind: "append", delta: answer })}\n`
          : `${JSON.stringify({ kind: "append", delta: answer })}\n${JSON.stringify({ kind: "finish", finalText: answer })}\n`);
      }
    } else if (askUser && req.url?.endsWith("/ask") && req.method === "GET") {
      askGets += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ask: {
        interactionId: "interaction-1", message: askUser === "sensitive" ? "Provide your API key"
          : askUser === "long" ? "界".repeat(900) : "Approve?", questions: [{
          id: "q1", header: "Decision", question: "Proceed?",
          options: [{ id: "yes", label: "Yes", description: "" }, { id: "no", label: "No", description: "" }], multiSelect: false,
        }], answers: [], activeQuestionIndex: 0, status: "pending",
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      } }));
    } else if (askUser && req.url?.endsWith("/ask") && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      submission = JSON.parse(body) as unknown;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ accepted: true, snapshot: { status: "answered" } }));
      finishAsk();
    } else if (askUser && req.url?.endsWith("/cancel") && req.method === "POST") {
      res.statusCode = 204; res.end(); finishAsk();
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
  return { root, artifactDir, turns, started, submission: () => submission,
    askGets: () => askGets, responseClosed: () => responseClosed,
    turn: (sessionId?: string, signal = new AbortController().signal,
      onQuestion?: import("../peer-acp-client.js").PeerAcpTurn["onQuestion"]) => runPeerAcpTurn({
      sourceId: "peer-test", cliPath, env: { ...process.env, MONO_AGENT_TRACE_REGISTRY_DIR: registry },
      workspace: root, artifactDir, caller: "agent-test", conversation: "web:caller",
      depth: 1, text: "request text", ...(sessionId ? { sessionId } : {}),
      signal, onSession: async () => {}, ...(onQuestion === undefined ? {} : { onQuestion }),
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
    await expect(access(join(f.root, "acp-peer-handoff", "consumed",
      createHash("sha256").update(first.sessionId).digest("hex")))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.turns).toHaveLength(1);
    const fresh = await f.turn();
    expect(fresh.sessionId).not.toBe(first.sessionId);
    expect(f.turns).toHaveLength(2);
  }, 30_000);

  it("maps an exhausted bridge session to explicit no-replay recovery", async () => {
    const f = await fixture();
    await expect(runPeerAcpTurn({
      sourceId: "peer-test", cliPath, env: { ...process.env, MONO_AGENT_TRACE_REGISTRY_DIR: join(f.root, "registry") },
      workspace: f.root, artifactDir: f.artifactDir, caller: "agent-test", conversation: "web:caller",
      depth: 1, text: "request text", signal: new AbortController().signal,
      onSession: async (id) => {
        const directory = join(f.root, "acp-peer-handoff", "consumed", createHash("sha256").update(id).digest("hex"));
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(join(directory, "generations.json"), JSON.stringify(Array.from({ length: 1024 }, () => randomUUID())), { mode: 0o600 });
      },
    })).rejects.toThrow(/peer_session_exhausted.*next explicit send/u);
    expect(f.turns).toHaveLength(0);
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

  it("PeerAgent foreground send and answer resume one real spawned ACP bridge turn", async () => {
    const f = await fixture("peer continued", true);
    const callerRoot = join(f.root, "caller");
    await mkdir(callerRoot);
    discovery.enabled = true;
    discovery.root = f.root;
    discovery.artifactDir = f.artifactDir;
    discovery.callerArtifactDir = join(callerRoot, "artifacts");
    const config = resolveJsonMonoAgentConfig({ cwd: callerRoot, json: {
      runtime: { model: "pi:openai-codex:gpt-5.5", workspace: callerRoot },
      context: { identityPath: "IDENTITY.md" }, artifacts: { dir: discovery.callerArtifactDir },
      traceability: { sourceId: "agent-a" }, tools: { allowedTools: ["PeerAgent"] },
      peers: { finance: { sourceId: "peer-test" } },
    } });
    const request = { conversationId: "web:owner", userMessage: "ask peer", metadata: { source: "web" },
      abortSignal: new AbortController().signal };
    const extension = await createPeerAgentRuntimeExtension({ config, cliPath,
      env: { ...process.env, MONO_AGENT_TRACE_REGISTRY_DIR: join(f.root, "registry") } })!({
      runId: "run", request, context: {} as never,
    });
    const spec = (extension.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-peer-agent"]!;
    const client = new Client({ name: "peer-tool-bridge", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
    try {
      const asked = await client.callTool({ name: "PeerAgent", arguments: {
        action: "send", peer: "finance", thread: "portfolio", message: "please ask",
      } });
      expect(asked.isError).not.toBe(true);
      const question = JSON.parse(String((asked.content as Array<{ text?: string }>)[0]?.text)) as { questionId: string; state: string };
      expect(question.state).toBe("awaiting_answer");
      const answered = await client.callTool({ name: "PeerAgent", arguments: {
        action: "answer", peer: "finance", thread: "portfolio", questionId: question.questionId,
        answers: { question_1: "yes" },
      } });
      expect(answered.isError).not.toBe(true);
      expect(answered.content).toEqual([{ type: "text", text: expect.stringContaining("peer continued") }]);
      expect(f.turns).toHaveLength(1);
      expect(f.submission()).toMatchObject({ interactionId: "interaction-1" });
    } finally { await client.close(); await extension.cleanup?.(); }
  }, 30_000);

  it("wakes a background caller with a bounded non-ASCII question through the real bridge", async () => {
    const f = await fixture("continued", "long");
    const callerRoot = join(f.root, "caller");
    await mkdir(callerRoot);
    discovery.enabled = true;
    discovery.root = f.root;
    discovery.artifactDir = f.artifactDir;
    discovery.callerArtifactDir = join(callerRoot, "artifacts");
    const config = resolveJsonMonoAgentConfig({ cwd: callerRoot, json: {
      runtime: { model: "pi:openai-codex:gpt-5.5", workspace: callerRoot },
      context: { identityPath: "IDENTITY.md" }, artifacts: { dir: discovery.callerArtifactDir },
      traceability: { sourceId: "agent-a" }, tools: { allowedTools: ["PeerAgent"] },
      peers: { finance: { sourceId: "peer-test" } },
    } });
    let pending: InternalProcessJobRequest | undefined;
    const service = { settings: { maxChainDepth: 4 }, internalController: () => ({
      startInternal: async (request: InternalProcessJobRequest) => {
        pending = request; return { jobId: request.jobId, state: "queued", startedAt: null };
      },
    }) } as unknown as ProcessJobsServiceHandle;
    const extension = await createPeerAgentRuntimeExtension({ config, service, channelId: "tui", cliPath,
      env: { ...process.env, MONO_AGENT_TRACE_REGISTRY_DIR: join(f.root, "registry") } })!({
      runId: "run", request: { conversationId: "web:owner", userMessage: "ask peer",
        metadata: { source: "web" }, abortSignal: new AbortController().signal }, context: {} as never,
    });
    const spec = (extension.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-peer-agent"]!;
    const client = new Client({ name: "peer-background-bridge", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
    try {
      const receipt = await client.callTool({ name: "PeerAgent", arguments: { action: "send", peer: "finance",
        thread: "portfolio", message: "ask", background: true } });
      expect(receipt.isError).not.toBe(true);
      const first = await pending!.run(new AbortController().signal, () => {}, () => {});
      expect(first.status).toBe("awaiting_reply");
      expect(isPeerProcessJobQuestion(first.peerQuestion)).toBe(true);
      expect(Buffer.byteLength(first.peerQuestion!.message, "utf8")).toBeLessThanOrEqual(2_000);
      const answered = await client.callTool({ name: "PeerAgent", arguments: { action: "answer",
        peer: "finance", thread: "portfolio", questionId: first.peerQuestion!.questionId,
        answers: { question_1: "yes" } } });
      expect(answered.isError).not.toBe(true);
      expect((await pending!.run(new AbortController().signal, () => {}, () => {}))).toMatchObject({ status: "ok" });
      expect(f.submission()).toMatchObject({ interactionId: "interaction-1" });
    } finally { await client.close(); await extension.cleanup?.(); }
  }, 30_000);

  it("relays a real ACP form into the same parked peer turn and resumes after acceptance", async () => {
    const f = await fixture("continued", true);
    let question: import("../peer-acp-client.js").PeerAcpQuestion | undefined;
    let result: Awaited<ReturnType<typeof f.turn>>;
    try { result = await f.turn(undefined, new AbortController().signal, async (form) => {
      question = form;
      return { action: "accept", content: { question_1: "yes" } };
    }); } catch (error) {
      throw new Error(`Peer form failed; question=${String(question?.message)}, submission=${JSON.stringify(f.submission())}, askGets=${f.askGets()}, responseClosed=${f.responseClosed()}`, { cause: error });
    }
    expect(question?.message).toBe("Approve?");
    expect(question?.requestedSchema).toHaveProperty("properties.question_1");
    expect(f.submission()).toMatchObject({ interactionId: "interaction-1" });
    expect(result.answer).toContain("continued");
    expect(f.turns).toHaveLength(1);
  }, 30_000);

  it("bounds a non-ASCII ACP question in UTF-8 bytes before background projection", async () => {
    const f = await fixture("continued", "long");
    let bounded = "";
    await f.turn(undefined, new AbortController().signal, async (question) => {
      bounded = question.message;
      return { action: "accept", content: { question_1: "yes" } };
    });
    expect(Buffer.byteLength("界".repeat(900), "utf8")).toBeGreaterThan(2_000);
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(2_000);
    expect(bounded).toContain("[truncated]");
  }, 30_000);

  it("submits a valid paired Other response through the bridge validator", async () => {
    const f = await fixture("custom continued", true);
    const result = await f.turn(undefined, new AbortController().signal, async () => ({ action: "accept", content: {
      question_1: "__mono_agent_custom__", question_1_other: "Different approach",
    } }));
    expect(result.answer).toContain("custom continued");
    expect(f.submission()).toMatchObject({ answers: [{ questionId: "q1", customReply: "Different approach" }] });
  }, 30_000);

  it("does not submit a declined peer question", async () => {
    const f = await fixture("never", true);
    await expect(f.turn(undefined, new AbortController().signal,
      async () => ({ action: "decline" }))).rejects.toThrow(/interrupted|refusal/u);
    expect(f.submission()).toBeUndefined();
  }, 30_000);

  it.each([
    { label: "unknown choice", content: { question_1: "invented" } },
    { label: "Other without custom text", content: { question_1: "__mono_agent_custom__" } },
  ])("rejects $label in the ACP bridge instead of submitting an answer", async ({ content }) => {
    const f = await fixture("never", true);
    await expect(f.turn(undefined, new AbortController().signal,
      async () => ({ action: "accept", content }))).rejects.toThrow(/invalid_elicitation_response/u);
    expect(f.submission()).toBeUndefined();
  }, 30_000);

  it("refuses a sensitive peer AskUser before offering a form", async () => {
    const f = await fixture("never", "sensitive");
    let offered = false;
    await expect(f.turn(undefined, new AbortController().signal,
      async () => { offered = true; return { action: "decline" }; })).rejects.toThrow(/sensitive_elicitation_unsupported/u);
    expect(offered).toBe(false);
    expect(f.submission()).toBeUndefined();
  }, 30_000);

  it("returns an explicit unsupported-interaction error for a peer AskUser", async () => {
    const f = await fixture("ok", true);
    await expect(f.turn()).rejects.toThrow(/AskUser interaction is unsupported.*interaction_required/u);
    expect(f.turns).toHaveLength(1);
  }, 30_000);

  it("SIGKILLs an owned bridge child that ignores SIGTERM", async () => {
    const f = await fixture();
    const script = join(f.root, "stubborn.cjs");
    const pidPath = join(f.root, "stubborn.pid");
    await writeFile(script, `require('node:fs').writeFileSync(process.env.PEER_PID_PATH, String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`);
    const controller = new AbortController();
    let pid: number | undefined;
    const turn = runPeerAcpTurn({ sourceId: "peer-test", cliPath: script,
      workspace: f.root, artifactDir: f.artifactDir, caller: "agent-test", conversation: "web:caller",
      depth: 1, text: "request", env: { ...process.env, PEER_PID_PATH: pidPath },
      signal: controller.signal, onSession: async () => {},
    });
    try {
      await vi.waitFor(async () => { pid = Number(await readFile(pidPath, "utf8")); expect(pid).toBeGreaterThan(0); }, { timeout: 4_000 });
      controller.abort();
      await expect(turn).rejects.toThrow(/Peer ACP turn failed/u);
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(/ESRCH/u), { timeout: 4_000, interval: 25 });
    } finally {
      controller.abort();
      if (pid !== undefined) { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } }
    }
  }, 15_000);

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
