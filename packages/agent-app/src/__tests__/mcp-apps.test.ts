import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
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

import {
  createMcpAppService,
  DEFAULT_MCP_APP_AUDIT_STORAGE_MAX_BYTES,
} from "../mcp-apps.js";
import {
  DEFAULT_REPLY_ARTIFACT_STORAGE_MAX_BYTES,
  replyArtifactStorageBudgetFor,
} from "../reply-artifacts.js";

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

async function padJsonFileToLimit(path: string, maxBytes: number): Promise<void> {
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  let low = 0;
  let high = maxBytes;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const serialized = `${JSON.stringify({ ...value, padding: "x".repeat(middle) })}\n`;
    if (Buffer.byteLength(serialized, "utf8") <= maxBytes) {
      best = serialized;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best.length === 0) throw new Error("Test manifest could not be padded to its byte boundary.");
  await writeFile(path, best, "utf8");
}

async function treeFileBytes(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  let total = 0;
  for (const entry of entries) {
    const path = join(root, entry.name);
    total += entry.isDirectory() && !entry.isSymbolicLink()
      ? await treeFileBytes(path)
      : (await stat(path)).size;
  }
  return total;
}

function fileSystemError(code: "EACCES" | "EPERM"): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code });
}

async function auditContents(directory: string): Promise<string> {
  return (await Promise.all((await readdir(directory))
    .filter((name) => /^audit(?:\.[1-9][0-9]*)?\.jsonl$/u.test(name))
    .map(async (name) => await readFile(join(directory, name), "utf8"))))
    .join("\n");
}

async function auditFileBytes(directory: string): Promise<number> {
  const sizes = await Promise.all((await readdir(directory))
    .filter((name) => /^audit(?:\.[1-9][0-9]*)?\.jsonl$/u.test(name))
    .map(async (name) => (await stat(join(directory, name))).size));
  return sizes.reduce((sum, size) => sum + size, 0);
}

function confirmedToolCall(app: AgentReplyMcpAppPart) {
  return {
    conversationId: "conversation",
    invocationId: app.invocationId,
    connectionId: app.connectionId,
    method: "tools/call" as const,
    params: { name: "refresh_chart" },
    confirmed: true,
  };
}

