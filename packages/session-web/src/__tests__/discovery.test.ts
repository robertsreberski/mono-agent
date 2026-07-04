import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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

  it("falls back to the artifact dir's parent for cwd when no config path is recorded", async () => {
    const registryDir = await tmp("reg");
    const agentDir = await tmp("agent");
    const artifactDir = join(agentDir, "runs");
    await registerSource({ registryDir, sourceId: "agent-two", label: "Agent Two", artifactDir });

    const discovered = await discoverWebInstances({ registryDirs: [registryDir] });

    expect(discovered[0]?.instance.cwd).toBe(dirname(resolve(artifactDir)));
    expect(discovered[0]?.liveBaseUrl).toBeUndefined();
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
