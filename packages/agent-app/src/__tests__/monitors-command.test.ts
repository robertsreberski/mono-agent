import { createHmac, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MonitorProjection } from "@mono-agent/agent-contracts";
import type { TraceSourceListItem, TraceSourceListResult } from "@mono-agent/observability";
import { describe, expect, it, vi } from "vitest";

import { runMonitorsCommand } from "../monitors-command.js";

describe("mono-agent monitors", () => {
  it("authenticates with the monitor-labelled bearer and renders list/get/cancel", async () => {
    const fixture = await createFixture();
    const projection = monitor();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${fixture.token}`);
      expect(init?.redirect).toBe("error");
      const url = String(input);
      if (url.endsWith("/v1/monitors")) return Response.json({ monitors: [projection] });
      if (url.endsWith("/cancel")) return Response.json({ ...projection, state: "cancelled", cancelRequested: true, timestamps: { ...projection.timestamps, completedAt: "2026-09-03T10:05:00.000Z" } });
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
    await expect(runMonitorsCommand({ ...common, positionals: ["list"] })).resolves.toBe(0);
    await expect(runMonitorsCommand({ ...common, positionals: ["get", projection.monitorId] })).resolves.toBe(0);
    await expect(runMonitorsCommand({ ...common, positionals: ["cancel", projection.monitorId] })).resolves.toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(output.join("\n")).toContain('"monitors"');
    expect(output.join("\n")).toContain('"cancelled"');
  });

  it("uses a bearer that cannot authorize the process-job routes", async () => {
    const fixture = await createFixture();
    expect(fixture.token).not.toBe(fixture.processJobToken);
  });

  it("renders a human table that never reveals the watched command", async () => {
    const fixture = await createFixture();
    const projection = monitor();
    const output: string[] = [];
    await expect(runMonitorsCommand({
      cwd: fixture.cwd,
      configPath: fixture.configPath,
      env: fixture.env,
      listSources: fixture.listSources,
      fetchImpl: (async () => Response.json({ monitors: [projection] })) as unknown as typeof fetch,
      positionals: ["list"],
      stdout: (text) => output.push(text),
    })).resolves.toBe(0);
    const rendered = output.join("");
    expect(rendered).toContain("mon-1");
    expect(rendered).toContain("Watching a selected pane");
    expect(rendered).not.toContain("/bin/bash");
  });

  it("rejects an invalid invocation before discovering an agent", async () => {
    const errors: string[] = [];
    const result = await runMonitorsCommand({
      cwd: process.cwd(),
      configPath: join(process.cwd(), "mono-agent.config.json"),
      env: {},
      positionals: ["get"],
      stderr: (text) => errors.push(text),
    });
    expect(result).toBe(2);
    expect(errors.join("")).toContain("Usage: mono-agent monitors");
  });

  it("refuses a remote endpoint before reading credentials", async () => {
    const fixture = await createFixture("http://agent.example/gui");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const errors: string[] = [];
    const result = await runMonitorsCommand({
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

  it("reports a live agent without a monitor controller as disabled", async () => {
    const fixture = await createFixture("http://127.0.0.1:49123/gui", { advertiseMonitors: false });
    const errors: string[] = [];
    const result = await runMonitorsCommand({
      cwd: fixture.cwd,
      configPath: fixture.configPath,
      env: fixture.env,
      positionals: ["list"],
      listSources: fixture.listSources,
      fetchImpl: (vi.fn() as unknown as typeof fetch),
      json: true,
      stderr: (text) => errors.push(text),
    });
    expect(result).toBe(1);
    expect(JSON.parse(errors.join(""))).toMatchObject({ error: { code: "monitor_disabled" } });
  });

  it("rejects a malformed projection rather than printing it", async () => {
    const fixture = await createFixture();
    const errors: string[] = [];
    const result = await runMonitorsCommand({
      cwd: fixture.cwd,
      configPath: fixture.configPath,
      env: fixture.env,
      positionals: ["list"],
      listSources: fixture.listSources,
      fetchImpl: (async () => Response.json({ monitors: [{ monitorId: "x" }] })) as unknown as typeof fetch,
      json: true,
      stderr: (text) => errors.push(text),
    });
    expect(result).toBe(1);
    expect(JSON.parse(errors.join(""))).toMatchObject({ error: { code: "monitor_invalid" } });
  });
});

async function createFixture(
  baseUrl = "http://127.0.0.1:49123/gui",
  options: { advertiseMonitors?: boolean } = {},
): Promise<{
  cwd: string;
  configPath: string;
  env: Record<string, string>;
  token: string;
  processJobToken: string;
  listSources: (input: { registryDir: string }) => Promise<TraceSourceListResult>;
}> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "mono-monitors-command-")));
  const configPath = join(cwd, "mono-agent.config.json");
  await writeFile(configPath, JSON.stringify({ processJobs: { enabled: true }, monitors: { enabled: true } }));
  const stateDir = join(cwd, ".mono-agent", "process-jobs");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32);
  await writeFile(join(stateDir, "process-jobs-secret"), `${secret.toString("base64url")}\n`, { mode: 0o600 });
  const token = createHmac("sha256", secret).update("mono-agent-monitor-operator-v1").digest("base64url");
  const processJobToken = createHmac("sha256", secret).update("mono-agent-process-job-operator-v1").digest("base64url");
  const registryDir = join(cwd, "registry");
  const source: TraceSourceListItem = {
    schema: "agent-runtime.trace-source.v1",
    sourceId: "fixture-source",
    label: "fixture-agent",
    artifactDir: join(cwd, "artifacts"),
    pid: 1234,
    status: "running",
    health: "running",
    startedAt: "2026-09-03T10:00:00.000Z",
    updatedAt: "2026-09-03T10:00:01.000Z",
    configPath,
    warnings: [],
    metadata: {
      channels: {
        tui: {
          kind: "running",
          baseUrl,
          processJobs: { stateDir },
          ...(options.advertiseMonitors === false
            ? {}
            : { monitors: { maxActive: 8, maxActivePerConversation: 2 } }),
        },
      },
    },
  };
  return {
    cwd,
    configPath,
    env: { MONO_AGENT_TRACE_REGISTRY_DIR: registryDir, MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: registryDir },
    token,
    processJobToken,
    listSources: async (input) => ({ registryDir: input.registryDir, sources: [source], warnings: [] }),
  };
}

function monitor(): MonitorProjection {
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
      lastEventAt: "2026-09-03T10:01:00.000Z",
      completedAt: null,
    },
    limits: { maxRuntimeMs: 3_600_000, coalesceMs: 200, maxBatchLines: 200, maxBatchBytes: 65_536, chainDepth: 0 },
    counters: { seq: 3, batchesDelivered: 3, linesObserved: 9, linesDelivered: 9, droppedLines: 0, pendingLines: 0 },
    exitCode: null,
    signal: null,
    cancelRequested: false,
    lastError: null,
  };
}
