---
title: "Always-on web console"
description: "Run and secure the persistent assistant-ui console for local-agent discovery, threads, attachments, notifications, and live turns."
sidebar:
  order: 5
---

`mono-agent web` is the browser operator console for every running agent discovered on this computer. It is a separate `@mono-agent/web` application built on assistant-ui's External Store Runtime and native Thread, ThreadList, Message, Composer, Attachment, GroupedParts, and ToolFallback primitives, with the assistant-ui Reasoning disclosure adapted for structured runtime parts. The service owns conversations and in-flight turns, so refreshing or closing a browser tab does not abort work.

This is the chat-first companion to [`mono-agent tui`](/observability/tui/). The former `mono-agent sessions` read-only run browser [was removed](#session-recorder-removed); recorded-run replay now lives in `mono-agent tui`.

The web service does not run the terminal UI. Both consoles discover and connect to each agent's `metadata.channels.tui.baseUrl`, whose default path is `/gui`; they merely share the same bidirectional operator protocol.

Successful cron runs suppressed by the shared `NOTHING_TO_REPORT` classifier have
no visible message row. Compact run history remains available separately from the
conversation feed. Failures, real output and completed notification content remain
visible. A cron revision change resets that conversation's cached transcript,
including previously loaded pages, so hidden history cannot reappear from an old
browser cache. Offline cleanup preserves real text and rich replies even when an
older server marked their cron metadata silent.

## Start it once

On Linux, use the [systemd user-service backend](./linux-services.md) for
`web start`, `stop`, `restart`, `status`, and `logs`. Its runtime is unmanaged
and HTTPS routes are configured separately. The managed launchd/Tailscale
lifecycle described below applies to macOS.

On macOS, install and start the managed service:

```bash
mono-agent web start --theme ocean
mono-agent web
```

Bare `mono-agent web` is read-only: it prints service status, the usable URLs, and lifecycle help. It does not start, stop, or rewrite the service. The default listener is `0.0.0.0:5050`, so the same process is directly reachable from localhost, the trusted local network, and the machine's Tailscale address.

```bash
mono-agent web start --theme ocean  # install/start with a distinctive shell
mono-agent web start --name "Flockbox"  # label tabs and the installed PWA
mono-agent web stop
mono-agent web restart
mono-agent web status
mono-agent web logs
mono-agent web run         # foreground service, including non-macOS hosts
```

Use `--loopback` with `start` or `run` to bind `127.0.0.1` instead. Advanced `--host` and `--port` overrides are available when `0.0.0.0:5050` is not appropriate. The lifecycle status records the effective bind, theme, console name, and any owned Tailscale route so later commands operate on the same service rather than guessing.

## Console identity and curated themes

By default every console identifies itself with the operating-system hostname.
The Dashboard header shows that name above the selected agent, the browser
title is `<name> · mono-agent`, and an installed PWA is named
`<name> · mono-agent Console` with `<name>` as its short name. Android uses the
short name as the home-screen label. This makes tabs and home-screen
installations distinguishable even before opening a thread.

Override the hostname with `--name` on `start`, `restart`, or `run` when the
machine hostname is not what belongs on a phone home screen:

```bash
mono-agent web start --name "Flockbox"
# Later, restore the hostname-derived label:
mono-agent web restart --name -
```

The label is 1-80 characters on a single line. Like `--theme`, it is persisted
in the managed service record and re-baked into the LaunchAgent arguments, so a
later restart without `--name` retains it and `mono-agent web status` prints the
effective value (or `— (machine hostname)` when unset). The documented `-`
value is a reset sentinel rather than a literal label. It is a machine-level
service flag: the web console deliberately reads no agent `--config` or
`--env-file`. On Linux the same value is persisted into the systemd user
unit's arguments instead of a LaunchAgent.

Android captures the launcher label when the PWA is installed, so an already
installed console keeps its old name until it is reinstalled.

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

The console intentionally has no application authentication or multi-user accounts. Anyone who can reach its HTTP listener can read retained conversations, upload files, cancel turns, send instructions to every discovered agent, and operate provider-authentication flows. Treat the listener as an owner-equivalent operator surface:

- run it only on a trusted LAN or tailnet;
- use `--loopback` when other devices must not reach it;
- do not publish port `5050` through a public router, tunnel, or unrestricted reverse proxy;
- keep operating-system and Tailscale network admission controls as the access boundary.

The server rejects unexpected Host/Origin combinations and does not enable cross-origin API access, but those checks are browser request-integrity controls, not authentication. Cron mutations additionally require the addressed agent's operator API key, an explicit agent-side opt-in, a source-qualified job route, and an agent-issued confirmation; those gates do not turn the web console into a multi-user authenticated application. Plain LAN HTTP is not encrypted. Tailscale transport protects direct tailnet traffic, while Tailscale Serve provides browser-trusted HTTPS when available.

Cron read routes preserve the operator endpoint's compatibility posture: they are keyless only when that endpoint has no API key, and otherwise require its bearer. The retained cron config-view proxy reuses the agent's source-annotated field view; it can return the already-visible job prompt, but never reads the console-discovered config path or exposes arbitrary keys and credentials. A stopped or failed cron registry degrades only the advertised cron capability—agent liveness still returns from `/v1/info`.

Provider-auth routes use the same compatibility posture: they are keyless when
the addressed operator endpoint has no API key and otherwise require its bearer.
This does not add a separate authentication boundary; the trusted LAN/tailnet
and operating-system admission controls remain the boundary.

At startup, mono-agent inspects the existing Tailscale Serve configuration. It prefers HTTPS `:443` only when free; otherwise it chooses the first free port in `8443`–`8499`. It never resets or replaces another Serve handler. Ownership is recorded locally, and `web stop` removes only the route this console created. If the first route cannot be created, the local/LAN service stays healthy and status prints the direct URLs plus remediation. If a restart cannot migrate an existing owned route to a changed app port, mono-agent restores the prior worker and exact route and exits nonzero.

## Provider authentication

For every current app-owned agent, **Agent settings** includes one compact
provider-authentication row for each provider used by the agent's effective
primary, fallback, memory, and enabled static trigger routes. A row says **OK**
only after a retained real request succeeds. Static credential presence is
**Not verified**; unusable material and a later credential rejection are
**Needs action**; keyless providers are **Not applicable**. Availability,
network, quota, and model-entitlement failures do not become false auth claims.
The evidence is best-effort and process-local: a restart loses check sessions
and observations, and no provider-auth result is stored durably. Ordinary run
evidence is fenced at provider-execution start: any target-store mutation makes
already-running summaries and their failover attempts ineligible to verify or
reject the replacement credential, even if post-install cleanup later fails.

One **Authenticate** or **Re-authenticate** action starts a short-lived session on
the agent host. GitHub Copilot and OpenAI Codex show Pi's native device URL and
code while the headless host polls. Anthropic shows an authorization URL and a
field for the final localhost redirect URL or code because Pi 0.85.1 has no
Anthropic device-code flow. API-key providers such as OpenCode-Go use masked,
provider-owned prompts. There is no `--device-auth` CLI flag.
The neutral recovery action remains available at its normal button size whenever
the provider exposes a supported login method, even when the row says **OK** or
**Not verified**. Starting another valid login cancels the current session and
begins again with a fresh session ID; a malformed or unavailable method leaves
the current prompt usable. Live checks are separate consented operations and
must be cancelled before authentication can start.

Cancelled prompts, progress, callback completions, and late provider results are
discarded. If the prior credential transaction has already entered atomic
promotion or cleanup, the replacement waits up to two seconds for it to finish
safely. A longer drain fails the fresh session with `replacement_timeout`
without starting another writer; retry after the prior transaction finishes.
An already-open provider page may still complete remotely, but its stale local
callback cannot update the replacement session or auth store. The console keeps
polling identical active snapshots; an expired retained session releases the
local running control, while transient status-read failures remain retryable.

**Run check** is one explicit section-level action for all provider rows already
displayed. It sends one tiny request to each provider's deterministically chosen
cheapest eligible model, with no fallback or alternate-model retry, and reports
partial results inline. A pass proves only that provider, credential, and model
worked at the check time. Missing or incomparable prices, including multiple
candidates when any price is unknown, make no request; a sole eligible candidate
with unknown price is the one documented exception. Opening or polling settings
never sends provider traffic. Clicking **Run check** may consume quota or incur a
minimum charge, and Pi may refresh OAuth and atomically update the agent's auth
store. Checks run at most two providers concurrently, time out, can be cancelled,
and observe a one-minute cooldown.

Every browser proxy route requires the exact console origin. The addressed
agent's provider-auth routes are keyless when its operator endpoint has no API
key; when it has one, the web server sends the discovered bearer over the
loopback operator connection and the agent enforces it. These are request
integrity and compatibility controls inside the trusted-network, single-user
posture above; they are not per-human owner/admin login.

A person or process that can reach the console inside that trusted network can
inspect provider status, start or cancel login sessions, read device codes and
authorization URLs, submit paste-back callbacks or API keys, and thereby bind or
replace a real provider credential in the agent's Pi auth store. That can switch
the account and billing identity the agent uses or disrupt its access. This is
accepted because network reachability is deliberately treated as owner-equivalent
authority; deployments that cannot make that assumption must use `--loopback`
or add an authenticated network boundary before exposing the console.

Login/check sessions, URLs, codes, progress, prompts, and sanitized check results
live only in agent/webapp memory. Responses use `Cache-Control: private,
no-store`; closing the dialog or switching agents cancels active work. The web
service never reads or writes `providers.piAuthPath` and stores no session,
submitted value, raw provider output, or raw provider error in SQLite, threads,
browser storage, or run history. The host writes the Pi auth store only through
its owner-only locked transaction, including an OAuth refresh performed by an
explicit check. Codex CLI worker credentials in `~/.codex/auth.json` are outside
this feature.

## How the service is structured

| Layer | What it owns |
| --- | --- |
| Service | Agent discovery, thread/turn lifecycle, attachment admission, notification ingestion, and the upstream operator connection. |
| Managed lifecycle | Paired macOS worker and one-shot maintenance LaunchAgents; the foreground worker only requests a wake, while the helper alone owns stopped-writer log rotation and durable recovery. |
| SQLite store | Authoritative agents, pins, threads, messages, structured parts, revisions, turns, live-input fallback state, uploads, and notification idempotency. |
| `/api/v1` HTTP/SSE | Browser commands and projections, compressed and ETag-revalidated. A browser subscribes the conversation it has open to that conversation's message deltas; everything else arrives as a hint it revalidates conditionally, instead of owning the turn. |
| Assistant-ui PWA | Responsive thread/message/composer presentation, upload progress, response notifications, and browser-origin preferences. |
| Notification ingress | Owner-private loopback endpoint recorded under `~/.mono-agent/web/`; `deliverWebNotification` uses its bearer for one bounded cron/webhook delivery. |

The browser never talks directly to a running agent. It talks to this persistent
service, which keeps the operator stream alive through page reloads and maps
agent events into durable message parts. The PWA refreshes only what an event
actually invalidates: the conversation it has open is subscribed to that
conversation's own message deltas and applied in place, while every other change
arrives as a hint it answers with a conditional read. Multiple tabs still
converge on the same SQLite-backed state, but by asking what changed rather than
by reloading a projection each time anything did.

Server and webapp ship as one artifact. `packages/web` serves the bundle built
beside it, and `mono-agent web restart` re-stages both together, so the two
always upgrade in lockstep — a console build older than the bootstrap and delta
protocol described here cannot read this server. An installed PWA is the one
copy that can lag: its service worker stages a new build and takes it over only
at a moment that costs nothing (see [What the browser fetches](#what-the-browser-fetches)).

## What the browser fetches

This console is installed on phones and reached over cellular, so what it costs
to keep open is part of its contract.

**On the wire.** Every response over a kilobyte is brotli- or gzip-compressed by
negotiation, except the event stream and byte-exact binary bodies, which are
marked `no-transform`. Hashed `assets/*` bundles are
`public, max-age=31536000, immutable`. `index.html`, the service workers, and the
icons keep their names across builds, so they are `no-cache` and revalidate
cheaply against their ETag on every load. `/api` reads default to
`private, no-cache`, which makes an unchanged read a `304` rather than a second
copy of the same transcript. Upload and stored-image content, whose URLs are
content-addressed and can never change meaning, is
`private, max-age=31536000, immutable, no-transform`.

**Deltas rather than reloads.** `GET /api/v1/events?thread=<id>` subscribes that
SSE connection to one conversation, resolving a redirected thread id to the
canonical one every event carries. Its assistant messages then arrive as
`message.delta` frames — `append`, `set`, and `truncate` operations against a
per-message sequence number — so a streaming turn costs what it produced instead
of the whole message every time it grows. Other conversations on the same
connection, and connections that named none, get a `message.changed` hint at most
once per conversation per second; the subscribed conversation's own hints and
reconciliation hints are never throttled. `Last-Event-ID` is
deliberately ignored: a reconnect's `ready` event means resync, not replay. Any
sequence gap is repaired with `GET /api/v1/threads/:id/messages/:messageId`, and
the first `ready` also conditionally revalidates the selected conversation once
the mount snapshot establishes its selection. This closes the interval between
sampling that snapshot and registering the stream without reloading the whole
bootstrap. After a later gap the browser revalidates what it holds with
`If-None-Match`, marks
kept conversations stale, refreshes the Dashboard's lists only after a real drop, and never
reloads the bootstrap. Coming back from an iOS suspend — `visibilitychange`,
`pageshow`, or `online` — takes the same path. Up to eight conversations are held
in memory and merged by identity rather than replaced, so leaving one and coming
back keeps the history already paged in instead of buying it again.

**What is running, fleet-wide.** `GET /api/v1/threads/active` answers with every conversation whose foreground turn is running or that has a retained process job queued, starting or running, joined to the agents discovery currently reports. It has a fixed scope and a fixed cap — no source id, no archive shelf, no cursor — because a projection with a cursor invites a console to walk it on every event, which is the cost this listing exists to avoid. `threads` carries at most fifty, ordered `updated_at DESC, id DESC`; `total`, `truncated` and `runningCounts` (per discovered agent, zeroes included) are computed over the whole qualifying set, so a cap can never report a busy fleet as a quiet one. The same projection rides on `GET /api/v1/bootstrap` as `activeThreads`, from the same store snapshot the agent summaries and their `runningCount` are taken from. A running foreground turn's `runState` additionally carries a bounded `activity` — `toolCallCount`, `phase`, and `cumulativeUsd` when the run was priced — which is absent on terminal runs. `turn.changed` is emitted when that projection changes, never per text delta, and the browser answers any event that could have moved it with at most one re-read per second. A retained job card is only as current as the notification behind it, so the service re-asks each agent about the cards it still draws as nonterminal: on a reconnect or an agent process-generation change, and otherwise no more than once every fifteen minutes per agent. One sweep is bounded for the whole service, not per agent — at most four job reads in flight and at most fifty cards across the fleet, shared evenly between the agents that are due — and what a pass does not reach it takes next time, both the agents the budget ran out before and the cards behind the page it asked about. A terminal projection is applied exactly as its notification would have been; an agent that no longer knows the job retires the card as `interrupted` with `process_job_agent_restarted`; any other failure leaves the card untouched, because an agent this console could not reach has not said that the job ended.

**Shaped transcripts, full bodies on demand.** Transcripts are shaped where the
service projects them, not in the browser. Telemetry parts outside the console's
allowlist keep their position but lose their `data`. A tool call's arguments or
result, and a subagent's report, longer than 4,096 characters ship as a preview
marked truncated, with the full byte count and a digest of the body it was cut
from. Expanding the row fetches the whole part from
`GET /api/v1/threads/:id/messages/:messageId/tool-calls/:toolCallId`; a restored
body is kept only when it matches that digest, so a repair can never re-attach
the wrong bytes to a device-restored transcript. `structuredResult` and `AskUser`
payloads are never shaped, and `?full=1` on a transcript read turns the whole
diet off for that one request.

**Data mode.** The command palette's **Data: Auto / Lean / Full** action and the
dashboard-footer indicator are the same control: it shows the mode, the bytes this
session has cost, and the rate over the last minute, prefixed `~` (and spoken as
"estimated") whenever any part of that total is the console's own body-length
estimate rather than a browser measurement. The meter is per session and is
neither persisted nor sent anywhere. `Auto` reads the browser's Network
Information API and resolves to Lean on a metered or save-data link; where there
is no such API — Safari, and therefore every iPhone — it resolves to `Full`, and
a home-screen install is offered Lean once. In Lean, pictures and MCP App
documents load when you ask for them, delta paint is batched to one second, pages
are 25 conversations and 15 messages instead of 50 and 30, polls run at half
rate, and images are retained less aggressively (8 pictures, 8 MiB, 20 seconds
against Full's 24, 32 MiB, and 60 seconds). Polling pauses whenever the tab is
hidden and reads immediately when it returns. Both preferences are browser-local
(`mono-agent.web.data-mode` and `mono-agent.web.data-mode-suggested`), not
configuration.

**Staged updates.** The service worker precaches the console shell and is
registered in `prompt` mode, so a new build is downloaded and held rather than
applied on arrival. It takes over when the tab becomes visible with nothing
running in any conversation this tab holds and nothing unsent that a reload would
destroy — staged attachments, or composer text on a browser that refuses local
storage — or immediately when you choose **Reload now** on the notice. That notice
stays on screen until the build is applied or dismissed. Applying it reloads the
page, which is why a streaming turn is never interrupted by one. Ordinary composer
text is retained on the device (see [Unsent composer text](#unsent-composer-text))
and comes back after the reload, so it no longer holds a new build back.

## Agents, threads, and turns

One **Dashboard** carries all navigation: a fixed 340-pixel left column on desktop and the entrance screen at 900 pixels and below. Top to bottom it holds the console name and connection state, the selected agent with the notifications, agent-settings and new-conversation controls, a horizontally scrolling strip of auto-discovered trace sources showing their current health, conversation search, a **Running** section, a **Projects** section, the **Recent** listing, and a footer with the data-mode indicator and the archive shelf. There is no rail width to choose and no stored layout preference.

**Running** lists what the whole fleet has in flight — a foreground turn, or a queued, starting or running background job — grouped by agent, two cards per agent with the rest behind an inline `+N more` control. Selecting a card switches agent, archive shelf and conversation in one action, including for a conversation this browser has never loaded. The membership is the service's, from `GET /api/v1/threads/active`, described under [What the browser fetches](#what-the-browser-fetches): every discovered agent, both archive shelves, counted before it is capped. The count beside the label is the count of the whole qualifying set, so a capped section says `Showing 50 of 63` underneath rather than quietly reporting fifty, and the badge on an agent square is that agent's own count from the same answer.

Each card's status line says only what a turn's own transcript can support: `Working · 11 tool calls`, `Asking you a question` when a retained `AskUser` call is still running, and `· $2.44` when the runtime priced the run. Tool calls are not steps, and a delegation's own calls belong to its subagent group and are not counted. What is deliberately **not** shown: a provider-neutral step ordinal, any estimate of how much longer, token or context percentages, generic pending approvals, and nested subagent accounting. A turn that has not reported anything yet keeps a muted `Working…` rather than claiming `0 tool calls`.

When no live answer stands behind the section — the event stream has dropped, a read of the listing failed, or the console is drawing a cold start from the device — it says **last known** beside the count and falls back to the last listing it heard plus the conversations this tab is holding. An authoritative empty listing removes the section, and that removal is an answer: the fleet is idle because the service said so. An empty fallback is omitted too, but it proves nothing — it is simply not drawn, because an unlabelled empty Running from a console that cannot see the fleet is the one claim it will not make.

**Unread.** A Recent row carries a small dot, and an agent square a muted count, when a conversation has moved since **this device** last looked at it. It is device-local: the service has no idea what a person has read, and one account is a phone, a laptop and a tab left open on a second monitor. A conversation this browser has never seen is not unread — first sight records it — and the mark is cleared only while the conversation is on screen, which on a phone means the conversation screen rather than the Dashboard. Work in flight takes the agent square's badge; the unread count returns when the work ends. See [Local state and reset](#local-state-and-reset).

**Recent** is the selected agent's current archive shelf, and its head carries the list's two chips: **Chats** and **Automations**. Each row carries a glyph for what it is: an alert for a presented failure, cancellation or interruption, otherwise a clock for cron, an activity trace for a webhook, and a conversation glyph for everything else. Trouble takes the glyph, and the row's accessible name still says where the conversation came from. Searching replaces these rows with server-side results; the chips stay, and switching to Automations clears the query, which means something else there.

**Projects** are one agent's named containers of conversations, with a **+ New** action in the section head. Opening one replaces the Dashboard in the same slot with the project page: the agent label to walk back, the project name with its `N conversations · N running · $X this month` line, a context card, and the member conversations sorted by recent. The context is free text, prepended operator-facing and at dispatch time to every turn of every member conversation, so existing conversations pick it up on their next turn; it is never stored in a message or shown as part of one. The conversation header menu offers **Add to project…** and **Remove from project** (a member instead offers **Move to…**). Archiving a project hides its entry while keeping chats, membership, and injection; deleting one detaches its chats back to the agent, where they reappear immediately. There is no cross-agent membership and no URL for a project: the open project is transient console state.

Choose a default, blue, purple, amber, or rose tint in project settings. The chat
toolbar badge shows its effective project. Join, leave, and move requests during
an active turn show a pending hint and apply after it finishes; the last request
wins. Persisted faded markers show the actual transition boundary without
becoming model messages. Name/context edits affect subsequent turns; current
steering retains the turn's original context, including an original absence of
membership. Color updates are immediate. Delete waits for active members and
pending references; archive waits for pending destinations. Creating a project
from a chat uses the existing conversation menu flow.

The agent can also use [console project tools](../tools/mcp.md#console-project-tools)
during a writable interactive turn. Creating a conversation does not start it.


On narrow touch screens the console opens on the Dashboard. Tapping a row, a
Running card or the new-conversation control pushes the conversation over it;
the **Back to dashboard** control at the left edge of the conversation header,
a right swipe across the unoccupied chat surface, or Escape pops it. Message
content, controls, inputs, modal surfaces, and any native horizontal scroller —
the agent strip included — keep their normal touch behavior. The gesture
requires at least 64 pixels of clearly horizontal travel, so short drags and
ordinary vertical scrolling do not change navigation. Neither screen is modal;
the one not showing is hidden from assistive technology and out of the tab
order. Only a cron channel has an address of its own, so only a URL naming one
opens on the conversation. The Dashboard's gutters grow into the horizontal
safe area on notched devices.

Add or remove the selected agent from favorites with the star in the agent settings dialog (behind the Dashboard header's gear) or the command palette's pin command. Pin state is persisted in the web service's SQLite settings rather than in browser storage, so favorites stay consistent when the same console is opened through localhost, a LAN address, or Tailscale. Pinned agents sort first and remain visible while offline.

Selecting an agent filters its conversations; each conversation is permanently bound to that source id so a label change or a different agent cannot inherit its history. The dashboard lists ordinary conversations under **Recent** and offers **Automations** as the list's second chip beside **Chats**, on desktop and on the phone's entrance screen; the chip swaps the rows in place, with no separate view to return from. Recent uses server-side scoped paging and search that excludes cron channels before limits and cursors are applied; webhook conversations remain ordinary conversations. The unscoped API default stays backward-compatible. Automations reads and searches the complete bounded agent-scoped cron overview instead, so configured jobs appear before their first run and independently of which conversation page is loaded. The shared search field changes meaning with the active chip and clears when the chip changes. Automations adds no project persistence, membership, folders, tags, or runtime context beyond the per-turn project envelope described above. Unpinned agents that remain discovered but are temporarily offline are hidden by default behind a subtle **Show N offline** control shared by the agent strip and the command palette. Pinned agents and the currently selected agent remain visible while that source is still discovered. When a successful discovery refresh omits a source, the console removes it from every picker and from the offline count regardless of its prior pin or selection. Its rows, conversations, and pin remain retained in SQLite and return if the same source id is discovered again. A discovery error only marks current sources offline; it is not treated as an authoritative removal. The offline filter resets to hidden on a full page load, and sending stays disabled until the exact source is reachable again. A pinned agent's square carries the same star the settings dialog pins with, so the order pinned agents sort into has a reason on it. A Recent row is marked as the open conversation only where that conversation is on screen — beside the list on desktop, and on a phone only once it has been pushed over the entrance screen — while the console's selection itself is unchanged.

Threads use the first prompt as their initial title and can be renamed. Active threads must be archived before deletion, and archived threads can be restored. The console permits one active turn per thread while different threads and agents can run concurrently.

Every turn tells the agent that it is in an interactive web console conversation and states the thread's conversation id, `web:<threadId>`, verbatim in its Session block. That id is the thread the person is already reading, not a route elsewhere, and it is disclosed so an agent can hand it to host-side tools and operator commands that bind background work to the thread — a Monitor, a process job, or a maintainer-style task record that must wake this exact conversation. Cron channels and other request-driven turns keep their existing wording and disclose nothing. See [Context assembly](/context/assembly/#session).

Cron jobs and webhook endpoints can explicitly target `notifyConversationId: "web:new"` with `notify: true`. Webhook results retain one assistant-only thread per delivery. Cron results instead fold into one durable, source-qualified channel per job, with the stable route `/agents/<sourceId>/cron/<jobId>`. Opening an Automations row uses that same route and chronological feed; loading the route directly selects the Automations chip. The list shows each overview job once with its id, cadence/timezone, enabled state, last or active run, and next run. A saved overview remains readable when the agent is offline or no longer advertises cron, but is visibly a snapshot and cannot supply actionable live state; truncated overviews disclose that removed historical jobs may be omitted. The chronological feed includes scheduled/manual admission, running, queued, succeeded, failed, cancelled, overlap-skipped, and dropped states, plus artifact/session links when the agent reports them. The header opens collapsed on one line — schedule, state and next run — and expands to show schedule, timezone, state, last and next run, and health. It is a native disclosure, so its expanded state is exposed to assistive technology and driven from the keyboard by the browser, and nothing about it is persisted. The disclosure belongs to one agent's one job, so every cron channel opens collapsed, including a direct switch from one cron channel to another. It retains **Run now**, **Enable/Disable**, and the redacted **View config** surface; action controls use the existing authentication, opt-in, confirmation, idempotency, and capability gates and explain when they are unavailable. Configuration remains file/config-JSON owned, and the browser never computes next-run locally or treats stale state as actionable. The cron transcript itself remains read-only, so console interaction cannot occupy the cron job's own conversation and cause a scheduled firing to overlap.

Every terminal cron row offers **Reply**. It captures the exact persisted summary
or already-loaded detail and imports it into a separate normal conversation as
explicitly untrusted context without running a model. The console presents that
immutable snapshot as one compact card with run status and timing, Markdown
result text, optional failure and truncation notices, and an accessible
**Details** disclosure containing source metadata and the exact raw JSON. This is
read-time presentation: the two host-seeded stored rows and the agent-facing
context bytes are unchanged. A malformed, modified, non-v1, model-authored, or
multi-part lookalike stays ordinary text.

The console retains at most 500 visible and 500 suppressed run projections per cron job. Silent history does not consume the visible-message allowance. A bootstrap carries one page of one `(sourceId, archived)` bucket -- the one `?sourceId=` names, or the agent of the current conversation when it names none -- and answers with `threadsSourceId` and `threadsNextCursor` alongside it. That page and every thread page are bounded to 50 rows by default and 200 at most, message pages to 30 by default and 100 at most, and all older-page queries use opaque keyset cursors. Conversation search is bounded to 50 conversations per query. A selected thread outside the current window is fetched through redirect-resolving `GET /threads/:id` before a mutation instead of silently no-oping.

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

The Dashboard's search field searches the full text of an agent's conversations, not
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

### Unsent composer text

Text you have typed but not sent belongs to the conversation you typed it in.
Switching conversations or agents puts each one's own unfinished message back in
the composer, and so does closing the console, reloading it, or having the system
evict the installed app from memory: the console writes the text to that browser
origin's local storage as you type — debounced, and again the moment the page is
hidden, which on a phone is the only warning it gets. Sending the message, or
deleting its conversation, removes it.

This is device-local and deliberately plain: the text sits in that browser
profile's storage in the clear until it is sent, cleared or expires, it is never
uploaded, and a draft typed on the phone does not appear on the laptop. A draft
nobody returns to expires after 30 days, the newest 40 conversations are kept, a
single draft is retained up to 32,768 characters, and a browser that refuses
storage (Safari private browsing, a locked-down profile) still keeps the text for
as long as the tab lives. Clearing that origin's site data removes drafts;
**Clear cached data** deliberately does not, because unsent writing is not a
cached copy of anything. Attachments are not part of this: their bytes belong to
the open tab and are staged again after a reload.

### Send while a turn is running

The composer keeps one **Send** action while a response is running. Button Send,
desktop Enter, and **Control/Command + Shift + Enter** all submit the same
immutable UUID-bearing payload; Shift+Enter and touch Enter remain newline. The
browser does not choose between turn and live-input endpoints. The service reads
authoritative state and either starts one normal turn or targets the exact active
Web operation and its harness-owned mailbox. The message displays one of five
delivery states:

- **Steering current run…** while the provider settlement is pending;
- **Consumed by current run** after exact transcript-consumption evidence and
  confirmed host settlement;
- **Queued as next turn** only when non-delivery is proved safe;
- **Delivery uncertain — not retried** when native delivery may have happened;
- **Cancelled** when the active turn is explicitly cancelled before settlement.

After exact consumption is confirmed, the assistant's Activity disclosure
also shows one completed `↪️ Steered: “<safe preview>”` tool row with result
`Consumed by current run`. This synthetic row carries only a one-line,
secret-redacted, path-collapsed preview capped at 40 Unicode code points; the
full follow-up stays in its human message. Queued, unavailable, and cancelled
guidance does not create the row.

Queued guidance starts automatically as a normal turn after the current turn
settles. It
uses the conversation's model and effort captured when the message was
offered; a follow-up offered during a turn retains that active turn's route.
Pending delivery and queue state live in the service's owner-private SQLite
store rather than the browser tab. Schema 22 persists a dispatch marker before
the operator request. On restart, unmarked offers recover queued while marked
offers become uncertain and non-promotable, preventing automatic duplicate
fallback. Schema 23 adds a thread-scoped durable submission ledger: replaying
the same UUID and payload returns the current receipt without redispatch, while
conflicting reuse returns `409`. Browser recovery stores only the thread and
submission UUID, then reads that receipt; it never persists draft/file content
or automatically posts again. Back up the database before upgrading: a
schema-22 Web binary refuses schema 23, and rollback requires restoring a
compatible backup, losing later writes. Deploy the targeting-capable operator
before Web. An older operator visibly queues `unsupported_targeting` instead of
guessing a current run. Each live follow-up is limited to 8,000 characters,
with at most 100 unsettled entries per thread.

Live guidance is text-only. When attachments are staged during an active turn,
the server durably rejects the submission before claiming or deleting uploads,
and the browser restores the full authored text, structured quote, and staged
files. Once the response finishes, an intentional new Send uses a new UUID and
the ordinary attachment turn path. For quoted live guidance, the server formats
the Markdown blockquote for the operator while retaining the structured quote
and exact authored text in the transcript.

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

Use the bell in the Dashboard header to opt into durable Web Push. The permission prompt and initial subscription are triggered only by that click. The server notifies for a completed response (including a cron/webhook-created **CRON** or **WEBHOOK** thread), a blocking `AskUser` question, and failed, cancelled, or interrupted runs. A test notification is queued immediately after registration. Notification clicks focus or open the exact same-origin conversation.

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

The picker is labelled **Next turn** because it is not evidence about the run
already on screen. The conversation header carries no run attribution. Below an
assistant message, the server-owned route marker appears for a normal run only
when the model that ran differs from the conversation's current selection. A
fallback warning always appears there, even when its answering model matches the
current selection, and names the requested and answering models plus the
runtime's classified reason when one was reported. Its disclosure shows the
bounded route chain, same-model retries, route effort, and Pi's effective thinking
level. Failed chains name the last attempt without claiming that it answered.
Raw provider errors and request identifiers remain outside browser payloads.

The dashboard header also has a separate **Agent settings** dialog for defaults used
when the web console creates a new conversation. Model and effort can each
inherit resolved config or be overridden. **Revert to config** clears both
overrides in one click.
Creation snapshots the effective pair into the new conversation, so later
settings changes never rewrite existing conversations. The layer applies only
to interactive web-console creation: Telegram, Slack, cron, webhook, API, and
TUI requests continue to use their own configured or request-scoped values.

When a process job or Monitor event must start a standalone revival turn, it
re-reads this conversation snapshot immediately before admission. A wake that
can be steered into the active run instead keeps that run's existing route.

The context control uses exact per-request measurements. The Pi runtime publishes a normalized `context_usage` telemetry event as each assistant message ends, so a tool-calling turn produces one measurement per provider request rather than one per turn. A percentage appears only when that same exact event carries the serving model's context window. Billing telemetry stays separate and is never converted into an occupancy measurement: `usage_update` is a single aggregate emitted once at the end of a run, carrying that run's cost and processed tokens. Durable message/tool-history storage size is never added to a provider measurement; only history actually sent in that request is already included by the provider.

In the header the control is a single percentage, because it shares one narrow row with the model picker on a phone. Token totals, measurement state, and cost all live in its popover; the percentage itself carries the state as colour, and its accessible name still reads the full summary aloud.

The header never calls an in-flight measurement current. A running turn is labeled **Updating** in the popover; failed, cancelled, and interrupted turns ignore their own snapshots and retain only the prior successful **Last measured** value. Changing the selected model also labels the previous model's value **Last measured** and names that measured model. A running or successful compaction invalidates every older value immediately, showing **—** in the header and **Awaiting** in the popover until a newer exact provider measurement arrives. A skipped or failed compaction does not invalidate the prior measurement. This is why an exact value may legitimately decrease after compaction.

The popover keeps aggregate last-turn processed tokens and accumulated conversation cost separate from context occupancy. Older conversations without exact telemetry show **—** and may still show their processed-token breakdown and cost; no aggregate number is converted into a context percentage.

Reported cost and processed tokens include what the run's subagents spent. A delegation is work the run asked for and is billed to the same account, so the Pi runtime folds each subagent's reported usage into the parent run's own before publishing it — which is also why the TUI status bar and the exported metrics agree with the console. The trade is attribution: a subagent running on a different model has its spend reported under the parent run's model, which is the right answer for a run total and the wrong one for a per-model breakdown.

Assistant reasoning, routine tool calls, subagent delegations, and context compactions share one compact **Activity** disclosure without changing their order. Each compaction is one row that updates from running to succeeded, skipped, failed, or interrupted instead of producing duplicate start/end rows. Pi's before/after token counts are estimates and carry a `~` prefix; provider summary text is never displayed. Activity opens while the message is running and force-collapses when the message completes, fails, is cancelled, or is interrupted; it can be reopened afterward, and individual tool payloads remain collapsed inside it. Standalone interactive tools remain outside the group.

A background `Exec` or `Bash` launch whose completed tool call contains the
exact persisted process-job receipt also shows lifecycle evidence in that
response's Activity. A start row requires a real start stamp: queued or starting
admission alone is not presented as running. Every terminal outcome gets one
row at the point its exact wake was consumed: where a wake steered into the
active assistant stream, or first in its follow-up assistant message. A wake
marker suppresses launch-adjacent terminal placement; without one, the terminal
row remains beside the launch as a fallback. Unavailable completion time,
duration, exit code, or signal is simply omitted. Association uses exact
job/tool/thread identity, never prose or timestamp proximity. Both the launch
response and card must be loaded, so legacy launches and paginated-out receipts
honestly remain stack-only.
Receipt-bearing launches stay as separate tool/event runs; ordinary adjacent
same-tool calls keep their existing grouping.

An `Agent` call is one foldable row inside Activity — profile name, the model's short task label, and a `4 tools · 12.4s · $0.0042` summary — that **owns** the tool calls its subagent made rather than listing them as siblings. The price appears when the runtime priced that subagent's model, and is the one place a single expensive delegation is identifiable; the run total it folds into cannot say which one spent it. Opening the row reveals each child call indented, individually foldable for its input and output, followed by the report the subagent sent back. Nesting keeps concurrent delegations readable when the provider overlaps them: their events interleave, so a flat transcript would shuffle several agents' work together. Pi 0.85 cannot overlap an `Agent` batch when any stateful/mutating or MCP tool is also offered because its scheduling mode applies to the whole harness. A child that failed is marked without marking the delegation that contains it, and a delegation whose parent call was never observed (a truncated or replayed stream) still renders from its children alone.

The child run's model and any fallback appear inside its own delegation row.
Parent and child routing attribution stay independent.

Every Activity row is one line at every width: the tool name and status hold their place and a long argument is truncated with an ellipsis, so a list of rows stays scannable rather than reflowing into a ragged block on a phone. Expanding a row reveals the full value. The nesting rails narrow below 560px and the settled Activity list scrolls with the page instead of inside its own box. Individual tool payloads stay height-capped and selectable so their output can still be copied on a phone, and they wrap within the panel rather than extending past it.

Background `Exec` and `Bash` jobs appear once in a stack after the loaded
transcript. Queued, starting, and running cards stay visible by default. Every
terminal outcome is hidden until the operator expands history; that choice is
remembered per conversation for the browser session. The header keeps neutral
active and history counts current because every loaded card remains mounted. If
older messages are available, the stack says its count covers loaded messages
and expanded history points to **Load earlier messages** rather than claiming a
whole-history total.

Each running card polls its exact source- and thread-bound projection once per
second in Full data mode and at the slower two-second Lean cadence, and shows a
redacted tail of roughly the newest 100 stdout/stderr lines. Polling pauses while
the tab is hidden and reads immediately when it returns. The card opens when the
first output appears. Collapsing it is sticky through later output and
settlement, and scrolling upward pauses bottom-follow until the tail is near the
bottom again. Live chunks remain memory-only in the agent; the web service does
not write each refresh to SQLite or broadcast it as a message delta. The same
bounded final tail remains behind the card after settlement.

Lifecycle rows never poll, expose output, offer cancellation, or repeat the
wake response. The separate stack remains the single live operational owner.

Type `/` in an empty composer to open the keyboard-friendly command popover for available actions such as run settings, starting a new conversation, or stopping an active response. Type `$` to find an available skill, or use **Browse skills** without entering a trigger.

## Reply files and MCP Apps

Assistant replies can include host-owned file or MCP App references when the
running agent advertises those additive operator capabilities. Reply files show
a message-bound download action; the service reauthorizes the exact
thread/message/part and the agent rechecks size and SHA-256 integrity before any
bytes stream. No host path or agent capability URL enters the browser DTO.

In an assistant reply, generated images are gathered below the answer, so a set of them reads as a set regardless of how the agent interleaved them with its prose.

A picture's bytes are bought once, whatever the transcript does around it. The
same image identity is fetched a single time and shared from one in-memory blob
cache rather than re-downloaded each time the message is re-projected, and a
picture starts loading as it comes within about a screen of the viewport instead
of on render. In Lean data mode nothing is bought until you tap the tile — for
the console's own stored copies as well — and the tile says what asking will
cost. A device-restored transcript holds no capability URLs, so its pictures
re-request access before they can be shown.

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
Its expiry is quantised down to a five-minute bucket, so a key lives between five
and ten minutes and the same picture asked for twice inside one bucket is the
same URL — which is what lets a running turn's transcript still answer `304`
instead of moving its ETag once a second. The bytes come back
`private, max-age=<what is left of the key>, no-transform` with
`Accept-Ranges: none`, so a second read inside that window is answered by the
browser itself.
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

The web state database is at schema 25. Schema 9 added the `message_search` FTS5
index and the triggers that maintain it, backfilled from existing messages on
first open. Schema 10 added an `origin` column to `attachments`, distinguishing a
file the operator uploaded from the console's own durable copy of an image the
agent generated. Schemas 11 through 17 carried per-conversation run overrides,
the provider summary an agent advertises, Monitor wake delivery receipts, and
discovery presence. Schema 18 adds `messages.seq`, the per-message write counter
a console compares against to tell the next delta from one it missed; existing
rows start at 0, which is exactly what a browser that has never seen a delta
holds. An earlier build numbered that column 17, so 18 also repairs that shape
without resetting sequence values already assigned. Schema 19 suppresses silent
cron projections at the storage read boundary. Schema 20 added the live agent's
provider-auth capability column so Agent settings receives it through
the same bootstrap projection as the rest of the agent summary. Schema 21 adds
the requested model and effort plus bounded runtime routing evidence to each
turn, so fallback attribution remains visible after reload. These migrations are
additive and transactional. Schema 22 adds the nullable
`live_inputs.dispatch_started_at` marker. The service commits that
marker before crossing the operator dispatch boundary: unmarked offers recover
as queued, while marked offers recover as terminal uncertainty and cannot be
promoted into an automatic next turn. Existing offered rows migrate with a NULL
marker, so their earlier dispatch history remains ambiguous. Schema 23 adds the
`web_submissions` idempotency ledger with payload digest, admitted kind,
turn/message/input associations, and durable product rejection reason. The
ledger survives archive and is removed only with permanent thread deletion.
Schema 24 adds two read-path indexes, `turns_by_thread_started` on
`turns(thread_id, started_at)` and `messages_by_turn` on `messages(turn_id)`,
so the per-thread run-state lookup behind the conversation list, bootstrap and
conversation detail no longer scans every turn and message of a long history.
The migration creates nothing else and changes no rows; on a store with a few
hundred conversations it completes in well under a second on first open.
Schema 25 adds `cron_reply_operations`, the durable owner of one terminal-run
Reply's immutable bounded snapshot, canonical import identity, pending
settlement, completion, failure, and deletion tombstone. It permits explicit
same-operation recovery without startup replay and prevents a late response
from exposing or resurrecting a deleted conversation. Back up the database
before upgrading. A schema-24 `@mono-agent/web` binary refuses the schema-25
database rather than reading it incorrectly; rollback requires restoring that
compatible pre-upgrade backup and therefore loses subsequent writes.

## Local state and reset

The service keeps its owner-private SQLite store, settings, notification idempotency ledger, VAPID private key, push subscriptions/outbox, upload stages, durable copies of generated images, logs, and live notification-ingress record under `~/.mono-agent/web/`. Stored messages, quote metadata, attachment metadata, revisions, run state, and pinned agents are local to this computer and independent from the agents' provider-side sessions. The browser also keeps a copy of its own in IndexedDB on that origin: the last eight conversations' transcripts, one listing row per agent view it has opened, and a snapshot of the agent list with the console's host identity, upload limits and push application key. That is what lets a cold start draw before the first request answers. **Clear cached data** in the command palette (⌘K) removes all of it, and so does clearing that origin's site data — the listing rows in particular are removed by nothing else, because ordinary use only ever adds to them. The service's own store is unaffected either way. That store is versioned (`mono-agent-web`, version 2) and every row records which tab wrote it, so a tab sweeps only its own rows and two open tabs cannot delete the conversation the other one is live in. It is bounded once per page load, as it is read: rows more than thirty days older than the newest row are dropped, conversations beyond the newest 24 are dropped oldest first, and listing rows belonging to agents no longer in the discovered fleet go with them. Nothing restored from the device is treated as current — a restored transcript draws immediately and stays marked stale until an ordinary conditional read confirms it — and a database written under a different console host identity is cleared rather than read. No capability URL is ever written to it, which is why a restored picture asks for access again before it can be shown. One thing **Clear cached data** cannot reach: reply-attachment bytes are served with a short private `max-age`, so the browser's own HTTP cache may still hold a copy on disk after the capability that fetched it has expired. That is the browser's private cache rather than console state, and clearing that origin's site data removes it. The unread marker is device-local in the same store: one revision number per conversation, recording what this browser has seen, written beside the console metadata and removed by **Clear cached data** and by clearing that origin's site data. Nothing about it reaches the service, and another browser signed in to the same console keeps its own. The selected data mode, notification opt-in, opaque subscription id, one-way endpoint digest, and unsent composer text (`mono-agent.web.composer-drafts`, see [Unsent composer text](#unsent-composer-text)) are intentionally browser-origin-local and are removed when that origin's site data is cleared. Raw push endpoints and key material are never stored in browser preferences.

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
preferences such as the notification opt-in, and it does not
remove an agent's config, durable conversation history, memory, or recorded run
artifacts, or agent-owned `.mono-agent/cron-control-v1/` runtime overrides,
audit, and idempotency state. After reset, browsers reconcile the missing or
rotated application-server key and subscribe again when permission permits;
cron channels rebuild from the running agents.

## Current scope

The web console covers discovery, configurable console identity, curated host themes, persistent multi-conversation chat, first-class cron channels, marked webhook notification conversations, structured `AskUser` forms, quoting, durable Web Push with a page-notification fallback, model/effort selection, streamed reasoning and tools, internal telemetry-backed context usage, cancellation, and attachments. It is responsive down to narrow phone widths and installable as a console-named PWA when served from a secure browser context.

General recorded-run replay and source-annotated configuration remain in the TUI. Use:

```bash
mono-agent tui
```

To change an agent, edit `mono-agent.config.json` or `IDENTITY.md`, run
`mono-agent validate`, restart the agent, and open the ordinary TUI if you want
to continue chatting.

## Session Recorder removed

The `mono-agent sessions` command that launched the read-only Session Recorder was removed. Use `mono-agent tui` (recorded-run replay) or `mono-agent web` (live console) for operator run inspection.

`@mono-agent/session-web`, the read-only `live` event relay, and their config/env surface have also been removed. `MONO_AGENT_WEB_AUTH_TOKEN` is no longer read by any code. See the [deprecation tracker](/reference/deprecations/#removed-surfaces).

## Related

- [CLI command reference](/observability/cli-reference/#web) — lifecycle and flags.
- [Terminal UI](/observability/tui/) — replay, live chat, and the config view.
- [TUI stream endpoint](/channels/tui/) — the default-on agent endpoint used for web chat.
- [Sessions and concurrency](/runtime/sessions-concurrency/) — how web threads map to harness conversations and provider sessions.
