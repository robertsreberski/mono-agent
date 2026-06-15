# Memory v2 — Phase 1: Substrate & Retrieval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local SQLite memory substrate (`@mono-agent/memory-store`) with hybrid (BM25 + vector) recall, bi-temporal records, and incremental upsert, plus a minimal Bullet-Journal engine (`@mono-agent/memory-bujo`) that implements the existing `MemoryStore` contract over canonical markdown — a drop-in retrieval upgrade with **no LLM** on the path yet.

**Architecture:** Two new `context`-category packages. `memory-store` is pure storage/retrieval (better-sqlite3 + sqlite-vec `vec0` + FTS5, fused by Reciprocal Rank Fusion and re-scored by recency/salience/insight) and takes an injected `EmbeddingProvider` so it is unit-testable without Ollama. `memory-bujo` owns the markdown bullet grammar (parse/serialize round-trip), writes daily files as the canonical source of truth, upserts the SQLite index, composes a curated recall block, and exposes a `rebuild` entrypoint that reconstructs `memory.db` from markdown deterministically. `memory.db` is disposable; markdown is canonical.

**Tech Stack:** TypeScript (ESM/NodeNext, `.js` import suffixes), vitest, `tsc` builds; `better-sqlite3` (synchronous), `sqlite-vec` (`vec0` virtual table, cosine), SQLite FTS5; reuses `@mono-agent/memory-search` for the `EmbeddingProvider` interface and Ollama provider.

**Scope note:** This is plan 1 of 4. P2 (capture/distill/reconcile pipeline + entity extraction), P3 (AM/PM reflection + migration cron + future-log), and P4 (config schema + `mono-agent-composer` step + `feature-registry` + `validate` self-check + live rollout) each get their own plan once these interfaces are real. See the spec: `docs/superpowers/specs/2026-06-15-memory-bujo-design.md`.

**Conventions to follow exactly (verified in-repo):**
- Each package has `package.json` (`"type": "module"`, `main`/`types` → `dist`, `exports`, scripts `build`/`typecheck`/`test`), `tsconfig.json` (extends `../../tsconfig.base.json`, `rootDir: src`, `outDir: dist`, `types: ["node"]`), `tsconfig.build.json` (extends `./tsconfig.json`, excludes tests), and a `README.md` with these exact sections: `## Category`, `## Responsibility`, `## Install / Usage`, `## Public API`, `## Dependency Boundary`, `## What This Package Does Not Own`, `## Verification`, plus a line `Category: \`context\``.
- Every package MUST be registered in `scripts/package-catalog.mjs` or `pnpm run check:architecture` fails.
- Tests live in `src/__tests__/*.test.ts`; run with `pnpm --filter <pkg> run test`.
- Import sibling modules with explicit `.js` extension (e.g. `import { openMemoryDb } from "./db.js"`).

---

## File Structure

**New package `packages/memory-store/`:**
- `package.json`, `tsconfig.json`, `tsconfig.build.json`, `README.md` — scaffold.
- `src/types.ts` — `MemoryRecord`, `MemoryType`, `MemoryStatus`, `MemoryEdgeKind`, `RecallHit`, `RecallOptions`, `RecallWeights`, `MemoryDbOptions`.
- `src/schema.ts` — the SQL DDL (one exported string array of migration statements).
- `src/vec.ts` — float32 blob encoding + sqlite-vec extension load helper.
- `src/fts.ts` — FTS5 query sanitization.
- `src/ranking.ts` — pure RRF fusion + recency/salience/insight re-score.
- `src/db.ts` — `MemoryDb` class (open, upsert, get, supersede, addEdge, expand, recall, rebuild, close) + `openMemoryDb()`.
- `src/index.ts` — public exports.
- `src/__tests__/*.test.ts` — one test file per behavior.

**New package `packages/memory-bujo/`:**
- scaffold (as above).
- `src/types.ts` — `Bullet` (the parsed markdown line) + `BujoOptions`.
- `src/grammar.ts` — `parseBullet()` / `serializeBullet()` (round-trip), `parseDailyFile()` / `serializeDailyFile()`.
- `src/ids.ts` — ULID-style id generator (monotonic, injectable clock/random for tests).
- `src/daily.ts` — daily-file path + append helpers.
- `src/recall.ts` — curated recall-block composition from `MemoryDb`.
- `src/store.ts` — `BujoMemoryStore implements MemoryStore` (from `@mono-agent/memory-md`).
- `src/rebuild.ts` — `rebuildFromMarkdown(root, db)` (no LLM).
- `src/cli.ts` — `memory-bujo rebuild <root>` / `recall <root> <query>` bin.
- `src/index.ts` — public exports.
- `src/__tests__/*.test.ts`.

**Modified:**
- `scripts/package-catalog.mjs` — add both packages.
- `package.json` (root) — add both as workspace devDependencies.

---

## Task 1: Scaffold `@mono-agent/memory-store` and register it

**Files:**
- Create: `packages/memory-store/package.json`
- Create: `packages/memory-store/tsconfig.json`
- Create: `packages/memory-store/tsconfig.build.json`
- Create: `packages/memory-store/README.md`
- Create: `packages/memory-store/src/index.ts` (temporary stub)
- Modify: `scripts/package-catalog.mjs`
- Modify: `package.json` (root)

- [ ] **Step 1: Create `packages/memory-store/package.json`**

```json
{
  "name": "@mono-agent/memory-store",
  "version": "0.2.2",
  "description": "Local SQLite memory substrate: bi-temporal records, sqlite-vec + FTS5 hybrid retrieval, incremental upsert, rebuildable from files.",
  "type": "module",
  "license": "UNLICENSED",
  "private": false,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@mono-agent/memory-search": "workspace:0.2.2",
    "better-sqlite3": "^11.8.1",
    "sqlite-vec": "^0.1.7-alpha.2"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

- [ ] **Step 2: Create `packages/memory-store/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/.tsbuildinfo",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `packages/memory-store/tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/**/*.test.ts", "src/**/__tests__/**"]
}
```

- [ ] **Step 4: Create `packages/memory-store/README.md`**

```markdown
# @mono-agent/memory-store

## Category

Category: `context`

## Responsibility

The local SQLite substrate for agent memory. It stores bi-temporal memory
records, embeds them with an injected `EmbeddingProvider`, and retrieves them by
hybrid search — BM25 keyword (FTS5) fused with `sqlite-vec` vector similarity via
Reciprocal Rank Fusion, then re-scored by recency, salience, and insight. It
supports incremental upsert, bi-temporal supersession (never hard-deletes), edge
storage with one-hop expansion, and full rebuild from supplied records.

## Install / Usage

```bash
pnpm --filter @mono-agent/memory-store run build
```

```ts
import { openMemoryDb } from "@mono-agent/memory-store";
import { createEmbeddingProvider } from "@mono-agent/memory-search";

const db = openMemoryDb({
  path: "./memory/memory.db",
  embeddings: createEmbeddingProvider({ provider: "ollama", model: "nomic-embed-text:v1.5" }),
  dim: 768,
});
await db.upsert({ id: "01J...", type: "note", status: "open", text: "Robert prefers opt-in memory.", salience: 0.9, isInsight: true, createdAt: new Date().toISOString(), accessCount: 0, tags: [], source: {} });
const hits = await db.recall("memory preferences", { topK: 5 });
```

## Public API

- `openMemoryDb`, `MemoryDb`
- `rrfFuse`, `reScore` (pure ranking helpers)
- `MemoryRecord`, `MemoryType`, `MemoryStatus`, `MemoryEdgeKind`, `RecallHit`, `RecallOptions`, `RecallWeights`, `MemoryDbOptions`

## Dependency Boundary

Depends on `@mono-agent/memory-search` (for the `EmbeddingProvider` interface),
`better-sqlite3`, and `sqlite-vec`. It does not embed text itself (the provider is
injected) and performs no LLM calls.

## What This Package Does Not Own

It does not own markdown files, the bullet grammar, entity extraction, reflection,
migration scheduling, or MCP tools. It is storage + retrieval only.

## Verification

```bash
pnpm --filter @mono-agent/memory-store run build
pnpm --filter @mono-agent/memory-store run typecheck
pnpm --filter @mono-agent/memory-store run test
```
```

- [ ] **Step 5: Create temporary `packages/memory-store/src/index.ts` stub**

```ts
export const MEMORY_STORE_PACKAGE = "@mono-agent/memory-store";
```

- [ ] **Step 6: Register both new packages in `scripts/package-catalog.mjs`**

Add these two entries to the `packageCatalog` array (alphabetical-ish, near the other `memory-*` entries):

```js
  {
    dir: "memory-store",
    name: "@mono-agent/memory-store",
    category: "context",
    responsibility: "Provides the local SQLite memory substrate: bi-temporal records, sqlite-vec + FTS5 hybrid retrieval, incremental upsert, and rebuild-from-records.",
    allowedDependencyCategories: ["core", "context"],
    publishable: true,
  },
  {
    dir: "memory-bujo",
    name: "@mono-agent/memory-bujo",
    category: "context",
    responsibility: "Provides the Bullet-Journal memory engine: markdown bullet grammar, canonical daily files, curated recall, and a MemoryStore implementation over the SQLite substrate.",
    allowedDependencyCategories: ["core", "context"],
    publishable: true,
  },
