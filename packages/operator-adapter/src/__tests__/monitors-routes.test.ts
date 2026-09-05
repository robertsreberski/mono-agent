import { afterEach, describe, expect, it, vi } from "vitest";

import type { MonitorOperator, MonitorProjection } from "@mono-agent/agent-contracts";

import { startTuiAdapter, type TuiAdapterStartResult } from "../index.js";

const servers: TuiAdapterStartResult[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.stop()));
});

function monitor(overrides: Partial<MonitorProjection> = {}): MonitorProjection {
  return {
    schema: "mono-agent.monitor-projection.v1",
    monitorId: "mon-1",
    state: "running",
    description: "Watching a selected pane",
    persistent: true,
    origin: { conversationId: "telegram:42", channel: "telegram", runId: "run-1", bucket: null },
    timestamps: {
      startedAt: "2026-09-03T10:00:00.000Z",
      runtimeDeadlineAt: null,
      lastEventAt: null,
      completedAt: null,
    },
    limits: { maxRuntimeMs: 3_600_000, coalesceMs: 200, maxBatchLines: 200, maxBatchBytes: 65_536, chainDepth: 0 },
    counters: { seq: 2, batchesDelivered: 2, linesObserved: 5, linesDelivered: 5, droppedLines: 0, pendingLines: 0 },
    exitCode: null,
    signal: null,
    cancelRequested: false,
    lastError: null,
    ...overrides,
  };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function start(operator: MonitorOperator | undefined, options: { bearerToken?: string } = {}) {
  const server = await startTuiAdapter({
    host: "127.0.0.1",
    port: 0,
    apiKey: "ordinary-tui-key",
    ...(operator === undefined ? {} : { monitors: operator }),
    ...(options.bearerToken === undefined ? {} : { monitorsBearer: options.bearerToken }),
    responder: { respond: async () => ({ text: "ok" }) },
  });
  servers.push(server);
  return server;
}

describe("monitor operator routes", () => {
  it("requires the independent owner bearer and advertises the capability", async () => {
    const projection = monitor();
    const operator: MonitorOperator = {
      operatorToken: "owner-monitors-token",
      list: vi.fn(async () => [projection]),
      get: vi.fn(async (id) => (id === projection.monitorId ? projection : undefined)),
      cancel: vi.fn(async (): Promise<MonitorProjection> => ({
        ...projection,
        state: "cancelled",
        cancelRequested: true,
        timestamps: { ...projection.timestamps, completedAt: "2026-09-03T10:05:00.000Z" },
      })),
    };
    const server = await start(operator, { bearerToken: "owner-monitors-token" });

    const info = await fetch(`${server.baseUrl}/v1/info`, { headers: bearer("ordinary-tui-key") });
    expect(await info.json()).toMatchObject({ capabilities: { monitors: true } });

    // The ordinary TUI key must not reach the owner-only monitor plane.
    expect((await fetch(`${server.baseUrl}/v1/monitors`)).status).toBe(401);
    expect((await fetch(`${server.baseUrl}/v1/monitors`, { headers: bearer("ordinary-tui-key") })).status).toBe(401);

    const listed = await fetch(`${server.baseUrl}/v1/monitors`, { headers: bearer("owner-monitors-token") });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ monitors: [projection] });

    const fetched = await fetch(`${server.baseUrl}/v1/monitors/mon-1`, { headers: bearer("owner-monitors-token") });
    expect(await fetched.json()).toEqual(projection);
    expect((await fetch(`${server.baseUrl}/v1/monitors/missing`, { headers: bearer("owner-monitors-token") })).status)
      .toBe(404);
  });

  it("maps a not-found and a conflict cancel to their HTTP statuses", async () => {
    const operator: MonitorOperator = {
      operatorToken: "owner-monitors-token",
      list: async () => [],
      get: async () => undefined,
      cancel: async (id) => {
        throw Object.assign(new Error("nope"), { code: id === "gone" ? "monitor_not_found" : "monitor_conflict" });
      },
    };
    const server = await start(operator, { bearerToken: "owner-monitors-token" });
    const headers = bearer("owner-monitors-token");
    expect((await fetch(`${server.baseUrl}/v1/monitors/gone/cancel`, { method: "POST", headers })).status).toBe(404);
    expect((await fetch(`${server.baseUrl}/v1/monitors/busy/cancel`, { method: "POST", headers })).status).toBe(409);
  });

  it("rejects an oversized monitor id before reaching the controller", async () => {
    const cancel = vi.fn();
    const server = await start({
      operatorToken: "owner-monitors-token",
      list: async () => [],
      get: async () => undefined,
      cancel: cancel as never,
    }, { bearerToken: "owner-monitors-token" });
    const response = await fetch(`${server.baseUrl}/v1/monitors/${"x".repeat(300)}`, {
      headers: bearer("owner-monitors-token"),
    });
    expect(response.status).toBe(400);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("404s every route and hides the capability without a controller", async () => {
    const server = await start(undefined);
    const info = await fetch(`${server.baseUrl}/v1/info`, { headers: bearer("ordinary-tui-key") });
    const body = await info.json() as { readonly capabilities: Record<string, unknown> };
    expect(body.capabilities).not.toHaveProperty("monitors");
    expect((await fetch(`${server.baseUrl}/v1/monitors`)).status).toBe(404);
  });

  it("refuses to start with only one half of the controller pair", async () => {
    await expect(start({
      operatorToken: "t",
      list: async () => [],
      get: async () => undefined,
      cancel: async () => { throw new Error("unused"); },
    })).rejects.toThrow(/monitors and monitorsBearer must be configured together/u);
  });
});

it.each([false, true])("authorizes Monitor turn and live-input keys independently of ordinary API auth (configured=%s)", async (apiAuth) => {
  const requests: unknown[] = [];
  const offers: unknown[] = [];
  const operator: MonitorOperator = {
    operatorToken: "owner-monitors-token", list: async () => [], get: async () => undefined, cancel: async () => monitor(),
  };
  const server = await startTuiAdapter({
    host: "127.0.0.1", port: 0,
    ...(apiAuth ? { apiKey: "ordinary-tui-key" } : {}),
    monitors: operator, monitorsBearer: operator.operatorToken,
    responder: {
      respond: async (request) => { requests.push(request); return { text: "NOTHING_TO_REPORT" }; },
      offerLiveInput: (input) => { offers.push(input); return { status: "accepted", settled: Promise.resolve({ status: "applied", runId: "run" }) }; },
    },
  });
  servers.push(server);
  const headers = { "content-type": "application/json", ...(apiAuth ? bearer("ordinary-tui-key") : {}) };
  const key = "monitor:mon-1:2";
  const turn = { client: "web", conversationId: "web:thread", text: "Literal", processJobWakeDeliveryKey: key };
  for (const supplied of [undefined, "Bearer ordinary-tui-key", "Bearer wrong-owner"]) {
    const response = await fetch(`${server.baseUrl}/v1/turns`, { method: "POST", headers: { ...headers,
      ...(supplied === undefined ? {} : { "x-mono-agent-monitor-wake-authorization": supplied }) }, body: JSON.stringify(turn) });
    expect(response.status).toBe(401); await response.text();
  }
  expect(requests).toHaveLength(0);
  const live = { id: key, deliveryKey: key, text: "Event", receivedAt: new Date().toISOString() };
  const denied = await fetch(`${server.baseUrl}/v1/conversations/web%3Athread/live-input`, { method: "POST", headers, body: JSON.stringify(live) });
  expect(denied.status).toBe(401); await denied.text(); expect(offers).toHaveLength(0);
  const ownerHeaders = { ...headers, "x-mono-agent-monitor-wake-authorization": `Bearer ${operator.operatorToken}` };
  const accepted = await fetch(`${server.baseUrl}/v1/turns`, { method: "POST", headers: ownerHeaders, body: JSON.stringify(turn) });
  expect(accepted.status).toBe(200); await accepted.text(); expect(requests).toHaveLength(1);
  const steered = await fetch(`${server.baseUrl}/v1/conversations/web%3Athread/live-input`, { method: "POST", headers: ownerHeaders, body: JSON.stringify(live) });
  expect(steered.status).toBe(200); await steered.text(); expect(offers).toHaveLength(1);
  const ordinary = await fetch(`${server.baseUrl}/v1/turns`, { method: "POST", headers,
    body: JSON.stringify({ client: "web", conversationId: "web:thread", text: "Literal" }) });
  expect(ordinary.status).toBe(200); expect(await ordinary.text()).toContain("NOTHING_TO_REPORT");
});
