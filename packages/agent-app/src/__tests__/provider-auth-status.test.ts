import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MonoAgentConfig } from "@mono-agent/config";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";
import { afterEach, describe, expect, it } from "vitest";

import type { ChannelDriver } from "../channels.js";
import { createProviderAuthObservationTracker } from "../provider-auth-observations.js";
import { collectUsedProviderReferences, providerAuthStatusSnapshot } from "../provider-auth-status.js";

const tempDirs: string[] = [];
afterEach(async () => await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true }))));

describe("provider auth status", () => {
  it("collects effective routes and excludes disabled static entries", async () => {
    const config = configWith("/missing");
    const drivers = [{
      id: "cron", label: "Cron", loadConfig: async () => ({ jobs: [
        { model: "anthropic:claude-sonnet-4-5" },
        { model: "openai:gpt-5.5", enabled: false },
      ] }),
    }] as unknown as readonly ChannelDriver[];
    const refs = await collectUsedProviderReferences(config, drivers, { cwd: "/tmp", configPath: "/tmp/config.json", env: {} });
    expect(refs.map(({ usage }) => [usage.kind, usage.model])).toEqual([
      ["primary", "opencode-go:kimi-k2.6"],
      ["fallback", "openai-codex:gpt-5.6-terra"],
      ["memory_llm", "anthropic:claude-sonnet-4-5"],
      ["cron", "anthropic:claude-sonnet-4-5"],
    ]);
  });

  it("reports stored, expired, and keyless local states separately from live verification", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-provider-status-"));
    tempDirs.push(dir);
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, `${JSON.stringify({
      "opencode-go": { type: "api_key", key: "secret-not-projected" },
      "openai-codex": { type: "oauth", access: "access", refresh: "refresh", expires: 1 },
    })}\n`, { mode: 0o600 });
    await chmod(authPath, 0o600);
    const config = {
      ...configWith(authPath),
      providers: {
        piAuthPath: authPath,
        local: [{ id: "anthropic", type: "openai_compat", baseUrl: "http://127.0.0.1:9999", enabled: true }],
      },
    } as unknown as MonoAgentConfig;
    const tracker = createProviderAuthObservationTracker(() => Date.parse("2026-09-06T12:00:00.000Z"));
    tracker.observe({ runId: "r", conversationId: "c", status: "succeeded", durationMs: 1, eventCount: 0, artifactPaths: [], model: "opencode-go:kimi-k2.6" });
    const snapshot = await providerAuthStatusSnapshot({ config, env: {}, drivers: [], input: { cwd: dir, configPath: join(dir, "config.json"), env: {} }, observations: tracker });
    expect(snapshot.providers.find((item) => item.providerId === "opencode-go")).toMatchObject({ state: "present", source: "stored", verification: "verified_by_live_request" });
    expect(snapshot.providers.find((item) => item.providerId === "openai-codex")).toMatchObject({ state: "expired", credentialType: "oauth", verification: "not_verified" });
    expect(snapshot.providers.find((item) => item.providerId === "anthropic")).toMatchObject({ state: "not_applicable", methods: [] });
    expect(JSON.stringify(snapshot)).not.toContain("secret-not-projected");
  });

  it("fails malformed OAuth expiry closed and detects an ambient API key without projecting it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-provider-status-invalid-"));
    tempDirs.push(dir);
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, `${JSON.stringify({
      "openai-codex": { type: "oauth", access: "access", refresh: "refresh", expires: 1e100 },
    })}\n`, { mode: 0o600 });
    const tracker = createProviderAuthObservationTracker();
    const openAi = await providerAuthStatusSnapshot({
      config: { ...configWith(authPath), runtime: { model: parseMonoRuntimeModelReference("openai-codex:gpt-5.6-terra") } } as unknown as MonoAgentConfig,
      env: {}, drivers: [], input: { cwd: dir, configPath: join(dir, "config.json"), env: {} }, observations: tracker,
    });
    expect(openAi.providers[0]).toMatchObject({
      state: "missing",
      credentialType: "oauth",
      unavailableReason: "Stored OAuth credential has an invalid expiry.",
    });

    const ambientSecret = "OPENCODE_AMBIENT_SENTINEL";
    const openCode = await providerAuthStatusSnapshot({
      config: { ...configWith(join(dir, "missing.json")), runtime: { model: parseMonoRuntimeModelReference("opencode-go:kimi-k2.6") } } as unknown as MonoAgentConfig,
      env: { OPENCODE_API_KEY: ambientSecret }, drivers: [], input: { cwd: dir, configPath: join(dir, "config.json"), env: {} }, observations: tracker,
    });
    expect(openCode.providers[0]).toMatchObject({ state: "present", credentialType: "api_key", source: "environment" });
    expect(JSON.stringify(openCode)).not.toContain(ambientSecret);

    await writeFile(join(dir, "unsafe.json"), "{}\n", { mode: 0o644 });
    await chmod(join(dir, "unsafe.json"), 0o644);
    const withUnsafeStore = await providerAuthStatusSnapshot({
      config: { ...configWith(join(dir, "unsafe.json")), runtime: { model: parseMonoRuntimeModelReference("opencode-go:kimi-k2.6") } } as unknown as MonoAgentConfig,
      env: { OPENCODE_API_KEY: ambientSecret }, drivers: [], input: { cwd: dir, configPath: join(dir, "config.json"), env: {} }, observations: tracker,
    });
    expect(withUnsafeStore.providers[0]).toMatchObject({ state: "present", source: "environment" });

    const wrongTypePath = join(dir, "wrong-type.json");
    await writeFile(wrongTypePath, `${JSON.stringify({
      "opencode-go": { type: "oauth", access: "wrong-type", refresh: "wrong-type", expires: Date.now() + 60_000 },
    })}\n`, { mode: 0o600 });
    const wrongType = await providerAuthStatusSnapshot({
      config: { ...configWith(wrongTypePath), runtime: { model: parseMonoRuntimeModelReference("opencode-go:kimi-k2.6") } } as unknown as MonoAgentConfig,
      env: {}, drivers: [], input: { cwd: dir, configPath: join(dir, "config.json"), env: {} }, observations: tracker,
    });
    expect(wrongType.providers[0]).toMatchObject({
      state: "missing", credentialType: "oauth", unavailableReason: "Stored credential type is not supported by this provider.",
    });
    expect(wrongType.providers[0]).not.toHaveProperty("source");

    const profilePath = join(dir, "profile.json");
    await writeFile(profilePath, `${JSON.stringify({
      "amazon-bedrock": { type: "api_key", env: { AWS_PROFILE: "stored-profile" } },
    })}\n`, { mode: 0o600 });
    const profile = await providerAuthStatusSnapshot({
      config: { ...configWith(profilePath), runtime: { model: parseMonoRuntimeModelReference("amazon-bedrock:global.anthropic.claude-sonnet-4-5-v1:0") } } as unknown as MonoAgentConfig,
      env: {}, drivers: [], input: { cwd: dir, configPath: join(dir, "config.json"), env: {} }, observations: tracker,
    });
    expect(profile.providers[0]).toMatchObject({ state: "present", credentialType: "api_key", source: "stored" });
  });
});

function configWith(authPath: string): MonoAgentConfig {
  return {
    runtime: {
      model: parseMonoRuntimeModelReference("opencode-go:kimi-k2.6"),
      fallbacks: [{ model: parseMonoRuntimeModelReference("openai-codex:gpt-5.6-terra") }],
    },
    memory: { llm: { provider: "agent-host", model: "anthropic:claude-sonnet-4-5" } },
    providers: { piAuthPath: authPath },
  } as unknown as MonoAgentConfig;
}
