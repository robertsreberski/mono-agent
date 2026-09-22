import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTuiAdapter } from "@mono-agent/operator-adapter";
import { startWebServer, OperatorClient } from "@mono-agent/web";
import type { AgentHarnessRuntimeOptionsInput } from "@mono-agent/agent-harness";
import { describe, expect, it, vi } from "vitest";
import { formatProviderUsageLead } from "@mono-agent/agent-contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";
import { createAgentProviderUsage } from "../provider-usage-scope.js";
import { createProviderUsageService } from "../provider-usage.js";
import { createProviderUsageRuntimeExtension, isProviderUsageToolAllowed, PROVIDER_USAGE_INPUT } from "../provider-usage-tool.js";

const request = (): AgentHarnessRuntimeOptionsInput => ({ request: { conversationId: "telegram:fixture", userMessage: "Quota?", abortSignal: new AbortController().signal }, runId: "fixture-run", context: {} as never });
describe("ProviderUsage tool", () => {
  it("honors all allow/deny aliases and strict optional input", () => {
    for (const alias of ["ProviderUsage", "mcp__mono-agent-provider-usage__ProviderUsage", "mcp__mono-agent-provider-usage__*", "*"]) {
      expect(isProviderUsageToolAllowed({ allowedTools: [alias] })).toBe(true);
      expect(isProviderUsageToolAllowed({ allowedTools: ["*"], disallowedTools: [alias] })).toBe(false);
    }
    expect(isProviderUsageToolAllowed({ allowedTools: ["Read"] })).toBe(false);
    expect(PROVIDER_USAGE_INPUT.safeParse({}).success).toBe(true);
    expect(PROVIDER_USAGE_INPUT.safeParse({ provider: "anthropic" }).success).toBe(true);
    expect(PROVIDER_USAGE_INPUT.safeParse({ provider: "github-copilot" }).success).toBe(true);
    expect(PROVIDER_USAGE_INPUT.safeParse({ provider: "other" }).success).toBe(false);
    expect(PROVIDER_USAGE_INPUT.safeParse({ url: "https://foreign" }).success).toBe(false);
    expect(PROVIDER_USAGE_INPUT.safeParse({ refresh: true }).success).toBe(true);
    expect(PROVIDER_USAGE_INPUT.safeParse({ refresh: false }).success).toBe(true);
    expect(PROVIDER_USAGE_INPUT.safeParse({ provider: "anthropic", refresh: true }).success).toBe(true);
    expect(PROVIDER_USAGE_INPUT.safeParse({ refresh: "yes" }).success).toBe(false);
    expect(PROVIDER_USAGE_INPUT.safeParse({ refresh: 1 }).success).toBe(false);
  });
  it("routes refresh:true through operator.refresh with the provider filter and keeps cached reads by default", async () => {
    const cached = { schema: "mono-agent.provider-usage.v1" as const, providers: [] };
    const fresh = { schema: "mono-agent.provider-usage.v1" as const, providers: [] };
    const snapshot = vi.fn(async () => cached);
    const refresh = vi.fn(async () => fresh);
    const bound = await createProviderUsageRuntimeExtension({ snapshot, refresh }, { allowedTools: ["ProviderUsage"] })(request());
    const spec = (bound.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-provider-usage"]!;
    const client = new Client({ name: "synthetic-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      expect((await client.listTools()).tools[0]?.description).toMatch(/refresh is true/);
      expect((await client.callTool({ name: "ProviderUsage", arguments: {} })).structuredContent).toEqual({ ...cached, projection: { providers: [] } });
      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(refresh).not.toHaveBeenCalled();
      await client.callTool({ name: "ProviderUsage", arguments: { provider: "anthropic" } });
      expect(snapshot).toHaveBeenCalledTimes(2);
      expect(snapshot).toHaveBeenLastCalledWith("anthropic");
      expect(refresh).not.toHaveBeenCalled();
      const forced = await client.callTool({ name: "ProviderUsage", arguments: { refresh: true, provider: "opencode-go" } });
      expect(forced.structuredContent).toEqual({ ...fresh, projection: { providers: [] } });
      expect(forced.content).toEqual([{ type: "text", text: JSON.stringify({ ...fresh, projection: { providers: [] } }) }]);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith("opencode-go");
      await client.callTool({ name: "ProviderUsage", arguments: { refresh: false } });
      expect(snapshot).toHaveBeenCalledTimes(3);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect((await client.callTool({ name: "ProviderUsage", arguments: { refresh: "yes" } })).isError).toBe(true);
      expect(snapshot).toHaveBeenCalledTimes(3);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally { await client.close(); await bound.cleanup?.(); }
  });
  it("falls back to the cached snapshot when the operator has no refresh", async () => {
    const cached = { schema: "mono-agent.provider-usage.v1" as const, providers: [] };
    const snapshot = vi.fn(async () => cached);
    const bound = await createProviderUsageRuntimeExtension({ snapshot }, { allowedTools: ["ProviderUsage"] })(request());
    const spec = (bound.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-provider-usage"]!;
    const client = new Client({ name: "synthetic-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const forced = await client.callTool({ name: "ProviderUsage", arguments: { refresh: true } });
      expect(forced.isError ?? false).toBe(false);
      expect(forced.structuredContent).toEqual({ ...cached, projection: { providers: [] } });
      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(snapshot).toHaveBeenCalledWith(undefined);
    } finally { await client.close(); await bound.cleanup?.(); }
  });
  it("projects burn pace with a warning for over-pace windows and omits it on track", async () => {
    const codex = { providerId: "openai-codex" as const, label: "Codex", plan: "Pro 20x", fetchedAt: "2026-09-22T09:35:00.000Z", stale: false,
      windows: [{ kind: "weekly" as const, label: "Weekly" as const, usedPercent: 96, resetsAt: "2026-09-26T08:10:22.000Z", periodMs: 604800000 }] };
    const snapshot = { schema: "mono-agent.provider-usage.v1" as const, providers: [codex] };
    const bound = await createProviderUsageRuntimeExtension({ snapshot: async () => snapshot }, { allowedTools: ["ProviderUsage"] })(request());
    const spec = (bound.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-provider-usage"]!;
    const client = new Client({ name: "synthetic-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const result = await client.callTool({ name: "ProviderUsage", arguments: {} });
      const body = result.structuredContent as Record<string, unknown>;
      expect(body.schema).toBe("mono-agent.provider-usage.v1");
      expect(body.providers).toEqual(snapshot.providers);
      const projection = body.projection as { providers: { providerId: string; anchor: string; windows: Record<string, unknown>[] }[]; warning?: string };
      expect(projection.providers).toHaveLength(1);
      expect(projection.providers[0]).toMatchObject({ providerId: "openai-codex", anchor: codex.fetchedAt });
      const window = projection.providers[0]!.windows[0]!;
      expect(window.kind).toBe("weekly");
      expect(window.severity).toBe("unsustainable");
      expect(window.confidence).toBe("normal");
      expect(window.pace as number).toBeGreaterThan(1.5);
      expect(window.pace).toBeCloseTo(2.2, 2);
      expect(window.elapsedFraction).toBeCloseTo(0.44, 2);
      expect(Date.parse(window.exhaustsAt as string)).toBeGreaterThan(Date.parse(codex.fetchedAt));
      expect(Date.parse(window.exhaustsAt as string)).toBeLessThan(Date.parse(codex.windows[0]!.resetsAt!));
      expect(window.leadMs).toBe(Date.parse(codex.windows[0]!.resetsAt!) - Date.parse(window.exhaustsAt as string));
      expect(window).not.toHaveProperty("projectedUnusedPercent");
      expect(projection.warning).toMatch(/Codex Weekly is projected to run out \S+, \d+d \d+h before its \S+ reset\./);
      expect(projection.warning).toContain(`${formatProviderUsageLead(window.leadMs as number)} before its`);
      expect(JSON.parse((result.content as [{ text: string }])[0]!.text)).toEqual(body);
    } finally { await client.close(); await bound.cleanup?.(); }
  });
  it("omits warning when everything is on track", async () => {
    const calm = { schema: "mono-agent.provider-usage.v1" as const, providers: [{
      providerId: "anthropic" as const, label: "Claude", fetchedAt: "2026-09-22T20:10:22.000Z", stale: false,
      windows: [{ kind: "weekly" as const, label: "Weekly" as const, usedPercent: 25, resetsAt: "2026-09-26T08:10:22.000Z", periodMs: 604800000 }],
    }] };
    const bound = await createProviderUsageRuntimeExtension({ snapshot: async () => calm }, { allowedTools: ["ProviderUsage"] })(request());
    const spec = (bound.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-provider-usage"]!;
    const client = new Client({ name: "synthetic-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const result = await client.callTool({ name: "ProviderUsage", arguments: {} });
      const body = result.structuredContent as Record<string, unknown>;
      expect(body.providers).toEqual(calm.providers);
      expect(body.projection).toEqual({ providers: [{
        providerId: "anthropic", anchor: calm.providers[0]!.fetchedAt,
        windows: [{ kind: "weekly", pace: 0.5, elapsedFraction: 0.5, severity: "ok", confidence: "normal", projectedUnusedPercent: 50 }],
      }] });
    } finally { await client.close(); await bound.cleanup?.(); }
  });
  it("returns a current read for refresh:true instead of a fresh cached value", async () => {
    const output = fileURLToPath(new URL("../../../../output/", import.meta.url));
    await mkdir(output, { recursive: true });
    const root = await mkdtemp(join(output, "usage-refresh-"));
    const vendor = vi.fn(async () => Response.json({ usage: { rolling: { percent: 12 } } }));
    const resolver = Object.assign(vi.fn(), { readCredential: vi.fn(async () => ({ type: "api_key", key: "synthetic-key" })) });
    const service = createProviderUsageService({ copilotCredential: async () => undefined, resolver: resolver as never, fetch: vendor });
    const usage = createAgentProviderUsage({
      config: { runtime: { model: parseMonoRuntimeModelReference("opencode-go:model") } } as MonoAgentConfig,
      drivers: [], input: { cwd: root, configPath: join(root, "config.json"), env: {} }, service,
    });
    const bound = await createProviderUsageRuntimeExtension(usage, { allowedTools: ["ProviderUsage"] })(request());
    const spec = (bound.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-provider-usage"]!;
    const client = new Client({ name: "synthetic-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const first = await client.callTool({ name: "ProviderUsage", arguments: { provider: "opencode-go" } });
      expect(first.structuredContent).toMatchObject({ schema: "mono-agent.provider-usage.v1", providers: [{ windows: [{ usedPercent: 12 }] }] });
      expect(vendor).toHaveBeenCalledTimes(1);
      vendor.mockResolvedValueOnce(Response.json({ usage: { rolling: { percent: 41 } } }));
      const cached = await client.callTool({ name: "ProviderUsage", arguments: { provider: "opencode-go" } });
      expect(cached.structuredContent).toMatchObject({ providers: [{ windows: [{ usedPercent: 12 }] }] });
      expect(vendor).toHaveBeenCalledTimes(1);
      const forced = await client.callTool({ name: "ProviderUsage", arguments: { provider: "opencode-go", refresh: true } });
      expect(forced.structuredContent).toMatchObject({ schema: "mono-agent.provider-usage.v1", providers: [{ windows: [{ usedPercent: 41 }] }] });
      expect(JSON.parse((forced.content as [{ text: string }])[0]!.text)).toEqual(forced.structuredContent);
      expect(vendor).toHaveBeenCalledTimes(2);
    } finally { await client.close(); await bound.cleanup?.(); service.stop(); await rm(root, { recursive: true, force: true }); }
  });
  it.each(["opencode-go", "github-copilot"] as const)("shares %s across MCP and operator -> web HTTP (synthetic vendor smoke)", async (id) => {
    const output = fileURLToPath(new URL("../../../../output/", import.meta.url));
    await mkdir(output, { recursive: true });
    const root = await mkdtemp(join(output, "usage-smoke-"));
    const vendor = vi.fn(async () => Response.json(id === "github-copilot" ? { copilot_plan: "individual", quota_snapshots: { premium_interactions: { percent_remaining: 58 } } } : { usage: { rolling: { percent: 0 }, weekly: { percent: 1 }, monthly: { percent: 17, resetsAt: "2026-10-01T00:00:00Z" } }, email: "DROP_IDENTIFIER" }));
    const resolver = Object.assign(vi.fn(), { readCredential: vi.fn(async (provider: string) => provider !== id ? { type: "oauth", access: "synthetic-inactive", refresh: "synthetic-inactive", expires: Date.now() + 60000 } : id === "github-copilot"
      ? { type: "oauth", access: "synthetic-inference", refresh: "synthetic-github", expires: 0 }
      : { type: "api_key", key: "synthetic-key" }) });
    const service = createProviderUsageService({ copilotCredential: async () => undefined, resolver: resolver as never, fetch: vendor });
    const usage = createAgentProviderUsage({
      config: { runtime: { model: parseMonoRuntimeModelReference(`${id}:model`) } } as MonoAgentConfig,
      drivers: [], input: { cwd: root, configPath: join(root, "config.json"), env: {} }, service,
    });
    const operator = await startTuiAdapter({ host: "127.0.0.1", port: 0, apiKey: "synthetic-owner", providerUsage: usage, responder: { respond: async () => ({ text: "unused" }) } });
    let web: Awaited<ReturnType<typeof startWebServer>> | undefined;
    const bound = await createProviderUsageRuntimeExtension(usage, { allowedTools: ["ProviderUsage"] })(request());
    const spec = (bound.runtimeOptions?.mcpServers as Record<string, { url: string }>)["mono-agent-provider-usage"]!;
    const client = new Client({ name: "synthetic-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["ProviderUsage"]);
      expect(tools.tools[0]?.annotations?.readOnlyHint).toBe(true);
      expect((await client.callTool({ name: "ProviderUsage", arguments: { provider: "anthropic" } })).structuredContent).toEqual({ schema: "mono-agent.provider-usage.v1", providers: [], projection: { providers: [] } });
      expect(resolver.readCredential).not.toHaveBeenCalled();
      expect(vendor).not.toHaveBeenCalled();
      const result = await client.callTool({ name: "ProviderUsage", arguments: { provider: id } });
      expect((await client.callTool({ name: "ProviderUsage", arguments: { provider: "other" } })).isError).toBe(true);
      expect((await fetch(`${operator.baseUrl}/v1/provider-usage`)).status).toBe(401);
      const headers = { authorization: "Bearer synthetic-owner" };
      expect((await fetch(`${operator.baseUrl}/v1/provider-usage?provider=other`, { headers })).status).toBe(400);
      expect(await (await fetch(`${operator.baseUrl}/v1/info`, { headers })).json()).toMatchObject({ capabilities: { providerUsage: { version: 1, refresh: true } } });
      await writeFile(join(root, "index.html"), "<!doctype html><title>Automated fixture</title>");
      web = await startWebServer({ port: 0, stateDir: join(root, "state"), staticDir: root, discoveryIntervalMs: 0, purgeIntervalMs: 0,
        discoverImpl: async () => [{ baseUrl: operator.baseUrl, apiKey: "synthetic-owner", source: {
          schema: "agent-runtime.trace-source.v1", sourceId: "fixture-agent", label: "Synthetic fixture", artifactDir: join(root, "artifacts"), pid: process.pid,
          status: "running", health: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), warnings: [],
        } }],
      });
      const base = `http://127.0.0.1:${web.port}`;
      const response = await fetch(`${base}/api/v1/agents/fixture-agent/provider-usage?provider=${id}`, { headers: { "X-Mono-Agent-Web-Origin": base } });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const body = await response.json();
      // The web route serves the raw v1 snapshot; the tool adds a sibling projection key.
      const toolResult = result.structuredContent as { schema: unknown; providers: unknown };
      expect(body).toEqual({ schema: toolResult.schema, providers: toolResult.providers });
      expect(JSON.stringify(body)).not.toMatch(/synthetic-key|synthetic-inference|synthetic-github|DROP_IDENTIFIER/);
      expect(vendor).toHaveBeenCalledTimes(1);
      expect(resolver).not.toHaveBeenCalled();
      if (id === "github-copilot") expect(vendor).toHaveBeenCalledWith("https://api.github.com/copilot_internal/user", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "token synthetic-github" }) }));
      expect((await fetch(`${base}/api/v1/agents/fixture-agent/provider-usage?provider=anthropic`, { headers: { "X-Mono-Agent-Web-Origin": base } })).status).toBe(200);
      expect((await fetch(`${base}/api/v1/agents/fixture-agent/provider-usage?provider=other`, { headers: { "X-Mono-Agent-Web-Origin": base } })).status).toBe(400);
      expect((await fetch(`${base}/api/v1/agents/fixture-agent/provider-usage`, { headers: { "X-Mono-Agent-Web-Origin": "https://foreign.invalid" } })).status).toBe(403);
      expect((await new OperatorClient({ baseUrl: operator.baseUrl, apiKey: "synthetic-owner" }).info()).supportsProviderUsageRefresh).toBe(true);
      const post = { method: "POST", headers: { "X-Mono-Agent-Web-Origin": base, "Content-Type": "application/json" }, body: "{}" };
      const refreshUrl = `${base}/api/v1/agents/fixture-agent/provider-usage/refresh`;
      expect((await fetch(`${operator.baseUrl}/v1/provider-usage/refresh`, { method: "POST" })).status).toBe(401);
      for (const suffix of ["?provider=other", "?provider=anthropic&provider=opencode-go", "?refresh=true"]) {
        expect((await fetch(`${operator.baseUrl}/v1/provider-usage/refresh${suffix}`, { method: "POST", headers })).status).toBe(400);
        expect((await fetch(refreshUrl + suffix, post)).status).toBe(400);
      }
      for (const body of ["[]", "null", '{"force":true}', "{"]) {
        expect((await fetch(`${operator.baseUrl}/v1/provider-usage/refresh`, { ...post, headers: { ...headers, "Content-Type": "application/json" }, body })).status).toBe(400);
        expect((await fetch(refreshUrl, { ...post, body })).status).toBe(400);
      }
      expect((await fetch(refreshUrl, { ...post, headers: { ...post.headers, "X-Mono-Agent-Web-Origin": "https://foreign.invalid" } })).status).toBe(403);
      expect((await fetch(refreshUrl, { ...post, headers: { ...post.headers, "Content-Type": "text/plain" }, body: "force" })).status).toBe(400);
      expect((await fetch(`${operator.baseUrl}/v1/provider-usage/refresh`, { method: "POST", headers: { ...headers, "Content-Type": "text/plain" }, body: "force" })).status).toBe(400);
      expect(vendor).toHaveBeenCalledTimes(1);
      vendor.mockResolvedValueOnce(Response.json(id === "github-copilot" ? { quota_snapshots: { premium_interactions: { percent_remaining: 59 } } } : { usage: { rolling: { percent: 41 } } }));
      const refreshed = await fetch(refreshUrl, post);
      expect(refreshed.status).toBe(200);
      expect(refreshed.headers.get("cache-control")).toContain("no-store");
      expect(await refreshed.json()).toMatchObject({ providers: [{ windows: [{ usedPercent: 41 }] }] });
      expect(vendor).toHaveBeenCalledTimes(2); // Same service, still inside successful TTL.
      const cached = await client.callTool({ name: "ProviderUsage", arguments: {} });
      expect(cached.structuredContent).toMatchObject({ providers: [{ windows: [{ usedPercent: 41 }] }] });
      expect(vendor).toHaveBeenCalledTimes(2);
      expect(new Set(resolver.readCredential.mock.calls.map(([provider]) => provider))).toEqual(new Set([id]));

    } finally { await client.close(); await bound.cleanup?.(); await web?.stop(); await operator.stop(); service.stop(); await rm(root, { recursive: true, force: true }); }
  });
  it("keeps old snapshot-only operators compatible without advertising or faking refresh", async () => {
    const snapshot = vi.fn(async () => ({ schema: "mono-agent.provider-usage.v1" as const, providers: [] }));
    const operator = await startTuiAdapter({ host: "127.0.0.1", port: 0, providerUsage: { snapshot }, responder: { respond: async () => ({ text: "unused" }) } });
    try {
      const client = new OperatorClient({ baseUrl: operator.baseUrl });
      expect(await client.info()).toMatchObject({ supportsProviderUsage: true });
      expect((await client.info()).supportsProviderUsageRefresh).toBeUndefined();
      expect(await client.providerUsage()).toEqual({ schema: "mono-agent.provider-usage.v1", providers: [] });
      const unavailable = await fetch(`${operator.baseUrl}/v1/provider-usage/refresh`, { method: "POST" });
      expect(unavailable.status).toBe(409);
      expect(unavailable.headers.get("cache-control")).toContain("no-store");
      expect(snapshot).toHaveBeenCalledTimes(1);
    } finally { await operator.stop(); }
  });
  it("omits tool when denied and detects absent usage capability", async () => {
    const bound = await createProviderUsageRuntimeExtension({ snapshot: vi.fn() }, { allowedTools: ["Read"] })(request());
    expect(bound.runtimeOptions).toEqual({});
    const operator = await startTuiAdapter({ host: "127.0.0.1", port: 0, responder: { respond: async () => ({ text: "unused" }) } });
    try {
      expect((await new OperatorClient({ baseUrl: operator.baseUrl }).info()).supportsProviderUsage).toBeUndefined();
      expect((await fetch(`${operator.baseUrl}/v1/provider-usage`)).status).toBe(503);
    } finally { await operator.stop(); }
  });
});
