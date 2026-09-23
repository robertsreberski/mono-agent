import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebService, agentGeneration } from "../service.js";
import { fakeDiscoveredAgent, temporaryRoot } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))); });

async function scenario(options: {
  readonly response?: () => Response | Promise<Response>;
  readonly turns?: () => Response | Promise<Response>;
  readonly infoResponse?: (call: number, normal: Response) => Response | Promise<Response> | undefined;
} = {}) {
  const root = await temporaryRoot(); roots.push(root);
  let discovered = fakeDiscoveredAgent({ apiKey: "fixture-key" });
  let ready = true;
  let supported = true;
  let infoPidOverride: number | undefined;
  let now = new Date("2026-09-23T10:00:00.000Z");
  let calls = 0;
  let restartCalls = 0;
  const service = await WebService.create({
    stateDir: join(root, "state"), clock: () => now, discoveryIntervalMs: 0, purgeIntervalMs: 0,
    discoverImpl: async () => [discovered],
    fetchImpl: (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/info")) {
        calls++;
        if (!ready) throw new Error("info probe unavailable");
        const normal = Response.json({ schema: 1, pid: infoPidOverride ?? discovered.source.pid, capabilities: { restart: { supported, ...(supported ? {} : { reason: "Restart=no" }) } } });
        return options.infoResponse?.(calls, normal) ?? normal;
      }
      if (url.endsWith("/v1/restart")) {
        restartCalls++;
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer fixture-key");
        return options.response?.() ?? Response.json({ operation: { id: "host-1" }, process: { pid: 123, startedAt: "2026-09-23T10:00:00.000Z" } }, { status: 202 });
      }
      if (url.endsWith("/v1/turns")) {
        return options.turns?.() ?? new Response(JSON.stringify({ kind: "finish", finalText: "done" }) + "\n", { headers: { "content-type": "application/x-ndjson" } });
      }
      throw new Error(`Unexpected fake request: ${url}`);
    }) as typeof fetch,
  });
  return { service, root, get calls() { return calls; }, get restartCalls() { return restartCalls; },
    updateAgent(next: typeof discovered) { discovered = next; },
    setReady(value: boolean) { ready = value; }, setSupported(value: boolean) { supported = value; },
    setInfoPid(value: number | undefined) { infoPidOverride = value; },
    advance(ms: number) { now = new Date(now.getTime() + ms); },
    agent: () => discovered,
  };
}

async function settle(service: WebService): Promise<void> { await service.refreshAgents(); }

function proposal(s: Awaited<ReturnType<typeof scenario>>, partId = "proposal-1") {
  const thread = s.service.createThread("agent-one");
  const turn = s.service.store.beginTurn({ threadId: thread.id, text: "question", attachmentIds: [] });
  s.service.store.completeTurn(turn.turnId, "Answer", {}, [{ type: "restart_proposal", id: partId, reason: "Please restart" }],
    { replyProcessGeneration: agentGeneration(s.agent()) });
  return { thread, messageId: turn.assistantMessageId, partId };
}

