# C4-tui-session-web — tui & session-web operator surfaces

## 1 Verdict & maturity grade

**Grade: B+**

Both packages are unusually well-engineered for a v1: every non-obvious invariant (session-boundary rendering, live-fold vs. disk-artifact precedence, SSE backpressure, memory-health fail-closed normalization, eviction semantics) is documented inline with a rationale, and the two surfaces agree with each other and with the premise almost everywhere they overlap. Correctness risk is low — no dishonest fallback or fake-success path was found; memory-health projection explicitly fails closed to "unknown" rather than rendering false-green (`packages/session-web/webapp/src/views/InstancesView.tsx:116-141`). The grade is held to B+ rather than A- by a real, measurable test-coverage gap in the browser layer (the actual React render trees for the two most important views are essentially unexercised by any test) and a handful of small dead-code/staleness items that a frozen codebase should not carry forward.

This part has no live-instance component (no running agent or SQLite file was touched), so no separate framework-fit grade applies.

## 2 Findings

**F1 — P2 — Replay's post-hoc view degrades session-boundary events to raw JSON, unlike live chat**
`packages/tui/src/ui/views/replay-detail.ts:194-196`
```ts
if (item.category === "runtime") {
  return item.type === "runtime_warning" ? new NoticeCell(item.summary, "warning") : undefined;
}
```
`buildDetailCell` only special-cases `runtime_warning`; every other `"runtime"`-category item — including a `session_boundary` telemetry event — falls through to `undefined` and is rendered via `buildRawPayloadBody` (raw JSON dump), not a friendly cell. Contrast with the live chat surface, `packages/tui/src/ui/turn-presenter.ts:143-172`, which renders the *same* event kind as a compact `"session boundary: rollover"`-style `NoticeCell` (and is thoroughly tested — see `packages/tui/src/__tests__/turn-presenter.test.ts:191-260`). No test in `replay-view.test.ts` or `event-list.test.ts` exercises a `session_boundary` item in the detail pane, confirming the gap is real, not just theoretical. This directly affects the "legible sessions" DoD clause for the one surface (replay/debugging) an operator would use *after the fact* to understand a rollover — exactly when legibility matters most. `@mono-agent/session-web`'s equivalent surface (`DetailView.tsx`'s `"boundary"` step kind, lines 136-151 and 881-898) gets a fully friendly, first-class rendering, so this is an asymmetry between the two operator surfaces rather than a universal gap.

**F2 — P1 — The webapp's actual React render trees are effectively untested; only extracted pure functions are**
`packages/session-web/webapp/src/views/ListView.tsx` (1092 lines, 0% statement coverage), `packages/session-web/webapp/src/App.tsx` (301 lines, 0%), `packages/session-web/webapp/src/views/DetailView.tsx` (1193 lines, 17.36% — only the exported pure helpers are hit).
Measured directly (`cd packages/session-web/webapp && node_modules/.bin/vitest run --coverage`, CI=true):
```
All files          |   44.03 |    79.15 |   75.24 |   44.03 |
 src/views         |   25.23 |    78.77 |   83.78 |   25.23 |
  DetailView.tsx    |   17.36 | ...
  ListView.tsx      |       0 | ...
```
There is no `@testing-library/react` (or any DOM-render helper) in `packages/session-web/webapp/package.json`'s dependencies, and `grep -c "render(" **/*.test.ts` returns 0 across every webapp test file. Every `*.test.ts` alongside a view (`DetailView.test.ts`, `InstancesView.test.ts`, `list-model.test.ts`) imports only the exported pure functions (`boundaryStepLabel`, `ctxSummaryLine`, `buildConversationDayGroups`, `buildInstanceCards`, …) and asserts on their return values — never mounts the component, never asserts on rendered output, never exercises a click handler, filter chip, or the day/lane grouping JSX itself. `App.tsx` (routing between list/instances/detail, the auth-error/token-entry form, the fixture-fallback status pill) has **zero** test coverage of any kind. This is precisely the component that renders `buildConversationDayGroups`'s output (the "conversation-day grouping" this audit was asked to verify) — the grouping *logic* is well tested (`list-model.test.ts`), but whether it actually renders correctly, given real props, running through real component lifecycle, is not verified by any automated test. For a frozen codebase this matters more, not less: any future edit to `ListView.tsx` or `App.tsx` has zero regression protection beyond manual/eyeball smoke testing.

