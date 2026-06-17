import { afterEach, describe, expect, it, vi } from "vitest";

import { printAppStatus } from "../cli.js";
import type { ExporterStatus, MonoAgentApp, TraceabilityStatus } from "../app.js";
import type { ChannelId, ChannelStatus } from "../channels.js";

function fakeApp(exporterStatus: ExporterStatus, traceabilityStatus?: TraceabilityStatus): MonoAgentApp {
  return {
    configPath: "/work/demo/mono-agent.config.json",
    traceabilityStatus: traceabilityStatus ?? {
      kind: "running",
      sourceId: "mono-agent-abc",
      registryDir: "/home/u/.mono-agent/trace-sources",
      artifactDir: "/work/demo/.mono-agent/artifacts",
    },
    exporterStatus,
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

function captureStatus(app: MonoAgentApp): string {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write);
  restore = () => spy.mockRestore();
  printAppStatus(app);
  return chunks.join("");
}

describe("printAppStatus exporter line", () => {
  it("prints the configured exporter endpoint, app url, and local-artifacts note", () => {
    const out = captureStatus(
      fakeApp({ kind: "configured", endpoint: "http://127.0.0.1:6006/v1/traces", includeSensitiveData: false }),
    );
    expect(out).toContain("observability");
    expect(out).toContain("http://127.0.0.1:6006/v1/traces");
    expect(out).toContain("app http://127.0.0.1:6006");
    expect(out).toContain("JSONL artifacts remain local at /work/demo/.mono-agent/artifacts");
  });

  it("prints a disabled exporter line when no exporter is configured", () => {
    const out = captureStatus(fakeApp({ kind: "disabled", reason: "No observability exporter configured." }));
    expect(out).toContain("observability");
    expect(out).toContain("disabled: No observability exporter configured.");
  });
});
