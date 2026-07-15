# 13 · tui & session-web operator surfaces

**Scope:** `packages/tui` (operator TUI: chat, replay, config views) and `packages/session-web` + `packages/session-web/webapp` (flight-recorder PWA: list/detail/instances views, markdown rendering, auth). **Maturity grade:** B+ (verifier-adjusted — grade unchanged; the sole severity change, F2 P1→P2, does not move the letter grade). Both packages are unusually well-engineered for a v1 — every non-obvious invariant (session-boundary rendering, live-fold vs. disk-artifact precedence, memory-health fail-closed normalization) is documented inline with rationale, and no dishonest fallback or fake-success path was found anywhere in scope. The grade is held at B+ rather than A- by a real, measured test-coverage gap in the webapp's React render trees and a small cluster of P3 dead-code/staleness items that a frozen codebase should not carry forward. Zero freeze-blockers were confirmed here (two-key rule; the verifier is the second key).

## Findings

**F1 — [P2] [verifier: CONFIRMED]** — `packages/tui/src/ui/views/replay-detail.ts:194-196`
Replay's post-hoc detail view degrades `session_boundary` telemetry to a raw JSON dump instead of a friendly cell. `buildDetailCell` special-cases only `runtime_warning` within the `"runtime"` category; every other runtime item (including `session_boundary`) falls through to `undefined` and renders via `buildRawPayloadBody`. The live chat surface (`turn-presenter.ts:143-172`, `sessionBoundaryNotice`) renders the *same* event kind as a compact "session boundary: rollover" notice and is fully tested (`turn-presenter.test.ts:191-260`); session-web's `DetailView.tsx` `"boundary"` step kind (lines 136-151, 881-898) also gets first-class friendly rendering. This is a real asymmetry between live and post-hoc surfaces on exactly the "legible sessions" DoD clause that matters most after the fact — when an operator is debugging a rollover.
> Verifier: "Verified `replay-detail.ts:194-196`... Real asymmetry; legible-sessions relevant."

**F2 — [P2, amended from P1] [verifier: AMENDED]** — `packages/session-web/webapp/src/views/ListView.tsx` (1092 lines, 0% statement coverage), `App.tsx` (301 lines, 0%), `DetailView.tsx` (1193 lines, 17.36%)
The webapp's actual React render trees are effectively untested; only extracted pure functions are. Measured directly (`vitest run --coverage`, CI=true): `ListView.tsx` 0%, `App.tsx` 0%, `DetailView.tsx` 17.36% (only exported pure helpers hit). No `@testing-library/react` (or any DOM-render helper) exists in the webapp's `package.json`, and `grep -c "render(" **/*.test.ts"` returns 0 across every webapp test file. Every `*.test.ts` alongside a view imports only the exported pure functions (`boundaryStepLabel`, `buildConversationDayGroups`, `buildInstanceCards`, …) and asserts on return values — never mounts the component, never exercises a click handler or the JSX itself. `App.tsx` (routing, auth-error/token-entry form, fixture-fallback status pill) has zero test coverage of any kind. For a frozen codebase, any future edit to `ListView.tsx`/`App.tsx` has zero regression protection beyond manual smoke testing.
> Verifier: "Proof holds... But this is a *regression-protection* gap, not a present defect — the render logic works today. P1 is reserved for shipped defects; a pure coverage gap on a working surface is P2." **Final severity: P2.**

**F3 — [P2] [verifier: CONFIRMED]** — `packages/session-web/webapp/src/lib/markdown.ts` (7.14% statement coverage)
The `dangerouslySetInnerHTML` markdown renderer (`md`, `mdInline`, and the `Markdown` component at lines 89-94) is almost entirely untested; only `esc()` gets indirect coverage via `format.test.ts`. This module hand-rolls markdown-to-HTML for arbitrary agent/tool output and injects it into the DOM. Manual review confirms escape-then-wrap ordering is correct (raw text is HTML-escaped before any markdown tag is added, so today this is **not** a live vulnerability) — but it is the single most safety-sensitive piece of code in the webapp with no regression test guarding that ordering against a future edit.
> Verifier: "`mdInline` does `let s = esc(input)` FIRST then applies tags... Escape-then-wrap order is correct → not a live vuln today (auditor agrees); finding is coverage-only. P2 justified by safety-sensitivity."

**F4 — [P3] [verifier: CONFIRMED]** — `packages/tui/src/agent/responder.ts:17-29`, re-exported `packages/tui/src/index.ts:8-11`
Dead code: `TuiAgentCancelledError`/`isTuiAgentCancelledError` are exported public API but never consumed anywhere in the monorepo. `chat.ts`'s cancellation checks use `isAgentResponseCancelledError` imported directly from `@mono-agent/agent-contracts`, never this tui-specific wrapper. `agent/responder.ts` is 0% covered.
> Verifier: "PROVEN — see dead-code table. Caveat: these are exported *public API*... 'dead' = zero internal/monorepo consumers. Keeping as intentional embedding-host surface is a valid alternative disposition."

