import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEmbeddingProvider, type EmbeddingProvider } from "../../search/index.js";
import { openMemoryDb } from "../../store/index.js";
import {
  auditBujoMemoryHealth,
  createBujoMemoryStore,
  readManagedIndexManifest,
  rollbackMemoryIndex,
  safeRebuildMemoryIndex,
  serializeBullet,
} from "../index.js";

const NOW = "2026-07-11T09:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("embedding instruction upgrade", () => {
  it("keeps serving a pre-preset bge-m3 index with legacy prefixes until a rebuild adopts the preset", async () => {
    const root = seededRoot();
    // Pre-upgrade build: the historical provider identity had no suffix and
    // always used the search prefixes.
    const legacy = recording("bge-m3:latest", "search");
    await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: legacy.provider, dim: 4 });
    expect(legacy.provider.id).toBe("ollama:bge-m3:latest");
    expect(legacy.sent.every((text) => text.startsWith("search_document: "))).toBe(true);

    // Upgrade with default `auto` instructions: no rebuild required, same prefixes.
    const upgraded = recording("bge-m3:latest");
    expect(upgraded.provider.id).toBe("ollama:bge-m3:latest#instructions=none");
    const store = createBujoMemoryStore({ root, tier: "journal", embeddings: upgraded.provider, dim: 4 });
    try {
      const hits = await store.recall("When was Morgan born?", { trackAccess: false });
      expect(hits.map((hit) => hit.record.text)).toContain("Morgan was born on 1990-05-17.");
    } finally {
      await store.close();
    }
    expect(upgraded.sent).toEqual(["search_query: When was Morgan born?"]);

    // A deliberate rebuild adopts the model preset.
    upgraded.sent.length = 0;
    await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: upgraded.provider, dim: 4 });
    expect(readManagedIndexManifest(root)?.active.embeddingModel).toBe("ollama:bge-m3:latest#instructions=none");
    expect(upgraded.sent).toContain("Morgan was born on 1990-05-17.");
    upgraded.sent.length = 0;
    const rebuilt = createBujoMemoryStore({ root, tier: "journal", embeddings: upgraded.provider, dim: 4 });
    try {
      await rebuilt.recall("When was Morgan born?", { trackAccess: false });
    } finally {
      await rebuilt.close();
    }
    expect(upgraded.sent).toEqual(["When was Morgan born?"]);

    // Rolling back to the pre-preset generation stays accepted under `auto`.
    await rollbackMemoryIndex({ root, tier: "journal", embeddings: upgraded.provider, dim: 4 });
    expect(readManagedIndexManifest(root)?.active.embeddingModel).toBe("ollama:bge-m3:latest");
  });

  it("keeps a manifest-free legacy memory.db serving under auto and rejects mixed identities", async () => {
    const root = seededRoot();
    const legacy = recording("bge-m3:latest", "search");
    const seed = openMemoryDb({ path: join(root, "memory.db"), embeddings: legacy.provider, dim: 4 });
    await seed.upsert({
      id: "M1", type: "note", status: "open", text: "Morgan was born on 1990-05-17.", salience: 0.5,
      isInsight: false, createdAt: NOW, accessCount: 0, tags: [], source: {},
    });
    seed.close();
    expect(readManagedIndexManifest(root)).toBeUndefined();

    const upgraded = recording("bge-m3:latest");
    const store = createBujoMemoryStore({ root, tier: "journal", embeddings: upgraded.provider, dim: 4 });
    try {
      const hits = await store.recall("When was Morgan born?", { trackAccess: false });
      expect(hits.map((hit) => hit.record.id)).toContain("M1");
    } finally {
      await store.close();
    }
    expect(upgraded.sent).toEqual(["search_query: When was Morgan born?"]);

    // A second vector under the new identity makes the store mixed: no adoption.
    const mixed = openMemoryDb({ path: join(root, "memory.db"), embeddings: upgraded.provider, dim: 4 });
    await mixed.upsert({
      id: "M2", type: "note", status: "open", text: "Taylor was born on 1988-11-02.", salience: 0.5,
      isInsight: false, createdAt: NOW, accessCount: 0, tags: [], source: {},
    });
    mixed.close();
    expect(() => createBujoMemoryStore({ root, tier: "journal", embeddings: upgraded.provider, dim: 4 }))
      .toThrow(/does not match configured/u);
  });

  it("health audit accepts a pre-preset index only through the legacy identity", async () => {
    const root = seededRoot();
    await safeRebuildMemoryIndex({
      root,
      tier: "journal",
      embeddings: recording("bge-m3:latest", "search").provider,
      dim: 4,
    });
    const configured = { root, mode: "journal" as const, configuredDimension: 4 };
    expect(auditBujoMemoryHealth({
      ...configured,
      configuredEmbeddingModel: "ollama:bge-m3:latest#instructions=none",
      configuredLegacyEmbeddingModel: "ollama:bge-m3:latest",
    }).issues).not.toContain("configured_identity_mismatch");
    expect(auditBujoMemoryHealth({
      ...configured,
      configuredEmbeddingModel: "ollama:bge-m3:latest#instructions=none",
    }).issues).toContain("configured_identity_mismatch");
  });

  it("requires the safe rebuild when explicit instructions differ from the index", async () => {
    const root = seededRoot();
    await safeRebuildMemoryIndex({
      root,
      tier: "journal",
      embeddings: recording("bge-m3:latest", "search").provider,
      dim: 4,
    });
    const explicit = recording("bge-m3:latest", "none").provider;
    expect(() => createBujoMemoryStore({ root, tier: "journal", embeddings: explicit, dim: 4 }))
      .toThrow(/safe memory rebuild/u);
  });

  it("opens an existing nomic index unchanged", async () => {
    const root = seededRoot();
    const before = recording("nomic-embed-text:v1.5");
    await safeRebuildMemoryIndex({ root, tier: "journal", embeddings: before.provider, dim: 4 });
    const after = recording("nomic-embed-text:v1.5");
    const store = createBujoMemoryStore({ root, tier: "journal", embeddings: after.provider, dim: 4 });
    try {
      await store.recall("When was Morgan born?", { trackAccess: false });
    } finally {
      await store.close();
    }
    expect(readManagedIndexManifest(root)?.active.embeddingModel).toBe("ollama:nomic-embed-text:v1.5");
    expect(after.sent).toEqual(["search_query: When was Morgan born?"]);
  });
});

