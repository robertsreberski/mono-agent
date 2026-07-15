# C3-observability — @mono-agent/observability package

## 1 Verdict & maturity grade

**Grade: B+**

This is one of the most carefully engineered packages in the repo: path-traversal-safe file I/O, atomic writes, deterministic idempotent OTLP ids, a documented and tested `includeSensitiveData` gate that correctly withholds content by default, honest failure-kind/status derivation with no fake-success paths, and a genuinely fuzz-like test suite for the trace-source memory-health state machine (`trace-sources.test.ts`, 1004 lines). All 250 unit tests pass, `build`/`typecheck` are clean, and the `run-export-mapping`/`event-timeline` subpaths are verifiably node-free (asserted against the *built* artifact, not just source). The package is heavily consumed (agent-app, agent-harness, tui, session-web) and nothing traced back to it looked dead.

It loses a grade for two "honest ops" nuances directly implicated by this audit's focus questions — the JSONL recorder only persists events at `start()`/`finish()`, so a mid-run crash (the exact `process_death` scenario this package's own reconciler targets) leaves an artifact reporting `eventCount: 0`; and "redaction" is field-key-based only, so free-text values (user input, system prompt, tool output prose) are never scanned for embedded secrets even though several docs describe them as "redacted." Neither is a fabricated result or a shipped secret, but both are precision gaps in a package whose entire job is to be the trustworthy record of what happened — and the second is live today: the flagship `personal-agent` instance runs its Phoenix exporter with `includeSensitiveData: true`. A further, purely cosmetic gap: the package's own README "Public API" list omits roughly a third of what `index.ts` actually exports (including the 1028-line `session-mapping.ts`, the entire TUI/session-web replay substrate).

## 2 Findings

**F1 (P2 — should fix).** A run that crashes between `start()` and `finish()`/`fail()` loses its entire event trail; the persisted artifact reports `eventCount: 0` regardless of how much actually happened.
`packages/observability/src/recorder.ts:81-89`
```ts
onEvent(event: RuntimeEventLike): void {
  if (this.terminalPromise !== undefined) return;
  const redacted = redactJsonValue(event, this.maxStringBytes) as RuntimeEventLike;
  ...
  this.events.push(...)
```
`onEvent` only pushes into an in-memory array; the only two calls to `writeArtifacts` are inside `start()` (writes an empty `.events.jsonl` + `eventCount: 0`) and inside `commitTerminal()` (the terminal `finish`/`fail`, which serializes the full in-memory buffer). Nothing flushes in between. `reconcileStaleRunArtifacts` (`recorded-runs.ts:121-176`) exists specifically to reclaim runs whose process died mid-run (OOM/SIGKILL/crash) and rewrites their status to `interrupted`/`process_death` — but for exactly that run, the on-disk event trail is whatever `start()` wrote (empty), so the operator investigating a crash gets zero evidence of what the process was doing when it died. This is a known, partially-mitigated tradeoff — `packages/agent-app/src/broadcast-recorder.ts:22` explicitly notes "the on-disk recorder... flushes only at start/finish" and compensates with a live in-memory broadcast for the TUI/web PWA — but that mitigation only helps a client that is watching *live*; it does nothing for offline/post-mortem forensics of an unwatched crash, which is the scenario the process-death feature exists for.

