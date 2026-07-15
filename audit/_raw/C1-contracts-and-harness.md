# C1-contracts-and-harness — agent-contracts & agent-harness kernel

## 1 Verdict & maturity grade

**Grade: B.** Source-only territory (no live-instance access in scope), so no separate Framework-fit grade is given.

This is, line for line, the most carefully engineered code in the framework I could sample against the premise. `durable-history.ts` (2,007 lines) implements a genuinely hard problem — crash-safe, cross-process, atomic conversation history with provider-session epoch/dirty-fence recovery — with owner-only-file assertions, directory-identity re-checks around every syscall, and 75 tests including a 30-independent-Node-process stress test. `resilient-message-stream.ts` cleanly generalizes what used to be duplicated per-channel FSMs into one transport-agnostic class. `agent-contracts` itself is genuinely dependency-free and its channel contract (`channel.ts`) is exemplary adapter-neutral design — no channel name ever appears in it. The continuation-capability validation in `harness.ts` (loopback-only URLs, capability shape checks, MCP transport classification) is defense-in-depth done right, and the external-summary redaction path (`externalResponseSummary`/`cloneExternalSummaryValue`) is a deliberately paranoid guard against a `toJSON`-based data-exfiltration vector in a public extension seam.

The grade is not higher because the one thing the audit brief specifically asked me to hunt for — "adapter-local behavior leaking into contracts... look for subtler leakage" — is present, and it is not subtle once found: `harness.ts`'s `sessionContextBlock` decides whether the model is told a live human is on the other end of the conversation using a **hardcoded two-item allowlist of channel-id string prefixes** (`telegram:`, `slack:`), instead of the trigger-metadata signal the function sits three lines away from already using for the opposite question (F1). This silently misclassifies three already-shipped surfaces — WhatsApp, the TUI, and the OpenAI-API-compatible adapter — as non-interactive on every single turn, directly undermining "a lean core open to external plugins." Compounding it, the repo's own mechanical adapter-neutrality guard only scans `agent-contracts` for two of the wrong three literal substrings, so this class of leak has no CI net at all in `agent-harness` (F2). Beyond that headline pair, findings are minor: an inert `version` field in the settings-JSON helpers (F3), `harness.ts`'s 3,166-line/70-top-level-declaration size straining "understandable core" (F4), a stale README type reference (F5), and a truncation-boundary inconsistency in skill loading (F6).

## 2 Findings

**F1 — P1.** The harness's per-turn model-facing "are you talking to a live human" framing is decided by a hardcoded two-channel string-prefix allowlist, not a structural signal — misclassifying WhatsApp, the TUI, and the OpenAI-API adapter as non-interactive on every turn.
- `packages/agent-harness/src/harness.ts:2661-2681`:
  ```ts
  const baseId = conversationId.replace(/#\d{4}-\d{2}-\d{2}$/u, "");
  const deliverable = baseId.startsWith("telegram:") || baseId.startsWith("slack:");
  ...
  if (deliverable) {
    return [
      "You are handling an interactive push conversation. The host owns its exact channel and thread destination.",
  ```
  and the else branch:
  ```ts
  const base = "This is a request-driven run (scheduled, webhook, or API) with no interactive user attached to a deliverable push conversation. Do not invent or infer a callback destination.";
  ```
- I confirmed the three misses by grepping conversationId construction across the actual adapters that ship in this repo: `extras/whatsapp-adapter/src/adapter.ts:504` builds `` `whatsapp:${message.chatJid}` ``; `packages/openai-api-adapter/src/server.ts:709` falls back to `` `openai-api:${requestId}` ``; the TUI (`packages/operator-adapter/src/tui/server.ts:207`) passes through whatever `body.conversationId` the operator console sent (not a `telegram:`/`slack:` id). None of these prefixes are in the allowlist, so a live, human-attended WhatsApp chat, an interactive Open WebUI session, or a live TUI operator turn all get told *"there is no interactive user attached to a deliverable push conversation"* — a false premise injected into the system prompt on every turn.
- The function already has the correct, general signal three lines below in the same file and does not use it for this decision: `notifyDeliveryGuidance` (line 2695) derives "this is a trigger run" from `metadata.cron`/`metadata.webhook` presence, which is exactly the inverse of "is a human attached" and would classify WhatsApp/TUI/OpenAI-API turns correctly without naming any channel.
- Test coverage locks in the bug rather than catching it: `packages/agent-harness/src/__tests__/harness.test.ts:524-528` asserts the interactive framing only for a `telegram:` conversationId, and `harness.test.ts:964-976` asserts the non-interactive framing for an arbitrary unprefixed id — there is no test anywhere in the suite for `whatsapp:`, `openai-api:`, or a TUI-shaped conversationId, so this misclassification is invisible to CI.
- **Why it matters**: violates the premise's "a lean, understandable core open to external plugins" directly — `channel.ts`'s own docstring uses `"discord"` as the textbook example of a third-party `ChannelId`, yet the harness kernel can only ever recognize two hardcoded first-party names, and even one of the two *first-party, currently-shipped* channels (WhatsApp) is already wrong today, not merely a future risk.

