# Memory v2 — P6 Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three Memory v2 follow-ups on PR #15 — wire async per-turn intelligent `capture()` into the turn loop, delete three dead config keys, and ship `@mono-agent/memory-mcp` v2 (recall/capture/note).

**Architecture:** Markdown stays canonical; SQLite stays a rebuildable index; the reply path stays fast. Per-turn capture is async + serialized in the store, layered on top of the sync rapid-log. The MCP is a stdio server mirroring the retired v1 package's shape (`createMemoryTools` pure logic + `main.ts` + `index.ts`).

**Tech Stack:** TypeScript (ESM, NodeNext), pnpm workspaces, vitest, better-sqlite3 + sqlite-vec + FTS5, `@modelcontextprotocol/sdk@^1.29.0`, zod v4, Ollama (embeddings + chat).

**Spec:** [`../specs/2026-06-16-memory-bujo-followups-design.md`](../specs/2026-06-16-memory-bujo-followups-design.md)

**Gate (run after each workstream):** `pnpm run check:architecture` · `pnpm run typecheck` · the touched package's `pnpm --filter @mono-agent/<pkg> test`.

**Conventions:**
- Tests live in `packages/<pkg>/src/__tests__/*.test.ts`. Run one package: `pnpm --filter @mono-agent/<pkg> test`. Filter to a file: append the path, e.g. `pnpm --filter @mono-agent/memory-bujo test src/__tests__/store.test.ts`.
- Commit messages follow the PR's conventional style (`feat(...)`, `fix(...)`, `refactor(...)!`, `test(...)`, `docs(...)`). `!` marks a breaking change.
- Build order is **B (cleanup) → A (capture) → C (MCP) → D (surfacing)**, so the pure deletion lands before feature work and C can rely on A's `store.recall`.

---

## Workstream B — config remnant cleanup

Delete `memory.scope`, `memory.graphPath`, `memory.tools` end-to-end. Confirmed dead: `createConfiguredMemory` (agent-host/src/index.ts:157) destructures only `{ mode, path, maxBytes, embeddings, llm }`; the real graph path is hardcoded `<root>/graph.jsonl` in memory-bujo/src/graph.ts.

### Task B1: Remove the three keys from config core

**Files:**
- Modify: `packages/config/src/types.ts:7-13,76,78-80`
- Modify: `packages/config/src/json-source.ts:77,79-80`
- Modify: `packages/config/src/config.ts:352-359,377-382,400-403,470-493`
- Modify: `packages/config/src/layered-loader.ts:102-104,108-116`
- Test: `packages/config/src/__tests__/config.test.ts`, `packages/config/src/__tests__/layered-loader.test.ts`

- [ ] **Step 1: Flip the test assertions to expect the keys are gone**

In `config.test.ts`, find the env-fixture test (~L30-55) that sets `MONO_AGENT_MEMORY_SCOPE: "single-file"` and `MONO_AGENT_MEMORY_TOOLS_*`, and asserts `scope: "single-file"` (~L55). Remove those env keys and the `scope` assertion. Replace the memory-config assertion block with one that pins absence:

```ts
// config.test.ts — inside the "reads memory config from env" test
expect(config.memory).toMatchObject({ mode: "lite", path: expect.any(String), writeMode: "append-host-summary" });
expect(config.memory).not.toHaveProperty("scope");
expect(config.memory).not.toHaveProperty("graphPath");
expect(config.memory).not.toHaveProperty("tools");
```

Delete the two tests that exercise removed behavior: the `MONO_AGENT_MEMORY_GRAPH_PATH` resolution test (~L475-479, ~L548) and the "rejects journal append for memory tools that are not enabled" test (~L181-193). Add a test pinning that a removed key is now an inert/unknown env var (no longer read):

```ts
it("ignores the retired MONO_AGENT_MEMORY_SCOPE / _TOOLS_* / _GRAPH_PATH env vars", () => {
  const config = loadConfig({
    env: { ...baseEnv, MONO_AGENT_MEMORY_PATH: "./mem",
      MONO_AGENT_MEMORY_SCOPE: "per-conversation",
      MONO_AGENT_MEMORY_TOOLS_ENABLED: "true",
      MONO_AGENT_MEMORY_GRAPH_PATH: "g.jsonl" },
    cwd: "/repo",
  });
  expect(config.memory).not.toHaveProperty("scope");
  expect(config.memory).not.toHaveProperty("tools");
  expect(config.memory).not.toHaveProperty("graphPath");
});
```

In `layered-loader.test.ts`, delete the assertions for `MONO_AGENT_MEMORY_SCOPE`, `MONO_AGENT_MEMORY_TOOLS_ENABLED`, `MONO_AGENT_MEMORY_TOOLS_ALLOW_JOURNAL_APPEND`, `MONO_AGENT_MEMORY_GRAPH_PATH` (the "translates JSON memory graphPath and embeddings to env keys" test ~L172-194 and the graphPath expectation ~L458-466, plus L65-66). Keep the embeddings half of any shared test; just drop the removed keys.

> Match the actual fixture/import names in each file when editing (the snippets above show intent + the assertions to add/remove).

- [ ] **Step 2: Run the config tests — expect failures**