**F2 (P2 — should fix).** Redaction is field-key-based only; free-text fields are never content-scanned for embedded secrets, and this is live today on the flagship instance with `includeSensitiveData: true`.
`packages/observability/src/redaction.ts:40`
```ts
if (key !== undefined && SENSITIVE_KEY_PATTERN.test(key) && typeof value !== "number") {
  return "[redacted]";
}
```
`redact()` only redacts when a JSON object *key* matches `/(token|secret|password|authorization|api[_-]?key|cookie)/iu`. Called on a bare string (no key), it falls straight to `truncateString` — there is no scan for secret-*shaped content* embedded in prose. `userInput`, the compiled `systemPrompt`, assistant message text, and tool-result text (e.g. a `Bash`/`Read` tool echoing a `.env` file or an API response containing a token inline) all pass through unredacted. `recorder.ts:67-68` and `:135-138` confirm the system prompt is only ever `truncateString`'d, never even passed through `redactJsonValue`. Verified live: `~/personal-agent/mono-agent.config.json` sets `"observability": {"exporters": [{"type": "phoenix", "includeSensitiveData": true, ...}]}` — meaning the flagship instance exports full user input, assistant replies, and system prompt to a separate Phoenix service (`otel/spans.ts:168-180`) with only this key-based redaction as a backstop. The 127.0.0.1 loopback endpoint limits network exposure, but the content still leaves the mono-agent process boundary into a different service's own storage/retention, and package/site docs (`docs/observability/phoenix-and-backfill.md:35`, out of this package's scope but describing this package's behavior) say the system prompt is exported "redacted," which overstates what actually happens for a flat string.

**F3 (P2 — should fix).** The package README's "Public API" list is missing a large fraction of what `index.ts` actually exports, including the entire session/TUI-replay substrate.
`packages/observability/README.md:37-48` vs `packages/observability/src/index.ts:1-168`. Exported-but-undocumented-in-README: `mapRunToSession` and the whole `Session*`/`SessionStep`/`SessionTurnContext` type family (`session-mapping.ts`, 1028 lines — the shared mapping consumed by both the TUI replay view and the session-web PWA), `segmentTimelineTurns` (`turn-segmentation.ts`), `summarizeRecordedRunMetrics` and its report types (`metrics.ts`, 306 lines), `describeRunFailureKind`/`KNOWN_RUN_FAILURE_KINDS` (`failure-kinds.ts`), `RUNS_HEALTH_STALE_RUNNING_MS`, `reconcileStaleRunArtifacts`, `deriveRunSource`, and `spanStatusFor`. All of these are real, consumed exports (confirmed via grep against `agent-app`, `agent-harness`, `tui`, `session-web`), not speculative surface — so this is a legibility gap, not dead code: a competent stranger reading the README would not discover that this package is the shared substrate for session replay and run-health/metrics reporting across three other packages.

**F4 (P3 — nice to have).** `writeJsonAtomic`'s per-attempt temp file is never swept if a write fails partway (e.g. `ENOSPC` during `writeFile`, or a process crash between `writeFile` and `rename`).
`packages/observability/src/artifact-fs.ts:91-96`. Each call mints a new `${filePath}.${pid}.${seq}.tmp`, so repeated failures accumulate orphaned `.tmp` files in the artifact directory with no sweep anywhere in this package. Low likelihood, low blast radius (a few stray files), but there is no cleanup path today.

**F5 (P3 — nice to have).** When a Phoenix exporter is composed, run events are buffered in memory three times over the run's lifetime with no shared cap: once in `JsonlRunRecorder.events` (`recorder.ts:41`), once in the composite recorder's own `events` buffer (`composite-recorder.ts:49`), and once again inside the Phoenix exporter's closure (`otel/phoenix-exporter.ts:65`). Each buffer is unbounded. In practice a "run" is one user turn (bounded to dozens–low hundreds of events per the package's own `TimelineTurn` doc comments), so this is not a live risk today, but the pattern is worth capping if event volume per run ever grows (e.g. very long agentic tool loops).

## 3 Dead code

None found. Every export traced from `index.ts` (including the less-obvious ones flagged in F3 — `mergeTraceSources`, `pruneTraceSources`, `reconcileStaleRunArtifacts`, `summarizeRecordedRunMetrics`, `describeRunFailureKind`/`KNOWN_RUN_FAILURE_KINDS`, `RUNS_HEALTH_STALE_RUNNING_MS`, `deriveRunSource`, `segmentTimelineTurns`, `mapRunToSession`) has at least one real, non-test consumer in `agent-app`, `agent-harness`, `tui`, or `session-web` (verified via repo-wide grep). `TraceSourceHandle.heartbeat()` has no explicit external caller (heartbeats fire only via the internal `heartbeatMs` timer registered inside `registerTraceSource`), but it is a reasonable, intentionally-exposed escape hatch on a small typed handle, not unreachable code — not flagged as dead.

