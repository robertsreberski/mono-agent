import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
vi.mock("../peer-acp-client.js", () => ({ runPeerAcpTurn: mocks.run }));

import { createPeerAgentRuntimeExtension } from "../peer-agent.js";
import { makePeerHandoff } from "../peer-provenance.js";
import type { InternalProcessJobRequest } from "../process-jobs-internal.js";
import type { ProcessJobsServiceHandle } from "../process-jobs-service.js";

const roots: string[] = [];
afterEach(async () => {
  mocks.turns.splice(0);
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(depth?: number | "forged", surface: "web" | "acp" = "web", eager = false) {
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
    : await makePeerHandoff(artifactDir, {
      caller: "agent-test", conversation: "web:origin", session: conversationId,
      sourceId: "finance-ai", generation: "11111111-1111-4111-8111-111111111111", depth, text: "request",
    });
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

  it("exhausts verified A→B→A lineage instead of resetting to zero", async () => {
    const f = await setup(4);
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
