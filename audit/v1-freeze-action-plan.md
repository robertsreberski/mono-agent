# v1-freeze action plan

The master, prioritized plan distilled from all 24 audit territories after adversarial verification. Full what/why/how/acceptance detail for every row: [`_raw/actions-consolidated.md`](_raw/actions-consolidated.md). Every action below is filed as a GitHub issue in the **`v1-freeze` milestone** (issue numbers in the last column; DUP = already owned by an existing open issue, cross-referenced instead of re-filed).

**The freeze path in one paragraph:** land the two Bucket-0 blockers (a license decision + a re-established 7-day fleet-green window), sweep Bucket 1 (59 mostly-S-effort hygiene items — a focused wave or two of goal loops), close epic #119, tag v1, and freeze. Bucket 2 (57 items) is the post-v1 backlog and does not gate anything.

## Bucket 0 — freeze blockers (2)

| ID | What | Effort | Sev | Issue |
|---|---|---|---|---|
| AUD-001 | Add root LICENSE + coherent per-package license fields (GPL-3.0 kernel is wrapped by UNLICENSED packages; ADR mislabels the project GPLv3). Requires a maintainer license **decision** first; the mechanical pass after is S. | S | P1 | #258 |
| AUD-002 | Achieve the 7-consecutive-day fleet-green window on the frozen build: pick the freeze sha → redeploy fleet → install the `fleet-green-check` LaunchAgent → 7 unattended green daily comments on #119. | M | P0 | #259 |

## Bucket 1 — pre-freeze hygiene & quick wins (59)

Ordered as in the consolidated table; effort is dominated by S items. Recommended slicing: **correctness first** (AUD-003…008), **honest-docs second** (AUD-009…020, 025…032), **dead-code third** (AUD-053…056), then the remainder.

