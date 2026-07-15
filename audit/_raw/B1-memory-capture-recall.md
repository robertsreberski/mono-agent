# B1-memory-capture-recall — Bujo memory capture & recall pipeline

## 1 Verdict & maturity grade

**Grade: B-**

The durability engineering here is genuinely excellent: the completed-turn intake (`capture-intake.ts`) implements a full crash-safe admit → pending → {dead|resolved} state machine with a sharded, fsynced, integrity-cataloged admission ledger, bounded exponential-backoff retry, and dead-lettering — and it is honest end-to-end (no fake successes; every failure either retries durably or lands in an inspectable dead letter, never silently drops a turn). The strict-vs-loose extraction split is a deliberate, well-reasoned design (README documents it accurately). Test coverage of the durability/crash-recovery machinery is unusually thorough (1,397 lines in `capture-intake.test.ts` alone).

The grade is held to B- by one real correctness/compatibility gap that sits squarely on the framework's own "bring any model" flagship path (F1: the strict, production-wired capture path has zero tolerance for markdown-fenced JSON, and the built-in Ollama adapter never requests Ollama's native JSON mode — a very common local-model completion habit), plus a meaningful amount of dead/unreachable capture-pipeline code sitting in the package's public API surface (F2), and a misleadingly-named scheduled ritual (F3). None of these are secret leaks or data-loss bugs — the framework's honesty properties hold — but they are real gaps against the "clean memory" and "lean, understandable core" premises that should close before calling this territory frozen-with-confidence.

Not a live-instance part (library/package source only); no separate Framework-fit grade applies.

## 2 Findings

### F1 — P1 — Strict completed-turn capture has no markdown-fence tolerance; the built-in Ollama adapter never requests JSON mode

`packages/memory/src/bujo/capture-batch.ts:101-106`:
```ts
let parsed: unknown;
try {
  parsed = parseJsonExact<unknown>(raw);
} catch {
  throw outputError("capture-extract", "completion is not exact JSON");
```
`parseJsonExact` (`packages/memory/src/bujo/json.ts:36-132`) is a bare recursive-descent parser: it starts consuming at cursor 0 and, after the value, requires `cursor === text.length` or throws `"trailing data after JSON value"`. Any ```` ```json ... ``` ```` wrapper — or even a stray leading/trailing newline beyond plain whitespace — makes it reject the completion outright. This is the path `captureTurnStrict` uses (`capture.ts:46-48`), which is the *only* production-wired intelligent-capture path (`BujoMemoryStore.captureCompletedTurn` → `captureTurnStrict`, confirmed live via `configured-agent.ts`'s completed-turn wiring and `harness.ts`'s `persistCompletedTurn` call).

The built-in LLM adapter never asks the provider to avoid this: `packages/memory/src/bujo/ollama-llm.ts:25-30`:
```ts
const res = await fetch(`${endpoint}/api/generate`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: opts.model, prompt, stream: false }),
```
No `format: "json"` field. Ollama's `/api/generate` has natively supported a `format` parameter (JSON mode) for a long time specifically to suppress prose/fencing around structured output — this is exactly the situation the repo's own `pi-upstream-recon` skill exists to catch (prefer a native provider capability over hand-rolled repair), just applied to a different provider than pi.

