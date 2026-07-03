import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { bashToolImpl } from "../../agent/tools/bash.js";
import { prepareMcpStdioCommand } from "../../agent/tools/pi-bridge.js";
import { webFetchToolImpl } from "../../agent/tools/web-fetch.js";
import { webSearchToolImpl } from "../../agent/tools/web-search.js";
import { createToolContext } from "../../agent/tools/shared/tool-context.js";
import { testSandboxPolicy } from "../helpers/fake-sandbox.js";

const tempDirs = [];

function tempWorkspace() {
  const dir = mkdtempSync(resolve("/tmp", "agent-runtime-sandbox-seam-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

/**
 * A minimal RuntimeSandbox spy — records every call so tests can assert which
 * (merged) policy each of the 5 use sites actually hands to the injected impl.
 */
function spySandbox({ allowNetwork = false } = {}) {
  const calls = { mergePolicies: [], prepareCommand: [], networkAllowsUrl: [] };
  return {
    calls,
    mergePolicies(configured, request) {
      calls.mergePolicies.push([configured, request]);
      return { ...(configured ?? {}), ...(request ?? {}) };
    },
    async prepareCommand(input) {
      calls.prepareCommand.push(input);
      return { ...input.command, args: input.command.args ?? [], cwd: input.command.cwd ?? process.cwd(), sandboxed: true };
    },
    networkAllowsUrl(policy, url) {
      calls.networkAllowsUrl.push([policy, url]);
      return allowNetwork;
    },
  };
}

describe("passthroughSandbox (zero-dependency default)", () => {
  it("allows a plain exec end-to-end when no sandbox policy is configured", async () => {
    const root = tempWorkspace();
    const ctx = createToolContext({ workspace: root });

    const result = await bashToolImpl({ command: "echo hello-passthrough" }, { ctx });

    expect(result).toContain("hello-passthrough");
  });

  it("prepareCommand is identity when there is no policy, or the policy's mode is \"off\"", async () => {
    const noPolicy = await passthroughSandbox.prepareCommand({
      command: { command: "/bin/echo", args: ["hi"], cwd: "/tmp" },
    });
    expect(noPolicy).toMatchObject({ command: "/bin/echo", args: ["hi"], cwd: "/tmp", sandboxed: false });

    const offPolicy = await passthroughSandbox.prepareCommand({
      policy: { mode: "off" },
      command: { command: "/bin/echo", args: [] },
    });
    expect(offPolicy.sandboxed).toBe(false);
  });

  it("fails closed (throws sandbox_unavailable) when a native-mode policy is present and nothing is injected to enforce it", async () => {
    await expect(passthroughSandbox.prepareCommand({
      policy: { mode: "native", network: { mode: "none" } },
      command: { command: "/bin/echo", args: [] },
    })).rejects.toMatchObject({ name: "SandboxUnavailableError", code: "sandbox_unavailable" });
  });

  it("fails closed end-to-end through bashToolImpl instead of silently running the command", async () => {
    const root = tempWorkspace();
    const ctx = createToolContext({ workspace: root, sandboxPolicy: testSandboxPolicy({ root }) });

    const result = await bashToolImpl({ command: "echo should-not-run" }, { ctx });

    expect(result).toContain("Error:");
    expect(result).toContain("RuntimeSandbox implementation is configured");
  });

  it("networkAllowsUrl: no policy or no network sub-policy allows; a restrictive policy denies; only network.mode \"all\" allows", () => {
    expect(passthroughSandbox.networkAllowsUrl(undefined, "https://example.com")).toBe(true);
    expect(passthroughSandbox.networkAllowsUrl({ mode: "native" }, "https://example.com")).toBe(true);
    expect(passthroughSandbox.networkAllowsUrl({ network: { mode: "none" } }, "https://example.com")).toBe(false);
    expect(passthroughSandbox.networkAllowsUrl({ network: { mode: "all" } }, "https://example.com")).toBe(true);
  });

  it("mergePolicies keeps the monotonic guarantee (I13): a request cannot weaken a native host policy", () => {
    const hostNative = { mode: "native", network: { mode: "none" } };
    const requestOff = { mode: "off", network: { mode: "all" } };

    const merged = passthroughSandbox.mergePolicies(hostNative, requestOff);

    expect(merged.mode).toBe("native");
    expect(merged.network.mode).toBe("none");
    expect(passthroughSandbox.mergePolicies(undefined, hostNative)).toBe(hostNative);
    expect(passthroughSandbox.mergePolicies(hostNative, undefined)).toBe(hostNative);
  });
});

describe("delegation to an injected RuntimeSandbox", () => {
  it("Bash: prepareCommand receives ctx.sandbox.mergePolicies's result", async () => {
    const root = tempWorkspace();
    const hostPolicy = testSandboxPolicy({ root });
    const requestPolicy = { ...testSandboxPolicy({ root }), tag: "request" };
    const sandbox = spySandbox();
    const ctx = createToolContext({ workspace: root, sandboxPolicy: hostPolicy, sandbox });

    const result = await bashToolImpl({ command: "echo bash-delegated" }, { ctx, sandboxPolicy: requestPolicy });

    expect(result).toContain("bash-delegated");
    // The first (top-level) merge call is bashToolImpl's own; later calls come
    // from path-resolver re-resolving an already-merged policy internally.
    expect(sandbox.calls.mergePolicies[0]).toEqual([hostPolicy, requestPolicy]);
    expect(sandbox.calls.prepareCommand).toHaveLength(1);
    expect(sandbox.calls.prepareCommand[0].policy).toMatchObject({ tag: "request" });
  });

  it("MCP-stdio: prepareMcpStdioCommand receives the merged policy", async () => {
    const root = tempWorkspace();
    const hostPolicy = testSandboxPolicy({ root });
    const requestPolicy = { ...testSandboxPolicy({ root }), tag: "request" };
    const sandbox = spySandbox();
    const ctx = createToolContext({ workspace: root, sandboxPolicy: hostPolicy, sandbox });

    const prepared = await prepareMcpStdioCommand(
      { command: "node", args: ["server.js"] },
      { cwd: root, sandboxPolicy: requestPolicy, ctx },
    );

    expect(sandbox.calls.mergePolicies).toEqual([[hostPolicy, requestPolicy]]);
    expect(sandbox.calls.prepareCommand[0].policy).toMatchObject({ tag: "request" });
    expect(sandbox.calls.prepareCommand[0].command).toMatchObject({ command: "node", args: ["server.js"] });
    expect(prepared.sandboxed).toBe(true);
  });

  it("WebFetch: networkAllowsUrl receives the merged policy", async () => {
    const hostPolicy = { mode: "native", network: { mode: "all" } };
    const sandbox = spySandbox({ allowNetwork: false });
    const ctx = createToolContext({ sandboxPolicy: hostPolicy, sandbox });

    const result = await webFetchToolImpl({ url: "https://example.com" }, { ctx });

    expect(result).toBe("Error: Network access denied by sandbox policy.");
    expect(sandbox.calls.networkAllowsUrl[0][0]).toEqual(hostPolicy);
    expect(sandbox.calls.networkAllowsUrl[0][1]).toBe("https://example.com/");
  });

  it("WebSearch: networkAllowsUrl receives the merged policy", async () => {
    const hostPolicy = { mode: "native", network: { mode: "none" } };
    const sandbox = spySandbox({ allowNetwork: false });
    const ctx = createToolContext({ sandboxPolicy: hostPolicy, sandbox });

    const result = await webSearchToolImpl({ query: "mono agent" }, { ctx });

    expect(result).toBe("Error: Network access denied by sandbox policy.");
    expect(sandbox.calls.networkAllowsUrl[0][0]).toEqual(hostPolicy);
  });
});
