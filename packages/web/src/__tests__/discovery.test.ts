import { createHmac } from "node:crypto";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverAcpBridgeAgents,
  discoverOperatorAgents,
  isTrustedOperatorBaseUrl,
  operatorBaseUrlFromMetadata,
} from "../discovery.js";
import { temporaryRoot } from "./helpers.js";

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe("operator discovery", () => {
  it("publishes a canonical, secret-free ACP bridge discovery contract", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const registry = join(base, "registry");
    const workspace = join(base, "workspace");
    await mkdir(registry);
    await mkdir(workspace);
    const configPath = join(base, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify({
      runtime: { workspace: "workspace" },
      tui: { apiKey: "must-never-leak" },
      mcp: { servers: { private: { env: { TOKEN: "also-secret" } } } },
    }));
    await writeFile(join(registry, "agent-one.json"), JSON.stringify({
      schema: "agent-runtime.trace-source.v1",
      sourceId: "agent-one",
      label: "Agent One",
      artifactDir: join(base, "artifacts"),
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      configPath,
      metadata: {
        channels: {
          tui: {
            kind: "running",
            baseUrl: "http://127.0.0.1:5555/gui",
            acpBridge: {
              schema: "mono-agent.acp-source.v1",
              bridgeVersion: 1,
              protocolVersion: 1,
              installedVersion: "0.18.0",
              workspacePath: workspace,
            },
          },
        },
      },
    }));

    const found = await discoverAcpBridgeAgents({ registryDirs: [registry], env: {} });

    expect(found).toEqual({
      schema: "mono-agent.acp-discovery.v1",
      bridgeVersion: 1,
      protocolVersion: 1,
      sources: [{
        schema: "mono-agent.acp-source.v1",
        bridgeVersion: 1,
        protocolVersion: 1,
        installedVersion: "0.18.0",
        sourceId: "agent-one",
        label: "Agent One",
        health: "running",
        compatible: true,
        workspace: { path: workspace, owner: "agent" },
        ownership: { configuration: "agent", workspace: "agent", mcp: "agent" },
        constraints: {
          promptContent: ["text", "resource_link"],
          clientMcp: false,
          clientFilesystem: false,
          clientTerminal: false,
          attachments: false,
          additionalDirectories: false,
        },
        warnings: [],
      }],
    });
    expect(JSON.stringify(found)).not.toMatch(/must-never-leak|also-secret|apiKey|baseUrl|configPath/u);
  });

  it("marks sources without the current bridge metadata as incompatible", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const registry = join(base, "registry");
    await mkdir(registry);
    const configPath = join(base, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify({ runtime: { workspace: "." } }));
    await writeFile(join(registry, "older-agent.json"), JSON.stringify({
      schema: "agent-runtime.trace-source.v1",
      sourceId: "older-agent",
      label: "Older Agent",
      artifactDir: join(base, "artifacts"),
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      configPath,
      metadata: {
        channels: {
          tui: { kind: "running", baseUrl: "http://127.0.0.1:5555/gui" },
        },
      },
    }));

    const found = await discoverAcpBridgeAgents({ registryDirs: [registry], env: {} });

    expect(found.sources[0]).toMatchObject({
      sourceId: "older-agent",
      bridgeVersion: 0,
      protocolVersion: 0,
      installedVersion: "unknown",
      compatible: false,
      workspace: { path: base, owner: "agent" },
      warnings: ["bridge_metadata_missing_or_invalid", "workspace_resolved_from_configuration"],
    });
  });

  it("accepts only credential-free loopback HTTP(S) operator URLs", () => {
    expect(isTrustedOperatorBaseUrl("http://127.0.0.1:4321/gui")).toBe(true);
    expect(isTrustedOperatorBaseUrl("https://[::1]:4321/gui")).toBe(true);
    expect(isTrustedOperatorBaseUrl("http://localhost:4321/gui")).toBe(true);
    expect(isTrustedOperatorBaseUrl("http://192.168.1.4:4321/gui")).toBe(false);
    expect(isTrustedOperatorBaseUrl("http://user:pass@127.0.0.1:4321/gui")).toBe(false);
    expect(isTrustedOperatorBaseUrl("file:///tmp/socket")).toBe(false);
  });

  it("extracts only running trusted channel metadata", () => {
    expect(operatorBaseUrlFromMetadata({ channels: { tui: { kind: "running", baseUrl: "http://127.0.0.1:1234/gui/" } } }))
      .toBe("http://127.0.0.1:1234/gui");
    expect(operatorBaseUrlFromMetadata({ channels: { tui: { kind: "failed", baseUrl: "http://127.0.0.1:1234/gui" } } })).toBeUndefined();
    expect(operatorBaseUrlFromMetadata({ channels: { tui: { kind: "running", baseUrl: "http://evil.example/gui" } } })).toBeUndefined();
  });

  it("merges registries, filters stopped agents, and resolves the local API key without exposing it in metadata", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const registry = join(base, "registry");
    await mkdir(registry);
    const configPath = join(base, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify({ tui: { apiKey: "  secret  " } }));
    const manifest = {
      schema: "agent-runtime.trace-source.v1",
      sourceId: "agent-one",
      label: "Agent One",
      artifactDir: join(base, "artifacts"),
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      configPath,
      metadata: { channels: { tui: { kind: "running", baseUrl: "http://127.0.0.1:5555/gui" } } },
    };
    await writeFile(join(registry, "agent-one.json"), JSON.stringify(manifest));

    const found = await discoverOperatorAgents({ registryDirs: [registry], env: {} });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ baseUrl: "http://127.0.0.1:5555/gui", apiKey: "secret", source: { sourceId: "agent-one" } });
  });

  it("derives the process-job bearer only from an owner-private advertised state directory", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const registry = join(base, "registry");
    const stateDir = join(base, "process-jobs");
    await mkdir(registry);
    await mkdir(stateDir, { mode: 0o700 });
    const secret = Buffer.alloc(32, 7);
    const secretPath = join(stateDir, "process-jobs-secret");
    await writeFile(secretPath, `${secret.toString("base64url")}\n`, { mode: 0o600 });
    await writeFile(join(registry, "agent-one.json"), JSON.stringify({
      schema: "agent-runtime.trace-source.v1",
      sourceId: "agent-one",
      label: "Agent One",
      artifactDir: join(base, "artifacts"),
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        channels: {
          tui: {
            kind: "running",
            baseUrl: "http://127.0.0.1:5555/gui",
            processJobs: { stateDir },
            monitors: { stateDir },
          },
        },
      },
    }));

    const expected = createHmac("sha256", secret)
      .update("mono-agent-process-job-operator-v1")
      .digest("base64url");
    await expect(discoverOperatorAgents({ registryDirs: [registry], env: {} }))
      .resolves.toEqual([expect.objectContaining({ processJobsBearer: expected })]);

    const monitorBearer = createHmac("sha256", secret).update("mono-agent-monitor-operator-v1").digest("base64url");
    await expect(discoverOperatorAgents({ registryDirs: [registry], env: {} }))
      .resolves.toEqual([expect.objectContaining({ monitorsBearer: monitorBearer })]);

    await chmod(secretPath, 0o644);
    const permissive = await discoverOperatorAgents({ registryDirs: [registry], env: {} });
    expect(permissive[0]).not.toHaveProperty("processJobsBearer");
    expect(permissive[0]).not.toHaveProperty("monitorsBearer");
  });

  it("resolves the documented per-agent dotenv key from an attested background snapshot", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const registry = join(base, "registry");
    await mkdir(registry);
    const configPath = join(base, "mono-agent.config.json");
    const dotenvPath = join(base, ".env");
    await writeFile(configPath, JSON.stringify({ tui: { apiKey: "legacy-inline" } }), { mode: 0o600 });
    await writeFile(dotenvPath, "MONO_AGENT_TUI_API_KEY=' durable-key '\nOTHER_SECRET=never-read\n", { mode: 0o600 });
    await writeFile(join(registry, "agent-one.json"), JSON.stringify({
      schema: "agent-runtime.trace-source.v1",
      sourceId: "agent-one",
      label: "Agent One",
      artifactDir: join(base, "artifacts"),
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      configPath,
      metadata: {
        channels: { tui: { kind: "running", baseUrl: "http://127.0.0.1:5555/gui" } },
        backgroundSnapshot: {
          schema: "mono-agent.background-snapshot.v1",
          configPath,
          configFingerprint: "config-proof",
          dotenvPath,
          dotenvFingerprint: "dotenv-proof",
        },
      },
    }));

    const found = await discoverOperatorAgents({ registryDirs: [registry], env: {} });
    expect(found[0]).toMatchObject({ apiKey: "durable-key" });
    expect(found[0]?.source.metadata).not.toHaveProperty("apiKey");
  });

  it("does not follow a dotenv symlink advertised by trace metadata", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const registry = join(base, "registry");
    await mkdir(registry);
    const configPath = join(base, "mono-agent.config.json");
    const secretPath = join(base, "secret.env");
    const dotenvPath = join(base, ".env");
    await writeFile(configPath, "{}", { mode: 0o600 });
    await writeFile(secretPath, "MONO_AGENT_TUI_API_KEY=must-not-follow\n", { mode: 0o600 });
    await symlink(secretPath, dotenvPath);
    await writeFile(join(registry, "agent-one.json"), JSON.stringify({
      schema: "agent-runtime.trace-source.v1",
      sourceId: "agent-one",
      label: "Agent One",
      artifactDir: join(base, "artifacts"),
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      configPath,
      metadata: {
        channels: { tui: { kind: "running", baseUrl: "http://127.0.0.1:5555/gui" } },
        backgroundSnapshot: {
          schema: "mono-agent.background-snapshot.v1",
          configPath,
          configFingerprint: "config-proof",
          dotenvPath,
          dotenvFingerprint: "dotenv-proof",
        },
      },
    }));

    const found = await discoverOperatorAgents({ registryDirs: [registry], env: {} });
    expect(found[0]?.apiKey).toBeUndefined();
  });
});
