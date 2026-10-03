import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecordedRunListItem } from "@mono-agent/observability";

import { printAppStatus } from "../cli.js";
import type { MonoAgentApp, SandboxStatus, TraceabilityStatus } from "../app.js";
import type { ChannelId, ChannelStatus } from "../channels.js";

const OFF_SANDBOX_STATUS: SandboxStatus = {
  configured: false,
  configuredMode: undefined,
  effective: "off",
  engine: undefined,
  engineAvailable: undefined,
  fallback: undefined,
  fallbackActive: false,
  unsafeAllowHostProcess: false,
  detail: "Sandbox is off; commands run without mono-agent sandbox wrapping.",
};

function fakeApp(
  traceabilityStatus?: TraceabilityStatus,
  selectedSkills: readonly string[] = [],
  sandboxStatus: SandboxStatus = OFF_SANDBOX_STATUS,
): MonoAgentApp {
  return {
    configPath: "/work/demo/mono-agent.config.json",
    traceabilityStatus: traceabilityStatus ?? {
      kind: "running",
      sourceId: "mono-agent-abc",
      registryDir: "/home/u/.mono-agent/trace-sources",
      artifactDir: "/work/demo/.mono-agent/artifacts",
    },
    sandboxStatus,
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
    listRecordedRuns: async (options) => {
      expect(options.scope).toBe("agent");
      return { totalRuns, runs, warnings: [] };
    },
  });
  return chunks.join("");
}

describe("printAppStatus", () => {
  it("prints effective sandbox state and unsafe fallback warning", async () => {
    const out = await captureStatus(
      fakeApp(
        undefined,
        [],
        {
          configured: true,
          configuredMode: "native",
          effective: "unsafe-host-process",
          engine: "srt",
          engineAvailable: false,
          fallback: "unsafe-host-process",
          fallbackActive: true,
          unsafeAllowHostProcess: true,
          detail:
            "Sandbox unsafe-host-process fallback is active because engine \"srt\" is unavailable; all sandbox roots/denyWrite entries are inert; commands run unsandboxed.",
          warning:
            "WARNING: Unsafe sandbox fallback is active: all sandbox roots/denyWrite entries are inert; commands run unsandboxed.",
        },
      ),
    );

    expect(out).toContain("sandbox");
    expect(out).toContain("effective: unsafe-host-process");
    expect(out).toContain("engine: srt (absent)");
    expect(out).toContain("fallback active: yes");
    expect(out).toContain("WARNING: Unsafe sandbox fallback is active");
    expect(out).toContain("all sandbox roots/denyWrite entries are inert; commands run unsandboxed");
  });

  it("prints the path-free unsafe ProcessJobs protection warning", async () => {
    const app = {
      ...fakeApp(),
      processJobsProtection: {
        protection: "unsafe-unprotected" as const,
        retainedRoots: true,
        unsafeAllowUnprotectedState: true,
        warning: "UNSAFE: ProcessJobs state and operator secret are model-accessible.",
      },
    };

    const out = await captureStatus(app);

    expect(out).toContain("process jobs protection");
    expect(out).toContain("protection: unsafe-unprotected; retained roots: yes");
    expect(out).toContain("UNSAFE: ProcessJobs state and operator secret are model-accessible.");
    expect(out).not.toContain(".mono-agent/process-jobs");
  });

  it("prints active skills and compact recent runs for foreground status", async () => {
    const out = await captureStatus(
      fakeApp(
        undefined,
        ["context-example", "todoist-cli"],
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
    expect(out).toContain("Active skills: context-example, todoist-cli.");
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
