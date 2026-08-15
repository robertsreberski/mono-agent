# Release notes

## Unreleased

### ACP client interoperability

- The mono-agent ACP bridge now accepts standard client filesystem and terminal
  capability advertisements without delegating agent-owned execution, treats
  client working directories as advisory, and supports durable source-bound
  `session/resume` across bridge and source restarts. Session authorizations are
  owner-only and are revoked by `restart --clear-sessions`.

### Slack mention preservation

- Slack now preserves one authenticated readable self-mention marker in the
  current model-visible turn when `slack.stripMentionText` is unset. Explicit
  `true` retains legacy full stripping and explicit `false` retains raw mention
  forms; command recognition, bare mentions, attachments, live input, routing,
  and preceding thread context keep their established paths.
- Migration: configurations that supplied only `botUserIds` previously enabled
  stripping implicitly. Set `stripMentionText: true` to retain that output;
  omission now selects readable-marker preservation.

### Cron operator controls

- Added an opt-in, authenticated cron control console with confirmed run-now
  and runtime enable/disable actions, durable audit/idempotency state, and
  bounded run history and detail views.
- Cron configuration now fails closed above 64 merged jobs or when an
  operator-visible id, expression, timezone, or conversation id exceeds its
  documented UTF-8 byte limit.

### Session tool history

- Managed `tool_use` / `tool_result` stream blocks intentionally gain
  host-authored `history` metadata with opaque record identity, persistence,
  bounds, and terminal state; provider-authored lookalikes remain untrusted and
  are removed.
- A configured app intentionally keeps the canonical managed-tool sidecar and
  `SessionHistory` capability when a programmatic caller supplies a custom
  message-history store. The custom store remains the sole owner of messages;
  the sidecar remains a separate lifecycle contract.
- Lazy writer acquisition keeps one bounded restart-handoff attempt, then
  fails fast for the rest of already-started turns and re-arms once at the next
  new turn. A delayed real result safely supersedes a finalization/recovery
  result for the same call without creating a permanent conflict.

## 0.19.1 — Web Push delivery fix (2026-08-13)

### Web Push reliability

- Fixed Web Push delivery on supported Node releases by honoring the
  all-address DNS lookup callback contract while still pinning each request to
  one previously validated public address.

### Release coordination

- All 22 catalog-publishable packages move together to 0.19.1. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.19.0 — Web Push, console discovery, and host themes (2026-08-13)

### Reliable Web Push

- The web console now delivers standards-based Web Push notifications after
  the page is closed. A server-owned VAPID identity and SQLite outbox cover
  completed responses, input requests, terminal failures, cancellations,
  interruptions, and explicit test sends while keeping notification previews
  plain-text, redacted, and bounded.
- Foreground acknowledgements suppress redundant pushes for the console a user
  is actively viewing. Subscription repair, bounded retry, per-subscription
  circuit breaking, stale cleanup, and shutdown draining make delivery
  recoverable without creating a historical backlog.
- Push mutation APIs bind to the exact browser origin, public push endpoints
  must use HTTPS, and endpoint or key material is never returned by the API.
  The server and outbox remain self-hosted; browser delivery necessarily uses
  the browser vendor's push relay.

### Console discovery and identity

- Agents expose a bounded live skill registry to the console. The composer now
  autocompletes canonical `$skill-name` references and provides a searchable,
  keyboard-, pointer-, touch-, mobile-, and screen-reader-friendly skill
  browser that inserts a reference without sending the message.
- The web console shows its operating-system host name in the shell, browser
  title, and installable PWA identity. Managed consoles can select evergreen,
  ocean, plum, or terracotta with `mono-agent web --theme`, and retain the
  chosen theme across restarts.

### Read image normalization

- Built-in `Read` image results with an edge above 8,000 pixels are normalized
  before provider embedding. Resizing preserves aspect ratio, source files,
  safe existing bytes, image formats, and GIF/WebP animation; resized BMP
  input becomes PNG and undecodable images fail before an image block is made.

### Release coordination

- All 22 catalog-publishable packages move together to 0.19.0. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.18.3 — Subagent web inheritance, ledger collapse, and transport causes (2026-08-12)

### Subagent web configuration

- Subagents now inherit the parent's `tools.web.search` and `tools.web.fetch`
  configuration. A child runs outside the harness and builds its own web
  controller, so with nothing threaded it received `searchConfig: undefined`
  and silently fell back to the keyless search backend — which rate-limits into
  a cooldown where every subsequent query fails in milliseconds.
- The failure was invisible from the parent, which kept using its configured
  backend normally. In one run the parent completed 40 searches on a loopback
  SearXNG endpoint with no errors while all 33 subagent searches failed on
  DuckDuckGo/Startpage, and two subagents spent 150+ tool calls each exhausting
  their whole time budget without returning anything.
- Browser rendering (`tools.web.fetch`) is inherited by the same path, so a
  child no longer loses `render: "auto"` and fall back to static-only
  extraction on client-rendered pages.

### Provider transport diagnostics

- Opaque provider transport failures now name their real reason. Node's fetch
  reports a cut response body as the single word `terminated`, keeping the
  actual cause (`UND_ERR_BODY_TIMEOUT`, `ECONNRESET`, `other side closed`) only
  on `error.cause` — which pi-agent-core discards before any runtime code sees
  the Error. Such a run failed, retried, and exhausted its fallback chain with
  no way to tell a stalled stream from a dropped socket.
- The pi bridge now resolves the underlying code from the error's own cause
  chain where the object survives, and otherwise from a bounded
  `undici:request:error` diagnostics-channel probe. Messages become
  `terminated (UND_ERR_BODY_TIMEOUT)`; correlated (rather than exact) matches
  are labelled as such, and a window holding conflicting codes reports nothing
  instead of guessing. Only contentless messages are annotated — descriptive
  provider errors are left alone.