## 4 Deprecation & legacy

None in scope. The only "legacy" language found is a docstring on `refineRunSource` (`session-mapping.ts:283`, "robust to legacy summaries that predate per-run source stamping") and the analogous comment on `deriveRunSource` (`run-source.ts:13-19`) — both are load-bearing backward-compatibility code for reading old on-disk summaries, not deprecated surface awaiting removal. No `@deprecated` markers exist anywhere in this package's source or README.

## 5 Actionable steps

| ID | What | Why (premise/DoD link) | How | Effort | Acceptance-check | Freeze-blocking |
|----|------|------|-----|--------|-------------------|------|
| A1-1 | Document the crash-mid-run event-loss limitation | "Honest ops" — operators debugging a `process_death` run should not be surprised the event trail is empty | Add a one-paragraph caveat to README's Trace Registry / recorder description and to `reconcileStaleRunArtifacts`'s docstring, stating events are only durable at start/finish and pointing at the live broadcast channel as the only real-time mitigation | S | README + docstring updated; no code change required | n |
| A1-2 | (Follow-up) Add a throttled incremental checkpoint write | Close the actual gap behind A1-1 so a crashed run keeps a partial event trail | In `JsonlRunRecorder.onEvent`, opportunistically re-run `writeArtifacts` at most every N events or T seconds (fire-and-forget, best-effort, never blocking the hot path) | M | New test: recorder crashes (never calls finish) after K events; re-reading the artifact dir shows a `running` summary with `eventCount > 0` and the events actually present | n |
| A2-1 | Correct "redacted" language for free-text fields in docs that describe this package's behavior | "Honest ops" — avoid operators believing key-based redaction scrubs secrets embedded in prose | Reword README + the out-of-scope site docs that call system prompt/user input export "redacted" to say "redacted object keys; free-text content is exported as-is when `includeSensitiveData: true`" | S | Docs no longer claim content-level secret scrubbing that doesn't exist | n |
| A2-2 | (Follow-up) Add lightweight content-pattern secret scanning as defense-in-depth | Reduce real leakage risk given the flagship instance runs `includeSensitiveData: true` | Extend `redactJsonValue`'s string branch with an opt-in pattern scan (common token prefixes: `sk-`, `ghp_`, `AKIA`, `xox[baprs]-`, etc.) redacting matches inside free text, independent of key name | M | New `redaction.test.ts` cases: a secret-shaped substring inside a plain string value is replaced; ordinary prose is untouched | n |
| A2-3 | Widen `SENSITIVE_KEY_PATTERN` | Current pattern misses `credential`, `private_key`, `client_secret`, `bearer`, `ssh_key`, `pem` | Extend the regex in `redaction.ts:12`; add matching test cases | S | `redaction.test.ts` covers the new key names | n |
| A3-1 | Sync README "Public API" list with `index.ts`'s real export set | Legibility — "a competent stranger must be able to understand the core"; the session-mapping/metrics/failure-kinds surface is currently invisible in the package's own docs | Add the missing exports (`mapRunToSession`+`Session*` types, `segmentTimelineTurns`, `summarizeRecordedRunMetrics`+report types, `describeRunFailureKind`/`KNOWN_RUN_FAILURE_KINDS`, `RUNS_HEALTH_STALE_RUNNING_MS`, `reconcileStaleRunArtifacts`, `deriveRunSource`, `spanStatusFor`) to the README bullet list, and the `./run-export` subpath section for `composeFailureDetail`/`renderFailoverHistory`/`normalizeFailoverHistory`/`buildEventSpans` | S | README bullet list superset-matches `index.ts`'s actual exports | n |
| A4-1 | Sweep orphaned atomic-write `.tmp` files | Cleanliness; avoids silent artifact-directory clutter after repeated write failures | On `registerTraceSource`/recorder init (or via the existing prune paths), glob and remove `*.tmp` files older than a short threshold | S | New test: a stray `.tmp` file older than the threshold is removed by the next prune/init call | n |
| A5-1 | Cap or stream the exporter-side event buffers | Avoid triple in-memory buffering growing unbounded if a single run ever accumulates very large event counts | Add a soft cap (mirroring `DEFAULT_MAX_EVENTS_PER_RUN`) to the composite recorder's and Phoenix exporter's buffers, dropping/warning past the cap rather than growing forever | M | New composite-recorder test: buffer growth is capped and a warning is emitted past the threshold | n |

