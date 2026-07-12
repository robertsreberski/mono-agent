import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { registerTraceSource } from "@mono-agent/observability";

import {
  defaultTraceRegistryDir,
  discoverWebInstances,
  liveBaseUrlFromMetadata,
  resolveLiveApiKey,
} from "../discovery.js";
import { makeTmpDir, registerSource, removeDir } from "./helpers.js";

const tmpDirs: string[] = [];

async function tmp(prefix: string): Promise<string> {
  const dir = await makeTmpDir(prefix);
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(removeDir));
});

describe("defaultTraceRegistryDir", () => {
  it("honors MONO_AGENT_TRACE_REGISTRY_DIR, else falls back to ~/.mono-agent/trace-sources", () => {
    expect(defaultTraceRegistryDir({ MONO_AGENT_TRACE_REGISTRY_DIR: "/custom/reg" })).toBe(resolve("/custom/reg"));
    expect(defaultTraceRegistryDir({})).toBe(resolve(homedir(), ".mono-agent", "trace-sources"));
  });
});

describe("liveBaseUrlFromMetadata", () => {
  it("returns the baseUrl only for a running live channel", () => {
    expect(
      liveBaseUrlFromMetadata({ channels: { live: { kind: "running", baseUrl: "http://127.0.0.1:5/live" } } }),
    ).toBe("http://127.0.0.1:5/live");
    expect(
      liveBaseUrlFromMetadata({ channels: { live: { kind: "running", baseUrl: "http://192.0.2.10:5/live" } } }),
    ).toBeUndefined();
    expect(liveBaseUrlFromMetadata({ channels: { live: { kind: "disabled" } } })).toBeUndefined();
    expect(liveBaseUrlFromMetadata({ channels: { live: { kind: "running", baseUrl: "" } } })).toBeUndefined();
    expect(liveBaseUrlFromMetadata({ channels: {} })).toBeUndefined();
    expect(liveBaseUrlFromMetadata(undefined)).toBeUndefined();
  });
});

describe("discoverWebInstances", () => {
  it("maps a running source to a WebInstance with cwd, artifactDir, and live endpoint", async () => {
    const registryDir = await tmp("reg");
    const agentDir = await tmp("agent");
    const artifactDir = join(agentDir, "runs");
    const configPath = join(agentDir, "mono-agent.config.json");
    await registerSource({
      registryDir,
      sourceId: "agent-one",
      label: "Agent One",
      artifactDir,
      configPath,
      liveBaseUrl: "http://127.0.0.1:52789/live",
    });

    const discovered = await discoverWebInstances({ registryDirs: [registryDir] });

    expect(discovered).toHaveLength(1);
    const only = discovered[0];
    expect(only?.instance.sourceId).toBe("agent-one");
    expect(only?.instance.label).toBe("Agent One");
    expect(only?.instance.artifactDir).toBe(resolve(artifactDir));
    // cwd derives from dirname(configPath) when a config path is present.
    expect(only?.instance.cwd).toBe(dirname(resolve(configPath)));
    expect(only?.instance.health).toBe("running");
    expect(only?.instance.liveConnected).toBe(false);
    expect(only?.instance.counts.runs).toBe(0);
    expect(only?.liveBaseUrl).toBe("http://127.0.0.1:52789/live");
  });

  it("projects only normalized memory health and never arbitrary manifest metadata", async () => {
    const registryDir = await tmp("reg-memory-health");
    const agentDir = await tmp("agent-memory-health");
    const artifactDir = join(agentDir, "runs");
    await registerTraceSource({
      registryDir,
      sourceId: "agent-memory",
      label: "Agent Memory",
      artifactDir,
      metadata: {
        privateNote: "must-not-cross-browser-boundary",
        nested: { secret: "also-private" },
      },
      memoryHealth: {
        backend: "bujo",
        mode: "bujo",
        status: "degraded",
        checkedAt: "2026-07-12T08:00:00.000Z",
        issues: ["dead_letters", "outbox_pending"],
        counts: { dead: 2, outbox: 1 },
      },
    });

    const [discovered] = await discoverWebInstances({ registryDirs: [registryDir] });

    expect(discovered?.instance.memoryHealth).toEqual({
      backend: "bujo",
      mode: "bujo",
      status: "degraded",
      checkedAt: "2026-07-12T08:00:00.000Z",
      issues: ["dead_letters", "outbox_pending"],
      counts: { dead: 2, outbox: 1 },
    });
    expect(Object.keys(discovered?.instance ?? {})).not.toContain("metadata");
    expect(JSON.stringify(discovered?.instance)).not.toContain("must-not-cross-browser-boundary");
    expect(JSON.stringify(discovered?.instance)).not.toContain("also-private");
  });

  it("falls back to the artifact dir's parent for cwd when no config path is recorded", async () => {
    const registryDir = await tmp("reg");
    const agentDir = await tmp("agent");
    const artifactDir = join(agentDir, "runs");
    await registerSource({ registryDir, sourceId: "agent-two", label: "Agent Two", artifactDir });

    const discovered = await discoverWebInstances({ registryDirs: [registryDir] });

    expect(discovered[0]?.instance.cwd).toBe(dirname(resolve(artifactDir)));
    expect(discovered[0]?.liveBaseUrl).toBeUndefined();
  });

  it("exposes instance timezone from trace metadata or config without failing discovery", async () => {
    const registryDir = await tmp("reg");
    const metadataAgentDir = await tmp("agent-meta");
    const invalidMetadataAgentDir = await tmp("agent-invalid-meta");
    const configAgentDir = await tmp("agent-config");
    const invalidConfigAgentDir = await tmp("agent-invalid-config");
    const badConfigAgentDir = await tmp("agent-bad-config");
    const configPath = join(configAgentDir, "mono-agent.config.json");
    const invalidConfigPath = join(invalidConfigAgentDir, "mono-agent.config.json");
    const badConfigPath = join(badConfigAgentDir, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify({ runtime: { session: { rolloverTimezone: "Europe/Amsterdam" } } }), "utf8");
    await writeFile(invalidConfigPath, JSON.stringify({ runtime: { session: { rolloverTimezone: "Not/A_Zone" } } }), "utf8");
    await writeFile(badConfigPath, "{not-json", "utf8");
    await registerSource({
      registryDir,
      sourceId: "agent-meta",
      label: "Agent Meta",
      artifactDir: join(metadataAgentDir, "runs"),
      configPath: join(metadataAgentDir, "mono-agent.config.json"),
      metadata: { runtime: { session: { rolloverTimezone: "America/New_York" } } },
    });
    await registerSource({
      registryDir,
      sourceId: "agent-invalid-meta",
      label: "Agent Invalid Meta",
      artifactDir: join(invalidMetadataAgentDir, "runs"),
      metadata: { runtime: { session: { rolloverTimezone: "Not/A_Zone" } } },
    });
    await registerSource({
      registryDir,
      sourceId: "agent-config",
      label: "Agent Config",
      artifactDir: join(configAgentDir, "runs"),
      configPath,
    });
    await registerSource({
      registryDir,
      sourceId: "agent-invalid-config",
      label: "Agent Invalid Config",
      artifactDir: join(invalidConfigAgentDir, "runs"),
      configPath: invalidConfigPath,
    });
    await registerSource({
      registryDir,
      sourceId: "agent-bad-config",
      label: "Agent Bad Config",
      artifactDir: join(badConfigAgentDir, "runs"),
      configPath: badConfigPath,
    });

    const discovered = await discoverWebInstances({ registryDirs: [registryDir] });
    const byId = new Map(discovered.map((item) => [item.instance.sourceId, item.instance]));

    expect(byId.get("agent-meta")).toMatchObject({ timeZone: "America/New_York", timezone: "America/New_York" });
    expect(byId.get("agent-config")).toMatchObject({ timeZone: "Europe/Amsterdam", timezone: "Europe/Amsterdam" });
    expect(byId.get("agent-invalid-meta")?.timeZone).toBeUndefined();
    expect(byId.get("agent-invalid-config")?.timeZone).toBeUndefined();
    expect(byId.get("agent-bad-config")?.timeZone).toBeUndefined();
  });

  it("uses env when resolving the default registry dir", async () => {
    const registryDir = await tmp("env-reg");
    const agentDir = await tmp("agent");
    const artifactDir = join(agentDir, "runs");
    await registerSource({ registryDir, sourceId: "env-agent", label: "Env Agent", artifactDir });

    const discovered = await discoverWebInstances({
      registryDirs: [],
      env: { MONO_AGENT_TRACE_REGISTRY_DIR: registryDir },
    });

    expect(discovered.map((item) => item.instance.sourceId)).toEqual(["env-agent"]);
  });
});