- Run diagnostics gain `provider_transport_error_code` and
  `provider_transport_error_source` when a cause was recovered. Failure
  classification and retry subkinds are unchanged.

### Chat ledger subagent groups

- A subagent group in the Telegram/Slack activity ledger now collapses as soon
  as that subagent reaches a terminal state: its child tool lines are removed
  while the header keeps the total tool count and duration. Subagents that are
  still running stay expanded, so one finished delegation no longer buries the
  live ones.
- A settled row may carry one optional secret-redacted `Result` or `Reason`
  line, normalized to a single line and capped at 120 Unicode code points. A
  lifecycle completion can collapse the group first and a later parent `Agent`
  completion may enrich it, but a terminal group is never re-expanded.

### Release coordination

- All 22 catalog-publishable packages move together to 0.18.3. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.18.2 — Provider-native subagent visibility and isolation (2026-08-03)

### Native subagents

- Claude SDK and Claude Code CLI runs now normalize live native child events
  into one `subagent_activity` contract. Child prose, tools, usage, and
  structured output stay out of the parent answer while the harness, TUI, and
  web console can render the complete nested lifecycle.
- Claude SDK filesystem settings remain disabled by default. Hosts can opt into
  trusted user, project, or local settings with `settingSources`; the CLI keeps
  its native discovery behavior. The live normalizer handles delayed task
  identities, background completion, concurrent launches, and unfinished
  tools without transcript-file replay.
- Codex app-server collaboration remains provider-owned. The runtime observes
  nested child threads, isolates them from the root turn, binds configured MCP
  approvals to the active child turn, and fails stale retained-session
  callbacks closed. Caller-defined Codex teammate profiles are rejected as a
  capability mismatch; `codexLoadProjectDocs` separately enables repository
  instructions for Codex and its native agents.
- The built-in Pi `general-purpose` helper now intersects its read-only default
  tools with the host's inline allowlist and fails closed when that intersection
  is empty. Explicit configured profiles keep their authored contracts.

### Routing and public contracts

- `@mono-agent/runtime-adapter` exports the exact native-subagent identity,
  phase, event, and type-guard contract used by every consumer.
- Router attempt resolvers may return the narrow `policyOptions` bag to project
  `allowedTools`, `disallowedTools`, and `permissionMode` for the provider
  actually attempted without replacing other protected request fields.

### Release coordination

- All 22 catalog-publishable packages move together to 0.18.2. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.18.1 — ACP handle confidentiality and lifecycle hardening (2026-08-02)

### Agent Client Protocol

- ACP provider-session ids and pagination cursors are now confidential,
  authenticated v2 handles. Hosts supply one persistent 32-byte binary key;
  the runtime encrypts raw remote values, binds every token to its profile and
  kind, and rejects missing-key, legacy-v1, tampered, wrong-key, cross-profile,
  and cross-kind values before profile resolution or process launch.
- ACP SDK payload-bearing diagnostics are guarded only while an owned ACP
  transport processes input. Malformed or hostile notifications can no longer
  copy form responses or URL credentials into process-wide console output, and
  concurrent non-ACP console behavior remains unchanged.
- `@mono-agent/runtime-adapter` now exposes the ACP handle key on its host and
  run contracts, and requires it for session list/delete controls. Key material
  is defensively snapshotted across asynchronous callbacks and derived cipher
  keys are cleared after construction.

### Release coordination

- All 22 catalog-publishable packages move together to 0.18.1. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.18.0 — ACP clients and mono-agent exposure (2026-08-02)

### Agent Client Protocol

- `@mono-agent/agent-runtime` adds a product-neutral ACP v1 stdio client and a
  sixth runtime bridge. Hosts resolve `acp:<profile-id>` references into exact
  argv, environment, ownership, capability, session, and process policies; the
  runtime handles initialize, new/load/resume, prompt updates, semantic
  cancellation, permissions, elicitation, authentication, logout, and session
  management without persisting host interaction values.
- `@mono-agent/runtime-adapter` exposes the same ACP connection, management,
  profile-id, and provider-session helpers through its supported facade.
- `mono-agent bridge acp --discover` returns sanitized, versioned descriptors
  for installed agents, and `mono-agent bridge acp --source-id <id>` exposes a
  selected running instance as an ACP v1 core-session bridge. It supports text
  and resource-link input, updates, cancellation, and form elicitation while
  keeping configuration, workspace, MCP, tools, and credentials agent-owned.
  Client-supplied MCP servers, client filesystem/terminal methods, media
  attachments, and additional directories remain explicitly unsupported.

### Release reliability

- The `create-mono-agent --help` delegator now maps to the supported init help
  command, so the published-CLI release smoke tests the actual bin symlink and
  exits successfully.
- All 22 catalog-publishable packages move together to 0.18.0. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

### Subagents: the `Agent` tool

- The main agent can now deploy independent subagents on the pi runtime. `Agent`
  takes `{prompt, name?, description?}`, resolves `name` against
  `subagents.definitions[]` or falls back to a read-only general-purpose
  researcher, and returns the subagent's final answer plus a compact
  per-tool-call activity log capped at roughly 24KB.
- Requires BOTH `subagents.enabled: true` and `Agent` in `tools.allowedTools`;
  `mono-agent validate` warns when only one half is set.
- Every subagent tool call streams live to the TUI and web console as
  `<profile>▸<tool>`, bracketed by the subagent's own start/finish rows. Ids
  are namespaced per subagent so concurrent helpers running the same tool stay
  distinct. No wire-schema change and no TUI/web changes were needed.
- `maxConcurrent` (default 5) bounds simultaneous subagents; `maxPerTurn`
  (default 20) bounds the total per turn and is the real runaway guard. Each
  subagent gets `maxTurns` (100) and `timeoutMs` (5 min), and its timeout starts
  only once it begins rather than while queued.