**F2 — P2.** The repo's own mechanical guard against exactly this class of leak has a scope gap that let F1 ship unnoticed.
- `scripts/check-package-architecture.mjs:152-160` is the only automated adapter-neutrality check in the repo:
  ```js
  const sharedContractDir = join(root, "packages", "agent-contracts");
  if (existsSync(sharedContractDir)) {
    for (const file of walkTextFiles(sharedContractDir)) {
      const text = readFileSync(file, "utf8").toLowerCase();
      if (text.includes("telegram") || text.includes("whatsapp")) {
  ```
  It scans **only** `packages/agent-contracts` (never `packages/agent-harness`, where F1 lives) and bans only the literal substrings `"telegram"`/`"whatsapp"` — not `"slack"`, which is also hardcoded in `harness.ts` (and, incidentally, `agent-contracts/src/tool-hints.ts:29` already contains the literal keyword `slack` inside a regex, unflagged because it's not one of the two banned words).
- **Why it matters**: the checklist artifact the review process relies on to keep this kernel "adapter-neutral" cannot catch a leak in the harness package at all, and would not catch a `"slack"` leak even inside the one package it does scan. This is a process gap, not just a code gap — see §6.

**F3 — P2.** `readSettingsJson`'s computed `version` (a sha-256 hash, presumably meant to support optimistic-concurrency writes) is dead weight: no caller anywhere in the monorepo ever reads it.
- `packages/agent-contracts/src/json-source.ts:28-34`:
  ```ts
  export interface ReadSettingsJsonResult {
    readonly json: SettingsJson;
    /** sha-256 of the parsed content, or empty string when the file is missing. */
    readonly version: string;
  ```
- `writeSettingsJson` (lines 60-82) performs an unconditional read-merge-write with no expected-version parameter and no compare-and-swap; `mergePatch` (line 84-87) always re-reads-then-merges the current on-disk state, so two concurrent writers (e.g. the TUI editing config while a `mono-agent config`/CLI process writes it) silently last-writer-wins with no detection.
- I grepped every consumer of `readSettingsJson`/`ReadSettingsJsonResult` across `packages/**/*.ts` (10+ call sites in channel adapters, `agent-app`, `@mono-agent/config`) — none references `.version`.
- **Why it matters**: either this is inert scaffolding that should be removed (simplification), or it is a half-built safety mechanism whose absence is a real "honest ops" gap for any multi-process config-writer scenario the framework's own recipes/onboarding could plausibly create (TUI + `mono-agent validate --recipe` running concurrently, for instance).

**F4 — P2 (legibility).** `harness.ts` is 3,166 lines / 70 top-level declarations — the audit brief's own focus question flags this, and on read-through it mixes at least five separable concerns in one file with no submodule boundary, unlike the rest of this same package.
- Turn orchestration (`run()`, ~650 lines), MCP request/continuation-context injection (`injectMcpRequestContext`/`injectMcpContinuationContext`/capability validation, ~350 lines), external-summary safe-cloning/redaction (`externalResponseSummary`/`cloneExternalSummaryValue`, ~150 lines), attachment persistence (`applyAttachments`/`describeAttachment`, ~150 lines), and turn-context event building (`buildTurnContextEvent`/`clampTurnContextText`, ~100 lines) all live as private methods/module functions in one file.
- The same package already has the right pattern next door: `context/`, `skills/`, and `tool-policy/` are each pulled into their own subdirectory with a barrel `index.ts` — `harness.ts` just never got the same treatment.
- **Why it matters**: "a lean, understandable core" is explicitly the premise's own yardstick; a 3,166-line file with 70 top-level declarations is the opposite of that for any maintainer trying to hold the whole turn lifecycle in their head, even though (as documented in F1's neighboring code) the invariants inside are individually well-reasoned.

