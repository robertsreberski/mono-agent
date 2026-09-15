import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTuiAdapter } from "@mono-agent/operator-adapter";
import { startWebServer, OperatorClient } from "@mono-agent/web";
import type { AgentHarnessRuntimeOptionsInput } from "@mono-agent/agent-harness";
import { describe, expect, it, vi } from "vitest";
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
  });
  it.each(["opencode-go", "github-copilot"] as const)("shares %s across MCP and operator -> web HTTP (synthetic vendor smoke)", async (id) => {
    const output = fileURLToPath(new URL("../../../../output/", import.meta.url));
    await mkdir(output, { recursive: true });
    const root = await mkdtemp(join(output, "usage-smoke-"));
    const vendor = vi.fn(async () => Response.json(id === "github-copilot" ? { copilot_plan: "individual", quota_snapshots: { premium_interactions: { percent_remaining: 58 } } } : { usage: { rolling: { percent: 0 }, weekly: { percent: 1 }, monthly: { percent: 17, resetsAt: "2026-10-01T00:00:00Z" } }, email: "DROP_IDENTIFIER" }));
    const resolver = Object.assign(vi.fn(), { readCredential: async (provider: string) => provider === id ? { type: "api_key", key: "synthetic-key" } : undefined });
    const usage = createProviderUsageService({ copilotCredential: async () => undefined, resolver: resolver as never, fetch: vendor });
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
      expect(body).toEqual(result.structuredContent);
      expect(JSON.stringify(body)).not.toMatch(/synthetic-key|DROP_IDENTIFIER/);
      expect(vendor).toHaveBeenCalledTimes(1);
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

    } finally { await client.close(); await bound.cleanup?.(); await web?.stop(); await operator.stop(); usage.stop(); await rm(root, { recursive: true, force: true }); }
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
