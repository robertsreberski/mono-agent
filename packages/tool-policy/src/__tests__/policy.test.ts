import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createToolPolicy, failClosedToolPolicy, loadToolPolicyFromJsonFile, toolPolicyToRuntimeOptions } from "../index.js";

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tool-policy-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("tool policy", () => {
  it("defaults to a fail-closed empty allowlist", () => {
    expect(failClosedToolPolicy()).toEqual({ allowedTools: [], disallowedTools: [] });
  });

  it("rejects duplicate or overlapping tool entries", () => {
    expect(() => createToolPolicy({ allowedTools: ["Read", "read"] })).toThrow(/duplicate/u);
    expect(() => createToolPolicy({ allowedTools: ["Read"], disallowedTools: ["Read"] })).toThrow(/both allowed/u);
  });

  it("converts policy into runtime options", () => {
    const policy = createToolPolicy({
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      mcpServers: { filesystem: { command: "mcp-server" } },
      mcpConfigPath: "/repo/mcp.json",
      approvalDefaultRiskTier: "high",
      approvalAlwaysAllowTools: ["Read"],
      approvalTimeoutMs: 5000,
      toolRiskTiers: { Bash: "high" },
    });

    expect(toolPolicyToRuntimeOptions(policy)).toEqual({
      allowedTools: ["Read"],
      disallowedTools: ["Bash"],
      mcpServers: { filesystem: { command: "mcp-server" } },
      mcpConfigPath: "/repo/mcp.json",
      approvalDefaultRiskTier: "high",
      approvalAlwaysAllowTools: ["Read"],
      approvalTimeoutMs: 5000,
      toolRiskTiers: { Bash: "high" },
    });
  });

  it("loads JSON policy files", async () => {
    const dir = await tempDir();
    const file = join(dir, "policy.json");
    await writeFile(file, JSON.stringify({ allowedTools: ["Read"], mcpServers: { fs: { command: "server" } }, mcpConfigPath: "/repo/mcp.json" }), "utf8");

    await expect(loadToolPolicyFromJsonFile(file)).resolves.toMatchObject({
      allowedTools: ["Read"],
      disallowedTools: [],
      mcpServers: { fs: { command: "server" } },
      mcpConfigPath: "/repo/mcp.json",
    });
  });
});