- Subagents are read-only unless a profile enumerates more, never receive
  `Agent`/`AskUser`/channel-send tools, get no MCP servers unless named, inherit
  the sandbox without being able to widen it, and cannot spawn subagents.
  A profile without a `model` inherits the parent's configured route, so
  subagents get the fallback chain and same-model retries too.


### Same-model retries before failover

- A fallback route can now retry itself before the chain advances.
  `runtime.retry.primaryAttempts` (default `2`) sets the total attempts on
  `runtime.model` including the first, and each `runtime.fallbacks[]` entry
  takes an optional `attempts` (omitted = single shot). `runtime.retry.backoffMs`
  doubles per retry, capped by `runtime.retry.maxBackoffMs`. Set
  `primaryAttempts: 1` to restore the previous single-shot behavior.
- Retries fire only for transient provider failures — overloaded, rate-limited,
  timeout, network, 5xx, and terminated streams. `context_limit` and
  `provider_auth` still advance immediately, because a second identical request
  against the same window or the same credentials cannot succeed. Cancellation
  and mid-turn sandbox/safety failures never retry.
- Agents with no configured backups now get a retry-only single-entry chain, so
  the primary-retry default applies to them too.
- A retry drops the route's provider session (the failed attempt already
  appended to it), emits the new `provider_status` kind `retry_started` rather
  than a failover event, and appends its own `failoverHistory` entry carrying
  `retryIndex` with its own request id and failure subkind.
- The router retry is a whole-turn retry layered outside each bridge's transport
  retries. On a `pi` primary the defaults allow up to six provider stream starts
  (2 router attempts x 3 pi stream tries); lower
  `providers.piNative.piMaxRetries` when raising `primaryAttempts`.
- `mono.agent.failover.count` now counts failed provider attempts rather than
  route transitions, so a primary-then-fallback run reports `2` where it
  previously reported `1`.

### Fixes

- `provider_status.from` / `.to` are populated again. The router emitted model
  references as objects while the responder read them as strings, so both fields
  were silently dropped and the TUI rendered `failover ? -> ?`.

## 0.17.1 — Pi authentication fallback recovery (2026-08-02)

### Runtime routing

- Pi's `Provider is not configured: <provider>` error is classified as
  `provider_auth` when credential resolution returns no usable credential.
  Router chains now advance to their next provider instead of stopping on a
  non-retryable `provider_unavailable` result.
- The regression guard exercises the real Pi `openai-codex` harness path with a
  null credential resolver, in addition to the shared failure classifier.

### Safety and compatibility

- The new signature is narrow and remains non-retryable on the same route;
  only configured fallback entries may run next.
- All catalog-publishable packages move together to 0.17.1. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.15.3 — Configured Codex MCP approvals (2026-07-28)

### Direct Codex MCP calls

- Direct Codex now accepts its synthesized `mcp_tool_call` elicitation only
  when the server name matches a valid MCP server explicitly forwarded by the
  runtime. Plan-mode calls can therefore reach configured Worklab-style tools
  without aborting the turn.
- Unknown or inherited servers, invalid server definitions, genuine downstream
  MCP form/URL elicitations, unrelated app-server requests, and exact no-tool
  probes remain fail-closed.

### Safety and compatibility

- Documentation now makes the authorization boundary explicit: direct Codex
  `permissionMode: "plan"` constrains Codex-owned command and filesystem work,
  but does not sandbox side effects implemented by a declared MCP server.
- All 22 catalog-publishable packages move together to 0.15.3. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.15.2 — Wildcard tool-policy compatibility (2026-07-28)

### Runtime policy discovery

- Built-in runtime bridges now report whether they project named tool policy or
  support only unrestricted tool access. Pi, Claude SDK, and Claude Code report
  `projected`; direct Codex and direct OpenCode report `allow_all_only`.
- Custom structural bridges may omit the capability, preserving compatibility
  while allowing hosts to reject unsupported routes before provider startup.

### Safety and compatibility

- Any `allowedTools` list containing `"*"` now has consistent allow-all
  semantics. Mixed forms such as `["*", "Read"]` work on direct Codex and
  OpenCode and no longer narrow Claude CLI projection by accident.
- Named-only allowlists, empty allowlists, and non-empty denylists remain
  fail-closed on providers that cannot project tool policy. The exact no-tool
  Codex readiness probe and `tools: "exact-allow-all"` telemetry token retain
  their existing contracts.
- All 22 catalog-publishable packages move together to 0.15.2. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.15.1 — Provider interoperability and bounded teardown (2026-07-28)

### Runtime interoperability

- `@mono-agent/agent-runtime/ai` now owns the supported Pi model catalog,
  reasoning-level, and OAuth boundary. Consumers can remove direct Pi imports
  while the runtime keeps its Pi dependencies exact-pinned and returns isolated
  model and credential snapshots.
- Claude SDK tests can inject `RuntimeRunOptions.claudeAgentQuery` without
  package-level module mocks. Production calls still use the runtime-owned
  Claude Agent SDK, preserving its intentional separation from Pi's Anthropic
  SDK dependency.

### Reliability and compatibility

- Codex app-server runs now settle when the transport closes or aborts while a
  live-input iterator is pending. Throwing acknowledgement and rejection
  callbacks are isolated from the provider result and reported as bounded
  warnings.
- The inert `toolPayloadCompactionTriggerChars` and
  `toolPruneTriggerTokens` policy fields are removed. `ReadSkill` continues to
  return complete instructions by default; callers may opt into an explicit
  positive `maxChars` cap.
- All 22 catalog-publishable packages move together to 0.15.1. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.15.0 — Live steering and precise runtime activity (2026-07-22)

### Highlights

- Plain-text follow-ups sent while an agent is working can now steer the active
  turn from Slack, Telegram, and the web console. The adapter-neutral live-input
  contract carries provider acknowledgement through Claude SDK, Codex
  app-server, and Pi runs, while unsupported providers and end-of-turn races
  queue the message as the next ordinary turn instead of losing it.
