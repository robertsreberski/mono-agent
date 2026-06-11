import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SandboxUnavailableError,
  createSandboxPolicy,
  createSrtSandboxEngine,
  failClosedSandboxPolicy,
  mergeSandboxPolicies,
  networkPolicyAllowsUrl,
  prepareSandboxedCommand,
  sandboxPolicyToRuntimeOptions,
  sandboxRequired,
  srtSettingsForPolicy,
} from "../index.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("sandbox policy", () => {
  it("creates a fail-closed native sandbox with denied network by default", () => {
    const policy = failClosedSandboxPolicy({ root: "/repo/workspace" });

    expect(policy).toMatchObject({
      mode: "native",
      engine: "srt",
      fallback: "fail-closed",
      root: "/repo/workspace",
      network: { mode: "none", allowlist: [] },
      readableRoots: ["/repo/workspace"],
      writableRoots: ["/repo/workspace"],
    });
    expect(sandboxRequired(policy)).toBe(true);
  });

  it("requires an explicit unsafe host-process opt-in before fallback is allowed", () => {
    expect(() =>
      createSandboxPolicy({
        root: "/repo",
        fallback: "unsafe-host-process",
      }),
    ).toThrow(/unsafeAllowHostProcess/u);

    const policy = createSandboxPolicy({
      root: "/repo",
      fallback: "unsafe-host-process",
      unsafeAllowHostProcess: true,
    });
    expect(policy).toMatchObject({
      fallback: "unsafe-host-process",
      unsafeAllowHostProcess: true,
    });
    expect(sandboxRequired(policy)).toBe(false);
  });

  it("serializes policy into runtime options without dropping the sandbox boundary", () => {
    const policy = failClosedSandboxPolicy({ root: "/repo" });

    expect(sandboxPolicyToRuntimeOptions(policy)).toEqual({
      sandboxPolicy: policy,
    });
  });
});

describe("policy merging", () => {
  it("does not let request-level policy weaken a configured policy", () => {
    const configured = createSandboxPolicy({
      root: "/repo",
      network: { mode: "none" },
    });
    const request = createSandboxPolicy({
      mode: "off",
      root: "/repo",
      network: { mode: "all" },
      fallback: "unsafe-host-process",
      unsafeAllowHostProcess: true,
    });

    expect(mergeSandboxPolicies(configured, request)).toMatchObject({
      mode: "native",
      fallback: "fail-closed",
      network: { mode: "none", allowlist: [] },
    });
  });

  it("intersects allowlists when both policies use allowlist networking", () => {
    const configured = createSandboxPolicy({
      root: "/repo",
      network: { mode: "allowlist", allowlist: ["github.com", "api.github.com"] },
    });
    const request = createSandboxPolicy({
      root: "/repo",
      network: { mode: "allowlist", allowlist: ["api.github.com", "npmjs.org"] },
    });

    expect(mergeSandboxPolicies(configured, request)?.network).toEqual({
      mode: "allowlist",
      allowlist: ["api.github.com"],
    });
  });

  it("keeps the configured allowlist when the request mode is broader", () => {
    const configured = createSandboxPolicy({
      root: "/repo",
      network: { mode: "allowlist", allowlist: ["github.com"] },
    });
    const request = createSandboxPolicy({
      root: "/repo",
      network: { mode: "all" },
    });

    expect(mergeSandboxPolicies(configured, request)?.network).toEqual({
      mode: "allowlist",
      allowlist: ["github.com"],
    });
  });

  it("reduces incomparable network modes to none instead of widening access", () => {
    const configured = createSandboxPolicy({
      root: "/repo",
      network: { mode: "allowlist", allowlist: ["github.com"] },
    });
    const request = createSandboxPolicy({
      root: "/repo",
      network: { mode: "localhost" },
    });

    // localhost would grant loopback hosts the configured allowlist never allowed.
    expect(mergeSandboxPolicies(configured, request)?.network).toEqual({
      mode: "none",
      allowlist: [],
    });
  });

  it("collapses disjoint allowlists to none rather than an invalid empty allowlist", () => {
    const configured = createSandboxPolicy({
      root: "/repo",
      network: { mode: "allowlist", allowlist: ["github.com"] },
    });
    const request = createSandboxPolicy({
      root: "/repo",
      network: { mode: "allowlist", allowlist: ["npmjs.org"] },
    });

    expect(mergeSandboxPolicies(configured, request)?.network).toEqual({
      mode: "none",
      allowlist: [],
    });
  });

  it("lets a request tighten filesystem roots but never widen them", () => {
    const configured = createSandboxPolicy({ root: "/repo" });
    const request = createSandboxPolicy({
      root: "/repo",
      readableRoots: ["/repo/packages"],
      writableRoots: ["/elsewhere"],
    });

    const merged = mergeSandboxPolicies(configured, request);
    expect(merged?.readableRoots).toEqual(["/repo/packages"]);
    expect(merged?.writableRoots).toEqual([]);
  });
});