**F5 — P3.** `agent-contracts/README.md` documents a Public-API type that does not exist in the source.
- `packages/agent-contracts/README.md:28`: `` - `AgentRequestMetadata`, `AgentResponseMetadata`, `AgentMessageStreamResult` ``
- `grep -rn "AgentMessageStreamResult" packages/agent-contracts/src` returns zero hits; the actual stream-result-shaped type is `AgentResponse`.
- **Why it matters**: minor, but directly undermines "a competent stranger must be able to understand the core" — a reader following the README's own Public API list to find this type will not find it.

**F6 — P3.** Skill-body truncation cuts at a raw byte offset without the UTF-8 code-point-boundary walk-back the same package already implements for an analogous truncation.
- `packages/agent-harness/src/skills/skills.ts:109-115`:
  ```ts
  const content = truncated
    ? `${buffer.subarray(0, maxBytes).toString("utf8")}\n<!-- truncated to first ${maxBytes} bytes -->`
    : markdown;
  ```
  slicing a `Buffer` at an arbitrary byte offset and calling `.toString("utf8")` can split a multi-byte character, which Node silently replaces with U+FFFD rather than erroring.
- Contrast with `packages/agent-harness/src/harness.ts:2956-2969` (`clampTurnContextText`), which walks back from the byte cap past any UTF-8 continuation byte specifically to avoid this.
- **Why it matters**: low impact (the truncation marker already tells the model the text was cut), but it is an avoidable inconsistency within the same package for the same class of "clamp text sent to the model" problem, and a maintainer fixing one is likely to miss the other.

## 3 Dead code

- **`createInMemoryHistoryStore` / `InMemoryConversationHistoryStore`** (`packages/agent-harness/src/history.ts`) — exported from the package's public API and documented in its README, but I found zero production callers: `packages/agent-app/src/configured-agent.ts:430` always defaults to `createDurableHistoryStore` unless a caller supplies its own `historyStore`, and no in-repo host ever supplies this one. It is exercised only by `history.test.ts`/`harness.test.ts`. **Not classified as dead code** — it is a plausible, intentional minimal reference implementation for a third-party embedder of `@mono-agent/agent-harness` who does not want file-based durability (directly serving the "lean core open to external plugins" premise), so disposition is **keep**, but worth a note in the README that no shipped host actually uses it, so a maintainer doesn't assume it is exercised end-to-end by this repo's own test suite.
- No other dead code found in scope. Every other exported symbol I spot-checked (`BufferedMessageStream`, `bearerTokensEqual`, `assertSafeBind`, `createLiveEventBus`, `classifyContinuationMcpServerTransport`, `AgentHarnessTurnHistoryEnricher`, `runtimeForModel`, `skillDisclosure`, `continuationContext`) has a live consumer in `agent-app` or an adapter package. No TODO/FIXME/HACK/XXX markers exist anywhere in the 41 in-scope source files (`grep` returned zero hits).

## 4 Deprecation & legacy

- **`LEGACY_STORE_VERSION`/`LEGACY_CONVERSATION_LOCK_PATTERN`/legacy dirty-fence v1 shape** (`packages/agent-harness/src/durable-history.ts:16, 36, 1610-1611, 1825-1858`) — active, tested migration/back-compat paths for pre-v2 on-disk history files and pre-shard-table per-conversation lock files. **Load-bearing.** Removing them would break upgrade-in-place for any existing deployment; keep until a documented store-format deprecation cycle.
- **`MemoryStore.appendHostSummary`/`scheduleCapture` legacy pair** (`packages/agent-contracts/src/memory.ts:56-67`, consumed at `packages/agent-harness/src/harness.ts:1673-1680`) — superseded by the strong `persistCompletedTurn` write, but explicitly retained "for stores that do not implement it." **Load-bearing** — this is the compatibility seam for any third-party `MemoryStore` plugin (e.g. `@mono-agent/memory-supermemory`) that predates the strong-write contract.
- **`ConversationHistoryStore.prepareAppend`/`beginProviderSessionTurn` as optional methods** (`packages/agent-harness/src/types.ts:56-75`) — "Stores that omit it keep the legacy append contract." **Load-bearing** — this is the plugin seam for a custom `ConversationHistoryStore`; a third-party implementer is not required to support crash-safe provider-session coordination.
- **`skillDisclosure: "full"` (default) vs `"index"`** (`packages/agent-harness/src/types.ts:336-342`) — `"full"` is described as preserving "legacy" up-front skill-body inlining, but it is still the *default* behavior, not a deprecated path being phased out. Not classified as legacy-for-removal; it is a first-class, currently-default option.
- No `@deprecated`-tagged symbol exists anywhere in either package's scope (`grep` returned zero hits).

