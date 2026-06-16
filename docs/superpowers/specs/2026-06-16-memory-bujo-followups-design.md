# Memory v2 — Follow-ups (per-turn capture · config cleanup · bujo MCP)

> Scope: the three known follow-ups recorded against PR #15 (`feat/memory-bujo`).
> Continuation of [`2026-06-15-memory-bujo-design.md`](./2026-06-15-memory-bujo-design.md).
> Date: 2026-06-16. Status: approved, ready to plan.

## 1. Goal & north star

Close the three open follow-ups on the Memory v2 PR without disturbing the established
invariants: **markdown stays canonical, SQLite is a rebuildable index, no silent fallback,
the per-turn reply path stays fast.**

1. **Wire intelligent `capture()` into the live turn loop** — today the per-turn path is the
   deterministic rapid-log (`appendHostSummary`); the LLM `capture()` exists but only runs via the
   scheduler/CLI. Make it run per-turn **without adding reply latency**.
2. **Remove three dead config keys** — `memory.scope`, `memory.graphPath`, `memory.tools` are
   parsed but read by nothing downstream. Delete them and their surface (types, env, TUI, tests,
   docs, example configs).
3. **Ship `@mono-agent/memory-mcp` v2** — a stdio MCP server exposing the bujo engine
   (`recall` / `capture` / `note`) to any MCP client. Reuses the retired package name at v2; it is
   the v2 replacement for the removed `memory.tools` mechanism.

## 2. Decisions of record

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Per-turn capture is **async, non-blocking** | LLM capture is several seconds on local Ollama; the reply must not wait on it. |
| 2 | Capture **augments**, does not replace, the rapid-log | The sync rapid-log is the durable journal line; capture is best-effort enrichment layered on top. Nothing canonical is lost if capture is interrupted. |
| 3 | The capture queue lives **in the store**, serialized | The store owns the `memory.db` handle + daily files and is shared across channels; serializing there prevents cross-channel db/file races with a single mechanism. |
| 4 | New `memory.writeMode` value `"capture"` (superset of `"append-host-summary"`) | Reuses the existing per-turn-write knob; no new top-level config concept. |
| 5 | `writeMode:"capture"` **requires `mode:"bujo"`** → hard validation error otherwise | Only bujo has an LLM. Consistent with the PR's "no silent fallback, warn loudly" (same posture that makes `mode:"markdown"` fail). |
| 6 | MCP surface = **`recall` + `capture` + `note`** | The practical "agent can search and save memories" set. Rituals (reflect/migrate) stay scheduled; not on-demand tools. |
| 7 | MCP resolves its store from **mono-agent config** (env fallback, like the CLI) | One source of truth for memory root / embeddings / llm; no divergent `--root` wiring. (An explicit `--root`/`--config` override may be added but config-resolution is the default.) |
| 8 | Add `busy_timeout` on DB open | The MCP is a *second process/writer* on `memory.db`; WAL already gives readers+1writer, busy_timeout absorbs transient lock contention instead of throwing `SQLITE_BUSY`. |

## 3. Verified current state (ground truth, 2026-06-16)

- **Turn loop:** `agent-harness/src/harness.ts::persistSuccessfulTurn` (~L292) calls
  `memory.appendHostSummary(convId, deterministicHostSummary(user, assistant))` **iff**
  `memoryWriteMode === "append-host-summary"`. `memoryWriteMode` is set in `agent-host/src/index.ts`
  (~L129) from `config.memory?.writeMode ?? "disabled"`.
- **Contract:** `memory-store/src/contract.ts` `MemoryStore` = `{ load, appendHostSummary }` only.
  `capture`/`reflect`/`migrate`/`decay`/`close`/`tier` are `BujoMemoryStore`-only (not on the contract).
