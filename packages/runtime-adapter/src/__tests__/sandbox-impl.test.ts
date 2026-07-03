import { describe, expect, it } from "vitest";
import { failClosedSandboxPolicy, mergeSandboxPolicies, networkPolicyAllowsUrl } from "@mono-agent/sandbox";

import { monoSandboxImpl } from "../sandbox-impl.js";

// monoSandboxImpl is the thin adapter that satisfies agent-runtime's
// RuntimeSandbox seam (see agent/sandbox-seam.js) with the real
// @mono-agent/sandbox implementation. Its methods must behave byte-identically
// to calling the real sandbox package functions directly — the adapter exists
// purely to cross a TypeScript structural-typing boundary (opaque kernel
// SandboxPolicy vs. the package's richer one), not to change behavior.
describe("monoSandboxImpl (real sandbox package injected into createMonoRuntime)", () => {
  it("mergePolicies delegates to mergeSandboxPolicies with the same monotonic result", () => {
    const configured = failClosedSandboxPolicy({ root: "/repo/workspace" });
    const request = failClosedSandboxPolicy({ root: "/repo/workspace/sub" });

    expect(monoSandboxImpl.mergePolicies(configured, request)).toEqual(mergeSandboxPolicies(configured, request));
    expect(monoSandboxImpl.mergePolicies(undefined, configured)).toEqual(mergeSandboxPolicies(undefined, configured));
    expect(monoSandboxImpl.mergePolicies(configured, undefined)).toEqual(mergeSandboxPolicies(configured, undefined));
  });

  it("prepareCommand delegates to prepareSandboxedCommand (identity when the policy is off/absent)", async () => {
    const command = { command: "/bin/echo", args: ["hi"], cwd: "/tmp" };

    const viaAdapter = await monoSandboxImpl.prepareCommand({ command });
    expect(viaAdapter).toMatchObject({ command: "/bin/echo", args: ["hi"], cwd: "/tmp", sandboxed: false });
  });

  it("prepareCommand fails closed under a native policy with no engine available, matching prepareSandboxedCommand directly", async () => {
    const policy = failClosedSandboxPolicy({ root: "/repo/workspace" });
    const command = { command: "/bin/echo", args: [] };

    await expect(monoSandboxImpl.prepareCommand({ policy, command })).rejects.toMatchObject({
      code: "sandbox_unavailable",
    });
  });

  it("networkAllowsUrl delegates to networkPolicyAllowsUrl", () => {
    const policy = failClosedSandboxPolicy({ root: "/repo/workspace" });

    expect(monoSandboxImpl.networkAllowsUrl(policy, "https://example.com")).toBe(
      networkPolicyAllowsUrl(policy, "https://example.com"),
    );
    expect(monoSandboxImpl.networkAllowsUrl(undefined, "https://example.com")).toBe(true);
  });
});
