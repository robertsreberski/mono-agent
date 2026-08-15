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

Selecting an agent filters its conversations; each conversation is permanently bound to that source id so a label change or a different agent cannot inherit its history. Unpinned offline agents are hidden by default behind a subtle **Show N offline** control shared by the desktop rail, mobile picker, and command palette. Pinned agents and the currently selected agent always remain visible. The filter resets to hidden on a full page load; sending stays disabled until that exact source returns.

Threads use the first prompt as their initial title and can be renamed. Active threads must be archived before deletion, and archived threads can be restored. The console permits one active turn per thread while different threads and agents can run concurrently.

Cron jobs and webhook endpoints can explicitly target `notifyConversationId: "web:new"` with `notify: true`. Webhook results retain one assistant-only thread per delivery. Cron results instead fold into one durable, source-qualified channel per job, with the stable route `/agents/<sourceId>/cron/<jobId>`. Its chronological feed includes scheduled/manual admission, running, queued, succeeded, failed, cancelled, overlap-skipped, and dropped states, plus artifact/session links when the agent reports them. The header shows the agent-authoritative schedule, timezone, declared/effective state, last/next run, and health; it never computes next-run locally. Cron channels are read-only in this release, so console interaction cannot occupy the cron job's own conversation and cause a scheduled firing to overlap.

The console retains at most 500 run rows per cron job. Thread bootstrap and paging are independently bounded to 200 rows per `(sourceId, archived)` bucket, message pages to 100, and all older-page queries use opaque keyset cursors. A selected thread outside the current window is fetched through redirect-resolving `GET /threads/:id` before a mutation instead of silently no-oping.

Configured cron channels may be archived but not deleted. If a job disappears from config, the channel becomes a `configured:false` historical tombstone; an archived tombstone may be deleted. Deletion retains a local suppression marker plus threadless notification-delivery receipts, so authoritative historical overviews and late or replayed deliveries cannot resurrect it. The marker clears only if that job id becomes configured again.

`web:new` is exact and explicit-only: other `web:*` values are rejected, and the web console never joins Telegram/Slack destination inference. Delivery uses an owner-private `~/.mono-agent/web/notify-ingress.json` record pointing to a bearer-authenticated ephemeral loopback endpoint. Duplicate event keys return the existing thread and conflicting reuse fails. If the web service is stopped or unavailable, the trigger makes one attempt bounded to five seconds and then skips delivery; there is no retry queue or outbox, and the cron/webhook result is unchanged.

The service, not the browser tab, owns the upstream operator connection. A browser disconnect or reload can therefore reconnect through the event stream while the turn continues. Brief event-stream reconnects do not raise the full reconnect banner; it appears after five seconds, while a browser-offline event is shown immediately. If the web service itself restarts, any turn that was still active is marked interrupted instead of being shown as permanently running.

During a turn the transcript shows streamed GitHub-Flavored Markdown, reasoning, tool calls and results, context-compaction lifecycle rows, user-facing errors, and the final outcome. Tables, task lists, strikethrough, autolinks, and footnotes render as real elements; a table wider than the transcript keeps its column alignment and scrolls horizontally inside its own keyboard-focusable region, and links to external sites open outside the console window. Raw HTML in a reply is never rendered. Other raw runtime, provider, and usage telemetry remains internal; measured token and cost data appears only through the context control. The composer exposes the selected agent's available model and effort controls. Copy, cancel, archive, unarchive, and steering a running turn are supported; edit/regenerate/branch and browser-defined client tools are deliberately not enabled.

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

The run-settings control uses a searchable model picker with the selected model's supported reasoning-effort choices in the same popover. On narrow screens it becomes a full-width bottom sheet so every effort level remains reachable without overflowing the viewport. Choosing **Automatic model** or **Automatic** effort delegates that setting to the agent.

The context control uses exact per-request measurements reported by Pi, Codex app-server, and OpenCode app-server. Pi reports every successful assistant request, Codex uses `tokenUsage.last` rather than the thread's cumulative total, and OpenCode is accepted only when its completed assistant message includes native `tokens.total`. A percentage appears only when that same exact event carries the serving model's context window. Direct Claude currently exposes no equivalent exact measurement, so the console says that usage is unavailable instead of estimating it from aggregate work.