## 5 Actionable steps

| ID | What | Why (premise/DoD link) | How | Effort | Acceptance-check | Freeze-blocking |
| --- | --- | --- | --- | --- | --- | --- |
| C1-1 | Replace `sessionContextBlock`'s hardcoded `telegram:`/`slack:` prefix allowlist with a structural signal | F1 — correctness bug hitting 3 shipped surfaces (WhatsApp, TUI, OpenAI-API) every turn; directly contradicts "lean core open to external plugins" | Derive the "interactive push conversation" branch as the *inverse* of the trigger-metadata check `notifyDeliveryGuidance` already uses (`!isRecord(metadata?.cron) && !isRecord(metadata?.webhook)`), or add an explicit `AgentHarnessRequest.interactive?: boolean` set by the responder/channel driver at the contract level so the harness never guesses from conversationId shape | M | A `whatsapp:`, `openai-api:`, or TUI-shaped conversationId gets the "interactive push conversation" framing in a new unit test; existing telegram/slack/cron/webhook tests stay green | y |
| C1-2 | Extend `check-package-architecture.mjs`'s adapter-neutrality scan to cover `packages/agent-harness/src` and every shipped `ChannelId`, not just `telegram`/`whatsapp` in `agent-contracts` | F2 — the process gap that let F1 ship; premise's "lean core" needs a working guard, not just a narrow one | Add `packages/agent-harness` to `sharedContractDir`-style scanning (excluding `__tests__`), and source the banned-word list from the actual shipped channel ids (telegram/slack/whatsapp/…) instead of two hardcoded literals | S | Re-introducing a hardcoded channel-prefix check in either package fails `pnpm check:architecture` | n |
| C1-3 | Wire `ReadSettingsJsonResult.version` into an optimistic-concurrency guard in `writeSettingsJson`, or remove the unused field/sha256 computation | F3 — inert scaffolding vs. an unaddressed concurrent-config-write race | Add an optional `expectedVersion` param to `writeSettingsJson` that rejects with a typed error on mismatch, and have the one realistic multi-writer caller (TUI config editor) pass it; otherwise delete `version`/`sha256()` | S | A test writes with a stale `expectedVersion` and gets a rejection instead of a silently lost update (or the field is gone and no caller references it) | n |
| C1-4 | Split `harness.ts` into cohesive submodules mirroring the `context/`/`skills/`/`tool-policy/` pattern | F4 — 3,166 LOC / 70 top-level declarations strains "understandable core" | Extract MCP request/continuation-context injection, external-summary redaction, attachment persistence, and turn-context event building into their own files under a new `harness/` subdirectory with a barrel; keep `run()` orchestration as the thin remainder | M | `harness.ts` (or its replacement orchestration file) drops well under 1,000 LOC; all existing tests pass unchanged | n |
| C1-5 | Remove the stale `AgentMessageStreamResult` reference from `agent-contracts/README.md`'s Public API list | F5 — doc/code drift | Delete the phantom type name from the README (or add the type if one was actually intended) | S | README's Public API list contains only symbols that exist in `src/index.ts`'s exports | n |
| C1-6 | Fix `loadSkillBody`'s truncation to walk back to a UTF-8 code-point boundary | F6 — truncation-boundary inconsistency vs. `clampTurnContextText` in the same package | Extract/reuse a shared byte-boundary-safe truncation helper and use it in `skills.ts` | S | A skill body truncated mid multi-byte character no longer contains a U+FFFD replacement char in tests | n |

## 6 Skill-worthy flags