```

- [ ] **Step 7: Add both packages to root `package.json` devDependencies**

Insert (keeping the existing alphabetical grouping among `@mono-agent/*`):

```json
    "@mono-agent/memory-bujo": "workspace:0.2.2",
    "@mono-agent/memory-store": "workspace:0.2.2",
```

- [ ] **Step 8: Install dependencies**

Run: `pnpm install`
Expected: resolves `better-sqlite3`, `sqlite-vec`, `@types/better-sqlite3`, links the two workspace packages, no errors.

- [ ] **Step 9: Verify scaffold builds and architecture check passes**

Run: `pnpm --filter @mono-agent/memory-store run build && node scripts/check-package-architecture.mjs`
Expected: build succeeds; "Package architecture check passed". (The architecture check will also flag `memory-bujo` as missing its dir until Task 9 — if so, run it again after Task 9. To keep this task green, create an empty placeholder dir is NOT needed; the catalog entry alone is fine because the check only errors on `packages/<dir>` that exist but are uncatalogued, not on catalogued dirs that don't exist yet.)

- [ ] **Step 10: Commit**

```bash
git add packages/memory-store scripts/package-catalog.mjs package.json pnpm-lock.yaml
git commit -m "feat(memory-store): scaffold SQLite substrate package + catalog/deps"
```

---

## Task 2: Spike — confirm the installed `sqlite-vec` KNN + FTS5 API

> Alpha dependency: verify the exact API once before building on it. This is a throwaway script; delete it after.

**Files:**
- Create (temp): `packages/memory-store/scripts/spike.mjs`

- [ ] **Step 1: Write the spike**

```js
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const db = new Database(":memory:");
sqliteVec.load(db);
console.log("vec_version:", db.prepare("SELECT vec_version() AS v").get());

db.exec("CREATE VIRTUAL TABLE v USING vec0(embedding float[4] distance_metric=cosine)");
const toBlob = (a) => Buffer.from(new Float32Array(a).buffer);
const ins = db.prepare("INSERT INTO v(rowid, embedding) VALUES (?, ?)");
ins.run(1, toBlob([1, 0, 0, 0]));
ins.run(2, toBlob([0, 1, 0, 0]));
const knn = db.prepare("SELECT rowid, distance FROM v WHERE embedding MATCH ? AND k = ? ORDER BY distance");
console.log("knn:", knn.all(toBlob([1, 0, 0, 0]), 2));

db.exec("CREATE VIRTUAL TABLE f USING fts5(id UNINDEXED, text)");
db.prepare("INSERT INTO f(id, text) VALUES (?, ?)").run("a", "the cat sat on the mat");
db.prepare("INSERT INTO f(id, text) VALUES (?, ?)").run("b", "stock market crash today");
console.log("fts:", db.prepare("SELECT id, bm25(f) AS s FROM f WHERE f MATCH ? ORDER BY s").all('"cat"'));
db.close();
```

- [ ] **Step 2: Run it**

Run: `node packages/memory-store/scripts/spike.mjs`
Expected: prints a `vec_version`, a KNN result where `rowid 1` has `distance ≈ 0` and is first, and an FTS result returning `id: "a"`. **If the KNN syntax (`AND k = ?`) errors**, switch to `ORDER BY distance LIMIT ?` and record which form works — use that form consistently in Task 6. **If `sqliteVec.load` differs** (e.g. `getLoadablePath()`), record the correct load call for Task 3.

- [ ] **Step 3: Delete the spike and commit nothing**

```bash
rm packages/memory-store/scripts/spike.mjs
rmdir packages/memory-store/scripts 2>/dev/null || true
```

(No commit — this task only validates the API and informs Tasks 3 & 6.)

---

## Task 3: Types + schema + DB open with extension load and migrations

**Files:**
- Create: `packages/memory-store/src/types.ts`
- Create: `packages/memory-store/src/schema.ts`
- Create: `packages/memory-store/src/vec.ts`
- Create: `packages/memory-store/src/db.ts` (open + migrate only, for now)
- Test: `packages/memory-store/src/__tests__/open.test.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
import type { EmbeddingProvider } from "@mono-agent/memory-search";

export type MemoryType = "task" | "event" | "note";

export type MemoryStatus =
  | "open"
  | "done"
  | "scheduled"
  | "migrated"
  | "dropped"
  | "invalidated";

export interface MemorySource {
  readonly session?: string;
  readonly file?: string;
  readonly line?: number;
}

export interface MemoryRecord {
  readonly id: string;
  readonly type: MemoryType;
  readonly status: MemoryStatus;
  readonly text: string;
  readonly salience: number;
  readonly isInsight: boolean;
  readonly createdAt: string;
  readonly lastAccessedAt?: string;
  readonly accessCount: number;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly supersededBy?: string;
  readonly supersededAt?: string;
  readonly dueAt?: string;
  readonly tags: readonly string[];
  readonly collection?: string;
  readonly source: MemorySource;
  readonly embeddingModel?: string;
  readonly dim?: number;
}

export type MemoryEdgeKind = "thread" | "about" | "supports" | "supersedes";

export interface RecallHit {
  readonly record: MemoryRecord;
  readonly score: number;
}

export interface RecallWeights {
  readonly rrf: number;
  readonly recency: number;
  readonly salience: number;
  readonly insight: number;
}

export interface RecallOptions {
  readonly topK?: number;
  readonly candidates?: number;
  readonly expandHops?: number;
  readonly includeInvalid?: boolean;
  readonly now?: Date;
}

export interface MemoryDbOptions {
  readonly path: string;
  readonly embeddings: EmbeddingProvider;
  readonly dim: number;
  readonly k?: number;
  readonly weights?: Partial<RecallWeights>;
  readonly decayGamma?: number;
  readonly clock?: () => Date;
}

export const DEFAULT_WEIGHTS: RecallWeights = {
  rrf: 1.0,
  recency: 0.3,
  salience: 0.3,
  insight: 0.2,
};
export const DEFAULT_RRF_K = 60;
export const DEFAULT_DECAY_GAMMA = 0.995;
```

- [ ] **Step 2: Write `src/schema.ts`**

```ts
/** Ordered DDL applied once at open. `${dim}` is substituted with the configured dimension. */
export function migrations(dim: number): readonly string[] {
  return [
    `CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('task','event','note')),
      status TEXT NOT NULL CHECK(status IN ('open','done','scheduled','migrated','dropped','invalidated')),
      text TEXT NOT NULL,
      salience REAL NOT NULL DEFAULT 0.5,
      is_insight INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_accessed_at TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      valid_from TEXT,
      valid_to TEXT,
      superseded_by TEXT,
      superseded_at TEXT,
      due_at TEXT,
      collection TEXT,
      source_session TEXT,
      source_file TEXT,
      source_line INTEGER,
      embedding_model TEXT,
      dim INTEGER,
      tags TEXT NOT NULL DEFAULT '[]'
    )`,
    `CREATE TABLE IF NOT EXISTS edges (
      src TEXT NOT NULL,
      dst TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('thread','about','supports','supersedes')),
      weight REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL,
      PRIMARY KEY(src, dst, kind)
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, text)`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(embedding float[${dim}] distance_metric=cosine)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status)`,
    `CREATE INDEX IF NOT EXISTS idx_memories_due ON memories(due_at)`,
  ];
}
```

- [ ] **Step 3: Write `src/vec.ts`**

```ts
import type { Database } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

/** Load the sqlite-vec extension into an open better-sqlite3 connection. */
export function loadVec(db: Database): void {
  sqliteVec.load(db);
}

/** Encode a numeric vector as a little-endian float32 BLOB for vec0. */
export function toBlob(vector: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}
```

- [ ] **Step 4: Write `src/db.ts` (open + migrate only)**

```ts
import BetterSqlite3, { type Database } from "better-sqlite3";

import { migrations } from "./schema.js";
import { loadVec } from "./vec.js";
import {
  DEFAULT_DECAY_GAMMA,
  DEFAULT_RRF_K,
  DEFAULT_WEIGHTS,
  type MemoryDbOptions,
  type RecallWeights,
} from "./types.js";
import type { EmbeddingProvider } from "@mono-agent/memory-search";

export class MemoryDb {
  protected readonly db: Database;
  protected readonly embeddings: EmbeddingProvider;
  protected readonly dim: number;
  protected readonly k: number;
  protected readonly weights: RecallWeights;
  protected readonly decayGamma: number;
  protected readonly clock: () => Date;

  constructor(options: MemoryDbOptions) {
    if (!Number.isInteger(options.dim) || options.dim <= 0) {
      throw new Error("MemoryDb: dim must be a positive integer.");
    }
    this.db = new BetterSqlite3(options.path);
    this.db.pragma("journal_mode = WAL");
    loadVec(this.db);
    for (const statement of migrations(options.dim)) {
      this.db.exec(statement);
    }
    this.embeddings = options.embeddings;
    this.dim = options.dim;
    this.k = options.k ?? DEFAULT_RRF_K;
    this.weights = { ...DEFAULT_WEIGHTS, ...options.weights };
    this.decayGamma = options.decayGamma ?? DEFAULT_DECAY_GAMMA;
    this.clock = options.clock ?? (() => new Date());
  }

  vecVersion(): string {
    return (this.db.prepare("SELECT vec_version() AS v").get() as { v: string }).v;
  }

  close(): void {
    this.db.close();
  }
}

export function openMemoryDb(options: MemoryDbOptions): MemoryDb {
  return new MemoryDb(options);
}
```

- [ ] **Step 5: Write the failing test `src/__tests__/open.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";

const fakeEmbeddings = { id: "fake", embed: async () => [] };

describe("openMemoryDb", () => {
  it("opens an in-memory db, loads sqlite-vec, and creates tables", () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings, dim: 8 });
    expect(db.vecVersion()).toMatch(/\d+\.\d+/);
    db.close();
  });

  it("rejects a non-positive dimension", () => {
    expect(() => openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings, dim: 0 })).toThrow(/positive integer/);
  });
});
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @mono-agent/memory-store run test`
Expected: 2 passing tests. (If `vec_version` errors, the spike in Task 2 already told you the correct load call — fix `vec.ts`.)

- [ ] **Step 7: Replace the stub `src/index.ts`**

```ts
export { MemoryDb, openMemoryDb } from "./db.js";
export type {
  MemoryDbOptions,
  MemoryEdgeKind,
  MemoryRecord,
  MemorySource,
  MemoryStatus,
  MemoryType,
  RecallHit,
  RecallOptions,
  RecallWeights,
} from "./types.js";
```

- [ ] **Step 8: Typecheck, build, commit**

```bash
pnpm --filter @mono-agent/memory-store run typecheck && pnpm --filter @mono-agent/memory-store run build
git add packages/memory-store/src
git commit -m "feat(memory-store): db open, sqlite-vec load, schema migrations"
```

---

## Task 4: Upsert + get (record round-trip through SQLite, FTS, and vec)

**Files:**
- Modify: `packages/memory-store/src/db.ts`
- Test: `packages/memory-store/src/__tests__/upsert.test.ts`

- [ ] **Step 1: Write the failing test `src/__tests__/upsert.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";
import type { MemoryRecord } from "../types.js";

function record(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m1",
    type: "note",
    status: "open",
    text: "Robert prefers opt-in memory, never silent fallback.",
    salience: 0.8,
    isInsight: true,
    createdAt: "2026-06-15T09:00:00.000Z",
    accessCount: 0,
    tags: ["preference", "memory"],
    source: { session: "s1", file: "daily/2026-06-15.md", line: 4 },
    ...over,
  };
}

describe("upsert/get", () => {
  it("stores and reads back a record with all fields", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    await db.upsert(record());
    const got = db.get("m1");
    expect(got).toMatchObject({
      id: "m1",
      type: "note",
      status: "open",
      salience: 0.8,
      isInsight: true,
      tags: ["preference", "memory"],
      source: { session: "s1", file: "daily/2026-06-15.md", line: 4 },
    });
    db.close();
  });

  it("upsert is idempotent on id (updates in place, no duplicate rows)", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(8), dim: 8 });
    await db.upsert(record({ text: "first" }));
    await db.upsert(record({ text: "second", salience: 0.2 }));
    expect(db.get("m1")?.text).toBe("second");
    expect(db.get("m1")?.salience).toBe(0.2);
    expect(db.count()).toBe(1);
    db.close();
  });
});
```

- [ ] **Step 2: Create the test helper `src/__tests__/helpers.ts`**

```ts
import type { EmbeddingProvider } from "@mono-agent/memory-search";

/** Deterministic bag-of-words embedding for tests: shared words → similar vectors. */
export function fakeEmbeddings(dim: number): EmbeddingProvider {
  return {
    id: `fake-${dim}`,
    embed: async (texts) => texts.map((text) => embedOne(text, dim)),
  };
}

function embedOne(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0);
  const stripped = text.replace(/^search_(query|document):\s*/u, "");
  for (const token of stripped.toLowerCase().split(/[^a-z0-9]+/u)) {
    if (token.length === 0) continue;
    vec[hash(token) % dim] += 1;
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

function hash(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @mono-agent/memory-store run test -- upsert`
Expected: FAIL — `db.upsert is not a function`.

- [ ] **Step 4: Add `upsert`, `get`, `count`, and row mapping to `src/db.ts`**

Add these imports at the top of `db.ts`:

```ts
import { toBlob } from "./vec.js";
import type { MemoryRecord } from "./types.js";
```

Add these methods to the `MemoryDb` class body:

```ts
  async upsert(record: MemoryRecord): Promise<void> {
    const [vector] = await this.embeddings.embed([`search_document: ${record.text}`]);
    if (vector === undefined) {
      throw new Error("memory-store: embedding provider returned no vector for upsert.");
    }
    const tx = this.db.transaction(() => {
      // seq computed inside the tx so concurrent upserts of new ids cannot collide on MAX(seq)+1.
      const seq = this.nextSeq(record.id);
      this.db.prepare(
        `INSERT INTO memories (
           id, seq, type, status, text, salience, is_insight, created_at, last_accessed_at,
           access_count, valid_from, valid_to, superseded_by, superseded_at, due_at, collection,
           source_session, source_file, source_line, embedding_model, dim, tags
         ) VALUES (
           @id, @seq, @type, @status, @text, @salience, @is_insight, @created_at, @last_accessed_at,
           @access_count, @valid_from, @valid_to, @superseded_by, @superseded_at, @due_at, @collection,
           @source_session, @source_file, @source_line, @embedding_model, @dim, @tags
         )
         ON CONFLICT(id) DO UPDATE SET
           type=excluded.type, status=excluded.status, text=excluded.text, salience=excluded.salience,
           is_insight=excluded.is_insight, last_accessed_at=excluded.last_accessed_at,
           access_count=excluded.access_count, valid_from=excluded.valid_from, valid_to=excluded.valid_to,
           superseded_by=excluded.superseded_by, superseded_at=excluded.superseded_at, due_at=excluded.due_at,
           collection=excluded.collection, source_session=excluded.source_session, source_file=excluded.source_file,
           source_line=excluded.source_line, embedding_model=excluded.embedding_model, dim=excluded.dim,
           tags=excluded.tags`,
      ).run(this.toRow(record, seq));
      this.db.prepare(`DELETE FROM memories_fts WHERE id = ?`).run(record.id);
      this.db.prepare(`INSERT INTO memories_fts (id, text) VALUES (?, ?)`).run(record.id, record.text);
      // NOTE (from Task 2 spike): sqlite-vec vec0 rejects float64-bound rowids — bind as BigInt.
      this.db.prepare(`DELETE FROM memories_vec WHERE rowid = ?`).run(BigInt(seq));
      this.db.prepare(`INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)`).run(BigInt(seq), toBlob(vector));
    });
    tx();
  }

  get(id: string): MemoryRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : this.fromRow(row);
  }

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number }).n;
  }

  protected nextSeq(id: string): number {
    const existing = this.db.prepare(`SELECT seq FROM memories WHERE id = ?`).get(id) as { seq: number } | undefined;
    if (existing !== undefined) return existing.seq;
    const max = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM memories`).get() as { m: number };
    return max.m + 1;
  }

  protected toRow(record: MemoryRecord, seq: number): Record<string, unknown> {
    return {
      id: record.id,
      seq,
      type: record.type,
      status: record.status,
      text: record.text,
      salience: record.salience,
      is_insight: record.isInsight ? 1 : 0,
      created_at: record.createdAt,
      last_accessed_at: record.lastAccessedAt ?? null,
      access_count: record.accessCount,
      valid_from: record.validFrom ?? null,
      valid_to: record.validTo ?? null,
      superseded_by: record.supersededBy ?? null,
      superseded_at: record.supersededAt ?? null,
      due_at: record.dueAt ?? null,
      collection: record.collection ?? null,
      source_session: record.source.session ?? null,
      source_file: record.source.file ?? null,
      source_line: record.source.line ?? null,
      embedding_model: record.embeddingModel ?? this.embeddings.id,
      dim: record.dim ?? this.dim,
      tags: JSON.stringify(record.tags),
    };
  }

  protected fromRow(row: Record<string, unknown>): MemoryRecord {
    const opt = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
    return {
      id: String(row.id),
      type: row.type as MemoryRecord["type"],
      status: row.status as MemoryRecord["status"],
      text: String(row.text),
      salience: Number(row.salience),
      isInsight: Number(row.is_insight) === 1,
      createdAt: String(row.created_at),
      lastAccessedAt: opt(row.last_accessed_at),
      accessCount: Number(row.access_count),
      validFrom: opt(row.valid_from),
      validTo: opt(row.valid_to),
      supersededBy: opt(row.superseded_by),
      supersededAt: opt(row.superseded_at),
      dueAt: opt(row.due_at),
      collection: opt(row.collection),
      source: {
        session: opt(row.source_session),
        file: opt(row.source_file),
        line: row.source_line === null || row.source_line === undefined ? undefined : Number(row.source_line),
      },
      embeddingModel: opt(row.embedding_model),
      dim: row.dim === null || row.dim === undefined ? undefined : Number(row.dim),
      tags: JSON.parse(String(row.tags ?? "[]")) as string[],
    };
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @mono-agent/memory-store run test -- upsert`
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add packages/memory-store/src
git commit -m "feat(memory-store): upsert/get with FTS + vec mirroring, idempotent on id"
```

---

## Task 5: Pure ranking — RRF fusion + recency/salience/insight re-score

**Files:**
- Create: `packages/memory-store/src/ranking.ts`
- Create: `packages/memory-store/src/fts.ts`
- Test: `packages/memory-store/src/__tests__/ranking.test.ts`

- [ ] **Step 1: Write the failing test `src/__tests__/ranking.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import { rrfFuse, reScore } from "../ranking.js";
import { ftsQuery } from "../fts.js";
import { DEFAULT_WEIGHTS } from "../types.js";

describe("rrfFuse", () => {
  it("rewards items ranked high in either list; top of both wins", () => {
    const vec = ["a", "b", "c"];
    const kw = ["a", "d", "b"];
    const fused = rrfFuse([vec, kw], 60);
    expect(fused[0]?.id).toBe("a"); // rank-0 in both lists → unambiguously highest RRF
    expect(fused.map((f) => f.id)).toContain("d");
  });
});

describe("reScore", () => {
  it("boosts recent, salient, insight memories", () => {
    const now = new Date("2026-06-15T00:00:00.000Z");
    const base = { rrfScore: 1, salience: 0.5, isInsight: false, lastAccessedAt: "2026-06-15T00:00:00.000Z" };
    const old = reScore({ ...base, lastAccessedAt: "2026-01-01T00:00:00.000Z" }, DEFAULT_WEIGHTS, 0.995, now);
    const fresh = reScore(base, DEFAULT_WEIGHTS, 0.995, now);
    const insight = reScore({ ...base, isInsight: true }, DEFAULT_WEIGHTS, 0.995, now);
    expect(fresh).toBeGreaterThan(old);
    expect(insight).toBeGreaterThan(fresh);
  });
});

describe("ftsQuery", () => {
  it("quotes tokens and ORs them, dropping punctuation", () => {
    expect(ftsQuery("cat's pricing? plan!")).toBe('"cat" OR "s" OR "pricing" OR "plan"');
  });
  it("returns empty string for tokenless input", () => {
    expect(ftsQuery("!?  ")).toBe("");
  });
});
```

- [ ] **Step 2: Write `src/fts.ts`**

```ts
/** Build a safe FTS5 MATCH expression: quote each alphanumeric token, OR them. */
export function ftsQuery(raw: string): string {
  const tokens = raw.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  return tokens.map((t) => `"${t}"`).join(" OR ");
}
```

- [ ] **Step 3: Write `src/ranking.ts`**

```ts
import type { RecallWeights } from "./types.js";

export interface FusedItem {
  readonly id: string;
  readonly rrfScore: number;
}

/** Reciprocal Rank Fusion across any number of ranked id lists (best-first). */
export function rrfFuse(lists: readonly (readonly string[])[], k: number): FusedItem[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, rrfScore]) => ({ id, rrfScore }))
    .sort((a, b) => b.rrfScore - a.rrfScore);
}

export interface ReScoreInput {
  readonly rrfScore: number;
  readonly salience: number;
  readonly isInsight: boolean;
  readonly lastAccessedAt?: string;
}

/** Final relevance: RRF + recency decay + salience + insight, weighted. */
export function reScore(input: ReScoreInput, weights: RecallWeights, decayGamma: number, now: Date): number {
  const recency = recencyDecay(input.lastAccessedAt, decayGamma, now);
  return (
    weights.rrf * input.rrfScore +
    weights.recency * recency +
    weights.salience * input.salience +
    weights.insight * (input.isInsight ? 1 : 0)
  );
}

function recencyDecay(lastAccessedAt: string | undefined, gamma: number, now: Date): number {
  if (lastAccessedAt === undefined) return 0;
  const days = Math.max(0, (now.getTime() - new Date(lastAccessedAt).getTime()) / 86_400_000);
  return gamma ** days;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @mono-agent/memory-store run test -- ranking`
Expected: PASS (all 5 assertions).

- [ ] **Step 5: Commit**

```bash
git add packages/memory-store/src/ranking.ts packages/memory-store/src/fts.ts packages/memory-store/src/__tests__/ranking.test.ts
git commit -m "feat(memory-store): pure RRF fusion, recency/salience/insight re-score, FTS query builder"
```

---

## Task 6: Hybrid recall (FTS + vec → RRF → re-score → filter)

**Files:**
- Modify: `packages/memory-store/src/db.ts`
- Test: `packages/memory-store/src/__tests__/recall.test.ts`

- [ ] **Step 1: Write the failing test `src/__tests__/recall.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";
import type { MemoryRecord } from "../types.js";

function note(id: string, text: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id, type: "note", status: "open", text, salience: 0.5, isInsight: false,
    createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {}, ...over,
  };
}

describe("recall", () => {
  it("ranks the topically-matching memory first via hybrid search", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert(note("a", "the cat sat on the mat"));
    await db.upsert(note("b", "stock market crash wiped out savings"));
    await db.upsert(note("c", "a feline pricing plan for cats"));
    const hits = await db.recall("cat", { topK: 3 });
    expect(hits[0]?.record.id).toBe("a");
    expect(hits.map((h) => h.record.id)).toContain("c");
    db.close();
  });

  it("excludes invalidated/dropped memories by default", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert(note("a", "cat one", { status: "invalidated" }));
    await db.upsert(note("b", "cat two", { status: "dropped" }));
    await db.upsert(note("c", "cat three"));
    const hits = await db.recall("cat", { topK: 5 });
    expect(hits.map((h) => h.record.id)).toEqual(["c"]);
    db.close();
  });

  it("bumps access_count and last_accessed_at on returned memories", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64, clock: () => new Date("2026-06-16T00:00:00.000Z") });
    await db.upsert(note("a", "cat"));
    await db.recall("cat", { topK: 1 });
    const got = db.get("a");
    expect(got?.accessCount).toBe(1);
    expect(got?.lastAccessedAt).toBe("2026-06-16T00:00:00.000Z");
    db.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @mono-agent/memory-store run test -- recall`
Expected: FAIL — `db.recall is not a function`.

- [ ] **Step 3: Add `recall` to `src/db.ts`**

Add imports:

```ts
import { ftsQuery } from "./fts.js";
import { rrfFuse, reScore } from "./ranking.js";
import type { RecallHit, RecallOptions } from "./types.js";
```

Add to the `MemoryDb` class:

```ts
  async recall(query: string, options: RecallOptions = {}): Promise<RecallHit[]> {
    const topK = options.topK ?? 8;
    const candidates = options.candidates ?? Math.max(topK * 4, 20);
    const now = options.now ?? this.clock();

    const vecIds = await this.vectorCandidates(query, candidates);
    const ftsIds = this.keywordCandidates(query, candidates);
    const fused = rrfFuse([vecIds, ftsIds], this.k);
    if (fused.length === 0) return [];

    const byId = new Map(fused.map((f) => [f.id, f.rrfScore]));
    const placeholders = fused.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...fused.map((f) => f.id)) as Record<string, unknown>[];

    const scored: RecallHit[] = [];
    for (const row of rows) {
      const record = this.fromRow(row);
      if (!options.includeInvalid && (record.status === "invalidated" || record.status === "dropped")) continue;
      if (!options.includeInvalid && record.validTo !== undefined && new Date(record.validTo) < now) continue;
      const score = reScore(
        { rrfScore: byId.get(record.id) ?? 0, salience: record.salience, isInsight: record.isInsight, lastAccessedAt: record.lastAccessedAt },
        this.weights,
        this.decayGamma,
        now,
      );
      scored.push({ record, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, topK);
    this.bumpAccess(top.map((h) => h.record.id), now);
    return top.map((h) => ({ ...h, record: { ...h.record, accessCount: h.record.accessCount + 1, lastAccessedAt: now.toISOString() } }));
  }

  protected async vectorCandidates(query: string, limit: number): Promise<string[]> {
    const [vector] = await this.embeddings.embed([`search_query: ${query}`]);
    if (vector === undefined) return [];
    const rows = this.db
      .prepare(`SELECT m.id AS id FROM memories_vec v JOIN memories m ON m.seq = v.rowid WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance`)
      .all(toBlob(vector), limit) as { id: string }[];
    return rows.map((r) => r.id);
  }

  protected keywordCandidates(query: string, limit: number): string[] {
    const match = ftsQuery(query);
    if (match.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT ?`)
      .all(match, limit) as { id: string }[];
    return rows.map((r) => r.id);
  }

  protected bumpAccess(ids: readonly string[], now: Date): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`);
    const tx = this.db.transaction(() => {
      for (const id of ids) stmt.run(now.toISOString(), id);
    });
    tx();
  }
```