| ID | What | Effort | Sev | Issue |
|---|---|---|---|---|
| AUD-003 | Fix harness `sessionContextBlock` hardcoded telegram/slack allowlist (WhatsApp misclassified; TUI cosmetic) | M | P1 | #260 |
| AUD-004 | Widen adapter-neutrality architecture guard to agent-harness + full channel catalog | S | P2 | #261 |
| AUD-005 | Validate telegram/slack advanced config blocks only after the `enabled` early-out | S | P1 | #262 |
| AUD-006 | Add fence tolerance to strict memory capture + request Ollama native JSON mode | M | P1 | #263 |
| AUD-007 | Doctor: bounded liveness probe for the Supermemory backend (no more `ok` from a shape check) | S | P1 | #264 |
| AUD-008 | Add direct tests for `preserveMcpServersUnderOverride` security boundary | S | P1 | #265 |
| AUD-009 | Fix glossary Consolidation/Salience entries to match actual non-decaying behavior | S | P1 | #266 |
| AUD-010 | Document `telegram.transcription` (setup page + env-vars reference) | S | P1 | #267 |
| AUD-011 | Document `slack.shortcuts` + `slack.homeTab` (prose + registry rows) | M | P1 | #268 |
| AUD-012 | Reconcile the bundled composer-skill references with feature-registry (≥7 missing features; rewrite playbook 6 to `notify:true`) | M | P1 | #269 |
| AUD-013 | Wire `verify:consumers` into CI | S | P1 | #270 |
| AUD-014 | Correct epic #119's stale "≤18 packages" DoD line (21 = 16+4+1 per catalog) | S | P1 | #271 |
| AUD-015 | Scope memory-preview FTS fallback so a bare TypeError isn't "embeddings unavailable" | S | P2 | #272 |
| AUD-016 | Correct observability "redacted" docs + widen `SENSITIVE_KEY_PATTERN` | S | P2 | #273 |
| AUD-017 | Document the crash-mid-run event-loss limitation | S | P2 | #274 |
| AUD-018 | Wire or explicitly document openai-api sampling params as inert | M | P2 | #275 |
| AUD-019 | Document the `ultra` effort → LOW thinking mapping caveat | S | P2 | #276 (rel #207) |
| AUD-020 | Rewrite `IDENTITY.example.md` to current memory tool names | S | P2 | #277 |
| AUD-021 | Adversarial-input tests for the webapp markdown escape pipeline | S | P2 | #278 |
| AUD-022 | Tests for operator `live/config.ts` incl. `redactLiveAdapterConfig` | S | P2 | #279 |
| AUD-023 | Real coverage for `readiness-probe-worker.ts` logic | M | P2 | #280 |
| AUD-024 | Post-listen bound-address recheck in webhook/tui/live adapters | M | P2 | #281 |
| AUD-025 | Correct cron-adapter README: overlap modes are programmatic-only; product pins skip | S | P2 | #282 |
| AUD-026 | Reconcile verify-all ↔ ci.yml as a documented superset relationship | S | P2 | #283 |
| AUD-027 | Remove the 3 redundant demo re-runs in ci.yml | S | P2 | #284 |
| AUD-028 | Name the two phantom gates as `check:*` scripts wired into repoGate | S | P2 | #285 |
| AUD-029 | validate-release: check root `@mono-agent/*` devDep pins | S | P2 | DUP #228 |
| AUD-030 | Widen env-vars-docs-parity test to every adapter prefix | M | P2 | #286 |
| AUD-031 | Fix 16 empty Starlight asides + CI check against recurrence | S | P2 | #287 |
| AUD-032 | Fix multi-agent playbook + reference code samples (await/fields/paths) | S | P2 | #288 |
| AUD-033 | Make `createMonoRuntime` sandbox injection unconditionally win | S | P2 | #289 |
| AUD-034 | Add a gitleaks rule for Telegram bot tokens + regression fixture | S | P2 | #290 |
| AUD-035 | Add dependency-vuln scanning to CI | S | P2 | #291 |
| AUD-036 | Sweep branches/worktrees + enable `delete_branch_on_merge` + skill cleanup step | M | P2 | #292 |
| AUD-037 | Fix implementer.md + #119 stale worktree paths | S | P2 | #293 |
| AUD-038 | Guard release-lockstep SKILL's hardcoded package counts | S | P3 | #294 |
| AUD-039 | Trim README Quickstart of deep-internals prose | M | P2 | #295 |
| AUD-040 | Cross-link #191 into sandbox-managed.ts doc comment | S | P2 | #296 (rel #191) |
| AUD-041 | Reconcile every package README/MIGRATION "Public API" list with real exports | M | P2 | #297 |
| AUD-042 | Fix non-codepoint-safe truncation (memory candidate text; skill body) | S | P3 | #298 |
| AUD-043 | Fix `firstFenceBody` unterminated-fence fallback | S | P3 | #299 |
| AUD-044 | Memory-rituals: use shared cron parser + doctor pre-flight for consolidation cron | S | P3 | #300 |
| AUD-045 | Wire `compactPostedMessageIndex` into a real call site | S | P2 | #301 |
| AUD-046 | launchd stdout/stderr rotation/size-cap (framework install + instances) | M | P2 | #302 |
| AUD-047 | Point personal-agent `bin/*` at the pinned runtime snapshot | M | P1 | #303 |
| AUD-048 | Make `sendNativeTelegramCard` honor quiet hours | S | P2 | #304 |
| AUD-049 | Root-cause the transcribe-mcp "missing trusted producing context" fatal | M | P2 | #305 |
| AUD-050 | chmod 600 the 644 live-instance .env/config files | S | P3 | #306 |
| AUD-051 | Document tokenEnv indirection for root dev configs | S | P3 | #307 |
| AUD-052 | Coverage for runs-health branches + Slack continuation wrapper | S | P2 | #308 |
| AUD-053 | Delete proven-dead exports in core packages (9 symbols) | S | P2 | #309 |
| AUD-054 | Delete proven-dead exports in the memory package (incl. deprecated store methods, vector-index API) | S | P2 | #310 |
| AUD-055 | Delete proven-dead exports in TUI/session-web/messaging adapters | S | P3 | #311 |
| AUD-056 | Delete dead files/dirs (a2a `cloneRecord`, baseline probe + fixtures, Jekyll scripts, 2 untracked dirs) | S | P3 | #312 |
| AUD-112 | Front-load the wizard's real wall-clock cost in --help/README | S | P3 | #313 |
| AUD-113 | Surface managed-runtime provenance (closure id) in doctor | S | P2 | #314 |
| AUD-114 | Fix `isContinuationStoreManifest` predicate + surface compacted/age fields | S | P3 | #315 |
| AUD-115 | O_NOFOLLOW guard on pi-oauth-login's auth.json write | S | P3 | #316 |
| AUD-116 | Guard rituals/scheduler `stop()` + fix empty-transports reload message | S | P3 | #317 |

