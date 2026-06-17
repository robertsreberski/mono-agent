import { describe, expect, it, vi } from "vitest";
import type {
  PhoenixExporterConfig,
  RunExportContext,
  RunExportEventContext,
  RunSummary,
} from "@mono-agent/observability";

import { createPhoenixRunExporter } from "../phoenix-exporter.js";

const summary: RunSummary = {
  runId: "run-1",
  conversationId: "conv-1",
  status: "succeeded",
  durationMs: 100,
  eventCount: 1,
  artifactPaths: [],
};

const baseCtx: RunExportContext = {
  runId: "run-1",
  conversationId: "conv-1",
  sourceId: "src-1",
  includeSensitiveData: false,
};

function eventCtx(index: number, ctx: RunExportContext = baseCtx): RunExportEventContext {
  return { ...ctx, eventIndex: index };
}

function fakeIdFactory(): { traceId(): Uint8Array; spanId(): Uint8Array } {
  let n = 0;
  return {
    traceId: () => new Uint8Array(16).fill(7),
    spanId: () => {
      n += 1;
      return new Uint8Array(8).fill(n);
    },
  };
}

function capturingFetch(): {
  fetch: typeof fetch;
  bodies: () => unknown[];
  count: () => number;
  url: () => string | undefined;
} {
  const bodies: unknown[] = [];
  let lastUrl: string | undefined;
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    lastUrl = String(url);
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 200 });
  });
  return {
    fetch: impl as unknown as typeof fetch,
    bodies: () => bodies,
    count: () => impl.mock.calls.length,
    url: () => lastUrl,
  };
}

describe("createPhoenixRunExporter", () => {
  it("finish posts exactly one request to the configured endpoint", async () => {
    const cap = capturingFetch();
    const config: PhoenixExporterConfig = {
      type: "phoenix",
      endpoint: "http://127.0.0.1:6006/v1/traces",
    };
    const exporter = createPhoenixRunExporter(config, {
      fetch: cap.fetch,
      now: () => 1000,
      idFactory: fakeIdFactory(),
    });

    await exporter.start?.(baseCtx);
    await exporter.onEvent?.({ type: "tool_call", name: "Read" }, eventCtx(0));
    await exporter.finish?.(summary, baseCtx);

    expect(cap.count()).toBe(1);
    expect(cap.url()).toBe("http://127.0.0.1:6006/v1/traces");
  });

  it("uses the default Phoenix endpoint when none is configured", async () => {
    const cap = capturingFetch();
    const exporter = createPhoenixRunExporter(
      { type: "phoenix" },
      { fetch: cap.fetch, now: () => 1, idFactory: fakeIdFactory() },
    );
    await exporter.finish?.(summary, baseCtx);
    expect(cap.url()).toBe("http://127.0.0.1:6006/v1/traces");
  });

  it("is metadata-only by default: no raw payload in the posted body", async () => {
    const cap = capturingFetch();
    const exporter = createPhoenixRunExporter(
      { type: "phoenix" },
      { fetch: cap.fetch, now: () => 1, idFactory: fakeIdFactory() },
    );
    await exporter.onEvent?.(
      { type: "tool_call", name: "Read", input: { apiKey: "sk-supersecret-value" } },
      eventCtx(0),
    );
    await exporter.finish?.(summary, baseCtx);
    const body = JSON.stringify(cap.bodies()[0]);
    expect(body).not.toContain("sk-supersecret-value");
  });

  it("includeSensitiveData=true includes a redacted payload (apiKey -> [redacted])", async () => {
    const cap = capturingFetch();
    const ctx: RunExportContext = { ...baseCtx, includeSensitiveData: true };
    const exporter = createPhoenixRunExporter(
      { type: "phoenix", includeSensitiveData: true },
      { fetch: cap.fetch, now: () => 1, idFactory: fakeIdFactory() },
    );
    await exporter.onEvent?.(
      { type: "tool_call", name: "Read", input: { apiKey: "sk-supersecret-value" } },
      eventCtx(0, ctx),
    );
    await exporter.finish?.(summary, ctx);
    const body = JSON.stringify(cap.bodies()[0]);
    expect(body).not.toContain("sk-supersecret-value");
    expect(body).toContain("[redacted]");
  });

  it("rejects when fetch rejects so the COMPOSITE can swallow the error", async () => {
    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    const exporter = createPhoenixRunExporter(
      { type: "phoenix" },
      { fetch: failing as unknown as typeof fetch, now: () => 1, idFactory: fakeIdFactory() },
    );
    await expect(exporter.finish?.(summary, baseCtx)).rejects.toThrow(/network down/u);
  });

  it("rejects when the collector returns a non-2xx status", async () => {
    const bad = vi.fn(async () => new Response("nope", { status: 500 }));
    const exporter = createPhoenixRunExporter(
      { type: "phoenix" },
      { fetch: bad as unknown as typeof fetch, now: () => 1, idFactory: fakeIdFactory() },
    );
    await expect(exporter.finish?.(summary, baseCtx)).rejects.toThrow(/500/u);
  });

  it("fail posts a request with an ERROR root span status", async () => {
    const cap = capturingFetch();
    const exporter = createPhoenixRunExporter(
      { type: "phoenix" },
      { fetch: cap.fetch, now: () => 1, idFactory: fakeIdFactory() },
    );
    const failed: RunSummary = { ...summary, status: "failed", failureKind: "boom" };
    await exporter.fail?.(failed, new Error("boom"), baseCtx);
    expect(cap.count()).toBe(1);
    const body = cap.bodies()[0] as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ status?: { code?: number } }> }> }>;
    };
    const root = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(root.status?.code).toBe(2);
  });
});