describe("web-owned restart lifecycle", () => {
  it("serves only sanitized card state; stale process, wrong thread or unsupported agent cannot forward", async () => {
    const s = await scenario();
    try {
      const card = proposal(s);
      const part = s.service.message(card.thread.id, card.messageId).parts.find((p) => p.type === "restart_proposal");
      expect(part).toEqual({ type: "restart_proposal", id: card.partId, reason: "Please restart",
        restartable: { state: "available" } });
      expect(s.service.message(card.thread.id, card.messageId, { full: true }).parts.find((p) => p.type === "restart_proposal"))
        .toEqual(part);
      expect(JSON.stringify(part)).not.toContain(agentGeneration(s.agent()));
      const foreign = s.service.createThread("agent-one");
      await expect(s.service.restartFromProposal(foreign.id, card.messageId, card.partId))
        .rejects.toMatchObject({ code: "restart_proposal_not_found" });
      const old = s.agent();
      s.updateAgent(fakeDiscoveredAgent({ ...old, source: { ...old.source, pid: 900, startedAt: "2026-09-23T10:01:00Z" } }));
      await settle(s.service);
      expect(s.service.message(card.thread.id, card.messageId).parts.find((p) => p.type === "restart_proposal"))
        .toMatchObject({ restartable: { state: "stale" } });
      await expect(s.service.restartFromProposal(card.thread.id, card.messageId, card.partId))
        .rejects.toMatchObject({ code: "restart_proposal_stale" });
      expect(s.restartCalls).toBe(0);
    } finally { await s.service.stop(); }
  });

  it("links the part BEFORE forwarding; concurrent duplicate clicks get the same operation with one adapter POST", async () => {
    let release!: (response: Response) => void;
    const s = await scenario({ response: () => new Promise<Response>((resolve) => { release = resolve; }) });
    try {
      const card = proposal(s);
      const first = s.service.restartFromProposal(card.thread.id, card.messageId, card.partId);
      await vi.waitFor(() => expect(release).toBeDefined());
      const linked = s.service.store.restartProposalBinding(card.messageId, card.partId)?.operationId;
      expect(linked).toBeDefined();
      const duplicate = await s.service.restartFromProposal(card.thread.id, card.messageId, card.partId);
      expect(duplicate).toMatchObject({ id: linked, stage: "requesting" });
      expect(s.restartCalls).toBe(1);
      release(Response.json({ operation: { id: "host-1" }, process: { pid: 123, startedAt: "2026-09-23T10:00:00.000Z" } }, { status: 202 }));
      expect(await first).toMatchObject({ id: linked, stage: "restarting" });
      expect(s.service.message(card.thread.id, card.messageId).parts.find((p) => p.type === "restart_proposal"))
        .toMatchObject({ restartable: { state: "used", operationId: linked } });
      expect(s.service.latestAgentRestart("agent-one")).toMatchObject({ id: linked, stage: "restarting" });
    } finally { await s.service.stop(); }
  });

  it("does not shadow a settled winning card operation with a losing click's fabricated failure", async () => {
    let releaseSecond!: (response: Response) => void;
    const s = await scenario({
      infoResponse: (call) => call === 3
        ? new Promise<Response>((resolve) => { releaseSecond = resolve; })
        : undefined,
      response: () => Response.json({ error: { code: "restart_unsupported", message: "Supervisor refused." } }, { status: 409 }),
    });
    try {
      const card = proposal(s);
      const first = s.service.restartFromProposal(card.thread.id, card.messageId, card.partId);
      const second = s.service.restartFromProposal(card.thread.id, card.messageId, card.partId);
      const winner = await first;
      expect(winner).toMatchObject({ outcome: "failure", reason: "Supervisor refused." });
      expect(releaseSecond).toBeDefined();
      releaseSecond(Response.json({ schema: 1, pid: 123, capabilities: { restart: { supported: true } } }));
      expect(await second).toEqual(winner);
      expect(s.service.latestAgentRestart("agent-one")?.id).toBe(winner.id);
      expect(s.restartCalls).toBe(1);
    } finally { await s.service.stop(); }
  });

  it("disables an unclaimed proposal when settings already started a restart", async () => {
    const s = await scenario();
    try {
      const card = proposal(s);
      await s.service.requestAgentRestart("agent-one");
      expect(s.service.message(card.thread.id, card.messageId).parts.find((p) => p.type === "restart_proposal"))
        .toMatchObject({ restartable: { state: "in_progress" } });
      await expect(s.service.restartFromProposal(card.thread.id, card.messageId, card.partId))
        .rejects.toMatchObject({ code: "restart_proposal_in_progress" });
      expect(s.restartCalls).toBe(1);
    } finally { await s.service.stop(); }
  });
  it("probes live support, records before POST and never succeeds on endpoint churn", async () => {
    let inspectedPending = false;
    let s!: Awaited<ReturnType<typeof scenario>>;
    s = await scenario({ response: () => {
      const pending = s.service.store.activeRestartOperation("agent-one");
      inspectedPending = pending?.stage === "requesting" && pending?.operationId === undefined;
      return Response.json({ operation: { id: "host-1" }, process: { pid: 123, startedAt: "2026-09-23T10:00:00.000Z" } }, { status: 202 });
    } });
    try {
      const initial = (await s.service.bootstrap()).agents[0];
      expect(initial?.restart).toEqual({ supported: true });
      const op = await s.service.requestAgentRestart("agent-one");
      expect(inspectedPending).toBe(true);
      expect(op).toMatchObject({ sourceId: "agent-one", stage: "restarting", approximateRunningTurns: 0 });
      expect(op).not.toHaveProperty("operationId");
      const moved = fakeDiscoveredAgent({ ...s.agent(), baseUrl: "http://127.0.0.1:45124/gui" });
      expect(agentGeneration(moved)).toBe(agentGeneration(s.agent()));
      s.updateAgent(moved);
      await settle(s.service);
      expect(s.service.restartStatus(op.id).outcome).toBeUndefined();
      const replaced = fakeDiscoveredAgent({ ...moved, source: { ...moved.source, pid: 124, startedAt: "2026-09-23T10:01:00Z" } });
      s.updateAgent(replaced); s.setReady(false);
      await settle(s.service);
      expect(s.service.restartStatus(op.id).outcome).toBeUndefined();
      s.setReady(true); await settle(s.service);
      expect(s.service.restartStatus(op.id)).toMatchObject({ stage: "back_online", outcome: "success" });
      expect(s.restartCalls).toBe(1);
    } finally { await s.service.stop(); }
  });

  it("does not claim acceptance when a different PID answers on the recycled endpoint", async () => {
    const s = await scenario({ response: () => Response.json({ operation: { id: "other-host-op" },
      process: { pid: 999, startedAt: "2026-09-23T10:00:00.000Z" } }, { status: 202 }) });
    try {
      const op = await s.service.requestAgentRestart("agent-one");
      expect(op.stage).toBe("requesting");
      expect(op.outcome).toBeUndefined();
      expect(s.service.store.restartOperation(op.id)?.operationId).toBeUndefined();
    } finally { await s.service.stop(); }
  });

  it("does not settle success when a new registry process is answered by a different operator PID", async () => {
    const s = await scenario();
    try {
      const operation = await s.service.requestAgentRestart("agent-one");
      const old = s.agent();
      s.updateAgent(fakeDiscoveredAgent({ ...old, source: { ...old.source, pid: 900, startedAt: "2026-09-23T10:01:00Z" } }));
      s.setInfoPid(901);
      await s.service.refreshAgents();
      expect(s.service.restartStatus(operation.id).outcome).toBeUndefined();
      s.setInfoPid(900);
      await s.service.refreshAgents();
      expect(s.service.restartStatus(operation.id)).toMatchObject({ stage: "back_online", outcome: "success" });
    } finally { await s.service.stop(); }
  });

  it("treats lost acknowledgement as unknown, and a new process as observed recovery without success", async () => {
    const s = await scenario({ response: () => { throw new Error("socket died"); } });
    try {
      const op = await s.service.requestAgentRestart("agent-one");
      expect(op).toMatchObject({ stage: "requesting" });
      expect(op.outcome).toBeUndefined();
      const old = s.agent();
      s.updateAgent(fakeDiscoveredAgent({ ...old, source: { ...old.source, pid: 900, startedAt: "2026-09-23T10:01:00Z" } }));
      await settle(s.service);
      expect(s.service.restartStatus(op.id)).toMatchObject({ outcome: "not_confirmed", stage: "back_online" });
    } finally { await s.service.stop(); }
  });

  it("settles definitive refusal and bound expiry, while 409 in-progress joins the existing host id", async () => {
    let receipt = Response.json({ error: { code: "restart_unsupported", message: "Restart=no" } }, { status: 409 });
    const s = await scenario({ response: () => receipt });
    try {
      const refused = await s.service.requestAgentRestart("agent-one");
      expect(refused).toMatchObject({ outcome: "failure", reason: "Restart=no" });
      receipt = Response.json({ error: { code: "restart_in_progress", message: "Already restarting" }, operation: { id: "existing-id" } }, { status: 409 });
      const attached = await s.service.requestAgentRestart("agent-one");
      expect(attached).toMatchObject({ stage: "restarting" });
      expect(s.service.store.restartOperation(attached.id)?.operationId).toBe("existing-id");
      expect((await s.service.requestAgentRestart("agent-one")).id).toBe(attached.id);
      expect(s.restartCalls).toBe(2);
      s.advance(120_001);
      expect(s.service.restartStatus(attached.id)).toMatchObject({ outcome: "not_confirmed" });
    } finally { await s.service.stop(); }
  });

  it("refuses changed policy between discovery and POST without persisting a request", async () => {
    const s = await scenario();
    try {
      s.setSupported(false);
      await expect(s.service.requestAgentRestart("agent-one")).rejects.toMatchObject({ code: "restart_unsupported" });
      expect(s.restartCalls).toBe(0);
      expect(s.service.store.activeRestartOperation("agent-one")).toBeUndefined();
    } finally { await s.service.stop(); }
  });

  it("preserves a diagnosed provider failure during the pending-restart window", async () => {
    const encoder = new TextEncoder();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let release!: (response: Response) => void;
    const s = await scenario({
      turns: () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }),
        { headers: { "content-type": "application/x-ndjson" } }),
      response: () => new Promise<Response>((resolve) => { release = resolve; }),
    });
    try {
      const thread = s.service.createThread("agent-one");
      await s.service.startTurn(thread.id, { text: "prompt" });
      await vi.waitFor(() => expect(stream).toBeDefined());
      const pending = s.service.requestAgentRestart("agent-one");
      await vi.waitFor(() => expect(release).toBeDefined());
      stream.enqueue(encoder.encode(JSON.stringify({ kind: "error", cancelled: false, code: "provider_failed", message: "Provider failed." }) + "\n"));
      stream.close();
      await vi.waitFor(() => expect(s.service.store.getThread(thread.id)?.runState.status).toBe("failed"));
      expect(s.service.store.getThread(thread.id)?.runState.error?.code).toBe("provider_failed");
      release(Response.json({ operation: { id: "host-1" }, process: { pid: 123, startedAt: "2026-09-23T10:00:00.000Z" } }, { status: 202 }));
      await pending;
    } finally { await s.service.stop(); }
  });

  it("preserves genuine explicit cancellation during the pending-restart window", async () => {
    const encoder = new TextEncoder();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let release!: (response: Response) => void;
    const s = await scenario({
      turns: () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }),
        { headers: { "content-type": "application/x-ndjson" } }),
      response: () => new Promise<Response>((resolve) => { release = resolve; }),
    });
    try {
      const thread = s.service.createThread("agent-one");
      await s.service.startTurn(thread.id, { text: "prompt" });
      await vi.waitFor(() => expect(stream).toBeDefined());
      const pending = s.service.requestAgentRestart("agent-one");
      await vi.waitFor(() => expect(release).toBeDefined());
      const turn = s.service.store.activeTurn(thread.id);
      expect(turn).toBeDefined();
      s.service.store.recordCancelOrigin(turn!.id, "user-stop");
      stream.enqueue(encoder.encode(JSON.stringify({ kind: "error", cancelled: true, code: "cancelled", message: "User stopped." }) + "\n"));
      stream.close();
      await vi.waitFor(() => expect(s.service.store.getThread(thread.id)?.runState.status).toBe("cancelled"));
      expect(s.service.store.getThread(thread.id)?.runState.cancelOrigin).toBe("user-stop");
      release(Response.json({ operation: { id: "host-1" }, process: { pid: 123, startedAt: "2026-09-23T10:00:00.000Z" } }, { status: 202 }));
      await pending;
    } finally { await s.service.stop(); }
  });

  it("classifies shutdown cancellation before the 202 is parsed as interrupted-by-restart", async () => {
    const encoder = new TextEncoder();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let release!: (response: Response) => void;
    const s = await scenario({
      turns: () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }),
        { headers: { "content-type": "application/x-ndjson" } }),
      response: () => new Promise<Response>((resolve) => { release = resolve; }),
    });
    try {
      const thread = s.service.createThread("agent-one");
      await s.service.startTurn(thread.id, { text: "prompt" });
      await vi.waitFor(() => expect(stream).toBeDefined());
      const pending = s.service.requestAgentRestart("agent-one");
      await vi.waitFor(() => expect(release).toBeDefined());
      stream.enqueue(encoder.encode(JSON.stringify({ kind: "error", cancelled: true, code: "cancelled", message: "Agent stopped." }) + "\n"));
      stream.close();
      await vi.waitFor(() => expect(s.service.store.getThread(thread.id)?.runState.status).toBe("interrupted"));
      expect(s.service.store.getThread(thread.id)?.runState.error?.code).toBe("agent_restart_interrupted");
      release(Response.json({ operation: { id: "host-1" }, process: { pid: 123, startedAt: "2026-09-23T10:00:00.000Z" } }, { status: 202 }));
      await pending;
    } finally { await s.service.stop(); }
  });
});