- **Store:** `memory-bujo/src/store.ts` — `appendHostSummary` (sync rapid-log, ~L59),
  `capture(convId, text) → {actions, entities} | undefined` (~L142, `undefined` when no LLM). Its
  docstring already says capture is "safe to call on every turn when an LLM is present, and a no-op
  when one is not." Recall primitive is `db.recall(query, {topK}) → [{score, record}]` (used by the CLI).
- **Config remnants — confirmed dead** (nothing reads them; `createConfiguredMemory`,
  agent-host ~L157, destructures only `{mode, path, maxBytes, embeddings, llm}`):
  - `memory.scope` → `config/src/types.ts` (`MemoryScope`, field), `json-source.ts`, `config.ts`
    (read + return), `layered-loader.ts` (JSON→env), `field-groups.ts` (TUI), `tui/src/config/pane.ts`,
    tests, example configs.
  - `memory.graphPath` → same files; the *real* graph path is hardcoded `<root>/graph.jsonl` in
    `memory-bujo/src/graph.ts` (independent of config).
  - `memory.tools` (`MemoryToolsConfig` `{enabled, allowJournalAppend}`) → same files +
    `readMemoryToolsConfig` in `config.ts`, two `MONO_AGENT_MEMORY_TOOLS_*` env vars,
    `config/README.md` "Memory Tools" section, `agent-host/README.md`.
- **DB:** `memory-store/src/db.ts:45` sets `journal_mode = WAL`; **no `busy_timeout`** set.
- **Shutdown:** `agent-app/src/app.ts` `closeMemory()` (~L523) closes the shared store via
  `mem.close()`; the store is shared across responders + ritual scheduler (single handle).
- **MCP SDK:** `@modelcontextprotocol/sdk@^1.29.0` is a root dep (used by agent-runtime/orchestrator).
  Retired v1 `memory-mcp` exported `createMemoryMcpServer` + `resolveMemoryMcpMainPath()` (bin `main.js`).

## 4. Workstream A — per-turn intelligent capture

### A.1 Contract (`memory-store/src/contract.ts`)
Add two **optional** methods to `MemoryStore`:
```ts
export interface MemoryStore {
  load(conversationId: string): Promise<MemoryBlock | undefined>;
  appendHostSummary(conversationId: string, summary: string): Promise<MemoryWriteResult>;
  /** Enqueue a best-effort intelligent capture. Returns immediately; never throws. No-op if unsupported. */
  scheduleCapture?(conversationId: string, text: string): void;
  /** Await all queued captures (graceful shutdown / one-shot exit). */
  flush?(): Promise<void>;
}
```
Optional ⇒ non-bujo stores need not implement; the harness feature-detects (`memory.scheduleCapture?.(...)`).

### A.2 Store (`memory-bujo/src/store.ts`)
- Private **serialized capture queue**: a promise chain (`private captureChain: Promise<void>`).
  `scheduleCapture(convId, text)` appends `() => this.capture(convId, text)` to the chain, each link
  wrapped so a rejection is **caught + logged and never propagates** (one bad capture doesn't break
  the chain or the process). Serializes captures across all channels (single shared store).
- `flush()` awaits the current chain tail.
- `capture()` is unchanged — it remains the awaitable primitive used by the queue, CLI, MCP, tests.
- Add a public `recall(query: string, opts?: {topK?: number})` delegating to `db.recall` (needed by
  the MCP; generally useful). Returns the hit list (text + score).
- Inject an optional `logger?` (via `BujoOptions`) for the queue's caught-error logging; default no-op.

### A.3 Harness (`agent-harness/src/harness.ts`)
- Widen `MemoryWriteMode` to `"disabled" | "append-host-summary" | "capture"`.
- In `persistSuccessfulTurn`, when mode is `"capture"`:
  1. `await this.options.memory.appendHostSummary(convId, deterministicHostSummary(user, assistant))`
     (unchanged sync rapid-log), then
  2. `this.options.memory.scheduleCapture?.(convId, turnText)` where `turnText` carries **both** the
     user message and assistant text (richer than the compacted host summary — the distiller wants
     real content). Fire-and-forget; never awaited.