- The web console persists live follow-ups and their pending, applied, queued,
  or cancelled state in its owner-private SQLite store. Applied guidance is
  committed to canonical conversation history and memory, so reloads, restarts,
  and later turns preserve what changed the answer.
- Pi, Codex app-server, and OpenCode app-server now publish exact provider-native
  context measurements and normalized compaction lifecycles. The web console
  renders measured usage and one update-in-place compaction activity row without
  exposing provider summaries.

### Reliability and security

- The v1 closeout removes the retired `session-web` / live-relay vertical and
  other proven-dead compatibility APIs, narrows controller, lifecycle, doctor,
  memory, and Slack ownership boundaries, and makes config validation and the
  final CI verdict explicit.
- Runtime shutdown/backpressure, managed web logs, orphan cleanup, artifact
  credential scanning, dependency audits, and packed-package verification are
  now bounded and executable repository gates.
- Slack AskUser cards use unique Block Kit action identifiers, and long web
  conversation lists remain independently scrollable so the composer stays
  visible at desktop and mobile viewport sizes.

### Compatibility

- Existing Slack, Telegram, and web configurations require no migration for
  live steering. Attachments continue through the ordinary queued-turn path;
  each live follow-up is bounded to 8,000 characters.
- The retired `@mono-agent/session-web` package is no longer part of the
  publishable catalog. All 22 remaining catalog-publishable packages move
  together to 0.15.0; keep every `@mono-agent/*` package and
  `create-mono-agent` on the same exact version.

## 0.14.0 — Durable conversations and self-healing agents (2026-07-21)

### Highlights

- `AskUser` is now one adapter-neutral structured interaction across the web
  console, Slack, and Telegram. It supports one to five questions, described
  choices, custom replies, and multi-select forms while preserving the logical
  producer's history and targeting the physical channel conversation.
- Cron and webhook results can create dedicated, marked web-console
  conversations through the explicit `web:new` destination. Successful
  deliveries append durable agent history, preserve the selected thread, and
  use authenticated, idempotent loopback ingress.
- `RunHistory` now searches logical conversations across daily rollover
  buckets, with compact overviews, cursor-paged timelines, and guided follow-up
  calls that avoid recursive history payloads.

### Reliability and documentation

- Managed macOS LaunchAgents gain an authenticated self-healing controller that
  checks worker/runtime identity at login and every five minutes, stages safe
  replacements while the existing worker serves, retries failed recovery, and
  still respects an explicit stop.
- `@mono-agent/docs-mcp` now exposes the unified `mono_agent_docs` search/read
  tool with heading anchors, source offsets, offline link targets, and exact
  previous/next continuation actions over the version-matched corpus.
- The final-agent demo no longer imposes a positive turn cap by default;
  `runtime.maxTurns` remains available as an explicit opt-in. Package READMEs,
  generated API inventories, link checks, and website accessibility coverage
  have also been standardized across the publishable set.

### Compatibility

- The documentation MCP's former `search_mono_agent_docs` tool is replaced by
  `mono_agent_docs` and its v2 response schema; exact-version consumers should
  update the configured tool name with this release.
- The scheduled CLI compatibility spellings `restart --force`, `metrics`, and
  `audit-runs` are removed. Use `restart --clear-sessions`, `runs report`, and
  `runs audit --artifacts <path>` respectively. The unrelated `--force` flags
  on `install-skill` and `web reset` remain supported.
- All 23 catalog-publishable packages move together to 0.14.0. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.13.0 — Native channel controls and safer operator workflows (2026-07-20)

### Highlights

- Slack and Telegram now provide native model and reasoning-effort selectors
  derived from the configured primary and fallback models. Slack supports both
  mention commands and workspace-registered `/<bot-username>-model` and
  `/<bot-username>-effort` commands, with DM-wide, channel-wide, and
  thread-local override scopes.
- Slack now matches Telegram's final-answer delivery: transient, redacted tool
  activity remains a separate progress message, the completed answer is posted
  as a fresh message, and the progress message is then removed best-effort.
- The new `@mono-agent/docs-mcp` companion provides version-matched semantic and
  exact-identifier search over the bundled mono-agent documentation.
- The always-on web console gains clearer agent navigation, response status,
  browser notifications, quoted-reply rendering, and the canonical `/gui`
  operator route.

### Reliability and security

- Managed runtime startup and restart readiness are faster and stricter, while
  Pi's SRT launch path enforces the configured all-network sandbox and preserves
  system DNS resolution.
- Runtime failover survives re-initialization against loopback MCP endpoints,
  indexed skills prefer the dedicated `ReadSkill` path, and Slack markdown/tool
  previews no longer expose internal sentinels or absolute paths.
- Telegram file delivery remains bound to the originating chat, and its
  interactive sessions retain durable reply history across control actions.

### Compatibility

- Slack slash commands require the bot `commands` scope plus registered
  `/<bot-username>-model` and `/<bot-username>-effort` commands. Socket Mode
  carries both command and menu payloads, so no public request URL is needed.
- The CLI now uses grouped help and uniform JSON/exit-code contracts; deprecated
  command shims and the legacy read-only `sessions` command have been removed.
- All 23 catalog-publishable packages, including the new
  `@mono-agent/docs-mcp`, move together to 0.13.0. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.12.0 — Always-on web console and resilient agent sessions (2026-07-17)

### Highlights

- `mono-agent web start` installs an always-on assistant-ui browser console for
  every locally discovered agent. The service owns its conversations and
  in-flight turns, persists owner-private state and uploads, and keeps work
  running across browser reloads or disconnects.
- The Pi runtime adds the managed `NodeRepl` tool: a run-scoped JavaScript REPL
  with multiline input, top-level `await`, workspace package resolution, and
  the same native-sandbox boundary as `Bash`.

### Reliability