describe("resolveLiveApiKey", () => {
  it("prefers MONO_AGENT_LIVE_API_KEY over the agent config's live.apiKey", async () => {
    const registryDir = await tmp("reg");
    const agentDir = await tmp("agent");
    const artifactDir = join(agentDir, "runs");
    const configPath = join(agentDir, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify({ live: { apiKey: "  from-config  " } }), "utf8");
    await registerSource({ registryDir, sourceId: "agent-key", label: "Agent Key", artifactDir, configPath });

    const [discovered] = await discoverWebInstances({ registryDirs: [registryDir] });
    if (discovered === undefined) {
      throw new Error("expected a discovered instance");
    }

    expect(await resolveLiveApiKey(discovered, { MONO_AGENT_LIVE_API_KEY: "from-env" })).toBe("from-env");
    // No env override → read + trim the agent's own config.
    expect(await resolveLiveApiKey(discovered, {})).toBe("from-config");
  });

  it("does not resolve a live api key for an untrusted live URL", async () => {
    const registryDir = await tmp("reg");
    const agentDir = await tmp("agent");
    const configPath = join(agentDir, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify({ live: { apiKey: "from-config" } }), "utf8");
    await registerSource({
      registryDir,
      sourceId: "agent-key",
      label: "Agent Key",
      artifactDir: join(agentDir, "runs"),
      configPath,
    });

    const [discovered] = await discoverWebInstances({ registryDirs: [registryDir] });
    if (discovered === undefined) {
      throw new Error("expected a discovered instance");
    }

    const withUntrustedUrl = { ...discovered, liveBaseUrl: "http://192.0.2.10:5/live" };
    expect(await resolveLiveApiKey(withUntrustedUrl, { MONO_AGENT_LIVE_API_KEY: "from-env" })).toBeUndefined();
    expect(await resolveLiveApiKey(withUntrustedUrl, {})).toBeUndefined();
  });

  it("resolves undefined when neither env nor config supplies a key", async () => {
    const registryDir = await tmp("reg");
    const agentDir = await tmp("agent");
    const configPath = join(agentDir, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify({ live: {} }), "utf8");
    await registerSource({
      registryDir,
      sourceId: "agent-nokey",
      label: "No Key",
      artifactDir: join(agentDir, "runs"),
      configPath,
    });

    const [discovered] = await discoverWebInstances({ registryDirs: [registryDir] });
    if (discovered === undefined) {
      throw new Error("expected a discovered instance");
    }
    expect(await resolveLiveApiKey(discovered, {})).toBeUndefined();
  });
});
