import { describe, expect, it, vi } from "vitest";
import { PROVIDER_USAGE_IDS, PROVIDER_USAGE_SCHEMA, type ProviderUsageId } from "@mono-agent/agent-contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";
import { MonoAgentAppController } from "../app-controller.js";
import type { ChannelDriver } from "../channels.js";
import { createAgentProviderUsage } from "../provider-usage-scope.js";
import { createProviderUsageService } from "../provider-usage.js";

const input = { cwd: "/synthetic", configPath: "/synthetic/config.json", env: {} };
function config(primary: string, fallbacks: string[] = []): MonoAgentConfig {
  return { runtime: { model: parseMonoRuntimeModelReference(primary), fallbacks: fallbacks.map((model) => ({ model: parseMonoRuntimeModelReference(model) })) }, providers: { piAuthPath: "/synthetic/shared-auth.json" } } as unknown as MonoAgentConfig;
}
function driver(id: "cron" | "webhook", loadConfig: () => Promise<unknown>): ChannelDriver {
  return { id, loadConfig } as unknown as ChannelDriver;
}
function fixture() {
  const credential = { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 60_000 };
  const resolver = Object.assign(vi.fn(async () => "synthetic-access"), { readCredential: vi.fn(async (id: string) => id === "opencode-go" ? { type: "api_key", key: "synthetic-key" } : credential) });
  const local = vi.fn(async () => "synthetic-local");
  const fetch = vi.fn(async () => Response.json({ five_hour: { utilization: 20 }, rate_limit: { primary_window: { used_percent: 30 } }, usage: { rolling: { percent: 40 } }, quota_snapshots: { premium_interactions: { percent_remaining: 50 } } }));
  const service = createProviderUsageService({ resolver: resolver as never, fetch, copilotCredential: local });
  return { service, resolver, local, fetch };
}

describe("agent-scoped provider usage", () => {
  it.each(["snapshot", "refresh"] as const)("%s visits only active supported primary/fallback providers", async (method) => {
    const f = fixture();
    const usage = createAgentProviderUsage({ config: config("anthropic:model", ["openai:model", "opencode-go:model", "anthropic:other"]), drivers: [], input, service: f.service });
    try {
      expect((await usage[method]()).providers.map((p) => p.providerId)).toEqual(["anthropic", "opencode-go"]);
      expect(f.fetch).toHaveBeenCalledTimes(2);
      expect(new Set(f.resolver.readCredential.mock.calls.map(([id]) => id))).toEqual(new Set(["anthropic", "opencode-go"]));
      expect(f.local).not.toHaveBeenCalled();
    } finally { f.service.stop(); }
  });

  it.each(["snapshot", "refresh"] as const)("%s rejects explicit inactive providers before all credential/vendor work", async (method) => {
    const f = fixture();
    const usage = createAgentProviderUsage({ config: config("openai:model"), drivers: [], input, service: f.service });
    try {
      for (const id of [undefined, ...PROVIDER_USAGE_IDS]) expect(await usage[method](id)).toEqual({ schema: PROVIDER_USAGE_SCHEMA, providers: [] });
      expect(f.resolver.readCredential).not.toHaveBeenCalled();
      expect(f.resolver).not.toHaveBeenCalled();
      expect(f.local).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
    } finally { f.service.stop(); }
  });

  it("reloads enabled memory/cron/webhook references using auth semantics, without a retained allowlist", async () => {
    const read = vi.fn(async (providerId?: ProviderUsageId) => ({ schema: PROVIDER_USAGE_SCHEMA, providers: providerId ? [{ providerId, label: providerId, windows: [], fetchedAt: "2026-09-14T12:00:00Z", stale: false }] : [] }));
    let cron = { jobs: [{ model: "opencode-go:model", enabled: true }, { model: "github-copilot:model", enabled: false }] };
    let webhook = { enabled: true, endpoints: [{ model: "github-copilot:model", enabled: true }, { model: "openai-codex:model", enabled: false }] };
    const cronLoad = vi.fn(async () => cron);
    const webhookLoad = vi.fn(async () => webhook);
    const usage = createAgentProviderUsage({
      config: { ...config("openai:model"), memory: { llm: { provider: "agent-host", model: "anthropic:model" } } } as MonoAgentConfig,
      drivers: [driver("cron", cronLoad), driver("webhook", webhookLoad)], input, service: { snapshot: read, refresh: read },
    });
    expect((await usage.snapshot()).providers.map((p) => p.providerId)).toEqual(["anthropic", "opencode-go", "github-copilot"]);
    expect(cronLoad).toHaveBeenCalledWith(input);
    expect(webhookLoad).toHaveBeenCalledWith(input);
    cron = { jobs: [] };
    webhook = { ...webhook, enabled: false };
    expect((await usage.refresh()).providers.map((p) => p.providerId)).toEqual(["anthropic"]);
    expect(await usage.snapshot("github-copilot")).toEqual({ schema: PROVIDER_USAGE_SCHEMA, providers: [] });
  });

  it("keeps controller config generations separately scoped while sharing cache and concurrent refresh flights by auth path", async () => {
    const f = fixture();
    // Inject only the credential/vendor service; exercise the real controller factory.
    const controller = { ...input, configReadPath: input.configPath, drivers: [], providerUsageServices: new Map([["/synthetic/shared-auth.json", f.service]]) } as unknown as MonoAgentAppController;
    const first = MonoAgentAppController.prototype.providerUsageFor.call(controller, config("anthropic:model", ["opencode-go:model"]));
    const second = MonoAgentAppController.prototype.providerUsageFor.call(controller, config("opencode-go:model"));
    try {
      const [a, b] = await Promise.all([first.snapshot(), second.snapshot()]);
      expect(a.providers.map((p) => p.providerId)).toEqual(["anthropic", "opencode-go"]);
      expect(b.providers.map((p) => p.providerId)).toEqual(["opencode-go"]);
      expect(f.fetch).toHaveBeenCalledTimes(2);
      await second.snapshot();
      expect(f.fetch).toHaveBeenCalledTimes(2);
      await Promise.all([first.refresh("opencode-go"), second.refresh("opencode-go")]);
      expect(f.fetch).toHaveBeenCalledTimes(3);
      f.resolver.readCredential.mockClear();
      expect(await second.refresh("anthropic")).toEqual({ schema: PROVIDER_USAGE_SCHEMA, providers: [] });
      expect(f.resolver.readCredential).not.toHaveBeenCalled();
      const reloaded = MonoAgentAppController.prototype.providerUsageFor.call(controller, config("openai:model"));
      expect(await reloaded.snapshot()).toEqual({ schema: PROVIDER_USAGE_SCHEMA, providers: [] });
      expect(f.fetch).toHaveBeenCalledTimes(3);
    } finally { f.service.stop(); }
  });
});