- Pi compaction now treats a still-overflowing context as `context_limit`,
  preserving typed failure evidence and allowing the configured fallback chain
  to recover instead of terminating as an unclassified provider error.
- TUI self-configuration remains attached to the same marked conversation
  after approvals, rejections, proposal-free turns, `done`, and `no changes`.
  Only an explicit exit leaves configuration mode, while successful changes
  restart the managed agent and reconnect to the proven fresh endpoint.

### Compatibility and security

- `mono-agent web` now owns the persistent chat console; the previous read-only
  run browser remains available as `mono-agent sessions`.
- The web console listens on `0.0.0.0:5050` by default for trusted LAN and
  Tailnet use and deliberately has no application login. Use `--loopback` when
  network peers must not have owner-equivalent access, and do not expose it to
  an untrusted or public network.
- `NodeRepl` joins the Pi bridge's managed allow-all tool set. Restrictive tool
  policies must name it explicitly when JavaScript evaluation is desired.
- All 22 catalog-publishable packages, including the new `@mono-agent/web`,
  move together to 0.12.0. Keep every `@mono-agent/*` package and
  `create-mono-agent` on the same exact version.

## 0.11.6 — Configurable A2A request bodies (2026-07-17)

### Added

- A2A providers can set `provider.maxRequestBytes` or
  `MONO_AGENT_A2A_MAX_REQUEST_BYTES` when authenticated task envelopes exceed
  the SDK's default request-body size.
- Configured JSON-RPC and REST routes authenticate before parsing and return
  protocol-shaped errors for oversized or malformed JSON bodies.

### Compatibility

- Omitting the setting preserves the A2A SDK default. Configured values must be
  integers from 1,024 through 100,000,000 bytes.
- All 21 catalog-publishable packages move together to 0.11.6. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.11.5 — Transient tool activity without thought clutter (2026-07-17)

### Added

- Interactive Slack and Telegram replies now expose tool starts in one
  cumulative, redacted status message while the agent works. Adjacent duplicate
  calls are compacted, and the same message is replaced by the final answer.
- `showHints: false` remains the opt-out for these activity previews. Proactive
  deliveries do not create a ledger, and acknowledged cancellation removes a
  still-transient status message on a best-effort basis.

### Fixed

- Pi streams and the OpenAI-compatible API no longer synthesize messages such
  as `Running Bash...` into assistant reasoning. Structured tool events and
  genuine model thoughts remain available to their intended consumers.

### Compatibility

- Existing Slack and Telegram configurations require no changes. Preview text
  is bounded and redacted before delivery.
- All 21 catalog-publishable packages move together to 0.11.5. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.11.4 — Hardened runtime operations and bounded state (2026-07-17)

### Highlights

- Webhooks now support static bearer authentication through `webhook.apiKey` /
  `MONO_AGENT_WEBHOOK_API_KEY`. Non-loopback binds require both explicit
  opt-in and a key, while endpoint-specific `maxRunMs` values can override the
  adapter watchdog.
- Managed macOS launchd instances now bound stdout and stderr automatically:
  active files plus three retained generations are capped at 5 MiB each and
  checked every five minutes. `validate` and `doctor` report the safely
  inspected inventory.
- Running observability artifacts checkpoint after 25 events or five seconds.
  Retention also sweeps orphaned atomic temporaries, exporter buffers are
  bounded, and sensitive exports can opt into high-confidence content-pattern
  secret redaction.
- Confirmed Slack and Telegram sends are appended to the destination
  conversation history, so later replies and cold replay include what the user
  actually received. TUI replay also renders recorded session boundaries.
- Slack's code-only `silent` delivery option is now explicit: both proactive
  sends and message streams accept the request, warn once that Slack cannot
  suppress bot-post notifications, and post with normal notification behavior.

### Reliability

- Durable A2A admissions publish atomically; continuation migration and
  rollback recovery are hardened; notification fallbacks are resolved and
  cancellation-bound per run rather than retained from process startup.
- Cold durable Pi resumes seed canonical history structurally only when a
  transcript must be recreated, avoiding duplicated or omitted turns.
  `restart --force` now removes both Pi transcripts and canonical active
  conversation history for a genuine fresh start.
- Memory maintenance now keeps read-only opens side-effect free, bounds replay
  guards and Supermemory completion fingerprints, normalizes proven embedding
  transport failures without swallowing programming errors, and retains at
  most three explicit-forget backups for 30 days while preserving active
  recovery state.
- OpenAI-compatible streaming caps serialized tool-result SSE frames at
  256 KiB and warns when sampling parameters are ignored. WhatsApp preserves
  FIFO handling per chat while allowing independent chats to progress
  concurrently.
- Release assurance now checks package-count drift, root workspace pins,
  exact known-compatible Pi dependency pins, explicit release-age policy,
  high-severity advisory dispositions, and isolated packed-consumer installs.

### Security

- Runtime-adapter sandbox injection is authoritative, and native Node launcher
  trust checks prevent caller overrides and unsafe launcher substitution.
- Network adapters recheck the actual resolved bind address; Pi OAuth stores
  refuse symlinked paths; managed-runtime provenance is bound to the verified
  dependency closure and rejects hardlinked runtime files.
- Session Web markdown rendering is hardened against adversarial fragments.
  Slack credential logging is redacted, and repository secret scanning now
  recognizes Telegram Bot API tokens, including token-bearing URLs.
- Shared owner-private publication, locking, replacement, and redaction
  primitives fail closed on FIFOs, link swaps, interrupted publication, and
  unsafe recovery races.

### Compatibility

- Existing loopback-only webhooks remain unauthenticated unless `apiKey` is
  configured. Existing non-loopback webhook deployments must add an API key;
  endpoint watchdog overrides are optional.
- Proven-dead compatibility exports were removed, including TUI cancellation
  aliases and `TUI_PACKAGE_VERSION`, Session Web's `listInstanceSessions`,
  Slack's redaction wrapper, Telegram's no-op `showThoughts`, unused
  wizard/readiness/runtime helpers, and legacy memory distillation,
  entity-extraction, vector-index, and recall-factory surfaces.