- `"capture"` is treated as a superset of `"append-host-summary"` (same step 1).

### A.4 Config + validation (`@mono-agent/config`)
- Add `"capture"` to the `memory.writeMode` enum (type + JSON schema + env reader for
  `MONO_AGENT_MEMORY_WRITE_MODE`).
- Validation: `writeMode === "capture" && mode !== "bujo"` → throw a clear config error
  (e.g. `memory.writeMode "capture" requires memory.mode "bujo" (needs an LLM)`).

### A.5 Drain (`agent-app/src/app.ts`)
- In `closeMemory()`, before `mem.close()`: `await mem.flush?.()` (guarded, never throws).
- (If a one-shot harness exit path exists that closes the store, it flushes the same way. The
  long-running app is the primary path.)

### A.6 Error handling
Capture failures are caught + logged inside the queue; they never affect the reply or crash the
process — mirrors the ritual scheduler's never-throws discipline.

## 5. Workstream B — config remnant cleanup

Delete `memory.scope`, `memory.graphPath`, `memory.tools` end-to-end:
- `config/src/types.ts` — remove `MemoryScope`, `MemoryToolsConfig`, and the three fields.
- `config/src/json-source.ts` — remove the three JSON fields.
- `config/src/config.ts` — remove `readMemoryToolsConfig`, the scope/graphPath reads + returns, and
  the orphaned-env check entry for `MONO_AGENT_MEMORY_GRAPH_PATH`.
- `config/src/layered-loader.ts` — remove the JSON→env translation blocks.
- `config/src/field-groups.ts` — remove the `memory.scope` / `memory.graphPath` /
  `memory.tools.*` field definitions.
- `tui/src/config/pane.ts` — remove the env-key mapping + display lines.
- Tests — `config.test.ts`, `field-groups.test.ts`, `layered-loader.test.ts`: drop the assertions;
  add an assertion that the keys are gone, plus a test pinning the verified behavior for a config
  that still carries a removed key (ignored vs rejected — see below).
- Docs — `config/README.md` ("Memory Tools" section), `agent-host/README.md`,
  `demos/final-agent/README.md`.
- Example configs — `mono-agent.config.json`, `.mono-agent/deploy/*.json`,
  `.mono-agent/multi-agent/config/*.json`: strip the dead keys.

**Open verification (resolve during implementation):** whether the JSON layer **rejects** unknown
keys or **ignores** them. If it ignores, old configs keep loading (keys become inert) — preferred.
If it rejects, removal is a (already-in-band) breaking change; clean the in-repo configs regardless
and note it in the PR's breaking-changes list. The behavior gets pinned by a test either way.

## 6. Workstream C — `@mono-agent/memory-mcp` v2

### C.1 Package
`packages/memory-mcp` → `@mono-agent/memory-mcp` (v2, reusing the retired name). Mirrors the retired
package's shape: a `createServer(...)` factory + a `main.ts` entry + bin `memory-mcp`
(`resolveMemoryMcpMainPath()`-style). Deps: `@modelcontextprotocol/sdk@^1.29.0`,
`@mono-agent/memory-bujo`, `@mono-agent/memory-store`, `@mono-agent/memory-search`. Standard
build/typecheck/test scripts + `tsconfig.build.json`, matching sibling packages.

### C.2 Tools (recall + capture + note)
| Tool | Input | Maps to | Tier behavior |
|------|-------|---------|---------------|
| `memory_recall` | `{ query: string, limit?: number }` | `store.recall(query, {topK})` | all tiers (FTS at minimum) |
| `memory_capture` | `{ text: string }` | `store.capture("mcp", text)` | bujo only — clear error result when no LLM (not a silent no-op) |
| `memory_note` | `{ text: string }` | `store.appendHostSummary("mcp", text)` | all tiers |

