import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBujoMemoryStore } from "@mono-agent/memory-bujo";
import { createMemoryMcpServer } from "../server.js";

describe("memory-mcp server", () => {
  it("registers exactly memory_recall, memory_capture, memory_note", async () => {
    const store = createBujoMemoryStore({ root: mkdtempSync(join(tmpdir(), "mcp-srv-")) });
    const server = createMemoryMcpServer({ store });
    // _registeredTools is a real property initialized in the McpServer constructor (SDK 1.29)
    const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
    expect(names).toEqual(["memory_capture", "memory_note", "memory_recall"]);
    await store.close();
  });
});