- The deprecated `recipes` command, `--recipe` init/validate alias, and CLI
  `--fallback-models <csv>` flag remain supported in 0.11.4 and are scheduled
  for removal in v2.0.0. JSON `runtime.fallbackModels`, the matching environment
  input, and legacy tool-policy aliases are not scheduled for removal.
- All 21 catalog-publishable packages move together to 0.11.4. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.11.3 — Configurable Pi provider transport (2026-07-16)

### Added

- Adds a typed Pi-native transport preference with `auto`, `sse`, `websocket`,
  and `websocket-cached` modes through `providers.piNative.transport`,
  `MONO_AGENT_PI_TRANSPORT`, and the programmatic `piTransport` run option.
- Reports the normalized requested mode as
  `diagnostics.pi_transport_requested` on every Pi result path.

### Reliability

- Keeps an explicitly configured host transport authoritative over
  request-scoped runtime extensions while allowing an extension to choose the
  transport when the host leaves it unset.
- Preserves Pi's provider-specific compatibility and fallback behavior by
  defaulting to `auto`; providers without multiple transports ignore the
  preference.

### Compatibility

- Existing configurations require no changes. Set the new field only when a
  provider supports or requires an explicit transport.
- All 21 catalog-publishable packages move together to 0.11.3. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.11.2 — Reliable native-notify continuations (2026-07-15)

### Fixed

- Preserves the logical cron or webhook conversation for durable history while
  binding continuation follow-ups to the host-resolved physical notification
  destination.
- Applies webhook notification precedence consistently: configured destination,
  deliverable request conversation, then a uniquely inferred fallback.
- Keeps physical reply destinations host-only and out of model-visible prompts.

### Compatibility

- No configuration changes are required. Existing explicit notification
  destinations continue to take precedence.
- All 21 catalog-publishable packages move together to 0.11.2. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.11.1 — Release provenance and continuation documentation (2026-07-15)

### Fixed

- Reconciles the repository release history with the already-published 0.10.0
  and 0.11.0 package sets, preserving their original commits and tags.
- Clarifies that interactive continuation delivery synthesizes from the
  immutable origin snapshot prepared and bound by the originating run, rather
  than reconstructing context from mutable latest history.

### Compatibility

- Runtime behavior is unchanged from 0.11.0; this patch release carries the
  documentation correction and a complete, traceable lockstep release surface.
- All 21 catalog-publishable packages move together to 0.11.1. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.11.0 — Durable conversation and continuation context (2026-07-14)

### Highlights

- Configured agents now keep the latest 64 messages for each exact conversation
  id in an owner-only, disk-backed history store. The bound is independent of
  `runtime.maxTurns`, and cold processes recover the history without requiring
  provider-session resume.
- Interactive continuation claims pin one immutable origin snapshot before the
  origin turn commits. The host closes and drains claim admission, prepares the
  bounded snapshot, finalizes its durable binding, activates the whole origin
  group only after successful commit, and abandons pending claims when the
  origin fails.
- Continuation synthesis consumes the pinned snapshot and preserves an explicit
  prior-day rollover bucket. It no longer depends on mutable latest history
  that can disappear on restart or be rebucketed after midnight.
- Missing, abandoned, legacy, or unreadable/corrupt origin snapshot blobs use
  one fixed zero-model response instead of an unbounded history-read retry
  loop. An invalid immutable binding HMAC is treated as state tampering and is
  dead-lettered without native delivery. Status exposes the origin-context
  state and the `origin_context_unavailable` completion kind.
- Per-record continuation state moves to v3 with content-addressed owner-only
  snapshot blobs, a 256 MiB aggregate blob quota, digest/HMAC binding,
  crash-recoverable group activation, stricter filesystem identity checks, and
  an old-reader rollback guard.
- Durable Pi resume is now coordinated by the canonical history record. Before
  a provider can mutate JSONL, history fsyncs a separate bounded dirty fence
  under a cross-process conversation lock without changing or pruning
  canonical history. A successful turn fsyncs the provider file and directory,
  atomically commits history with the clean epoch and transcript revision, then
  clears the fence. Processes compare that revision with their warm handle and
  cold-reopen every unconfirmed handle—even after a harness reload with an
  empty local map—so serialized A/B/A writers cannot branch from outdated
  process memory. Missing, legacy, fenced, host-only-appended, or
  unsynchronized state rotates a random provider epoch.
- Provider sessions are explicitly invalidated when any pre-history commit
  stage fails. Durable Pi invalidation waits for JSONL deletion and parent
  directory fsync, propagates cleanup failures, and blocks cold reopen while
  cleanup is in flight. History rotation and retention also retire every exact
  cold/live provider id before it becomes unreachable; dirty fences double as
  crash-recovery retirement journals, while a fence whose canonical revision
  proves the turn committed is cleared without deleting its valid transcript.

### Compatibility

- The configured app's default history changes from a process-local 12-message
  (or `2 * maxTurns`) window to a restart-durable 64-message window. Programs
  that inject `historyStore` retain their custom behavior. Default files live
  in the owner-only `history/` directory next to the configured artifact
  directory; each serialized message is capped at 64 KiB.
- The default history store is bounded across conversations as well: 256 MiB,
  10,000 conversations, and 365 days of inactivity. It stages and fsyncs a
  completed turn before the semantic commit, never evicts committed history on
  prepare/abort, and independently caps all live unpublished stages at 256 MiB
  by default (`maxStagedBytes` can tune the programmatic store). Dead or
  markerless stages are reclaimed immediately, including after an abort-cleanup
  failure. It prunes oldest inactive files only after publication and uses
  an owner-only fixed 16-shard cross-process lock table so separate
  channel/worker processes cannot lose same-conversation or root-retention
  updates or create unbounded lock files. Legacy per-conversation SQLite locks
  are honored without unlinking or creating new ones. Failed fresh turns leave
  a bounded crash fence rather than a counted history record, so they cannot
  evict successful conversations; inactive fences carry the exact provider id
  needed for fail-closed reclamation.