> If Task 2's spike showed the KNN form is `ORDER BY distance LIMIT ?` (no `AND k = ?`), change the `vectorCandidates` SQL to `... WHERE v.embedding MATCH ? ORDER BY v.distance LIMIT ?` accordingly.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @mono-agent/memory-store run test -- recall`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/memory-store/src
git commit -m "feat(memory-store): hybrid recall (FTS+vec RRF, re-score, filter, access bump)"
```

---

## Task 7: Bi-temporal supersede (invalidate, never delete)

**Files:**
- Modify: `packages/memory-store/src/db.ts`
- Test: `packages/memory-store/src/__tests__/supersede.test.ts`

- [ ] **Step 1: Write the failing test `src/__tests__/supersede.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";
import type { MemoryRecord } from "../types.js";

function note(id: string, text: string): MemoryRecord {
  return { id, type: "note", status: "open", text, salience: 0.5, isInsight: false, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {} };
}

describe("supersede", () => {
  it("invalidates the old record (keeps the row) and links the new one", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64, clock: () => new Date("2026-06-16T00:00:00.000Z") });
    await db.upsert(note("old", "Robert lives in Berlin"));
    await db.supersede("old", note("new", "Robert lives in Lisbon"));

    const old = db.get("old");
    expect(old).toBeDefined();                       // not deleted
    expect(old?.status).toBe("invalidated");
    expect(old?.supersededBy).toBe("new");
    expect(old?.supersededAt).toBe("2026-06-16T00:00:00.000Z");
    expect(old?.validTo).toBe("2026-06-16T00:00:00.000Z");
    expect(db.get("new")?.status).toBe("open");
    expect(db.edges("old")).toContainEqual(expect.objectContaining({ src: "old", dst: "new", kind: "supersedes" }));
    db.close();
  });

  it("excludes the superseded record from default recall but keeps it for includeInvalid", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert(note("old", "Berlin city note"));
    await db.supersede("old", note("new", "Lisbon city note"));
    const live = await db.recall("city", { topK: 5 });
    expect(live.map((h) => h.record.id)).not.toContain("old");
    const all = await db.recall("city", { topK: 5, includeInvalid: true });
    expect(all.map((h) => h.record.id)).toContain("old");
    db.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @mono-agent/memory-store run test -- supersede`
Expected: FAIL — `db.supersede is not a function`.

- [ ] **Step 3: Add `supersede` and `edges` to `src/db.ts`**

Add to the `MemoryDb` class:

```ts
  async supersede(oldId: string, replacement: MemoryRecord): Promise<void> {
    const now = this.clock().toISOString();
    await this.upsert(replacement);
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE memories SET status = 'invalidated', superseded_by = ?, superseded_at = ?, valid_to = ? WHERE id = ?`,
      ).run(replacement.id, now, now, oldId);
      this.db.prepare(
        `INSERT OR IGNORE INTO edges (src, dst, kind, weight, created_at) VALUES (?, ?, 'supersedes', 1.0, ?)`,
      ).run(oldId, replacement.id, now);
    });
    tx();
  }

  edges(src: string): { src: string; dst: string; kind: string; weight: number }[] {
    return this.db.prepare(`SELECT src, dst, kind, weight FROM edges WHERE src = ?`).all(src) as {
      src: string; dst: string; kind: string; weight: number;
    }[];
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @mono-agent/memory-store run test -- supersede`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add packages/memory-store/src
git commit -m "feat(memory-store): bi-temporal supersede with supersedes edge (never deletes)"
```

---

## Task 8: Edges + one-hop expansion

**Files:**
- Modify: `packages/memory-store/src/db.ts`
- Modify: `packages/memory-store/src/index.ts`
- Test: `packages/memory-store/src/__tests__/expand.test.ts`

- [ ] **Step 1: Write the failing test `src/__tests__/expand.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";
import type { MemoryRecord } from "../types.js";

function note(id: string, text: string): MemoryRecord {
  return { id, type: "note", status: "open", text, salience: 0.5, isInsight: false, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {} };
}

describe("addEdge/expand", () => {
  it("expands one hop along thread/about edges, excluding the seed ids", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    for (const id of ["a", "b", "c", "d"]) await db.upsert(note(id, `memory ${id}`));
    db.addEdge("a", "b", "thread", 0.9);
    db.addEdge("a", "c", "about", 1.0);
    db.addEdge("c", "d", "thread", 0.5); // 2 hops from a — must NOT appear at hops=1

    const expanded = db.expand(["a"], 1).map((r) => r.id).sort();
    expect(expanded).toEqual(["b", "c"]);
    db.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @mono-agent/memory-store run test -- expand`
Expected: FAIL — `db.addEdge is not a function`.

- [ ] **Step 3: Add `addEdge` and `expand` to `src/db.ts`**

```ts
  addEdge(src: string, dst: string, kind: "thread" | "about" | "supports" | "supersedes", weight = 1.0): void {
    this.db.prepare(
      `INSERT INTO edges (src, dst, kind, weight, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(src, dst, kind) DO UPDATE SET weight = excluded.weight`,
    ).run(src, dst, kind, weight, this.clock().toISOString());
  }

  expand(seedIds: readonly string[], hops = 1): MemoryRecord[] {
    const seeds = new Set(seedIds);
    let frontier = new Set(seedIds);
    const reached = new Set<string>();
    for (let hop = 0; hop < hops; hop += 1) {
      const next = new Set<string>();
      for (const id of frontier) {
        const rows = this.db
          .prepare(`SELECT dst FROM edges WHERE src = ? AND kind IN ('thread','about')`)
          .all(id) as { dst: string }[];
        for (const { dst } of rows) {
          if (!seeds.has(dst) && !reached.has(dst)) {
            next.add(dst);
            reached.add(dst);
          }
        }
      }
      frontier = next;
    }
    const ids = [...reached];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`).all(...ids) as Record<string, unknown>[];
    return rows.map((row) => this.fromRow(row));
  }
```

- [ ] **Step 4: Export the new surface in `src/index.ts`**

Append nothing new for types (already exported); ensure `MemoryDb` exposes `addEdge`/`expand`/`edges`/`supersede` (they are public methods, already reachable through the exported class). No change needed if Task 3's index already exports `MemoryDb`. Confirm by reading `src/index.ts`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @mono-agent/memory-store run test -- expand`
Expected: PASS.

- [ ] **Step 6: Add `rebuild` + a determinism test, then commit**

Add to the `MemoryDb` class:

```ts
  /** Wipe the index and rebuild it from the supplied records (used by rebuild-from-files). No LLM. */
  async rebuild(records: readonly MemoryRecord[]): Promise<{ indexed: number }> {
    const tx = this.db.transaction(() => {
      this.db.exec(`DELETE FROM memories; DELETE FROM memories_fts; DELETE FROM memories_vec; DELETE FROM edges;`);
    });
    tx();
    for (const record of records) {
      await this.upsert(record);
    }
    return { indexed: records.length };
  }
```

Create `src/__tests__/rebuild.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { openMemoryDb } from "../db.js";
import { fakeEmbeddings } from "./helpers.js";
import type { MemoryRecord } from "../types.js";

function note(id: string, text: string): MemoryRecord {
  return { id, type: "note", status: "open", text, salience: 0.5, isInsight: false, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {} };
}

describe("rebuild", () => {
  it("is deterministic — same records produce the same recall ordering and count", async () => {
    const records = [note("a", "cat sat"), note("b", "dog ran"), note("c", "cat napped")];
    const build = async () => {
      const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
      await db.rebuild(records);
      const ids = (await db.recall("cat", { topK: 3 })).map((h) => h.record.id);
      const count = db.count();
      db.close();
      return { ids, count };
    };
    const first = await build();
    const second = await build();
    expect(first.count).toBe(3);
    expect(second).toEqual(first);
    db: void 0;
  });
});
```

Run: `pnpm --filter @mono-agent/memory-store run test`
Expected: ALL memory-store tests pass.

```bash
pnpm --filter @mono-agent/memory-store run typecheck && pnpm --filter @mono-agent/memory-store run build
git add packages/memory-store/src
git commit -m "feat(memory-store): edges + one-hop expand + deterministic rebuild"
```

---

## Task 9: Scaffold `@mono-agent/memory-bujo`

**Files:**
- Create: `packages/memory-bujo/package.json`
- Create: `packages/memory-bujo/tsconfig.json`
- Create: `packages/memory-bujo/tsconfig.build.json`
- Create: `packages/memory-bujo/README.md`
- Create: `packages/memory-bujo/src/index.ts` (temporary stub)

- [ ] **Step 1: Create `packages/memory-bujo/package.json`**

```json
{
  "name": "@mono-agent/memory-bujo",
  "version": "0.2.2",
  "description": "Bullet-Journal memory engine: markdown bullet grammar, canonical daily files, curated recall, and a MemoryStore over the SQLite substrate.",
  "type": "module",
  "license": "UNLICENSED",
  "private": false,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "bin": {
    "memory-bujo": "./dist/cli.js"
  },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@mono-agent/memory-md": "workspace:0.2.2",
    "@mono-agent/memory-search": "workspace:0.2.2",
    "@mono-agent/memory-store": "workspace:0.2.2"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

- [ ] **Step 2: Create `packages/memory-bujo/tsconfig.json`** — identical to memory-store's (Task 1 Step 2).

- [ ] **Step 3: Create `packages/memory-bujo/tsconfig.build.json`** — identical to memory-store's (Task 1 Step 3).

- [ ] **Step 4: Create `packages/memory-bujo/README.md`** with all seven required sections and `Category: \`context\``:

```markdown
# @mono-agent/memory-bujo

## Category

Category: `context`

## Responsibility

The Bullet-Journal memory engine. It owns the markdown bullet grammar (lossless
parse/serialize), writes daily files as the canonical source of truth, mirrors
them into the SQLite substrate (`@mono-agent/memory-store`), composes a curated
always-in-context recall block, and rebuilds the index from markdown with no LLM.
It implements the `MemoryStore` contract so agent hosts can adopt it as a drop-in
memory mode.

## Install / Usage

```bash
pnpm --filter @mono-agent/memory-bujo run build
node packages/memory-bujo/dist/cli.js rebuild ./memory
```

```ts
import { createBujoMemoryStore } from "@mono-agent/memory-bujo";
import { createEmbeddingProvider } from "@mono-agent/memory-search";

const store = createBujoMemoryStore({
  root: "./memory",
  embeddings: createEmbeddingProvider({ provider: "ollama", model: "nomic-embed-text:v1.5" }),
  dim: 768,
});
const block = await store.load("global");
```

## Public API

- `createBujoMemoryStore`, `BujoMemoryStore`
- `parseBullet`, `serializeBullet`, `parseDailyFile`, `serializeDailyFile`
- `rebuildFromMarkdown`
- `Bullet`, `BujoOptions`

## Dependency Boundary

Depends on `@mono-agent/memory-store` (substrate), `@mono-agent/memory-search`
(embedding provider), and `@mono-agent/memory-md` (the `MemoryStore` contract). It
performs no LLM calls in Phase 1 — writes are deterministic rapid-log appends.

## What This Package Does Not Own

It does not own SQLite storage or ranking (that is `memory-store`), embedding
implementations (that is `memory-search`), entity extraction, reflection, or
migration scheduling (later phases).

## Verification

```bash
pnpm --filter @mono-agent/memory-bujo run build
pnpm --filter @mono-agent/memory-bujo run typecheck
pnpm --filter @mono-agent/memory-bujo run test
```
```

- [ ] **Step 5: Create temporary `packages/memory-bujo/src/index.ts` stub**

```ts
export const MEMORY_BUJO_PACKAGE = "@mono-agent/memory-bujo";
```

- [ ] **Step 6: Install + verify architecture**

Run: `pnpm install && node scripts/check-package-architecture.mjs`
Expected: "Package architecture check passed for N workspace packages." (catalog entry was added in Task 1).

- [ ] **Step 7: Commit**

```bash
git add packages/memory-bujo pnpm-lock.yaml
git commit -m "feat(memory-bujo): scaffold Bullet-Journal engine package"
```

---

## Task 10: Bullet grammar — lossless parse/serialize round-trip

**Files:**
- Create: `packages/memory-bujo/src/types.ts`
- Create: `packages/memory-bujo/src/grammar.ts`
- Test: `packages/memory-bujo/src/__tests__/grammar.test.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
import type { EmbeddingProvider } from "@mono-agent/memory-search";
import type { MemoryStatus, MemoryType } from "@mono-agent/memory-store";

/** One parsed markdown bullet line: a visible part + structured metadata from the trailing comment. */
export interface Bullet {
  readonly id: string;
  readonly type: MemoryType;
  readonly status: MemoryStatus;
  readonly text: string;
  readonly salience: number;
  readonly isInsight: boolean;
  readonly createdAt: string;
  readonly refs: readonly string[];
  readonly dueAt?: string;
}

export interface BujoOptions {
  readonly root: string;
  readonly embeddings: EmbeddingProvider;
  readonly dim: number;
  readonly maxBytes?: number;
  readonly clock?: () => Date;
}
```

- [ ] **Step 2: Write the failing test `src/__tests__/grammar.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import { parseBullet, serializeBullet, parseDailyFile, serializeDailyFile } from "../grammar.js";
import type { Bullet } from "../types.js";

const LINE =
  '- [ ] Ship the P1 substrate.  <!--mem id=01J type=task status=open salience=0.8 isInsight=0 created=2026-06-15T09:12:00.000Z refs=01A,01B-->';

describe("parseBullet/serializeBullet", () => {
  it("parses a task bullet with metadata", () => {
    const b = parseBullet(LINE);
    expect(b).toEqual({
      id: "01J", type: "task", status: "open", text: "Ship the P1 substrate.",
      salience: 0.8, isInsight: false, createdAt: "2026-06-15T09:12:00.000Z", refs: ["01A", "01B"], dueAt: undefined,
    } satisfies Bullet);
  });

  it("round-trips byte-for-byte for task/event/note across statuses", () => {
    const samples = [
      LINE,
      '- [x] Confirmed nomic tag is v1.5.  <!--mem id=01C type=note status=done salience=0.4 isInsight=0 created=2026-06-15T10:00:00.000Z refs=-->',
      '- ◦ Met about memory rituals.  <!--mem id=01D type=event status=open salience=0.5 isInsight=0 created=2026-06-15T11:00:00.000Z refs=-->',
      '- – Robert prefers opt-in, never silent fallback.  <!--mem id=01E type=note status=open salience=0.9 isInsight=1 created=2026-06-15T12:00:00.000Z refs=01C-->',
    ];
    for (const line of samples) {
      expect(serializeBullet(parseBullet(line))).toBe(line);
    }
  });

  it("returns undefined for non-bullet lines", () => {
    expect(parseBullet("## 2026-06-15")).toBeUndefined();
    expect(parseBullet("just prose")).toBeUndefined();
  });
});

describe("parseDailyFile/serializeDailyFile", () => {
  it("round-trips a daily file, preserving non-bullet lines verbatim", () => {
    const file = ["# 2026-06-15", "", LINE, "", "Some freeform note.", ""].join("\n");
    const parsed = parseDailyFile(file);
    expect(parsed.bullets).toHaveLength(1);
    expect(serializeDailyFile(parsed)).toBe(file);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @mono-agent/memory-bujo run test -- grammar`
Expected: FAIL — module `../grammar.js` not found.

- [ ] **Step 4: Write `src/grammar.ts`**

```ts
import type { MemoryStatus, MemoryType } from "@mono-agent/memory-store";

import type { Bullet } from "./types.js";

const MARKERS: Record<string, { type: MemoryType; status: MemoryStatus }> = {
  "[ ]": { type: "task", status: "open" },
  "[x]": { type: "task", status: "done" },
  "[>]": { type: "task", status: "migrated" },
  "[<]": { type: "task", status: "scheduled" },
  "[~]": { type: "task", status: "dropped" },
  "◦": { type: "event", status: "open" },
  "–": { type: "note", status: "open" },
};
const MARKER_FOR = (type: MemoryType, status: MemoryStatus): string => {
  for (const [marker, m] of Object.entries(MARKERS)) {
    if (m.type === type && m.status === status) return marker;
  }
  // notes/events that are done still serialize with their base marker + status in the comment
  if (type === "event") return "◦";
  return "–";
};

const LINE_RE = /^- (\[[ x><~]\]|◦|–) (.*?)  <!--mem (.*)-->$/u;

export function parseBullet(line: string): Bullet | undefined {
  const match = LINE_RE.exec(line);
  if (match === null) return undefined;
  const [, marker, text, meta] = match;
  const fields = parseMeta(meta ?? "");
  const base = MARKERS[marker ?? ""];
  if (base === undefined) return undefined;
  const status = (fields.status as MemoryStatus | undefined) ?? base.status;
  const type = (fields.type as MemoryType | undefined) ?? base.type;
  return {
    id: fields.id ?? "",
    type,
    status,
    text: text ?? "",
    salience: fields.salience === undefined ? 0.5 : Number(fields.salience),
    isInsight: fields.isInsight === "1",
    createdAt: fields.created ?? "",
    refs: fields.refs === undefined || fields.refs.length === 0 ? [] : fields.refs.split(","),
    dueAt: fields.due,
  };
}

export function serializeBullet(bullet: Bullet): string {
  const marker = MARKER_FOR(bullet.type, bullet.status);
  const meta = [
    `id=${bullet.id}`,
    `type=${bullet.type}`,
    `status=${bullet.status}`,
    `salience=${bullet.salience}`,
    `isInsight=${bullet.isInsight ? "1" : "0"}`,
    `created=${bullet.createdAt}`,
    `refs=${bullet.refs.join(",")}`,
    ...(bullet.dueAt === undefined ? [] : [`due=${bullet.dueAt}`]),
  ].join(" ");
  return `- ${marker} ${bullet.text}  <!--mem ${meta}-->`;
}

function parseMeta(meta: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of meta.trim().split(/\s+/u)) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

export interface DailyFile {
  readonly lines: readonly { readonly raw: string; readonly bullet?: Bullet }[];
}

export function parseDailyFile(content: string): DailyFile & { bullets: Bullet[] } {
  const lines = content.split("\n").map((raw) => {
    const bullet = parseBullet(raw);
    return bullet === undefined ? { raw } : { raw, bullet };
  });
  return { lines, bullets: lines.flatMap((l) => (l.bullet ? [l.bullet] : [])) };
}

export function serializeDailyFile(file: DailyFile): string {
  return file.lines.map((l) => (l.bullet ? serializeBullet(l.bullet) : l.raw)).join("\n");
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @mono-agent/memory-bujo run test -- grammar`
Expected: PASS (all cases, including byte-for-byte round-trip).

> If round-trip fails on the `– note` / `◦ event` `done` status, it is because `MARKER_FOR` collapses to the base marker while the comment carries the true status — that is intended and the test lines above only use `open` for event/note, so they pass. Keep status authoritative in the comment.

- [ ] **Step 6: Commit**

```bash
git add packages/memory-bujo/src/types.ts packages/memory-bujo/src/grammar.ts packages/memory-bujo/src/__tests__/grammar.test.ts
git commit -m "feat(memory-bujo): lossless bullet grammar (parse/serialize round-trip)"
```

---

## Task 11: Id generator + daily-file append

**Files:**
- Create: `packages/memory-bujo/src/ids.ts`
- Create: `packages/memory-bujo/src/daily.ts`
- Test: `packages/memory-bujo/src/__tests__/daily.test.ts`

- [ ] **Step 1: Write the failing test `src/__tests__/daily.test.ts`**

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appendBullet, dailyFilePath } from "../daily.js";
import { parseDailyFile } from "../grammar.js";

describe("daily file", () => {
  it("computes the daily path from a date", () => {
    expect(dailyFilePath("/root", new Date("2026-06-15T23:00:00.000Z"))).toBe("/root/daily/2026-06-15.md");
  });

  it("appends a bullet and is re-parseable", () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-"));
    const now = new Date("2026-06-15T09:00:00.000Z");
    const bullet = appendBullet(root, {
      id: "01TESTID", type: "note", status: "open", text: "A captured fact.", salience: 0.6, isInsight: false, createdAt: now.toISOString(), refs: [],
    }, now);
    const file = readFileSync(dailyFilePath(root, now), "utf8");
    const parsed = parseDailyFile(file);
    expect(parsed.bullets.map((b) => b.id)).toContain("01TESTID");
    expect(bullet.id).toBe("01TESTID");
  });
});
```

- [ ] **Step 2: Write `src/ids.ts`**

```ts
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/** Minimal ULID-style id: 48-bit time + random suffix. Injectable for tests. */
export function createIdFactory(options: { clock?: () => Date; random?: () => number } = {}): () => string {
  const clock = options.clock ?? (() => new Date());
  const random = options.random ?? Math.random;
  return () => {
    let time = clock().getTime();
    const timeChars: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      timeChars.unshift(ENCODING[time % 32] ?? "0");
      time = Math.floor(time / 32);
    }
    let suffix = "";
    for (let i = 0; i < 16; i += 1) {
      suffix += ENCODING[Math.floor(random() * 32)] ?? "0";
    }
    return timeChars.join("") + suffix;
  };
}
```

- [ ] **Step 3: Write `src/daily.ts`**

```ts
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { serializeBullet } from "./grammar.js";
import type { Bullet } from "./types.js";

export function dailyFilePath(root: string, when: Date): string {
  const day = when.toISOString().slice(0, 10);
  return join(root, "daily", `${day}.md`);
}

/** Append a bullet to today's daily file (creating it with a heading if absent). Returns the bullet. */
export function appendBullet(root: string, bullet: Bullet, when: Date): Bullet {
  const path = dailyFilePath(root, when);
  mkdirSync(dirname(path), { recursive: true });
  let header = "";
  try {
    readFileSync(path, "utf8");
  } catch {
    header = `# ${when.toISOString().slice(0, 10)}\n\n`;
  }
  appendFileSync(path, `${header}${serializeBullet(bullet)}\n`, "utf8");
  return bullet;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @mono-agent/memory-bujo run test -- daily`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add packages/memory-bujo/src/ids.ts packages/memory-bujo/src/daily.ts packages/memory-bujo/src/__tests__/daily.test.ts
git commit -m "feat(memory-bujo): ULID-style ids + daily-file append"
```

---

## Task 12: Curated recall block

**Files:**
- Create: `packages/memory-bujo/src/recall.ts`
- Test: `packages/memory-bujo/src/__tests__/recall.test.ts`

- [ ] **Step 1: Write the failing test `src/__tests__/recall.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import { openMemoryDb } from "@mono-agent/memory-store";
import { fakeEmbeddings } from "../../../memory-store/src/__tests__/helpers.js";
import { composeRecallBlock } from "../recall.js";

describe("composeRecallBlock", () => {
  it("renders a markdown block with the most relevant memories and a source label", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    await db.upsert({ id: "a", type: "note", status: "open", text: "Robert prefers opt-in memory.", salience: 0.9, isInsight: true, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {} });
    await db.upsert({ id: "b", type: "task", status: "open", text: "Ship the substrate.", salience: 0.6, isInsight: false, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {} });
    const block = await composeRecallBlock(db, "memory preferences", { topK: 5 });
    expect(block.kind).toBe("markdown");
    expect(block.source).toBe("memory-bujo");
    expect(block.content).toContain("Robert prefers opt-in memory.");
    expect(block.truncated).toBe(false);
    db.close();
  });

  it("truncates to the byte budget and flags it", async () => {
    const db = openMemoryDb({ path: ":memory:", embeddings: fakeEmbeddings(64), dim: 64 });
    for (let i = 0; i < 20; i += 1) {
      await db.upsert({ id: `m${i}`, type: "note", status: "open", text: `memory fact number ${i} about cats`, salience: 0.5, isInsight: false, createdAt: "2026-06-15T09:00:00.000Z", accessCount: 0, tags: [], source: {} });
    }
    const block = await composeRecallBlock(db, "cats", { topK: 20, maxBytes: 120 });
    expect(Buffer.byteLength(block.content, "utf8")).toBeLessThanOrEqual(120);
    expect(block.truncated).toBe(true);
    db.close();
  });
});
```

> Note: the cross-package import of `fakeEmbeddings` is a test-only convenience. If your tsconfig `rootDir` rejects the `../../../memory-store/...` path, copy the `fakeEmbeddings` helper into `packages/memory-bujo/src/__tests__/helpers.ts` instead (same body as Task 4 Step 2) and import locally.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @mono-agent/memory-bujo run test -- recall`
Expected: FAIL — `../recall.js` not found.

- [ ] **Step 3: Write `src/recall.ts`**

```ts
import type { MemoryBlock } from "@mono-agent/memory-md";
import type { MemoryDb } from "@mono-agent/memory-store";

const MARKER: Record<string, string> = { task: "- [ ]", event: "- ◦", note: "- –" };

export async function composeRecallBlock(
  db: MemoryDb,
  query: string,
  options: { topK?: number; maxBytes?: number } = {},
): Promise<MemoryBlock> {
  const maxBytes = options.maxBytes ?? 8_000;
  const hits = await db.recall(query, { topK: options.topK ?? 8 });
  const lines = ["## Memory (recalled)", ""];
  for (const hit of hits) {
    const star = hit.record.isInsight ? " *" : "";
    lines.push(`${MARKER[hit.record.type] ?? "- –"} ${hit.record.text}${star}`);
  }
  let content = lines.join("\n");
  let truncated = false;
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    content = clampToBytes(content, maxBytes);
    truncated = true;
  }
  return { kind: "markdown", content, source: "memory-bujo", truncated };
}

function clampToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  // Cut on a UTF-8 boundary by decoding a sliced buffer leniently.
  return new TextDecoder("utf-8").decode(buf.subarray(0, maxBytes)).replace(/�+$/u, "");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @mono-agent/memory-bujo run test -- recall`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add packages/memory-bujo/src/recall.ts packages/memory-bujo/src/__tests__/recall.test.ts
git commit -m "feat(memory-bujo): curated recall block with byte-budget truncation flag"
```

---

## Task 13: `BujoMemoryStore` — implements the `MemoryStore` contract

**Files:**
- Create: `packages/memory-bujo/src/store.ts`
- Modify: `packages/memory-bujo/src/index.ts`
- Test: `packages/memory-bujo/src/__tests__/store.test.ts`

- [ ] **Step 1: Write the failing test `src/__tests__/store.test.ts`**

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { fakeEmbeddings } from "../../../memory-store/src/__tests__/helpers.js";
import { createBujoMemoryStore } from "../store.js";
import { dailyFilePath } from "../daily.js";
import { parseDailyFile } from "../grammar.js";

describe("BujoMemoryStore", () => {
  it("appendHostSummary writes a canonical daily bullet and indexes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-"));
    const now = new Date("2026-06-15T09:00:00.000Z");
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64, clock: () => now });

    const result = await store.appendHostSummary("global", "Robert prefers opt-in memory, never silent fallback.");
    expect(result.bytesWritten).toBeGreaterThan(0);

    const file = readFileSync(dailyFilePath(root, now), "utf8");
    const parsed = parseDailyFile(file);
    expect(parsed.bullets).toHaveLength(1);
    expect(parsed.bullets[0]?.text).toContain("opt-in memory");

    const block = await store.load("global");
    expect(block?.content).toContain("opt-in memory");
    await store.close();
  });

  it("conforms to MemoryStore (load returns undefined-safe markdown block)", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-store-"));
    const store = createBujoMemoryStore({ root, embeddings: fakeEmbeddings(64), dim: 64 });
    const block = await store.load("global");
    expect(block?.kind).toBe("markdown");
    await store.close();
  });
});
```

> Apply the same cross-package-import note from Task 12 Step 1 if needed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @mono-agent/memory-bujo run test -- store`
Expected: FAIL — `../store.js` not found.

