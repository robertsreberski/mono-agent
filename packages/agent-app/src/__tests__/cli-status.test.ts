import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecordedRunListItem } from "@mono-agent/observability";

import { printAppStatus } from "../cli.js";
import type { ExporterStatus, MonoAgentApp, TraceabilityStatus } from "../app.js";
import type { ChannelId, ChannelStatus } from "../channels.js";

function fakeApp(
  exporterStatus: ExporterStatus,
  traceabilityStatus?: TraceabilityStatus,
  selectedSkills: readonly string[] = [],
): MonoAgentApp {
  return {
    configPath: "/work/demo/mono-agent.config.json",
    traceabilityStatus: traceabilityStatus ?? {
      kind: "running",
      sourceId: "mono-agent-abc",
      registryDir: "/home/u/.mono-agent/trace-sources",
      artifactDir: "/work/demo/.mono-agent/artifacts",
    },
    exporterStatus,
    selectedSkills,
    channelStatus: () => ({ kind: "disabled", reason: "n/a" }),
    channelStatuses: () => new Map<ChannelId, ChannelStatus>(),
    startChannelIfConfigured: async () => ({ kind: "disabled", reason: "n/a" }),
    applyConfigChange: async () => ({ kind: "applied", message: "ok", transports: [] }),
    stop: async () => undefined,
  };
}

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

async function captureStatus(
  app: MonoAgentApp,
  runs: readonly RecordedRunListItem[] = [],
  totalRuns = runs.length,
): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write);
  restore = () => spy.mockRestore();
  await printAppStatus(app, {
    nowMs: Date.parse("2026-06-24T08:00:00.000Z"),
    listRecordedRuns: async () => ({ totalRuns, runs, warnings: [] }),
  });
  return chunks.join("");
}

describe("printAppStatus exporter line", () => {
  it("prints the configured exporter endpoint, app url, and local-artifacts note", async () => {
    const out = await captureStatus(
      fakeApp({ kind: "configured", endpoint: "http://127.0.0.1:6006/v1/traces", includeSensitiveData: false }),
    );
    expect(out).toContain("observability");
    expect(out).toContain("http://127.0.0.1:6006/v1/traces");
    expect(out).toContain("app http://127.0.0.1:6006");
    expect(out).toContain("JSONL artifacts remain local at /work/demo/.mono-agent/artifacts");
    expect(out).not.toContain("[WARN] includeSensitiveData=true");
  });

  it("prints a warning when sensitive data export is enabled", async () => {
    const endpoint = "http://127.0.0.1:6006/v1/traces";
    const out = await captureStatus(
      fakeApp({ kind: "configured", endpoint, includeSensitiveData: true }),
    );
    expect(out).toContain("[WARN] includeSensitiveData=true");
    expect(out).toContain(endpoint);
    expect(out).toContain("user input");
    expect(out).toContain("assistant replies");
    expect(out).toContain("tool args/results");
    expect(out).toContain("system prompt");
  });

  it("prints a disabled exporter line when no exporter is configured", async () => {
    const out = await captureStatus(fakeApp({ kind: "disabled", reason: "No observability exporter configured." }));
    expect(out).toContain("observability");
    expect(out).toContain("disabled: No observability exporter configured.");
  });

  it("prints active skills and compact recent runs for foreground status", async () => {
    const out = await captureStatus(
      fakeApp(
        { kind: "configured", endpoint: "http://127.0.0.1:6006/v1/traces", includeSensitiveData: false },
        undefined,
        ["context-a8c", "todoist-cli"],
      ),
      [
        makeRun({
          runId: "run-usage",
          status: "failed",
          failureKind: "usage_limit",
          updatedAt: "2026-06-24T07:55:00.000Z",
        }),
        makeRun({
          runId: "run-ok",
          status: "succeeded",
          updatedAt: "2026-06-24T07:58:30.000Z",
        }),
      ],
      12,
    );

    expect(out).toContain("runs health");
    expect(out).toContain("Active skills: context-a8c, todoist-cli.");
    expect(out).toContain("Recorded runs: 12 total; showing 2 recent (max 50).");
    expect(out).toContain("Last runs: run-usage failed 5m ago, run-ok succeeded 1m ago.");
    expect(out).toContain("[WARN] Failure kinds: usage_limit=1.");
  });
});

function makeRun(overrides: Partial<RecordedRunListItem>): RecordedRunListItem {
  return {
    runId: "run",
    conversationId: "chat",
    status: "succeeded",
    durationMs: 1000,
    eventCount: 1,
    updatedAt: "2026-06-24T08:00:00.000Z",
    ...overrides,
  };
}