- Programmatic custom history stores that do not implement
  `beginProviderSessionTurn` and advertise fail-closed provider-session
  retirement keep ordinary process-local warm sessions, and the harness
  deliberately withholds `piSessionsRoot`: crash-safe durable provider resume
  requires both the history-owned epoch transaction and exact-id transcript
  retirement. Ordinary host-only history appends retire and rotate that epoch
  before a later model turn.
- Interactive origin snapshots retain at most 64 messages, 64 KiB of content
  per message, and 256 KiB total. If the completed origin turn cannot fit, the
  origin request fails before success is committed; older whole turns are
  evicted first under ordinary size pressure.
- Opening an existing v1/v2 continuation store migrates it idempotently and
  installs a guard that makes 0.10 and older runtimes fail closed. Do not remove
  the guard or point an older runtime at upgraded state; restore the complete
  pre-upgrade state directory for a runtime rollback.
- Legacy interactive records that lack an immutable snapshot cannot recreate
  past context retroactively. They remain idempotently recoverable and deliver
  the deterministic zero-model fallback.
- All 21 catalog-publishable packages move together to 0.11.0. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.10.0 — Durable A2A lifecycle joins (2026-07-14)

### Highlights

- A2A consumers can now admit a logical dispatch with a mandatory stable
  `idempotencyKey` and receive a lifecycle handle containing the current
  authoritative projection, an independently abortable terminal observer, and
  an explicit cancellation operation.
- Terminal observation rejoins the original provider admission with the same
  canonical request. Stopping or timing out an observer does not cancel remote
  work, while explicit cancellation remains a separate, auditable authority.
- Terminal outcomes are discriminated as completed, failed, canceled,
  rejected, authentication-required, or input-required and retain the final
  response for bounded orchestration decisions.
- The top-level `dispatchA2AMessage` helper and exported lifecycle types make
  restart-safe broker reconciliation available without exposing provider
  internals.

### Compatibility

- Existing `sendA2AMessage`, streaming, and responder APIs are unchanged.
  Durable lifecycle callers should use `dispatchA2AMessage`; its
  `idempotencyKey` is required and is never generated implicitly.
- Observation `signal` and `timeoutMs` values govern only the local join. They
  never imply remote cancellation; call `cancel()` explicitly when cancellation
  is intended.
- All 21 catalog-publishable packages move together to 0.10.0. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.
- The 0.9.2 source preparation was not published to npm. Its reliability and
  maintenance changes, documented in the next section, ship publicly as part
  of 0.10.0.

## 0.9.2 — Reliable context, polling, provenance, and memory maintenance (2026-07-14)

### Highlights

- `ReadSkill` now loads a selected skill completely instead of silently
  truncating larger instruction files at the former 64 KiB boundary, while
  retaining the existing path and selection guards.
- Telegram long polling tolerates sustained transient network failures through
  a 90-second retry window. grammY's internal retry logger is disabled so raw
  Bot API URLs and credentials cannot bypass the framework's redaction layer.
- Runtime dependency provenance ignores only mutable
  `node_modules/.vite/vitest` result caches. Sibling `.vite` content, JavaScript,
  native addons, modes, and safe symlink targets remain attested.
- Operators can prepare a sealed, content-free explicit-ID memory-forget plan,
  apply it only while the agent is stopped, and restore from a full owner-only
  backup. Stale plans, unsafe paths, drift, tampering, and interrupted root
  swaps fail closed or recover automatically.

### Compatibility

- Existing agent configuration remains compatible; the reliability changes are
  active without new configuration.
- Memory forget is intentionally an offline maintenance operation. Stop the
  configured agent before apply or restore, and retain the generated backup
  until post-cleanup strict audit and live verification are complete.
- All 21 catalog-publishable packages move together to 0.9.2. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.9.1 — Durable A2A dispatch admission (2026-07-14)

### Highlights

- A2A callers can attach a versioned `idempotencyKey` metadata extension after
  verifying that the remote Agent Card advertises durable support. Unsupported
  peers fail before a task is submitted.
- Providers fsync a payload-bound admission before invoking the responder.
  Same-process concurrent duplicates share one execution; a concurrent provider
  process loses the exclusive admission and fails closed as
  `idempotency_in_doubt`. Retained terminal tasks replay, and a changed request
  under the same key fails with a typed conflict.
- Immediate and blocking callers share the same admitted task while retaining
  their own response projection and history length. The provider persists an
  immediate acceptance and monitors it to a terminal task without treating
  response preferences as different work.
- A provider restart with an active receipt fails closed as
  `idempotency_in_doubt`; it never guesses that model work is safe to repeat.
  Expired results compact to permanent conflict tombstones, and bounded store
  capacity fails closed instead of evicting a live or previously bound key.
- Owner-only state, strict persisted-result validation, file and directory
  fsync, cross-process exclusive admission, and permanent key ownership close
  crash, expiry, and concurrent-provider replay races.

### Compatibility

- Durable A2A idempotency is opt-in. A config-loaded provider advertises it only
  when plugin `config.provider.idempotency.namespace` (or the equivalent
  full-root/env setting) is an explicit stable logical principal; `stateDir`,
  retention, and maximum records remain configurable.
- Direct consumers may pass `idempotencyKey`. Programmatic responder bridges
  may supply `idempotencyKeyForRequest`; neither path invents a random identity.
- The contract is at-most-once and fail-closed across ambiguous failure, not a
  claim of exactly-once execution across an unknowable process/network crash.
- All 21 catalog-publishable packages move together to 0.9.1. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

## 0.9.0 — Durable origin-bound continuations (2026-07-14)