Chat-tuned local models (the kind Ollama typically serves, and the one adapter this package ships) very commonly wrap JSON answers in ```` ```json ```` fences out of habit even when told "return ONLY JSON" — the prompt in `capture-batch.ts:24-25` says so but does not defend against it. If a configured model does this consistently (a stable per-model behavior, not a fluke), **every** retry of a given completed turn fails identically with `MemoryModelOutputError` → `failureCode` classifies it `"model_output"` (`capture-intake.ts:1962-1966`) → the record retries for ~44 hours (16 attempts, exponential backoff capped at 6h, matching the README's "more than 24 hours" claim) and then dead-letters (`capture-intake.ts:578-596`). The turn's deterministic summary is still written (honest, no data loss), but **zero** intelligent memory is ever extracted for that model/session — silently, from the operator's point of view, beyond a buried `warn()` call.

Confirmed no test anywhere exercises this: `grep -rlF '```' packages/memory/src/bujo/__tests__/` only matches `json.test.ts` and `distill.test.ts` (the loose, non-strict path); `strict-capture.test.ts` and `capture-intake.test.ts` feed only `JSON.stringify(...)`-clean completions, never a fenced one, into the strict path.

Why it matters vs premise: "bring any model" is a named yardstick clause, and the built-in/default/simplest-to-configure memory-LLM backend (Ollama, the only adapter shipped inside this package) is exactly the audience most likely to trip this.

### F2 — P2 — Dead-in-production capture-pipeline duplication sitting in the public API surface

Two full building blocks are exported from the package's canonical public surface (`index.ts`) yet have **zero** production callers anywhere in the monorepo (confirmed by repo-wide grep excluding tests/dist):

- `packages/memory/src/bujo/distill.ts:22` — `export async function distill(...)`, re-exported at `index.ts:101`. Only `normalizeCandidate` (a different, smaller function in the same file) is actually used, by `capture-batch.ts:1,69`.
- `packages/memory/src/bujo/entities.ts:103` — `export async function extractEntities(...)`, re-exported at `index.ts:106`. Nothing calls it outside its own tests.

Both duplicate logic that `capture-batch.ts`'s one-shot `extractCapturePlan`/`extractCapturePlanStrict` reimplements inline with its own prompt and its own entity-id scoping rules (entities/relations must reference ids from the *same* batch — a rule `distill()`+`extractEntities()`'s two-call design cannot even express, since entities are extracted in a separate call from memories).

One level deeper, the non-strict half of the *current* pipeline is itself unreachable in production: `capture.ts:29-31`'s `captureTurn` (non-strict) is only invoked by `BujoMemoryStore.capture()`, and repo-wide grep for `.capture(` (excluding the one internal call inside `capture-intake.ts:533`, which calls the *strict* wrapper) turns up **no caller of `BujoMemoryStore.capture()` anywhere in `agent-app` or `agent-harness`**. Only `persistCompletedTurn` (strict) and `appendHostSummary` (deterministic, no LLM) are wired into the live host. `capture-batch.ts`'s non-strict `extractCapturePlan` is therefore also effectively dead in production, reachable only via that same unwired method and via tests.

Why it matters vs premise: "a lean, understandable core open to external plugins." An external plugin author reading `index.ts`'s exports would reasonably assume `distill`/`extractEntities`/`captureTurn` are supported composable primitives; in reality the shipped pipeline bypasses all three, and using them would silently diverge from the real pipeline's behavior (double LLM calls, no cross-entity scoping, and — for `captureTurn` specifically — a code path currently not wired to anything the framework itself calls).

### F3 — P2 — `consolidate` ritual's name and result shape imply active cleanup it never performs, undocumented

`packages/memory/src/bujo/consolidate.ts:18-32`:
```ts
/**
 * Projection-only compatibility maintenance.
 *
 * Duplicate groups are reported, never folded: canonical Bullet fields and
 * the rebuildable SQLite index remain untouched.
 */
export async function consolidateBujoMemory(deps: ConsolidateDeps): Promise<ConsolidateResult> {
  const liveRecords = deps.db.topSalient(Math.max(deps.db.count(), 1));
  const groups = groupByNormalizedText(liveRecords);
  const duplicateGroups = [...groups.values()].filter((group) => group.length > 1).length;

  writeIndex(deps.root, deps.db, deps.now);
  writeEmptyFutureLog(deps.root);
  return { decayed: 0, duplicateGroups, superseded: 0, markdownInvalidated: 0 };
```
`decayed`, `superseded`, and `markdownInvalidated` are permanently hardcoded to `0` — the function never decays salience, never supersedes, never invalidates markdown. It only counts duplicate-text groups and refreshes `index.md`/`future-log.md`. This is confirmed live: it's called from `store.ts:829` and, per `agent-app/src/memory-rituals.ts`, scheduled by default every 2 hours whenever tier is `bujo`. Nothing in the codebase reads the three permanently-zero fields (confirmed by grep). `packages/memory/README.md` never mentions `consolidate` at all.

Why it matters vs premise: "clean memory" — the ritual's own name and its result type's field names (`decayed`, `superseded`) imply active hygiene; an operator inspecting logs or the result shape would reasonably believe duplicates are being merged and stale memories decayed on a 2-hour cadence, when in fact nothing changes except two derived markdown files and a count.

### F4 — P2 — `recall-evidence.ts`'s automatic-injection gate is a 344-line hand-rolled mini-parser with ad hoc exceptions

`packages/memory/src/bujo/recall-evidence.ts` implements five distinct `DirectFactQuery` shapes (named-property, choice, event-time, copular-time, location) via interacting regexes, a stopword/alias table, singular/plural canonicalization, and one-off literal exceptions baked into general-purpose helpers, e.g. `canonicalName` (`recall-evidence.ts:340-343`):
```ts
function canonicalName(token: string): string {
  if (token.endsWith("s") && token.length > 5 && token !== "atlas") return token.slice(0, -1);
  return token;
}
```
and the identical `"atlas"` carve-out again in `canonicalConcept` (`:332-337`). These read as reactive patches against specific test fixtures rather than a principled rule, which is the kind of debt that tends to accumulate silently (the next proper-noun-ending-in-s test failure gets its own carve-out).

The design intent is sound and documented (`recall-evidence.ts:1-8`: "intentionally not a general natural-language parser... a semantically relevant record that does not match one of those shapes remains available through the default-on MemoryRecall tool") and it fails *closed* (under-recall, not wrong-recall), which bounds the practical risk. But the premise's "a competent stranger must be able to understand the core" bar is a stretch for this file as it stands — the five query shapes, their canonicalization rules, and their interaction are not enumerated anywhere a new reader could scan in under a few minutes.

### F5 — P3 — Unicode-unsafe truncation and an inconsistent length bound in the non-strict candidate normalizer

`packages/memory/src/bujo/distill.ts:66-70`:
```ts
export function normalizeCandidateText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.normalize("NFKC").replace(/\s+/gu, " ").replace(/<!--mem/gu, "").trim().slice(0, 280);
  return text.length === 0 ? undefined : text;
}
```
`.slice(0, 280)` truncates by UTF-16 code unit, not Unicode code point or grapheme; if an astral character (emoji, CJK extension-B, etc.) straddles index 280 the cut produces a lone unpaired surrogate. When that string is later written to disk as UTF-8 (`writeCanonicalFileAtomic`), Node substitutes the replacement character for the unpaired half, silently mangling that one memory's text. `recall.ts:88-93`'s `clampToBytes` shows the codebase already knows the correct pattern (byte-bound + lenient `TextDecoder` + strip trailing replacement chars) — it just isn't applied here. Separately, both capture prompts (`capture-batch.ts:33`, `distill.ts:17`) tell the model the limit is "at most 160 Unicode code points," but this function's actual cap is 280 UTF-16 units — the two numbers don't correspond to the same unit or the same value, which is confusing for anyone trying to verify the contract end-to-end. Low severity (narrow trigger condition) but a real, fixable bug in an in-scope, exported (transitively, via `capture-batch.ts` and `reconcile.ts`) function.

### F6 — P3 — `parseJsonLoose`'s fence-body extraction falls back to the *entire* original text on a truncated fence

`packages/memory/src/bujo/json.ts:216-224`:
```ts
function firstFenceBody(text: string): string {
  const fence = text.indexOf("```");
  if (fence === -1) return text;
  let start = fence + 3;
  ...
  const end = text.indexOf("```", start);
  return end === -1 ? text : text.slice(start, end);
}
```
When the opening fence is never closed (a plausible truncated/max-tokens completion), the function returns `text` — the *whole original completion, including anything before the fence* — instead of `text.slice(start)` (just the unterminated fenced content). Because the downstream bracket-scanner in `parseJsonLooseWithDiagnostics` picks the *largest complete* JSON candidate it finds anywhere in the given body, this means a truncated fenced answer can cause the loose parser to silently return an unrelated, complete-but-wrong JSON blob that happened to appear earlier in the model's own output (e.g. restated instructions, chain-of-thought scratch), instead of correctly reporting "no result." Currently low-impact because `parseJsonLoose` is only reachable via the already-dead-in-production non-strict path (F2), but it is exported public API (`packages/memory/src/bujo/index.ts` does not re-export `parseJsonLoose` itself, but `distill()`/`extractCapturePlan` do call it, and it is a plausible target for reuse elsewhere) and worth a one-line fix regardless.

## 3 Dead code

| Path | Why dead | Proposed disposition | Proof hints |
|---|---|---|---|
| `distill.ts:22` `distill()` (whole function; `normalizeCandidate` in the same file is still used) | Zero non-test callers anywhere in the repo | Delete, or explicitly document as a legacy composable primitive no longer used by the shipped pipeline | `grep -rn "\bdistill(" --include="*.ts"` outside `__tests__`/`dist` → only its own definition |
| `entities.ts:103` `extractEntities()` | Zero non-test callers anywhere in the repo | Delete, or document as legacy | `grep -rn "extractEntities"` outside `__tests__`/`dist` → only its own definition |
| `capture.ts:29-31` `captureTurn` (non-strict) | Reachable only via `BujoMemoryStore.capture()`, which has no caller in `agent-app`/`agent-harness` | Wire into a concrete host trigger, or mark clearly as dormant/experimental in the README | `grep -rn "\.capture("` outside tests → only the *strict* internal call in `capture-intake.ts:533` |
| `capture-batch.ts:45-79` `extractCapturePlan` (non-strict) | Reachable only via the above dead `captureTurn` | Same as above | Same grep chain |
| `capture-intake.ts:1972` `compareLocated()` | Defined, never called or referenced anywhere (`nextPendingRuntimeId` and `pruneResolved` reimplement equivalent sort logic inline instead) | Delete | `grep -in "comparelocated"` → only the definition |

## 4 Deprecation & legacy

- `store.ts`'s `decay()` method carries an explicit `@deprecated` tag ("Salience is static canonical state; this is a compatibility no-op") — out of scope for this part (store.ts) but its sibling `consolidateBujoMemory` (F3, in scope) is effectively the same pattern (a compatibility no-op wearing an active-sounding name) without the `@deprecated` marker or docs to match; worth aligning the two.
- No `@deprecated`-tagged items exist within this part's file list itself. The legacy surface here is implicit rather than annotated: `index.ts`'s own section comments (`// Phase 2 capture pipeline` at line 77, `// Phase 3 rituals` at line 124, `// Phase 4 built-in LLM adapter` at line 121) are phase-numbered from the original build-out and, combined with F2's findings, show `distill`/`extractEntities` are "Phase 2" primitives superseded by the batched one-shot design without ever being marked as such — they read as current, first-class API next to everything else in the same export list.

## 5 Actionable steps

| ID | What | Why (premise/DoD link) | How | Effort | Acceptance-check | Freeze-blocking |
|---|---|---|---|---|---|---|
| B1-1 | Add fence tolerance to the strict completed-turn capture path and/or request Ollama JSON mode | F1 — "bring any model" flagship path silently dead-letters for fence-happy local models | Pass `format: "json"` in `ollama-llm.ts`'s request body; additionally add a bounded, still-fail-closed fence-strip pre-pass before `parseJsonExact` in `extractCapturePlanStrict` (strip at most one leading/trailing ```` ``` ````/```` ```json ```` wrapper, reject anything else unchanged) | M | New `strict-capture.test.ts` case: a ```` ```json ````-fenced, otherwise-valid completion succeeds; assert the Ollama request body includes `format` | y |
| B1-2 | Remove or clearly re-scope the dead `distill()`/`extractEntities()` exports | F2 — lean core / no orphaned public API for plugin authors | Delete both plus their `index.ts` re-exports, or add an explicit "legacy primitive, not used by the shipped pipeline" doc comment and README note | S | `index.ts` no longer silently exports unused symbols as first-class API; repo-wide grep shows zero remaining runtime dependents | n |
| B1-3 | Decide the fate of the unwired non-strict capture path (`captureTurn`/`BujoMemoryStore.capture()`) | F2 — "honest ops": nothing tells an operator this path is dormant | Either wire it into a concrete trigger (e.g. lightweight per-turn best-effort hook) or document its dormancy explicitly in the README/index.ts | M | A live call site + integration test exists, or the README explicitly states the method is not currently invoked by any shipped host | n |
| B1-4 | Trim or rename the `consolidate` ritual's misleading result shape | F3 — "clean memory": scheduled default-on ritual whose name/fields imply cleanup it never does | Shrink `ConsolidateResult` to the field actually computed (`duplicateGroups`), or restore real fold/decay behavior if intended; add a short README paragraph documenting the true (report-only) behavior | S | Type change compiles; README gains a "consolidate" section describing actual behavior | n |
| B1-5 | Add a design-rationale map to `recall-evidence.ts` | F4 — legibility ("a competent stranger must be able to understand the core") | Add a doc comment enumerating the 5 recognized `DirectFactQuery` shapes with one example query/fact pair each; consider moving the hardcoded exception list (e.g. `"atlas"`) to a documented, extensible table | M | A new reader can map each shape to an example in under 5 minutes from the file's top comment; `recall.test.ts`/existing tests stay green | n |
| B1-6 | Fix Unicode-unsafe truncation in `normalizeCandidateText` | F5 — correctness: can silently corrupt a memory record's text | Truncate by code point (or reuse `recall.ts`'s byte-safe `clampToBytes` pattern) and align the cap with the 160-code-point contract stated in the prompts | S | New `distill.test.ts` case with an astral character straddling the truncation boundary produces a well-formed string (no lone surrogates) | n |
| B1-7 | Fix `firstFenceBody`'s unterminated-fence fallback | F6 — can return an unrelated JSON blob instead of "no result" on truncated model output | Change `end === -1 ? text : ...` to `end === -1 ? text.slice(start) : ...` | S | New `json.test.ts` case: a response with an unrelated complete JSON object before an unterminated fence must not return that earlier object | n |
| B1-8 | Delete dead `compareLocated()`; consider a repo-wide unused-code lint | Dead code section — lean core; the compiler doesn't currently catch this class of issue (`noUnusedLocals` is off in `tsconfig.base.json`) | Remove the function now (S); separately file a tracking issue to evaluate `noUnusedLocals`/an unused-vars ESLint rule repo-wide (L, likely surfaces pre-existing violations elsewhere) | S/L | Function removed; tracking issue filed for the broader lint change | n |

