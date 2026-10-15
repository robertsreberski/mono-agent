import { describe, expect, it } from "vitest";

import { parseMcpServers } from "@mono-agent/turn/host/config";

describe("MCP package references are opaque transport data", () => {
  it.each([
    "@mono-agent/agent-app@0.22.0",
    "--package=@mono-agent/agent-app@0.22.0",
    "-p=@mono-agent/agent-app@0.22.0",
  ])("preserves metadata server argument %s", (specifier) => {
    const args = ["metadata-mcp.mjs", specifier];
    expect(parseMcpServers({ metadata: { command: "node", args } })).toEqual([
      { name: "metadata", transport: "stdio", command: "node", args },
    ]);
  });

  it("does not diagnose package names used as commands", () => {
    expect(parseMcpServers({ peer: { command: "@mono-agent/agent-orchestrator" } })).toEqual([
      { name: "peer", transport: "stdio", command: "@mono-agent/agent-orchestrator" },
    ]);
  });

  it.each(["http", "sse"])("ignores command and args for explicit %s transport", (type) => {
    const url = "https://metadata.example.test/mcp";
    expect(parseMcpServers({ metadata: {
      type,
      url,
      command: "@mono-agent/agent-app",
      args: ["--package=@mono-agent/agent-app@0.22.0"],
    } })).toEqual([{ name: "metadata", transport: type, url }]);
  });
});