### Highlights

- Long-running tool work can claim a host-owned continuation before dispatch,
  return the interactive turn promptly, and later bind the durable result to the
  exact originating conversation without exposing channel routes or credentials
  to the model, A2A payloads, or result contracts.
- Continuation synthesis is isolated, tool-disabled, and at most once. Its
  output is persisted before delivery, so restart-safe native-channel retries
  reuse the same synthesis instead of running the model again.
- Reply, actionable-notification, silent, and capture modes support interactive
  and detached work. Status, retry, cancel, and delivery-unknown resolution give
  operators a durable control surface for recovery and auditing.
- Configured loopback MCP servers receive short-lived opaque claim capabilities;
  spoofed or remote claim transports are rejected. Pi tool failures now retain
  their error status through runtime bridging and telemetry.
- Bounded concurrent workers, active-record admission limits, operation
  timeouts, and keyset-paginated operator reads prevent one hung provider or
  abusive claim origin from stalling or exhausting the continuation service.
- Multi-message native delivery requires every chunk to succeed. Partial sends
  become delivery-unknown, and operator-confirmed sends use a history-only
  commit so reconciliation can never repost the answer.

### Compatibility

- All 21 catalog-publishable packages move together to 0.9.0. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.
- Durable continuations are opt-in. Existing agents keep their current turn and
  delivery behavior until a continuation service and eligible MCP servers or
  detached routes are explicitly configured.

### Upgrade

- Upgrading managed SRT from 0.8 or earlier is an offline transition. Stop
  every old background and foreground mono-agent process for the OS user, and
  wait for old `mono-agent init` and `mono-agent sandbox setup` commands to
  exit, before installing 0.9. Keep them stopped through the first 0.9 sandbox
  setup. Older versions do not honor 0.9's permanent OS-level install guard,
  so mixed-version setup or repair is unsafe.

## 0.8.0 — Durable operations and direct access (2026-07-13)

This is the first public npm release containing the Product v1 source line. The
0.7.0 source tag remains an immutable milestone but was not published to npm.

### Highlights

- Completed turns are durably admitted before success is reported. BuJo capture
  now has fsynced intake, restart-safe retries and dead letters, strict output
  contracts, exact replay adoption, and health-visible reconciliation.
- Strict memory audit now verifies managed generations, canonical graph and
  SQLite parity, vector coverage, intake/outbox state, stale runtime artifacts,
  and legacy timestamp adoption without silently accepting partial state.
- `/cancel` emits one terminal acknowledgement across Telegram, Slack, and
  WhatsApp, stays out of model/history/memory processing, and records user
  cancellation without degrading fleet health.
- Session Web and the OpenAI-compatible API support authenticated direct LAN and
  Tailscale access. Tailscale Serve remains optional for HTTPS and full PWA
  installation behavior.
- Blocking asks retain their history; completed prior runs can be inspected
  through a conversation-scoped, read-only tool; request-scoped MCP delivery no
  longer leaks tools between concurrent turns.
- Per-turn effort keywords, native voice transcription, safer Telegram logging,
  cron de-duplication, and loaded-build provenance improve day-to-day operation.
- Lockstep publication now binds immutable tarballs to a clean exact tag and
  verified build provenance, stages and integrity-checks the complete package
  set before promotion, and smoke-tests all three public CLI entry paths.

### Compatibility

- Node.js **22.19.0 or newer** is required. This is a new requirement for public
  npm users upgrading from 0.6.2; it was already the floor for the unpublished
  0.7.0 source milestone.
- All 21 catalog-publishable packages move together to 0.8.0. Do not mix
  `@mono-agent/*` or `create-mono-agent` versions.
- BuJo entity writes now replace the complete canonical record. Integrations
  that call the low-level `upsertEntity` API must provide every field they want
  retained instead of relying on omitted fields from an older record.
- `AgentHarnessResponse.metadata.summary` no longer exposes `systemPrompt` and
  is typed as `ExternalRunSummary`. Private recorder artifacts still retain the
  prompt for local inspection, but channel/programmatic callers must not depend
  on receiving it from the harness response.

### Upgrade

Users on 0.6.2 can upgrade directly to 0.8.0; no public 0.7.0 package is
required. Follow the
[product-v1 cutover checklist](./docs/memory/validation-and-cli.md#enable-v1-on-an-existing-agent)
and run `mono-agent memory audit --strict --json` after upgrading a built-in
memory agent.

## 0.7.0 — Product v1 (2026-07-11)

Product v1 is the 0.7.0 source/tag milestone; it is a product milestone, not an
npm major-version claim. This exact version was not published to npm; its
content is included in the 0.8.0 public release.

### Highlights

- A new agent remains config-first: scaffold one folder, then continue in the
  local configuration conversation with the bundled `mono-agent-configure` and
  `mono-agent-memory` skills.
- `MemoryRecall` is enabled by default. Lite, Journal, and BuJo now have strict
  tiers, bounded/background work, metadata-only health, measurable graph recall,
  and side-by-side rebuild/rollback generations with integrity-qualified immutable
  snapshots.
- Supermemory is an external plugin (`@mono-agent/memory-supermemory`) rather
  than bundled core behavior.
- Active conversation history wins over durable memory for questions about the
  immediately preceding message.
- App-owned Slack, Telegram, file/button, and blocking `AskUser` tools work under
  enforced managed-SRT network policies without serializing proxy credentials or
  widening destination allowlists.

### Compatibility

- The minimum supported Node.js version is now **22.19.0** (previously Node.js 20). This aligns every published package with the Pi runtime already shipped in the `@mono-agent/agent-app` dependency graph. Upgrade Node before installing or updating mono-agent; Node 20 is no longer supported.

### Upgrade

Follow the [product-v1 cutover checklist](./docs/memory/validation-and-cli.md#enable-v1-on-an-existing-agent), including the built-in-memory versus Supermemory branch.
