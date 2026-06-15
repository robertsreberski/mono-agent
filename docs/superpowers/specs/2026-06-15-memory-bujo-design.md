# Memory v2 — The Bullet-Journal Engine

**Status:** Design approved (2026-06-15) — pending written-spec review before planning.
**Branch:** `feat/memory-bujo`
**Author:** brainstorming session, grounded in a 4-track research workflow (BuJo method, SOTA agentic memory, existing mono-agent memory, embeddings/storage).

---

## 1. Goal & north star

Bake a **superior, local-first, Bullet-Journal-inspired memory system** into the mono-agent framework. Two co-equal pillars:

1. **The engine** — a new first-class memory system whose differentiator is the *rituals that act on the store over time*: consolidation/**migration**, **threading** (associative links), **reflection** (AM/PM), bi-temporal forgetting, and hybrid semantic recall. Capture/search alone is table stakes; the loops *between* captures are the soul.
2. **The surfacing** — the engine must be discoverable and verifiable through the agent-**creation playbook**. Today the powerful memory machinery exists but never surfaced in real trials, so agents silently fell back to single-file `MEMORY.md`. The `mono-agent-composer` skill must *proactively* offer it, the config must expose it cleanly, `docs/feature-registry.md` must map it, and `validate` must confirm it is actually live (no silent degradation).

A great memory engine that the playbook never surfaces is worthless. Both pillars ship.

## 2. Decisions of record

From the brainstorming dialogue (all confirmed by the user):

| # | Decision | Choice |
|---|---|---|
| 1 | Architecture direction | **B — full BuJo rebuild**: a new first-class engine, not bolt-ons. |
| 2 | Source of truth | **Markdown files canonical; SQLite is a rebuildable, disposable index.** |
| 3 | Write path | **Pipeline distills atomic facts** post-turn (mem0-style), not agent self-edit. |
| 4 | Forgetting | **Invalidate + decay-rank; never hard-delete** (bi-temporal). |
| 5 | Migration cadence | **Time-based cron**: nightly reflect (light), monthly migrate (deep). |
| 6 | Threading/graph depth | **Threading links + typed entities, both first-class.** |
| 7 | Reflection autonomy | **Fully autonomous LLM reflection** each session. |
| 8 | Surfacing | **Opt-in (default stays `markdown`)**, but composer proactively offers it + `validate` self-check so it's impossible to miss or to fail silently. |
| F1 | New native dependency (`better-sqlite3` + `sqlite-vec`) reversing the prior "dependency-free" stance | **Approved.** |
| F2 | Extracted entities written to a canonical `graph.jsonl` so the DB rebuilds without re-running LLM extraction | **Approved.** |
| — | Embedding tier | Local `nomic-embed-text:v1.5` default; **opt-in** OpenAI `text-embedding-3-small` quality tier. |

## 3. Verified current state (ground truth, 2026-06-15)

Confirmed by reading the code, not the research summary:

- **Five memory packages exist** (`@mono-agent/memory-md`, `-journal`, `-graph`, `-search`, `-mcp`), all v0.2.2, wired through a clean `MemoryStore` contract in `packages/memory-md/src/types.ts` + `memory-store.ts`.
- The **live config uses the simplest mode**: `mono-agent.config.json → memory.scope: "single-file"`, `writeMode: "append-host-summary"` — i.e. deterministic transcript concatenation into one `MEMORY.md`. The journal/graph/search machinery is built but not the live path.
- **There is NO prefix bug.** `packages/memory-search/src/vector-index.ts:48,61` correctly applies `search_document: ` on index and `search_query: ` on query. *(The research over-called this; struck from scope.)*
- **Real retrieval weaknesses:** `VectorMemoryIndex.rebuild()` (`vector-index.ts:46`) **replaces the entire index** and re-embeds everything on any change — no incremental upsert. Search is brute-force cosine only — **no BM25/keyword, no hybrid fusion, no recency/salience scoring**.
- **No SQLite anywhere** (0 hits for `better-sqlite3`/`sqlite-vec` in `pnpm-lock.yaml`). The prior team deliberately chose dependency-free brute-force cosine (see `memory-subsystem` memory note). Decision F1 reverses this consciously.
- **No consolidation/forgetting/temporality.** `entity_upsert`/`memory_reindex` MCP tools exist but nothing drives them. `monthly/` is referenced but never written. Daily notes grow unbounded and are truncated at ~64 KB, silently dropping content within a busy day.
- **cron-as-markdown engine is real**: `packages/cron-adapter/src/{scheduler,jobs-dir,config}.ts`. Migration rituals will ride it.

**Verdict:** the contracts are good; the intelligence *between* captures is absent. That gap is the project.

## 4. Architecture — packages

Isolation-first. The substrate (storage/retrieval, no LLM) is separated from the engine (intelligence + markdown) so the substrate is unit-testable without a model.

| Package | Role | Change |
|---|---|---|
| `@mono-agent/memory-md` | `MemoryStore` contract + markdown mode | **keep** — contract reused as the integration seam |
| `@mono-agent/memory-search` | Embedding **providers** (Ollama/OpenAI) + chunking utilities | **keep** — consumed by `memory-store` for the embedding interface |
| **`@mono-agent/memory-store`** *(new)* | SQLite substrate: schema + migrations, `sqlite-vec` + FTS5, **RRF hybrid retrieval + re-scoring**, bi-temporal columns, edges & entities, **incremental upsert**, rebuild-from-files. **No LLM.** | **new** |
| **`@mono-agent/memory-bujo`** *(new)* | The BuJo engine: domain model, markdown readers/writers (daily/monthly/future/collections/index + canonical `graph.jsonl`), capture→distill→reconcile pipeline, AM/PM reflection, migration cron jobs, two-mode retrieval orchestration. **Implements `MemoryStore`.** | **new** |
| `@mono-agent/memory-mcp` | Add tools: `memory_recall` (hybrid), `thread_expand`, `future_log`, `migrate_now`; point at the bujo engine when active | **extend** |
| `@mono-agent/memory-journal`, `-graph` | legacy `journal` mode | **keep for back-compat**, superseded by `bujo` mode |

Because `memory-bujo` implements `MemoryStore`, `agent-host` wiring (`packages/agent-host/src/index.ts`) is a drop-in: selecting `bujo` mode is a composition choice, not a contract change.

Dependency direction: `memory-bujo → {memory-store, memory-search, memory-md(contract), an LLM client}`; `memory-store → {better-sqlite3, sqlite-vec, memory-search(embedding iface)}`. No cycles. Respect `scripts/check-package-architecture.mjs` (catalog + README sections).

## 5. Domain model — the "bullet"

A **Memory** is the atomic unit (BuJo bullet), born at ideal granularity (1–3 sentences, *not* chunked):

```ts
type MemoryType = "task" | "event" | "note";          // • task / ○ event / — note
type MemoryStatus =
  | "open" | "done" | "scheduled" | "migrated" | "dropped" | "invalidated";

interface Memory {
  id: string;                 // stable, ULID-style (sortable, no PII)
  type: MemoryType;
  status: MemoryStatus;       // drives retention; "dropped"/"invalidated" = forgotten, never deleted
  text: string;               // canonical atomic content
  salience: number;           // 0..1 signifier (priority "*")
  isInsight: boolean;         // signifier "!" — reflection-synthesized higher-level belief
  createdAt: string;          // ISO8601
  lastAccessedAt?: string;
  accessCount: number;
  validFrom?: string;         // bi-temporal validity window (events/facts)
  validTo?: string;           // set when superseded/forgotten — NOT deleted
  supersededBy?: string;      // id of the memory that replaced this one
  supersededAt?: string;
  dueAt?: string;             // future-log scheduled intentions
  tags: string[];             // small controlled vocabulary, kept sparse
  collection?: string;        // optional "home" topic slug
  source: { session?: string; file?: string; line?: number };  // provenance
  embeddingModel?: string;    // per-vector, enables clean re-index on model switch
  dim?: number;
}
```

Threading edges and typed entities are separate first-class objects (§7).

## 6. Storage layout

### 6.1 Canonical markdown (the human notebook, git-friendly)

```
<root>/
  daily/<YYYY-MM-DD>.md      # rapid-logged bullets; each carries a stable id
  monthly/<YYYY-MM>.md       # migration record (written by the monthly ritual)
  collections/<slug>.md      # topic threads (BuJo collections)
  future-log.md              # due-dated intentions queue
  index.md                   # living table of contents, auto-grown
  graph.jsonl                # canonical extracted entities + entity relations (F2)
  memory.db                  # DISPOSABLE SQLite index (gitignored; rebuildable)
```

**Bullet line grammar** (visible BuJo-clean; machine metadata in a trailing comment for lossless round-trip — the comment is the parse source of truth):

```
- [ ] Ship the memory-bujo P1 substrate.  <!--mem id=01J... type=task status=open salience=0.8 created=2026-06-15T09:12Z refs=01J...,01J... -->
- [x] Confirmed Ollama nomic tag is :v1.5. <!--mem id=... type=note status=done salience=0.4 ... -->
- ◦ Met about memory rituals.              <!--mem id=... type=event ... validFrom=... -->
- – Robert prefers opt-in, never silent fallback. <!--mem id=... type=note isInsight=1 salience=0.9 ... -->
```

Markers: `- [ ]` open · `- [x]` done · `- [>]` migrated · `- [<]` scheduled · `- [~]` dropped (struck) · `- ◦` event · `- –` note. The exact grammar is finalized in P1; round-trip fidelity (parse → model → serialize → identical bytes) is a P1 acceptance test.

`daily/` is a memory's **home** (provenance). Collections and threads *reference* ids; they don't duplicate text. `graph.jsonl` reuses the existing `memory-graph` entity/relation schema so legacy data imports cleanly.

### 6.2 SQLite index (`memory.db`, rebuildable from §6.1)

Substrate: **better-sqlite3** (sync, mature) + **sqlite-vec** (`vec0`) + **FTS5**, one file, one transaction, one backup. (`node:sqlite` noted as a future zero-third-party-dep path once `vec0` is loadable there.)

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  rowid_int INTEGER UNIQUE,          -- maps to vec0/fts rowid
  type TEXT NOT NULL CHECK(type IN ('task','event','note')),
  status TEXT NOT NULL CHECK(status IN ('open','done','scheduled','migrated','dropped','invalidated')),
  text TEXT NOT NULL,
  salience REAL NOT NULL DEFAULT 0.5,
  is_insight INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT, valid_to TEXT,
  superseded_by TEXT REFERENCES memories(id),
  superseded_at TEXT,
  due_at TEXT,
  collection TEXT,
  source_session TEXT, source_file TEXT, source_line INTEGER,
  embedding_model TEXT, dim INTEGER
);
CREATE TABLE memory_tags (memory_id TEXT REFERENCES memories(id), tag TEXT, PRIMARY KEY(memory_id, tag));

CREATE TABLE edges (                 -- threading + provenance + supersession
  src TEXT NOT NULL, dst TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('thread','about','supports','supersedes')),
  weight REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  PRIMARY KEY(src, dst, kind)
);

CREATE TABLE entities (              -- typed entity graph (mirrors canonical graph.jsonl)
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, summary TEXT,
  created_at TEXT NOT NULL, updated_at TEXT
);
CREATE TABLE entity_relations (src TEXT, dst TEXT, relation TEXT, created_at TEXT, PRIMARY KEY(src,dst,relation));

CREATE VIRTUAL TABLE memories_fts USING fts5(text, content='memories', content_rowid='rowid_int');
CREATE VIRTUAL TABLE memories_vec USING vec0(embedding float[768]);   -- dim from config; int8 quantization optional
```

**Rebuild contract:** deleting `memory.db` and re-running `memory-store rebuild <root>` reconstructs the full index from the markdown files + `graph.jsonl` with **no LLM calls** (entities already canonical per F2; only re-embedding runs). This is a P1 acceptance test.

## 7. Threading & entities (decision 6)

- **Threading (memory↔memory):** `edges(kind='thread')`. Created automatically at write time (link a new memory to its top-K nearest neighbors above a similarity threshold, weighted by similarity) and during migration (clustering). This is the associative-recall substrate.
- **Typed entities (memory→entity & entity↔entity):** an extraction pass identifies named entities (people, projects, orgs, concepts) and relations, written canonically to `graph.jsonl` and mirrored into `entities`/`entity_relations`. Memories link to entities via `edges(kind='about')`. Reuses `memory-graph`'s schema.
- **Two-mode retrieval payoff (§8):** hybrid search to *enter* the graph; edge traversal (1–2 hops over `thread`/`about`) to *expand*.

## 8. Retrieval (read path)

1. **Candidate generation (parallel):** FTS5/BM25 top-N + `sqlite-vec` cosine top-N over the query embedding (`search_query: ` prefix preserved; renormalize after any Matryoshka truncation).
2. **Fusion:** **Reciprocal Rank Fusion**, `rrf(d) = Σ_lists 1 / (k + rank_list(d))`, `k = 60`.
3. **Re-score** (Generative-Agents style):
   `score(d) = w_rrf·rrf(d) + w_recency·decay(last_accessed_at) + w_salience·salience(d) + w_insight·isInsight(d)`
   with `decay(t) = γ^Δdays` (default `γ = 0.995`), filtering out `status ∈ {dropped, invalidated}` and `valid_to < now` unless a point-in-time query asks for history. Default weights `{rrf:1.0, recency:0.3, salience:0.3, insight:0.2}` (config-tunable).
4. **Expand:** traverse `thread`/`about` edges 1 hop (configurable) from the top hits, merge, dedup.
5. **Side effects:** bump `last_accessed_at`/`access_count` on returned memories (feeds decay/promotion).

**Always-in-context block (AM priming):** instead of dumping today's note, the engine composes a *curated* block: top-salient pinned memories + memories relevant to the current session + due/overdue future-log intentions + open high-salience tasks. Capped to a byte budget; never silently truncates mid-item.

## 9. The three loops (engine intelligence)

### 9.1 Capture — pipeline-distilled writes (decision 3)
- **During the turn:** a cheap rapid-log append captures raw observations to the daily file (no LLM) so nothing is lost.
- **At session end (PM):** the **Distiller** (LLM) extracts atomic, typed candidate bullets (task/event/note) with a salience estimate.
- **Reconciliation (mem0 ADD/UPDATE/SUPERSEDE/NOOP):** for each candidate `c`: embed → retrieve top-K (≈5) similar existing memories `M` → LLM classifies:
  - **ADD** — novel: insert.
  - **UPDATE(target, mergedText)** — same fact, more detail: merge text/salience, bump access.
  - **SUPERSEDE(target, newText)** — contradicts/replaces: set `target.status='invalidated'`, `superseded_by=new.id`, `superseded_at=now`, `valid_to=now`; insert new; add `edges(supersedes)`. *(Bi-temporal — old row stays.)*
  - **NOOP** — duplicate: bump `target.last_accessed`.
- **Auto-thread + extract:** add `thread` edges to nearest neighbors; run entity extraction → `graph.jsonl` + `about` edges.
- Incremental index upsert (single transaction); no full rebuild.

### 9.2 Reflection — AM/PM, fully autonomous (decision 7)
- **AM (session-start priming):** compose the curated always-in-context block (§8); surface due intentions and open tasks.
- **PM (session-end reconciliation):** run the Distiller + reconciliation over the session; mark referenced tasks `done`/`scheduled`; queue follow-ups into the future log; write durable memories with provenance edges. Fully autonomous LLM pass, cheap enough to run every session.

### 9.3 Migration — scheduled cron (decisions 4, 5)
- **Nightly (light) — `0 3 * * *` (configurable):** decay salience by recency/access; promote hot facts (high salience + recently accessed) into the pinned/always-in-context set; **synthesize insights** — cluster recent related notes (by embedding + `thread` edges), LLM summarizes each cluster into a new `isInsight` note with `supports` edges to its sources; surface overdue `future-log` items.
- **Monthly (deep) — `0 4 1 * *` (configurable):** the BuJo ritual. Gather open tasks + aging/low-access memories; per item the LLM decides **promote** (episodic→semantic, raise salience) / **reschedule** (set `due_at`, status `scheduled`) / **cluster** (attach to a collection + edges) / **forget** (status `dropped`, `valid_to=now`). Rewrite `monthly/<YYYY-MM>.md` as the migration record; compact the hot context (move invalidated/dropped out of always-in-context). **Nothing is deleted** — forgetting is a status + bi-temporal stamp.

All three loops emit observability events (via `@mono-agent/observability`) so runs are inspectable.

## 10. Embeddings & substrate

- **Default (local):** `nomic-embed-text:v1.5` via Ollama, 768-dim. Mandatory full tag (`:v1.5`) — the bare alias is not pulled (known gotcha). Prefixes already correct; preserved.
- **Quality tier (opt-in):** OpenAI `text-embedding-3-small` via the existing `memory-search` provider; a config flip triggers a one-time bulk re-index. Local stays primary for privacy/offline.
- **Per-vector `embedding_model` + `dim`** stored so a model switch re-indexes cleanly without dimension confusion. Optional int8 quantization in `vec0` to keep the DB small; metadata filtering done in SQL (join by rowid), not inside `vec0`.
- **Chunking:** atomic memories are not chunked. Longer raw journal text (if embedded) → recursive ~512-token splits, ~10–15% overlap. FTS stores raw text *unprefixed*; the prefixed form is embedding input only.

## 11. Surfacing — the playbook pillar (decision 8)

Default `memory.mode` **stays `markdown`** (opt-in), but the engine is impossible to miss and impossible to fail silently:

- **Config schema** (`@mono-agent/config`): `memory.mode` gains `"bujo"`; new `memory.bujo` block:
  ```jsonc
  "memory": {
    "mode": "markdown",                 // default; "bujo" opt-in
    "bujo": {
      "root": "./memory",
      "embeddings": { "tier": "local", "model": "nomic-embed-text:v1.5", "dim": 768 },
      "reflection": { "enabled": true, "onSessionEnd": true },
      "migration": { "nightly": "0 3 * * *", "monthly": "0 4 1 * *" },
      "retrieval": { "k": 60, "topK": 8, "expandHops": 1,
                     "weights": { "rrf": 1.0, "recency": 0.3, "salience": 0.3, "insight": 0.2 } }
    }
  }
  ```
- **`mono-agent-composer` skill:** add a memory step that *proactively* explains BuJo memory, asks the BuJo questions (local vs quality tier, reflection on/off, migration cadence), and writes the config block. Surfaced even though not default.
- **`docs/feature-registry.md`:** add the BuJo-memory feature → config mapping row(s), closing the discoverability gap that this project exists to fix.
- **`validate` (CLI):** when `mode: "bujo"`, actively verify and report:
  - embeddings reachable (Ollama up **and** the exact tagged model pulled; or the configured remote key present),
  - `memory.db` writable and schema-current (run migrations),
  - index built / row counts sane,
  - and **warn loudly on any silent fallback** to markdown (the direct cure for "didn't surface / didn't know why it wasn't working").
- **`docs/memory.md`:** a short operator guide (modes, rituals, recall, troubleshooting).

## 12. Live `~/personal-agent` migration

The global `mono-agent` is symlinked to this repo, so a rebuild + `mono-agent restart` updates the live service. Rollout:

1. Existing `daily/*.md` are already canonical → index in place.
2. Import existing `graph.jsonl` entities into `entities`/`entity_relations`.
3. Discard the old embeddings JSONL → re-embed under the new index.
4. **Shadow-compare**: build the new index alongside the running markdown mode; run recall comparisons on real queries; review.
5. Flip the live config to `mode: "bujo"`, rebuild, `mono-agent restart`. Reversible (markdown files untouched; `memory.db` is disposable).

## 13. Testing strategy

- **Unit:** bullet parse/serialize **round-trip fidelity**; reconciliation decision routing (ADD/UPDATE/SUPERSEDE/NOOP) over fixtures; RRF fusion; re-score formula; bi-temporal supersede; decay scoring; **rebuild-from-files determinism** (no LLM).
- **Integration:** end-to-end against the **real local Ollama** — capture → reconcile → reflect → migrate on a seeded corpus; verify hot/cold transitions, threading, future-log surfacing.
- **Retrieval eval:** precision/recall before vs after, using the existing `@mono-agent/agent-evals` package, on a labeled query set.
- **Contract:** `MemoryStore` conformance suite so `agent-host` integration is provably drop-in.
- **Surfacing:** a `validate` test that asserts the loud-warning path fires when embeddings are unreachable.

## 14. Build phasing (sequenced within Direction B)

Each phase is independently valuable and shippable to the live service.

- **P1 — Substrate & retrieval.** `memory-store` (schema, migrations, `vec0`+FTS5, RRF + re-score, bi-temporal columns, **incremental upsert**, rebuild-from-files) + the markdown bullet model/parser + hybrid recall wired behind `MemoryStore` as `mode: "bujo"`. *Outcome:* a drop-in retrieval upgrade (hybrid + recency/salience) over existing markdown.
  *Acceptance:* round-trip + rebuild-determinism tests pass; hybrid recall beats brute-force cosine on the eval set; `MemoryStore` conformance green.
- **P2 — Capture intelligence.** Distiller + reconciliation pipeline (ADD/UPDATE/SUPERSEDE/NOOP) + threading edges + entity extraction → `graph.jsonl`.
  *Acceptance:* reconciliation routing tests pass; contradictions supersede (not duplicate); dedup works; entities import/round-trip.
- **P3 — Rituals.** AM/PM reflection hooks + nightly/monthly migration cron jobs + future-log queue + living `index.md`.
  *Acceptance:* seeded corpus shows decay, insight synthesis with provenance, monthly migration record written, nothing hard-deleted.
- **P4 — Surfacing & rollout.** Config schema + `mono-agent-composer` step + `feature-registry.md` + `validate` self-check + `docs/memory.md`; then the live-data migration + shadow compare + cutover.
  *Acceptance:* composing a fresh agent surfaces and configures BuJo memory; `validate` catches an unreachable-embeddings misconfig with a loud warning; live service runs on `mode: "bujo"`.

## 15. Non-goals / explicitly deferred

- Graph DB (Neo4j/Graphiti), LanceDB/Chroma, cross-encoder re-ranking, Personalized PageRank — overkill at personal scale; revisit only past ~1M vectors or a measured precision gap.
- MemGPT-style per-page LLM paging on the read path (too token-expensive).
- Agent self-editing as the *primary* write path (kept available via MCP tools, but the pipeline is authoritative).
- Multi-writer/concurrent-process memory access (single-writer assumption retained; document it).

## 16. Risks

- **Stalling after P1.** Mitigation: P1 alone is a real upgrade; each later phase has its own acceptance bar.
- **LLM cost of per-session reflection + reconciliation.** Mitigation: cheap deterministic rapid-log during turns; heavy LLM work batched at session end / cron; model tier configurable.
- **Reconciliation false SUPERSEDE** (wrongly invalidating a valid memory). Mitigation: bi-temporal keeps the old row recoverable; conservative prompt; log every supersede as an observability event.
- **Native dependency portability** (`better-sqlite3`/`sqlite-vec` prebuilds under launchd on macOS). Mitigation: pin versions; verify prebuilt binaries load in the service context as a P1 gate.
- **Bullet-grammar drift** between writer and parser. Mitigation: round-trip test is a hard P1 gate; comment-as-source-of-truth keeps visible prose free to vary.

---

### Appendix — research provenance
Synthesized from a 4-track research workflow: the Bullet Journal method (Ryder Carroll) → mechanism mapping; SOTA agentic memory (MemGPT/Letta, mem0, A-MEM, Generative Agents reflection, Zep/Graphiti bi-temporal graph, HippoRAG, Cognee, Anthropic memory tool); the existing mono-agent memory subsystem; and the local-first embedding/storage landscape (sqlite-vec + FTS5 + RRF; nomic/EmbeddingGemma; OpenAI quality tier). Full reports retained in the session task output.
