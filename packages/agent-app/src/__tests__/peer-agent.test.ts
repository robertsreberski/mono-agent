import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveJsonMonoAgentConfig } from "@mono-agent/config";

const mocks = vi.hoisted(() => ({
  turns: [] as string[],
  run: vi.fn(),
  discover: vi.fn(),
  operators: vi.fn(),
}));
vi.mock("@mono-agent/web", async (importOriginal) => ({
  ...await importOriginal<typeof import("@mono-agent/web")>(),
  discoverAcpBridgeAgents: mocks.discover,
  discoverOperatorAgents: mocks.operators,
}));
vi.mock("../peer-acp-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../peer-acp-client.js")>(), runPeerAcpTurn: mocks.run,
}));

import { createPeerAgentRuntimeExtension } from "../peer-agent.js";
import { PeerSessionGoneError, type PeerAcpTurn } from "../peer-acp-client.js";
import { makePeerHandoff, stampPeerOperatorHandoff } from "../peer-provenance.js";
import type { InternalProcessJobRequest } from "../process-jobs-internal.js";
import type { ProcessJobsServiceHandle } from "../process-jobs-service.js";

const roots: string[] = [];
afterEach(async () => {
  mocks.turns.splice(0);
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(depth?: number | "forged", surface: "web" | "acp" = "web", eager = false, chain?: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-peer-tool-"));
  roots.push(root);
  const artifactDir = join(root, "artifacts");
  const config = resolveJsonMonoAgentConfig({ cwd: root, json: {
    runtime: { model: "pi:openai-codex:gpt-5.5", workspace: root },
    context: { identityPath: "IDENTITY.md" },
    artifacts: { dir: artifactDir },
    tools: { allowedTools: ["PeerAgent"] },
    peers: { finance: { sourceId: "finance-ai" } },
  } });
  mocks.discover.mockResolvedValue({ sources: [{ sourceId: "finance-ai", health: "running", compatible: true,
    workspace: { path: root } }] });
  mocks.operators.mockResolvedValue([
    { source: { sourceId: "agent-A", health: "running", artifactDir } },
    { source: { sourceId: "finance-ai", health: "running", artifactDir: join(root, "peer-artifacts") } },
  ]);
  mocks.run.mockImplementation(async (options: { onSession(id: string): Promise<void>; text: string; depth: number }) => {
    mocks.turns.push(options.text);
    await options.onSession("acp:finance-ai:cebc81c1-e853-468f-a5d2-b88a97a9aa01");
    return { sessionId: "acp:finance-ai:cebc81c1-e853-468f-a5d2-b88a97a9aa01", answer: "[Untrusted peer answer] done" };
  });
  let pending: InternalProcessJobRequest | undefined;
  let eagerRun: Promise<unknown> | undefined;
  let admittedOrigin: unknown;
  const service = {
    settings: { maxChainDepth: 4 },
    internalController: (origin: unknown) => {
      admittedOrigin = origin;
      return { startInternal: async (request: InternalProcessJobRequest) => {
        pending = request;
        if (eager) {
          eagerRun = request.run(new AbortController().signal, () => {}, () => {});
          await Promise.resolve();
          expect(mocks.turns).toEqual([]);
        }
        return { jobId: request.jobId, state: "queued", startedAt: null };
      } };
    },
  } as unknown as ProcessJobsServiceHandle;
  const conversationId = surface === "acp" ? "acp:agent-b:turn" : "web:origin";
  const peerHandoff = depth === undefined ? undefined : depth === "forged" ? { depth: 4 }
    : await stampPeerOperatorHandoff(artifactDir, await makePeerHandoff(artifactDir, {
      caller: chain?.at(-2) ?? "agent-test", conversation: "web:origin", session: conversationId,
      sourceId: "agent-A", generation: "11111111-1111-4111-8111-111111111111", depth,
      chain: chain ?? ["agent-test", "agent-A"], text: "request",
    }));
  const request = { conversationId, userMessage: "request", metadata: {
    source: surface, ...(peerHandoff ? { peerHandoff } : {}),
  }, abortSignal: new AbortController().signal };
  const extension = await createPeerAgentRuntimeExtension({ config, service, channelId: "tui" })!({
    runId: "run-1", request, context: {} as never,
  });
  const spec = (extension.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-peer-agent"]!;
  const client = new Client({ name: "peer-agent-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
  return { client, config, request, pending: () => pending, eagerRun: () => eagerRun, admittedOrigin: () => admittedOrigin,
    close: async () => { await client.close(); await extension.cleanup?.(); },
    send: async (background = false) => await client.callTool({ name: "PeerAgent", arguments: {
      action: "send", peer: "finance", thread: "portfolio", message: "do work", background,
    } }),
  };
}

describe("PeerAgent request lifecycle", () => {
  const parked = async (options: PeerAcpTurn) => {
    await options.onSession("acp:finance-ai:cebc81c1-e853-468f-a5d2-b88a97a9aa01");
    const response = await options.onQuestion!({ sessionId: "acp:finance-ai:cebc81c1-e853-468f-a5d2-b88a97a9aa01",
      toolCallId: "ask-1", message: "Proceed?", requestedSchema: { type: "object",
        properties: { question_1: { type: "string", enum: ["yes", "no"] } }, required: ["question_1"] } });
    if (response.action !== "accept") throw new Error("Peer question declined or interrupted.");
    return { sessionId: "acp:finance-ai:cebc81c1-e853-468f-a5d2-b88a97a9aa01", answer: "[Untrusted peer answer] continued" };
  };

  it("returns a foreground question then resumes the same run after an exact answer", async () => {
    const f = await setup();
    mocks.run.mockImplementation(parked);
    try {
      const asked = await f.send();
      expect(asked.isError).not.toBe(true);
      const question = JSON.parse(String((asked.content as Array<{ text?: string }>)[0]?.text)) as { questionId: string; state: string };
      expect(question.state).toBe("awaiting_answer");
      for (const { thread, questionId } of [
        { thread: "wrong", questionId: question.questionId },
        { thread: "portfolio", questionId: "22222222-2222-4222-8222-222222222222" },
      ]) {
        const rejected = await f.client.callTool({ name: "PeerAgent", arguments: { action: "answer", peer: "finance",
          thread, questionId, answers: { question_1: "yes" } } });
        expect(rejected.isError).toBe(true);
      }
      const answered = await f.client.callTool({ name: "PeerAgent", arguments: { action: "answer", peer: "finance",
        thread: "portfolio", questionId: question.questionId, answers: { question_1: "yes" } } });
      expect(answered.isError).not.toBe(true);
      expect(answered.content).toEqual([{ type: "text", text: "[Untrusted peer answer] continued" }]);
      const duplicate = await f.client.callTool({ name: "PeerAgent", arguments: { action: "answer", peer: "finance",
        thread: "portfolio", questionId: question.questionId, answers: { question_1: "yes" } } });
      expect(duplicate.isError).toBe(true);
    } finally { await f.close(); }
  });

  it.each(["decline", "stop"] as const)("interrupts a parked question on %s and rejects late answers", async (action) => {
    const f = await setup();
    mocks.run.mockImplementation(parked);
    try {
      const asked = await f.send();
      const question = JSON.parse(String((asked.content as Array<{ text?: string }>)[0]?.text)) as { questionId: string };
      const stopped = await f.client.callTool({ name: "PeerAgent", arguments: { action, peer: "finance",
        thread: "portfolio", ...(action === "decline" ? { questionId: question.questionId } : {}) } });
      if (action === "stop") expect(stopped.isError).not.toBe(true);
      else expect(stopped.isError).toBe(true);
      const late = await f.client.callTool({ name: "PeerAgent", arguments: { action: "answer", peer: "finance",
        thread: "portfolio", questionId: question.questionId, answers: { question_1: "yes" } } });
      expect(late.isError).toBe(true);
    } finally { await f.close(); }
  });

  it("skips one corrupt peer record while reconciling a healthy parked thread", async () => {
    const f = await setup();
    const root = join(dirname(f.config.artifacts.dir), "peer-threads");
    const invalid = join(root, "a".repeat(64));
    const healthy = join(root, "b".repeat(64));
    await mkdir(invalid, { recursive: true, mode: 0o700 });
    await mkdir(healthy, { recursive: true, mode: 0o700 });
    await writeFile(join(invalid, "thread.json"), "{corrupt", { mode: 0o600 });
    await writeFile(join(healthy, "thread.json"), JSON.stringify({ schema: 1, conversation: "web:origin",
      peer: "finance", thread: "portfolio", sourceId: "finance-ai", generation: "11111111-1111-4111-8111-111111111111",
      status: "awaiting_answer", question: { questionId: "22222222-2222-4222-8222-222222222222",
        message: "Proceed?", peer: "finance", thread: "portfolio", requestedSchema: { type: "object" },
        expiresAt: new Date(Date.now() + 60_000).toISOString() },
    }), { mode: 0o600 });
    const fresh = await createPeerAgentRuntimeExtension({ config: f.config })!({
      runId: "after-restart", request: f.request, context: {} as never,
    });
    try {
      expect(fresh.runtimeOptions?.mcpServers).toHaveProperty("mono-agent-peer-agent");
      expect(JSON.parse(await readFile(join(healthy, "thread.json"), "utf8"))).toMatchObject({ status: "interrupted" });
    } finally { await fresh.cleanup?.(); await f.close(); }
  });

  it("streams more than 8192 owner entries without blocking ordinary turns", async () => {
    const f = await setup();
    const root = join(dirname(f.config.artifacts.dir), "peer-threads");
    await mkdir(root, { recursive: true });
    for (let offset = 0; offset < 8_193; offset += 256) {
      await Promise.all(Array.from({ length: Math.min(256, 8_193 - offset) }, (_, index) =>
        mkdir(join(root, `junk-${String(offset + index)}`))));
    }
    const healthy = join(root, "c".repeat(64));
    await mkdir(healthy, { mode: 0o700 });
    await writeFile(join(healthy, "thread.json"), JSON.stringify({ schema: 1, conversation: "web:origin",
      peer: "finance", thread: "portfolio", sourceId: "finance-ai", generation: "11111111-1111-4111-8111-111111111111",
      status: "busy" }), { mode: 0o600 });
    const fresh = await createPeerAgentRuntimeExtension({ config: f.config })!({
      runId: "after-large-restart", request: f.request, context: {} as never,
    });
    try {
      expect(fresh.runtimeOptions?.mcpServers).toHaveProperty("mono-agent-peer-agent");
      expect(JSON.parse(await readFile(join(healthy, "thread.json"), "utf8"))).toMatchObject({ status: "interrupted" });
    } finally { await fresh.cleanup?.(); await f.close(); }
  }, 30_000);

  it("marks a persisted but ownerless question interrupted after caller restart", async () => {
    const f = await setup();
    const key = join(dirname(f.config.artifacts.dir), "peer-threads",
      createHash("sha256").update(JSON.stringify([f.request.conversationId, "finance", "portfolio"])).digest("hex"));
    await mkdir(key, { recursive: true, mode: 0o700 });
    const questionId = "11111111-1111-4111-8111-111111111111";
    await writeFile(join(key, "thread.json"), JSON.stringify({ schema: 1, conversation: f.request.conversationId,
      peer: "finance", thread: "portfolio", sourceId: "finance-ai", sessionId: "acp:finance-ai:prior",
      generation: "22222222-2222-4222-8222-222222222222", status: "awaiting_answer",
      question: { questionId, message: "Proceed?", peer: "finance", thread: "portfolio",
        requestedSchema: { type: "object" }, expiresAt: new Date(Date.now() + 30_000).toISOString() },
    }), { mode: 0o600 });
    const fresh = await createPeerAgentRuntimeExtension({ config: f.config, channelId: "tui" })!({
      runId: "after-restart", request: f.request, context: {} as never,
    });
    expect(JSON.parse(await readFile(join(key, "thread.json"), "utf8"))).toMatchObject({ status: "interrupted" });
    const spec = (fresh.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-peer-agent"]!;
    const client = new Client({ name: "peer-restart-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
    try {
      const late = await client.callTool({ name: "PeerAgent", arguments: { action: "answer", peer: "finance",
        thread: "portfolio", questionId, answers: { question_1: "yes" } } });
      expect(late.isError).toBe(true);
      expect(late.content).toEqual([{ type: "text", text: expect.stringContaining("interrupted") }]);
      expect(JSON.parse(await readFile(join(key, "thread.json"), "utf8"))).toMatchObject({ status: "interrupted" });
      expect(mocks.run).not.toHaveBeenCalled();
    } finally { await client.close(); await fresh.cleanup?.(); await f.close(); }
  });

  it("answers a question from an ACP-served peer in foreground without inventing a wake", async () => {
    const f = await setup(2, "acp");
    mocks.run.mockImplementation(parked);
    try {
      const asked = await f.send();
      const question = JSON.parse(String((asked.content as Array<{ text?: string }>)[0]?.text)) as { questionId: string };
      expect((await f.send(true)).isError).toBe(true);
      const result = await f.client.callTool({ name: "PeerAgent", arguments: { action: "answer", peer: "finance",
        thread: "portfolio", questionId: question.questionId, answers: { question_1: "yes" } } });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "[Untrusted peer answer] continued" }]);
      expect(f.pending()).toBeUndefined();
    } finally { await f.close(); }
  });

  it("settles a background question wake then a continuation wake on the exact original origin", async () => {
    const f = await setup();
    mocks.run.mockImplementation(parked);
    try {
      expect((await f.send(true)).isError).not.toBe(true);
      const questionJob = f.pending()!;
      const questionResult = await questionJob.run(new AbortController().signal, () => {}, () => {});
      expect(questionResult).toMatchObject({ status: "awaiting_reply", peerQuestion: {
        questionId: expect.any(String), message: "Proceed?", state: "awaiting_answer" } });
      const questionId = questionResult.peerQuestion!.questionId;
      const receipt = await f.client.callTool({ name: "PeerAgent", arguments: { action: "answer", peer: "finance",
        thread: "portfolio", questionId, answers: { question_1: "yes" } } });
      expect(receipt.isError).not.toBe(true);
      expect(receipt.content).toEqual([{ type: "text", text: expect.stringContaining('"state":"started"') }]);
      expect(f.admittedOrigin()).toMatchObject({ conversationId: "web:origin", replyToConversationId: "web:origin" });
      const completion = await f.pending()!.run(new AbortController().signal, () => {}, () => {});
      expect(completion).toMatchObject({ status: "ok", answer: "[Untrusted peer answer] continued" });
    } finally { await f.close(); }
  });
  it("persists started before dispatch and binds the exact caller for terminal wake", async () => {
    const f = await setup();
    try {
      const receipt = await f.send(true);
      expect(receipt.isError).not.toBe(true);
      expect(receipt.content).toEqual([{ type: "text", text: expect.stringContaining('"state":"started"') }]);
      expect(mocks.turns).toEqual([]);
      expect(f.admittedOrigin()).toMatchObject({ conversationId: "web:origin", replyToConversationId: "web:origin" });
      const request = f.pending()!;
      expect(request.tool).toBe("PeerAgent");
      const result = await request.run(new AbortController().signal, () => {}, () => {});
      expect(result).toMatchObject({ status: "ok", answer: expect.stringContaining("Untrusted") });
      expect(mocks.turns).toEqual(["do work"]);
      expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ caller: "agent-A" }));
    } finally { await f.close(); }
  });

  it("describes only callable peers and rechecks live discovery at send time", async () => {
    const f = await setup();
    try {
      const listed = await f.client.listTools();
      expect(listed.tools.find((tool) => tool.name === "PeerAgent")?.description).toContain("Callable peers: finance");
      mocks.discover.mockResolvedValue({ sources: [] });
      const denied = await f.send();
      expect(denied.isError).toBe(true);
      expect(mocks.run).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("hides the tool when the caller has no unique registered source", async () => {
    const f = await setup();
    try {
      mocks.operators.mockResolvedValue([]);
      const hidden = await createPeerAgentRuntimeExtension({ config: f.config })!({
        runId: "run-2", request: f.request, context: {} as never,
      });
      expect(hidden.runtimeOptions?.mcpServers).toBeUndefined();
      await hidden.cleanup?.();
    } finally { await f.close(); }
  });

  it("refuses to invent caller identity when no running local source matches", async () => {
    const f = await setup();
    try {
      mocks.operators.mockResolvedValue([{ source: {
        sourceId: "finance-ai", health: "running", artifactDir: join(f.config.runtime.workspace, "peer-artifacts"),
      } }]);
      const denied = await f.send();
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual([{ type: "text", text: expect.stringContaining("provenance cannot be attested") }]);
      expect(mocks.run).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("rejects a second send on an active thread without dispatching it", async () => {
    const f = await setup();
    try {
      await f.send(true);
      const second = await f.send();
      expect(second.isError).toBe(true);
      expect(mocks.turns).toHaveLength(0);
      await f.pending()!.cleanup();
    } finally { await f.close(); }
  });

  it("withholds eager internal execution until after the started receipt", async () => {
    const f = await setup(undefined, "web", true);
    try {
      const receipt = await f.send(true);
      expect(receipt.isError).not.toBe(true);
      expect(receipt.content).toEqual([{ type: "text", text: expect.stringContaining('"state":"started"') }]);
      expect(await f.eagerRun()).toMatchObject({ status: "ok" });
      expect(mocks.turns).toEqual(["do work"]);
    } finally { await f.close(); }
  });

  it("stops a queued background turn before it dispatches and never replays its prompt", async () => {
    const f = await setup();
    try {
      await f.send(true);
      const stopped = await f.client.callTool({ name: "PeerAgent", arguments: {
        action: "stop", peer: "finance", thread: "portfolio",
      } });
      expect(stopped.isError).not.toBe(true);
      expect(stopped.content).toEqual([{ type: "text", text: expect.stringContaining("settling") }]);
      const result = await f.pending()!.run(new AbortController().signal, () => {}, () => {});
      expect(result).toMatchObject({ status: "failed" });
      expect(mocks.turns).toEqual([]);
      const next = await f.send();
      expect(next.isError).not.toBe(true);
      expect(mocks.turns).toEqual(["do work"]);
    } finally { await f.close(); }
  });

  it.each(["unknown_session_id", "peer_session_exhausted"] as const)("clears a %s session only for the next explicit send", async (reason) => {
    const f = await setup();
    try {
      expect((await f.send()).isError).not.toBe(true);
      mocks.run.mockRejectedValueOnce(new PeerSessionGoneError(reason));
      const interrupted = await f.send();
      expect(interrupted.isError).toBe(true);
      expect(interrupted.content).toEqual([{ type: "text", text: expect.stringContaining("next explicit send") }]);
      expect(mocks.run).toHaveBeenCalledTimes(2);
      expect((await f.send()).isError).not.toBe(true);
      expect(mocks.run.mock.lastCall?.[0]).not.toHaveProperty("sessionId");
    } finally { await f.close(); }
  });

  it("rejects A→B→A cycle before an ACP call can deadlock the original agent", async () => {
    const f = await setup(2, "acp", false, ["finance-ai", "agent-A"]);
    try {
      const denied = await f.send();
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual([{ type: "text", text: expect.stringContaining("Peer call cycle rejected") }]);
      expect(mocks.run).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("exhausts verified A→B→A lineage instead of resetting to zero", async () => {
    const f = await setup(4, "acp");
    try {
      const denied = await f.send();
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual([{ type: "text", text: expect.stringContaining("chain depth exhausted") }]);
      expect(mocks.turns).toHaveLength(0);
    } finally { await f.close(); }
  });

  it("reports ACP-origin background as unavailable but keeps foreground usable", async () => {
    const f = await setup(2, "acp");
    try {
      const denied = await f.send(true);
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual([{ type: "text", text: expect.stringContaining("no wake-capable origin") }]);
      const foreground = await f.send();
      expect(foreground.isError).not.toBe(true);
      expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ depth: 3 }));
    } finally { await f.close(); }
  });

  it("does not trust a forged free metadata depth", async () => {
    const f = await setup("forged");
    try {
      const result = await f.send();
      expect(result.isError).not.toBe(true);
      expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ depth: 1 }));
    } finally { await f.close(); }
  });
});
