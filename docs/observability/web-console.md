---
title: "Always-on web console"
description: "Run and secure the persistent assistant-ui console for local-agent discovery, threads, attachments, notifications, and live turns."
sidebar:
  order: 5
---

`mono-agent web` is the browser operator console for every running agent discovered on this computer. It is a separate `@mono-agent/web` application built on assistant-ui's External Store Runtime and native Thread, ThreadList, Message, Composer, Attachment, GroupedParts, and ToolFallback primitives, with the assistant-ui Reasoning disclosure adapted for structured runtime parts. The service owns conversations and in-flight turns, so refreshing or closing a browser tab does not abort work.

This is the chat-first companion to [`mono-agent tui`](/observability/tui/). The former `mono-agent sessions` read-only run browser [was removed](#session-recorder-removed); recorded-run replay now lives in `mono-agent tui`.

The web service does not run the terminal UI. Both consoles discover and connect to each agent's `metadata.channels.tui.baseUrl`, whose default path is `/gui`; they merely share the same bidirectional operator protocol.

## Start it once

On macOS, install and start the managed service:

```bash
mono-agent web start --theme ocean
mono-agent web
```

Bare `mono-agent web` is read-only: it prints service status, the usable URLs, and lifecycle help. It does not start, stop, or rewrite the service. The default listener is `0.0.0.0:5050`, so the same process is directly reachable from localhost, the trusted local network, and the machine's Tailscale address.

```bash
mono-agent web start --theme ocean  # install/start with a distinctive shell
mono-agent web stop
mono-agent web restart
mono-agent web status
mono-agent web logs
mono-agent web run         # foreground service, including non-macOS hosts
```

Use `--loopback` with `start` or `run` to bind `127.0.0.1` instead. Advanced `--host` and `--port` overrides are available when `0.0.0.0:5050` is not appropriate. The lifecycle status records the effective bind, theme, and any owned Tailscale route so later commands operate on the same service rather than guessing.

## Host identity and curated themes

Every console identifies itself with the operating-system hostname. The desktop
rail and mobile agent-picker header show that hostname, the browser title is
`<host> · mono-agent`, and an installed PWA is named
`<host> · mono-agent Console` with `<host>` as its short name. This makes tabs
and home-screen installations distinguishable even before opening a thread.

Choose one of four curated shell/accent themes on `start`, `restart`, or the
foreground `run` command:

```bash
mono-agent web start --theme evergreen    # default green
mono-agent web restart --theme ocean      # blue
mono-agent web restart --theme plum       # purple
mono-agent web restart --theme terracotta # warm orange
```

Managed lifecycle state persists the selection. A later restart without
`--theme` retains it, while a pre-theme service record upgrades to `evergreen`.
`mono-agent web status` prints the effective value. Themes intentionally affect
the navigation shell, accent controls, browser chrome, and PWA background; text,
online/degraded state, warnings, and destructive actions keep shared semantic
colors. Theme choice is explicit rather than inferred from the hostname.

## Security boundary: trusted network, no login

The console intentionally has no application authentication or multi-user accounts. Anyone who can reach its HTTP listener can read retained conversations, upload files, cancel turns, and send instructions to every discovered agent. Treat the listener as an owner-equivalent operator surface:

- run it only on a trusted LAN or tailnet;
- use `--loopback` when other devices must not reach it;
- do not publish port `5050` through a public router, tunnel, or unrestricted reverse proxy;
- keep operating-system and Tailscale network admission controls as the access boundary.

The server rejects unexpected Host/Origin combinations and does not enable cross-origin API access, but those checks are browser request-integrity controls, not authentication. Cron mutations additionally require the addressed agent's operator API key, an explicit agent-side opt-in, a source-qualified job route, and an agent-issued confirmation; those gates do not turn the web console into a multi-user authenticated application. Plain LAN HTTP is not encrypted. Tailscale transport protects direct tailnet traffic, while Tailscale Serve provides browser-trusted HTTPS when available.

Cron read routes preserve the operator endpoint's compatibility posture: they are keyless only when that endpoint has no API key, and otherwise require its bearer. The cron configuration action reuses the agent's source-annotated field view; it can show the already-visible job prompt, but never reads the console-discovered config path or exposes arbitrary keys and credentials. A stopped or failed cron registry degrades only the advertised cron capability—agent liveness still returns from `/v1/info`.

At startup, mono-agent inspects the existing Tailscale Serve configuration. It prefers HTTPS `:443` only when free; otherwise it chooses the first free port in `8443`–`8499`. It never resets or replaces another Serve handler. Ownership is recorded locally, and `web stop` removes only the route this console created. If the first route cannot be created, the local/LAN service stays healthy and status prints the direct URLs plus remediation. If a restart cannot migrate an existing owned route to a changed app port, mono-agent restores the prior worker and exact route and exits nonzero.

## How the service is structured

| Layer | What it owns |
| --- | --- |
| Service | Agent discovery, thread/turn lifecycle, attachment admission, notification ingestion, and the upstream operator connection. |
| Managed lifecycle | Paired macOS worker and one-shot maintenance LaunchAgents; the foreground worker only requests a wake, while the helper alone owns stopped-writer log rotation and durable recovery. |
| SQLite store | Authoritative agents, pins, threads, messages, structured parts, revisions, turns, live-input fallback state, uploads, and notification idempotency. |
| `/api/v1` HTTP/SSE | Browser commands and projections. Mutations publish invalidations; browsers refetch current state instead of owning the turn. |
| Assistant-ui PWA | Responsive thread/message/composer presentation, upload progress, response notifications, and browser-origin preferences. |
| Notification ingress | Owner-private loopback endpoint recorded under `~/.mono-agent/web/`; `deliverWebNotification` uses its bearer for one bounded cron/webhook delivery. |

The browser never talks directly to a running agent. It talks to this persistent
service, which keeps the operator stream alive through page reloads and maps
agent events into durable message parts. The PWA consumes service invalidations
and reloads authoritative projections, so multiple tabs converge on the same
SQLite-backed state.

## Agents, threads, and turns

The left rail lists auto-discovered trace sources and their current health. On desktop, its explicit toggle switches between a fixed compact rail and a fixed expanded rail with full agent names. The chosen state is a browser-local presentation preference, so different browser profiles can keep different layouts without a drag-resize target.

Use the star beside an agent to add or remove it from favorites. The same pin control is available in the mobile agent picker. Pin state is persisted in the web service's SQLite settings rather than in browser storage, so favorites stay consistent when the same console is opened through localhost, a LAN address, or Tailscale. Pinned agents sort first and remain visible while offline.

Selecting an agent filters its conversations; each conversation is permanently bound to that source id so a label change or a different agent cannot inherit its history. Unpinned agents that remain discovered but are temporarily offline are hidden by default behind a subtle **Show N offline** control shared by the desktop rail, mobile picker, and command palette. Pinned agents and the currently selected agent remain visible while that source is still discovered. When a successful discovery refresh omits a source, the console removes it from every picker and from the offline count regardless of its prior pin or selection. Its rows, conversations, and pin remain retained in SQLite and return if the same source id is discovered again. A discovery error only marks current sources offline; it is not treated as an authoritative removal. The offline filter resets to hidden on a full page load, and sending stays disabled until the exact source is reachable again.

Threads use the first prompt as their initial title and can be renamed. Active threads must be archived before deletion, and archived threads can be restored. The console permits one active turn per thread while different threads and agents can run concurrently.

Every turn tells the agent that it is in an interactive web console conversation and states the thread's conversation id, `web:<threadId>`, verbatim in its Session block. That id is the thread the person is already reading, not a route elsewhere, and it is disclosed so an agent can hand it to host-side tools and operator commands that bind background work to the thread — a Monitor, a process job, or a maintainer-style task record that must wake this exact conversation. Cron channels and other request-driven turns keep their existing wording and disclose nothing. See [Context assembly](/context/assembly/#session).

Cron jobs and webhook endpoints can explicitly target `notifyConversationId: "web:new"` with `notify: true`. Webhook results retain one assistant-only thread per delivery. Cron results instead fold into one durable, source-qualified channel per job, with the stable route `/agents/<sourceId>/cron/<jobId>`. Its chronological feed includes scheduled/manual admission, running, queued, succeeded, failed, cancelled, overlap-skipped, and dropped states, plus artifact/session links when the agent reports them. The header shows the agent-authoritative schedule, timezone, declared/effective state, last/next run, and health; it never computes next-run locally. Cron channels are read-only in this release, so console interaction cannot occupy the cron job's own conversation and cause a scheduled firing to overlap.

The console retains at most 500 run rows per cron job. A bootstrap carries one page of one `(sourceId, archived)` bucket -- the one `?sourceId=` names, or the agent of the current conversation when it names none -- and answers with `threadsSourceId` and `threadsNextCursor` alongside it. That page and every thread page are bounded to 50 rows by default and 200 at most, message pages to 30 by default and 100 at most, and all older-page queries use opaque keyset cursors. Conversation search is bounded to 50 conversations per query. A selected thread outside the current window is fetched through redirect-resolving `GET /threads/:id` before a mutation instead of silently no-oping.

Configured cron channels may be archived but not deleted. If a job disappears from config, the channel becomes a `configured:false` historical tombstone; an archived tombstone may be deleted. Deletion retains a local suppression marker plus threadless notification-delivery receipts, so authoritative historical overviews and late or replayed deliveries cannot resurrect it. The marker clears only if that job id becomes configured again.

`web:new` is exact and explicit-only: other `web:*` values are rejected, and the web console never joins Telegram/Slack destination inference. Delivery uses an owner-private `~/.mono-agent/web/notify-ingress.json` record pointing to a bearer-authenticated ephemeral loopback endpoint. Duplicate event keys return the existing thread and conflicting reuse fails. If the web service is stopped or unavailable, the trigger makes one attempt bounded to five seconds and then skips delivery; there is no retry queue or outbox, and the cron/webhook result is unchanged.

The service, not the browser tab, owns the upstream operator connection. A browser disconnect or reload can therefore reconnect through the event stream while the turn continues. Brief event-stream reconnects do not raise the full reconnect banner; it appears after five seconds, while a browser-offline event is shown immediately. If the web service itself restarts, any turn that was still active is marked interrupted instead of being shown as permanently running.

During a turn the transcript shows streamed GitHub-Flavored Markdown, reasoning, tool calls and results, context-compaction lifecycle rows, user-facing errors, and the final outcome. Tables, task lists, strikethrough, autolinks, and footnotes render as real elements; a table wider than the transcript keeps its column alignment and scrolls horizontally inside its own keyboard-focusable region, and links to external sites open outside the console window. Raw HTML in a reply is never rendered. Other raw runtime, provider, and usage telemetry remains internal; measured token and cost data appears only through the context control. The composer exposes the selected agent's available model and effort controls. Copy, cancel, archive, unarchive, and steering a running turn are supported; edit/regenerate/branch and browser-defined client tools are deliberately not enabled.

Activity is one panel, and every entry in it is the same row: a status glyph, a
name, a summary of what it acted on, a failure tag when there is one, a duration,
and a chevron. A single tool call, a folded run of them, a thought, and a subagent
delegation all read as that row — only the glyph and what expanding reveals
differ. The panel header summarizes the turn as a step count and its wall-clock
elapsed time — from the moment the turn started until it settled, so thinking,
tool calls and waits are all counted once. It ticks while the turn runs and
freezes at the recorded finish; a historical record with no finish stamp shows
the step count alone.

Repeated tool calls fold together: a run of two or more consecutive calls to the
same tool renders as one row (**Read ×4**) carrying a deduplicated summary, a
failure count, and the combined duration, with every member still individually
expandable on a rail beneath it. The same folding applies to a subagent's own
nested steps.

A settled call says nothing about being settled — the absence of a failure tag is
the success signal. A failed one is tagged, and where the durable tool record
knows *how* it failed, that canonical terminal state names the tag (`timeout`
rather than a generic `failed`). Tool names come from a table rather than a
guess, so `memory_search` is never shortened to "Search"; an unlisted tool is
de-underscored rather than renamed.

A thought still arriving stays open, because watching the model work is the whole
reason Activity opens itself while a turn runs; it folds away once it settles.
Its row shows a plain-prose preview with markdown markers stripped, while
expanding shows exactly what the model wrote.

Durations come from the timing the runtime reports for each tool call. Messages
recorded before the console preserved that timing have none, and a missing
duration is shown as nothing at all rather than as zero.


### Search conversations

The sidebar search box searches the full text of an agent's conversations, not
just their titles. It queries the web service rather than filtering the page the
browser has already loaded, so a phrase used once in a conversation from months
ago is reachable without paging back to it. Titles are matched as substrings;
message text is matched with SQLite FTS5 over an index the service maintains in
SQLite alongside the conversations themselves.

Only conversation prose is indexed: user messages and the agent's answers.
Reasoning and tool inputs/outputs are deliberately excluded, so a search returns
what was said rather than the machine payloads behind it.

Message text and titles match differently, because they are matched by different
means. Message text is tokenized: each query word matches from the start of a
word, so `deploy phoen` finds "deploy the phoenix exporter" but `hoenix` does
not, and accents are folded so an unaccented query still matches accented prose.
Titles are matched as a plain substring, so `hoenix` does find a conversation
*titled* "deploy the phoenix exporter", and title matching folds ASCII case only
— `reunion` will not match a title spelled "Réunion". Adding a word narrows the
results either way.

The tokenizer splits on letters and digits, which suits languages that put
spaces between words. Text in a language written without them — Chinese,
Japanese, Thai — is treated as one long token, so only a query repeating the
whole run will match it.

An answer becomes searchable when its turn settles rather than on every
streaming snapshot, because re-extracting a large message's text every ~50 ms
costs several times the write itself. A turn cut short by a service restart is
indexed on the next open, so nothing is permanently missing from search.

Results are scoped to the selected agent and cover archived conversations,
which appear under their own **Archived** heading rather than being hidden
behind the archive toggle. Each hit shows a highlighted snippet of its best
matching message and, when several matched, how many; a conversation matched
only by its title says so instead. Queries shorter than two characters are not
run.

Titles lead the results, but never take the whole page: half of it is held for
ranked message hits whenever there are any, so a common word appearing in many
auto-derived titles cannot crowd out the one conversation that only mentions it
in a message. A result set that had to be cut says so.

### Discover and reference skills

Typing `$` at a token boundary opens a keyboard-navigable list of skills available to the selected agent. Search ranks exact and prefix name matches first, then token prefixes, partial/fuzzy names, and description terms. The separate **Browse skills** composer control exposes the same live registry without requiring the trigger character; unavailable entries remain visible there with their reason but cannot be selected.

Choosing a result by keyboard, mouse, or touch inserts its exact `$skill-name` reference at the saved caret and returns focus to the draft. It does not submit the message or execute the skill. A sent reference is ordinary turn text plus model-facing intent; the agent prompt defines exact `$skill-name` tokens as explicit requests to use matching instructions. See [Selected skills](/context/skills/#canonical-skill-references) for the syntax and availability rules.

The registry is scoped to the active agent and comes from that running agent's `skillsRoot`, disclosure mode, selected skills, and `ReadSkill` policy. The agent refreshes its in-memory snapshot every five seconds when installed skill files change; the web service never persists a second skill list. Agent switches, registry invalidations, and event-stream reconnects refetch the active snapshot. Loading, empty, unsupported, offline, refresh-error, and stale states leave ordinary composition usable; stale entries are visible but cannot be inserted until a live refresh succeeds.

### Steer a running turn

The composer remains sendable while a response is running. A text-only send is
persisted immediately and offered to the active provider as live guidance. The
message displays one of four delivery states:

- **Steering current run…** while the provider settlement is pending;
- **Applied to current run** after the provider accepts it;
- **Queued as next turn** when the provider is unsupported, delivery fails, or
  the active turn finishes first;
- **Cancelled** when the active turn is explicitly cancelled before settlement.

After the provider accepts the follow-up, the assistant's Activity disclosure
also shows one completed `↪️ Steered: “<safe preview>”` tool row with result
`Applied to current run`. This synthetic row carries only a one-line,
secret-redacted, path-collapsed preview capped at 40 Unicode code points; the
full follow-up stays in its human message. Queued, unavailable, and cancelled
guidance does not create the row.

Queued guidance starts automatically as a normal turn after the current turn
settles. Pending delivery and queue state live in the service's owner-private
SQLite store rather than the browser tab. A web-service restart converts any
uncertain pending offer to queued and drains it after agent discovery, so it is
not silently lost. Each live follow-up is limited to 8,000 characters, with at
most 100 unsettled entries per thread. Attachments keep the ordinary turn path.
If a quote is present, the browser flattens its Markdown blockquote context into
the live guidance before persistence and delivery.
## Structured AskUser forms

When an agent calls the channel-agnostic `AskUser` tool, the web console keeps
the current turn open and renders every remaining question together in one
form. Each question shows its short header, prompt, two or three described
choices, and an **Other** field for a custom reply. Single-select questions use
radio controls; multi-select questions use checkboxes and may combine proposed
choices with a custom reply. Submitting the complete form resumes the same
model run rather than creating a new user turn.

An `AskUser` call may contain one to five questions. Each card reconciles by its
exact `interactionId`, so an older run cannot adopt a newer ask from the same
conversation. One backoff poller serves the selected thread, including after a
refresh and after the tool call becomes terminal. The agent preserves the
asking tool's single-consumer long-poll contract while separately retaining up
to 512 terminal snapshots for at most 24 hours. An answer submitted through a
different destination therefore converges in the console without a manual
refresh. Once terminal history is evicted, or when an agent restarts/offlines,
the card renders unavailable and non-actionable; expired and cancelled cards
are also non-actionable. Submission remains server-authoritative and rejects
stale, missing, or invalid answers without optimistic success. Older agents
without exact lookup remain usable with a non-actionable degraded card.

When the interaction reaches a terminal state, the completion state replaces
the form rather than leaving disabled controls behind. Answered interactions
keep `Answers submitted.` and add either one compact answer line or a question-
attributed list in recorded order. Resolved option labels take precedence over
custom replies. Because this is the owner-private operator console, custom-only
answers show their text; unknown questions and unknown-option-only answers are
omitted. If nothing is resolvable, the generic completion text stands alone.
The completion container retains semantic `role="status"` markup. Cancelling
the turn cancels its pending question set, and an expired or already-completed
form cannot submit stale answers. Older agents that do not advertise the
`askUser` capability remain usable, but the console does not poll them for
pending forms.

## Quote message text

Select text rendered in a user or assistant markdown message and choose **Quote** from the floating toolbar. Reasoning, tool payloads, errors, attachments, and an already-rendered quote are not selection targets. The composer keeps one quote at a time, shows a dismissible preview, and clears it when you switch agents or threads.

The quote is persisted with the new user message as `{ text, messageId }`, so it survives reloads and is rendered separately from the authored message. The operator receives a Markdown blockquote followed by the authored text, while the transcript and automatic title keep the exact text the user typed. The service rejects a source message from another thread. A quote alone is not sendable, and the formatted quote plus message must fit the existing 200,000-character turn-text boundary.

Programmatic callers can use the optional `StartWebTurnInput.quote` field:

```ts
import type { StartWebTurnInput } from "@mono-agent/web";

const input: StartWebTurnInput = {
  text: "Please expand on this.",
  quote: { text: "The selected response text", messageId: sourceMessageId },
};

await fetch(`/api/v1/threads/${threadId}/turns`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(input),
});
```

## Response notifications

Use the header bell to opt into durable Web Push. The permission prompt and initial subscription are triggered only by that click. The server notifies for a completed response (including a cron/webhook-created **CRON** or **WEBHOOK** thread), a blocking `AskUser` question, and failed, cancelled, or interrupted runs. A test notification is queued immediately after registration. Notification clicks focus or open the exact same-origin conversation.

The opt-in is stored per browser origin, so localhost, a LAN hostname, and a Tailscale HTTPS hostname have independent preferences and permissions. The browser keeps only the opaque server subscription id and a one-way digest of its endpoint, then reconciles its `PushManager` subscription with the server on load. A browser-reported subscription rotation is registered from the service worker even with no console window open and atomically retires the old endpoint; transient repair failures receive bounded in-event retries, and the page digest repairs rotations on the next load when that lifecycle event is unavailable or the retry window is exhausted. Application-server-key rotation unsubscribes and reconnects when browser permission allows it. Disabling the bell records the local opt-out first, retires the server subscription, and unsubscribes locally; an interrupted server deletion is retried on the next load, and an already-deleted record counts as complete cleanup. Browsers without a confirmed active push subscription keep the older hidden/unfocused response-notification path while the page is alive, avoiding a silent regression and disabling that fallback as soon as push is confirmed.

Each terminal turn or completed `web:new` thread is committed atomically with its server event and per-device delivery rows; every logical event has a distinct Web Push topic so a later response cannot replace an earlier durable notification. A pending `AskUser` snapshot is enqueued idempotently when discovered, ignored after expiry, and rechecked immediately before delivery. An unavailable agent makes that check retry rather than falsely marking the question resolved. Initial delivery waits three seconds. During that window, a focused page acknowledges only when the exact conversation is visible, using the subscription id stored by that origin and an ephemeral HMAC token delivered over SSE. This is an origin-scoped suppression check, not device authentication; LAN/tailnet reachability remains the console access boundary. Claiming the outbox row wins the race, so late or lost acknowledgements deliver rather than silently dropping an update. Retries use bounded exponential backoff until the event expires. Subscriptions are retired on `404`/`410`, on a resolved unsafe endpoint, and on `400`/`403` bodies carrying the strict `BadSubscription` or `UNREGISTERED` reason allowlist. Transient DNS resolver failures retry without retiring the browser. Ambiguous `401`/`403` responses degrade push health without guessing that the subscription expired, and the vendor-origin circuit opens only after repeated failures span at least two distinct subscriptions.

Payload previews are built only from final assistant text, the active Ask header/question, sanitized failure text, or a fixed terminal status. Obvious Markdown is converted to plain text, common credential shapes are redacted, control and bidirectional characters are removed, and output is limited to 180 code points. Reasoning, tool payloads, telemetry, Ask framing/options, endpoint URLs, and subscription keys never enter the payload or browser API.

The web service and outbox are self-hosted. Web Push itself necessarily sends an encrypted request through the push service selected by the browser vendor; this is not a direct connection to the device. The server accepts only HTTPS port-443 endpoints with public DNS results, repeats that DNS check for every attempt, pins the request to a validated address, and never follows redirects. On iPhone and iPad, serve the console over HTTPS and install it with **Add to Home Screen** before enabling the bell.

## Run controls and context

Pointer/touch opening and model or effort changes do not focus the search input;
keyboard opening retains search navigation. LM Studio and Ollama models confirmed
as embedding-only by native metadata are omitted from chat choices, including
configured aliases. Unknown metadata preserves compatibility; names are not used
to guess a model's purpose. Memory embedding configuration is unaffected.

The run-settings control marks whether the conversation is running on the agent's
default or on a choice made here, and while an override is in force the picker
offers to reset back to the agent default. It uses a searchable model picker with the selected model's supported reasoning-effort choices in the same popover. Configured models use their configured display name when present and otherwise use the running agent's catalog name. A persisted catalog-only selection stays visible by its canonical reference when lazy provider metadata is absent, fails, or omits that model. While no metadata describes that model at all, its current effort and the shared compatibility ladder the agent accepts remain controllable, without reverting to the agent default; once exact metadata loads it supplies the catalog display name and the advertised ladder, which may narrow, keep, or remove those choices. A model choice applies immediately but leaves the picker open so effort can be chosen next; the explicit **Close** action finishes the interaction. The running agent captures those capabilities at startup from configured/local Pi metadata and Pi's built-in catalog, which covers every bundled provider (Anthropic, GitHub Copilot, OpenAI Codex, OpenCode-Go, and more). If that snapshot marks a model as reasoning-capable but cannot confirm its exact levels, the picker hides the effort control entirely, default row included, instead of substituting the global effort ladder. Silence is different from that claim: older agents that omit per-model metadata retain the global ladder for protocol compatibility. On narrow screens the picker becomes a full-width bottom sheet so every advertised effort level remains reachable without overflowing the viewport. **Default model** delegates model selection to the agent. The default effort names the effective configured value, such as **Default · High**; when the agent leaves that choice to its provider, the control says **Default · Provider** instead of guessing a level. Choosing either default clears the conversation override.

The agent rail also has a separate **Agent settings** dialog for defaults used
when the web console creates a new conversation. Model and effort can each
inherit resolved config or be overridden, and the dialog labels the effective
source for both fields. **Revert to config** clears both overrides in one click.
Creation snapshots the effective pair into the new conversation, so later
settings changes never rewrite existing conversations. The layer applies only
to interactive web-console creation: Telegram, Slack, cron, webhook, API, and
TUI requests continue to use their own configured or request-scoped values.

The context control uses exact per-request measurements. The Pi runtime publishes a normalized `context_usage` telemetry event as each assistant message ends, so a tool-calling turn produces one measurement per provider request rather than one per turn. A percentage appears only when that same exact event carries the serving model's context window. Billing telemetry stays separate and is never converted into an occupancy measurement: `usage_update` is a single aggregate emitted once at the end of a run, carrying that run's cost and processed tokens. Durable message/tool-history storage size is never added to a provider measurement; only history actually sent in that request is already included by the provider.

In the header the control is a single percentage, because it shares one narrow row with the model picker on a phone. Token totals, measurement state, and cost all live in its popover; the percentage itself carries the state as colour, and its accessible name still reads the full summary aloud.

The header never calls an in-flight measurement current. A running turn is labeled **Updating** in the popover; failed, cancelled, and interrupted turns ignore their own snapshots and retain only the prior successful **Last measured** value. Changing the selected model also labels the previous model's value **Last measured** and names that measured model. A running or successful compaction invalidates every older value immediately, showing **—** in the header and **Awaiting** in the popover until a newer exact provider measurement arrives. A skipped or failed compaction does not invalidate the prior measurement. This is why an exact value may legitimately decrease after compaction.

The popover keeps aggregate last-turn processed tokens and accumulated conversation cost separate from context occupancy. Older conversations without exact telemetry show **—** and may still show their processed-token breakdown and cost; no aggregate number is converted into a context percentage.

Reported cost and processed tokens include what the run's subagents spent. A delegation is work the run asked for and is billed to the same account, so the Pi runtime folds each subagent's reported usage into the parent run's own before publishing it — which is also why the TUI status bar and the exported metrics agree with the console. The trade is attribution: a subagent running on a different model has its spend reported under the parent run's model, which is the right answer for a run total and the wrong one for a per-model breakdown.

Assistant reasoning, routine tool calls, subagent delegations, and context compactions share one compact **Activity** disclosure without changing their order. Each compaction is one row that updates from running to succeeded, skipped, failed, or interrupted instead of producing duplicate start/end rows. Pi's before/after token counts are estimates and carry a `~` prefix; provider summary text is never displayed. Activity opens while the message is running and force-collapses when the message completes, fails, is cancelled, or is interrupted; it can be reopened afterward, and individual tool payloads remain collapsed inside it. Standalone interactive tools remain outside the group.

An `Agent` call is one foldable row inside Activity — profile name, the model's short task label, and a `4 tools · 12.4s · $0.0042` summary — that **owns** the tool calls its subagent made rather than listing them as siblings. The price appears when the runtime priced that subagent's model, and is the one place a single expensive delegation is identifiable; the run total it folds into cannot say which one spent it. Opening the row reveals each child call indented, individually foldable for its input and output, followed by the report the subagent sent back. Nesting keeps concurrent delegations readable when the provider overlaps them: their events interleave, so a flat transcript would shuffle several agents' work together. Pi 0.85 cannot overlap an `Agent` batch when any stateful/mutating or MCP tool is also offered because its scheduling mode applies to the whole harness. A child that failed is marked without marking the delegation that contains it, and a delegation whose parent call was never observed (a truncated or replayed stream) still renders from its children alone.

Every Activity row is one line at every width: the tool name and status hold their place and a long argument is truncated with an ellipsis, so a list of rows stays scannable rather than reflowing into a ragged block on a phone. Expanding a row reveals the full value. The nesting rails narrow below 560px and the settled Activity list scrolls with the page instead of inside its own box. Individual tool payloads stay height-capped and selectable so their output can still be copied on a phone, and they wrap within the panel rather than extending past it.

Type `/` in an empty composer to open the keyboard-friendly command popover for available actions such as run settings, starting a new conversation, or stopping an active response. Type `$` to find an available skill, or use **Browse skills** without entering a trigger.

## Reply files and MCP Apps

Assistant replies can include host-owned file or MCP App references when the
running agent advertises those additive operator capabilities. Reply files show
a message-bound download action; the service reauthorizes the exact
thread/message/part and the agent rechecks size and SHA-256 integrity before any
bytes stream. No host path or agent capability URL enters the browser DTO.

In an assistant reply, generated images are gathered below the answer, so a set of them reads as a set regardless of how the agent interleaved them with its prose.

Generated images are kept. A reply artifact is otherwise proxied from the agent
and never stored, so a `png`, `jpeg`, `gif`, or `webp` reply would stop resolving
at the agent's retention deadline and show as broken whenever that agent is
stopped. The service instead fetches each one once — at the end of the turn that
produced it, and on read for anything that attempt missed — verifies its declared
size and SHA-256 before writing anything, and keeps the bytes beside uploaded
files under `~/.mono-agent/web/uploads`. The image is then served from the same
stable, token-free path an upload uses, so it survives the access window, the
retention deadline, and the agent being stopped. Every step is best-effort: a
failed fetch, a hash mismatch, or an offline agent leaves the part on its
ordinary capability path and never affects the turn. `svg` is deliberately not
kept, and other file types are not either — they keep the capability path.

Each browser capability is projected for an exact thread/message/part with a
ten-minute access window that never extends the reply part's retention deadline.
An authentic capability used after that window returns `reply_access_expired`;
forged, cross-thread, unknown, and otherwise invalid references retain the
generic not-found response. On `reply_access_expired`, the PWA automatically
asks the exact-origin access route to re-project the authoritative retained part
and retries the attachment download, app resource, or app bridge request once.
If that recovery is exhausted, the file card offers **Refresh access** and the
app card offers **Refresh app access**. A refreshed capability is neither a
persisted credential nor a retention extension.

MCP Apps run only while their exact originating MCP connection is live. The PWA
uses a nonce-bound double iframe with opaque origins and exactly `allow-scripts`;
an intersected clipboard grant adds only `clipboard-write` at both levels. Its
fixed same-origin outer proxy has a no-store, route-local executable CSP and
receives invocation binding from its direct parent; matching repeated
configuration re-arms the bridge while delayed host-ready remains ignored,
without allowing origin or identity replacement. Because inner `srcdoc`
inherits the response policy, the proxy envelope omits the capability
directives owned by the required canonical inner meta CSP. The SPA shell retains
`script-src 'self'`, no invocation data enters the proxy URL, remote script
origins remain denied, and a second inner-frame navigation removes the app.
Tool calls, links, and context updates use an inert, focus-trapped confirmation
dialog; tool arguments are bounded and secret-key-redacted. Resource reads are
limited to the exact `ui://` URI registered for that invocation.

See [Reply files and MCP Apps](/tools/rich-replies/) for native Slack/Telegram
delivery, fallback behavior, producer/bridge limits, retention, and connection
eviction.

## Attachments use the browser device picker

The attachment button opens the native file picker on the device running the browser. It does not expose or browse the web-service host's filesystem.

Web uploads use the same transport-neutral `AgentAttachment` contract and harness path as Telegram:

- the same MIME allowlist;
- a 20 MiB per-file default limit;
- the same image versus document classification;
- UTF-8 decoding for supported text files;
- the same owner-private harness attachment persistence and model-facing attachment description.

A web turn additionally permits at most 10 files and 64 MiB in aggregate. Attachment-only turns are valid. The browser streams bytes to a staged upload with progress; it does not retain base64 copies in React state. Removing an unattached upload removes its stage, and abandoned stages are purged after 24 hours. Committed attachments remain with their conversation, including after archival.

Images are shown rather than filed, and carry no chrome at all: a `png`, `jpeg`, `gif`, or `webp` attachment renders as the picture itself, with no filename, media type, size, or download button beside it. Several in one message share a single row that scrolls sideways rather than reflowing, each cropped to a common height. Selecting one opens it full size, uncropped, with paging, a counter, and a download action — that is where the whole image and its file live. Other file types keep the compact chip or card with their name and size. `svg` is never rendered inline: it is active content, so it stays a download.

An image whose bytes cannot be shown — no durable copy and a failed or unverifiable fetch — falls back to its ordinary file card, keeping the download and **Refresh access** actions. If the console cannot show you the picture, it still hands you the file.

Telegram's optional audio transcription is adapter-specific and is not reused here. Browser-selected audio and video retain their ordinary attachment MIME and document classification unless a future transport-neutral capability changes that contract.

Older running agents that do not advertise attachment support remain usable for text chat, but the upload control is disabled for them rather than sending a request they cannot interpret.

## Storage schema

The web state database is at schema 10. Schema 9 added the `message_search` FTS5
index and the triggers that maintain it, backfilled from existing messages on
first open. Schema 10 adds an `origin` column to `attachments`, distinguishing a
file the operator uploaded from the console's own durable copy of an image the
agent generated. Both migrations are additive and transactional. An older
`@mono-agent/web` binary refuses to open a newer database rather than reading it
incorrectly, so downgrading means restoring a pre-upgrade copy of
`~/.mono-agent/web/state.sqlite`.

## Local state and reset

The service keeps its owner-private SQLite store, settings, notification idempotency ledger, VAPID private key, push subscriptions/outbox, upload stages, durable copies of generated images, logs, and live notification-ingress record under `~/.mono-agent/web/`. Stored messages, quote metadata, attachment metadata, revisions, run state, and pinned agents are local to this computer; they are independent from browser storage and from the agents' provider-side sessions. The desktop agent-rail expansion state, notification opt-in, opaque subscription id, and one-way endpoint digest are intentionally browser-origin-local preferences and are removed when that origin's site data is cleared. Raw push endpoints and key material are never stored in browser preferences.

Durable copies of generated images are retained for as long as their conversation
is, with no size ceiling and no expiry — that is what makes an image you generated
last month still open today. They are bound to the message that produced them, so
**deleting the conversation reclaims them**, both the rows and the bytes on disk,
through the same path that reclaims uploaded files. A console that generates many
images will grow `~/.mono-agent/web/uploads` accordingly; deleting conversations
is the way to reclaim that space.

Managed stdout/stderr live at `logs/web.out.log` and `logs/web.err.log`.
Each active file and retained `.1`, `.2`, and `.3` generation is capped at
5 MiB after maintenance. `mono-agent web logs` reads only the active names, and
`--follow` uses `tail -F` so it reopens them after rotation; there is no
historical selector. `log-monitor-status.json` records the worker's bounded
wake-only observation, while `log-maintenance-status.json` records the helper's
last phase, refusal, or failure. `service.json`, `tailscale-serve.json`, and the
durable rotation intent complete the lifecycle evidence in this owner-private
tree. The two LaunchAgent plists remain under `~/Library/LaunchAgents/`.

The managed worker never rotates its open files or exits with a special rollover
code. `com.mono-agent-web-maintenance` is the only rotation authority. It runs
at login and at one deterministic hourly minute, with deterministic pre-import
dispersion, and restarts the service only after proving the writer stopped.
That restart can interrupt in-flight turns and SSE streams; the next projection
marks an unfinished turn interrupted. Safe oversize logs awaiting the next pass
appear as `due` in `mono-agent web status` without making a healthy service
nonzero. A missing or stale helper, unsafe inventory, refused legacy artifact,
failed pass, or abandoned durable intent remains nonzero. A recoverable proven
intent names `mono-agent web restart`; an unproven `stopping` intent or one tied
to an older main-plist identity instead names `mono-agent web stop` followed by
`mono-agent web start`. Stop clears that stale authority only after both jobs
are proven down.

There is no per-message delete. Ordinary threads and tombstoned cron channels can be deleted only after archival; configured cron channels cannot be deleted. To intentionally erase the whole console store, stop the service and use the explicit two-part confirmation:

```bash
mono-agent web reset --all --yes
```

Reset first requires both the web worker and maintenance helper stopped and both
plist files absent, then takes their shared web lifecycle lock. It removes the
web console's conversations, cron projection, notification ledger and stale ingress record,
VAPID identity, push subscriptions/outbox, committed uploads, staged uploads,
and server settings, including agent pins. It does not clear browser-local
preferences such as rail expansion or notification opt-in, and it does not
remove an agent's config, durable conversation history, memory, or recorded run
artifacts, or agent-owned `.mono-agent/cron-control-v1/` runtime overrides,
audit, and idempotency state. After reset, browsers reconcile the missing or
rotated application-server key and subscribe again when permission permits;
cron channels rebuild from the running agents.

## Current scope

The web console covers discovery, hostname identity, curated host themes, persistent multi-conversation chat, first-class cron channels, marked webhook notification conversations, structured `AskUser` forms, quoting, durable Web Push with a page-notification fallback, model/effort selection, streamed reasoning and tools, internal telemetry-backed context usage, cancellation, and attachments. It is responsive down to narrow phone widths and installable as a host-named PWA when served from a secure browser context.

General recorded-run replay, source-annotated configuration outside cron's redacted view, and managed conversational configuration remain in the TUI for now. Use:

```bash
mono-agent tui
mono-agent tui --configure
```

## Session Recorder removed

The `mono-agent sessions` command that launched the read-only Session Recorder was removed. Use `mono-agent tui` (recorded-run replay) or `mono-agent web` (live console) for operator run inspection.

`@mono-agent/session-web`, the read-only `live` event relay, and their config/env surface have also been removed. `MONO_AGENT_WEB_AUTH_TOKEN` is no longer read by any code. See the [deprecation tracker](/reference/deprecations/#removed-surfaces).

## Related

- [CLI command reference](/observability/cli-reference/#web) — lifecycle and flags.
- [Terminal UI](/observability/tui/) — replay, config view, and managed configuration.
- [TUI stream endpoint](/channels/tui/) — the default-on agent endpoint used for web chat.
- [Sessions and concurrency](/runtime/sessions-concurrency/) — how web threads map to harness conversations and provider sessions.