## 6 Skill-worthy flags

- **Prefer-native-provider-capability gap, generalized beyond `pi`**: the memory package hand-rolls two JSON-repair parsers (`parseJsonLoose`, `parseJsonExact`) to cope with unreliable model output instead of using Ollama's native `format: "json"` structured-output mode (F1). The existing `pi-upstream-recon` skill only frames this check around the vendored `pi` packages; it (or a sibling skill) should generalize the checklist item to "before hand-rolling output-shape recovery for *any* provider integration, check that provider's native structured-output/JSON-mode support first" — this would have caught F1 at design time.
- **Dead-code-by-inference pattern**: this territory had a well-tested-but-unreachable pipeline (F2) that only surfaced by grepping every exported symbol for non-test callers across the *whole* monorepo, not just the owning package. Worth a lightweight checklist addition to whichever skill governs pre-freeze/dead-code review: "for each symbol exported from a package's public index, grep the rest of the monorepo (not just the package itself) for a non-test caller before treating good test coverage as evidence the code is live." A one-line addendum to `verify-green` or a dedicated dead-code pass would prevent this from recurring at the next freeze audit.
- **`noUnusedLocals`/unused-vars gap**: `tsconfig.base.json` has no `noUnusedLocals`/`noUnusedParameters`, and there's no repo-root ESLint config, so a fully dead private function (`compareLocated`) shipped unnoticed. Not this part's call to flip that switch repo-wide (likely surfaces many pre-existing violations elsewhere), but worth a tracked follow-up rather than silence.