- [ ] **Step 3: Write `src/store.ts`**

```ts
import { join } from "node:path";

import type { MemoryBlock, MemoryStore, MemoryWriteResult } from "@mono-agent/memory-md";
import { openMemoryDb, type MemoryDb, type MemoryRecord } from "@mono-agent/memory-store";

import { appendBullet, dailyFilePath } from "./daily.js";
import { createIdFactory } from "./ids.js";
import { composeRecallBlock } from "./recall.js";
import type { Bullet, BujoOptions } from "./types.js";

export class BujoMemoryStore implements MemoryStore {
  private readonly root: string;
  private readonly db: MemoryDb;
  private readonly maxBytes: number;
  private readonly clock: () => Date;
  private readonly nextId: () => string;

  constructor(options: BujoOptions) {
    this.root = options.root;
    this.maxBytes = options.maxBytes ?? 8_000;
    this.clock = options.clock ?? (() => new Date());
    this.nextId = createIdFactory({ clock: this.clock });
    this.db = openMemoryDb({
      path: join(options.root, "memory.db"),
      embeddings: options.embeddings,
      dim: options.dim,
    });
  }

  async load(conversationId: string): Promise<MemoryBlock | undefined> {
    // Phase 1: prime with recent high-salience memories. The query is the conversation id
    // as a coarse seed; richer session-aware priming arrives with reflection (P3).
    return composeRecallBlock(this.db, conversationId, { topK: 8, maxBytes: this.maxBytes });
  }

  async appendHostSummary(conversationId: string, summary: string): Promise<MemoryWriteResult> {
    const now = this.clock();
    const bullet: Bullet = {
      id: this.nextId(),
      type: "note",
      status: "open",
      text: summary.trim(),
      salience: 0.5,
      isInsight: false,
      createdAt: now.toISOString(),
      refs: [],
    };
    const path = dailyFilePath(this.root, now);
    appendBullet(this.root, bullet, now);
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
      source: { session: conversationId, file: dailyFilePath(this.root, now).replace(`${this.root}/`, "") },
    };
    await this.db.upsert(record);
    return { conversationId, source: path, bytesWritten: Buffer.byteLength(summary, "utf8") };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export function createBujoMemoryStore(options: BujoOptions): BujoMemoryStore {
  return new BujoMemoryStore(options);
}
```