**F3 — P2 — The `dangerouslySetInnerHTML` markdown renderer is almost entirely untested**
`packages/session-web/webapp/src/lib/markdown.ts` — 7.14% statement coverage (`md`, `mdInline`, and the `Markdown` component that calls `dangerouslySetInnerHTML` at lines 89-94 are effectively unexercised; only `esc()` gets indirect coverage via `format.test.ts`). This module hand-rolls markdown-to-HTML for arbitrary agent/tool output (thinking blocks, assistant text, tool args/results) and injects it into the DOM via `dangerouslySetInnerHTML`. Manual review shows the escape-then-wrap ordering is correct (raw text is HTML-escaped by `esc()` before any markdown-generated tag is added, so an adversarial `<script>` or attribute-breakout attempt in a tool result would render as inert escaped text) — this is **not** a live vulnerability today. But it is the single most safety-sensitive piece of code in the webapp, and it has no regression test asserting that escaping survives a change (e.g., a future edit to the code-span or link regex that shifts escape order). Given the freeze, an un-caught regression here would ship straight to operators with no test to catch it.

**F4 — P3 — Dead code: `TuiAgentCancelledError`/`isTuiAgentCancelledError` exported but never consumed**
`packages/tui/src/agent/responder.ts:17-29`, re-exported at `packages/tui/src/index.ts:8-11`. `grep -rn "TuiAgentCancelledError\|isTuiAgentCancelledError" packages --include="*.ts"` (excluding tui's own src/dist) turns up only a same-named class independently re-declared inside `agent-contracts`'s own test file (not an import of the real one). Inside `packages/tui/src/ui/views/chat.ts`, cancellation checks use `isAgentResponseCancelledError` imported directly from `@mono-agent/agent-contracts`, never the tui-specific wrapper. Coverage confirms it: `agent/responder.ts` is 0% covered. The whole 29-line file is unused public API surface for a package whose README promises "a lean, understandable core."

**F5 — P3 — Stale, unused version constant**
`packages/tui/src/runtime/version.ts:6`
```ts
export const TUI_PACKAGE_VERSION = "0.1.0";
```
with a comment promising it is "Updated manually when the package version changes." `packages/tui/package.json`'s actual version is `0.11.2`. `grep -rn "TUI_PACKAGE_VERSION" packages/tui/src` shows it is only ever re-exported (`index.ts`), never read anywhere — no `--version` CLI flag exists in `bin/cli.ts`, and the help overlay in `ui/app.ts:653-687` doesn't reference it either. It is both stale (wrong by 11 minor versions) and dead (nothing renders it), which is a small but real honesty/legibility smell for a package that otherwise takes documentation-matches-code seriously.

**F6 — P2 — The Config view/pane (one of 4 core TUI views) has no dedicated test**
`packages/tui/src/ui/views/config.ts` (112 lines, 44.7% coverage — only incidentally exercised, e.g. via `app-smoke.test.ts`'s constructor path) and `packages/tui/src/config/pane.ts` (44 lines, 14.28% coverage). `ls packages/tui/src/__tests__/ | grep -i config` returns nothing — there is no `config.test.ts` or `pane.test.ts` anywhere in the package. The Config view is the TUI's read-only preview of the resolved, redacted configuration (`buildTuiConfigSummary`, shared with the `mono-agent config` CLI command) — directly load-bearing for the "legible... honest ops" premise clause, since it's the one place an operator checks "what is this agent actually configured to do, and where did each value come from." Its `refresh()` success path (the redaction, section-building, and source-annotation logic actually rendering) is untested.

**F7 — P3 — Dead code: `listInstanceSessions` back-compat alias has no production caller**
`packages/session-web/src/history.ts:101-110`. Documented as a "Back-compat alias for callers that only need list rows," but `grep -rn "listInstanceSessions\b" packages/session-web/src` shows it is called only from its own test file (`history.test.ts`) — the aggregator uses `listInstanceSessionSummaries`/`listInstanceSessionSummaryPage` directly. It is also not re-exported from `packages/session-web/src/index.ts`, so it isn't part of the package's declared public API either — genuinely orphaned back-compat surface.

**F8 — P3 — Session-web's bearer auth token persists indefinitely in `localStorage`**
`packages/session-web/webapp/src/lib/api.ts:307-322` (`saveAuthToken`) writes the token to both `sessionStorage` and `window.localStorage` (`AUTH_TOKEN_PERSIST_KEY`), and `currentAuthToken()` (lines 268-305) falls back to the `localStorage` copy indefinitely (only cleared by an explicit `clearAuthToken()` call). For a read-only operator console this is a reasonable convenience tradeoff (avoids re-pasting the token every reload on a trusted machine/Tailscale node), but it does widen the token's exposure window beyond the tab session, and the README's security section (lines 46-65) doesn't mention this persistence choice when it otherwise documents the auth model in detail.

**F9 — P3 — TUI's custom-host embedding path (`--responder`) is untested**
`packages/tui/src/bin/cli.ts:101-136` (`loadResponder`, `exitWithError`) — 55.55% file coverage, with lines 91-136 uncovered. `cli.test.ts` only tests `parseArgs`; the dynamic `import()` of a user-supplied ESM module and its `createResponder`/default-export resolution logic (the actual mechanism third-party embedding hosts rely on per the README's "Embedded" mode) has zero test coverage.

## 3 Dead code

| Path | Why dead | Proposed disposition | Proof |
|---|---|---|---|
| `packages/tui/src/agent/responder.ts` (`TuiAgentCancelledError`, `isTuiAgentCancelledError`) | Exported from package's public API (`index.ts`) but never imported/consumed anywhere in the monorepo; `chat.ts` uses the base `agent-contracts` function directly instead | Remove the wrapper class + re-export, or find/document a real external consumer before keeping it | 0% coverage; grep across all packages shows no real import, only an independently-declared same-named class in an unrelated test file |
| `packages/tui/src/runtime/version.ts` (`TUI_PACKAGE_VERSION`) | Hardcoded stale value (`0.1.0` vs actual `0.11.2`), never rendered anywhere (no `--version` flag, no help-overlay use) | Either wire to package.json at build time and surface via `--version`/help overlay, or delete | 0% coverage; grep shows only the re-export in `index.ts` consumes it |
| `packages/session-web/src/history.ts` (`listInstanceSessions`) | "Back-compat alias" with no production caller (aggregator uses the summary/page functions directly); not re-exported from `index.ts` | Low priority — cheap to keep (it is tested), but should be deleted or its back-compat rationale re-verified against real external consumers | grep shows only `history.test.ts` calls it |

## 4 Deprecation & legacy

No `@deprecated` JSDoc markers or explicit "legacy"/"deprecated" designations exist anywhere in this scope (`grep -rn "@deprecated" packages/tui/src packages/session-web/src packages/session-web/webapp/src` — no hits). Two genuine back-compat surfaces exist and are load-bearing (not removable):

- `packages/tui/src/data/replay.ts:57-64` — `listReplayRuns(artifactDir, number | ListReplayRunsOptions)` accepts a bare `number` "for published-API callers predating `sourceFilter`." This is a public exported function (`index.ts`) with an unknown external consumer set — load-bearing, keep.
- `packages/session-web/webapp/src/lib/types.ts:207` / `packages/session-web/src/session-model.ts:38-40` — `WebInstance.timezone` mirrors `WebInstance.timeZone` "for clients that already probe `timezone`." Load-bearing back-compat spelling, cheap to keep.

## 5 Actionable steps

| ID | What | Why (premise/DoD link) | How | Effort | Acceptance-check | Freeze-blocking |
|---|---|---|---|---|---|---|
| A1-1 | Render `session_boundary` telemetry as a friendly cell in TUI replay-detail, mirroring `turn-presenter.ts`'s `sessionBoundaryNotice` | "Legible sessions" — the post-hoc debugging surface should show boundaries as legibly as live chat does | In `replay-detail.ts`'s `buildDetailCell`, detect `session_boundary` (by `type`/`data.kind`/`data.type`, same detection as `sessionBoundaryNotice`) before falling through to `undefined`, and return a `NoticeCell` with the same compact label | S | New `replay-detail.test.ts` (or extend `replay-view.test.ts`) asserts a `session_boundary` item renders a friendly label, not raw JSON | n |
| A1-2 | Add `config.test.ts` + `pane.test.ts` unit tests for the TUI Config view/pane | Load-bearing "honest ops" surface (config preview) currently has 0 dedicated tests | Cover: redacted-field rendering, section/source annotation (`[env]`/`[json]`/`[default]`), refresh-on-instance-switch race guard, and the load-failure path | S | `config.ts`/`pane.ts` line coverage rises from 44.7%/14.28% to >80% | n |
| A1-3 | Remove (or find and document a real consumer for) `TuiAgentCancelledError`/`isTuiAgentCancelledError` | Dead public-API surface contradicts "lean, understandable core" | Delete the class + re-export if no real consumer is found; else document the intended host usage in the README | S | `grep` shows either a real consumer or the symbols are gone from `index.ts` | n |
| A1-4 | Fix or delete the stale `TUI_PACKAGE_VERSION` constant | Dead + factually wrong value undermines "honest ops" | Either wire it from `package.json` at build time and surface it via a `--version` flag / help overlay, or delete the file and export | S | `mono-agent-tui --version` (if added) prints the real installed version, or the dead export is gone | n |
| A2-1 | Add component-level render tests (React Testing Library or equivalent) for `App.tsx` and `ListView.tsx`, at minimum covering the conversation-day-group render path and the auth-error/token form | Load-bearing "legible sessions" rendering has zero component-level regression protection | Add `@testing-library/react` (or `@testing-library/preact`-style shallow harness) devDependency; add `App.test.tsx`/`ListView.test.tsx` mounting with fixture data | M | webapp coverage for `src/views/ListView.tsx` and `src/App.tsx` rises above 0%; at least one test asserts day-group headers + lane rendering from `buildConversationDayGroups` output | n |
| A2-2 | Add adversarial-input tests for `lib/markdown.ts`'s escape/format pipeline | The one `dangerouslySetInnerHTML` surface in the webapp has 7% coverage; regression-proof it before any future edit | Test `esc`/`mdInline`/`md` against inputs containing `<script>`, `"` inside link URLs, and unmatched markdown tokens; assert no unescaped `<`/`>` survives outside the intentionally-generated tags | S | `markdown.ts` coverage >80%; a test explicitly asserts an adversarial payload renders inert | n |
| A2-3 | Remove or clearly re-justify `listInstanceSessions` (session-web back-compat alias) | Dead production code (test-only caller) | Delete function + its test, or re-export from `index.ts` if it is meant as public back-compat API | S | grep shows either real usage/export or it's gone | n |
| A2-4 | Document (or reconsider) persisting the session-web auth token in `localStorage` | "Honest ops" — the README documents the auth model in detail but omits this persistence choice | Add a line to the README's auth section noting the token persists in `localStorage` until `clearAuthToken()`/manual clear, or switch to `sessionStorage`-only if the convenience tradeoff isn't wanted | S | README updated, or code changed and behavior documented | n |
| A1-5 | Add tests for TUI `bin/cli.ts`'s `loadResponder`/`exitWithError` (the `--responder` embedding path) | Third-party embedding is a documented public capability with no test evidence it works | Add fixture ESM modules (default-export responder, `createResponder` factory, malformed module) and assert `loadResponder` resolves/rejects correctly | S | `cli.ts` coverage rises from 55.55% to >85% | n |

## 6 Skill-worthy flags

- **New-feature parity between live and replay/detail rendering.** Twice in this scope, a new event/step kind got first-class friendly rendering on the *live* surface (turn-presenter.ts's `sessionBoundaryNotice`) while the *post-hoc* surface (replay-detail.ts) silently fell back to raw JSON for the same kind. Worth amending **pi-upstream-recon** or **verify-green** with a checklist item: "when adding rendering for a new `runtime_telemetry`/stream-event kind, grep for the existing handler in the sibling surface (`turn-presenter.ts` ↔ `replay-detail.ts` for tui; the equivalent step-kind switch in `session-web/webapp/src/views/DetailView.tsx`) and add matching treatment there too, not just live chat." Seed pattern: `grep -rn "session_boundary" packages/tui/src packages/session-web/webapp/src` as the reference case.
- **Pure-function-only testing leaves component render trees unverified.** This is a recurring shape across the webapp: logic is extracted into pure, well-tested helper functions (`list-model.ts`, the exported helpers atop `DetailView.tsx`/`InstancesView.tsx`), but the JSX component itself that consumes them is never rendered in a test. Worth amending **verify-green** (or a new lightweight "webapp-component-test" convention doc) to require at least a smoke-render test (mount + snapshot/assert-on-key-text) for any new top-level view component, not just its extracted pure functions. Seed command: `grep -rL "render(" packages/*/webapp/src/views/*.test.ts` to find view files with pure-function-only coverage.
- **Stale hardcoded version constants.** `TUI_PACKAGE_VERSION` drifted 11 minor versions from `package.json` because nothing enforces the "update manually" comment. Worth a **release-lockstep** amendment: grep for hand-authored `_VERSION`/`_PACKAGE_VERSION` string literals across packages during the version-bump step, or replace them with a build-time substitution from `package.json`.

## 7 Coverage note

Every non-test source file in scope was read in full:

**packages/tui/src/**
- `index.ts`
- `agent/history.ts`, `agent/responder.ts`
- `config/pane.ts`
- `data/instances.ts`, `data/replay.ts`
- `remote/client.ts`
- `runtime/start.ts`, `runtime/version.ts`
- `bin/cli.ts`, `bin/mono-agent-tui.ts`
- `ui/app.ts`
- `ui/turn-presenter.ts`
- `ui/format.ts`, `ui/theme.ts`
- `ui/views/chat.ts`, `ui/views/replay.ts`, `ui/views/replay-detail.ts`, `ui/views/config.ts`, `ui/views/picker.ts`
- `ui/components/event-list.ts`, `ui/components/status-bar.ts`, `ui/components/tool-panel.ts`, `ui/components/transcript-cells.ts`

**packages/tui/**
- `README.md`
- `package.json` (skimmed for version/scripts/deps)
- `src/__tests__/cli.test.ts` (skimmed, per methodology, to judge coverage adequacy of `bin/cli.ts`)

**packages/session-web/src/**
- `discovery.ts`
- `session-model.ts`
- `aggregator.ts` (full, read in sequential chunks)
- `history.ts`
- `live-client.ts`
- `server.ts`
- `index.ts`

**packages/session-web/**
- `README.md`
- `package.json`

**packages/session-web/webapp/src/**
- `App.tsx`
- `main.tsx`
- `styles.css`
- `views/list-model.ts`, `views/ListView.tsx` (full), `views/DetailView.tsx` (full), `views/InstancesView.tsx` (full)
- `lib/api.ts`, `lib/format.ts`, `lib/markdown.ts`, `lib/tokens.ts`, `lib/types.ts`, `lib/useIsMobile.ts`, `lib/store.ts`
- `lib/fixture.ts` (skimmed — bundled synthetic demo data, confirmed non-sensitive)

**packages/session-web/webapp/**
- `index.html`
- `vite.config.ts`
- `package.json`

Test coverage was measured directly rather than assumed:
- `pnpm --filter @mono-agent/tui exec vitest run --coverage` (14 test files, 187 tests, all passing; per-file breakdown quoted in findings)
- `pnpm --filter @mono-agent/session-web exec vitest run src/__tests__ --coverage` (5 test files, 64 tests, all passing; backend `src/` at 83.16% stmt)
- `cd packages/session-web/webapp && CI=true node_modules/.bin/vitest run --coverage` (6 test files, 81 tests, all passing; overall 44.03% stmt, per-file breakdown quoted in F2/F3)

Not read line-by-line (per methodology, tests are skimmed only to judge coverage adequacy, not audited): the remaining `packages/tui/src/__tests__/*.test.ts` files and `packages/session-web/src/__tests__/*.test.ts` / `packages/session-web/webapp/src/**/*.test.ts` files beyond what's needed to confirm the coverage-gap findings above (all were run for coverage numbers; several — `app-smoke.test.ts`, `turn-presenter.test.ts`, `cli.test.ts`, `DetailView.test.ts` — were also opened and partially read to verify specific claims).

No files named in the brief were missing from the repository.
