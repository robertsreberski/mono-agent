# @mono-agent/web

The persistent browser console for mono-agent. It discovers every running local
agent, keeps multiple independent conversations in owner-private SQLite state,
and serves the assistant-ui PWA from one always-on process.

## Category

Category: `operator-surface`

## Responsibility

- Discover local agents through the shared trace-source registry and probe their
  loopback operator endpoints.
- Persist agents, threads, messages, structured reasoning/tool/telemetry parts,
  revisions, turns, attachments, and agent pin preferences under
  `~/.mono-agent/web`.
- Keep an upstream turn running when a browser reloads or disconnects, and expose
  state invalidations over SSE so any connected browser can catch up.
- Render a running agent's structured `AskUser` interaction as one complete web
  form and proxy validated answer submission back to that same model run.
- Accept browser-selected files through bounded staged uploads and forward the
  exact transport-neutral `AgentAttachment` contract used by Telegram.
- Serve the assistant-ui PWA and its versioned JSON/SSE API.
- Accept explicit cron/webhook `web:new` notification delivery through an
  owner-private, bearer-authenticated loopback ingress; persist one marked,
  assistant-only conversation per distinct result only after agent history is
  durably appended.

## Install / Usage

The `mono-agent web` command owns normal lifecycle management. The embeddable
server API is also available:

```ts
import { startWebServer } from "@mono-agent/web";

const server = await startWebServer(); // 0.0.0.0:5050
console.log(server.url);
await server.stop();
```

The interface is deliberately single-user and has no application login. Anyone
who can reach port 5050 can inspect conversations and operate discovered agents;
use host firewall/LAN policy and Tailscale ACLs as the access boundary. The
server emits no CORS permission and rejects cross-origin mutations.

Private IP literals, localhost, the machine hostname, and its exact `.local`
name are accepted as browser hosts. Set `MONO_AGENT_WEB_ALLOWED_HOSTS` to a
comma-separated list of any additional exact DNS names (for example the node's
Tailscale DNS name); suffix wildcards are intentionally not trusted. When a
managed agent protects its loopback operator endpoint, discovery reads only
`MONO_AGENT_TUI_API_KEY` from that agent's attested, owner-owned dotenv file.

On desktop, the agent rail has fixed compact and expanded layouts selected by
an explicit expand/collapse control. That choice is remembered by the browser.
Offline agents are hidden behind a subtle count by default; pinned agents and
the currently selected agent remain visible even while offline. The same
filter applies to the desktop rail, mobile picker, and command palette. Pin or
unpin with the star control; pins live in the web service so favorites stay
consistent over localhost, LAN, and Tailscale.

The assistant-ui run-settings popover combines searchable model selection with
the selected model's supported reasoning-effort choices and becomes a
viewport-safe bottom sheet on narrow screens. Usage telemetry remains internal
and is summarized through a context display that keeps the final provider
request's exact context snapshot separate from last-turn processed tokens and
conversation cost. Exact snapshots can decrease after compaction; legacy threads
show `Context —` instead of deriving a percentage from aggregate work. Structured
reasoning and routine tools share one stream-aware Activity disclosure that
collapses at every terminal message state without reordering answer parts.
Typing `/` in an empty composer opens the available command triggers.

Select rendered message text to quote it into the composer. One quote is kept
with the authored user message and supplied to the operator as Markdown
blockquote context; it does not rewrite the visible message text. The public
turn DTO exposes this as `quote: { text, messageId }`, and the source message
must belong to the same thread.

The header bell explicitly enables browser notifications for successful
responses that arrive while the console is hidden or unfocused. Notifications
include a short response preview and open the exact conversation. Permission
is requested only from the bell, the preference is browser-origin-local, and
the page/PWA must remain alive: this is not a Web Push subscription and does
not notify after the application is fully closed. Cron/webhook notification
threads use the same bell and are marked `CRON` / `WEBHOOK` in the sidebar,
header, and browser notification title.

An app-managed cron job or webhook endpoint can set `notify: true` with the
exact destination `notifyConversationId: "web:new"`. Each distinct result gets
a new thread without changing the selected thread. Delivery is idempotent,
best-effort, attempted once with a five-second bound, and has no outbox when the
web service is unavailable. Other `web:*` destinations are not accepted.