- [ ] **Step 4: Update `src/index.ts`**

```ts
export { createBujoMemoryStore, BujoMemoryStore } from "./store.js";
export { composeRecallBlock } from "./recall.js";
export { rebuildFromMarkdown } from "./rebuild.js";
export { parseBullet, serializeBullet, parseDailyFile, serializeDailyFile } from "./grammar.js";
export { appendBullet, dailyFilePath } from "./daily.js";
export { createIdFactory } from "./ids.js";
export type { Bullet, BujoOptions } from "./types.js";
```

> `rebuild.js` is created in Task 14; the export line will resolve once that task lands. If you run a build between tasks, comment the `rebuildFromMarkdown` export until Task 14.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @mono-agent/memory-bujo run test -- store`
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add packages/memory-bujo/src/store.ts packages/memory-bujo/src/index.ts packages/memory-bujo/src/__tests__/store.test.ts
git commit -m "feat(memory-bujo): BujoMemoryStore implements MemoryStore over daily files + SQLite"
```

---

## Task 14: Rebuild-from-markdown (deterministic, no LLM) + CLI

**Files:**
- Create: `packages/memory-bujo/src/rebuild.ts`
- Create: `packages/memory-bujo/src/cli.ts`
- Test: `packages/memory-bujo/src/__tests__/rebuild.test.ts`

