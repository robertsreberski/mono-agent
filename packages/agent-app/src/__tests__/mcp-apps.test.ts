import { access, mkdir, mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MCP_APP_RESOURCE_MIME_TYPE,
  AgentResponseCancelledError,
  type AgentMessageStream,
  type AgentReplyMcpAppPart,
  type AgentResponder,
} from "@mono-agent/agent-contracts";
import type {
  RuntimeMcpAppConnection,
  RuntimeMcpAppHost,
  RuntimeMcpAppRegistration,
} from "@mono-agent/runtime-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMcpAppService } from "../mcp-apps.js";

const tempDirs: string[] = [];
const stream: AgentMessageStream = { async append() {} };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-mcp-apps-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

function responder(runId: string): AgentResponder {
  return {
    async respond() {
      return { text: "Tool completed", metadata: { runId } };
    },
  };
}

function connection(connectionId: string): RuntimeMcpAppConnection & {
  readResource: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    connectionId,
    readResource: vi.fn(async (uri: string) => ({ contents: [{ uri, text: "resource" }] })),
    callTool: vi.fn(async (name: string, args: unknown) => ({ name, args, ok: true })),
    close: vi.fn(async () => {}),
  };
}

function registration(
  live: RuntimeMcpAppConnection,
  overrides: Partial<RuntimeMcpAppRegistration> = {},
): RuntimeMcpAppRegistration {
  const resourceUri = overrides.resourceUri ?? "ui://widgets/chart";
  return {
    serverName: "widgets",
    toolName: "show_chart",
    title: "Interactive chart",
    description: "A safe chart application",
    toolCallId: "call-1",
    resourceUri,
    protocolVersion: "2026-01-26",
    toolInput: { query: "monthly" },
    toolResult: { content: [{ type: "text", text: "ready" }] },
    resource: {
      uri: resourceUri,
      mimeType: MCP_APP_RESOURCE_MIME_TYPE,
      text: "<!doctype html><html><body>chart</body></html>",
      _meta: { ui: { csp: { connectDomains: [] } } },
    },
    appVisibleTools: ["refresh_chart"],
    connection: live,
    ...overrides,
  };
}

async function hostFor(
  service: ReturnType<typeof createMcpAppService>,
  runId: string,
  conversationId: string,
): Promise<RuntimeMcpAppHost> {
  const extension = await service.createExtension({
    runId,
    request: { conversationId },
    context: {},
  } as never);
  return extension.runtimeOptions?.mcpApps as RuntimeMcpAppHost;
}

