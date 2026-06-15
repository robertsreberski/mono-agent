# Memory v2 — Phase 4: Surfacing & Rollout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal (the user's core ask):** make BuJo memory **discoverable and impossible to silently fail** through the agent-creation playbook. Add a real local LLM adapter so capture/reflect/migrate run end-to-end; expose `memory.mode: "bujo"` in config; wire it into `agent-host`; add a `validate`/doctor self-check that confirms it's live; surface it in the `mono-agent-composer` skill, `docs/feature-registry.md`, and a new `docs/memory.md`. Default stays `markdown` (opt-in), per the user's decision.

**Architecture:** `memory-bujo` gains an OPTIONAL built-in `createOllamaLlm()` implementing its own injected `LlmComplete` via Ollama `/api/generate` (local-first, mirrors memory-search's Ollama embeddings; the injected-LLM design is preserved — this is just one provided implementation). The CLI's `reflect`/`migrate` (deferred in P3) now wire it. `@mono-agent/config` adds `"bujo"` to `MemoryMode` + an optional `memory.llm` block. `agent-host`'s `createConfiguredMemory` gains a `bujo` branch building an in-process `EmbeddingProvider` (+ optional Ollama LLM) and `createBujoMemoryStore`. `agent-app`'s doctor gains a bujo liveness check (embeddings reachable + model pulled + db writable; loud on misconfig). Composer skill + feature-registry + docs make it discoverable. Live `~/personal-agent` cutover is PREPARED and verified but executed only on explicit confirmation (it restarts a running service).

**Tech Stack:** TS ESM/NodeNext, strict TS, vitest. Builds on P1–P3 (branch `feat/memory-bujo`).

**Plan-code convention:** interfaces + behavior + test intent given; implementers read the real `config`/`agent-host`/`agent-app` code and adapt to actual types, following existing idioms. Each task ends green (build/typecheck/test/arch) and commits.

---

## Task 1: `memory-bujo` — `createOllamaLlm()` (built-in LlmComplete via Ollama)

**Files:** Create `packages/memory-bujo/src/ollama-llm.ts`; Modify `src/index.ts`; Test `src/__tests__/ollama-llm.test.ts`.

- [ ] **Step 1: implement** `createOllamaLlm(opts: { model: string; endpoint?: string; timeoutMs?: number }): LlmComplete`:
```ts
import type { LlmComplete } from "./llm.js";
export function createOllamaLlm(opts: { model: string; endpoint?: string; timeoutMs?: number }): LlmComplete {
  const endpoint = (opts.endpoint ?? "http://localhost:11434").replace(/\/$/u, "");
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return {
    id: `ollama:${opts.model}`,
    async complete(prompt: string): Promise<string> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${endpoint}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: opts.model, prompt, stream: false }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`ollama /api/generate ${res.status}`);
        const data = (await res.json()) as { response?: unknown };
        return typeof data.response === "string" ? data.response : "";
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
```
Note: `complete` may throw (network/abort) — callers (distill/reconcile/reflect/migrate) already guard LLM calls, so a throw degrades gracefully.

- [ ] **Step 2: failing test `ollama-llm.test.ts`** — stub global `fetch` (vitest `vi.stubGlobal("fetch", ...)`): assert `complete` posts to `<endpoint>/api/generate` with `{model,prompt,stream:false}` and returns `data.response`; returns "" when response missing; throws on non-ok status; `id` is `ollama:<model>`; trailing slash on endpoint is trimmed. Restore fetch after.
- [ ] **Step 3:** export `createOllamaLlm` from index.ts. test/typecheck/build green. **Commit** `feat(memory-bujo): createOllamaLlm built-in LlmComplete (Ollama /api/generate)`.

---

## Task 2: `memory-bujo` CLI — wire `reflect`/`migrate` via Ollama (close the P3 deferral)

**Files:** Modify `packages/memory-bujo/src/cli.ts`; Test extend CLI smoke (manual).

- [ ] **Step 1:** In `cli.ts`, replace the P3 "reflect/migrate require an LLM … not available" stubs with real wiring: build the embeddings provider (as today) AND `const chatModel = process.env.MONO_AGENT_LLM_MODEL;` — if unset, print a clear error ("set MONO_AGENT_LLM_MODEL to a local Ollama chat model, e.g. qwen3.6:latest") and `exit(2)`. Else `const llm = createOllamaLlm({ model: chatModel, ...(endpoint from MONO_AGENT_LLM_ENDPOINT) })`. For `reflect`: construct a `BujoMemoryStore`-equivalent flow OR call the pure `reflect({db, root, llm, nextId: createIdFactory(), now: () => new Date()})` then `writeFutureLog`+`writeIndex`; print a summary (`reflected: decayed N, insights M, due K`). For `migrate`: call `migrate(...)` then print counts + note the monthly file. Keep the try/finally db.close. `index` unchanged.
- [ ] **Step 2:** typecheck/build (dist/cli.js emitted). Manual smoke is part of the Phase-4 gate (Task 7) against real Ollama.
- [ ] **Step 3:** **Commit** `feat(memory-bujo): CLI reflect/migrate wired to Ollama LLM`.

---

## Task 3: `@mono-agent/config` — add `"bujo"` mode + optional `memory.llm`

**Files:** Modify `packages/config/src/{types.ts,field-groups.ts,config.ts,json-source.ts,index.ts}`; Tests in `packages/config/src/__tests__/`.

- [ ] **Step 1:** `types.ts`: `MemoryMode = "markdown" | "journal" | "bujo"`. Add `MemoryLlmConfig` (`{ provider: "ollama"; model: string; endpoint?: string }`) and optional `readonly llm?: MemoryLlmConfig` on `MemoryConfig` (+ redacted variant if the redacted type enumerates fields). bujo reuses existing `path` (root), `maxBytes`, `embeddings`.
- [ ] **Step 2:** `field-groups.ts`: add `"bujo"` to the `memory.mode` options; update the `memory.path` description to mention bujo ("bujo mode: the memory root directory"); add fields for `memory.llm.provider`/`memory.llm.model`/`memory.llm.endpoint` (optional). Keep validation consistent with existing field defs.
- [ ] **Step 3:** `config.ts`: add `"bujo"` to the `readChoice<MemoryMode>(... MONO_AGENT_MEMORY_MODE ...)` allowed list; parse `MONO_AGENT_MEMORY_LLM_PROVIDER/MODEL/ENDPOINT` into `memory.llm` (optional). `json-source.ts`: accept `mode: "bujo"` and an optional `llm` object.
- [ ] **Step 4:** Tests: extend config tests to cover loading a `mode: "bujo"` config (JSON + env) with an `llm` block; redaction keeps/redacts as appropriate. Run `pnpm --filter @mono-agent/config run test` (all pass), typecheck, build.
- [ ] **Step 5:** **Commit** `feat(config): memory.mode "bujo" + optional memory.llm`.

---

## Task 4: `agent-host` — `createConfiguredMemory` bujo branch

**Files:** Modify `packages/agent-host/src/index.ts`, `packages/agent-host/package.json` (add deps `@mono-agent/memory-bujo`, `@mono-agent/memory-search`); Test `packages/agent-host/src/__tests__/`.

- [ ] **Step 1:** In `createConfiguredMemory`, add a branch BEFORE the journal branch:
```ts
if (config.memory.mode === "bujo") {
  const embeddings = createEmbeddingProvider({
    provider: config.memory.embeddings?.provider ?? "ollama",
    model: config.memory.embeddings?.model ?? "nomic-embed-text:v1.5",
    ...(config.memory.embeddings?.endpoint ? { endpoint: config.memory.embeddings.endpoint } : {}),
    ...(config.memory.embeddings?.apiKey ? { apiKey: config.memory.embeddings.apiKey } : {}),
  });
  const dim = config.memory.embeddings?.dim ?? 768; // add `dim?` to MemoryEmbeddingsConfig if absent (Task 3) or default 768
  return createBujoMemoryStore({
    root: config.memory.path,
    embeddings,
    dim,
    ...(config.memory.maxBytes !== undefined && { maxBytes: config.memory.maxBytes }),
    ...(config.memory.llm?.provider === "ollama" && { llm: createOllamaLlm({ model: config.memory.llm.model, ...(config.memory.llm.endpoint ? { endpoint: config.memory.llm.endpoint } : {}) }) }),
  });
}
```
Import `createBujoMemoryStore`/`createOllamaLlm` from `@mono-agent/memory-bujo`, `createEmbeddingProvider` from `@mono-agent/memory-search`. If `MemoryEmbeddingsConfig` has no `dim`, default 768 (or add `dim?` in Task 3 — implementer's call; keep consistent). Add the two deps to package.json (allowed: agent-host is `execution`, may depend on `context`).
- [ ] **Step 2:** Test: a `mode: "bujo"` config produces a `BujoMemoryStore` (instanceof / duck-typed: has `load`+`appendHostSummary`+`capture`); `load`/`appendHostSummary` work against a tmp root with a fake/real embeddings provider. (If the host test can't easily inject a fake embeddings provider, assert the store is constructed and `load` returns a markdown block.) Run `pnpm --filter @mono-agent/agent-host run test`, typecheck, build, arch check.
- [ ] **Step 3:** **Commit** `feat(agent-host): wire memory.mode "bujo" to BujoMemoryStore`.

---

## Task 5: `agent-app` doctor — bujo liveness self-check (no silent fallback)

**Files:** Modify `packages/agent-app/src/doctor.ts`; Test `packages/agent-app/src/__tests__/doctor.test.ts`.

- [ ] **Step 1:** Read `doctor.ts` to match its existing check structure (it likely returns a list of {name, ok, detail} or logs). Add a check that runs when `config.memory?.mode === "bujo"`:
  - **embeddings reachable**: probe the configured Ollama endpoint (`GET <endpoint>/api/tags`) and confirm the configured embeddings model (e.g. `nomic-embed-text:v1.5`) is present → ok/warn with a clear message ("embeddings model X not pulled — run `ollama pull X`"). Network failure → warn ("Ollama not reachable at <endpoint>; bujo memory will fail to embed").
  - **chat llm (if memory.llm configured)**: same tags probe for the chat model.
  - **memory root writable**: confirm `config.memory.path` dir is creatable/writable.
  - Emit a LOUD warning if bujo is selected but embeddings are unreachable (the "didn't surface / silently degraded" cure).
  Keep network probes defensive (short timeout; never throw — degrade to a warn line).
- [ ] **Step 2:** Test: with `mode: "bujo"` and a stubbed fetch returning the model in `/api/tags` → check passes; with fetch failing → a warning entry is produced (not a throw); with model absent → a "not pulled" warning. Use the doctor test's existing harness; stub fetch.
- [ ] **Step 3:** Run `pnpm --filter @mono-agent/agent-app run test`, typecheck, build. **Commit** `feat(agent-app): doctor bujo-memory liveness check (warns instead of silently degrading)`.

---

## Task 6: Surface in the playbook — composer skill + feature-registry + docs

**Files:** `docs/feature-registry.md` (modify); `docs/memory.md` (create); the `mono-agent-composer` skill (locate: check `docs/skills/` and `~/.claude/**`; if in-repo, edit; if external, document the exact addition in `docs/memory.md` + note in feature-registry).

- [ ] **Step 1: `docs/feature-registry.md`** — add row(s) mapping the BuJo memory feature → config: `memory.mode: "bujo"`, `memory.path` (root), `memory.embeddings.{provider,model}`, `memory.llm.{provider,model}`, and the CLI `memory-bujo rebuild|recall|index|reflect|migrate`. Follow the file's existing table format.
- [ ] **Step 2: `docs/memory.md`** — a concise operator guide: the three modes (markdown default / journal / **bujo**), what bujo does (capture→reconcile, reflection, migration, hybrid recall), the config block (with example JSON), the CLI subcommands, the Ollama prerequisites (embeddings model + optional chat model), and how `validate`/doctor confirms liveness. Reference the spec + plans.
- [ ] **Step 3: composer skill** — locate `mono-agent-composer`. If its source is in-repo (e.g. `docs/skills/mono-agent-composer*`), add a memory step: when composing, proactively explain the bujo option, ask the bujo questions (local embeddings model; optional chat model for capture/reflection; reflection on/off), and write the `memory` block (default markdown unless the user opts into bujo). If the skill is external (plugin cache, not in this repo), instead add a clearly-labeled "Composer integration" section to `docs/memory.md` specifying the exact block the composer should write, and note in the commit message that the external skill update is tracked separately.
- [ ] **Step 4:** No code tests (docs/skill). Verify markdown renders sanely; `node scripts/check-package-architecture.mjs` still passes (docs don't affect it but confirm). **Commit** `docs(memory): surface bujo memory in feature-registry + memory.md + composer`.

---

## Task 7: Phase-4 verification gate + real end-to-end + rollout prep

- [ ] **Step 1:** `node scripts/check-package-architecture.mjs` → passed (agent-host now depends on memory-bujo/memory-search — both `context`, allowed for `execution`).
- [ ] **Step 2:** Whole-relevant build + typecheck: `pnpm --filter @mono-agent/memory-store --filter @mono-agent/memory-bujo --filter @mono-agent/config --filter @mono-agent/agent-host --filter @mono-agent/agent-app run build` and `run typecheck` → clean.
- [ ] **Step 3:** Full test suites for the touched packages → green.
- [ ] **Step 4: REAL end-to-end (Ollama present on this machine):** in a tmp root, drive the CLI: `memory-bujo rebuild <root>`; then exercise capture+reflect through a tiny node script using `createBujoMemoryStore` with `createOllamaLlm({model: <a local chat model, e.g. qwen3.6:latest>})` + real Ollama embeddings — `await store.capture("s1", "<multi-sentence text>")` then `await store.reflect()` — assert memories recallable, an entity/insight created, future-log.md + index.md written. (Guard the chat-model name behind an env; pick one present in `ollama list`.) This proves the full intelligent path against a real model.
- [ ] **Step 5: Rollout prep (do NOT auto-cutover the live service):** produce the exact `memory` config block for `~/personal-agent` to switch to `mode: "bujo"`, and the steps (rebuild, `mono-agent validate`/doctor, `mono-agent restart`). Present these for explicit confirmation rather than restarting the live launchd service automatically.
- [ ] **Step 6:** Commit any gate fixes. Final: a holistic review of the whole Memory v2 (P1–P4) before finishing the branch.

---

## Self-Review (planning)
- Spec coverage: §11 surfacing — config (Task 3), agent-host wiring (Task 4), validate self-check (Task 5), composer + feature-registry + docs (Task 6); real LLM adapter (Task 1) closes the capture/reflect/migrate end-to-end gap and the P3 CLI deferral (Task 2). §12 live rollout — prepared in Task 7 Step 5, executed on confirmation.
- Boundary: `createOllamaLlm` is a provided implementation of the injected `LlmComplete` (memory-bujo may fetch localhost, like memory-search) — design preserved; agent-host (execution) → memory-bujo/memory-search (context) is allowed.
- Carry-ins from earlier reviews to address opportunistically: reflect idempotence (a `lastReflectedAt`/dedup guard) — optional here, can stay a documented nightly-job characteristic; about-edge cartesian tightening — defer to a later pass. AM session-aware priming (load() needs a query arg — a `MemoryStore` contract change) — note in docs as a known limitation; out of P4 scope unless trivial.
- Non-goals: changing the `MemoryStore.load` contract; auto-restarting the live service.