The header never calls an in-flight measurement current. A running turn is labeled **Updating**; failed, cancelled, and interrupted turns ignore their own snapshots and retain only the prior successful **Last measured** value. Changing the selected model also labels the previous model's value **Last measured** and names that measured model. A running or successful compaction invalidates every older value immediately, showing **Context — · Awaiting** until a newer exact provider measurement arrives. A skipped or failed compaction does not invalidate the prior measurement. This is why an exact value may legitimately decrease after compaction.

The popover keeps aggregate last-turn processed tokens and accumulated conversation cost separate from context occupancy. Older conversations without exact telemetry show **Context —** and may still show their processed-token breakdown and cost; no aggregate number is converted into a context percentage.

Reported cost and processed tokens include what the run's subagents spent. A delegation is work the run asked for and is billed to the same account, so the Pi runtime folds each subagent's reported usage into the parent run's own before publishing it — which is also why the TUI status bar and the exported metrics agree with the console. The trade is attribution: a subagent running on a different model has its spend reported under the parent run's model, which is the right answer for a run total and the wrong one for a per-model breakdown.

Assistant reasoning, routine tool calls, subagent delegations, and context compactions share one compact **Activity** disclosure without changing their order. Each compaction is one row that updates from running to succeeded, skipped, failed, or interrupted instead of producing duplicate start/end rows. Pi's before/after token counts are estimates and carry a `~` prefix; provider summary text is never displayed. Activity opens while the message is running and force-collapses when the message completes, fails, is cancelled, or is interrupted; it can be reopened afterward, and individual tool payloads remain collapsed inside it. Standalone interactive tools remain outside the group.

An `Agent` call is one foldable row inside Activity — profile name, the model's short task label, and a `4 tools · 12.4s · $0.0042` summary — that **owns** the tool calls its subagent made rather than listing them as siblings. The price appears when the runtime priced that subagent's model, and is the one place a single expensive delegation is identifiable; the run total it folds into cannot say which one spent it. Opening the row reveals each child call indented, individually foldable for its input and output, followed by the report the subagent sent back. Nesting is what keeps concurrent delegations readable: subagents run in parallel and their events interleave, so a flat transcript would shuffle several agents' work together. A child that failed is marked without marking the delegation that contains it, and a delegation whose parent call was never observed (a truncated or replayed stream) still renders from its children alone.

Below 560px the tree adapts rather than clipping: each row keeps its tool name and status on the first line and wraps the argument preview onto a second, the nesting rails narrow, and the settled Activity list scrolls with the page instead of inside its own box. Individual tool payloads stay height-capped and selectable so their output can still be copied on a phone.

Type `/` in an empty composer to open the keyboard-friendly command popover for available actions such as run settings, starting a new conversation, or stopping an active response. Type `$` to find an available skill, or use **Browse skills** without entering a trigger.

## Reply files and MCP Apps

Assistant replies can include host-owned file or MCP App references when the
running agent advertises those additive operator capabilities. Reply files show
a message-bound download action; the service reauthorizes the exact
thread/message/part and the agent rechecks size and SHA-256 integrity before any
bytes stream. No host path or agent capability URL enters the browser DTO.

MCP Apps run only while their exact originating MCP connection is live. The PWA
uses a nonce-bound double iframe with opaque origins and `allow-scripts` only.
Remote CSP origins default to denied, resource domains never grant script
execution, and a second inner-frame navigation removes the app. Tool calls,
links, and context updates use an inert, focus-trapped confirmation dialog;
tool arguments are bounded and secret-key-redacted. Resource reads are limited
to the exact `ui://` URI registered for that invocation.

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

Telegram's optional audio transcription is adapter-specific and is not reused here. Browser-selected audio and video retain their ordinary attachment MIME and document classification unless a future transport-neutral capability changes that contract.

Older running agents that do not advertise attachment support remain usable for text chat, but the upload control is disabled for them rather than sending a request they cannot interpret.

## Local state and reset

The service keeps its owner-private SQLite store, settings, notification idempotency ledger, VAPID private key, push subscriptions/outbox, upload stages, logs, and live notification-ingress record under `~/.mono-agent/web/`. Stored messages, quote metadata, attachment metadata, revisions, run state, and pinned agents are local to this computer; they are independent from browser storage and from the agents' provider-side sessions. The desktop agent-rail expansion state, notification opt-in, opaque subscription id, and one-way endpoint digest are intentionally browser-origin-local preferences and are removed when that origin's site data is cleared. Raw push endpoints and key material are never stored in browser preferences.

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