Run: `pnpm --filter @mono-agent/config test src/__tests__/config.test.ts src/__tests__/layered-loader.test.ts`
Expected: FAIL — the config still returns `scope`/`tools`/`graphPath`, so `not.toHaveProperty` assertions fail (and the deleted tests' referenced env still flows through).

- [ ] **Step 3: Remove the keys from `types.ts`**

Delete `MemoryScope` (L8) and `MemoryToolsConfig` (L10-13). In the `memory` block, delete `scope` (L76), `tools` (L78), and `graphPath` + its comment (L79-80). Resulting `memory` block:

```ts
  readonly memory?: {
    readonly mode: MemoryMode;
    readonly path: string;
    readonly maxBytes: number;
    readonly writeMode: MemoryWriteMode;
    /** Embedding provider for semantic memory_search; keyword fallback when unset. */
    readonly embeddings?: MemoryEmbeddingsConfig;
    /** Local LLM for bujo capture/reflect/migrate (optional; ollama only for now). */
    readonly llm?: MemoryLlmConfig;
    /** Bujo-tier reflection ritual (nightly summarise/compress). Default cron: `0 3 * * *`. */
    readonly reflection?: MemoryRitualConfig;
    /** Bujo-tier migration ritual (monthly archive/rebalance). Default cron: `0 4 1 * *`. */
    readonly migration?: MemoryRitualConfig;
  };
```

- [ ] **Step 4: Remove the keys from `json-source.ts`**

In the `memory` block (L73-85), delete `scope` (L77), `tools` (L79), `graphPath` (L80). Remove now-unused imports of `MemoryScope` / `MemoryToolsConfig` if present.

- [ ] **Step 5: Remove the reads from `config.ts`**

- In the orphaned-env list (L352-359), delete the `"MONO_AGENT_MEMORY_GRAPH_PATH",` entry.
- Delete the `scope` read (L377-380), the `tools` read (L381), and the `graphPath` read (L382).
- In the return object (L396-408), delete the `scope,` line (L400), the `...(tools …)` spread (L402), and the `...(graphPath …)` spread (L403).
- Delete the whole `readMemoryToolsConfig` function (L470-493).
- Remove now-unused imports (`MemoryScope`, `MemoryToolsConfig`) from the type import.

- [ ] **Step 6: Remove the translations from `layered-loader.ts`**

Delete the `scope` block (L102-104), the two `tools` blocks (L108-113), and the `graphPath` block (L114-116). Leave `writeMode` (L105-107) and `embeddings`/`llm` blocks intact.

- [ ] **Step 7: Run the config tests — expect pass**

Run: `pnpm --filter @mono-agent/config test src/__tests__/config.test.ts src/__tests__/layered-loader.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck the package**

Run: `pnpm --filter @mono-agent/config typecheck`
Expected: PASS (no dangling references to the removed types).

- [ ] **Step 9: Commit**

```bash
git add packages/config/src
git commit -m "refactor(config)!: remove dead memory keys (scope/graphPath/tools)"
```

### Task B2: Remove the keys from the TUI / field-group surface

**Files:**
- Modify: `packages/config/src/field-groups.ts:213-223,236-257`
- Modify: `packages/tui/src/config/pane.ts:46,202-207`
- Test: `packages/config/src/__tests__/field-groups.test.ts:37`

- [ ] **Step 1: Update the field-groups test**

In `field-groups.test.ts`, change the `expect(ids).toContain("memory.graphPath")` assertion (L37) to assert absence, and add the siblings:

```ts
expect(ids).not.toContain("memory.scope");
expect(ids).not.toContain("memory.graphPath");
expect(ids).not.toContain("memory.tools.enabled");
expect(ids).not.toContain("memory.tools.allowJournalAppend");
```

- [ ] **Step 2: Run it — expect failure**

Run: `pnpm --filter @mono-agent/config test src/__tests__/field-groups.test.ts`
Expected: FAIL — the field ids still exist.

- [ ] **Step 3: Delete the field definitions in `field-groups.ts`**

Remove the `memory.scope` field (L213-223), the `memory.tools.enabled` field (L236-242), the `memory.tools.allowJournalAppend` field (L243-249), and the `memory.graphPath` field (L250-257). Leave `memory.maxBytes`, `memory.writeMode`, and the embeddings fields.

- [ ] **Step 4: Delete the TUI display references in `pane.ts`**

Remove the `memoryScope: "MONO_AGENT_MEMORY_SCOPE",` ENV_KEYS entry (L46) and the `scope` display `toField(...)` block (L202-207). (There are no `graphPath`/`tools` display blocks in pane.ts — only `scope` is surfaced there.) The `redacted.memory.scope` reference disappears with the block; the redacted type derives from `MonoAgentConfig.memory`, which no longer has `scope`.

- [ ] **Step 5: Run field-groups test + typecheck config & tui**

Run: `pnpm --filter @mono-agent/config test src/__tests__/field-groups.test.ts && pnpm --filter @mono-agent/config typecheck && pnpm --filter @mono-agent/tui typecheck`
Expected: PASS for all three.

- [ ] **Step 6: Commit**

```bash
git add packages/config/src/field-groups.ts packages/tui/src/config/pane.ts packages/config/src/__tests__/field-groups.test.ts
git commit -m "refactor(config,tui)!: drop scope/graphPath/tools from the config field surface"
```

### Task B3: Clean docs and example configs

**Files:**
- Modify: `packages/config/README.md` (the "## Memory Tools" section ~L105-133)
- Modify: `packages/agent-host/README.md:32-34`
- Modify: `demos/final-agent/README.md:164`
- Modify: `mono-agent.config.json:24`, `.mono-agent/deploy/final-agent-gemma4.config.json`, `.mono-agent/multi-agent/config/{orchestrator,researcher,worker}.config.json`, `.mono-agent/downloads-curator/downloads-curator.config.json`

- [ ] **Step 1: Remove the docs sections**

Delete the "## Memory Tools" section in `packages/config/README.md`, the `memory.tools.*` references in `packages/agent-host/README.md` (L32-34), and the `"scope"` line in the example in `demos/final-agent/README.md` (L164).

- [ ] **Step 2: Strip the dead keys from the in-repo example configs**

In each config file listed above, remove any `"scope"`, `"graphPath"`, and `"tools"` keys inside the `"memory"` object. Example — `mono-agent.config.json` memory block becomes:

```json
  "memory": {
    "path": "./.worklab-tmp/live-final-demo/MEMORY.md",
    "maxBytes": 64000,
    "writeMode": "append-host-summary"
  },
```

(Leave the `.mono-agent/multi-agent/artifacts/**/*.events.jsonl` run logs untouched — they're historical artifacts, not configs.)

- [ ] **Step 3: Validate the example configs still load**

Run: `pnpm --filter @mono-agent/config test`
Expected: PASS (full config suite green).

- [ ] **Step 4: Commit**

```bash
git add packages/config/README.md packages/agent-host/README.md demos/final-agent/README.md mono-agent.config.json .mono-agent
git commit -m "docs(config): drop retired memory keys from docs + example configs"
```

---

## Workstream A — per-turn intelligent capture (async)

### Task A1: Store capture queue + flush + recall + contract

**Files:**
- Modify: `packages/memory-store/src/contract.ts:14-17`
- Modify: `packages/memory-bujo/src/types.ts:23-37` (add `logger` + `BujoLogger`)
- Modify: `packages/memory-bujo/src/store.ts` (queue, `scheduleCapture`, `flush`, `recall`)
- Test: `packages/memory-bujo/src/__tests__/store.test.ts`

- [ ] **Step 1: Write failing tests for the queue, flush, recall, and error isolation**

Append to `store.test.ts`. Use an inline fake LLM that records call order and can be made to throw; capture needs only an `llm` (no embeddings → FTS-only; with an empty distillation the capture is a no-op that never touches the vector index, so no embeddings are required). **Reuse the empty-but-valid completion shape from the existing `capture.test.ts` fake LLM** (e.g. distill/entities may expect `[]` vs `{"memories":[]}` — match `distill.ts`/`entities.ts`, don't guess). The serialization assertion must prove **non-interleaving** (all of capture #1's LLM calls precede all of capture #2's), not merely that the two distill calls fire in order.

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBujoMemoryStore } from "../store.js";
import type { LlmComplete } from "../llm.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "bujo-queue-"));
}

// A fake LLM that records the order of completion calls and yields empty JSON
// (distill/reconcile/entities all tolerate empty arrays → a no-op capture).
function recordingLlm(order: string[], opts: { throwOnText?: string } = {}): LlmComplete {
  return {
    id: "fake",
    async complete(prompt: string): Promise<string> {
      const tag = prompt.slice(0, 40);
      order.push(tag);
      if (opts.throwOnText !== undefined && prompt.includes(opts.throwOnText)) {
        throw new Error("boom");
      }
      return "[]"; // empty distillation/entities — safe no-op
    },
  };
}

describe("BujoMemoryStore async capture queue", () => {
  it("scheduleCapture runs captures serially (no interleaving) and flush awaits them", async () => {
    const order: string[] = []; // every LLM call pushes its turn tag (FIRST/SECOND)
    const store = createBujoMemoryStore({ root: tmpRoot(), tier: "bujo", llm: recordingLlm(order) });
    store.scheduleCapture("c1", "FIRST user text");
    store.scheduleCapture("c1", "SECOND user text");
    await store.flush();
    // Serialized ⇒ ALL of FIRST's calls precede ALL of SECOND's (the last FIRST < the first SECOND).
    const firstTags = order.map((t, i) => (t.includes("FIRST") ? i : -1)).filter((i) => i >= 0);
    const secondTags = order.map((t, i) => (t.includes("SECOND") ? i : -1)).filter((i) => i >= 0);
    expect(firstTags.length).toBeGreaterThan(0);
    expect(secondTags.length).toBeGreaterThan(0);
    expect(Math.max(...firstTags)).toBeLessThan(Math.min(...secondTags));
    await store.close();
  });

  it("a throwing capture is swallowed and does not block the next capture", async () => {
    const order: string[] = [];
    const warnings: string[] = [];
    const store = createBujoMemoryStore({
      root: tmpRoot(), tier: "bujo",
      llm: recordingLlm(order, { throwOnText: "POISON" }),
      logger: { warn: (m) => warnings.push(m) },
    });
    store.scheduleCapture("c1", "POISON text");
    store.scheduleCapture("c1", "HEALTHY text");
    await expect(store.flush()).resolves.toBeUndefined();
    expect(warnings.some((w) => /capture/i.test(w))).toBe(true);
    expect(order.some((t) => t.includes("HEALTHY"))).toBe(true);
    await store.close();
  });

  it("scheduleCapture is a no-op without an llm (lite/journal)", async () => {
    const store = createBujoMemoryStore({ root: tmpRoot() }); // lite
    expect(() => store.scheduleCapture("c1", "x")).not.toThrow();
    await expect(store.flush()).resolves.toBeUndefined();
    await store.close();
  });

  it("recall delegates to db.recall and returns scored hits", async () => {
    const store = createBujoMemoryStore({ root: tmpRoot() });
    await store.appendHostSummary("c1", "The launch date is March 3rd.");
    const hits = await store.recall("launch date", { topK: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(typeof hits[0]!.score).toBe("number");
    expect(hits[0]!.record.text).toMatch(/launch/i);
    await store.close();
  });
});
```

- [ ] **Step 2: Run the tests — expect failure**

Run: `pnpm --filter @mono-agent/memory-bujo test src/__tests__/store.test.ts`
Expected: FAIL — `scheduleCapture`, `flush`, `recall`, and `logger` don't exist yet.

- [ ] **Step 3: Add `BujoLogger` + `logger` to `types.ts`**

```ts
/** Minimal logger sink for best-effort background work (capture queue). */
export interface BujoLogger {
  warn(message: string): void;
}
```
Add to `BujoOptions` (after `tier?`):
```ts
  /** Optional sink for caught errors in the async capture queue. Defaults to a no-op. */
  readonly logger?: BujoLogger;
```

- [ ] **Step 4: Add the optional contract methods in `memory-store/src/contract.ts`**

```ts
export interface MemoryStore {
  load(conversationId: string): Promise<MemoryBlock | undefined>;
  appendHostSummary(conversationId: string, summary: string): Promise<MemoryWriteResult>;
  /** Enqueue a best-effort intelligent capture of a turn. Returns immediately; never throws. No-op when unsupported. */
  scheduleCapture?(conversationId: string, text: string): void;
  /** Await all queued captures (graceful shutdown / one-shot exit). */
  flush?(): Promise<void>;
}
```

- [ ] **Step 5: Implement the queue, flush, and recall in `store.ts`**

Add imports + fields and methods. At the top, import the recall types:
```ts
import type { MemoryBlock, MemoryStore, MemoryWriteResult, RecallHit } from "@mono-agent/memory-store";
```
> `RecallHit` must be exported from `packages/memory-store/src/index.ts`. It's defined in `memory-store/src/types.ts:43`; if the barrel doesn't already re-export it, add `RecallHit` to the `export type { … }` list there (and confirm `RecallOptions` too if referenced).
Add private fields (next to the others):
```ts
  private readonly logger: BujoLogger;
  private captureChain: Promise<void> = Promise.resolve();
```
In the constructor, after `this._tier = …`:
```ts
    this.logger = options.logger ?? { warn: () => {} };
```
(Import `BujoLogger` from `./types.js`.) Add the methods (place `recall` near `load`, the queue near `capture`):
```ts
  /** Query-based hybrid recall (text + score). Used by the MCP and any deliberate recall surface. */
  async recall(query: string, options: { topK?: number } = {}): Promise<RecallHit[]> {
    return this.db.recall(query, { ...(options.topK !== undefined && { topK: options.topK }) });
  }

  /**
   * Enqueue a best-effort intelligent capture. Returns immediately. Captures run strictly
   * one-at-a-time (serialized across all channels sharing this store), and a failure is caught +
   * logged so it never breaks the chain, the reply, or the process. No-op without an llm.
   */
  scheduleCapture(conversationId: string, text: string): void {
    if (this.llm === undefined) return;
    this.captureChain = this.captureChain.then(async () => {
      try {
        await this.capture(conversationId, text);
      } catch (error) {
        this.logger.warn(`bujo capture failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /** Await all captures queued before this call (graceful shutdown / one-shot exit). */
  async flush(): Promise<void> {
    await this.captureChain;
  }
```

- [ ] **Step 6: Run the tests — expect pass**

Run: `pnpm --filter @mono-agent/memory-bujo test src/__tests__/store.test.ts`
Expected: PASS (4 new tests green).

- [ ] **Step 7: Typecheck both packages**

Run: `pnpm --filter @mono-agent/memory-store typecheck && pnpm --filter @mono-agent/memory-bujo typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/memory-store/src/contract.ts packages/memory-bujo/src
git commit -m "feat(memory-bujo): async serialized capture queue + flush + recall; optional contract methods"
```

### Task A2: Harness `"capture"` write mode

**Files:**
- Modify: `packages/agent-harness/src/types.ts:8`
- Modify: `packages/agent-harness/src/harness.ts:292-302,502-508`
- Test: `packages/agent-harness/src/__tests__/harness.test.ts`

- [ ] **Step 1: Write failing tests for the capture branch**

Add to `harness.test.ts`. Use a fake `MemoryStore` that records calls. Drive one `run()` and assert behavior per mode. (Reuse the file's existing harness-construction helper / fake runtime; the snippet shows the memory-specific assertions.)

```ts
it("writeMode 'capture' writes the rapid-log AND schedules an async capture", async () => {
  const calls: string[] = [];
  const memory = {
    load: async () => undefined,
    appendHostSummary: async (id: string) => { calls.push(`append:${id}`); return { conversationId: id, source: "x", bytesWritten: 1 }; },
    scheduleCapture: (id: string, text: string) => { calls.push(`schedule:${id}:${text.includes("Assistant") ? "turn" : "?"}`); },
    flush: async () => {},
  };
  const harness = makeHarness({ memory, memoryWriteMode: "capture" }); // helper from this file
  await harness.run(makeRequest({ conversationId: "c1", userMessage: "hi" }));
  expect(calls).toContain("append:c1");
  expect(calls.some((c) => c.startsWith("schedule:c1"))).toBe(true);
});

it("writeMode 'append-host-summary' does NOT schedule a capture", async () => {
  const calls: string[] = [];
  const memory = {
    load: async () => undefined,
    appendHostSummary: async (id: string) => { calls.push(`append:${id}`); return { conversationId: id, source: "x", bytesWritten: 1 }; },
    scheduleCapture: () => { calls.push("schedule"); },
    flush: async () => {},
  };
  const harness = makeHarness({ memory, memoryWriteMode: "append-host-summary" });
  await harness.run(makeRequest({ conversationId: "c1", userMessage: "hi" }));
  expect(calls).toContain("append:c1");
  expect(calls).not.toContain("schedule");
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @mono-agent/agent-harness test src/__tests__/harness.test.ts`
Expected: FAIL — `"capture"` is not an assignable `MemoryWriteMode`, and `scheduleCapture` is never called.

- [ ] **Step 3: Widen `MemoryWriteMode` in `types.ts`**

```ts
export type MemoryWriteMode = "disabled" | "append-host-summary" | "capture";
```

- [ ] **Step 4: Implement the branch in `harness.ts`**

Replace `persistSuccessfulTurn`'s memory block (L299-301) with:
```ts
    const mode = this.options.memoryWriteMode;
    if (this.options.memory !== undefined && (mode === "append-host-summary" || mode === "capture")) {
      // Always write the deterministic rapid-log line (sync, durable).
      await this.options.memory.appendHostSummary(
        request.conversationId,
        deterministicHostSummary(request.userMessage, assistantText),
      );
      // 'capture' additionally enqueues a best-effort intelligent capture (async, non-blocking).
      if (mode === "capture") {
        this.options.memory.scheduleCapture?.(request.conversationId, captureTurnText(request.userMessage, assistantText));
      }
    }
```
Add the helper next to `deterministicHostSummary` (after L508):
```ts
function captureTurnText(userMessage: string, assistantText: string): string {
  // Richer than the compacted host summary: the distiller wants the real turn content.
  return `User: ${userMessage}\nAssistant: ${assistantText}`;
}
```

- [ ] **Step 5: Run — expect pass**

Run: `pnpm --filter @mono-agent/agent-harness test src/__tests__/harness.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @mono-agent/agent-harness typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-harness/src
git commit -m "feat(agent-harness): writeMode 'capture' — rapid-log + async intelligent capture per turn"
```

### Task A3: Config `writeMode: "capture"` + bujo-tier validation

**Files:**
- Modify: `packages/config/src/types.ts:7`
- Modify: `packages/config/src/config.ts:373-376` (+ validation after writeMode)
- Modify: `packages/config/src/field-groups.ts:230-233`
- Test: `packages/config/src/__tests__/config.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
it("accepts memory.writeMode 'capture' with mode 'bujo'", () => {
  const config = loadConfig({ env: { ...baseEnv,
    MONO_AGENT_MEMORY_PATH: "./mem", MONO_AGENT_MEMORY_MODE: "bujo",
    MONO_AGENT_MEMORY_WRITE_MODE: "capture", MONO_AGENT_MEMORY_LLM_MODEL: "qwen3.6:latest" }, cwd: "/repo" });
  expect(config.memory?.writeMode).toBe("capture");
});

it("rejects memory.writeMode 'capture' unless mode is 'bujo'", () => {
  expect(() => loadConfig({ env: { ...baseEnv,
    MONO_AGENT_MEMORY_PATH: "./mem", MONO_AGENT_MEMORY_MODE: "journal",
    MONO_AGENT_MEMORY_WRITE_MODE: "capture" }, cwd: "/repo" }))
    .toThrow(/capture.*requires.*bujo/i);
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @mono-agent/config test src/__tests__/config.test.ts`
Expected: FAIL — `"capture"` is not an accepted `readChoice` value (throws "invalid value"), and no bujo guard exists.

- [ ] **Step 3: Add `"capture"` to the `MemoryWriteMode` type (`types.ts:7`)**

```ts
export type MemoryWriteMode = "disabled" | "append-host-summary" | "capture";
```

- [ ] **Step 4: Accept `"capture"` + add the bujo guard in `config.ts`**

Extend the `writeMode` `readChoice` array (L373-376):
```ts
  const writeMode = readChoice<MemoryWriteMode>(env.MONO_AGENT_MEMORY_WRITE_MODE, "MONO_AGENT_MEMORY_WRITE_MODE", [
    "disabled",
    "append-host-summary",
    "capture",
  ], "disabled", invalidEnv);
  if (writeMode === "capture" && mode !== "bujo") {
    throw new MonoAgentConfigError(
      "invalid_env",
      `MONO_AGENT_MEMORY_WRITE_MODE "capture" requires MONO_AGENT_MEMORY_MODE "bujo" (it needs a chat LLM).`,
      { env: "MONO_AGENT_MEMORY_WRITE_MODE" },
    );
  }
```
(`mode` is already read just above at L368-372.)

- [ ] **Step 5: Add the `"capture"` option to the TUI write-mode select (`field-groups.ts:230-233`)**

```ts
      options: [
        { value: "disabled", label: "disabled" },
        { value: "append-host-summary", label: "append-host-summary" },
        { value: "capture", label: "capture (bujo)" },
      ],
```

- [ ] **Step 6: Run — expect pass**

Run: `pnpm --filter @mono-agent/config test src/__tests__/config.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck config + agent-harness (shared string compatibility)**

Run: `pnpm --filter @mono-agent/config typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/config/src
git commit -m "feat(config): memory.writeMode 'capture' (bujo-only, validated)"
```

### Task A4: agent-app drain on shutdown + logger threading

**Files:**
- Modify: `packages/agent-host/src/index.ts:153` (`createConfiguredMemory` gains an optional deps arg)
- Modify: `packages/agent-app/src/app.ts:513-529` (pass logger; flush before close)
- Test: `packages/agent-app/src/__tests__/app.test.ts`

- [ ] **Step 1: Write a failing test that flush precedes close on stop**

Add to `app.test.ts` (or a focused unit). Drive `resetSharedMemory` via `stop()` with a fake shared store that records order. If the suite can't easily inject the shared store, assert via a spy on a constructed store. Minimal version:

```ts
it("drains pending captures (flush) before closing memory on stop", async () => {
  const order: string[] = [];
  const fakeStore = {
    load: async () => undefined,
    appendHostSummary: async () => ({ conversationId: "c", source: "s", bytesWritten: 1 }),
    flush: async () => { order.push("flush"); },
    close: async () => { order.push("close"); },
  };
  const app = makeAppWithSharedMemory(fakeStore); // test helper: seeds this.sharedMemory + sharedMemoryBuilt
  await app.stop();
  expect(order).toEqual(["flush", "close"]);
});
```

> If no `makeAppWithSharedMemory` helper exists, add a tiny test-only injection (e.g. an `__setSharedMemoryForTest` method guarded for tests) OR assert ordering through the public config-driven path the suite already uses for memory. Keep the production code change (Step 3) the source of truth.

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @mono-agent/agent-app test src/__tests__/app.test.ts`
Expected: FAIL — `resetSharedMemory` only calls `close()`, so `order` is `["close"]`.

- [ ] **Step 3: Flush before close in `resetSharedMemory` (`app.ts:521-529`)**

```ts
  private async resetSharedMemory(): Promise<void> {
    const mem = this.sharedMemory as
      | { flush?: () => Promise<void>; close?: () => Promise<void> | void }
      | undefined;
    this.sharedMemory = undefined;
    this.sharedMemoryBuilt = false;
    if (mem?.flush !== undefined) {
      await Promise.resolve(mem.flush()).catch(() => undefined);
    }
    if (mem?.close !== undefined) {
      await Promise.resolve(mem.close()).catch(() => undefined);
    }
  }
```

- [ ] **Step 4: Thread the app logger into the shared store**

In `agent-host/src/index.ts`, widen `createConfiguredMemory` to accept optional deps and forward a logger to every `createBujoMemoryStore` call:
```ts
export function createConfiguredMemory(
  config: MonoAgentConfig,
  deps: { logger?: { warn(message: string): void } } = {},
): MemoryStore | undefined {
```
Add `...(deps.logger !== undefined && { logger: deps.logger })` to each `createBujoMemoryStore({ … })` (the lite, journal, and bujo branches). In `agent-app/src/app.ts` `memoryStore()` (L513-519), pass the app logger:
```ts
      this.sharedMemory = createConfiguredMemory(coreConfig, ...(this.logger !== undefined ? [{ logger: this.logger }] : []));
```
(or the simpler `createConfiguredMemory(coreConfig, { logger: this.logger })` if `this.logger` is always defined — match the field's type.) The internal `buildHarness` call in agent-host (`createConfiguredMemory(config)`) stays unchanged (no logger → no-op).

- [ ] **Step 5: Run app tests + typecheck agent-host & agent-app**

Run: `pnpm --filter @mono-agent/agent-app test src/__tests__/app.test.ts && pnpm --filter @mono-agent/agent-host typecheck && pnpm --filter @mono-agent/agent-app typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-host/src/index.ts packages/agent-app/src
git commit -m "feat(agent-app): drain pending captures before closing memory; thread logger into the store"
```

---

## Workstream C — `@mono-agent/memory-mcp` v2

### Task C1: `busy_timeout` on DB open (concurrency hardening)

**Files:**
- Modify: `packages/memory-store/src/db.ts:44-45`
- Test: `packages/memory-store/src/__tests__/open.test.ts`

- [ ] **Step 1: Write a failing pragma test**

Add to `open.test.ts`:
```ts
it("sets a non-zero busy_timeout so concurrent writers retry instead of throwing SQLITE_BUSY", () => {
  const db = openMemoryDb({ path: ":memory:" });
  // @ts-expect-error reach the underlying handle for the pragma read
  const value = db.db.pragma("busy_timeout", { simple: true });
  expect(Number(value)).toBeGreaterThanOrEqual(5000);
  db.close();
});
```
> If `db.db` is not reachable in tests, add a `busyTimeoutMs(): number` getter on `MemoryDb` and assert that instead.

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @mono-agent/memory-store test src/__tests__/open.test.ts`
Expected: FAIL — `busy_timeout` defaults to 0.

- [ ] **Step 3: Set the pragma in the constructor (`db.ts`, right after WAL at L45)**

```ts
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
```

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @mono-agent/memory-store test src/__tests__/open.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/memory-store/src
git commit -m "feat(memory-store): busy_timeout=5000 so a second writer (MCP) retries instead of SQLITE_BUSY"
```

### Task C2: Scaffold the `@mono-agent/memory-mcp` package

**Files:**
- Create: `packages/memory-mcp/package.json`, `tsconfig.json`, `tsconfig.build.json`, `src/index.ts`, `README.md`
- Modify: `scripts/package-catalog.mjs:117` (insert entry)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@mono-agent/memory-mcp",
  "version": "0.2.2",
  "description": "MCP stdio server exposing the Bullet-Journal memory engine: recall, capture, and note over the SQLite substrate.",
  "type": "module",
  "license": "UNLICENSED",
  "private": false,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "bin": { "memory-mcp": "./dist/main.js" },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "@mono-agent/memory-bujo": "workspace:0.2.2",
    "@mono-agent/memory-search": "workspace:0.2.2",
    "@mono-agent/memory-store": "workspace:0.2.2",
    "zod": "^4.4.3"
  },
  "publishConfig": { "access": "public" }
}
```

- [ ] **Step 2: Create `tsconfig.json` and `tsconfig.build.json`**

Copy `packages/memory-bujo/tsconfig.json` verbatim to `packages/memory-mcp/tsconfig.json` (same compiler options / project refs pattern). Then `tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/**/*.test.ts", "src/**/__tests__/**"]
}
```
> Verify `tsconfig.json`'s `references` match this package's deps (memory-bujo, memory-store, memory-search) if the repo uses project references; mirror memory-bujo's references and adjust paths.

- [ ] **Step 3: Create a minimal `src/index.ts` so the package builds**

```ts
import { fileURLToPath } from "node:url";

export function resolveMemoryMcpMainPath(): string {
  return fileURLToPath(new URL("./main.js", import.meta.url));
}
```

- [ ] **Step 4: Add the catalog entry in `scripts/package-catalog.mjs` (after the `memory-bujo` entry, ~L117)**

```js
  {
    dir: "memory-mcp",
    name: "@mono-agent/memory-mcp",
    category: "context",
    responsibility: "Exposes the Bullet-Journal memory engine over MCP (stdio): recall, capture, and note tools backed by the SQLite substrate.",
    allowedDependencyCategories: ["core", "context"],
    publishable: true,
  },
```

- [ ] **Step 5: Install + verify the workspace + architecture check**

Run: `pnpm install && pnpm run check:architecture`
Expected: PASS — "Package architecture check passed for N workspace packages." (N increased by 1; the new package's deps are all `context`/external).

- [ ] **Step 6: Typecheck the new package**

Run: `pnpm --filter @mono-agent/memory-mcp typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/memory-mcp scripts/package-catalog.mjs pnpm-lock.yaml
git commit -m "feat(memory-mcp): scaffold @mono-agent/memory-mcp v2 package + catalog entry"
```

### Task C3: `createMemoryTools` — recall / capture / note (pure logic)

**Files:**
- Create: `packages/memory-mcp/src/tools.ts`
- Test: `packages/memory-mcp/src/__tests__/tools.test.ts`

- [ ] **Step 1: Write failing tests against a real store + fake LLM**

```ts
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

  it("capture returns an explicit error when the store has no llm (non-bujo)", async () => {
    const store = createBujoMemoryStore({ root: root() }); // lite — no llm
    const tools = createMemoryTools({ store });
    const res = await tools.capture({ text: "anything" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/bujo/i);
    await store.close();
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @mono-agent/memory-mcp test src/__tests__/tools.test.ts`
Expected: FAIL — `../tools.js` doesn't exist.

- [ ] **Step 3: Implement `tools.ts`**

```ts
import type { BujoMemoryStore } from "@mono-agent/memory-bujo";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface MemoryToolDeps {
  readonly store: BujoMemoryStore;
}

export interface MemoryTools {
  recall(args: { query: string; limit?: number }): Promise<ToolResult>;
  capture(args: { text: string }): Promise<ToolResult>;
  note(args: { text: string }): Promise<ToolResult>;
}

function textResult(text: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], ...(structured !== undefined && { structuredContent: structured }) };
}
function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(50, Math.max(1, Math.trunc(limit)));
}

export function createMemoryTools(deps: MemoryToolDeps): MemoryTools {
  return {
    async recall(args) {
      const topK = clampLimit(args.limit, 8);
      const hits = await deps.store.recall(args.query, { topK });
      if (hits.length === 0) return textResult(`No memories matched "${args.query}".`, { hits: [] });
      const text = hits.map((h) => `${h.score.toFixed(3)}  ${h.record.text}`).join("\n");
      return textResult(text, { hits: hits.map((h) => ({ id: h.record.id, score: h.score, text: h.record.text })) });
    },

    async capture(args) {
      const result = await deps.store.capture("mcp", args.text);
      if (result === undefined) {
        return errorResult("memory_capture requires the bujo tier (a chat LLM). This store has no LLM configured.");
      }
      return textResult(
        `Captured: ${result.actions} memory action(s), ${result.entities} entit${result.entities === 1 ? "y" : "ies"}.`,
        { actions: result.actions, entities: result.entities },
      );
    },

    async note(args) {
      const res = await deps.store.appendHostSummary("mcp", args.text);
      return textResult(`Noted to ${res.source}.`, { source: res.source, bytesWritten: res.bytesWritten });
    },
  };
}
```
> Ensure `@mono-agent/memory-bujo` re-exports `BujoMemoryStore` (type) and `LlmComplete` from its `index.ts`. If `LlmComplete` isn't exported, add `export type { LlmComplete } from "./llm.js";` to `packages/memory-bujo/src/index.ts` (and `BujoMemoryStore` if missing).

- [ ] **Step 4: Run — expect pass**

Run: `pnpm --filter @mono-agent/memory-mcp test src/__tests__/tools.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/memory-mcp/src packages/memory-bujo/src/index.ts
git commit -m "feat(memory-mcp): recall/capture/note tool logic over BujoMemoryStore"
```

### Task C4: MCP server (register tools) + config builder + stdio entry

**Files:**
- Create: `packages/memory-mcp/src/server.ts`, `src/main.ts`
- Modify: `packages/memory-mcp/src/index.ts` (export server API)
- Test: `packages/memory-mcp/src/__tests__/server.test.ts`

- [ ] **Step 1: Write a failing test that the server registers exactly the three tools**

```ts
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
    // McpServer exposes registered tools; read them via the SDK's introspection.
    const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
    expect(names).toEqual(["memory_capture", "memory_note", "memory_recall"]);
    await store.close();
  });
});
```
> If `_registeredTools` is not the accessor in this SDK version, list tools via the public `server.server.listTools()`-equivalent or assert through a connected in-memory transport. Adjust the introspection to whatever `@modelcontextprotocol/sdk@1.29` exposes (the retired server used `server.registerTool(...)`).

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @mono-agent/memory-mcp test src/__tests__/server.test.ts`
Expected: FAIL — `../server.js` doesn't exist.

- [ ] **Step 3: Implement `server.ts`**

```ts
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createBujoMemoryStore } from "@mono-agent/memory-bujo";
import type { BujoMemoryStore } from "@mono-agent/memory-bujo";
import { createOllamaLlm } from "@mono-agent/memory-bujo";
import { createEmbeddingProvider } from "@mono-agent/memory-search";
import type { EmbeddingProviderConfig } from "@mono-agent/memory-search";
import * as z from "zod/v4";

import { createMemoryTools, type MemoryToolDeps } from "./tools.js";

export function createMemoryMcpServer(deps: MemoryToolDeps): McpServer {
  const tools = createMemoryTools(deps);
  const server = new McpServer({ name: "agent-memory", version: "0.2.2" });

  server.registerTool(
    "memory_recall",
    {
      title: "Recall from memory",
      description: "Hybrid (keyword + semantic) search over long-term memory. Use to recall facts, decisions, and context.",
      inputSchema: {
        query: z.string().min(1).describe("Natural-language description of what to recall."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 8)."),
      },
    },
    async (args) => tools.recall(args),
  );

  server.registerTool(
    "memory_capture",
    {
      title: "Capture a memory",
      description: "Intelligently store a turn or fact: distil → reconcile (add/update/supersede) → extract entities. Requires the bujo tier.",
      inputSchema: { text: z.string().min(1).describe("The text to remember (a fact, decision, or turn).") },
    },
    async (args) => tools.capture(args),
  );

  server.registerTool(
    "memory_note",
    {
      title: "Quick note to memory",
      description: "Append a quick deterministic note (rapid-log) to today's daily file. No LLM required.",
      inputSchema: { text: z.string().min(1).describe("The note to record (one line).") },
    },
    async (args) => tools.note(args),
  );

  return server;
}

export interface MemoryMcpServerConfig {
  readonly root: string;
  readonly embeddings?: EmbeddingProviderConfig;
  readonly llm?: { readonly model: string; readonly endpoint?: string };
}

/** Build a server (and its backing store) from resolved config. Returns both so the caller can close the store. */
export function createMemoryMcpServerFromConfig(config: MemoryMcpServerConfig): { server: McpServer; store: BujoMemoryStore } {
  const store = createBujoMemoryStore({
    root: config.root,
    ...(config.embeddings !== undefined && {
      embeddings: createEmbeddingProvider(config.embeddings),
      dim: config.embeddings.dim ?? 768,
    }),
    ...(config.llm !== undefined && { llm: createOllamaLlm({ model: config.llm.model, ...(config.llm.endpoint !== undefined && { endpoint: config.llm.endpoint }) }) }),
  });
  const server = createMemoryMcpServer({ store });
  return { server, store };
}
```
> Confirm `createEmbeddingProvider`'s parameter type matches `EmbeddingProviderConfig` (memory-search/src/types.ts:34) and that `dim` is a valid field there; if `dim` lives only on the mono-agent config, drop it from `EmbeddingProviderConfig` usage and pass `dim` separately. Export `createOllamaLlm` from memory-bujo's `index.ts` if not already.

- [ ] **Step 4: Implement `main.ts` (stdio entry, env-resolved config)**

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { EmbeddingProviderConfig, EmbeddingProviderKind } from "@mono-agent/memory-search";

import { createMemoryMcpServerFromConfig } from "./server.js";

function readEmbeddings(): EmbeddingProviderConfig | undefined {
  const provider = process.env.MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER?.trim();
  if (provider !== "ollama" && provider !== "openai") return undefined;
  const model = process.env.MONO_AGENT_MEMORY_EMBEDDINGS_MODEL?.trim() || "nomic-embed-text:v1.5";
  const endpoint = process.env.MONO_AGENT_MEMORY_EMBEDDINGS_ENDPOINT?.trim();
  const apiKey = process.env.MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY?.trim();
  return {
    provider: provider as EmbeddingProviderKind,
    model,
    ...(endpoint ? { endpoint } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

function readLlm(): { model: string; endpoint?: string } | undefined {
  const model = process.env.MONO_AGENT_MEMORY_LLM_MODEL?.trim();
  if (!model) return undefined;
  const endpoint = process.env.MONO_AGENT_MEMORY_LLM_ENDPOINT?.trim();
  return { model, ...(endpoint ? { endpoint } : {}) };
}

async function main(): Promise<void> {
  const root = process.env.MONO_AGENT_MEMORY_PATH?.trim();
  if (!root) {
    process.stderr.write("memory-mcp: MONO_AGENT_MEMORY_PATH is required.\n");
    process.exitCode = 1;
    return;
  }
  const embeddings = readEmbeddings();
  const llm = readLlm();
  const { server, store } = createMemoryMcpServerFromConfig({
    root,
    ...(embeddings !== undefined && { embeddings }),
    ...(llm !== undefined && { llm }),
  });
  const closeStore = (): void => { void store.close(); };
  process.on("SIGINT", closeStore);
  process.on("SIGTERM", closeStore);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`memory-mcp: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 5: Export the server API from `index.ts`**

```ts
import { fileURLToPath } from "node:url";

export { createMemoryMcpServer, createMemoryMcpServerFromConfig } from "./server.js";
export type { MemoryMcpServerConfig } from "./server.js";
export { createMemoryTools } from "./tools.js";
export type { MemoryTools, MemoryToolDeps, ToolResult } from "./tools.js";

export function resolveMemoryMcpMainPath(): string {
  return fileURLToPath(new URL("./main.js", import.meta.url));
}
```

- [ ] **Step 6: Run server test + typecheck**

Run: `pnpm --filter @mono-agent/memory-mcp test && pnpm --filter @mono-agent/memory-mcp typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/memory-mcp/src packages/memory-bujo/src/index.ts
git commit -m "feat(memory-mcp): McpServer with recall/capture/note tools + stdio entry + config builder"
```

### Task C5: memory-mcp README

**Files:**
- Modify: `packages/memory-mcp/README.md`

- [ ] **Step 1: Write the README**

Document: what it exposes (the three tools + tier behavior), how to run it (`memory-mcp` bin over stdio), and the env it reads (`MONO_AGENT_MEMORY_PATH` required; `MONO_AGENT_MEMORY_EMBEDDINGS_*` for recall ranking; `MONO_AGENT_MEMORY_LLM_MODEL`/`_ENDPOINT` for `memory_capture`). Note it opens its own `memory.db` handle (WAL + busy_timeout makes concurrent use with a running agent safe) and that it replaces the retired v1 `memory.tools` config mechanism.

- [ ] **Step 2: Commit**

```bash
git add packages/memory-mcp/README.md
git commit -m "docs(memory-mcp): README — tools, env, concurrency"
```

---

## Workstream D — surfacing + verification

### Task D1: Docs — capture mode + MCP in the guides

**Files:**
- Modify: `docs/memory.md`
- Modify: `docs/feature-registry.md`
- Modify: `packages/agent-app/src/...` doctor (only if a quick `writeMode: capture` note is cheap; otherwise skip — validation already enforces it)

- [ ] **Step 1: Document `writeMode: "capture"` in `docs/memory.md`**

Add a subsection under the bujo tier: what `capture` does (sync rapid-log + async intelligent capture), that it requires `mode: "bujo"`, the latency/durability trade-off, and that captures drain on graceful shutdown.

- [ ] **Step 2: Add a "Memory over MCP" section to `docs/memory.md`**

Describe `@mono-agent/memory-mcp`: the three tools, env-based config, pointing a client at it, and that it supersedes the removed `memory.tools`.

- [ ] **Step 3: Update `docs/feature-registry.md`**

Add rows: `memory.writeMode: "capture"` → the harness capture path; `@mono-agent/memory-mcp` → memory-over-MCP. Remove any rows referencing the deleted `memory.scope`/`graphPath`/`tools`.

- [ ] **Step 4: Commit**

```bash
git add docs/memory.md docs/feature-registry.md
git commit -m "docs(memory): per-turn capture mode + memory-over-MCP; drop retired keys from the registry"
```

### Task D2: Full gate + real-Ollama e2e

**Files:** none (verification only) — optionally `scripts/` if a repeatable e2e script is added.

- [ ] **Step 1: Whole-repo gate**

Run: `pnpm run check:architecture && pnpm run typecheck && pnpm run test`
Expected: PASS — architecture check (N packages), whole-repo typecheck, and every package suite green (config, memory-store, memory-bujo, agent-harness, agent-app, memory-mcp).

- [ ] **Step 2: Real-Ollama e2e (manual, mirrors the PR's verification)**

With Ollama running (`nomic-embed-text:v1.5` + a chat model, e.g. `qwen3.6:latest`):
1. Build: `pnpm run build`.
2. **Per-turn capture:** point a temp config at a bujo memory root with `writeMode: "capture"` + `memory.llm`; run a couple of turns through the agent; confirm the daily file has rapid-log lines immediately AND (after a moment / on stop) `memory-bujo recall <root> "<topic>"` surfaces distilled memories + that `graph.jsonl` gained entities.
3. **MCP:** `MONO_AGENT_MEMORY_PATH=<root> MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER=ollama MONO_AGENT_MEMORY_LLM_MODEL=<chat> node packages/memory-mcp/dist/main.js` and drive `memory_note` → `memory_recall` → `memory_capture` from an MCP client (or a short stdio harness); confirm round-trips and that `memory_capture` on a lite root returns the explicit "requires bujo" error.

- [ ] **Step 3: Record the e2e outcome in the PR description / commit**

```bash
git commit --allow-empty -m "test(memory): P6 real-Ollama e2e verified — per-turn capture + memory-mcp round-trips"
```

---

## Self-review notes (author)

- **Spec coverage:** A (decisions 1-5, 8 drain) → A1-A4; B (the three keys) → B1-B3; C (decisions 6-8, MCP) → C1-C5; surfacing/testing (§5-7) → D1-D2. All spec sections map to a task.
- **Type consistency:** `MemoryWriteMode` widened in both `agent-harness/src/types.ts` and `config/src/types.ts` (A2, A3). `scheduleCapture`/`flush` signatures identical in contract (A1.4) and store (A1.5) and consumed in harness (A2) + app (A4). `store.recall(query, {topK})` defined in A1.5, consumed in C3. `ToolResult` shape consistent C3/C4. `createConfiguredMemory(config, deps?)` change (A4) leaves the agent-host-internal call site (no logger) valid.
- **Deferred (non-goals):** reflect/migrate MCP tools, entity-graph MCP tools, JSON-config (vs env) resolution in the MCP, live cutover, npm deprecate.