async function auditSentinels(
  directory: string,
  rotationName = "audit.5.jsonl",
): Promise<{
  readonly activePath: string;
  readonly rotationPath: string;
  assertUnchanged(): Promise<void>;
}> {
  const activePath = join(directory, "audit.jsonl");
  const rotationPath = join(directory, rotationName);
  const active = Buffer.from("outside active audit must stay byte-identical\n");
  const rotation = Buffer.from("outside rotated audit must stay byte-identical\n");
  await Promise.all([
    writeFile(activePath, active),
    writeFile(rotationPath, rotation),
  ]);
  return {
    activePath,
    rotationPath,
    async assertUnchanged() {
      await expect(readFile(activePath)).resolves.toEqual(active);
      await expect(readFile(rotationPath)).resolves.toEqual(rotation);
    },
  };
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

  it("turns only a delivery-binding overflow into a bounded failure and preserves text plus good apps", async () => {
    const artifactDir = await tempDir();
    const service = createMcpAppService({ artifactDir });
    const badConnection = connection("connection-binding-bad");
    const goodConnection = connection("connection-binding-good");
    const host = await hostFor(service, "run-binding", "origin");
    const bad = await host.register(registration(badConnection, {
      toolCallId: "call-binding-bad",
      resourceUri: "ui://widgets/bad",
    }));
    const good = await host.register(registration(goodConnection, {
      toolCallId: "call-binding-good",
      resourceUri: "ui://widgets/good",
    }));
    const badApp = bad.part as AgentReplyMcpAppPart;
    const goodApp = good.part as AgentReplyMcpAppPart;
    await padJsonFileToLimit(
      join(artifactDir, "mcp-apps", badApp.invocationId, "manifest.json"),
      64 * 1024,
    );

    const response = await service.wrapResponder(responder("run-binding")).respond({
      conversationId: "delivery",
      text: "show apps",
      abortSignal: new AbortController().signal,
    }, stream);

    expect(response.text).toBe("Tool completed");
    expect(response.parts).toEqual([
      expect.objectContaining({
        type: "failure",
        code: "app_resource_invalid",
        relatedPartId: badApp.id,
        message: "The MCP App could not be finalized for delivery.",
      }),
      expect.objectContaining({ type: "mcp_app", id: goodApp.id }),
    ]);
    expect(Buffer.byteLength(JSON.stringify(response.parts?.[0]), "utf8")).toBeLessThan(1_024);
    expect(JSON.stringify(response.parts)).not.toContain("padding");
    await expect(access(join(artifactDir, "mcp-apps", badApp.invocationId))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(artifactDir, "mcp-apps", goodApp.invocationId, "manifest.json")))
      .resolves.toBeUndefined();
    expect(badConnection.close).toHaveBeenCalledOnce();
    expect(goodConnection.close).not.toHaveBeenCalled();
    await service.dispose();
    expect(goodConnection.close).toHaveBeenCalledOnce();
  });

  it("fails closed with an explicit part when aggregate reply-artifact storage is full", async () => {
    const artifactDir = await tempDir();
    const storageBudget = replyArtifactStorageBudgetFor(artifactDir, 128);
    const service = createMcpAppService({ artifactDir, storageBudget });
    const live = connection("connection-storage-full");
    const host = await hostFor(service, "run-storage-full", "conversation");

    const registered = await host.register(registration(live));

    expect(registered).toMatchObject({
      retainConnection: false,
      part: {
        type: "failure",
        code: "app_resource_invalid",
        message: "Reply artifact storage is full; this MCP App was not retained.",
      },
    });
    expect(live.close).not.toHaveBeenCalled();
    expect((await readdir(join(artifactDir, "mcp-apps"))).filter((entry) => /^[0-9a-f]{8}-/u.test(entry)))
      .toEqual([]);
    await service.dispose();
  });

  it("normalizes and safely bounds app display text without bidi controls or split code points", async () => {
    const artifactDir = await tempDir();
    const service = createMcpAppService({ artifactDir });
    const live = connection("connection-display");
    const host = await hostFor(service, "run-display", "conversation");

    const registered = await host.register(registration(live, {
      title: `Cafe\u0301\u202e\u2066-${"😀".repeat(80)}`,
      description: "Harmless description",
    }));
    const app = registered.part as AgentReplyMcpAppPart;

    expect(app.title?.startsWith("Café-")).toBe(true);
    expect(app.title).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    expect(app.title).not.toContain("�");
    expect(Buffer.byteLength(app.title!, "utf8")).toBeLessThanOrEqual(240);
    expect(app.description).toBe("Harmless description");
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

  it("does not expire committed current-run app state before responder finalization", async () => {
    const artifactDir = await tempDir();
    let clock = new Date("2026-08-15T12:00:00.000Z");
    const storageBudget = replyArtifactStorageBudgetFor(
      artifactDir,
      DEFAULT_REPLY_ARTIFACT_STORAGE_MAX_BYTES - DEFAULT_MCP_APP_AUDIT_STORAGE_MAX_BYTES,
    );
    const publishingService = createMcpAppService({
      artifactDir,
      storageBudget,
      retentionDays: 1,
      now: () => clock,
    });
    const cleanupService = createMcpAppService({
      artifactDir,
      storageBudget,
      retentionDays: 1,
      now: () => clock,
    });
    const live = connection("connection-current-run");
    const host = await hostFor(publishingService, "run-current", "conversation");
    const app = (await host.register(registration(live))).part as AgentReplyMcpAppPart;
    const directory = join(artifactDir, "mcp-apps", app.invocationId);

    clock = new Date("2026-08-17T12:00:00.000Z");
    await cleanupService.cleanupExpired();
    await expect(access(directory)).resolves.toBeUndefined();

    const response = await publishingService.wrapResponder(responder("run-current")).respond({
      conversationId: "conversation",
      text: "show app",
      abortSignal: new AbortController().signal,
    }, stream);
    expect(response.parts).toEqual([expect.objectContaining({ type: "mcp_app", id: app.id })]);
    await cleanupService.cleanupExpired();
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await publishingService.dispose();
    await cleanupService.dispose();
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

    time = new Date(time.getTime() + 1_000);
    await expect(service.request({
      ...identity,
      method: "resources/read",
      params: { uri: app.resourceUri },
    })).resolves.toMatchObject({ contents: [{ uri: app.resourceUri }] });
    for (let index = 0; index < 2; index += 1) {
      await service.request({
        ...identity,
        method: "ui/open-link",
        params: { url: `https://example.com/next-${String(index)}` },
        confirmed: true,
      });
    }

    const directory = join(artifactDir, "mcp-apps", app.invocationId);
    const auditFiles = (await readdir(directory)).filter((name) => /^audit(?:\.\d+)?\.jsonl$/u.test(name));
    expect(auditFiles.length).toBeGreaterThan(1);
    expect(auditFiles.length).toBeLessThanOrEqual(3);
    for (const file of auditFiles) expect((await stat(join(directory, file))).size).toBeLessThanOrEqual(1_024);

    await service.dispose();
  });

  it("keeps audited tool actions usable and physically bounded after model-visible storage is full", async () => {
    const artifactDir = await tempDir();
    const contentStorageMaxBytes = 8 * 1024;
    const auditMaxBytes = 1_024;
    const auditRetainedFiles = 2;
    const auditStorageMaxBytes = auditMaxBytes * (auditRetainedFiles + 1);
    const storageBudget = replyArtifactStorageBudgetFor(artifactDir, contentStorageMaxBytes);
    const service = createMcpAppService({
      artifactDir,
      storageBudget,
      auditMaxBytes,
      auditRetainedFiles,
      auditStorageMaxBytes,
    });
    const live = connection("connection-audit-reserve");
    const host = await hostFor(service, "run-audit-reserve", "conversation");
    const registered = await host.register(registration(live));
    expect(registered).toMatchObject({ retainConnection: true, part: { type: "mcp_app" } });
    const app = registered.part as AgentReplyMcpAppPart;
    const bytesBeforeFill = await treeFileBytes(artifactDir);
    expect(bytesBeforeFill).toBeGreaterThan(0);
    expect(bytesBeforeFill).toBeLessThan(contentStorageMaxBytes);
    const fillerDirectory = join(artifactDir, "reply-files", "model-visible-fill");
    await mkdir(fillerDirectory, { recursive: true });
    await writeFile(
      join(fillerDirectory, "content"),
      Buffer.alloc(contentStorageMaxBytes - bytesBeforeFill, 0x78),
    );
    expect(await treeFileBytes(artifactDir)).toBe(contentStorageMaxBytes);
    await expect(storageBudget.reserve(1)).resolves.toBeUndefined();

    const identity = {
      conversationId: "conversation",
      invocationId: app.invocationId,
      connectionId: app.connectionId,
    };
    for (let index = 0; index < 6; index += 1) {
      await expect(service.request({
        ...identity,
        method: "tools/call",
        params: { name: "refresh_chart", arguments: { index } },
        confirmed: true,
      })).resolves.toMatchObject({ ok: true, name: "refresh_chart" });
    }
    expect(live.callTool).toHaveBeenCalledTimes(6);
    await expect(storageBudget.reserve(1)).resolves.toBeUndefined();

    const directory = join(artifactDir, "mcp-apps", app.invocationId);
    const auditFiles = (await readdir(directory)).filter((name) => /^audit(?:\.[1-9][0-9]*)?\.jsonl$/u.test(name));
    expect(auditFiles.length).toBeGreaterThan(1);
    expect(auditFiles.length).toBeLessThanOrEqual(auditRetainedFiles + 1);
    let auditBytes = 0;
    const records: Array<{ readonly details?: { readonly phase?: string } }> = [];
    for (const file of auditFiles) {
      const filePath = join(directory, file);
      const fileBytes = (await stat(filePath)).size;
      auditBytes += fileBytes;
      expect(fileBytes).toBeLessThanOrEqual(auditMaxBytes);
      records.push(...(await readFile(filePath, "utf8")).trim().split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { details?: { phase?: string } }));
    }
    expect(auditBytes).toBeLessThanOrEqual(auditStorageMaxBytes);
    expect(records.some((record) => record.details?.phase === "confirmed")).toBe(true);
    expect(records.some((record) => record.details?.phase === "completed")).toBe(true);
    expect(await treeFileBytes(artifactDir)).toBeLessThanOrEqual(
      contentStorageMaxBytes + auditStorageMaxBytes,
    );
    await service.dispose();
  });

  it("reclaims the oldest cross-app audit files without starving active app actions", async () => {
    const artifactDir = await tempDir();
    const auditMaxBytes = 1_024;
    const auditRetainedFiles = 2;
    const auditStorageMaxBytes = 4 * auditMaxBytes;
    const service = createMcpAppService({
      artifactDir,
      auditMaxBytes,
      auditRetainedFiles,
      auditStorageMaxBytes,
    });
    const apps = await Promise.all(["a", "b", "c"].map(async (suffix) => {
      const live = connection(`connection-audit-${suffix}`);
      const host = await hostFor(service, `run-audit-${suffix}`, "conversation");
      const registered = await host.register(registration(live, {
        toolCallId: `call-audit-${suffix}`,
        resourceUri: `ui://widgets/audit-${suffix}`,
      }));
      return { live, app: registered.part as AgentReplyMcpAppPart };
    }));

    const rounds = 20;
    for (let index = 0; index < rounds; index += 1) {
      for (const { app } of apps) {
        await expect(service.request({
          conversationId: "conversation",
          invocationId: app.invocationId,
          connectionId: app.connectionId,
          method: "tools/call",
          params: { name: "refresh_chart", arguments: { index } },
          confirmed: true,
        })).resolves.toMatchObject({ ok: true, name: "refresh_chart" });
      }
    }
    for (const { live } of apps) expect(live.callTool).toHaveBeenCalledTimes(rounds);

    let totalAuditBytes = 0;
    let retainedRecordCount = 0;
    for (const { app } of apps) {
      const directory = join(artifactDir, "mcp-apps", app.invocationId);
      const auditFiles = (await readdir(directory))
        .filter((name) => /^audit(?:\.[1-9][0-9]*)?\.jsonl$/u.test(name));
      expect(auditFiles.length).toBeLessThanOrEqual(auditRetainedFiles + 1);
      const records: Array<{
        readonly invocationId?: string;
        readonly details?: { readonly phase?: string };
      }> = [];
      for (const file of auditFiles) {
        const filePath = join(directory, file);
        const fileBytes = (await stat(filePath)).size;
        totalAuditBytes += fileBytes;
        expect(fileBytes).toBeLessThanOrEqual(auditMaxBytes);
        records.push(...(await readFile(filePath, "utf8")).trim().split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as {
            invocationId?: string;
            details?: { phase?: string };
          }));
      }
      retainedRecordCount += records.length;
      expect(records.some((record) => (
        record.invocationId === app.invocationId && record.details?.phase === "confirmed"
      ))).toBe(true);
      expect(records.some((record) => (
        record.invocationId === app.invocationId && record.details?.phase === "completed"
      ))).toBe(true);
    }
    expect(retainedRecordCount).toBeLessThan(apps.length * rounds * 2);
    expect(totalAuditBytes).toBeLessThanOrEqual(auditStorageMaxBytes);
    await service.dispose();
  });

  it("reclaims noisy-app history before erasing a quiet app audit trail", async () => {
    const artifactDir = await tempDir();
    const auditMaxBytes = 1_024;
    const auditRetainedFiles = 2;
    const auditStorageMaxBytes = auditMaxBytes * (auditRetainedFiles + 1);
    const service = createMcpAppService({
      artifactDir,
      auditMaxBytes,
      auditRetainedFiles,
      auditStorageMaxBytes,
    });
    const quietLive = connection("connection-audit-quiet");
    const quietHost = await hostFor(service, "run-audit-quiet", "conversation");
    const quietApp = (await quietHost.register(registration(quietLive, {
      toolCallId: "call-audit-quiet",
      resourceUri: "ui://widgets/audit-quiet",
    }))).part as AgentReplyMcpAppPart;
    const noisyLive = connection("connection-audit-noisy");
    const noisyHost = await hostFor(service, "run-audit-noisy", "conversation");
    const noisyApp = (await noisyHost.register(registration(noisyLive, {
      toolCallId: "call-audit-noisy",
      resourceUri: "ui://widgets/audit-noisy",
    }))).part as AgentReplyMcpAppPart;
    const requestTool = async (app: AgentReplyMcpAppPart, index: number) => await service.request({
      conversationId: "conversation",
      invocationId: app.invocationId,
      connectionId: app.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart", arguments: { index } },
      confirmed: true,
    });

    for (let index = 0; index < 3; index += 1) await requestTool(quietApp, index);
    for (let index = 0; index < 20; index += 1) await requestTool(noisyApp, index);
    expect(quietLive.callTool).toHaveBeenCalledTimes(3);
    expect(noisyLive.callTool).toHaveBeenCalledTimes(20);

    let aggregateAuditBytes = 0;
    for (const app of [quietApp, noisyApp]) {
      const directory = join(artifactDir, "mcp-apps", app.invocationId);
      const files = (await readdir(directory))
        .filter((name) => /^audit(?:\.[1-9][0-9]*)?\.jsonl$/u.test(name));
      expect(files.length).toBeLessThanOrEqual(auditRetainedFiles + 1);
      for (const file of files) {
        const bytes = (await stat(join(directory, file))).size;
        aggregateAuditBytes += bytes;
        expect(bytes).toBeLessThanOrEqual(auditMaxBytes);
      }
    }
    const quietDirectory = join(artifactDir, "mcp-apps", quietApp.invocationId);
    const quietRecords = (await Promise.all((await readdir(quietDirectory))
      .filter((name) => /^audit(?:\.[1-9][0-9]*)?\.jsonl$/u.test(name))
      .map(async (name) => await readFile(join(quietDirectory, name), "utf8"))))
      .flatMap((contents) => contents.trim().split("\n").filter(Boolean));
    expect(quietRecords).toHaveLength(6);
    expect(quietRecords.filter((line) => line.includes('"phase":"confirmed"'))).toHaveLength(3);
    expect(quietRecords.filter((line) => line.includes('"phase":"completed"'))).toHaveLength(3);
    expect(aggregateAuditBytes).toBeLessThanOrEqual(auditStorageMaxBytes);
    await expect(requestTool(quietApp, 999)).resolves.toMatchObject({ ok: true });
    await service.dispose();
  });

  it("initializes a many-directory audit inventory once and never rescans foreign owners on append", async () => {
    const artifactDir = await tempDir();
    const auditRoot = join(artifactDir, "mcp-apps");
    const readdirCounts = new Map<string, number>();
    const service = createMcpAppService({
      artifactDir,
      beforeAuditStorageOperation(operation, path) {
        if (operation === "readdir") readdirCounts.set(path, (readdirCounts.get(path) ?? 0) + 1);
      },
    });
    const live = connection("connection-audit-inventory");
    const host = await hostFor(service, "run-audit-inventory", "conversation");
    const app = (await host.register(registration(live))).part as AgentReplyMcpAppPart;
    const foreignDirectories = Array.from({ length: 500 }, (_, index) => join(
      auditRoot,
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ));
    await Promise.all(foreignDirectories.map(async (directory) => {
      await mkdir(directory);
      await writeFile(join(directory, "audit.1.jsonl"), "{}\n");
    }));

    const identity = {
      conversationId: "conversation",
      invocationId: app.invocationId,
      connectionId: app.connectionId,
    };
    await service.request({
      ...identity,
      method: "tools/call",
      params: { name: "refresh_chart" },
      confirmed: true,
    });
    const targetDirectory = join(auditRoot, app.invocationId);
    expect(readdirCounts.get(auditRoot)).toBe(1);
    expect(foreignDirectories.every((directory) => readdirCounts.get(directory) === 1)).toBe(true);
    const foreignReadsAfterInitialization = foreignDirectories
      .reduce((total, directory) => total + (readdirCounts.get(directory) ?? 0), 0);
    const targetReadsAfterInitialization = readdirCounts.get(targetDirectory) ?? 0;

    for (let index = 0; index < 20; index += 1) {
      await service.request({
        ...identity,
        method: "ui/open-link",
        params: { url: `https://example.com/${String(index)}` },
        confirmed: true,
      });
    }
    expect(readdirCounts.get(auditRoot)).toBe(1);
    expect(foreignDirectories
      .reduce((total, directory) => total + (readdirCounts.get(directory) ?? 0), 0))
      .toBe(foreignReadsAfterInitialization);
    expect((readdirCounts.get(targetDirectory) ?? 0) - targetReadsAfterInitialization).toBe(20);
    await service.dispose();
  });

  it("reclaims inactive active files only after restart so stale owners cannot exhaust the reserve", async () => {
    const artifactDir = await tempDir();
    const auditMaxBytes = 1_024;
    const auditRetainedFiles = 1;
    const auditStorageMaxBytes = 4_096;
    const removedPaths: string[] = [];
    const observeRemoval: NonNullable<Parameters<typeof createMcpAppService>[0]["beforeAuditStorageOperation"]> = (
      operation,
      path,
    ) => {
      if (operation === "remove") removedPaths.push(path);
    };
    const firstService = createMcpAppService({
      artifactDir,
      auditMaxBytes,
      auditRetainedFiles,
      auditStorageMaxBytes,
      beforeAuditStorageOperation: observeRemoval,
    });
    const staleApps = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
      const live = connection(`connection-audit-stale-${String(index)}`);
      const host = await hostFor(firstService, `run-audit-stale-${String(index)}`, "conversation");
      return (await host.register(registration(live, {
        toolCallId: `call-audit-stale-${String(index)}`,
        resourceUri: `ui://widgets/audit-stale-${String(index)}`,
      }))).part as AgentReplyMcpAppPart;
    }));
    await Promise.all(staleApps.map(async (app, index) => await writeFile(
      join(artifactDir, "mcp-apps", app.invocationId, "audit.jsonl"),
      Buffer.alloc(900, 0x61 + (index % 20)),
    )));
    const staleRotatedPath = join(artifactDir, "mcp-apps", staleApps[0]!.invocationId, "audit.1.jsonl");
    await writeFile(staleRotatedPath, Buffer.alloc(500, 0x72));
    await firstService.dispose();

    const restartedService = createMcpAppService({
      artifactDir,
      auditMaxBytes,
      auditRetainedFiles,
      auditStorageMaxBytes,
      beforeAuditStorageOperation: observeRemoval,
    });
    const freshLive = connection("connection-audit-fresh-after-restart");
    const freshHost = await hostFor(restartedService, "run-audit-fresh-after-restart", "conversation");
    const freshApp = (await freshHost.register(registration(freshLive, {
      toolCallId: "call-audit-fresh-after-restart",
      resourceUri: "ui://widgets/audit-fresh-after-restart",
    }))).part as AgentReplyMcpAppPart;

    await expect(restartedService.request({
      conversationId: "conversation",
      invocationId: freshApp.invocationId,
      connectionId: freshApp.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart" },
      confirmed: true,
    })).resolves.toMatchObject({ ok: true });
    expect(freshLive.callTool).toHaveBeenCalledTimes(1);
    expect(removedPaths[0]).toBe(staleRotatedPath);
    const staleActiveFiles = await Promise.all(staleApps.map(async (app) => await stat(
      join(artifactDir, "mcp-apps", app.invocationId, "audit.jsonl"),
    ).then(() => true, () => false)));
    expect(staleActiveFiles.filter(Boolean).length).toBeLessThan(staleApps.length);
    const aggregateBytes = (await Promise.all([...staleApps, freshApp].map(async (app) => (
      await auditFileBytes(join(artifactDir, "mcp-apps", app.invocationId))
    )))).reduce((sum, bytes) => sum + bytes, 0);
    expect(aggregateBytes).toBeLessThanOrEqual(auditStorageMaxBytes);
    expect(await auditContents(join(artifactDir, "mcp-apps", freshApp.invocationId)))
      .toContain('"phase":"completed"');
    await restartedService.dispose();
  });

  it("remedies an oversized target rotation during initialization without deleting its active audit", async () => {
    const artifactDir = await tempDir();
    const service = createMcpAppService({
      artifactDir,
      auditMaxBytes: 1_024,
      auditRetainedFiles: 1,
      auditStorageMaxBytes: 4_096,
    });
    const live = connection("connection-audit-oversized-rotation");
    const host = await hostFor(service, "run-audit-oversized-rotation", "conversation");
    const app = (await host.register(registration(live))).part as AgentReplyMcpAppPart;
    const directory = join(artifactDir, "mcp-apps", app.invocationId);
    await Promise.all([
      writeFile(join(directory, "audit.jsonl"), "existing active audit\n"),
      writeFile(join(directory, "audit.1.jsonl"), Buffer.alloc(1_025, 0x78)),
    ]);

    await expect(service.request({
      conversationId: "conversation",
      invocationId: app.invocationId,
      connectionId: app.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart" },
      confirmed: true,
    })).resolves.toMatchObject({ ok: true });
    expect(live.callTool).toHaveBeenCalledTimes(1);
    await expect(access(join(directory, "audit.1.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    const audit = await readFile(join(directory, "audit.jsonl"), "utf8");
    expect(audit).toContain("existing active audit");
    expect(audit).toContain('"phase":"completed"');
    await service.dispose();
  });

  it("reserves completion capacity before an irreversible tool call under deterministic contention", async () => {
    const artifactDir = await tempDir();
    const clock = new Date("2026-08-15T12:00:00.000Z");
    const service = createMcpAppService({
      artifactDir,
      now: () => clock,
      auditMaxBytes: 1_024,
      auditRetainedFiles: 1,
      auditStorageMaxBytes: 2_048,
    });
    const entered = deferred();
    const release = deferred();
    const irreversibleLive = connection("a");
    irreversibleLive.callTool.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { ok: true };
    });
    const pressureLive = connection("b");
    const irreversibleHost = await hostFor(service, "run-audit-reserved-completion", "conversation");
    const pressureHost = await hostFor(service, "run-audit-reserved-pressure", "conversation");
    const irreversibleApp = (await irreversibleHost.register(registration(irreversibleLive, {
      toolCallId: "call-audit-reserved-completion",
      resourceUri: "ui://widgets/audit-reserved-completion",
    }))).part as AgentReplyMcpAppPart;
    const pressureApp = (await pressureHost.register(registration(pressureLive, {
      toolCallId: "call-audit-reserved-pressure",
      resourceUri: "ui://widgets/audit-reserved-pressure",
    }))).part as AgentReplyMcpAppPart;
    const irreversibleDirectory = join(artifactDir, "mcp-apps", irreversibleApp.invocationId);
    const pressureDirectory = join(artifactDir, "mcp-apps", pressureApp.invocationId);
    await Promise.all([
      writeFile(join(irreversibleDirectory, "audit.jsonl"), Buffer.alloc(850, 0x61)),
      writeFile(join(pressureDirectory, "audit.jsonl"), Buffer.alloc(650, 0x62)),
    ]);

    const irreversibleRequest = service.request({
      conversationId: "conversation",
      invocationId: irreversibleApp.invocationId,
      connectionId: irreversibleApp.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart", arguments: { irreversible: true } },
      confirmed: true,
    }).then((value) => ({ status: "resolved" as const, value }), (error: unknown) => ({
      status: "rejected" as const,
      code: (error as { code?: string }).code,
    }));
    await entered.promise;
    const pressureResult = await service.request({
      conversationId: "conversation",
      invocationId: pressureApp.invocationId,
      connectionId: pressureApp.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart" },
      confirmed: true,
    }).then((value) => ({ status: "resolved" as const, value }), (error: unknown) => ({
      status: "rejected" as const,
      code: (error as { code?: string }).code,
    }));
    release.resolve();
    const irreversibleResult = await irreversibleRequest;

    expect(pressureResult).toEqual({ status: "rejected", code: "app_audit_failed" });
    expect(pressureLive.callTool).not.toHaveBeenCalled();
    expect(irreversibleResult).toMatchObject({ status: "resolved", value: { ok: true } });
    expect(irreversibleLive.callTool).toHaveBeenCalledTimes(1);
    const records = await auditContents(irreversibleDirectory);
    expect(records).toContain('"phase":"confirmed"');
    expect(records).toContain('"phase":"completed"');
    await service.dispose();
  });

  it("releases exactly the reserved completion bytes when the tool fails before completion", async () => {
    const artifactDir = await tempDir();
    const clock = new Date("2026-08-15T12:00:00.000Z");
    const service = createMcpAppService({
      artifactDir,
      now: () => clock,
      auditMaxBytes: 1_024,
      auditRetainedFiles: 1,
      auditStorageMaxBytes: 2_048,
    });
    const failedLive = connection("c");
    failedLive.callTool.mockRejectedValueOnce(new Error("tool transport closed"));
    const healthyLive = connection("d");
    const failedHost = await hostFor(service, "run-audit-release-failed", "conversation");
    const healthyHost = await hostFor(service, "run-audit-release-healthy", "conversation");
    const failedApp = (await failedHost.register(registration(failedLive, {
      toolCallId: "call-audit-release-failed",
      resourceUri: "ui://widgets/audit-release-failed",
    }))).part as AgentReplyMcpAppPart;
    const healthyApp = (await healthyHost.register(registration(healthyLive, {
      toolCallId: "call-audit-release-healthy",
      resourceUri: "ui://widgets/audit-release-healthy",
    }))).part as AgentReplyMcpAppPart;
    const auditLineBytes = (app: AgentReplyMcpAppPart, phase: "confirmed" | "completed") => Buffer.byteLength(
      `${JSON.stringify({
        at: clock.toISOString(),
        invocationId: app.invocationId,
        connectionId: app.connectionId,
        method: "tools/call",
        details: { phase },
      })}\n`,
      "utf8",
    );
    const failedLineBytes = auditLineBytes(failedApp, "confirmed");
    const healthyPairBytes = auditLineBytes(healthyApp, "confirmed")
      + auditLineBytes(healthyApp, "completed");
    const failedDirectory = join(artifactDir, "mcp-apps", failedApp.invocationId);
    const healthyDirectory = join(artifactDir, "mcp-apps", healthyApp.invocationId);
    await Promise.all([
      writeFile(join(failedDirectory, "audit.jsonl"), Buffer.alloc(1_024 - failedLineBytes, 0x66)),
      writeFile(join(healthyDirectory, "audit.jsonl"), Buffer.alloc(1_024 - healthyPairBytes, 0x68)),
    ]);

    await expect(service.request({
      conversationId: "conversation",
      invocationId: failedApp.invocationId,
      connectionId: failedApp.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart" },
      confirmed: true,
    })).rejects.toMatchObject({ code: "app_connection_closed" });
    await expect(service.request({
      conversationId: "conversation",
      invocationId: healthyApp.invocationId,
      connectionId: healthyApp.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart" },
      confirmed: true,
    })).resolves.toMatchObject({ ok: true });

    expect(failedLive.callTool).toHaveBeenCalledTimes(1);
    expect(healthyLive.callTool).toHaveBeenCalledTimes(1);
    await expect(stat(join(failedDirectory, "audit.jsonl"))).resolves.toMatchObject({ size: 1_024 });
    await expect(stat(join(healthyDirectory, "audit.jsonl"))).resolves.toMatchObject({ size: 1_024 });
    await service.dispose();
  });

  it("never reclaims another app's active confirmation while its tool call is in flight", async () => {
    const artifactDir = await tempDir();
    const clock = new Date("2026-08-15T12:00:00.000Z");
    const service = createMcpAppService({
      artifactDir,
      now: () => clock,
      auditMaxBytes: 1_024,
      auditRetainedFiles: 2,
      auditStorageMaxBytes: 4_096,
    });
    const entered = deferred();
    const release = deferred();
    const activeLive = connection("connection-audit-active-a");
    activeLive.callTool.mockImplementationOnce(async (name: string, args: unknown) => {
      entered.resolve();
      await release.promise;
      return { name, args, ok: true };
    });
    const activeHost = await hostFor(service, "run-audit-active-a", "conversation");
    const activeApp = (await activeHost.register(registration(activeLive, {
      toolCallId: "call-audit-active-a",
      resourceUri: "ui://widgets/audit-active-a",
    }))).part as AgentReplyMcpAppPart;
    const pressureLive = connection("connection-audit-active-b");
    const pressureHost = await hostFor(service, "run-audit-active-b", "conversation");
    const pressureApp = (await pressureHost.register(registration(pressureLive, {
      toolCallId: "call-audit-active-b",
      resourceUri: "ui://widgets/audit-active-b",
    }))).part as AgentReplyMcpAppPart;
    const activeDirectory = join(artifactDir, "mcp-apps", activeApp.invocationId);
    const pressureDirectory = join(artifactDir, "mcp-apps", pressureApp.invocationId);
    await Promise.all([
      writeFile(join(activeDirectory, "audit.jsonl"), `${"a".repeat(799)}\n`),
      writeFile(join(activeDirectory, "audit.1.jsonl"), `${"h".repeat(899)}\n`),
      writeFile(join(activeDirectory, "audit.2.jsonl"), `${"i".repeat(899)}\n`),
      writeFile(join(pressureDirectory, "audit.jsonl"), `${"b".repeat(1_019)}\n`),
      writeFile(join(pressureDirectory, "audit.1.jsonl"), `${"j".repeat(199)}\n`),
    ]);
    const future = new Date("2035-01-01T00:00:00.000Z");
    await Promise.all([
      utimes(join(activeDirectory, "audit.1.jsonl"), future, future),
      utimes(join(activeDirectory, "audit.2.jsonl"), future, future),
    ]);

    const activeRequest = service.request({
      conversationId: "conversation",
      invocationId: activeApp.invocationId,
      connectionId: activeApp.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart", arguments: { owner: "a" } },
      confirmed: true,
    });
    await entered.promise;
    expect(await readFile(join(activeDirectory, "audit.jsonl"), "utf8"))
      .toContain('"phase":"confirmed"');

    await expect(service.request({
      conversationId: "conversation",
      invocationId: pressureApp.invocationId,
      connectionId: pressureApp.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart", arguments: { owner: "b" } },
      confirmed: true,
    })).resolves.toMatchObject({ ok: true });
    expect(pressureLive.callTool).toHaveBeenCalledTimes(1);
    expect(await readFile(join(activeDirectory, "audit.jsonl"), "utf8"))
      .toContain('"phase":"confirmed"');

    release.resolve();
    await expect(activeRequest).resolves.toMatchObject({ ok: true });
    const records = await auditContents(activeDirectory);
    expect(records).toContain('"phase":"confirmed"');
    expect(records).toContain('"phase":"completed"');
    await service.dispose();
  });

  it.each(["readdir", "lstat"] as const)(
    "isolates a foreign %s failure while the poisoned owner still fails closed as a target",
    async (failedOperation) => {
    const artifactDir = await tempDir();
    let poisonedDirectory = "";
    const service = createMcpAppService({
      artifactDir,
      auditMaxBytes: 1_024,
      auditRetainedFiles: 1,
      auditStorageMaxBytes: 4_096,
      beforeAuditStorageOperation(operation, path) {
        if (
          operation === failedOperation
          && (path === poisonedDirectory || path.startsWith(`${poisonedDirectory}/`))
        ) throw fileSystemError("EACCES");
      },
    });
    const poisonedLive = connection("connection-audit-read-poison");
    const poisonedHost = await hostFor(service, "run-audit-read-poison", "conversation");
    const poisonedApp = (await poisonedHost.register(registration(poisonedLive, {
      toolCallId: "call-audit-read-poison",
      resourceUri: "ui://widgets/audit-read-poison",
    }))).part as AgentReplyMcpAppPart;
    poisonedDirectory = join(artifactDir, "mcp-apps", poisonedApp.invocationId);
    await writeFile(join(poisonedDirectory, "audit.1.jsonl"), "foreign history\n");
    const healthyLive = connection("connection-audit-read-healthy");
    const healthyHost = await hostFor(service, "run-audit-read-healthy", "conversation");
    const healthyApp = (await healthyHost.register(registration(healthyLive, {
      toolCallId: "call-audit-read-healthy",
      resourceUri: "ui://widgets/audit-read-healthy",
    }))).part as AgentReplyMcpAppPart;

    await expect(service.request({
      conversationId: "conversation",
      invocationId: healthyApp.invocationId,
      connectionId: healthyApp.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart" },
      confirmed: true,
    })).resolves.toMatchObject({ ok: true });
    expect(healthyLive.callTool).toHaveBeenCalledTimes(1);

    await expect(service.request({
      conversationId: "conversation",
      invocationId: poisonedApp.invocationId,
      connectionId: poisonedApp.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart" },
      confirmed: true,
    })).rejects.toMatchObject({ code: "app_audit_failed" });
    expect(poisonedLive.callTool).not.toHaveBeenCalled();
    await service.dispose();
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves unrelated history when two real unreadable owners make admission impossible and recovers in place",
    async () => {
      const artifactDir = await tempDir();
      const service = createMcpAppService({
        artifactDir,
        auditMaxBytes: 1_024,
        auditRetainedFiles: 1,
        auditStorageMaxBytes: 3_072,
      });
      const healthyLive = connection("connection-audit-real-poison-healthy");
      const healthyHost = await hostFor(service, "run-audit-real-poison-healthy", "conversation");
      const healthyApp = (await healthyHost.register(registration(healthyLive, {
        toolCallId: "call-audit-real-poison-healthy",
        resourceUri: "ui://widgets/audit-real-poison-healthy",
      }))).part as AgentReplyMcpAppPart;
      const root = join(artifactDir, "mcp-apps");
      const poisonedDirectories = [
        join(root, "10000000-0000-4000-8000-000000000001"),
        join(root, "10000000-0000-4000-8000-000000000002"),
      ];
      const unrelatedDirectory = join(root, "10000000-0000-4000-8000-000000000003");
      const unrelatedHistory = join(unrelatedDirectory, "audit.1.jsonl");
      await Promise.all([...poisonedDirectories, unrelatedDirectory]
        .map(async (directory) => await mkdir(directory)));
      await Promise.all([
        ...poisonedDirectories.map(async (directory) => await writeFile(
          join(directory, "audit.jsonl"),
          Buffer.alloc(128, 0x70),
        )),
        writeFile(unrelatedHistory, Buffer.alloc(600, 0x68)),
      ]);
      await Promise.all(poisonedDirectories.map(async (directory) => await chmod(directory, 0o000)));

      try {
        await expect(service.request({
          conversationId: "conversation",
          invocationId: healthyApp.invocationId,
          connectionId: healthyApp.connectionId,
          method: "tools/call",
          params: { name: "refresh_chart" },
          confirmed: true,
        })).rejects.toMatchObject({ code: "app_audit_failed" });
        expect(healthyLive.callTool).not.toHaveBeenCalled();
        await expect(stat(unrelatedHistory)).resolves.toMatchObject({ size: 600 });
      } finally {
        await Promise.all(poisonedDirectories.map(async (directory) => await chmod(directory, 0o700)));
      }

      await expect(service.request({
        conversationId: "conversation",
        invocationId: healthyApp.invocationId,
        connectionId: healthyApp.connectionId,
        method: "tools/call",
        params: { name: "refresh_chart" },
        confirmed: true,
      })).resolves.toMatchObject({ ok: true });
      expect(healthyLive.callTool).toHaveBeenCalledTimes(1);
      await expect(stat(unrelatedHistory)).resolves.toMatchObject({ size: 600 });
      for (const directory of poisonedDirectories) {
        await expect(stat(join(directory, "audit.jsonl"))).resolves.toMatchObject({ size: 128 });
      }
      expect(await auditContents(join(root, healthyApp.invocationId)))
        .toContain('"phase":"completed"');
      await service.dispose();
    },
  );

  it.skipIf(process.platform === "win32")(
    "never follows a poisoned owner replaced by a symlink or changes outside audit files",
    async () => {
      const artifactDir = await tempDir();
      const outsideDirectory = await tempDir();
      const service = createMcpAppService({
        artifactDir,
        auditMaxBytes: 1_024,
        auditRetainedFiles: 1,
        auditStorageMaxBytes: 4_096,
      });
      const live = connection("connection-audit-poisoned-symlink-target");
      const host = await hostFor(service, "run-audit-poisoned-symlink-target", "conversation");
      const app = (await host.register(registration(live))).part as AgentReplyMcpAppPart;
      const root = join(artifactDir, "mcp-apps");
      const poisonedDirectory = join(root, "10000000-0000-4000-8000-000000000001");
      await mkdir(poisonedDirectory);
      await writeFile(join(poisonedDirectory, "audit.jsonl"), Buffer.alloc(128, 0x70));
      await chmod(poisonedDirectory, 0o000);

      try {
        await expect(service.request(confirmedToolCall(app))).resolves.toMatchObject({ ok: true });
      } finally {
        await chmod(poisonedDirectory, 0o700);
      }
      await rm(poisonedDirectory, { recursive: true, force: true });
      const sentinels = await auditSentinels(outsideDirectory);
      await symlink(outsideDirectory, poisonedDirectory, "dir");

      const outcome = await service.request(confirmedToolCall(app))
        .then(() => "resolved", (error: unknown) => (error as { code?: string }).code);
      expect(["resolved", "app_audit_failed"]).toContain(outcome);
      await sentinels.assertUnchanged();
      expect(live.callTool).toHaveBeenCalledTimes(outcome === "resolved" ? 2 : 1);
      await service.dispose();
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps a poisoned owner quarantined when a different real directory replaces it",
    async () => {
      const artifactDir = await tempDir();
      const service = createMcpAppService({
        artifactDir,
        auditMaxBytes: 1_024,
        auditRetainedFiles: 1,
        auditStorageMaxBytes: 4_096,
      });
      const live = connection("connection-audit-poisoned-replacement-target");
      const host = await hostFor(service, "run-audit-poisoned-replacement-target", "conversation");
      const app = (await host.register(registration(live))).part as AgentReplyMcpAppPart;
      const poisonedDirectory = join(
        artifactDir,
        "mcp-apps",
        "10000000-0000-4000-8000-000000000002",
      );
      await mkdir(poisonedDirectory);
      await writeFile(join(poisonedDirectory, "audit.jsonl"), Buffer.alloc(128, 0x70));
      await chmod(poisonedDirectory, 0o000);
      try {
        await service.request(confirmedToolCall(app));
      } finally {
        await chmod(poisonedDirectory, 0o700);
      }
      await rm(poisonedDirectory, { recursive: true, force: true });
      await mkdir(poisonedDirectory);
      const sentinels = await auditSentinels(poisonedDirectory);

      await expect(service.request(confirmedToolCall(app))).resolves.toMatchObject({ ok: true });
      await sentinels.assertUnchanged();
      expect(live.callTool).toHaveBeenCalledTimes(2);
      await service.dispose();
    },
  );

  it.each(["append", "rename"] as const)(
    "fails closed when the target owner parent is swapped before audit %s",
    async (attackedOperation) => {
      const artifactDir = await tempDir();
      const outsideDirectory = await tempDir();
      let targetDirectory = "";
      let attackedPath = "";
      let swapped = false;
      const parkedDirectory = join(artifactDir, "mcp-apps", ".swapped-audit-owner");
      const outsideActivePath = join(outsideDirectory, "audit.jsonl");
      const outsideRotationPath = join(outsideDirectory, "audit.1.jsonl");
      const outsideActive = Buffer.from("outside target active audit\n");
      const outsideRotation = Buffer.from("outside target rotated audit\n");
      await Promise.all([
        writeFile(outsideActivePath, outsideActive),
        writeFile(outsideRotationPath, outsideRotation),
      ]);
      const service = createMcpAppService({
        artifactDir,
        auditMaxBytes: 1_024,
        auditRetainedFiles: 1,
        auditStorageMaxBytes: 4_096,
        async beforeAuditStorageOperation(operation, path) {
          if (swapped || operation !== attackedOperation || path !== attackedPath) return;
          swapped = true;
          await rename(targetDirectory, parkedDirectory);
          await symlink(outsideDirectory, targetDirectory, "dir");
        },
      });
      const live = connection(`connection-audit-parent-swap-${attackedOperation}`);
      const host = await hostFor(service, `run-audit-parent-swap-${attackedOperation}`, "conversation");
      const app = (await host.register(registration(live))).part as AgentReplyMcpAppPart;
      targetDirectory = join(artifactDir, "mcp-apps", app.invocationId);
      attackedPath = join(targetDirectory, "audit.jsonl");
      if (attackedOperation === "rename") {
        await writeFile(attackedPath, Buffer.alloc(1_000, 0x61));
      }

      await expect(service.request({
        conversationId: "conversation",
        invocationId: app.invocationId,
        connectionId: app.connectionId,
        method: "tools/call",
        params: { name: "refresh_chart" },
        confirmed: true,
      })).rejects.toMatchObject({ code: "app_audit_failed" });
      expect(swapped).toBe(true);
      expect(live.callTool).not.toHaveBeenCalled();
      await expect(readFile(outsideActivePath)).resolves.toEqual(outsideActive);
      await expect(readFile(outsideRotationPath)).resolves.toEqual(outsideRotation);
      await service.dispose();
    },
  );

  it.each(["readdir", "lstat"] as const)(
    "fails closed when target inventory sees a parent swap before %s",
    async (attackedOperation) => {
      const artifactDir = await tempDir();
      const outsideDirectory = await tempDir();
      let targetDirectory = "";
      let attackedPath = "";
      let swapped = false;
      const parkedDirectory = join(artifactDir, "mcp-apps", ".swapped-inventory-owner");
      const outsideActivePath = join(outsideDirectory, "audit.jsonl");
      const outsideRotationPath = join(outsideDirectory, "audit.5.jsonl");
      const outsideActive = Buffer.from("outside inventory active audit\n");
      const outsideRotation = Buffer.from("outside inventory rotated audit\n");
      await Promise.all([
        writeFile(outsideActivePath, outsideActive),
        writeFile(outsideRotationPath, outsideRotation),
      ]);
      const service = createMcpAppService({
        artifactDir,
        async beforeAuditStorageOperation(operation, path) {
          if (swapped || operation !== attackedOperation || path !== attackedPath) return;
          swapped = true;
          await rename(targetDirectory, parkedDirectory);
          await symlink(outsideDirectory, targetDirectory, "dir");
        },
      });
      const live = connection(`connection-audit-inventory-swap-${attackedOperation}`);
      const host = await hostFor(service, `run-audit-inventory-swap-${attackedOperation}`, "conversation");
      const app = (await host.register(registration(live))).part as AgentReplyMcpAppPart;
      targetDirectory = join(artifactDir, "mcp-apps", app.invocationId);
      const activePath = join(targetDirectory, "audit.jsonl");
      await writeFile(activePath, "existing audit\n");
      attackedPath = attackedOperation === "readdir" ? targetDirectory : activePath;

      await expect(service.request({
        conversationId: "conversation",
        invocationId: app.invocationId,
        connectionId: app.connectionId,
        method: "tools/call",
        params: { name: "refresh_chart" },
        confirmed: true,
      })).rejects.toMatchObject({ code: "app_audit_failed" });
      expect(swapped).toBe(true);
      expect(live.callTool).not.toHaveBeenCalled();
      await expect(readFile(outsideActivePath)).resolves.toEqual(outsideActive);
      await expect(readFile(outsideRotationPath)).resolves.toEqual(outsideRotation);
      await service.dispose();
    },
  );

  it("fails closed when the verified audit root is swapped before inventory", async () => {
    const artifactDir = await tempDir();
    const outsideDirectory = await tempDir();
    const root = join(artifactDir, "mcp-apps");
    const parkedRoot = join(artifactDir, ".swapped-mcp-apps-root");
    let swapped = false;
    const outsideActive = Buffer.from("outside root active audit\n");
    const outsideRotation = Buffer.from("outside root rotated audit\n");
    const service = createMcpAppService({
      artifactDir,
      async beforeAuditStorageOperation(operation, path) {
        if (swapped || operation !== "readdir" || path !== root) return;
        swapped = true;
        await rename(root, parkedRoot);
        await symlink(outsideDirectory, root, "dir");
      },
    });
    const live = connection("connection-audit-root-swap");
    const host = await hostFor(service, "run-audit-root-swap", "conversation");
    const app = (await host.register(registration(live))).part as AgentReplyMcpAppPart;
    const targetOutsideDirectory = join(outsideDirectory, app.invocationId);
    const outsideActivePath = join(targetOutsideDirectory, "audit.jsonl");
    const outsideRotationPath = join(targetOutsideDirectory, "audit.5.jsonl");
    await mkdir(targetOutsideDirectory);
    await Promise.all([
      writeFile(outsideActivePath, outsideActive),
      writeFile(outsideRotationPath, outsideRotation),
    ]);

    await expect(service.request({
      conversationId: "conversation",
      invocationId: app.invocationId,
      connectionId: app.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart" },
      confirmed: true,
    })).rejects.toMatchObject({ code: "app_audit_failed" });
    expect(swapped).toBe(true);
    expect(live.callTool).not.toHaveBeenCalled();
    await expect(readFile(outsideActivePath)).resolves.toEqual(outsideActive);
    await expect(readFile(outsideRotationPath)).resolves.toEqual(outsideRotation);
    await service.dispose();
  });

  it.each(["symlink", "directory"] as const)(
    "refuses expired-owner cleanup after its parent is replaced by a %s",
    async (replacementKind) => {
      const artifactDir = await tempDir();
      const outsideDirectory = await tempDir();
      let clock = new Date("2026-08-15T12:00:00.000Z");
      let targetDirectory = "";
      let swapped = false;
      let sentinels = replacementKind === "symlink"
        ? await auditSentinels(outsideDirectory)
        : undefined;
      const parkedDirectory = join(artifactDir, "mcp-apps", ".swapped-cleanup-owner");
      const service = createMcpAppService({
        artifactDir,
        retentionDays: 1,
        now: () => clock,
        async beforeAuditStorageOperation(operation, path) {
          if (swapped || operation !== "remove" || path !== targetDirectory) return;
          swapped = true;
          await rename(targetDirectory, parkedDirectory);
          if (replacementKind === "symlink") {
            await symlink(outsideDirectory, targetDirectory, "dir");
          } else {
            await mkdir(targetDirectory);
            sentinels = await auditSentinels(targetDirectory);
          }
        },
      });
      const runId = `run-audit-cleanup-parent-swap-${replacementKind}`;
      const live = connection(`connection-audit-cleanup-parent-swap-${replacementKind}`);
      const host = await hostFor(service, runId, "conversation");
      const app = (await host.register(registration(live))).part as AgentReplyMcpAppPart;
      targetDirectory = join(artifactDir, "mcp-apps", app.invocationId);
      await service.wrapResponder(responder(runId)).respond({
        conversationId: "conversation",
        text: "retain app",
        abortSignal: new AbortController().signal,
      }, stream);
      clock = new Date("2026-08-17T12:00:00.000Z");

      await expect(service.cleanupExpired()).resolves.toBeUndefined();
      expect(swapped).toBe(true);
      expect((await lstat(targetDirectory)).isSymbolicLink()).toBe(replacementKind === "symlink");
      expect(sentinels).toBeDefined();
      await sentinels!.assertUnchanged();
      await service.dispose();
    },
  );

  it("refuses quota reclamation after a foreign owner parent swap", async () => {
    const artifactDir = await tempDir();
    const outsideDirectory = await tempDir();
    const foreignDirectory = join(
      artifactDir,
      "mcp-apps",
      "10000000-0000-4000-8000-000000000003",
    );
    const parkedDirectory = join(artifactDir, "mcp-apps", ".swapped-foreign-audit-owner");
    const foreignHistoryPath = join(foreignDirectory, "audit.1.jsonl");
    const outsideActivePath = join(outsideDirectory, "audit.jsonl");
    const outsideHistoryPath = join(outsideDirectory, "audit.1.jsonl");
    const outsideActive = Buffer.from("outside foreign active audit\n");
    const outsideHistory = Buffer.from("outside foreign rotated audit\n");
    let swapped = false;
    const service = createMcpAppService({
      artifactDir,
      auditMaxBytes: 1_024,
      auditRetainedFiles: 1,
      auditStorageMaxBytes: 2_048,
      async beforeAuditStorageOperation(operation, path) {
        if (swapped || operation !== "remove" || path !== foreignHistoryPath) return;
        swapped = true;
        await rename(foreignDirectory, parkedDirectory);
        await symlink(outsideDirectory, foreignDirectory, "dir");
      },
    });
    const live = connection("connection-audit-foreign-parent-swap");
    const host = await hostFor(service, "run-audit-foreign-parent-swap", "conversation");
    const app = (await host.register(registration(live))).part as AgentReplyMcpAppPart;
    const targetActivePath = join(artifactDir, "mcp-apps", app.invocationId, "audit.jsonl");
    await mkdir(foreignDirectory);
    await Promise.all([
      writeFile(targetActivePath, Buffer.alloc(900, 0x61)),
      writeFile(foreignHistoryPath, Buffer.alloc(900, 0x62)),
      writeFile(outsideActivePath, outsideActive),
      writeFile(outsideHistoryPath, outsideHistory),
    ]);

    await expect(service.request({
      conversationId: "conversation",
      invocationId: app.invocationId,
      connectionId: app.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart" },
      confirmed: true,
    })).rejects.toMatchObject({ code: "app_audit_failed" });
    expect(swapped).toBe(true);
    expect(live.callTool).not.toHaveBeenCalled();
    await expect(readFile(outsideActivePath)).resolves.toEqual(outsideActive);
    await expect(readFile(outsideHistoryPath)).resolves.toEqual(outsideHistory);
    await service.dispose();
  });

  it("rejects a multiply linked audit file without changing its outside alias", async () => {
    const artifactDir = await tempDir();
    const outsideDirectory = await tempDir();
    const service = createMcpAppService({ artifactDir });
    const live = connection("connection-audit-hardlink");
    const host = await hostFor(service, "run-audit-hardlink", "conversation");
    const app = (await host.register(registration(live))).part as AgentReplyMcpAppPart;
    const outsidePath = join(outsideDirectory, "outside-audit-alias.jsonl");
    const outsideBytes = Buffer.from("outside hardlink alias must not change\n");
    await writeFile(outsidePath, outsideBytes);
    await link(outsidePath, join(artifactDir, "mcp-apps", app.invocationId, "audit.jsonl"));

    await expect(service.request({
      conversationId: "conversation",
      invocationId: app.invocationId,
      connectionId: app.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart" },
      confirmed: true,
    })).rejects.toMatchObject({ code: "app_audit_failed" });
    expect(live.callTool).not.toHaveBeenCalled();
    await expect(readFile(outsidePath)).resolves.toEqual(outsideBytes);
    await service.dispose();
  });

  it("skips a foreign removal failure and reclaims another safe history candidate", async () => {
    const artifactDir = await tempDir();
    let failedRemovalPath = "";
    const service = createMcpAppService({
      artifactDir,
      auditMaxBytes: 1_024,
      auditRetainedFiles: 1,
      auditStorageMaxBytes: 3_072,
      beforeAuditStorageOperation(operation, path) {
        if (operation === "remove" && path === failedRemovalPath) throw fileSystemError("EPERM");
      },
    });
    const failedLive = connection("connection-audit-remove-failed");
    const failedHost = await hostFor(service, "run-audit-remove-failed", "conversation");
    const failedApp = (await failedHost.register(registration(failedLive, {
      toolCallId: "call-audit-remove-failed",
      resourceUri: "ui://widgets/audit-remove-failed",
    }))).part as AgentReplyMcpAppPart;
    const fallbackLive = connection("connection-audit-remove-fallback");
    const fallbackHost = await hostFor(service, "run-audit-remove-fallback", "conversation");
    const fallbackApp = (await fallbackHost.register(registration(fallbackLive, {
      toolCallId: "call-audit-remove-fallback",
      resourceUri: "ui://widgets/audit-remove-fallback",
    }))).part as AgentReplyMcpAppPart;
    const healthyLive = connection("connection-audit-remove-healthy");
    const healthyHost = await hostFor(service, "run-audit-remove-healthy", "conversation");
    const healthyApp = (await healthyHost.register(registration(healthyLive, {
      toolCallId: "call-audit-remove-healthy",
      resourceUri: "ui://widgets/audit-remove-healthy",
    }))).part as AgentReplyMcpAppPart;
    const failedDirectory = join(artifactDir, "mcp-apps", failedApp.invocationId);
    const fallbackDirectory = join(artifactDir, "mcp-apps", fallbackApp.invocationId);
    failedRemovalPath = join(failedDirectory, "audit.1.jsonl");
    const fallbackHistoryPath = join(fallbackDirectory, "audit.1.jsonl");
    await Promise.all([
      writeFile(join(failedDirectory, "audit.jsonl"), Buffer.alloc(900, 0x61)),
      writeFile(failedRemovalPath, Buffer.alloc(900, 0x62)),
      writeFile(join(fallbackDirectory, "audit.jsonl"), Buffer.alloc(600, 0x63)),
      writeFile(fallbackHistoryPath, Buffer.alloc(600, 0x64)),
    ]);

    await expect(service.request({
      conversationId: "conversation",
      invocationId: healthyApp.invocationId,
      connectionId: healthyApp.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart" },
      confirmed: true,
    })).resolves.toMatchObject({ ok: true });
    expect(healthyLive.callTool).toHaveBeenCalledTimes(1);
    await expect(access(failedRemovalPath)).resolves.toBeUndefined();
    await expect(access(fallbackHistoryPath)).rejects.toMatchObject({ code: "ENOENT" });
    await service.dispose();
  });

  it("fails closed for unsafe owned audit storage without coupling a healthy app", async () => {
    const artifactDir = await tempDir();
    const service = createMcpAppService({ artifactDir });
    const poisonedLive = connection("connection-audit-failure");
    const poisonedHost = await hostFor(service, "run-audit-failure", "conversation");
    const poisonedRegistered = await poisonedHost.register(registration(poisonedLive));
    const poisonedApp = poisonedRegistered.part as AgentReplyMcpAppPart;
    const healthyLive = connection("connection-audit-healthy");
    const healthyHost = await hostFor(service, "run-audit-healthy", "conversation");
    const healthyRegistered = await healthyHost.register(registration(healthyLive, {
      toolCallId: "call-audit-healthy",
      resourceUri: "ui://widgets/audit-healthy",
    }));
    const healthyApp = healthyRegistered.part as AgentReplyMcpAppPart;
    await mkdir(join(artifactDir, "mcp-apps", poisonedApp.invocationId, "audit.jsonl"));

    await expect(service.request({
      conversationId: "conversation",
      invocationId: poisonedApp.invocationId,
      connectionId: poisonedApp.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart", arguments: { range: "week" } },
      confirmed: true,
    })).rejects.toMatchObject({ code: "app_audit_failed" });
    expect(poisonedLive.callTool).not.toHaveBeenCalled();

    await expect(service.request({
      conversationId: "conversation",
      invocationId: healthyApp.invocationId,
      connectionId: healthyApp.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart", arguments: { range: "month" } },
      confirmed: true,
    })).resolves.toMatchObject({ ok: true, name: "refresh_chart" });
    expect(healthyLive.callTool).toHaveBeenCalledTimes(1);
    const healthyAudit = await readFile(
      join(artifactDir, "mcp-apps", healthyApp.invocationId, "audit.jsonl"),
      "utf8",
    );
    expect(healthyAudit).toContain('"phase":"confirmed"');
    expect(healthyAudit).toContain('"phase":"completed"');
    await service.dispose();
  });

  it("uses the injected aggregate ceiling and never reclaims foreign active files to exceed it", async () => {
    const artifactDir = await tempDir();
    const service = createMcpAppService({
      artifactDir,
      auditMaxBytes: 1_024,
      auditRetainedFiles: 1,
      auditStorageMaxBytes: 2_048,
    });
    const owners = await Promise.all(["one", "two"].map(async (suffix) => {
      const live = connection(`connection-audit-ceiling-${suffix}`);
      const host = await hostFor(service, `run-audit-ceiling-${suffix}`, "conversation");
      const app = (await host.register(registration(live, {
        toolCallId: `call-audit-ceiling-${suffix}`,
        resourceUri: `ui://widgets/audit-ceiling-${suffix}`,
      }))).part as AgentReplyMcpAppPart;
      return { live, app };
    }));
    await Promise.all(owners.map(async ({ app }, index) => await writeFile(
      join(artifactDir, "mcp-apps", app.invocationId, "audit.jsonl"),
      Buffer.alloc(1_024, 0x61 + index),
    )));
    const targetLive = connection("connection-audit-ceiling-target");
    const targetHost = await hostFor(service, "run-audit-ceiling-target", "conversation");
    const targetApp = (await targetHost.register(registration(targetLive, {
      toolCallId: "call-audit-ceiling-target",
      resourceUri: "ui://widgets/audit-ceiling-target",
    }))).part as AgentReplyMcpAppPart;

    await expect(service.request({
      conversationId: "conversation",
      invocationId: targetApp.invocationId,
      connectionId: targetApp.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart" },
      confirmed: true,
    })).rejects.toMatchObject({ code: "app_audit_failed" });
    expect(targetLive.callTool).not.toHaveBeenCalled();
    for (const { app } of owners) {
      await expect(stat(join(artifactDir, "mcp-apps", app.invocationId, "audit.jsonl")))
        .resolves.toMatchObject({ size: 1_024 });
    }
    await service.dispose();
  });

  it("requires one audit option set for every service sharing an artifact root", async () => {
    const artifactDir = await tempDir();
    const first = createMcpAppService({
      artifactDir,
      auditMaxBytes: 1_024,
      auditRetainedFiles: 1,
      auditStorageMaxBytes: 4_096,
    });
    const matching = createMcpAppService({
      artifactDir,
      auditMaxBytes: 1_024,
      auditRetainedFiles: 1,
      auditStorageMaxBytes: 4_096,
    });
    expect(() => createMcpAppService({
      artifactDir,
      auditMaxBytes: 1_024,
      auditRetainedFiles: 1,
      auditStorageMaxBytes: 5_120,
    })).toThrow(/must agree for one artifact root/iu);
    await Promise.all([first.dispose(), matching.dispose()]);
  });

  it("refuses a symlink audit target without writing through it or poisoning a healthy owner", async () => {
    const artifactDir = await tempDir();
    const service = createMcpAppService({ artifactDir });
    const poisonedLive = connection("connection-audit-symlink");
    const poisonedHost = await hostFor(service, "run-audit-symlink", "conversation");
    const poisonedApp = (await poisonedHost.register(registration(poisonedLive))).part as AgentReplyMcpAppPart;
    const sentinelPath = join(artifactDir, "audit-symlink-sentinel");
    await writeFile(sentinelPath, "unchanged");
    await symlink(sentinelPath, join(artifactDir, "mcp-apps", poisonedApp.invocationId, "audit.jsonl"));

    await expect(service.request({
      conversationId: "conversation",
      invocationId: poisonedApp.invocationId,
      connectionId: poisonedApp.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart" },
      confirmed: true,
    })).rejects.toMatchObject({ code: "app_audit_failed" });
    expect(poisonedLive.callTool).not.toHaveBeenCalled();
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("unchanged");

    const healthyLive = connection("connection-audit-symlink-healthy");
    const healthyHost = await hostFor(service, "run-audit-symlink-healthy", "conversation");
    const healthyApp = (await healthyHost.register(registration(healthyLive, {
      toolCallId: "call-audit-symlink-healthy",
      resourceUri: "ui://widgets/audit-symlink-healthy",
    }))).part as AgentReplyMcpAppPart;
    await expect(service.request({
      conversationId: "conversation",
      invocationId: healthyApp.invocationId,
      connectionId: healthyApp.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart" },
      confirmed: true,
    })).resolves.toMatchObject({ ok: true });
    await service.dispose();
  });

  it("keeps all model-filled tool, argument, resource, and URL content out of audit records", async () => {
    const artifactDir = await tempDir();
    const service = createMcpAppService({ artifactDir });
    const live = connection("connection-audit-model-content");
    const resourceUri = "ui://widgets/model-secret-resource";
    const toolName = "model_secret_tool";
    const host = await hostFor(service, "run-audit-model-content", "conversation");
    const app = (await host.register(registration(live, {
      resourceUri,
      appVisibleTools: [toolName],
    }))).part as AgentReplyMcpAppPart;
    const identity = {
      conversationId: "conversation",
      invocationId: app.invocationId,
      connectionId: app.connectionId,
    };
    await service.request({
      ...identity,
      method: "tools/call",
      params: { name: toolName, arguments: { prompt: "model-secret-argument" } },
      confirmed: true,
    });
    await service.request({
      ...identity,
      method: "resources/read",
      params: { uri: resourceUri },
    });
    await service.request({
      ...identity,
      method: "ui/open-link",
      params: { url: "https://example.com/model-secret-url" },
      confirmed: true,
    });

    const audit = await auditContents(join(artifactDir, "mcp-apps", app.invocationId));
    expect(audit).not.toContain(toolName);
    expect(audit).not.toContain("model-secret-argument");
    expect(audit).not.toContain(resourceUri);
    expect(audit).not.toContain("model-secret-url");
    expect(audit).toContain('"phase":"confirmed"');
    expect(audit).toContain('"phase":"completed"');
    expect(audit).toContain('"phase":"requested"');
    await service.dispose();
  });

  it("reports a non-retryable incomplete audit when completion persistence fails after execution", async () => {
    const artifactDir = await tempDir();
    const service = createMcpAppService({ artifactDir });
    const live = connection("connection-audit-incomplete");
    const host = await hostFor(service, "run-audit-incomplete", "conversation");
    const app = (await host.register(registration(live))).part as AgentReplyMcpAppPart;
    const directory = join(artifactDir, "mcp-apps", app.invocationId);
    live.callTool.mockImplementationOnce(async (name: string, args: unknown) => {
      await mkdir(join(directory, "audit.1.jsonl"));
      return { name, args, ok: true };
    });

    await expect(service.request({
      conversationId: "conversation",
      invocationId: app.invocationId,
      connectionId: app.connectionId,
      method: "tools/call",
      params: { name: "refresh_chart", arguments: { irreversible: true } },
      confirmed: true,
    })).rejects.toMatchObject({
      code: "app_audit_incomplete",
      message: expect.stringContaining("do not retry automatically"),
    });
    expect(live.callTool).toHaveBeenCalledTimes(1);
    const audit = await readFile(join(directory, "audit.jsonl"), "utf8");
    expect(audit).toContain('"phase":"confirmed"');
    expect(audit).not.toContain('"phase":"completed"');
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