describe("MCP Apps registry", () => {
  it("persists isolated instances and authorizes load by conversation and exact connection", async () => {
    const artifactDir = await tempDir();
    const service = createMcpAppService({ artifactDir });
    const firstConnection = connection("connection-one");
    const secondConnection = connection("connection-two");
    const host = await hostFor(service, "run-1", "bucketed-conversation");

    const first = await host.register(registration(firstConnection));
    const second = await host.register(registration(secondConnection, {
      toolCallId: "call-2",
      resourceUri: "ui://widgets/second",
    }));
    expect(first.retainConnection).toBe(true);
    expect(second.retainConnection).toBe(true);

    const wrapped = service.wrapResponder(responder("run-1"));
    const response = await wrapped.respond({
      conversationId: "delivery-conversation",
      text: "show apps",
      abortSignal: new AbortController().signal,
    }, stream);
    const apps = response.parts?.filter((part): part is AgentReplyMcpAppPart => part.type === "mcp_app") ?? [];
    expect(apps).toHaveLength(2);
    expect(new Set(apps.map((part) => part.invocationId)).size).toBe(2);
    expect(apps.map((part) => part.connectionId)).toEqual(["connection-one", "connection-two"]);
    expect(JSON.stringify(apps)).not.toContain("<!doctype");
    expect(JSON.stringify(apps)).not.toContain("monthly");

    const loaded = await wrapped.loadMcpApp?.({
      conversationId: "delivery-conversation",
      invocationId: apps[0]!.invocationId,
      connectionId: apps[0]!.connectionId,
    });
    expect(loaded).toMatchObject({ connected: true, toolInput: { query: "monthly" } });
    expect(loaded?.html).toContain("<body>chart</body>");
    await expect(wrapped.loadMcpApp?.({
      conversationId: "different-conversation",
      invocationId: apps[0]!.invocationId,
      connectionId: apps[0]!.connectionId,
    })).rejects.toMatchObject({ code: "app_forbidden" });
    await expect(wrapped.loadMcpApp?.({
      conversationId: "delivery-conversation",
      invocationId: apps[0]!.invocationId,
      connectionId: apps[1]!.connectionId,
    })).rejects.toMatchObject({ code: "app_forbidden" });
  });

  it("requires confirmation and routes only app-visible operations through the originating connection", async () => {
    const artifactDir = await tempDir();
    const service = createMcpAppService({ artifactDir });
    const live = connection("connection-one");
    const host = await hostFor(service, "run-2", "conversation");
    const registered = await host.register(registration(live));
    const app = registered.part as AgentReplyMcpAppPart;
    const request = {
      conversationId: "conversation",
      invocationId: app.invocationId,
      connectionId: app.connectionId,
    };

    await expect(service.request({
      ...request,
      method: "tools/call",
      params: { name: "refresh_chart", arguments: { range: "week" } },
    })).rejects.toMatchObject({ code: "app_confirmation_required" });
    await expect(service.request({
      ...request,
      method: "tools/call",
      params: { name: "model_only_tool", arguments: {} },
      confirmed: true,
    })).rejects.toMatchObject({ code: "app_tool_forbidden" });
    await expect(service.request({
      ...request,
      method: "tools/call",
      params: { name: "refresh_chart", arguments: { range: "week" } },
      confirmed: true,
    })).resolves.toMatchObject({ ok: true, name: "refresh_chart" });
    expect(live.callTool).toHaveBeenCalledWith("refresh_chart", { range: "week" });

    await expect(service.request({
      ...request,
      method: "resources/read",
      params: { uri: "ui://widgets/data" },
    })).rejects.toMatchObject({ code: "app_resource_forbidden" });
    await expect(service.request({
      ...request,
      method: "resources/read",
      params: { uri: "ui://widgets/chart" },
    })).resolves.toMatchObject({ contents: [{ uri: "ui://widgets/chart" }] });
    expect(live.readResource).toHaveBeenCalledWith("ui://widgets/chart");

    await expect(service.request({
      ...request,
      method: "ui/open-link",
      params: { url: "javascript:alert(1)" },
      confirmed: true,
    })).rejects.toMatchObject({ code: "app_open_link_forbidden" });
    await expect(service.request({
      ...request,
      method: "ui/open-link",
      params: { url: "https://example.com/report" },
      confirmed: true,
    })).resolves.toEqual({ allowed: true, url: "https://example.com/report" });
  });

  it("revalidates connection liveness after refresh and records invalid resources as visible failures", async () => {
    const artifactDir = await tempDir();
    const service = createMcpAppService({ artifactDir });
    const live = connection("connection-one");
    const host = await hostFor(service, "run-3", "conversation");
    const successful = await host.register(registration(live));
    await host.register(registration(live, {
      toolCallId: "invalid-call",
      resource: { mimeType: "text/html", text: "unsafe" },
    }));
    const response = await service.wrapResponder(responder("run-3")).respond({
      conversationId: "conversation",
      text: "show app",
      abortSignal: new AbortController().signal,
    }, stream);
    expect(response.text).toBe("Tool completed");
    expect(response.parts?.map((part) => part.type)).toEqual(["mcp_app", "failure"]);

    const app = successful.part as AgentReplyMcpAppPart;
    const restored = createMcpAppService({ artifactDir });
    await expect(restored.load({
      conversationId: "conversation",
      invocationId: app.invocationId,
      connectionId: app.connectionId,
    })).resolves.toMatchObject({ connected: false });
    await expect(restored.request({
      conversationId: "conversation",
      invocationId: app.invocationId,
      connectionId: app.connectionId,
      method: "resources/read",
      params: { uri: "ui://widgets/data" },
    })).rejects.toMatchObject({ code: "app_connection_closed" });

    await service.dispose();
    expect(live.close).toHaveBeenCalledOnce();
  });

  it("rejects oversized bridge requests before touching the live connection", async () => {
    const artifactDir = await tempDir();
    const service = createMcpAppService({ artifactDir });
    const live = connection("connection-one");
    const host = await hostFor(service, "run-4", "conversation");
    const registered = await host.register(registration(live));
    const app = registered.part as AgentReplyMcpAppPart;

    await expect(service.request({
      conversationId: "conversation",
      invocationId: app.invocationId,
      connectionId: app.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart", arguments: { value: "x".repeat(70 * 1024) } },
      confirmed: true,
    })).rejects.toMatchObject({ code: "app_request_too_large" });
    expect(live.callTool).not.toHaveBeenCalled();
  });

  it("bounds the complete persisted state object rather than only each value", async () => {
    const artifactDir = await tempDir();
    const service = createMcpAppService({ artifactDir });
    const live = connection("connection-state-boundary");
    const host = await hostFor(service, "run-state-boundary", "conversation");
    const registered = await host.register(registration(live, {
      toolInput: "x".repeat((1024 * 1024) / 2),
      toolResult: "y".repeat((1024 * 1024) / 2),
    }));
    const app = registered.part as AgentReplyMcpAppPart;

    expect(registered.retainConnection).toBe(true);
    await expect(service.load({
      conversationId: "conversation",
      invocationId: app.invocationId,
      connectionId: app.connectionId,
    })).resolves.toMatchObject({
      toolInput: { truncated: true },
      toolResult: { truncated: true },
      connected: true,
    });
    await service.dispose();
  });

  it("rejects a manifest that cannot fit its complete persisted byte budget", async () => {
    const artifactDir = await tempDir();
    const service = createMcpAppService({ artifactDir });
    const live = connection("connection-manifest-boundary");
    const host = await hostFor(service, "run-manifest-boundary", "conversation");
    const appVisibleTools = Array.from({ length: 256 }, (_, index) => {
      const prefix = `tool_${String(index)}_`;
      return `${prefix}${"x".repeat(256 - prefix.length)}`;
    });

    await expect(host.register(registration(live, { appVisibleTools }))).resolves.toMatchObject({
      retainConnection: false,
      part: { type: "failure", code: "app_resource_invalid" },
    });
    expect(live.close).not.toHaveBeenCalled();
    await service.dispose();
  });

  it("publishes atomically while cleanup runs and removes only stale staging directories", async () => {
    const artifactDir = await tempDir();
    const entered = deferred();
    const release = deferred();
    const clock = new Date("2026-08-15T12:00:00.000Z");
    const service = createMcpAppService({
      artifactDir,
      now: () => clock,
      stagingGraceMs: 60_000,
      beforePublicationCommit: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const live = connection("connection-atomic");
    const host = await hostFor(service, "run-atomic", "conversation");
    const publishing = host.register(registration(live));
    await entered.promise;

    const root = join(artifactDir, "mcp-apps");
    expect((await readdir(root)).filter((entry) => entry !== ".staging")).toEqual([]);
    const staged = await readdir(join(root, ".staging"));
    expect(staged).toHaveLength(1);
    await service.cleanupExpired();
    await expect(access(join(root, ".staging", staged[0]!))).resolves.toBeUndefined();

    release.resolve();
    const registered = await publishing;
    const app = registered.part as AgentReplyMcpAppPart;
    expect((await readdir(join(root, app.invocationId))).sort()).toEqual([
      "manifest.json",
      "resource.html",
      "state.json",
    ]);
    expect(await readdir(join(root, ".staging"))).toEqual([]);
    await expect(service.load({
      conversationId: "conversation",
      invocationId: app.invocationId,
      connectionId: app.connectionId,
    })).resolves.toMatchObject({ connected: true });

    const stale = "00000000-0000-4000-8000-000000000001";
    const recent = "00000000-0000-4000-8000-000000000002";
    await mkdir(join(root, ".staging", stale));
    await mkdir(join(root, ".staging", recent));
    await utimes(join(root, ".staging", stale), new Date(clock.getTime() - 120_000), new Date(clock.getTime() - 120_000));
    await utimes(join(root, ".staging", recent), clock, clock);
    await service.cleanupExpired();
    await expect(access(join(root, ".staging", stale))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(root, ".staging", recent))).resolves.toBeUndefined();
    await service.dispose();
  });

  it("bounds retained connections with LRU eviction and treats load as a touch", async () => {
    const artifactDir = await tempDir();
    const service = createMcpAppService({ artifactDir, maxRetainedConnections: 2 });
    const first = connection("connection-lru-1");
    const second = connection("connection-lru-2");
    const third = connection("connection-lru-3");
    const host = await hostFor(service, "run-lru", "conversation");
    const app1 = (await host.register(registration(first, { toolCallId: "call-1" }))).part as AgentReplyMcpAppPart;
    const app2 = (await host.register(registration(second, { toolCallId: "call-2", resourceUri: "ui://widgets/two" }))).part as AgentReplyMcpAppPart;
    await service.load({ conversationId: "conversation", invocationId: app1.invocationId, connectionId: app1.connectionId });
    const app3 = (await host.register(registration(third, { toolCallId: "call-3", resourceUri: "ui://widgets/three" }))).part as AgentReplyMcpAppPart;

    expect(first.close).not.toHaveBeenCalled();
    expect(second.close).toHaveBeenCalledOnce();
    expect(third.close).not.toHaveBeenCalled();
    await expect(service.load({ conversationId: "conversation", invocationId: app1.invocationId, connectionId: app1.connectionId }))
      .resolves.toMatchObject({ connected: true });
    await expect(service.load({ conversationId: "conversation", invocationId: app2.invocationId, connectionId: app2.connectionId }))
      .resolves.toMatchObject({ connected: false });
    await expect(service.load({ conversationId: "conversation", invocationId: app3.invocationId, connectionId: app3.connectionId }))
      .resolves.toMatchObject({ connected: true });
    await service.dispose();
    expect(first.close).toHaveBeenCalledOnce();
    expect(third.close).toHaveBeenCalledOnce();
  });

  it("evicts idle connections, refreshes idle age on use, and degrades through connected false", async () => {
    const artifactDir = await tempDir();
    let time = new Date("2026-08-15T12:00:00.000Z");
    const service = createMcpAppService({
      artifactDir,
      connectionIdleMs: 1_000,
      now: () => time,
    });
    const live = connection("connection-idle");
    const host = await hostFor(service, "run-idle", "conversation");
    const app = (await host.register(registration(live))).part as AgentReplyMcpAppPart;

    time = new Date(time.getTime() + 500);
    await service.load({ conversationId: "conversation", invocationId: app.invocationId, connectionId: app.connectionId });
    time = new Date(time.getTime() + 900);
    await service.cleanupExpired();
    expect(live.close).not.toHaveBeenCalled();
    time = new Date(time.getTime() + 101);
    await service.cleanupExpired();
    expect(live.close).toHaveBeenCalledOnce();
    await expect(service.load({ conversationId: "conversation", invocationId: app.invocationId, connectionId: app.connectionId }))
      .resolves.toMatchObject({ connected: false });
    await service.dispose();
  });

  it("rate-limits each connection with a stable error and rotates bounded audit files", async () => {
    const artifactDir = await tempDir();
    let time = new Date("2026-08-15T12:00:00.000Z");
    const service = createMcpAppService({
      artifactDir,
      now: () => time,
      bridgeRateLimit: 3,
      bridgeRateWindowMs: 1_000,
      auditMaxBytes: 1_024,
      auditRetainedFiles: 2,
    });
    const live = connection("connection-rate");
    const host = await hostFor(service, "run-rate", "conversation");
    const app = (await host.register(registration(live))).part as AgentReplyMcpAppPart;
    const identity = {
      conversationId: "conversation",
      invocationId: app.invocationId,
      connectionId: app.connectionId,
    };

    for (let index = 0; index < 3; index += 1) {
      await service.request({
        ...identity,
        method: "ui/open-link",
        params: { url: `https://example.com/${"x".repeat(300)}${String(index)}` },
        confirmed: true,
      });
    }
    await expect(service.request({
      ...identity,
      method: "ui/open-link",
      params: { url: "https://example.com/limited" },
      confirmed: true,
    })).rejects.toMatchObject({ code: "app_rate_limited" });

    const directory = join(artifactDir, "mcp-apps", app.invocationId);
    const auditFiles = (await readdir(directory)).filter((name) => /^audit(?:\.\d+)?\.jsonl$/u.test(name));
    expect(auditFiles.length).toBeGreaterThan(1);
    expect(auditFiles.length).toBeLessThanOrEqual(3);
    for (const file of auditFiles) expect((await stat(join(directory, file))).size).toBeLessThanOrEqual(1_024);

    time = new Date(time.getTime() + 1_000);
    await expect(service.request({
      ...identity,
      method: "resources/read",
      params: { uri: app.resourceUri },
    })).resolves.toMatchObject({ contents: [{ uri: app.resourceUri }] });
    await service.dispose();
  });

  it("supports both shipped protocol revisions with an explicit intersection", async () => {
    const artifactDir = await tempDir();
    const service = createMcpAppService({ artifactDir });
    const live = connection("connection-legacy");
    const host = await hostFor(service, "run-legacy", "conversation");
    expect(host.protocolVersions).toEqual(["2026-01-26", "2025-11-21"]);
    const registered = await host.register(registration(live, { protocolVersion: "2025-11-21" }));
    expect(registered.part).toMatchObject({ type: "mcp_app", protocolVersion: "2025-11-21" });
    await service.dispose();
  });

  it("deduplicates retries, enforces the exact part boundary, and gives repeated failures unique stable ids", async () => {
    const artifactDir = await tempDir();
    const service = createMcpAppService({ artifactDir });
    const live = connection("connection-parts");
    const host = await hostFor(service, "run-parts", "conversation");
    const original = await host.register(registration(live));
    const retried = await host.register(registration(live));
    expect(retried).toEqual({ part: original.part, retainConnection: false });

    const firstFailure = await host.recordFailure({
      serverName: "widgets",
      toolName: "show_chart",
      toolCallId: "same-call",
      code: "app_resource_invalid",
      message: "first failure",
    });
    const repeatedFailure = await host.recordFailure({
      serverName: "widgets",
      toolName: "show_chart",
      toolCallId: "same-call",
      code: "app_resource_invalid",
      message: "first failure",
    });
    const secondFailure = await host.recordFailure({
      serverName: "widgets",
      toolName: "show_chart",
      toolCallId: "same-call",
      code: "app_resource_invalid",
      message: "second failure",
    });
    expect(repeatedFailure.id).toBe(firstFailure.id);
    expect(secondFailure.id).not.toBe(firstFailure.id);

    for (let index = 3; index < 20; index += 1) {
      await host.register(registration(live, {
        toolCallId: `call-${String(index)}`,
        resourceUri: `ui://widgets/${String(index)}`,
      }));
    }
    const overCap = await host.register(registration(live, {
      toolCallId: "call-over-cap",
      resourceUri: "ui://widgets/over-cap",
    }));
    expect(overCap).toMatchObject({
      retainConnection: false,
      part: { type: "failure", code: "app_capability_mismatch" },
    });
    const response = await service.wrapResponder(responder("run-parts")).respond({
      conversationId: "conversation",
      text: "show apps",
      abortSignal: new AbortController().signal,
    }, stream);
    expect(response.parts).toHaveLength(20);
    expect(new Set(response.parts?.map((part) => part.id)).size).toBe(20);
    await service.dispose();
  });

  it.each(["throw", "cancel", "missing metadata"] as const)(
    "releases run state, files, and retained clients on terminal %s",
    async (terminal) => {
      const artifactDir = await tempDir();
      const service = createMcpAppService({ artifactDir });
      const live = connection(`connection-${terminal}`);
      const base: AgentResponder = {
        async respond(request) {
          const extension = await service.createExtension({ runId: "run-terminal", request, context: {} } as never);
          const host = extension.runtimeOptions?.mcpApps as RuntimeMcpAppHost;
          await host.register(registration(live));
          await extension.settleCleanup?.();
          if (terminal === "throw") throw new Error("responder failed");
          if (terminal === "cancel") throw new AgentResponseCancelledError("cancelled");
          return { text: "no run metadata" };
        },
      };
      const wrapped = service.wrapResponder(base);
      const request = {
        conversationId: "conversation",
        text: "show app",
        abortSignal: new AbortController().signal,
      };
      if (terminal === "missing metadata") await wrapped.respond(request, stream);
      else await expect(wrapped.respond(request, stream)).rejects.toThrow();

      const entries = await readdir(join(artifactDir, "mcp-apps"));
      expect(entries.filter((entry) => /^[0-9a-f]{8}-/u.test(entry))).toEqual([]);
      expect(live.close).toHaveBeenCalledOnce();
      await service.dispose();
    },
  );

  it("keeps a settled in-request publication when the responder returns matching run metadata", async () => {
    const artifactDir = await tempDir();
    const service = createMcpAppService({ artifactDir });
    const live = connection("connection-retained");
    const base: AgentResponder = {
      async respond(request) {
        const extension = await service.createExtension({ runId: "run-retained", request, context: {} } as never);
        const host = extension.runtimeOptions?.mcpApps as RuntimeMcpAppHost;
        await host.register(registration(live));
        await extension.settleCleanup?.();
        return { text: "done", metadata: { runId: "run-retained" } };
      },
    };
    const response = await service.wrapResponder(base).respond({
      conversationId: "conversation",
      text: "show app",
      abortSignal: new AbortController().signal,
    }, stream);
    const app = response.parts?.[0] as AgentReplyMcpAppPart;
    await expect(access(join(artifactDir, "mcp-apps", app.invocationId, "manifest.json")))
      .resolves.toBeUndefined();
    expect(live.close).not.toHaveBeenCalled();
    await service.dispose();
  });
});