Tool I/O validated with the SDK's schema mechanism; handlers return MCP `ToolResult`-shaped content.

### C.3 Store access & lifecycle
The server constructs a `BujoMemoryStore` from a memory root + embeddings/LLM resolved from
mono-agent config (env fallback, like the CLI). It opens its own `memory.db` handle and closes it on
shutdown. A synthetic conversation id `"mcp"` tags writes.

### C.4 Concurrency
Add `busy_timeout` (~5000ms) on DB open in `memory-store/src/db.ts` so a second writer (MCP next to a
running agent) retries transient locks instead of throwing `SQLITE_BUSY`. WAL already permits
concurrent readers + a single writer; busy_timeout covers the writer-contention window.

### C.5 Surfacing
- `docs/memory.md` — a "Memory over MCP" section (what it exposes, how to point a client at it).
- `docs/feature-registry.md` — feature → config row for the MCP.
- `mono-agent` doctor — a note when the MCP is relevant. (No new config schema required to run the
  MCP standalone; it reads the existing `memory` block.)

## 7. Testing strategy

Test-first, per the PR's discipline (two-stage review per task).

- **A — capture wiring**
  - Store: `scheduleCapture` serializes (two enqueues run strictly in order via a fake LLM that
    records call order), `flush` awaits both, a throwing capture is swallowed + logged and does **not**
    break a subsequent capture. Fake clock.
  - Harness: in `"capture"` mode, `appendHostSummary` is still awaited (rapid-log written) **and**
    `scheduleCapture` is invoked with user+assistant text; in `"append-host-summary"` mode
    `scheduleCapture` is **not** called. Fake `MemoryStore`.
  - Config: `writeMode:"capture"` + `mode:"bujo"` validates; `+ mode:"lite"|"journal"` throws.
  - App: `closeMemory` awaits `flush` before `close` (spy ordering).
- **B — config cleanup**
  - Suites assert the three keys are absent from the loaded config + field groups; a config carrying
    a removed key exercises the pinned ignored-vs-rejected behavior.
- **C — MCP**
  - Tool handlers against a **real** `BujoMemoryStore` over a temp root with a **fake LLM**:
    `note` then `recall` round-trips; `capture` returns action/entity counts; `capture` on a
    no-LLM store returns the explicit "requires bujo" error.
  - Server lists exactly the three tools.
  - `busy_timeout` is set (pragma assertion in memory-store).
- **Gate** (matches the PR): architecture check + whole-repo `typecheck` + every touched suite +
  a **real-Ollama e2e** (per-turn `writeMode:"capture"` produces memories+entities in the background;
  MCP `recall`/`capture`/`note` round-trip).

## 8. Build phasing

1. **B (config cleanup)** first — smallest, isolates a pure deletion + its test churn from feature work.
2. **A (capture wiring)** — contract → store queue/recall → harness → config writeMode+validation → app drain.
3. **C (memory-mcp)** — depends on `store.recall` (A.2) and `busy_timeout` (shared with A's concurrency note).
4. Surfacing/docs + the real-Ollama e2e last.

## 9. Non-goals / explicitly deferred

- No reflect/migrate **tools** on the MCP (rituals stay scheduled — decision 6).
- No change to the rapid-log format or the canonical markdown grammar.
- No live `~/personal-agent` cutover (maintainer step) or npm (de)publish here.
- No new entity-graph query tools on the MCP (deferred; recall covers search).

## 10. Risks

- **Async capture lost on hard kill** — mitigated: the sync rapid-log is durable and `rebuild`
  re-derives the index; `flush` covers graceful shutdown.
- **Two-writer contention on `memory.db`** — mitigated by WAL + `busy_timeout`; writes are
  short (append + upsert). Documented.
- **Removing a config key breaks a live config** — the PR already carries breaking config changes;
  behavior is pinned by a test and the in-repo configs are cleaned.
