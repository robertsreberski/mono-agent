import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({ host: "0.0.0.0", allowNonLoopback: true }));
    expect(output).toContain("Loopback only.");
    expect(output).not.toContain("Bound non-loopback");
    expect(stop).toHaveBeenCalledTimes(1);
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
});
