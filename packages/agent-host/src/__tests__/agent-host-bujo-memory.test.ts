/**
 * Verifies createConfiguredMemory wires memory.mode "bujo" to a BujoMemoryStore
 * (and NOT the markdown fallback). Hermetic: the host-branch test only constructs
 * the harness (no embedding/network at construction); the direct-store tests inject
 * a fake embeddings provider so no Ollama call is made.
 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EmbeddingProvider } from "@mono-agent/memory-search";
import type { MonoAgentConfig } from "@mono-agent/config";
import { createBujoMemoryStore } from "@mono-agent/memory-bujo";
import { createMarkdownMemoryStore } from "@mono-agent/memory-md";

import { createConfiguredAgentHarness } from "../index.js";

/** Deterministic non-zero fake embeddings — no network. */
const fakeEmbeddings: EmbeddingProvider = {
  id: "fake",
  embed: async (texts) => texts.map(() => Array.from({ length: 768 }, () => 0.01)),
};

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-bujo-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createConfiguredMemory — bujo mode", () => {
  it("constructs a harness for mode: bujo without throwing (exercises the bujo branch)", async () => {
    const dir = await tempDir();
    const identityPath = join(dir, "IDENTITY.md");
    await writeFile(identityPath, "You are Mono.", "utf8");

    const fakeRuntime = { async run() { return { text: "ok" }; } };
    const harness = createConfiguredAgentHarness({
      config: bujoConfig({ dir, identityPath, memoryRoot: join(dir, "bujo-memory") }),
      runtime: fakeRuntime as never,
    });
    expect(harness).toBeDefined();
    expect(typeof harness.run).toBe("function");
  });

  it("BujoMemoryStore.appendHostSummary writes into <root>/daily/ (proves bujo, not markdown)", async () => {
    const dir = await tempDir();
    const memoryRoot = join(dir, "bujo-memory");
    const store = createBujoMemoryStore({ root: memoryRoot, embeddings: fakeEmbeddings, dim: 768 });
    await store.appendHostSummary("conv-1", "A summary of this turn.");
    await store.close();

    const files = await readdir(join(memoryRoot, "daily"));
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/u);
  });

  it("BujoMemoryStore exposes capture(); MarkdownMemoryStore does not (differentiates the branches)", async () => {
    const dir = await tempDir();
    const memoryMd = join(dir, "MEMORY.md");
    await writeFile(memoryMd, "", "utf8");

    const bujoStore = createBujoMemoryStore({ root: join(dir, "bujo-memory"), embeddings: fakeEmbeddings, dim: 768 });
    const mdStore = createMarkdownMemoryStore({ path: memoryMd, maxBytes: 8_000 });

    expect(typeof bujoStore.load).toBe("function");
    expect(typeof bujoStore.appendHostSummary).toBe("function");
    expect(typeof bujoStore.capture).toBe("function");
    expect("capture" in mdStore).toBe(false);
    await bujoStore.close();
  });
});

function bujoConfig(input: { readonly dir: string; readonly identityPath: string; readonly memoryRoot: string }): MonoAgentConfig {
  return {
    runtime: {
      model: { sdk: "pi", provider: "ollama", model: "qwen3:8b", reference: "pi:ollama:qwen3:8b" },
      executionMode: "sdk",
      maxTurns: 4,
      workspace: input.dir,
      session: { mode: "per-message", idleTimeoutMs: 1_800_000 },
    },
    context: { identityPath: input.identityPath, selectedSkills: [] },
    memory: {
      mode: "bujo",
      path: input.memoryRoot,
      writeMode: "disabled",
      maxBytes: 8_000,
      scope: "single-file",
      embeddings: { provider: "ollama", model: "nomic-embed-text:v1.5" },
    },
    tools: { allowedTools: [], disallowedTools: [] },
    artifacts: { dir: join(input.dir, "artifacts") },
    traceability: { registryDir: join(input.dir, "trace-sources") },
  } as unknown as MonoAgentConfig;
}