## Bucket 2 — post-v1 (57)

Does not gate the freeze. Four rows here are DUPLICATEs of already-open issues (cross-referenced, not re-filed); the fifth DUP, AUD-029 → #228, sits in Bucket 1.

| ID | What | Effort | Sev | Issue |
|---|---|---|---|---|
| AUD-057 | Record proactive Telegram/Slack sends into destination history | M | P2 | DUP #201 |
| AUD-058 | Clear durable history on `restart --force` (or qualify message pre-freeze) | S | P2 | DUP #203 |
| AUD-059 | Constant-time non-BuJo replay guard | M | P2 | DUP #231 |
| AUD-060 | npm `--provenance` / OIDC trusted publishing | S | P3 | DUP #230 |
| AUD-061 | Set `minimumReleaseAge` or drop the inert exclude list | S | P3 | #318 |
| AUD-062 | TUI/session-web component + embedding coverage | M | P2 | #319 |
| AUD-063 | `deploy-cli.test.ts` for the demo deploy parser | S | P2 | #320 |
| AUD-064 | Render `session_boundary` friendly in TUI replay-detail | S | P2 | #321 |
| AUD-065 | Document/narrow session-web auth-token localStorage persistence | S | P3 | #322 |
| AUD-066 | Cap tool-call arg/result size in openai-api SSE | M | P2 | #323 |
| AUD-067 | Optional bearer auth for webhook-adapter | M | P3 | #324 |
| AUD-068 | Per-endpoint `maxRunMs` override in webhook-adapter | S | P3 | #325 |
| AUD-069 | Slack silent/quiet-hours notify parity | M | P3 | #326 |
| AUD-070 | Slack log-redaction analog (or documented rationale) | M | P3 | #327 |
| AUD-071 | Consolidate hand-rolled hardened FS/security primitives (2× write, 2× redaction, 4× lock) | L | P2 | #328 |
| AUD-072 | De-duplicate `isDeliverableConversation` into agent-contracts | M | P3 | #329 |
| AUD-073 | Decompose the 7 oversized single-file modules (cli.ts 4493 … harness.ts 3166) | L | P2 | #330 |
| AUD-074 | Config-reference type-fidelity test vs hand-written table | M | P2 | #331 |
| AUD-075 | Extract shared MemoryRecallSettings resolution (preview vs live) | S | P3 | #332 |
| AUD-076 | Deduplicate `MEMORY_LLM_ENV_KEYS` | S | P3 | #333 |
| AUD-077 | Decide + document the dormant best-effort capture subsystem | M | P2 | #334 |
| AUD-078 | Trim/rename the consolidate ritual's misleading result shape | S | P3 | #335 |
| AUD-079 | Design-rationale map for recall-evidence.ts | M | P3 | #336 |
| AUD-080 | Evaluate noUnusedLocals / unused-vars lint repo-wide | L | P3 | #337 |
| AUD-081 | Retire/reconcile the vestigial `about` MemoryEdgeKind | S | P3 | #338 |
| AUD-082 | Record the memory subsystem's threat-model rationale | S | P3 | #339 |
| AUD-083 | Point `rebuildFromMarkdown` docstring at the managed path | S | P3 | #340 |
| AUD-084 | Wrap embedding-provider timeout/network failures in MemorySearchError | S | P2 | #341 |
| AUD-085 | Apply `normalizeServiceRoot` to Ollama/OpenAI embedding endpoints | S | P3 | #342 |
| AUD-086 | Skip mkdirSync on read-only MemoryDb open | S | P3 | #343 |
| AUD-087 | Document/enforce the memory schema-evolution convention | S/M | P2 | #344 |
| AUD-088 | Throttled incremental checkpoint write in the run recorder | M | P2 | #345 |
| AUD-089 | Opt-in content-pattern secret scanning in observability redaction | M | P2 | #346 |
| AUD-090 | Sweep orphaned observability atomic-write .tmp files | S | P3 | #347 |
| AUD-091 | Cap the triple-held observability event buffers | M | P3 | #348 |
| AUD-092 | Reword vendored agent/index.js doc-comment (phantom consumers) | S | P3 | #349 |
| AUD-093 | Skip records-v2 + rollback-guard creation on fresh continuation stores (or close WAI) | S | P3 | #350 |
| AUD-094 | Verify/document `notifyFallbackConversationId` snapshot drift | M | P3 | #351 |
| AUD-095 | Cache the artifact-dir scan behind native-notify destination inference | S | P3 | #352 |
| AUD-096 | Register agent-orchestrator `res.on("close")` before handleRequest | S | P3 | #353 |
| AUD-097 | Document (or fix) whatsapp-adapter cross-chat serialization | S/M | P3 | #354 |
| AUD-098 | Bound SupermemoryStore.completedTurns map | S | P3 | #355 |
| AUD-099 | Telegram-polling-instability signal in the personal-agent watchdog | S | P2 | #356 |
| AUD-100 | Bind personal-agent openaiApi + session-web to the Tailscale IP | S | P3 | #357 |
| AUD-101 | Finish the heartbeat-prefilter retirement on personal-agent | S | P3 | #358 |
| AUD-102 | Clean up the stray `--limit/` wacli store | S | P3 | #359 |
| AUD-103 | Bounded retention for memory-forget backup snapshots | S | P3 | #360 |
| AUD-104 | Reduce entity-normalization noise in personal-agent memory | M | P3 | #361 |
| AUD-105 | Consecutive-crash circuit breaker for the a8c fleet plists | M | P2 | #362 |
| AUD-106 | Page/notify on a tripped breaker or overdue outbox item | S | P2 | #363 |
| AUD-107 | Record a soak-end date then delete the 3 retired a8c agent dirs | S | P3 | #364 |
| AUD-108 | Delete or document the empty a8c `legacy/` directory | S | P3 | #365 |
| AUD-109 | Derive the expected @mono-agent version from one place in the a8c fleet | S | P3 | #366 |
| AUD-110 | Surface real per-task activity in a8c `./bin/agents logs` | M | P3 | #367 |
| AUD-111 | Document whether Memory v2/BuJo targets fleet-scale shared knowledge | S | P3 | #368 |
| AUD-117 | Set removal timelines / sunset gates for deprecated surfaces | S | P3 | #369 |
| AUD-118 | Consolidate first-run + bujo atomic-publish into one primitive | L | P3 | #370 |

## Mapping to the 11 open issues

- **Owned by existing issues (cross-referenced, not re-filed):** #201→AUD-057, #203→AUD-058, #228→AUD-029, #230→AUD-060, #231→AUD-059.
- **Related but new work:** #207 (AUD-019 documents the `ultra` caveat), #191 (AUD-040 cross-links the tradeoff).
- **No surviving action:** #190 (pi metadata refresh), #226 (provenance portability — honestly disclosed, noted under AUD-060), #248 (repo-side shipped; open only for the external A8C fleet cutover), and epic #119 itself (closed by Bucket 0 + AUD-014's DoD text fix).

## After the freeze

Freeze means: Bucket 0 done, Bucket 1 swept, #119 closed with the 7-day evidence, v1 tagged. Bucket 2 and the three new engineering skills (see [agent-workflow-improvements.md](agent-workflow-improvements.md)) are the standing backlog for whenever development reopens — none of it should pull you back into build-mode during the freeze.
