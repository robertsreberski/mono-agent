import { createHmac, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProcessJobProjection } from "@mono-agent/agent-contracts";
import type { TraceSourceListItem, TraceSourceListResult } from "@mono-agent/observability";
import { describe, expect, it, vi } from "vitest";

import { runJobsCommand } from "../jobs-command.js";

describe("mono-agent jobs", () => {
  it("discovers by --agent, authenticates with the owner secret, and renders list/get/cancel JSON", async () => {
    const fixture = await createFixture();
    const projection = job();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${fixture.token}`);
      expect(init?.redirect).toBe("error");
      const url = String(input);
      if (url.endsWith("/v1/jobs")) return Response.json({ jobs: [projection] });
      if (url.endsWith("/cancel")) return Response.json({ ...projection, cancelRequested: true });
      return Response.json(projection);
    }) as unknown as typeof fetch;
    const output: string[] = [];
    const common = {
      cwd: fixture.cwd,
      configPath: fixture.configPath,
      env: fixture.env,
      agent: "fixture-agent",
      listSources: fixture.listSources,
      fetchImpl,
      json: true,
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
    };
    await expect(runJobsCommand({ ...common, positionals: ["list"] })).resolves.toBe(0);
    await expect(runJobsCommand({ ...common, positionals: ["get", projection.jobId] })).resolves.toBe(0);
    await expect(runJobsCommand({ ...common, positionals: ["cancel", projection.jobId] })).resolves.toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(output.join("\n")).toContain('"jobs"');
    expect(output.join("\n")).toContain('"cancelRequested": true');
  });

  it("refuses remote endpoints before reading credentials or making a request", async () => {
    const fixture = await createFixture("http://agent.example/gui");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const errors: string[] = [];
    const result = await runJobsCommand({
      cwd: fixture.cwd,
      configPath: fixture.configPath,
      env: fixture.env,
      positionals: ["list"],
      listSources: fixture.listSources,
      fetchImpl,
      json: true,
      stderr: (text) => errors.push(text),
    });
    expect(result).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(errors.join(""))).toMatchObject({ error: { code: "remote_refused" } });
  });

  it("refuses credential-bearing loopback endpoints before sending the owner bearer", async () => {
    const fixture = await createFixture("http://user:pass@127.0.0.1:49123/gui");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const errors: string[] = [];
    const result = await runJobsCommand({
      cwd: fixture.cwd,
      configPath: fixture.configPath,
      env: fixture.env,
      positionals: ["list"],
      listSources: fixture.listSources,
      fetchImpl,
      json: true,
      stderr: (text) => errors.push(text),
    });
    expect(result).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(errors.join(""))).toMatchObject({ error: { code: "remote_refused" } });
  });

  it("returns exit 1 with agent_unreachable for discovery and transport failures, and exit 2 for usage", async () => {
    const fixture = await createFixture();
    const errors: string[] = [];
    const missing = await runJobsCommand({
      cwd: fixture.cwd,
      configPath: fixture.configPath,
      env: fixture.env,
      agent: "missing",
      positionals: ["list"],
      listSources: fixture.listSources,
      json: true,
      stderr: (text) => errors.push(text),
    });
    expect(missing).toBe(1);
    expect(JSON.parse(errors.pop() ?? "{}")).toMatchObject({ error: { code: "agent_unreachable" } });

    const unreachable = await runJobsCommand({
      cwd: fixture.cwd,
      configPath: fixture.configPath,
      env: fixture.env,
      positionals: ["list"],
      listSources: fixture.listSources,
      fetchImpl: vi.fn(async () => { throw new Error("connection refused"); }) as unknown as typeof fetch,
      json: true,
      stderr: (text) => errors.push(text),
    });
    expect(unreachable).toBe(1);
    expect(JSON.parse(errors.pop() ?? "{}")).toMatchObject({ error: { code: "agent_unreachable" } });

    const invalidProjection = await runJobsCommand({
      cwd: fixture.cwd,
      configPath: fixture.configPath,
      env: fixture.env,
      positionals: ["list"],
      listSources: fixture.listSources,
      fetchImpl: vi.fn(async () => Response.json({ jobs: [{ jobId: "not-a-projection" }] })) as unknown as typeof fetch,
      json: true,
      stderr: (text) => errors.push(text),
    });
    expect(invalidProjection).toBe(1);
    expect(JSON.parse(errors.pop() ?? "{}")).toMatchObject({ error: { code: "process_job_invalid" } });

    await expect(runJobsCommand({
      cwd: fixture.cwd,
      configPath: fixture.configPath,
      env: fixture.env,
      positionals: ["delete", "job"],
      listSources: fixture.listSources,
      stderr: (text) => errors.push(text),
    })).resolves.toBe(2);
  });
});

async function createFixture(baseUrl = "http://127.0.0.1:49123/gui"): Promise<{
  cwd: string;
  configPath: string;
  env: Record<string, string>;
  token: string;
  listSources: (options: { registryDir: string }) => Promise<TraceSourceListResult>;
}> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "mono-jobs-command-")));
  const configPath = join(cwd, "mono-agent.config.json");
  await writeFile(configPath, JSON.stringify({ processJobs: { enabled: true } }));
  const stateDir = join(cwd, ".mono-agent", "process-jobs");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32);
  await writeFile(join(stateDir, "process-jobs-secret"), `${secret.toString("base64url")}\n`, { mode: 0o600 });
  const token = createHmac("sha256", secret).update("mono-agent-process-job-operator-v1").digest("base64url");
  const registryDir = join(cwd, "registry");
  const source: TraceSourceListItem = {
    schema: "agent-runtime.trace-source.v1",
    sourceId: "fixture-source",
    label: "fixture-agent",
    artifactDir: join(cwd, "artifacts"),
    pid: 1234,
    status: "running",
    health: "running",
    startedAt: "2026-08-14T10:00:00.000Z",
    updatedAt: "2026-08-14T10:00:01.000Z",
    configPath,
    warnings: [],
    metadata: { channels: { tui: { kind: "running", baseUrl, processJobs: { stateDir } } } },
  };
  return {
    cwd,
    configPath,
    env: { MONO_AGENT_TRACE_REGISTRY_DIR: registryDir, MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: registryDir },
    token,
    listSources: async (options) => ({ registryDir: options.registryDir, sources: [source], warnings: [] }),
  };
}

function job(): ProcessJobProjection {
  return {
    schema: "mono-agent.process-job-projection.v1",
    jobId: "11111111-1111-4111-8111-111111111111",
    tool: "Exec",
    state: "running",
    summary: "exec (values redacted)",
    origin: { conversationId: "slack:C1:1.1", channel: "slack", runId: "run-1", historyBoundary: "run-1", bucket: null },
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
