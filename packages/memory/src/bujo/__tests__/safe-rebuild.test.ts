import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider } from "../../search/index.js";
import { openMemoryDb, type MemoryRecord } from "../../store/index.js";
import {
  createBujoMemoryStore,
  resolveActiveMemoryDbPath,
  rollbackMemoryIndex,
  safeRebuildMemoryIndex,
  serializeBullet,
} from "../index.js";

const NOW = "2026-07-11T09:00:00.000Z";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("safe memory index rebuild", () => {
  it("builds beside a legacy index, activates one versioned generation, and retains a working rollback", async () => {
    const root = tempRoot();
    await seedLegacy(root, note("OLD", "Legacy index sentinel."));
    writeDaily(root, [bullet("NEW", "Canonical source sentinel.")]);

    const legacyPath = await resolveActiveMemoryDbPath(root);
    expect(legacyPath).toBe(join(root, "memory.db"));

    await safeRebuildMemoryIndex({ root, tier: "lite" });

    const candidatePath = await resolveActiveMemoryDbPath(root);
    expect(candidatePath).not.toBe(legacyPath);
    expect(readTexts(candidatePath)).toEqual(["Canonical source sentinel."]);
    expect(existsSync(legacyPath)).toBe(true);

    await rollbackMemoryIndex({ root, tier: "lite" });

    const rolledBackPath = await resolveActiveMemoryDbPath(root);
    expect(rolledBackPath).not.toBe(candidatePath);
    expect(readTexts(rolledBackPath)).toEqual(["Legacy index sentinel."]);
    expect(existsSync(candidatePath)).toBe(true);
  });

  it("does not switch the active pointer when a closed candidate fails before manifest activation", async () => {
    const root = tempRoot();
    await seedLegacy(root, note("OLD", "Still active after a candidate fault."));
    writeDaily(root, [bullet("NEW", "Candidate that must not activate.")]);
    const before = await resolveActiveMemoryDbPath(root);

    await expect(safeRebuildMemoryIndex({
      root,
      tier: "lite",
      hooks: {
        afterCandidateValidated: () => {
          throw new Error("fault-after-candidate-validation");
        },
      },
    })).rejects.toThrow("fault-after-candidate-validation");

    expect(await resolveActiveMemoryDbPath(root)).toBe(before);
    expect(readTexts(before)).toEqual(["Still active after a candidate fault."]);
  });

  it("keeps the newly referenced generation when failure is injected after manifest rename", async () => {
    const root = tempRoot();
    await seedLegacy(root, note("OLD", "Rollback sentinel."));
    writeDaily(root, [bullet("NEW", "Activated before directory-sync reporting failed.")]);
    const before = await resolveActiveMemoryDbPath(root);

    await expect(safeRebuildMemoryIndex({
      root,
      tier: "lite",
      hooks: {
        afterManifestRename: () => {
          throw new Error("fault-after-manifest-rename");
        },
      },
    })).rejects.toThrow(/fault-after-manifest-rename|activation.*uncertain/iu);

    const after = await resolveActiveMemoryDbPath(root);
    expect(after).not.toBe(before);
    expect(existsSync(after)).toBe(true);
    expect(readTexts(after)).toEqual(["Activated before directory-sync reporting failed."]);
  });

  it("performs a final source fingerprint CAS and leaves the prior generation active on mutation", async () => {
    const root = tempRoot();
    await seedLegacy(root, note("OLD", "Source-CAS rollback sentinel."));
    writeDaily(root, [bullet("A", "Snapshot A.")]);
    const before = await resolveActiveMemoryDbPath(root);

    await expect(safeRebuildMemoryIndex({
      root,
      tier: "lite",
      hooks: {
        beforeSourceCas: () => writeDaily(root, [bullet("B", "Snapshot B changed concurrently.")]),
      },
    })).rejects.toThrow(/source|fingerprint|concurrent/iu);

    expect(await resolveActiveMemoryDbPath(root)).toBe(before);
    expect(readTexts(before)).toEqual(["Source-CAS rollback sentinel."]);
  });

  it("rejects a rebuild while a configured writer is live before making any embedding call", async () => {
    const root = tempRoot();
    const store = createBujoMemoryStore({ root, tier: "lite" });
    await store.appendHostSummary("conversation", "A live writer owns this memory root.");
    const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => new Array<number>(8).fill(0)));

    try {
      await expect(safeRebuildMemoryIndex({
        root,
        tier: "journal",
        embeddings: { id: "test:model", embed },
        dim: 8,
      })).rejects.toThrow(/active|agent|lock|stop|writer/iu);
      expect(embed).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

  it("serializes competing rebuilds and rejects the loser before it pays for embeddings", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("ONE", "One canonical fact.")]);
    const entered = deferred<void>();
    const release = deferred<void>();
    const firstEmbeddings = embeddings("test:first", 8);
    const secondEmbed = vi.fn(async (texts: readonly string[]) => texts.map(() => new Array<number>(8).fill(0)));

    const first = safeRebuildMemoryIndex({
      root,
      tier: "journal",
      embeddings: firstEmbeddings,
      dim: 8,
      hooks: {
        afterSnapshot: async () => {
          entered.resolve();
          await release.promise;
        },
      },
    });
    await entered.promise;

    await expect(safeRebuildMemoryIndex({
      root,
      tier: "journal",
      embeddings: { id: "test:second", embed: secondEmbed },
      dim: 8,
    })).rejects.toThrow(/active|lock|rebuild|transaction/iu);
    expect(secondEmbed).not.toHaveBeenCalled();

    release.resolve();
    await first;
  });

  it.each([
    ["malformed JSON", "not-json\n"],
    ["unknown graph kind", `${JSON.stringify({ kind: "future-record", id: "x" })}\n`],
    [
      "orphan association",
      `${JSON.stringify({
        kind: "association",
        memoryId: "M1",
        entityId: "person:missing",
        provenance: "capture",
        createdAt: NOW,
      })}\n`,
    ],
  ])("rejects strict BuJo graph input with %s instead of silently dropping evidence", async (_label, graph) => {
    const root = tempRoot();
    await seedLegacy(root, note("OLD", "Strict graph rollback sentinel."));
    writeDaily(root, [bullet("M1", "Morgan owns the migration plan.")]);
    writeFileSync(join(root, "graph.jsonl"), graph, "utf8");
    const before = await resolveActiveMemoryDbPath(root);
    const embed = vi.fn(embeddings("test:graph", 8).embed);

    await expect(safeRebuildMemoryIndex({
      root,
      tier: "bujo",
      embeddings: { id: "test:graph", embed },
      dim: 8,
    })).rejects.toThrow(/association|graph|kind|json|orphan/iu);

    expect(await resolveActiveMemoryDbPath(root)).toBe(before);
  });

  it("rejects symlinked canonical source paths without changing the active index", async () => {
    const root = tempRoot();
    const outside = tempRoot();
    await seedLegacy(root, note("OLD", "Symlink defense sentinel."));
    mkdirSync(join(outside, "daily"), { recursive: true });
    writeDaily(outside, [bullet("OUT", "Must not be followed through a symlink.")]);
    symlinkSync(join(outside, "daily"), join(root, "daily"), "dir");
    const before = await resolveActiveMemoryDbPath(root);

    await expect(safeRebuildMemoryIndex({ root, tier: "lite" })).rejects.toThrow(/symlink|symbolic|source/iu);
    expect(await resolveActiveMemoryDbPath(root)).toBe(before);
  });

  it("uses the same safe path for model and dimension changes, retaining the old generation", async () => {
    const root = tempRoot();
    writeDaily(root, [bullet("M1", "Embedding identity migration fact.")]);

    await safeRebuildMemoryIndex({
      root,
      tier: "journal",
      embeddings: embeddings("test:model-a", 8),
      dim: 8,
    });
    const firstPath = await resolveActiveMemoryDbPath(root);
    expect(readMetadata(firstPath)).toMatchObject({ embeddingModel: "test:model-a", dimension: 8, tier: "journal" });

    await safeRebuildMemoryIndex({
      root,
      tier: "journal",
      embeddings: embeddings("test:model-b", 4),
      dim: 4,
    });
    const secondPath = await resolveActiveMemoryDbPath(root);
    expect(secondPath).not.toBe(firstPath);
    expect(readMetadata(secondPath)).toMatchObject({ embeddingModel: "test:model-b", dimension: 4, tier: "journal" });
    expect(existsSync(firstPath)).toBe(true);

    const rollbackEmbed = vi.fn(async (): Promise<number[][]> => {
      throw new Error("rollback must not embed");
    });
    await rollbackMemoryIndex({
      root,
      tier: "journal",
      embeddings: { id: "test:model-a", embed: rollbackEmbed },
      dim: 8,
    });
    expect(rollbackEmbed).not.toHaveBeenCalled();
    expect(await resolveActiveMemoryDbPath(root)).toBe(firstPath);
  });

  it("rejects an embedding response with the wrong vector dimension before activation", async () => {
    const root = tempRoot();
    await seedLegacy(root, note("OLD", "Dimension failure rollback sentinel."));
    writeDaily(root, [bullet("M1", "Candidate with bad provider output.")]);
    const before = await resolveActiveMemoryDbPath(root);

    await expect(safeRebuildMemoryIndex({
      root,
      tier: "journal",
      embeddings: embeddings("test:wrong-dim", 7),
      dim: 8,
    })).rejects.toThrow(/dimension|expected 8|got 7/iu);

    expect(await resolveActiveMemoryDbPath(root)).toBe(before);
  });

  it("refuses a stale rollback after canonical source changes", async () => {
    const root = tempRoot();
    await seedLegacy(root, note("OLD", "Old retained generation."));
    writeDaily(root, [bullet("M1", "Source at activation.")]);
    await safeRebuildMemoryIndex({ root, tier: "lite" });
    const active = await resolveActiveMemoryDbPath(root);

    writeDaily(root, [bullet("M1", "Source changed after activation.")]);
    await expect(rollbackMemoryIndex({ root, tier: "lite" })).rejects.toThrow(/source|fingerprint|stale|changed/iu);

    expect(await resolveActiveMemoryDbPath(root)).toBe(active);
    expect(readTexts(active)).toEqual(["Source at activation."]);
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mono-agent-safe-rebuild-"));
  roots.push(root);
  return root;
}

function bullet(id: string, text: string) {
  return {
    id,
    type: "note" as const,
    status: "open" as const,
    text,
    salience: 0.7,
    isInsight: false,
    createdAt: NOW,
    refs: [] as readonly string[],
  };
}

function writeDaily(root: string, bullets: readonly ReturnType<typeof bullet>[]): void {
  const daily = join(root, "daily");
  mkdirSync(daily, { recursive: true });
  writeFileSync(
    join(daily, "2026-07-11.md"),
    `# 2026-07-11\n\n${bullets.map((item) => serializeBullet(item)).join("\n")}\n`,
    "utf8",
  );
}

function note(id: string, text: string): MemoryRecord {
  return {
    id,
    type: "note",
    status: "open",
    text,
    salience: 0.5,
    isInsight: false,
    createdAt: NOW,
    accessCount: 0,
    tags: [],
    source: {},
  };
}

async function seedLegacy(root: string, record: MemoryRecord): Promise<void> {
  const db = openMemoryDb({ path: join(root, "memory.db") });
  try {
    await db.upsert(record);
  } finally {
    db.close();
  }
}

function readTexts(path: string): string[] {
  const db = openMemoryDb({ path });
  try {
    return db.topSalient(100).map((record) => record.text).sort();
  } finally {
    db.close();
  }
}

function readMetadata(path: string) {
  const db = openMemoryDb({ path });
  try {
    return db.indexMetadata();
  } finally {
    db.close();
  }
}

function embeddings(id: string, dim: number): EmbeddingProvider {
  return {
    id,
    embed: async (texts) => texts.map((text) => deterministicVector(text, dim)),
  };
}

function deterministicVector(text: string, dim: number): number[] {
  const vector = new Array<number>(dim).fill(0);
  for (const [index, byte] of Buffer.from(text).entries()) {
    const slot = index % dim;
    vector[slot] = (vector[slot] ?? 0) + byte / 255;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve: (value?: T) => resolvePromise(value as T),
  };
}
