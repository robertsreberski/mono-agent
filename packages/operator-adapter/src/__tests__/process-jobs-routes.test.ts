import type { ProcessJobProjection, ProcessJobOperator } from "@mono-agent/agent-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startTuiAdapter, type TuiAdapterStartResult } from "../index.js";

const servers: TuiAdapterStartResult[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.stop()));
});

describe("process-job operator routes", () => {
  it("requires an independent owner bearer and advertises jobs only with the complete controller", async () => {
    const projection = job();
    const processJobs: ProcessJobOperator = {
      operatorToken: "owner-jobs-token",
      list: vi.fn(async () => [projection]),
      get: vi.fn(async (jobId) => jobId === projection.jobId ? projection : undefined),
      cancel: vi.fn(async () => ({ ...projection, cancelRequested: true })),
    };
    const server = await startTuiAdapter({
      host: "127.0.0.1",
      port: 0,
      apiKey: "ordinary-tui-key",
      processJobs,
      processJobsBearer: "owner-jobs-token",
      responder: { respond: async () => ({ text: "ok" }) },
    });
    servers.push(server);

    const info = await fetch(`${server.baseUrl}/v1/info`, { headers: bearer("ordinary-tui-key") });
    expect(await info.json()).toMatchObject({ capabilities: { jobs: true } });
    expect((await fetch(`${server.baseUrl}/v1/jobs`)).status).toBe(401);
    expect((await fetch(`${server.baseUrl}/v1/jobs`, { headers: bearer("ordinary-tui-key") })).status).toBe(401);

    const listed = await fetch(`${server.baseUrl}/v1/jobs`, { headers: bearer("owner-jobs-token") });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ jobs: [projection] });
    expect((await fetch(`${server.baseUrl}/v1/jobs/missing`, { headers: bearer("owner-jobs-token") })).status).toBe(404);
    const cancelled = await fetch(`${server.baseUrl}/v1/jobs/${projection.jobId}/cancel`, {
      method: "POST",
      headers: bearer("owner-jobs-token"),
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ jobId: projection.jobId, cancelRequested: true });

    vi.mocked(processJobs.list).mockResolvedValue(Array.from(
      { length: 2_200 },
      () => ({ ...projection, summary: "x".repeat(8_000) }),
    ));
    const oversized = await fetch(`${server.baseUrl}/v1/jobs`, { headers: bearer("owner-jobs-token") });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: "process_job_response_too_large" } });
  });

  it("rejects half-configured controller/token pairs", async () => {
    const processJobs: ProcessJobOperator = {
      operatorToken: "token",
      list: async () => [],
      get: async () => undefined,
      cancel: async () => { throw new Error("not used"); },
    };
    await expect(startTuiAdapter({
      host: "127.0.0.1",
      port: 0,
      processJobs,
      responder: { respond: async () => ({ text: "ok" }) },
    })).rejects.toThrow(/configured together/u);
  });
});

function bearer(token: string): Record<string, string> { return { authorization: `Bearer ${token}` }; }

function job(): ProcessJobProjection {
  return {
    schema: "mono-agent.process-job-projection.v1",
    jobId: "11111111-1111-4111-8111-111111111111",
    tool: "Exec",
    state: "running",
    summary: "exec (values redacted)",
    origin: { conversationId: "web:thread-1", channel: "web", runId: "run-1", historyBoundary: "run-1", bucket: null },
    timestamps: {
      admittedAt: "2026-08-14T10:00:00.000Z",
      queueDeadlineAt: "2026-08-14T10:05:00.000Z",
      startedAt: "2026-08-14T10:00:01.000Z",
      runtimeDeadlineAt: "2026-08-14T10:30:01.000Z",
      completedAt: null,
    },
    limits: { maxRuntimeMs: 1_800_000, maxOutputBytes: 1_048_576, previewChars: 2_000, chainDepth: 0 },
    output: { stdoutBytes: 0, stderrBytes: 0, truncated: false, preview: "", stdoutRef: null, stderrRef: null },
    wake: { state: "pending", attempts: 0, deliveryKey: "process-job:1", lastAttemptAt: null },
    exitCode: null,
    signal: null,
    durationMs: null,
    cancelRequested: false,
    lastError: null,
  };
}