function recording(
  model: string,
  instructions?: "auto" | "search" | "none",
): { provider: EmbeddingProvider; sent: string[] } {
  const sent: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { input: string[] };
    sent.push(...body.input);
    return new Response(JSON.stringify({
      embeddings: body.input.map((text) => vector(text.replace(/^search_(query|document): /u, ""))),
    }), { status: 200 });
  }) as unknown as typeof fetch;
  return {
    provider: createEmbeddingProvider({
      provider: "ollama",
      model,
      ...(instructions === undefined ? {} : { instructions }),
    }, fetchImpl),
    sent,
  };
}

function vector(text: string): number[] {
  const out = [0, 0, 0, 0];
  for (const [index, byte] of Buffer.from(text.toLowerCase()).entries()) out[index % 4]! += byte / 255;
  const norm = Math.sqrt(out.reduce((sum, value) => sum + value * value, 0)) || 1;
  return out.map((value) => value / norm);
}

function seededRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mono-agent-embedding-instructions-"));
  roots.push(root);
  mkdirSync(join(root, "daily"), { recursive: true });
  writeFileSync(
    join(root, "daily", "2026-07-11.md"),
    `# 2026-07-11\n\n${serializeBullet({
      id: "MORGAN-BORN",
      type: "note",
      status: "open",
      text: "Morgan was born on 1990-05-17.",
      salience: 0.7,
      isInsight: false,
      createdAt: NOW,
      refs: [],
    })}\n`,
    "utf8",
  );
  return root;
}
