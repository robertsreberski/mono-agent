import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverAcpBridgeAgents } from "@mono-agent/web";
import { afterEach, describe, expect, it } from "vitest";

import { runAcpDiscovery } from "../acp-discovery-command.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe("ACP discovery command", () => {
  it("prints the public discovery result byte-for-byte as one JSON line", async () => {
    const base = await mkdtemp(join(tmpdir(), "mono-agent-acp-discovery-"));
    cleanup.push(base);
    const registry = join(base, "registry");
    const workspace = join(base, "workspace");
    await mkdir(registry);
    await mkdir(workspace);
    await writeFile(join(registry, "personal-agent.json"), JSON.stringify({
      schema: "agent-runtime.trace-source.v1",
      sourceId: "personal-agent",
      label: "Personal Agent",
      artifactDir: join(base, "artifacts"),
      status: "running",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
    const options = { registryDirs: [registry], env: {} } as const;
    const expected = await discoverAcpBridgeAgents(options);
    let output = "";

    const exitCode = await runAcpDiscovery({
      env: { MONO_AGENT_TRACE_REGISTRY_DIR: registry },
      output: { write(chunk) { output += chunk; } },
    });

    expect(exitCode).toBe(0);
    expect(output).toBe(`${JSON.stringify(expected)}\n`);
    expect(JSON.parse(output)).toEqual(expected);
  });
});
