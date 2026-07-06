import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionWebServerHandle, StartSessionWebServerOptions } from "@mono-agent/session-web";

import { runWeb } from "../web-command.js";

let dir: string | undefined;

afterEach(async () => {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

async function testConfig(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "agent-web-command-test-"));
  const configPath = join(dir, "mono-agent.config.json");
  await writeFile(configPath, JSON.stringify({ traceability: { registryDir: "./trace-sources" } }), "utf8");
  return configPath;
}

async function writeStaleTraceManifest(registryDir: string, sourceId: string): Promise<void> {
  const updatedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  await mkdir(registryDir, { recursive: true });
  await writeFile(
    join(registryDir, `${sourceId}.json`),
    JSON.stringify({
      schema: "agent-runtime.trace-source.v1",
      sourceId,
      label: sourceId,
      artifactDir: join(registryDir, "..", `${sourceId}-artifacts`),
      status: "stopped",
      startedAt: updatedAt,
      updatedAt,
    }),
    "utf8",
  );
}

describe("runWeb", () => {
  it("prints reachability from the actual server URL, not the requested allow flag", async () => {
    const configPath = await testConfig();
    let output = "";
    const stop = vi.fn(async () => undefined);
    const startServer = vi.fn(async (_options: StartSessionWebServerOptions): Promise<SessionWebServerHandle> => {
      return { url: "http://127.0.0.1:4599", stop };
    });

    const code = await runWeb(
      {
        configPath,
        cwd: dir!,
        env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: join(dir!, "global-trace-sources") },
        host: "0.0.0.0",
        allowNonLoopback: true,
        open: false,
      },
      {
        startServer,
        waitForShutdown: async () => undefined,
        stdout: { write: (text) => (output += text) },
      },
    );

    expect(code).toBe(0);
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({ host: "0.0.0.0", port: 4599, allowNonLoopback: true }));
    expect(output).toContain("Loopback only.");
    expect(output).toContain("Reverse proxies should target http://127.0.0.1:4599/");
    expect(output).not.toContain("Bound non-loopback");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("passes the stable default web port when --port is omitted", async () => {
    const configPath = await testConfig();
    let capturedOptions: StartSessionWebServerOptions | undefined;
    const startServer = vi.fn(async (options: StartSessionWebServerOptions): Promise<SessionWebServerHandle> => {
      capturedOptions = options;
      return { url: "http://127.0.0.1:4599/", stop: vi.fn(async () => undefined) };
    });

    await runWeb(
      {
        configPath,
        cwd: dir!,
        env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: join(dir!, "global-trace-sources") },
        open: false,
      },
      {
        startServer,
        waitForShutdown: async () => undefined,
        stdout: { write: () => undefined },
      },
    );

    expect(capturedOptions?.port).toBe(4599);
  });

  it("passes includeMemory through to the session-web server", async () => {
    const configPath = await testConfig();
    let capturedOptions: StartSessionWebServerOptions | undefined;
    const startServer = vi.fn(async (options: StartSessionWebServerOptions): Promise<SessionWebServerHandle> => {
      capturedOptions = options;
      return { url: "http://127.0.0.1:4599/", stop: vi.fn(async () => undefined) };
    });

    await runWeb(
      {
        configPath,
        cwd: dir!,
        env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: join(dir!, "global-trace-sources") },
        open: false,
        includeMemory: true,
      },
      {
        startServer,
        waitForShutdown: async () => undefined,
        stdout: { write: () => undefined },
      },
    );

    expect(capturedOptions?.includeMemory).toBe(true);
  });

  it("passes maxRunsPerInstance through to the session-web server", async () => {
    const configPath = await testConfig();
    let capturedOptions: StartSessionWebServerOptions | undefined;
    const startServer = vi.fn(async (options: StartSessionWebServerOptions): Promise<SessionWebServerHandle> => {
      capturedOptions = options;
      return { url: "http://127.0.0.1:4599/", stop: vi.fn(async () => undefined) };
    });

    await runWeb(
      {
        configPath,
        cwd: dir!,
        env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: join(dir!, "global-trace-sources") },
        open: false,
        maxRunsPerInstance: 500,
      },
      {
        startServer,
        waitForShutdown: async () => undefined,
        stdout: { write: () => undefined },
      },
    );

    expect(capturedOptions?.maxRunsPerInstance).toBe(500);
  });

  it("prints a non-loopback hint when the server actually binds a non-loopback URL", async () => {
    const configPath = await testConfig();
    let output = "";
    const startServer = vi.fn(async (): Promise<SessionWebServerHandle> => {
      return { url: "http://0.0.0.0:4599", stop: vi.fn(async () => undefined) };
    });

    await runWeb(
      {
        configPath,
        cwd: dir!,
        env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: join(dir!, "global-trace-sources") },
        host: "0.0.0.0",
        allowNonLoopback: true,
        open: false,
      },
      {
        startServer,
        waitForShutdown: async () => undefined,
        stdout: { write: (text) => (output += text) },
      },
    );

    expect(output).toContain("Bound non-loopback");
  });

  it("passes an auth token to non-loopback servers and prints a tokenized URL", async () => {
    const configPath = await testConfig();
    let output = "";
    let capturedOptions: StartSessionWebServerOptions | undefined;
    const openUrl = vi.fn();
    const startServer = vi.fn(async (options: StartSessionWebServerOptions): Promise<SessionWebServerHandle> => {
      capturedOptions = options;
      return { url: "http://0.0.0.0:4599", stop: vi.fn(async () => undefined) };
    });

    await runWeb(
      {
        configPath,
        cwd: dir!,
        env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: join(dir!, "global-trace-sources") },
        host: "0.0.0.0",
        allowNonLoopback: true,
      },
      {
        startServer,
        openUrl,
        waitForShutdown: async () => undefined,
        stdout: { write: (text) => (output += text) },
      },
    );

    expect(capturedOptions?.authToken).toMatch(/^[a-f0-9]{64}$/u);
    expect(output).toContain(`token=${capturedOptions?.authToken}`);
    expect(openUrl).toHaveBeenCalledWith(expect.stringContaining(`token=${capturedOptions?.authToken}`));
  });

  it("prunes stale manifests from configured and global registries before serving", async () => {
    const configPath = await testConfig();
    const configuredRegistryDir = join(dir!, "trace-sources");
    const globalRegistryDir = join(dir!, "global-trace-sources");
    await writeStaleTraceManifest(configuredRegistryDir, "configured-old");
    await writeStaleTraceManifest(globalRegistryDir, "global-old");
    const startServer = vi.fn(async (): Promise<SessionWebServerHandle> => {
      expect(await readdir(configuredRegistryDir)).toEqual([]);
      expect(await readdir(globalRegistryDir)).toEqual([]);
      return { url: "http://127.0.0.1:4599", stop: vi.fn(async () => undefined) };
    });

    const code = await runWeb(
      {
        configPath,
        cwd: dir!,
        env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: globalRegistryDir },
        open: false,
      },
      {
        startServer,
        waitForShutdown: async () => undefined,
        stdout: { write: () => undefined },
      },
    );

    expect(code).toBe(0);
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      registryDirs: [configuredRegistryDir, globalRegistryDir],
    }));
  });
});
