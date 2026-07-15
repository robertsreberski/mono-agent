# A4-channels-io — agent-app channel wiring & proactive IO

## 1 Verdict & maturity grade

**Grade: B+**

This territory is the composition layer that turns adapter packages into running channels, plus the proactive-notify/interaction machinery that lets an agent push into Telegram/Slack. The code is unusually well-documented (nearly every non-obvious branch carries a "why" comment), the lazy-load gate (`isChannelConfigured`) is drift-guarded against the real adapter loaders, and the freshly-landed PR #256 fix (native-notify reply destinations) is a small, sound, well-tested change that reuses the existing Slack continuation `replyTo` plumbing rather than inventing a new mechanism. Security-sensitive paths (TOCTOU-hardened `TelegramSendFile` strict uploads, interaction-bridge bearer scoping, proxy-secret redaction) are handled with real rigor.

It loses half a grade for: one clearly dead maintenance routine (`compactPostedMessageIndex` is fully built, unit-tested, and never wired into any call path, so the JSONL index it exists to bound grows unboundedly), a confirmed-but-still-open upstream-tracked correctness gap (issue #201: proactive `TelegramSendMessage`/`SlackSendMessage` sends never become destination history), a real coverage gap on the Slack continuation wrapper's allowlist/error-mapping logic, and `channels.ts` growing to 1,551 lines mixing seven unrelated channel-driver factories with cron/webhook notification-delivery logic — a legibility concern against the "lean, understandable core" premise. None of these are freeze-blocking; all are concrete, fileable follow-ups.

## 2 Findings

**F1 — P2 — Dead maintenance routine leaves `posted-message-index.jsonl` unbounded.**
`packages/agent-app/src/posted-message-index.ts:128` (`compactPostedMessageIndex`) is fully implemented and unit-tested (`posted-message-index.test.ts` — round-trip, dedupe, no-op-below-cap) but is **never called** from any production path. `app.ts` only calls `resolvePostedMessageIndexPath`, `appendPostedMessage`, and `lookupProducingConversation` — never the compactor.
```
export async function compactPostedMessageIndex(
  indexPath: string,
  maxEntries: number = DEFAULT_COMPACT_MAX_ENTRIES,
```
Every `SlackSendMessage` tool call (agent-app's own adapter-send tool, `adapter-send-tools.ts:721`) appends a line to this file with no compaction ever triggered, so on a long-lived agent that uses the Slack send tool the index grows forever and `lookupProducingConversation`'s linear scan (`posted-message-index.ts:100-120`) gets slower with every entry. Contrast: `web-command.ts`/`tui-command.ts` both correctly call the analogous `pruneTraceSources` at a natural lifecycle point — the same pattern was simply never applied here. Premise: "honest ops" / "clean memory ... a way to preview it" implies bounded, self-maintaining local state.

**F2 — P2 — Proactive adapter-tool sends still are not recorded into destination conversation history (tracked upstream as #201, confirmed still open).**
`registerTelegramSendTool` (`adapter-send-tools.ts:755-791`) and `registerSlackSendTool` (`adapter-send-tools.ts:678-753`) both post directly through the adapter client and return a tool result — neither appends the delivered text as an assistant turn to the *destination* conversation's history. `SlackSendMessage` links posted messages back to the *producing* conversation via `appendPostedMessage` (so a reply resumes the producer), but the destination conversation's own history never gains the sent text. I confirmed this via `gh issue view 201` (open, P2, filed by the repo owner, with matching problem statement and scope notes) — the finding here independently reproduces the same gap from reading the source. Not a regression risk (native cron/webhook `notify:true` verbatim delivery *does* record history via a different path — `app.ts`'s `deliverVerbatim`/history flow), so this is scoped correctly to the model-visible tool path only, per the issue's own scope note.

**F3 — P2 — Slack driver's continuation allowlist + error-mapping wrapper has no direct unit test in agent-app.**
`createSlackChannelDriver`'s `synthesizeContinuation` (`channels.ts:475-542`) and `recordContinuationHistory` (`channels.ts:543-559`) enforce the channel allowlist and translate `SerialQueueFullError`/`AgentHarnessFailureError("history_boundary_not_found")` into structured `ContinuationChannelSynthesisResult`s before ever reaching the adapter. `packages/slack-adapter/src/__tests__/adapter.test.ts` tests the underlying adapter method; `app.test.ts` only stubs `synthesizeContinuation` as a mock in an unrelated flow. No test in `packages/agent-app/src/__tests__/` exercises this wrapper's allowlist rejection or either error-mapping branch. This is load-bearing security logic (a continuation reply target that bypassed the allowlist could post to a channel the operator never approved).

**F4 — P3 — `isDeliverableConversation` is duplicated verbatim in two packages.**
```
function isDeliverableConversation(conversationId: string): boolean {
  return conversationId.startsWith("telegram:") || conversationId.startsWith("slack:");
}
```
This exact function exists both at `channels.ts:1000-1002` (used by the webhook async-callback destination inference) and in `packages/webhook-adapter/src/server.ts` (added in the same PR #256 commit, used for the run's `replyTo` target). `proactive-notify.ts`'s `PUSH_CHANNEL_BY_SCHEME` encodes a related-but-not-identical scheme list (adds `whatsapp`). Three independent "which schemes are deliverable" lists across two packages is a drift risk: a future WhatsApp notify hook would need to be added in three places to stay consistent, and nothing enforces that today.

**F5 — P3 — `channels.ts` is 1,551 lines mixing seven channel-driver factories with cron/webhook notification-delivery logic and Telegram error-text formatting.**
The file contains `createTelegramChannelDriver`, `createSlackChannelDriver`, `createWebhookChannelDriver`, `createOpenAIApiChannelDriver`, `createTuiChannelDriver`, `createLiveChannelDriver`, `createCronChannelDriver`, plus ~250 lines of native-notify delivery/cooldown logic and ~100 lines of Telegram failure-text formatting, all in one module. Every individual driver is well-commented and the file is not hard to follow section-by-section, but "a competent stranger must be able to understand the core" (the audit yardstick) is harder to satisfy for a 1,551-line file than for one driver-per-file layout, especially since the adapter packages themselves (telegram-adapter, slack-adapter, etc.) already keep their own logic in dedicated files.

**F6 — P3 — `resolveNotifyDestinations` rescans the whole artifact directory on every native-notify resolution with no explicit destination.**
`notify-destinations.ts:44` → `seen-conversations.ts:34` (`listSeenNotifyDestinations`) reads every `*.summary.json` in the artifact dir and `stat`s up to 2,000 of them (batched at 64 concurrent) every time it runs. It is invoked once per completed cron/webhook run whose `notify:true` job/endpoint has no explicit `notifyConversationId` (via `resolveNativeCronNotifyDestination` / `resolveNativeWebhookNotifyDestination` in `channels.ts`), not just at channel start. On a long-lived, busy instance with a large artifact directory this is a real (bounded, but non-trivial) per-notification cost. Not a correctness bug — a performance/scale note.

**F7 — P3, PLAUSIBLE (not confirmed; needs the harness/continuation owner to verify) — `notifyFallbackConversationId` is snapshotted once at channel `start()`, while actual delivery is re-resolved dynamically per run; the two can drift.**
In PR #256 (`channels.ts:656-662` for webhook, `:1046-1052` for cron), `inferUniqueNotifyDestination` runs **once**, at channel `start()`, and its result is baked as a static `notifyFallbackConversationId` into every matching job/endpoint config forwarded to the cron/webhook adapter — which uses it to set the run's `replyTo` (continuation-registration target, per `cron-adapter/src/scheduler.ts`'s `toReplyTarget`). Meanwhile the *actual delivery* destination (`resolveNativeCronNotifyDestination` / `resolveNativeWebhookNotifyDestination`, `channels.ts:1199-1273` and `:1340-1370`) is recomputed **fresh, per completed run**, calling the same `listNotifyDestinations()` again. If the set of "seen" notify-capable conversations changes between channel start and a given run's completion (e.g. a second allowlisted chat starts talking to the bot after startup, making the "exactly one candidate" inference ambiguous going forward), the `replyTo` used for continuation-registration can point at a stale destination that no longer matches where the notification is actually delivered — the continuation would be registered under the old conversation while the message lands somewhere else (or delivery is skipped once the destination becomes ambiguous). This is a narrow edge case that only bites once a fixed single-user Telegram/Slack setup starts fielding a second deliverable conversation; I could not fully verify the downstream `replyTo` semantics inside `agent-harness/src/harness.ts` (out of this part's scope) so I report it as PLAUSIBLE rather than CONFIRMED.

## 3 Dead code

- `packages/agent-app/src/posted-message-index.ts:128` — `compactPostedMessageIndex`. Exported, unit-tested, never called from `app.ts`, `channels.ts`, `adapter-send-tools.ts`, or `index.ts` (verified via `grep -rl` across `packages/agent-app/src`, excluding tests). Proof: `grep -rln "compactPostedMessageIndex" packages/agent-app/src` returns only the definition file and its own test file. Proposed disposition: wire a call site (e.g. at channel start, mirroring `pruneTraceSources` in `web-command.ts`/`tui-command.ts`), or delete it if compaction is deliberately deferred — but leaving a tested-but-unwired safety valve is worse than either choice (see F1 and A4-1).

No other dead code found in this scope: every other exported function/type in the 18 in-scope files has at least one production call site (traced `channelIdForConversation`, `formatChannelFactValue`, `findTriggerOverrideIssues`, `issueProgressCapability`/`releaseRun`/`enrichAssistantHistory` — the last three are consumed indirectly through the `turnHistoryEnricher`/`progressCapabilityIssuer` typed interfaces in `agent-harness/src/harness.ts`, not directly from `app.ts`, which is why a naive grep of `app.ts` alone looks like a false positive; confirmed live via `packages/agent-harness/src/harness.ts:858,1616,1854-1856`).

## 4 Deprecation & legacy

No `@deprecated` markers or explicitly legacy-flagged code exist in this scope. The one legacy-adjacent surface is `LEGACY_TOOL_ALIASES` consumed by `adapter-send-tools.ts:1478-1480` (`legacyAliasesFor`) to keep pre-rename snake_case tool names (e.g. `telegram_send_photo`) matching the collapsed canonical `TelegramSendFile` tool in `allowedTools`/`disallowedTools`. This is load-bearing backward compatibility (per the init-wizard/PascalCase-rename history), not removable — it is what lets an operator's pre-rename config keep working. No action needed; it is doing its job.

## 5 Actionable steps

| ID | What | Why (premise/DoD link) | How | Effort | Acceptance-check | Freeze-blocking |
|---|---|---|---|---|---|---|
| A4-1 | Wire `compactPostedMessageIndex` into a real call site | "Honest ops / clean memory": a compaction routine that's built, tested, and never runs is a silent unbounded-growth bug on any live instance using `SlackSendMessage` | Call it from the Slack channel driver's `start()` (mirroring `pruneTraceSources` in `web-command.ts`), or from `appendPostedMessage`'s caller on a periodic/every-N-writes basis | S | A live Slack-tool-enabled agent's `posted-message-index.jsonl` stays ≤ `DEFAULT_COMPACT_MAX_ENTRIES` after sustained use; existing compaction unit tests keep passing | n |
| A4-2 | Land (or explicitly re-confirm scope of) GH #201 — record proactive `TelegramSendMessage`/`SlackSendMessage` sends into destination history | Continuity/"legible sessions": a user asking "what did you just send me?" in the destination chat gets a correct answer | Per issue's own "Desired behavior" section: a host-visible post-tool-result hook records delivered text as an assistant turn in the destination conversation, without double-recording ordinary replies/native notify/AskUser | M | New focused Telegram + Slack tests: proactive send → destination reply → replayed history contains the sent text; existing notify/AskUser/posted-message-index tests stay green | n |
| A4-3 | Add direct unit tests for the Slack driver's `synthesizeContinuation`/`recordContinuationHistory` allowlist + error-mapping wrapper | Load-bearing security logic (allowlist enforcement) with a real, findable coverage gap | New test file exercising `createSlackChannelDriver` directly: reject a non-allowlisted destination for both methods; assert `SerialQueueFullError`→`destination_queue_full` and `history_boundary_not_found`→`origin_history_not_ready` mappings | S | New tests fail on a reverted allowlist check and pass on current code | n |
| A4-4 | De-duplicate the "is this conversationId a deliverable push destination" predicate | DRY / drift risk across `channels.ts`, `webhook-adapter/server.ts`, and `proactive-notify.ts`'s `PUSH_CHANNEL_BY_SCHEME` | Extract one shared helper (e.g. into `@mono-agent/agent-contracts`) that all three consult; keep `whatsapp` explicitly excluded from the webhook/cron async-callback list with a comment referencing "no notify hook yet" | S | grep shows one definition, three call sites; existing tests for all three unaffected | n |
| A4-5 | Split `channels.ts` into one file per channel driver (+ a small `native-notify.ts` for the cron/webhook delivery helpers) | Legibility premise: "a lean, understandable core" is easier to audit as 7-8 focused files than one 1,551-line file | Mechanical extraction behind the existing `ChannelDriver`/export surface; no behavior change | M | `check:architecture` and full test suite stay green; `git diff --stat` shows only file moves + import path changes | n |
| A4-6 | Verify `notifyFallbackConversationId`'s start-time snapshot can't drift from the dynamically-resolved delivery destination | Correctness of the just-landed PR #256 fix under the multi-destination edge case | Either re-resolve the fallback per-run (not just once at start) or document why the snapshot is intentionally sticky | M | A test that adds a second seen/allowlisted destination mid-lifecycle and asserts `replyTo` and actual delivery destination always agree | n |
| A4-7 | Bound or cache the artifact-directory scan behind native-notify destination inference | Scale/perf note for busy long-lived instances | Cache `listSeenNotifyDestinations` results for a short TTL (mirroring the TUI's `LOCAL_MODEL_DISCOVERY_TTL_MS` pattern already used elsewhere in this same package), invalidated on new runs | S | Existing destination-inference tests stay correct; a synthetic large-artifact-dir benchmark shows reduced per-notification stat calls | n |

## 6 Skill-worthy flags

- **Dead-wiring after building a maintenance routine.** `compactPostedMessageIndex` (F1/A4-1) is a textbook instance of a recurring shape: a bounded-growth/compaction utility is designed, implemented, and unit-tested in isolation, but the PR never adds its call site into the actual runtime lifecycle — even though the *correct* pattern (`pruneTraceSources` called from `web-command.ts`/`tui-command.ts` at startup) already exists elsewhere in the very same package. Worth an amendment to **verify-green** (or **code-review**): when a diff adds an exported function whose name suggests periodic maintenance (`compact*`, `prune*`, `rotate*`, `gc*`), grep the touched package for at least one non-test call site before treating the PR as done. Command to seed it: `git diff --name-only | xargs grep -l "^export.*function.*\(compact\|prune\|rotate\|gc\)" ` then `grep -rl "<fnName>(" <package>/src | grep -v __tests__` must return more than the definition file.
- **Snapshot-vs-dynamic-resolution drift (F7).** When a fix introduces a value resolved once at a long-lived resource's start time (`inferUniqueNotifyDestination` in PR #256) that must stay consistent with the same computation re-run later at a different cadence, that's a recurring shape worth a **code-review** checklist line: "if this PR adds a `*Fallback*`/`*Cached*`/`*Snapshot*` value alongside an existing dynamic resolver of the same fact, add a test proving they can't disagree, or document why staleness is safe."

## 7 Coverage note

Read in full (production source, every line):
- `packages/agent-app/src/channels.ts`
- `packages/agent-app/src/channel-plugins.ts`
- `packages/agent-app/src/channel-gate.ts`
- `packages/agent-app/src/channel-config-view.ts`
- `packages/agent-app/src/channel-fact-format.ts`
- `packages/agent-app/src/adapter-send-tools.ts`
- `packages/agent-app/src/adapter-send-tools-main.ts`
- `packages/agent-app/src/adapter-send-proxy.ts`
- `packages/agent-app/src/interaction-bridge.ts`
- `packages/agent-app/src/broadcast-recorder.ts`
- `packages/agent-app/src/notify-destinations.ts`
- `packages/agent-app/src/proactive-notify.ts`
- `packages/agent-app/src/seen-conversations.ts`
- `packages/agent-app/src/posted-message-index.ts`
- `packages/agent-app/src/web-command.ts`
- `packages/agent-app/src/tui-command.ts`
- `packages/agent-app/src/supermemory-plugin.ts`
- `packages/agent-app/src/trigger-overrides.ts`

All 18 named in-scope files exist; none were missing.

Tests skimmed (not line-by-line audited) for coverage adequacy:
- `packages/agent-app/src/__tests__/channel-gate.test.ts` (read in full, ~100 lines, including the drift-guard test)
- `packages/agent-app/src/__tests__/channel-config-view.test.ts` (grep-level)
- `packages/agent-app/src/__tests__/channel-plugins.test.ts` (grep-level, 12 `it` blocks enumerated)
- `packages/agent-app/src/__tests__/channel-fact-format.test.ts` (grep-level)
- `packages/agent-app/src/__tests__/notify-allowlist.test.ts` (read relevant sections — confirms `notify` coverage for Telegram/Slack drivers but not `synthesizeContinuation`/`recordContinuationHistory`)
- `packages/agent-app/src/__tests__/proactive-notify.test.ts` (grep-level, 6 tests)
- `packages/agent-app/src/__tests__/seen-conversations.test.ts` (grep-level, 3 tests)
- `packages/agent-app/src/__tests__/posted-message-index.test.ts` (read `it` list in full — confirms compaction is tested but unwired)
- `packages/agent-app/src/__tests__/interaction-bridge.test.ts` (grep-level, 20 tests)
- `packages/agent-app/src/__tests__/adapter-send-tools.test.ts` (grep-level, 67 tests)
- `packages/agent-app/src/__tests__/cron-channel.test.ts`, `webhook-channel.test.ts`, `tui-channel.test.ts`, `live-channel.test.ts` (existence/scope confirmed, not read line-by-line)
- `packages/agent-app/src/__tests__/web-command.test.ts`, `tui-command.test.ts`, `supermemory-plugin.test.ts` (existence/scope confirmed)
- `packages/agent-app/src/__tests__/doctor.test.ts` (grepped for trigger-override integration coverage, lines 641/644)
- `packages/agent-app/src/__tests__/app.test.ts` (grepped for `synthesizeContinuation`/`createTelegramChannelDriver`/`createSlackChannelDriver` usage)
- `packages/slack-adapter/src/__tests__/adapter.test.ts` (grepped only to confirm where `synthesizeContinuation` is unit-tested at the adapter layer, out of this part's direct scope)

External verification performed:
- `gh issue view 201` — confirmed open, P2, matches the independently-derived F2 finding.
- `git show 218ec3bd` (PR #256, "fix: preserve native notify reply destinations") — read the full diff across `channels.ts`, `cron-adapter/scheduler.ts`, `webhook-adapter/server.ts`, and the touched test files to verify the fix's soundness (F7 raised from reading this diff carefully).
- Grepped `agent-harness/src/harness.ts` and `agent-contracts/src` for `replyTo`/`turnHistoryEnricher`/`progressCapabilityIssuer` usage to confirm `interaction-bridge.ts`'s exports are consumed (not dead) despite no direct `app.ts` call-site match.

Not read (explicitly out of this part's scope, cross-referenced only): `packages/agent-app/src/app.ts`, `agent-harness/src/harness.ts` internals beyond the grepped call sites, and the Telegram/Slack adapter packages themselves (owned by C5) — the recon hint's "continuous Telegram getUpdates timeout restart loop" concern was checked only at the wiring boundary: `channels.ts`'s `telegramStartOptions` `onPollingError`/`onPollingRecovered` handlers are correctly edge-triggered (a `pollingDegraded` boolean prevents duplicate degrade/recover calls for a flapping connection) and do not themselves loop or restart anything — the restart mechanism, if any, lives inside `@mono-agent/telegram-adapter`'s own polling runner, which is C5's territory and was not re-audited here to avoid duplication.