## 7 Coverage note

All files in the assigned scope were read in full:

- `packages/memory/src/bujo/capture.ts`
- `packages/memory/src/bujo/capture-intake.ts` (2,032 lines, read in full across two passes)
- `packages/memory/src/bujo/capture-batch.ts`
- `packages/memory/src/bujo/recall.ts`
- `packages/memory/src/bujo/recall-evidence.ts`
- `packages/memory/src/bujo/distill.ts`
- `packages/memory/src/bujo/consolidate.ts`
- `packages/memory/src/bujo/daily.ts`
- `packages/memory/src/bujo/grammar.ts`
- `packages/memory/src/bujo/entities.ts`
- `packages/memory/src/bujo/projections.ts`
- `packages/memory/src/bujo/queue.ts`
- `packages/memory/src/bujo/llm.ts`
- `packages/memory/src/bujo/ollama-llm.ts`
- `packages/memory/src/bujo/model-error.ts`
- `packages/memory/src/bujo/ids.ts`
- `packages/memory/src/bujo/json.ts`
- `packages/memory/src/bujo/cli.ts`
- `packages/memory/src/bujo/cli-env.ts`
- `packages/memory/src/bujo/index.ts`
- `packages/memory/src/bujo/types.ts`
- `packages/memory/README.md`

Test files skimmed (not line-by-line audited) to judge coverage adequacy, per method: `capture-batch.test.ts`, `capture-intake.test.ts` (browsed its full `describe`/`it` index plus several representative bodies), `distill.test.ts`, `entities.test.ts`, `complete-label.test.ts`, `strict-capture.test.ts`, `json.test.ts`, `recall.test.ts`, `store.test.ts` (grepped for queue-behavior coverage only), `daily.test.ts` (grepped), `rewrite.test.ts` (grepped).

Out-of-scope files consulted only as corroborating cross-reference context (not audited, no formal findings anchored to them): `packages/memory/src/bujo/store.ts` (capture/consolidate/intake wiring, journal-lock usage), `packages/memory/src/bujo/reconcile.ts` (signature/behavior of `reconcileBatch` that `capture.ts` depends on), `packages/memory/src/store/types.ts` and `db.ts` (`RecallHit` shape), `packages/agent-app/src/memory-retrieval.ts`, `packages/agent-app/src/memory-rituals.ts`, `packages/agent-app/src/configured-agent.ts`, `packages/agent-harness/src/harness.ts`, `tsconfig.base.json`.