**F5 — [P3] [verifier: CONFIRMED]** — `packages/tui/src/runtime/version.ts:6`
Stale, unused version constant: `TUI_PACKAGE_VERSION = "0.1.0"` (comment: "Updated manually when the package version changes") vs. the real `packages/tui/package.json` version `0.11.2` — 11 minor versions stale, and never read anywhere (no `--version` CLI flag, no help-overlay use).
> Verifier: "PROVEN — value `0.1.0` vs `package.json` `0.11.2` (verified). Only def + re-export, never read."

**F6 — [P2] [verifier: CONFIRMED]** — `packages/tui/src/ui/views/config.ts` (112 lines, 44.7% coverage) and `packages/tui/src/config/pane.ts` (44 lines, 14.28% coverage)
The Config view/pane — one of the TUI's four core views, the read-only preview of resolved, redacted configuration shared with the `mono-agent config` CLI command — has no dedicated test file (`ls __tests__/ | grep -i config` returns nothing). Its `refresh()` success path (redaction, section-building, source-annotation logic) is untested; this is directly load-bearing for the "legible... honest ops" premise clause, since it's where an operator checks what an agent is actually configured to do.
> Verifier: "`ls packages/tui/src/__tests__/ | grep -i config` → nothing. Honest-ops preview surface; coverage gap on a working surface. P2 defensible (borderline P3)."

**F7 — [P3] [verifier: CONFIRMED]** — `packages/session-web/src/history.ts:101-110`
Dead code: `listInstanceSessions`, documented as a "back-compat alias," has no production caller — the aggregator uses `listInstanceSessionSummaries`/`listInstanceSessionSummaryPage` directly, and the function is called only from its own test file. It is also not re-exported from `packages/session-web/src/index.ts`, so it isn't part of the declared public API either.
> Verifier: "PROVEN — `history.ts:105` def + only `history.test.ts` callers; NOT in `session-web/src/index.ts` (grep confirmed absent). Test-only."

**F8 — [P3] [verifier: CONFIRMED]** — `packages/session-web/webapp/src/lib/api.ts:307-322` (`saveAuthToken`), 268-305 (`currentAuthToken`)
Session-web's bearer auth token persists indefinitely in `localStorage` (in addition to `sessionStorage`), only cleared by an explicit `clearAuthToken()` call. For a read-only operator console this is a reasonable convenience tradeoff, but it widens the token's exposure window beyond the tab session and the README's security section doesn't mention the choice.
> Verifier: "Accepted per auditor's read of `api.ts:307-322`; honest-ops doc gap (README omits the persistence choice). P3 fine for a read-only Tailscale-node console."

**F9 — [P3] [verifier: CONFIRMED]** — `packages/tui/src/bin/cli.ts:101-136` (`loadResponder`, `exitWithError`)
The TUI's custom-host embedding path (`--responder`) is untested: 55.55% file coverage, lines 91-136 uncovered. `cli.test.ts` only tests `parseArgs`; the dynamic `import()` of a user-supplied ESM module and its `createResponder`/default-export resolution logic — the actual mechanism third-party embedding hosts rely on per the README's "Embedded" mode — has zero test coverage.
> Verifier: "Accepted; documented public capability with no test evidence."

No verifier NEW-# findings apply to this territory (C4-tui-session-web).

## Dead code & deprecation

**Proven dead (grep-proof confirmed by verifier):**

| Path | Why dead | Proof |
|---|---|---|
| `packages/tui/src/agent/responder.ts` (`TuiAgentCancelledError`, `isTuiAgentCancelledError`) | Exported from package's public API (`index.ts`) but never imported/consumed anywhere in the monorepo; `chat.ts` uses the base `agent-contracts` function directly | Verifier re-ran: `grep -rn "TuiAgentCancelledError\|isTuiAgentCancelledError" --include=*.ts packages extras demos scripts website` (excl. node_modules/dist) → 13 hits = def, re-export, and one independently-declared same-named class in an unrelated `agent-contracts` test file (not an import). No real consumer. |
| `packages/tui/src/runtime/version.ts` (`TUI_PACKAGE_VERSION`) | Hardcoded stale value (`0.1.0` vs actual `0.11.2`), never rendered anywhere | Verifier re-ran grep → only `version.ts:6` (def) + `index.ts:75` (re-export). Never read. |
| `packages/session-web/src/history.ts` (`listInstanceSessions`) | "Back-compat alias" with no production caller; not re-exported from `index.ts` | Verifier re-ran: `grep -rn "listInstanceSessions\b"` → def + `history.test.ts` only; absent from `index.ts`. |

No dead-code claim in this territory was refuted by the verifier — all three are proven dead. Caveat noted by the verifier for F4/`TuiAgentCancelledError`: these are exported public API, so "dead" means zero internal/monorepo consumers specifically; keeping them as an intentional embedding-host surface (with documentation) is a valid alternative to deletion.

**Suspected (unproven):** none — every dead-code claim raised in the raw audit for this territory was independently grep-verified by the adversarial pass.

**Load-bearing back-compat (NOT dead — do not delete):**