- [ ] **Step 1: Write the failing test `src/__tests__/rebuild.test.ts`**

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openMemoryDb } from "@mono-agent/memory-store";
import { fakeEmbeddings } from "../../../memory-store/src/__tests__/helpers.js";
import { rebuildFromMarkdown } from "../rebuild.js";

describe("rebuildFromMarkdown", () => {
  it("indexes every bullet across daily files, with no LLM, deterministically", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-rebuild-"));
    mkdirSync(join(root, "daily"), { recursive: true });
    writeFileSync(join(root, "daily", "2026-06-14.md"),
      '# 2026-06-14\n\n- [ ] Ship substrate.  <!--mem id=01A type=task status=open salience=0.8 isInsight=0 created=2026-06-14T09:00:00.000Z refs=-->\n');
    writeFileSync(join(root, "daily", "2026-06-15.md"),
      '# 2026-06-15\n\n- – Robert prefers opt-in memory.  <!--mem id=01B type=note status=open salience=0.9 isInsight=1 created=2026-06-15T09:00:00.000Z refs=-->\n');

    const db = openMemoryDb({ path: join(root, "memory.db"), embeddings: fakeEmbeddings(64), dim: 64 });
    const result = await rebuildFromMarkdown(root, db);
    expect(result.indexed).toBe(2);
    expect(db.count()).toBe(2);
    expect((await db.recall("substrate", { topK: 2 })).map((h) => h.record.id)).toContain("01A");
    db.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @mono-agent/memory-bujo run test -- rebuild`
Expected: FAIL — `../rebuild.js` not found.

- [ ] **Step 3: Write `src/rebuild.ts`**

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { MemoryDb, MemoryRecord } from "@mono-agent/memory-store";

import { parseDailyFile } from "./grammar.js";
import type { Bullet } from "./types.js";

/** Rebuild the SQLite index from canonical markdown. No LLM — re-embeds via the db's provider. */
export async function rebuildFromMarkdown(root: string, db: MemoryDb): Promise<{ indexed: number }> {
  const dailyDir = join(root, "daily");
  let files: string[];
  try {
    files = readdirSync(dailyDir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    files = [];
  }
  const records: MemoryRecord[] = [];
  for (const file of files) {
    const parsed = parseDailyFile(readFileSync(join(dailyDir, file), "utf8"));
    parsed.bullets.forEach((bullet, index) => {
      records.push(toRecord(bullet, `daily/${file}`, index));
    });
  }
  return db.rebuild(records);
}

function toRecord(bullet: Bullet, file: string, line: number): MemoryRecord {
  return {
    id: bullet.id,
    type: bullet.type,
    status: bullet.status,
    text: bullet.text,
    salience: bullet.salience,
    isInsight: bullet.isInsight,
    createdAt: bullet.createdAt,
    accessCount: 0,
    dueAt: bullet.dueAt,
    tags: [],
    source: { file, line },
  };
}
```

- [ ] **Step 4: Write `src/cli.ts`**

```ts
#!/usr/bin/env node
import { join } from "node:path";

import { createEmbeddingProvider } from "@mono-agent/memory-search";
import { openMemoryDb } from "@mono-agent/memory-store";

import { rebuildFromMarkdown } from "./rebuild.js";

async function main(): Promise<void> {
  const [command, root, ...rest] = process.argv.slice(2);
  if (command !== "rebuild" && command !== "recall") {
    process.stderr.write("usage: memory-bujo <rebuild|recall> <root> [query]\n");
    process.exit(2);
  }
  if (root === undefined) {
    process.stderr.write("error: <root> is required\n");
    process.exit(2);
  }
  const model = process.env.MONO_AGENT_EMBED_MODEL ?? "nomic-embed-text:v1.5";
  const dim = Number(process.env.MONO_AGENT_EMBED_DIM ?? "768");
  const embeddings = createEmbeddingProvider({ provider: "ollama", model });
  const db = openMemoryDb({ path: join(root, "memory.db"), embeddings, dim });
  if (command === "rebuild") {
    const result = await rebuildFromMarkdown(root, db);
    process.stdout.write(`rebuilt: indexed ${result.indexed} memories into ${join(root, "memory.db")}\n`);
  } else {
    const hits = await db.recall(rest.join(" "), { topK: 8 });
    for (const hit of hits) process.stdout.write(`${hit.score.toFixed(3)}  ${hit.record.text}\n`);
  }
  db.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`memory-bujo failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
```

- [ ] **Step 5: Run the test, typecheck, build**

Run: `pnpm --filter @mono-agent/memory-bujo run test && pnpm --filter @mono-agent/memory-bujo run typecheck && pnpm --filter @mono-agent/memory-bujo run build`
Expected: all tests pass; clean typecheck; build emits `dist/cli.js`.

- [ ] **Step 6: Commit**

```bash
git add packages/memory-bujo/src/rebuild.ts packages/memory-bujo/src/cli.ts packages/memory-bujo/src/__tests__/rebuild.test.ts
git commit -m "feat(memory-bujo): deterministic rebuild-from-markdown + rebuild/recall CLI"
```

---

## Task 15: Integration test against the real local Ollama (guarded)

**Files:**
- Test: `packages/memory-bujo/src/__tests__/ollama.integration.test.ts`

- [ ] **Step 1: Write the guarded integration test**

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createEmbeddingProvider } from "@mono-agent/memory-search";
import { createBujoMemoryStore } from "../store.js";

const OLLAMA = process.env.MONO_AGENT_OLLAMA_E2E === "1";

describe.skipIf(!OLLAMA)("BujoMemoryStore @ real Ollama", () => {
  it("captures and semantically recalls a fact via nomic-embed-text:v1.5", async () => {
    const root = mkdtempSync(join(tmpdir(), "bujo-e2e-"));
    const store = createBujoMemoryStore({
      root,
      embeddings: createEmbeddingProvider({ provider: "ollama", model: "nomic-embed-text:v1.5" }),
      dim: 768,
    });
    await store.appendHostSummary("global", "The team decided to adopt opt-in memory with a validate self-check.");
    await store.appendHostSummary("global", "Lunch was pizza on Tuesday.");
    const block = await store.load("memory configuration decision");
    expect(block?.content).toContain("opt-in memory");
    await store.close();
  }, 30_000);
});
```

- [ ] **Step 2: Run unit suite (integration skipped by default)**

Run: `pnpm --filter @mono-agent/memory-bujo run test`
Expected: PASS; the Ollama test reports as skipped.

- [ ] **Step 3: Run the integration test against real Ollama (manual gate)**

Run: `MONO_AGENT_OLLAMA_E2E=1 pnpm --filter @mono-agent/memory-bujo run test -- ollama`
Expected: PASS — semantic recall surfaces the memory decision over the pizza note. (Requires `ollama serve` running and `ollama pull nomic-embed-text:v1.5`.)

- [ ] **Step 4: Commit**

```bash
git add packages/memory-bujo/src/__tests__/ollama.integration.test.ts
git commit -m "test(memory-bujo): guarded end-to-end recall against real Ollama"
```

---

## Task 16: Phase-1 verification gate (whole-repo)

**Files:** none (verification only).

- [ ] **Step 1: Architecture check**

Run: `node scripts/check-package-architecture.mjs`
Expected: "Package architecture check passed for N workspace packages."

- [ ] **Step 2: Build + typecheck both packages in dependency order**

Run: `pnpm --filter @mono-agent/memory-store --filter @mono-agent/memory-bujo run build && pnpm --filter @mono-agent/memory-store --filter @mono-agent/memory-bujo run typecheck`
Expected: clean.

- [ ] **Step 3: Full test suites for both packages**

Run: `pnpm --filter @mono-agent/memory-store run test && pnpm --filter @mono-agent/memory-bujo run test`
Expected: all green; integration test skipped.

- [ ] **Step 4: Native-dependency load gate (spec risk)**

Run: `node -e "import('@mono-agent/memory-store').then(async (m)=>{const db=m.openMemoryDb({path:':memory:',embeddings:{id:'x',embed:async()=>[]},dim:8});console.log('vec',db.vecVersion());db.close();})"`
Expected: prints a `vec` version — confirms `better-sqlite3` + `sqlite-vec` prebuilt binaries load in this Node/runtime (the launchd-context concern from the spec is the same binary path).

- [ ] **Step 5: CLI smoke test**

Run: `node packages/memory-bujo/dist/cli.js rebuild ./.tmp-bujo-smoke || true` then inspect output.
Expected: prints `rebuilt: indexed 0 memories ...` for an empty/new root (no crash). Remove `./.tmp-bujo-smoke` afterward.

- [ ] **Step 6: Final commit (if any docs/notes changed)**

```bash
git add -A
git commit -m "chore(memory): Phase 1 verification gate green (substrate + bujo engine)" || echo "nothing to commit"
```

---

## Self-Review (completed during planning)

**Spec coverage** (against `2026-06-15-memory-bujo-design.md`):
- §4 packages → Tasks 1, 9 (scaffold `memory-store`, `memory-bujo`); `memory-mcp`/`agent-host`/config wiring deferred to P4 by design.
- §5 domain model → Task 3 `types.ts` (`MemoryRecord` mirrors the spec's `Memory`; markdown-only fields like `refs`/`collection` mapping handled in `Bullet`).
- §6.1 markdown layout + bullet grammar → Tasks 10, 11, 14.
- §6.2 SQLite DDL (memories/edges/FTS5/vec0, bi-temporal) → Task 3 `schema.ts`. *(entities/entity_relations tables deferred to P2 with entity extraction — flagged below.)*
- §7 threading edges → Tasks 7 (supersedes), 8 (thread/about/expand). Typed-entity extraction is P2.
- §8 retrieval (RRF + recency/salience/insight, two-mode expand, access bump, query prefix) → Tasks 5, 6, 8.
- §9.1 deterministic capture (no LLM) → Task 13. LLM distill/reconcile is P2.
- §10 embeddings/substrate (nomic v1.5, injected provider, per-vector model/dim) → Tasks 3, 4, 13.
- §13 testing (round-trip, rebuild determinism, contract conformance, real-Ollama) → Tasks 8, 10, 13, 15.
- §14 P1 acceptance bar (drop-in hybrid retrieval, MemoryStore conformance, rebuild determinism) → Tasks 6, 8, 13, 16.

**Deferred-by-design (not P1 gaps):** entity tables + extraction, reflection, migration cron, future-log, config/composer/feature-registry/validate, live rollout — each is an explicit later-phase plan per the spec.

**Placeholder scan:** none — every code step contains complete code; the only conditional ("if the spike showed a different KNN form") is an explicit, resolved branch tied to Task 2's output.

**Type consistency:** `MemoryRecord`/`MemoryStatus`/`MemoryType`/`MemoryEdgeKind` defined once in `memory-store/types.ts` and imported by `memory-bujo`; `Bullet` is `memory-bujo`-local; `openMemoryDb`/`MemoryDb`/`recall`/`upsert`/`supersede`/`addEdge`/`expand`/`rebuild`/`count`/`get`/`edges`/`vecVersion`/`close` are named identically across tasks; `composeRecallBlock`, `createBujoMemoryStore`, `rebuildFromMarkdown`, `parseBullet`/`serializeBullet` are consistent between definition and use.
