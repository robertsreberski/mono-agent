import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createBujoMemoryStore, createOllamaLlm } from "@mono-agent/memory-bujo";
import { createEmbeddingProvider } from "@mono-agent/memory-search";

import { createMemoryTools } from "../tools.js";

// Gated, real-Ollama end-to-end for the memory-mcp tool surface + the async per-turn capture path.
// Run with: MONO_AGENT_OLLAMA_E2E=1 pnpm --filter @mono-agent/memory-mcp test (needs
// nomic-embed-text:v1.5 + a chat model pulled). Skipped by default.
const OLLAMA = process.env.MONO_AGENT_OLLAMA_E2E === "1";
const EMBED = process.env.MONO_AGENT_EMBED_MODEL ?? "nomic-embed-text:v1.5";
const CHAT = process.env.MONO_AGENT_LLM_MODEL ?? "qwen3.6:latest";

describe.skipIf(!OLLAMA)("memory-mcp @ real Ollama (bujo tier)", () => {
  function bujoStore(): { root: string; store: ReturnType<typeof createBujoMemoryStore> } {
    const root = mkdtempSync(join(tmpdir(), "mcp-e2e-"));
    const store = createBujoMemoryStore({
      root,
      embeddings: createEmbeddingProvider({ provider: "ollama", model: EMBED }),
      dim: 768,
      llm: createOllamaLlm({ model: CHAT }),
    });
    return { root, store };
  }

  it("memory_note then memory_recall round-trips via real embeddings", async () => {
    const { store } = bujoStore();
    const tools = createMemoryTools({ store });
    await tools.note({ text: "The Q3 product launch is scheduled for March 3rd, 2026." });
    const res = await tools.recall({ query: "when is the product launch happening" });
    expect(res.isError).not.toBe(true);
    expect(res.content[0]!.text).toMatch(/March 3rd|launch/i);
    await store.close();
  }, 60_000);

  it("memory_capture distills facts + extracts entities via the real LLM, then recalls them", async () => {
    const { root, store } = bujoStore();
    const tools = createMemoryTools({ store });
    const cap = await tools.capture({
      text:
        "User: My sister Anna is a cardiologist at Massachusetts General Hospital in Boston. I prefer dark mode.\n" +
        "Assistant: Noted — Anna (cardiologist, MGH Boston) and your dark-mode preference.",
    });
    expect(cap.isError).not.toBe(true);
    expect(cap.structuredContent).toHaveProperty("actions");
    // The intelligent pipeline writes the canonical entity graph.
    expect(existsSync(join(root, "graph.jsonl"))).toBe(true);
    expect(readFileSync(join(root, "graph.jsonl"), "utf8").trim().length).toBeGreaterThan(0);
    // The captured fact is recallable.
    const rec = await tools.recall({ query: "what is Anna's profession" });
    expect(rec.content[0]!.text).toMatch(/cardiolog|Anna|MGH|hospital|Boston/i);
    await store.close();
  }, 180_000);

  it("scheduleCapture + flush (the per-turn capture path) persists a distilled memory", async () => {
    const { store } = bujoStore();
    store.scheduleCapture(
      "turn-1",
      "User: We moved the company all-hands to Thursday at 2pm.\nAssistant: Got it — the all-hands is now Thursday at 2pm.",
    );
    await store.flush(); // drains the background queue, exactly as graceful shutdown does
    const tools = createMemoryTools({ store });
    const rec = await tools.recall({ query: "when is the all-hands meeting" });
    expect(rec.content[0]!.text).toMatch(/Thursday|all-hands|2 ?pm/i);
    await store.close();
  }, 180_000);
});