- **Adapter-neutrality guard is too narrow to do its job (see F2).** The recurring failure mode here is: a mechanical check exists, but its scope (one package) and its banned-word list (two hardcoded literals) were never updated as new channels (WhatsApp → `extras/`, OpenAI-API adapter, the TUI) were added to the framework. Amend **new-package** (and/or **verify-green**) so that adding any new channel/adapter requires a standing check of the *entire* core surface — `packages/agent-contracts/src` **and** `packages/agent-harness/src` — for hardcoded references to any shipped `ChannelId`, e.g. a command like `grep -riE "\\b(telegram|whatsapp|slack|discord)\\b" packages/agent-contracts/src packages/agent-harness/src --include=*.ts | grep -v __tests__` run as part of the architecture check, sourced from the actual channel catalog rather than a fixed literal list.
- **Cross-cutting "does the harness correctly classify this channel" check is easy to silently skip when adding a channel.** When a new interactive channel/adapter is added (the **new-package** skill's territory), the harness's per-turn model-facing guidance (`sessionContextBlock` and any sibling logic keyed off conversationId shape) is exactly the kind of contract that's easy to get wrong because it lives on a string-prefix allowlist instead of a structural flag threaded through `AgentHarnessRequest`/`AgentRequestBase`. Worth a line item in **new-package**'s checklist: "if this channel produces interactive (human-attended) conversations, confirm the harness's session-context framing recognizes it — do not assume a hardcoded allowlist elsewhere already covers it."

## 7 Coverage note

All non-test source files in scope were read in full:

`packages/agent-contracts/src/`: `index.ts`, `channel.ts`, `config-loader.ts`, `host-safety.ts`, `memory.ts`, `stream-wire.ts`, `resilient-message-stream.ts`, `live-events.ts`, `tool-hints.ts`, `bearer.ts`, `coded-error.ts`, `buffered-message-stream.ts`, `stream-text.ts`, `json-source.ts`, `types.ts`.

`packages/agent-harness/src/`: `harness.ts` (full, read in sequential chunks covering all 3,166 lines), `durable-history.ts` (full, read in sequential chunks covering all 2,007 lines), `responder.ts`, `sessions.ts`, `live-session.ts`, `semaphore.ts`, `recorder.ts`, `mcp-server-transport.ts`, `history.ts`, `types.ts`, `index.ts`, `context/context-builder.ts`, `context/file-loader.ts`, `context/skill-index.ts`, `context/fs-paths.ts`, `context/json.ts`, `context/text.ts`, `context/errors.ts`, `context/types.ts`, `context/default-soul.ts`, `context/index.ts`, `skills/skills.ts`, `skills/skills-cache.ts`, `skills/index.ts`, `tool-policy/policy.ts`, `tool-policy/index.ts`.

Both READMEs: `packages/agent-contracts/README.md`, `packages/agent-harness/README.md`.

Test files were not read line-by-line but were enumerated, sized, and spot-checked for coverage adequacy (test counts, describe/it names, and targeted greps for specific behaviors under review — e.g. `sessionContextBlock`/"deliverable" framing in `harness.test.ts`): `agent-contracts/src/__tests__/{attachments,config-loader,contracts,foundations,host-safety,live-bus,resilient-message-stream,settings,stream-wire,tool-hints}.test.ts`; `agent-harness/src/__tests__/{durable-history,harness-attachments,harness-backpressure,harness-cancel-concurrency,harness-model-override,harness-proactive-isolation,harness-resilience,harness-run-config,harness-sessions,harness-skill-disclosure,harness-submit,harness-turn-context,harness,history,live-session,responder,semaphore,sessions,skills-public-api}.test.ts`; `agent-harness/src/context/__tests__/{context-builder,file-loader,skill-index}.test.ts`; `agent-harness/src/skills/__tests__/{skills-cache,skills}.test.ts`; `agent-harness/src/tool-policy/__tests__/policy.test.ts`.

Also read (out of scope, cited only as corroborating evidence for F2): `scripts/check-package-architecture.mjs`, `scripts/package-catalog.mjs` (grepped), and conversationId-construction sites in `packages/telegram-adapter/src/{bot,adapter}.ts`, `packages/slack-adapter/src/adapter.ts`, `extras/whatsapp-adapter/src/adapter.ts`, `packages/openai-api-adapter/src/server.ts`, `packages/operator-adapter/src/tui/server.ts`, and `packages/observability/src/run-source.ts`.

No named files in the SCOPE were missing.