When the selected agent advertises `capabilities.askUser`, a running `AskUser`
tool call appears as one form containing all remaining questions. Each question
has two or three described choices plus an **Other** custom-reply field;
multi-select questions accept several choices and custom text. The browser
submits the form atomically and the agent resumes the existing run. Cancelling
the turn also cancels its pending form.

## Public API

<!-- public-api-inventory:start -->
<!-- Generated by scripts/generate-public-api-docs.mjs. Do not edit by hand. -->

Every symbol exported by each public code entrypoint is listed below.

**`@mono-agent/web`**

```text
CreateWebThreadInput
CreateWebUploadInput
DEFAULT_WEB_HOST
DEFAULT_WEB_PORT
DeliverWebNotificationInput
DeliverWebNotificationOptions
DeliverWebNotificationResult
DiscoverOperatorAgentsOptions
DiscoveredOperatorAgent
PatchWebAgentInput
PatchWebThreadInput
StartWebServerOptions
StartWebTurnInput
WEB_API_VERSION
WEB_MAX_ACTIVE_ATTACHMENT_TURN_BYTES
WEB_MAX_CONCURRENT_UPLOADS
WEB_MAX_FILES_PER_TURN
WEB_MAX_QUEUED_ATTACHMENT_TURNS
WEB_MAX_STAGED_UPLOADS
WEB_MAX_STAGED_UPLOAD_BYTES
WEB_MAX_TURN_ATTACHMENT_BYTES
WEB_STAGED_UPLOAD_TTL_MS
WebAgentStatus
WebAgentSummary
WebAttachment
WebBootstrap
WebConsoleError
WebEvent
WebEventType
WebMessage
WebMessagePart
WebMessageStatus
WebModelOption
WebNotificationTriggerKind
WebQuote
WebRunState
WebRunStatus
WebServerHandle
WebStatePathOptions
WebStatePaths
WebThread
WebThreadDetail
WebThreadTrigger
defaultTraceRegistryDir
defaultWebStateDir
deliverWebNotification
discoverOperatorAgents
isTrustedOperatorBaseUrl
operatorBaseUrlFromMetadata
prepareWebState
prepareWebStatePaths
resetWebState
resolveWebStatePaths
startWebServer
```

<!-- public-api-inventory:end -->

The primary exports are `startWebServer`, `prepareWebState`, `resetWebState`,
`defaultWebStateDir`, the versioned `Web*` DTOs, API/upload limit constants, and
the trace-registry discovery helpers. `startWebServer()` returns a handle with
the actual bound address/port plus idempotent `stop()` and `close()` methods.

The browser API is rooted at `/api/v1`:

- `GET /bootstrap`, `PATCH /agents/:id`, and `GET/PATCH /threads/:id`
- `POST /threads`, `/threads/:id/turns`, and `/threads/:id/cancel`
- `GET /threads/:id/ask` and `POST /threads/:id/ask` for the current structured
  `AskUser` snapshot and atomic answer submission
- `POST /uploads`, `PUT/GET /uploads/:id/content`, and `DELETE /uploads/:id`
- `GET /events` (SSE)

`GET /healthz` is intentionally outside the versioned API for service probes.
`POST /threads/:id/turns` accepts optional
`quote: { text, messageId }` metadata in addition to the authored `text`.

## Dependency Boundary

The server depends only on the `core` `@mono-agent/agent-contracts` and
`@mono-agent/config` packages, the `observability` trace-source registry, and
Express. Its compiled browser bundle additionally contains the production graph
from the isolated `webapp` lockfile: assistant-ui, Base UI, cmdk, React, and
Workbox plus their transitive dependencies. The repository advisory and license
gates audit that nested production graph separately because it ships inside this
package even though it is not part of the root pnpm workspace. Running agents
are reached over their loopback HTTP operator endpoints; this package does not
import a communication adapter or another operator surface.

## What This Package Does Not Own

- Agent runtime/provider execution or conversation history inside an agent.
- The operator-adapter HTTP server published by each agent.
- CLI background-process, launchd, or conflict-safe Tailscale Serve lifecycle.
- Session Recorder history/replay, which remains in `@mono-agent/session-web`.
- Authentication. Network reachability is the intentional security boundary.
- Host filesystem browsing: attachments come only from the browser device's
  native file picker.

## Verification

```sh
pnpm --filter @mono-agent/web run typecheck
pnpm --filter @mono-agent/web run test
pnpm --filter @mono-agent/web run build
```