- `packages/tui/src/data/replay.ts:57-64` — `listReplayRuns(artifactDir, number | ListReplayRunsOptions)` accepts a bare `number` for published-API callers predating `sourceFilter`. Public exported function with an unknown external consumer set. Verifier: "CONFIRMED reasonable (both public, cheap, tested)."
- `packages/session-web/webapp/src/lib/types.ts:207` / `packages/session-web/src/session-model.ts:38-40` — `WebInstance.timezone` mirrors `WebInstance.timeZone` for clients that already probe `timezone`. Verifier: "CONFIRMED reasonable."

No `@deprecated` JSDoc markers or "legacy"/"deprecated" designations exist anywhere in this scope.

## Actionable steps

| ID | What | Why | How | Effort | Acceptance check | Freeze-blocking |
|---|---|---|---|---|---|---|
| A1-1 | Render `session_boundary` telemetry as a friendly cell in TUI replay-detail, mirroring `turn-presenter.ts`'s `sessionBoundaryNotice` | "Legible sessions" — the post-hoc debugging surface should show boundaries as legibly as live chat does | In `replay-detail.ts`'s `buildDetailCell`, detect `session_boundary` (by `type`/`data.kind`/`data.type`, same detection as `sessionBoundaryNotice`) before falling through to `undefined`, and return a `NoticeCell` with the same compact label | S | New `replay-detail.test.ts` (or extend `replay-view.test.ts`) asserts a `session_boundary` item renders a friendly label, not raw JSON | n |
| A1-2 | Add `config.test.ts` + `pane.test.ts` unit tests for the TUI Config view/pane | Load-bearing "honest ops" surface (config preview) currently has 0 dedicated tests | Cover: redacted-field rendering, section/source annotation (`[env]`/`[json]`/`[default]`), refresh-on-instance-switch race guard, and the load-failure path | S | `config.ts`/`pane.ts` line coverage rises from 44.7%/14.28% to >80% | n |
| A1-3 | Remove (or find and document a real consumer for) `TuiAgentCancelledError`/`isTuiAgentCancelledError` | Dead public-API surface contradicts "lean, understandable core" | Delete the class + re-export if no real consumer is found; else document the intended host usage in the README | S | `grep` shows either a real consumer or the symbols are gone from `index.ts` | n |
| A1-4 | Fix or delete the stale `TUI_PACKAGE_VERSION` constant | Dead + factually wrong value undermines "honest ops" | Either wire it from `package.json` at build time and surface it via a `--version` flag / help overlay, or delete the file and export | S | `mono-agent-tui --version` (if added) prints the real installed version, or the dead export is gone | n |
| A2-1 | Add component-level render tests (React Testing Library or equivalent) for `App.tsx` and `ListView.tsx`, at minimum covering the conversation-day-group render path and the auth-error/token form | Load-bearing "legible sessions" rendering has zero component-level regression protection | Add `@testing-library/react` (or equivalent shallow harness) devDependency; add `App.test.tsx`/`ListView.test.tsx` mounting with fixture data | M | Webapp coverage for `src/views/ListView.tsx` and `src/App.tsx` rises above 0%; at least one test asserts day-group headers + lane rendering from `buildConversationDayGroups` output | n |
| A2-2 | Add adversarial-input tests for `lib/markdown.ts`'s escape/format pipeline | The one `dangerouslySetInnerHTML` surface in the webapp has 7% coverage; regression-proof it before any future edit | Test `esc`/`mdInline`/`md` against inputs containing `<script>`, `"` inside link URLs, and unmatched markdown tokens; assert no unescaped `<`/`>` survives outside the intentionally-generated tags | S | `markdown.ts` coverage >80%; a test explicitly asserts an adversarial payload renders inert | n |
| A2-3 | Remove or clearly re-justify `listInstanceSessions` (session-web back-compat alias) | Dead production code (test-only caller) | Delete function + its test, or re-export from `index.ts` if it is meant as public back-compat API | S | grep shows either real usage/export or it's gone | n |
| A2-4 | Document (or reconsider) persisting the session-web auth token in `localStorage` | "Honest ops" — the README documents the auth model in detail but omits this persistence choice | Add a line to the README's auth section noting the token persists in `localStorage` until `clearAuthToken()`/manual clear, or switch to `sessionStorage`-only if the convenience tradeoff isn't wanted | S | README updated, or code changed and behavior documented | n |
| A1-5 | Add tests for TUI `bin/cli.ts`'s `loadResponder`/`exitWithError` (the `--responder` embedding path) | Third-party embedding is a documented public capability with no test evidence it works | Add fixture ESM modules (default-export responder, `createResponder` factory, malformed module) and assert `loadResponder` resolves/rejects correctly | S | `cli.ts` coverage rises from 55.55% to >85% | n |

All acceptance checks and the "how" text above were confirmed concrete by the verifier ("Actionable steps (C4): A1-1..A1-5 all concrete with real acceptance checks. No rewrites needed."). None were confirmed as freeze-blocking; this territory produced zero of the audit's three proposed (and all-rejected) freeze-blockers.

## Quarantine (refuted/unproven)

None. Every finding, severity call, and dead-code claim raised in the raw C4-tui-session-web audit was either CONFIRMED as-stated or AMENDED (F2 only, P1→P2) by the adversarial verifier; zero were refuted.
