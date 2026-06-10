import { describe, expect, it } from "vitest";

import {
  SandboxUnavailableError,
  createSandboxPolicy,
  failClosedSandboxPolicy,
  mergeSandboxPolicies,
  prepareSandboxedCommand,
  sandboxPolicyToRuntimeOptions,
  srtSettingsForPolicy,
} from "../index.js";

describe("sandbox policy", () => {
  it("creates a fail-closed native sandbox with denied network by default", () => {
    const policy = failClosedSandboxPolicy({ root: "/repo/workspace" });

    expect(policy).toMatchObject({
      mode: "native",
      engine: "srt",
      fallback: "fail-closed",
      required: true,
      root: "/repo/workspace",
      network: { mode: "none", allowlist: [] },
      readableRoots: ["/repo/workspace"],
      writableRoots: ["/repo/workspace"],
    });
  });

  it("requires an explicit unsafe host-process opt-in before fallback is allowed", () => {
    expect(() =>
      createSandboxPolicy({
        root: "/repo",
        fallback: "unsafe-host-process",
      }),
    ).toThrow(/unsafeAllowHostProcess/u);

    expect(
      createSandboxPolicy({
        root: "/repo",
        fallback: "unsafe-host-process",
        unsafeAllowHostProcess: true,
      }),
    ).toMatchObject({
      required: false,
      fallback: "unsafe-host-process",
    });
  });

  it("serializes policy into runtime options without dropping the sandbox boundary", () => {
    const policy = failClosedSandboxPolicy({ root: "/repo" });

    expect(sandboxPolicyToRuntimeOptions(policy)).toEqual({
      sandboxPolicy: policy,
    });
  });

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
      required: true,
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
        denyRead: ["/Users"],
        allowRead: ["/Users/example/project"],
        allowWrite: ["/Users/example/project"],
      },
    });
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
});
