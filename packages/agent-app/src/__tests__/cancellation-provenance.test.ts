import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentResponseCancelledError,
  isChannelUserCancelReason,
  type AgentRequestBase,
  type AgentResponder,
} from "@mono-agent/agent-contracts";
import { startTuiAdapter, type TuiAdapterStartResult } from "@mono-agent/operator-adapter";
import {
  startWebServer,
  type DiscoveredOperatorAgent,
  type WebServerHandle,
} from "@mono-agent/web";

const roots: string[] = [];
const operators: TuiAdapterStartResult[] = [];
const webServers: WebServerHandle[] = [];

afterEach(async () => {
  await Promise.all(webServers.splice(0).map(async (server) => server.stop()));
  await Promise.all(operators.splice(0).map(async (server) => server.stop()));
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

describe("channel cancellation provenance", () => {
  it("delivers explicit web-console cancellation to the responder before generic stream disconnect", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "mono-agent-web-cancel-provenance-"));
    roots.push(temporaryRoot);
    const root = await realpath(temporaryRoot);
    const staticDir = join(root, "static");
    await mkdir(staticDir);
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>web cancellation</title>");

    let resolveTurnStarted!: () => void;
    const turnStarted = new Promise<void>((resolve) => { resolveTurnStarted = resolve; });
    let resolveFirstCancellation!: (reason: unknown) => void;
    const firstCancellation = new Promise<unknown>((resolve) => { resolveFirstCancellation = resolve; });
    let rejectTurn: ((reason?: unknown) => void) | undefined;
    let settled = false;
    const settle = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      resolveFirstCancellation(reason);
      rejectTurn?.(new AgentResponseCancelledError("Turn cancelled.", { reason }));
    };
    const responder: AgentResponder = {
      respond(request: AgentRequestBase) {
        request.abortSignal.addEventListener("abort", () => settle(request.abortSignal.reason), { once: true });
        resolveTurnStarted();
        return new Promise<never>((_resolve, reject) => { rejectTurn = reject; });
      },
      cancel(_conversationId, reason) {
        settle(reason);
      },
    };
    const operator = await startTuiAdapter({
      host: "127.0.0.1",
      port: 0,
      responder,
      info: { label: "Cancellation Target" },
    });
    operators.push(operator);

    const discovered: DiscoveredOperatorAgent = {
      source: {
        schema: "agent-runtime.trace-source.v1",
        sourceId: "cancel-target",
        label: "Cancellation Target",
        artifactDir: join(root, "artifacts"),
        pid: process.pid,
        status: "running",
        health: "running",
        startedAt: "2026-08-15T08:00:00.000Z",
        updatedAt: "2026-08-15T08:00:00.000Z",
        warnings: [],
      },
      baseUrl: operator.baseUrl,
    };
    const delayedCancelFetch: typeof fetch = async (input, init) => {
      if (requestUrl(input).endsWith("/cancel")) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return fetch(input, init);
    };
    const web = await startWebServer({
      host: "127.0.0.1",
      port: 0,
      stateDir: join(root, "state"),
      staticDir,
      discoveryIntervalMs: 0,
      purgeIntervalMs: 0,
      discoverImpl: async () => [discovered],
      fetchImpl: delayedCancelFetch,
    });
    webServers.push(web);
    const baseUrl = `http://127.0.0.1:${String(web.port)}`;

    const created = await fetch(`${baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "cancel-target" }),
    });
    expect(created.status).toBe(201);
    const thread = (await created.json() as { thread: { id: string } }).thread;
    const started = await fetch(`${baseUrl}/api/v1/threads/${thread.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Keep working" }),
    });
    expect(started.status).toBe(202);
    await turnStarted;

    const cancelled = await fetch(`${baseUrl}/api/v1/threads/${thread.id}/cancel`, { method: "POST" });
    expect(cancelled.status).toBe(202);
    const reason = await firstCancellation;

    expect(isChannelUserCancelReason(reason)).toBe(true);
    expect(reason).toMatchObject({ channelUserCancel: true, channel: "TUI" });
  });
});
