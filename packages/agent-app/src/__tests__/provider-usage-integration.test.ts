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
    expect(PROVIDER_USAGE_INPUT.safeParse({ provider: "other" }).success).toBe(false);
    expect(PROVIDER_USAGE_INPUT.safeParse({ url: "https://foreign" }).success).toBe(false);
  });
  it("shares the real usage service across MCP and operator -> web HTTP (synthetic vendor smoke)", async () => {
    const output = fileURLToPath(new URL("../../../../output/", import.meta.url));
    await mkdir(output, { recursive: true });
    const root = await mkdtemp(join(output, "usage-smoke-"));
    const vendor = vi.fn(async () => Response.json({ usage: { rolling: { percent: 0 }, weekly: { percent: 1 }, monthly: { percent: 17, resetsAt: "2026-10-01T00:00:00Z" } }, email: "DROP_IDENTIFIER" }));
    const resolver = Object.assign(vi.fn(), { readCredential: async (provider: string) => provider === "opencode-go" ? { type: "api_key", key: "synthetic-key" } : undefined });
    const usage = createProviderUsageService({ resolver: resolver as never, fetch: vendor });
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
      const result = await client.callTool({ name: "ProviderUsage", arguments: {} });
      expect((await client.callTool({ name: "ProviderUsage", arguments: { provider: "other" } })).isError).toBe(true);
      expect((await fetch(`${operator.baseUrl}/v1/provider-usage`)).status).toBe(401);
      const headers = { authorization: "Bearer synthetic-owner" };
      expect((await fetch(`${operator.baseUrl}/v1/provider-usage?provider=other`, { headers })).status).toBe(400);
      expect(await (await fetch(`${operator.baseUrl}/v1/info`, { headers })).json()).toMatchObject({ capabilities: { providerUsage: { version: 1 } } });
      await writeFile(join(root, "index.html"), "<!doctype html><title>Automated fixture</title>");
      web = await startWebServer({ port: 0, stateDir: join(root, "state"), staticDir: root, discoveryIntervalMs: 0, purgeIntervalMs: 0,
        discoverImpl: async () => [{ baseUrl: operator.baseUrl, apiKey: "synthetic-owner", source: {
          schema: "agent-runtime.trace-source.v1", sourceId: "fixture-agent", label: "Synthetic fixture", artifactDir: join(root, "artifacts"), pid: process.pid,
          status: "running", health: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), warnings: [],
        } }],
      });
      const base = `http://127.0.0.1:${web.port}`;
      const response = await fetch(`${base}/api/v1/agents/fixture-agent/provider-usage`, { headers: { "X-Mono-Agent-Web-Origin": base } });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const body = await response.json();
      expect(body).toEqual(result.structuredContent);
      expect(JSON.stringify(body)).not.toMatch(/synthetic-key|DROP_IDENTIFIER/);
      expect(vendor).toHaveBeenCalledTimes(1);
      expect((await fetch(`${base}/api/v1/agents/fixture-agent/provider-usage?provider=anthropic`, { headers: { "X-Mono-Agent-Web-Origin": base } })).status).toBe(200);
      expect((await fetch(`${base}/api/v1/agents/fixture-agent/provider-usage?provider=other`, { headers: { "X-Mono-Agent-Web-Origin": base } })).status).toBe(400);
      expect((await fetch(`${base}/api/v1/agents/fixture-agent/provider-usage`, { headers: { "X-Mono-Agent-Web-Origin": "https://foreign.invalid" } })).status).toBe(403);
    } finally { await client.close(); await bound.cleanup?.(); await web?.stop(); await operator.stop(); usage.stop(); await rm(root, { recursive: true, force: true }); }
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