## 6 Skill-worthy flags

- **docs-sync amendment**: the site docs (`docs/observability/*.md`) stayed current across many PRs, but the *package's own* `README.md` "Public API" list quietly fell behind as the package organically grew (session-mapping, metrics, failure-kinds, run-health, run-source were all added without a README bullet). Recurring pattern: a new named export lands in `src/index.ts` without a corresponding README update, because `docs-sync` today checks `docs/`/website content, not each package's own README against its own `index.ts`. Concrete seed for the skill: when a PR diff touches `packages/*/src/index.ts` (adds/removes an `export {...} from`), diff the touched package's `README.md` "Public API" section too, and flag if the new export name doesn't appear anywhere in the README.
- No other recurring process-shaped issues found in this territory — the redaction/crash-event-loss findings (F1/F2) are one-off engineering follow-ups, not process gaps that an existing or new skill would systematically prevent.

## 7 Coverage note

All non-test source files under `packages/observability/src/**` were read in full, plus `README.md`:

- `README.md`
- `src/index.ts`
- `src/types.ts`
- `src/recorder.ts`
- `src/redaction.ts`
- `src/guards.ts`
- `src/content.ts`
- `src/event-classify.ts`
- `src/event-timeline.ts`
- `src/turn-segmentation.ts`
- `src/failure-kinds.ts`
- `src/composite-recorder.ts`
- `src/metrics.ts`
- `src/artifact-scope.ts`
- `src/artifact-fs.ts`
- `src/artifact-audit.ts`
- `src/artifact-summaries.ts`
- `src/artifact-retention.ts`
- `src/summary-schema.ts`
- `src/recorded-runs.ts`
- `src/run-export-mapping.ts`
- `src/session-mapping.ts`
- `src/trace-sources.ts`
- `src/run-source.ts`
- `src/run-health.ts`
- `src/otel/index.ts`
- `src/otel/ids.ts`
- `src/otel/serialize.ts`
- `src/otel/spans.ts`
- `src/otel/transport.ts`
- `src/otel/phoenix-exporter.ts`

Test files skimmed for coverage adequacy (not line-by-line audited): `src/__tests__/redaction.test.ts`, `src/__tests__/recorder.test.ts`, `src/__tests__/composite-recorder.test.ts`, `src/__tests__/run-export-browser-safety.test.ts`, `src/__tests__/contracts.types.test.ts`, `src/__tests__/trace-sources.test.ts` (descriptions only), `src/otel/__tests__/spans.test.ts`; remaining test files (`artifact-fs`, `artifact-audit`, `artifact-retention`, `event-classify`, `event-timeline`, `turn-segmentation`, `failure-kinds`, `metrics`, `recorded-runs`, `run-export-mapping`, `session-mapping`, `trace-source-write-order`, `otel/__tests__/ids`, `otel/__tests__/transport`, `otel/__tests__/phoenix-exporter`) were confirmed present, sized, and passing (`pnpm --filter @mono-agent/observability run test` → 22 files / 250 tests, all green) but not opened individually, per the audit method's "skim only" instruction for test code.

Additional verification performed: `pnpm --filter @mono-agent/observability run build` and `run typecheck` both clean; re-ran the test suite after building to confirm `run-export-browser-safety.test.ts` executes its real assertion (not the not-yet-built skip path) against the actual `dist/run-export-mapping.js`, and independently grepped that built file for `node:`/`Buffer` references (none found). Cross-package export usage was verified via repo-wide grep (not full reads) of `packages/agent-app/src`, `packages/agent-harness/src`, `packages/tui/src`, `packages/session-web/src`. The live `~/personal-agent/mono-agent.config.json` was read (read-only) to verify the `includeSensitiveData: true` recon hint for F2; no live process, launchd state, or database was touched.