describe("network policy URL checks", () => {
  it("matches bracketed IPv6 loopback hosts under localhost mode", () => {
    const policy = createSandboxPolicy({ root: "/repo", network: { mode: "localhost" } });

    expect(networkPolicyAllowsUrl(policy, "http://[::1]:8080/health")).toBe(true);
    expect(networkPolicyAllowsUrl(policy, "http://127.0.0.1:8080/health")).toBe(true);
    expect(networkPolicyAllowsUrl(policy, "https://example.com/")).toBe(false);
  });

  it("matches exact hosts and wildcard subdomains in allowlist mode", () => {
    const policy = createSandboxPolicy({
      root: "/repo",
      network: { mode: "allowlist", allowlist: ["github.com", "*.npmjs.org"] },
    });

    expect(networkPolicyAllowsUrl(policy, "https://github.com/owner/repo")).toBe(true);
    expect(networkPolicyAllowsUrl(policy, "https://api.github.com/")).toBe(false);
    expect(networkPolicyAllowsUrl(policy, "https://registry.npmjs.org/")).toBe(true);
  });
});

describe("srt integration contract", () => {
  it("builds workspace-only srt settings with network denied", () => {
    const policy = failClosedSandboxPolicy({ root: "/Users/example/project" });

    expect(srtSettingsForPolicy(policy)).toMatchObject({
      network: {
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: false,
        allowAllUnixSockets: false,
      },
      filesystem: {
        // The policy also denies the real home directory, which varies by
        // platform (/Users/... on macOS, /home/... on Linux CI).
        denyRead: expect.arrayContaining(["/Users"]),
        allowRead: ["/Users/example/project"],
        allowWrite: ["/Users/example/project"],
        denyWrite: [".env", ".env.*", ".git/config", ".git/hooks/**"],
      },
    });
  });

  it("denies the home directory even when the workspace lives elsewhere", () => {
    const policy = failClosedSandboxPolicy({ root: "/workspace" });

    expect(srtSettingsForPolicy(policy).filesystem.denyRead).toContain(homedir());
  });

  it("honors a custom denyWrite list", () => {
    const policy = failClosedSandboxPolicy({ root: "/repo", denyWrite: ["credentials.json"] });

    expect(srtSettingsForPolicy(policy).filesystem.denyWrite).toEqual(["credentials.json"]);
  });

  it("fails closed before process execution when the native engine is unavailable", async () => {
    const policy = failClosedSandboxPolicy({ root: "/repo" });

    await expect(
      prepareSandboxedCommand({
        policy,
        command: { command: "node", args: ["server.js"], cwd: "/repo" },
        engine: {
          id: "fake",
          async isAvailable() {
            return false;
          },
          async prepareCommand() {
            throw new Error("should not prepare");
          },
        },
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("fails closed when the policy names an engine with no implementation", async () => {
    const policy = createSandboxPolicy({ root: "/repo", engine: "bubblewrap" });

    await expect(
      prepareSandboxedCommand({
        policy,
        command: { command: "node", args: ["server.js"], cwd: "/repo" },
      }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("routes process execution through the sandbox engine when required", async () => {
    const policy = failClosedSandboxPolicy({ root: "/repo" });

    await expect(
      prepareSandboxedCommand({
        policy,
        command: { command: "node", args: ["server.js"], cwd: "/repo", env: { A: "1" } },
        engine: {
          id: "fake",
          async isAvailable() {
            return true;
          },
          async prepareCommand(command, receivedPolicy) {
            return {
              ...command,
              command: "sandbox",
              args: [receivedPolicy.engine, command.command, ...(command.args ?? [])],
              cwd: command.cwd ?? receivedPolicy.root,
              sandboxed: true,
            };
          },
        },
      }),
    ).resolves.toMatchObject({
      command: "sandbox",
      args: ["srt", "node", "server.js"],
      cwd: "/repo",
      env: { A: "1" },
      sandboxed: true,
    });
  });

  it("passes through empty argv entries verbatim", async () => {
    const prepared = await prepareSandboxedCommand({
      command: { command: "node", args: ["server.js", "--prefix", ""], cwd: "/repo" },
    });

    expect(prepared.args).toEqual(["server.js", "--prefix", ""]);
    expect(prepared.sandboxed).toBe(false);
  });

  it("reuses one content-addressed settings file across commands under the same policy", async () => {
    const tempRoot = await tempDir();
    const policy = failClosedSandboxPolicy({ root: "/repo", tempRoot });
    const engine = createSrtSandboxEngine();

    const first = await engine.prepareCommand({ command: "node", args: ["a.js"] }, policy);
    const second = await engine.prepareCommand({ command: "node", args: ["b.js"] }, policy);

    expect(first.sandboxSettingsPath).toBe(second.sandboxSettingsPath);
    const settings = JSON.parse(await readFile(first.sandboxSettingsPath as string, "utf8"));
    expect(settings).toEqual(srtSettingsForPolicy(policy));
    expect(first.args.slice(0, 2)).toEqual(["--settings", first.sandboxSettingsPath]);
  });

  it("prepares shared srt settings for concurrent commands without staging collisions", async () => {
    const root = await tempDir();
    const policy = failClosedSandboxPolicy({
      root,
      tempRoot: join(root, "tmp"),
    });
    const engine = createSrtSandboxEngine();

    const settled = await Promise.allSettled(
      Array.from({ length: 64 }, (_, index) =>
        engine.prepareCommand({ command: "node", args: ["server.js", String(index)] }, policy),
      ),
    );

    const rejected = settled.flatMap((result) =>
      result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
        : [],
    );
    expect(rejected).toEqual([]);
    expect(new Set(
      settled
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value.sandboxSettingsPath),
    ).size).toBe(1);
  });
});
