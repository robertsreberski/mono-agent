import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import type { EmbeddingProvider } from "../../search/index.js";
import { openMemoryDb, type MemoryEntityAssociation, type EntityRecord, type MemoryRecord } from "../../store/index.js";

import { appendBullet, dailyFilePath } from "../daily.js";
import { appendAssociation, appendEntity } from "../graph.js";
import { safeRebuildMemoryIndex } from "../rebuild.js";
import { initializeReplayProjection } from "../replay-projection.js";
import type { Bullet } from "../types.js";

import { fakeEmbeddings } from "./helpers.js";

/** Shared on-disk BuJo fixtures for the bundle export/import/round-trip suites. */

const createdRoots: string[] = [];

export interface FixtureBulletSpec {
  readonly id: string;
  readonly text: string;
  readonly day?: string;
  readonly type?: Bullet["type"];
  readonly status?: Bullet["status"];
  readonly salience?: number;
  readonly refs?: readonly string[];
}

export interface FixtureSpec {
  readonly prefix: string;
  readonly dim?: number;
  readonly bullets: readonly FixtureBulletSpec[];
  readonly entities?: readonly EntityRecord[];
  readonly associations?: readonly MemoryEntityAssociation[];
}

export interface BujoFixture {
  readonly root: string;
  readonly parent: string;
  readonly dim: number;
  readonly embeddings: EmbeddingProvider;
}

const DEFAULT_DAY = "2026-07-30";

export function bulletOf(spec: FixtureBulletSpec): Bullet {
  return {
    id: spec.id,
    type: spec.type ?? "note",
    status: spec.status ?? "open",
    text: spec.text,
    salience: spec.salience ?? 0.5,
    isInsight: false,
    createdAt: `${spec.day ?? DEFAULT_DAY}T05:00:00.000Z`,
    refs: spec.refs ?? [],
  };
}

/** Build a rebuilt, healthy BuJo root with a managed index generation. */
export async function createBujoFixture(spec: FixtureSpec): Promise<BujoFixture> {
  const dim = spec.dim ?? 16;
  const embeddings = fakeEmbeddings(dim);
  const parent = mkdtempSync(join(tmpdir(), `${spec.prefix}-`));
  createdRoots.push(parent);
  const root = join(parent, "memory");
  mkdirSync(root, { mode: 0o700 });
  initializeReplayProjection(root);

  // A store that never captured anything has no legacy database either.
  // Creating an empty one would make the rebuild try to adopt it as a Lite
  // rollback and fail on the dimension check.
  const db = spec.bullets.length === 0
    ? undefined
    : openMemoryDb({ path: join(root, "memory.db"), embeddings, dim });
  try {
    for (const entry of spec.bullets) {
      const bullet = bulletOf(entry);
      const when = new Date(bullet.createdAt);
      appendBullet(root, bullet, when);
      const record: MemoryRecord = {
        id: bullet.id,
        type: bullet.type,
        status: bullet.status,
        text: bullet.text,
        salience: bullet.salience,
        isInsight: bullet.isInsight,
        createdAt: bullet.createdAt,
        accessCount: 0,
        tags: [],
        source: { file: relative(root, dailyFilePath(root, when)) },
      };
      await db?.upsert(record);
    }
    db?.checkpoint();
  } finally {
    db?.close();
  }

  for (const entity of spec.entities ?? []) appendEntity(root, entity);
  for (const association of spec.associations ?? []) appendAssociation(root, association);

  await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings, dim });
  return { root, parent, dim, embeddings };
}

/** Scratch directory outside every fixture root, for bundles and backups. */
export function scratchDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `${prefix}-`));
  createdRoots.push(path);
  return path;
}

export function cleanupBujoFixtures(): void {
  while (createdRoots.length > 0) {
    const path = createdRoots.pop();
    if (path === undefined) continue;
    rmSync(path, { recursive: true, force: true });
  }
}
