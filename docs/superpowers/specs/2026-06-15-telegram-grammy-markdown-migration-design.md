# Telegram: grammY comms + `telegramify-markdown` formatting — design

- **Date:** 2026-06-15
- **Branch / worktree:** `worktree-telegram-grammy-markdown`
- **Package:** `@mono-agent/telegram-adapter` (+ `@mono-agent/agent-app` wiring)
- **Status:** Proposed — awaiting review

## 1. Problem & root cause (confirmed by evidence)

Final answers arrive in Telegram showing **literal markdown** (`**bold**`, `` `code` ``, raw
tables) instead of rendered formatting.

The adapter already ships a hand-rolled Markdown→Telegram-HTML converter
(`telegram-html.ts`, commit #12) and applies it to the final answer with a
plain-text fallback. Running the **real** converter against realistic LLM output
shows the fallback is the symptom source:

| Input | `renderTelegramHtml` output | Result |
|---|---|---|
| `**bold**`, `**X**: text`, inline code | correct | ✅ |
| Markdown table | raw `\| … \|` (no table support) | ❌ raw markdown shown |
| Link with `()` in URL (Wikipedia) | `href="…Foo_(bar"` + stray `)` | ❌ broken link |
| Overlapping emphasis `**a _b** c_` | `<b>a <i>b</b> c</i>` (overlap) | ❌ **invalid HTML → Telegram rejects → fallback re-sends raw markdown** |
| Multi-line bold | raw `**…**` (split before parse) | ❌ raw markdown shown |

The `deliverText` recovery path re-sends the **original markdown verbatim** as
plain text whenever the generated HTML is rejected:

```ts
if (outcome.kind === "reformat_plain" && useHtml) {
  useHtml = false;
  renderedText = normalizedSource; // ← raw markdown
  continue;
}
```

**Root cause:** a regex converter that is both incomplete (tables, nested/task
lists, multi-line emphasis) and able to emit invalid markup. This is a whole
*class* of bug that regex patching cannot durably close.

## 2. Goal & locked decisions

Replace the hand-rolled formatting **and** comms layer with maintained libraries.
Decisions confirmed with the user:

1. **grammY adoption depth:** *full idiomatic middleware rewrite* — auth, commands,
   and dispatch become grammY middleware (not the hand-rolled `handleUpdate`).
2. **Concurrency:** *concurrent polling via `@grammyjs/runner`* — cross-chat
   concurrency, with a reachable "busy" reply when a second message arrives for a
   chat mid-run.
3. **Errors:** grammY errors are mapped onto the existing `TelegramApiError` shape
   so the streaming/retry/classification logic and its tests stay intact.
4. **Formatting:** only the **final** answer is rendered to MarkdownV2 via
   `telegramify-markdown`; interim streaming stays plain text. Raw-text fallback
   retained as a safety net.

### Concurrency nuance (explicit)

True per-chat `sequentialize` and a *reachable* "busy" reply are mutually
exclusive: `sequentialize` would queue the second message behind the (long) agent
run rather than reject it. Since "busy reachable" is the chosen goal, the long run
is **not** sequentialized. Instead a per-chat `activeRuns` guard is set
**synchronously at handler entry** (before any `await`), so a concurrent
same-chat update sees the in-flight run and gets the busy reply. The runner
provides cross-chat concurrency.

## 3. Libraries (versions verified 2026-06-15)

| Package | Version | Role |
|---|---|---|
| `grammy` | 1.44.0 | Bot client (`bot.api`), context, error types |
| `@grammyjs/runner` | 2.0.3 | Concurrent long-polling runtime (`run`, handle `.stop()`) |
| `telegramify-markdown` | 1.3.3 | Markdown → Telegram **MarkdownV2** (remark-based) |

Not adopted: `@grammyjs/auto-retry` (our stream already owns retry/backoff;
adding it would double-wait). Rationale documented so it is a deliberate choice.

### Verified API shapes

- `Api.sendMessage(chat_id, text, other?, signal?)` → `Message`.
- `Api.editMessageText(chat_id, message_id, text, other?, signal?)` → `true | Message`.
  `other` carries `parse_mode: "MarkdownV2"`, `reply_parameters: { message_id }`,
  `link_preview_options`.
- `GrammyError` exposes `error_code`, `description`, `parameters.retry_after`;
  `HttpError` is the network failure type.
- `run(bot)` returns a handle with `.isRunning()` and `await .stop()`.

### `telegramify-markdown` behavior (verified against the failing battery)

Every failing case above produces **valid** MarkdownV2: parenthesized URLs
escaped (`…Foo_\(bar\)`), overlapping emphasis resolved, multi-line bold joined,
all MarkdownV2 reserved chars (`_ * [ ] ( ) ~ \` > # + - = | { } . !`) escaped.
Accepted minor lossiness: task-checkbox glyphs dropped, code-fence language hint
dropped, tables rendered as escaped pipe text. All output is valid → no raw leak.

## 4. Target architecture

grammY owns the **transport and update runtime**; the agent-facing **streaming
delivery** logic is preserved behind the existing `TelegramBotApi` seam.

| Concern | Today | After |
|---|---|---|
| HTTP transport | `TelegramBotApiClient` (`fetch`) | grammY `bot.api`, wrapped to satisfy `TelegramBotApi`, errors mapped to `TelegramApiError` |
| Update polling | `TelegramLongPoller` | `@grammyjs/runner` `run(bot)` |
| Routing/auth/commands | `TelegramAdapter.handleUpdate` | grammY middleware (auth filter, `bot.command`, `bot.on("message:text")`) |
| Busy guard | `activeRuns` map (effectively unreachable) | `activeRuns` map, now reachable under runner concurrency |
| Streaming/retry/split/cancel | `TelegramMessageStream` | **unchanged** (calls the seam) |
| Error classification | `classifyTelegramError` | **unchanged** (still sees `TelegramApiError`) |
| Markdown rendering | `telegram-html.ts` (HTML) | `telegramify-markdown` → `parse_mode: "MarkdownV2"` |

### Why keep the `TelegramBotApi` seam

`TelegramMessageStream` is the "bulletproof delivery" core (debounced edits,
in-flight serialization, retry honoring `retry_after`, message splitting,
cancellation). It depends only on `TelegramBotApi` + `TelegramApiError`. A grammY
client that satisfies that interface and maps `GrammyError`/`HttpError` →
`TelegramApiError` lets all of that logic — and its 17-test suite — survive the
migration unchanged. The seam shrinks to `sendMessage`/`editMessageText`
(`getUpdates`/`deleteWebhook` move into the runner's responsibility).

## 5. Component changes

### New
- `grammy-client.ts` — `createGrammyTelegramApi(bot: Bot): TelegramBotApi`.
  Implements `sendMessage`/`editMessageText` over `bot.api`, translating
  arguments (params object → positional + `other`) and errors
  (`GrammyError`/`HttpError`/abort → `TelegramApiError`).
- `bot.ts` — builds the grammY `Bot`, registers middleware
  (auth → commands → `message:text` run handler), and exposes `start`/`stop`
  driven by `@grammyjs/runner`. Holds the per-chat `activeRuns` map and busy
  guard. Replaces the routing half of `adapter.ts` and all of `long-poller.ts`.
- `telegram-markdown.ts` — thin wrapper around `telegramify-markdown`
  (`renderTelegramMarkdown(md): string`), isolating the dependency and its
  options (unsupported-tag strategy) behind one function the stream calls.

### Changed
- `message-stream.ts` — swap `renderTelegramHtml` → `renderTelegramMarkdown`;
  `parse_mode` `"HTML"` → `"MarkdownV2"`; rename the `formatHtml` option →
  `formatMarkdown`. The "rendered == source → skip parse_mode" shortcut is
  dropped (MarkdownV2 escaping nearly always changes the text); final delivery
  uses `parse_mode: "MarkdownV2"` and falls back to plain on parse rejection.
- `start.ts` — compose `bot.ts` + grammY client + runner; preserve the
  `startTelegramAdapter(options): Promise<{ stop }>` signature and its test seams
  (`clientFactory`/`pollerFactory` become a `botFactory`/`runnerFactory`).
- `index.ts` — update exports (drop `renderTelegramHtml`/`escapeTelegramHtml`,
  `TelegramBotApiClient`, `TelegramLongPoller`; add the new modules' public API).
- `agent-app/src/channels.ts` — build the grammY-backed driver; rename
  `formatHtml: true` → `formatMarkdown: true`; keep `overrides` test seams.

### Removed
- `telegram-html.ts` + `telegram-html.test.ts`
- `telegram-client.ts` (the `fetch` client) — `TelegramApiError` is **retained**
  (moved to its own module, e.g. `telegram-error.ts`) because the stream and
  classification depend on it.
- `long-poller.ts` + `long-poller.test.ts`

## 6. Error mapping (`grammy-client.ts`)

| grammY throw | → `TelegramApiError` |
|---|---|
| `GrammyError` | `kind: "telegram"`, `errorCode = error_code`, `telegramDescription = description`, `retryAfterMs = parameters.retry_after * 1000` (when present) |
| `HttpError` | `kind: "network"` |
| `AbortError` (signal) | `kind: "aborted"` |
| other | `kind: "network"` (conservative retry) |

This preserves every branch of `classifyTelegramError` (`not_modified`,
`recreate`, `reformat_plain`, `retry`, `fatal`) without change.

## 7. Config & public API impact

- Stream option `formatHtml` → `formatMarkdown` (rename; semantics: render final
  answer as MarkdownV2). `agent-app` sets `formatMarkdown: true`.
- `@mono-agent/telegram-adapter` package exports change (removed client/poller/
  html helpers; added grammY client + bot builder). This is a breaking change to
  that package's surface — acceptable inside the monorepo; `agent-app` is the only
  internal consumer and is updated in the same change.
- No user-facing config-file changes (`telegram.botToken/allowedChatIds/
  allowAllChats/enabled` unchanged). New deps added to the package.json.

## 8. Risks & mitigations

- **Behavioral parity of dispatch rewrite.** The hand-rolled `handleUpdate` has 13
  tests encoding auth/command/busy/cancel/error semantics. Mitigation: port those
  as grammY middleware tests (drive a fake/`Bot` with crafted updates) and keep
  the same observable outcomes (welcome/help/busy/unauthorized/cancel/error copy).
- **Runner lifecycle in tests.** Mitigation: inject the bot + a fake runner via
  factory seams; assert wiring and clean stop without real network.
- **Chunk split mid-markdown** (e.g. across a code fence) can still yield imperfect
  MarkdownV2 — pre-existing with HTML, degrades more gracefully now. Out of scope.
- **Double-retry** if `auto-retry` were added — avoided by not using it.
- **`reply_to_message_id` deprecation** — use `reply_parameters: { message_id }`.

## 9. Testing strategy (TDD)

1. **Red first — formatting:** add `telegram-markdown.test.ts` asserting the four
   evidenced failure cases now produce valid MarkdownV2 (table, parens-URL,
   overlapping emphasis, multi-line bold) plus the common cases. Confirm they fail
   before the swap.
2. **Preserve:** `message-stream.test.ts` (17) and the relevant `adapter`
   behavioral expectations stay green via the seam + error mapping. Update only
   the `parse_mode`/option-name assertions.
3. **Replace:** delete `telegram-client`/`long-poller` tests; add
   `grammy-client.test.ts` (error mapping + arg translation, fake `bot.api`) and a
   `bot.test.ts` middleware suite (auth/commands/busy/cancel/error, fake runner).
4. **Integration:** `start.test.ts` updated to assert grammY bot + runner wiring
   and clean stop.
5. **Whole-package + agent-app:** `pnpm --filter @mono-agent/telegram-adapter test`
   and `pnpm --filter @mono-agent/agent-app test`, plus `typecheck` and
   `check:architecture`.

## 10. Out of scope

- Formatting interim/streaming updates (kept plain text).
- Markdown-aware chunk splitting.
- Webhook transport (polling only, as today).
- Task-checkbox / code-fence-language fidelity beyond what telegramify provides.
