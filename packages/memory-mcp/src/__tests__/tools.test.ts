import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBujoMemoryStore } from "@mono-agent/memory-bujo";
import type { LlmComplete } from "@mono-agent/memory-bujo";
import { createMemoryTools } from "../tools.js";

const fakeLlm: LlmComplete = { id: "fake", async complete() { return "[]"; } };
const root = () => mkdtempSync(join(tmpdir(), "mcp-tools-"));

describe("memory-mcp tools", () => {
  it("note → recall round-trips", async () => {
    const store = createBujoMemoryStore({ root: root() });
    const tools = createMemoryTools({ store });
    await tools.note({ text: "The Q3 launch is on March 3rd." });
    const res = await tools.recall({ query: "launch date" });
    expect(res.isError).not.toBe(true);
    expect(res.content[0]!.text).toMatch(/March 3rd/i);
    await store.close();
  });

  it("capture returns action/entity counts on a bujo store", async () => {
    const store = createBujoMemoryStore({ root: root(), tier: "bujo", llm: fakeLlm });
    const tools = createMemoryTools({ store });
    const res = await tools.capture({ text: "User: I prefer dark mode.\nAssistant: Noted." });
    expect(res.isError).not.toBe(true);
    expect(res.structuredContent).toHaveProperty("actions");
    await store.close();
  });

  it("note rejects whitespace-only text instead of writing an empty bullet", async () => {
    const store = createBujoMemoryStore({ root: root() });
    const tools = createMemoryTools({ store });
    const res = await tools.note({ text: "   \n\t " });
    expect(res.isError).toBe(true);
    // Nothing should have been written: recall finds no memories.
    const recalled = await tools.recall({ query: "anything" });
    expect(recalled.structuredContent).toMatchObject({ hits: [] });
    await store.close();
  });

  it("capture rejects whitespace-only text", async () => {
    const store = createBujoMemoryStore({ root: root(), tier: "bujo", llm: fakeLlm });
    const tools = createMemoryTools({ store });
    const res = await tools.capture({ text: "   " });
    expect(res.isError).toBe(true);
    await store.close();
  });

  it("capture returns an explicit error when the store has no llm (non-bujo)", async () => {
    const store = createBujoMemoryStore({ root: root() }); // lite — no llm
    const tools = createMemoryTools({ store });
    const res = await tools.capture({ text: "anything" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/bujo/i);
    await store.close();
  });
});
