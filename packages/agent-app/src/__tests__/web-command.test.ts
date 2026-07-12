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
        interactive: true,
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
        interactive: true,
      },
    );

    expect(output).toContain("Bound non-loopback");
    expect(output).toContain("Tailscale Serve is optional");
  });

  it("normalizes an IPv6 wildcard advertisement to a usable bracketed loopback URL", async () => {
    const configPath = await testConfig();
    let output = "";
    const startServer = vi.fn(async (): Promise<SessionWebServerHandle> => ({
      url: "http://[::]:4599/",
      stop: vi.fn(async () => undefined),
    }));

    await runWeb(
      {
        configPath,
        cwd: dir!,
        env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: join(dir!, "global-trace-sources") },
        host: "[::]",
        allowNonLoopback: true,
        open: false,
      },
      {
        startServer,
        waitForShutdown: async () => undefined,
        stdout: { write: (text) => (output += text) },
        interactive: true,
        discoverNetworkAddresses: () => [],
      },
    );

    expect(output).toContain("mono-agent web  →  http://[::1]:4599/");
    expect(output).not.toContain("http://[::]:4599/");
  });

  it("uses the actual wildcard bind to replace an IPv4-mapped unspecified URL", async () => {
    const configPath = await testConfig();
    let output = "";
    const startServer = vi.fn(async (): Promise<SessionWebServerHandle> => ({
      url: "http://[::ffff:0.0.0.0]:4599/",
      boundAddress: "::",
      stop: vi.fn(async () => undefined),
    }));

    await runWeb(
      {
        configPath,
        cwd: dir!,
        env: {
          MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: join(dir!, "global-trace-sources"),
          MONO_AGENT_WEB_AUTH_TOKEN: "stable-test-token",
        },
        host: "[::ffff:0.0.0.0]",
        allowNonLoopback: true,
        open: false,
      },
      {
        startServer,
        waitForShutdown: async () => undefined,
        stdout: { write: (text) => (output += text) },
        discoverNetworkAddresses: () => [
          { address: "192.168.178.103", kind: "lan" },
          { address: "100.64.103.59", kind: "tailscale" },
        ],
      },
    );

    expect(output).toContain("mono-agent web  →  http://127.0.0.1:4599/");
    expect(output).toContain("LAN       →  http://192.168.178.103:4599/");
    expect(output).toContain("Tailscale →  http://100.64.103.59:4599/");
    expect(output).not.toContain("::ffff:0");
    expect(output).not.toContain("stable-test-token");
  });

  it("reports actual non-loopback reachability when localhost resolves to a wildcard", async () => {
    const configPath = await testConfig();
    let output = "";
    const startServer = vi.fn(async (): Promise<SessionWebServerHandle> => ({
      url: "http://localhost:4599/",
      boundAddress: "0.0.0.0",
      stop: vi.fn(async () => undefined),
    }));

    await runWeb(
      {
        configPath,
        cwd: dir!,
        env: {
          MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: join(dir!, "global-trace-sources"),
          MONO_AGENT_WEB_AUTH_TOKEN: "stable-test-token",
        },
        host: "localhost",
        allowNonLoopback: true,
        open: false,
      },
      {
        startServer,
        waitForShutdown: async () => undefined,
        stdout: { write: (text) => (output += text) },
        discoverNetworkAddresses: () => [
          { address: "192.168.178.103", kind: "lan" },
          { address: "100.64.103.59", kind: "tailscale" },
        ],
      },
    );

    expect(output).toContain("mono-agent web  →  http://127.0.0.1:4599/");
    expect(output).toContain("LAN       →  http://192.168.178.103:4599/");
    expect(output).toContain("Tailscale →  http://100.64.103.59:4599/");
    expect(output).toContain("Bound non-loopback: direct HTTP is available");
    expect(output).not.toContain("Loopback only.");
  });

  it("generates auth and prints concrete tokenized loopback, LAN, and Tailscale URLs", async () => {
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
        interactive: true,
        discoverNetworkAddresses: () => [
          { address: "100.64.103.59", kind: "tailscale" },
          { address: "192.168.178.103", kind: "lan" },
        ],
      },
    );

    expect(capturedOptions?.authToken).toMatch(/^[a-f0-9]{64}$/u);
    const token = capturedOptions?.authToken ?? "";
    expect(output).toContain(`mono-agent web  →  http://127.0.0.1:4599/#token=${token}`);
    expect(output).toContain(`LAN       →  http://192.168.178.103:4599/#token=${token}`);
    expect(output).toContain(`Tailscale →  http://100.64.103.59:4599/#token=${token}`);
    expect(output).not.toContain("0.0.0.0");
    expect(output).toContain("bearer token never enters process arguments");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("uses a stable environment token without printing it", async () => {
    const configPath = await testConfig();
    const stableToken = "stable-environment-token";
    let output = "";
    let capturedOptions: StartSessionWebServerOptions | undefined;
    const openUrl = vi.fn();
    const startServer = vi.fn(async (options: StartSessionWebServerOptions): Promise<SessionWebServerHandle> => {
      capturedOptions = options;
      return { url: "http://0.0.0.0:4599/", stop: vi.fn(async () => undefined) };
    });

    await runWeb(
      {
        configPath,
        cwd: dir!,
        env: {
          MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: join(dir!, "global-trace-sources"),
          MONO_AGENT_WEB_AUTH_TOKEN: stableToken,
        },
        host: "0.0.0.0",
        allowNonLoopback: true,
      },
      {
        startServer,
        openUrl,
        waitForShutdown: async () => undefined,
        stdout: { write: (text) => (output += text) },
        discoverNetworkAddresses: () => [{ address: "192.168.178.103", kind: "lan" }],
      },
    );

    expect(capturedOptions?.authToken).toBe(stableToken);
    expect(output).toContain("mono-agent web  →  http://127.0.0.1:4599/");
    expect(output).toContain("LAN       →  http://192.168.178.103:4599/");
    expect(output).toContain("MONO_AGENT_WEB_AUTH_TOKEN is configured (token redacted)");
    expect(output).not.toContain(stableToken);
    expect(output).not.toContain("#token=");
    expect(output).toContain("bearer token never enters process arguments");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("refuses non-interactive non-loopback serving without a configured token", async () => {
    const configPath = await testConfig();
    let errors = "";
    const startServer = vi.fn(async (): Promise<SessionWebServerHandle> => {
      return { url: "http://0.0.0.0:4599/", stop: vi.fn(async () => undefined) };
    });

    const code = await runWeb(
      {
        configPath,
        cwd: dir!,
        env: { MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: join(dir!, "global-trace-sources") },
        host: "0.0.0.0",
        allowNonLoopback: true,
      },
      {
        startServer,
        waitForShutdown: async () => undefined,
        stderr: { write: (text) => (errors += text) },
        interactive: false,
      },
    );

    expect(code).toBe(1);
    expect(startServer).not.toHaveBeenCalled();
    expect(errors).toContain("MONO_AGENT_WEB_AUTH_TOKEN");
    expect(errors).toContain("refusing to generate a bearer secret into logs");
  });

  it("reveals a configured token only with explicit interactive opt-in", async () => {
    const configPath = await testConfig();
    const stableToken = "interactive-stable-token";
    let output = "";
    const startServer = vi.fn(async (): Promise<SessionWebServerHandle> => {
      return { url: "http://0.0.0.0:4599/", stop: vi.fn(async () => undefined) };
    });

    await runWeb(
      {
        configPath,
        cwd: dir!,
        env: {
          MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: join(dir!, "global-trace-sources"),
          MONO_AGENT_WEB_AUTH_TOKEN: stableToken,
        },
        host: "0.0.0.0",
        allowNonLoopback: true,
        showAuthUrl: true,
        open: false,
      },
      {
        startServer,
        waitForShutdown: async () => undefined,
        stdout: { write: (text) => (output += text) },
        interactive: true,
        discoverNetworkAddresses: () => [],
      },
    );

    expect(output).toContain(`http://127.0.0.1:4599/#token=${stableToken}`);
    expect(output).not.toContain("token redacted");
  });

  it("refuses to reveal a configured token to non-interactive output", async () => {
    const configPath = await testConfig();
    const stableToken = "do-not-log-this-token";
    let output = "";
    let errors = "";
    const startServer = vi.fn(async (): Promise<SessionWebServerHandle> => {
      return { url: "http://0.0.0.0:4599/", stop: vi.fn(async () => undefined) };
    });

    await runWeb(
      {
        configPath,
        cwd: dir!,
        env: {
          MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: join(dir!, "global-trace-sources"),
          MONO_AGENT_WEB_AUTH_TOKEN: stableToken,
        },
        host: "0.0.0.0",
        allowNonLoopback: true,
        showAuthUrl: true,
        open: false,
      },
      {
        startServer,
        waitForShutdown: async () => undefined,
        stdout: { write: (text) => (output += text) },
        stderr: { write: (text) => (errors += text) },
        interactive: false,
        discoverNetworkAddresses: () => [],
      },
    );

    expect(output).not.toContain(stableToken);
    expect(errors).not.toContain(stableToken);
    expect(errors).toContain("ignored because stdout is not an interactive terminal");
  });

  it("honors MONO_AGENT_WEB_AUTH_TOKEN for the default loopback-only server", async () => {
    const configPath = await testConfig();
    const stableToken = "loopback-stable-token";
    let output = "";
    let capturedOptions: StartSessionWebServerOptions | undefined;
    const openUrl = vi.fn();
    const startServer = vi.fn(async (options: StartSessionWebServerOptions): Promise<SessionWebServerHandle> => {
      capturedOptions = options;
      return { url: "http://127.0.0.1:4599/", stop: vi.fn(async () => undefined) };
    });

    await runWeb(
      {
        configPath,
        cwd: dir!,
        env: {
          MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: join(dir!, "global-trace-sources"),
          MONO_AGENT_WEB_AUTH_TOKEN: stableToken,
        },
        open: false,
      },
      {
        startServer,
        openUrl,
        waitForShutdown: async () => undefined,
        stdout: { write: (text) => (output += text) },
      },
    );

    expect(capturedOptions?.authToken).toBe(stableToken);
    expect(output).toContain("MONO_AGENT_WEB_AUTH_TOKEN is configured (token redacted)");
    expect(output).not.toContain(stableToken);
    expect(openUrl).not.toHaveBeenCalled();
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
