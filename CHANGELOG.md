# Release notes

## Unreleased

- Add a deliberate `MemoryRecall` original-query mode to configured per-turn
  memory, reusing the bounded automatic lookup after a safety abstention without
  changing ordinary query-local search or capability-free programmatic recall
  tools. Preserve existing graph expansion and count delivered IDs once per turn,
  including explicit recall through shared non-graph writable stores.

- **Breaking: retire first-party Supermemory integration.** Remove the
  `@mono-agent/memory-supermemory` package, active backend/config/env surfaces,
  backend-specific runtime/CLI/doctor/trace/fleet behavior, and automatic official
  MCP injection without selecting a replacement. Active legacy intent fails closed
  with secret-safe migration guidance, including direct programmatic composition;
  an exact empty JSON tombstone and blank retired env assignments remain inert.
  Generic `MemoryStore` injection, manually configured MCP servers, and local
  none/Lite/Journal/BuJo behavior remain. The upgrade performs no fallback, export,
  remote data migration, or remote cleanup; existing remote data is untouched.

- Fix managed subagent cancellation settlement so a newer terminal release
  publication is durably rearmed after an older publication finishes, without
  releasing capacity or waking the parent early.

- **Breaking: remove first-party Phoenix/OTLP export.** Remove the bundled
  exporter package, `observability.exporters`,
  `MONO_AGENT_OBSERVABILITY_EXPORTERS`, `mono-agent backfill`, exporter status,
  and the OpenInference mapping subpath. Keep bounded local JSONL recording,
  run history/audit/report, trace-source discovery, failover normalization, and
  provider-neutral `RunExporter` composition. Active legacy settings now fail
  with secret-safe migration guidance; inert empty leftovers remain accepted.

- Let a configured `runtime.compaction.triggerRatio` up to `0.95` take effect on
  large context windows by deriving the safety headroom as 10% of the window
  (`16,000`-`48,000` tokens) instead of 25% (`16,000`-`96,000`); the `0.70`
  default trigger path is unchanged.

- Replace the marketing site’s inactive PostHog integration with native Astro Vercel Web Analytics, preserving explicit opt-in, browser privacy signals and withdrawal controls; simplify reporting to basic page views.

- Connect marketing and documentation links to mono-agent.dev and docs.mono-agent.dev, with a permanent redirect from the former marketing host.

- Align marketing canonicals, social metadata and crawler endpoints with the live production origin, clarify AI-companion/framework search metadata, and prevent indexing of Vercel preview aliases.

- Extend the marketing site and README with a shared responsive agent overview, companion-led positioning, and opt-in PostHog events with privacy controls.

- Add the standalone static marketing site source for the
  `mono-agent.dev` domain. The isolated `marketing/` Astro app renders one
  crawlable page centered on a schema-checked `mono-agent.config.json`
  blueprint, framework/package composition, deliberate memory tiers, explicit
  model routes, local run evidence, a source-linked harness comparison, honest
  setup, FAQ, and GitHub/docs calls to action. Tested SEO metadata, a social
  card, sitemap/robots, and a dedicated CI lane protect the static output. The
  harness comparison leads with Hermes and OpenClaw, with additional coding
  harnesses, no-JavaScript content, native FAQ disclosures, and command copying. A shorter mobile-first layout adds a compact disclosure menu, a
  refined mark and CTAs, a coherent responsive type scale, SVG link arrows, and
  building-block cards that lift and toss through a compact native-scroll deck,
  with static pause, keyboard, reduced-motion, and no-JavaScript layouts.
  GitHub-marked CTAs, a mobile-optimized transparent matte-stone
  hero, compact self-hosted OFL fonts, and real desktop console UI imagery with
  clearly labelled synthetic data and source-build availability.
  Shorter CTAs, a single-line JSON caption, consistent FAQ spacing, and a tighter
  mobile deck reduce clutter; cached geometry and compositor transform updates
  avoid repeated card measurements during scrolling.
  Position the site around ongoing agent work and TypeScript composition, with
  shared project context, delegated work, and retained execution evidence as
  concrete benefits. Keep the JSON blueprint prominent, compare architectural
  approaches honestly, and correct availability labels against v0.22.0.
  The marketing site is deployed at `mono-agent.dev`, with documentation at
  `docs.mono-agent.dev`.
- Let automatic memory recall answer directly scheduled temporal questions with
  valid clock times while preserving exact event identity and abstaining on
  qualified, compatibility-hidden, or conflicting schedule payloads; keep raw
  candidates available through `MemoryRecall`.

- Let `WebSearch` request an optional ISO country localization preference,
  defaulting to no requested country. Apply documented DuckDuckGo regions,
  carry advisory Parallel intent, and skip unsupported providers or Hound
  engines before dispatch instead of silently returning untargeted results.

- Improve local web extraction with Hound-derived content-link prioritization,
  title and main-content fallbacks, and Markdown tables that retain links and
  code. Keep rate-limit and access refusals terminal instead of retrying or
  forwarding the same fetch to another provider, including binary login pages.
  Reject image-only extraction without visible text, preserve ordinary search
  URL parameters, and retain native Hound aggregate cooldown evidence.

- Fix unrelated provider turns blocking history admission and cancellation
  publication when conversation keys share a lock shard. Concurrent writers
  sharing history must use v0.20.0 or later; stop older writers first.

- Replace opt-in external Hound RPC with built-in Node DDG/Brave/Mojeek search
  and HTTP-only fetch. Gate/admit each request, account for robots/engine sends,
  report partial engine coverage, and enforce fail-closed Hound-only robots.
  Remove obsolete endpoint settings: JSON/env/direct callers receive an explicit
  migration error without contacting a service. Default providers are unchanged.

- Keep model-guided BuJo capture faithful to speaker, evidence, and preference
  scope; distinguish corrected reports from actual state changes and avoid
  turning observed outcomes into causal proof, without extra model calls or a
  storage-schema change.
- Give strict BuJo extraction the durable completed-turn admission instant as
  host-owned observation context, reused across retries, and guide extraction
  and reconciliation to retain material dates, relative phrases and anchors,
  uncertainty, negation, event scope, and distinct repeated events without
  presenting receipt time as event time or trusting timestamps in quoted text.
- Make strict agent-host BuJo extraction and reconciliation request the runtime's
  schema-guided `StructuredOutput` result while retaining authoritative strict
  validation and whole-turn atomicity. Accept a successful terminal structured
  submission at a one-turn ceiling, fail closed when the selected structured
  path returns no result, and keep direct Ollama memory completion on its
  validated JSON-text path.
- Keep independent BuJo facts that share an explicit speaker-attribution preamble
  from being rejected as duplicate variants, while preserving whole-batch
  rejection for actual near-duplicates, conflicting values, and negations.
- Let automatic direct-fact recall use finite first-party reported properties,
  choices, and work/live locations while rendering their attribution unchanged;
  require exact textual reporter identity, reject compatibility-hidden unsafe
  syntax, and keep ambiguous corrections and conflicts out of automatic context.
- Reject memory E2E corpus/split selections with no groups before provider
  setup, build, or benchmark execution instead of reporting a successful
  zero-trial run.
- Add opt-in LoCoMo memory diagnostics with ordered source exchanges, one
  capture pass per conversation within a run, independent question histories,
  source timestamp-bound admission clocks that retries cannot shift, and exact
  completed-result reuse. Retry only positively identified local capture
  failures, including fulfilled strict calls that omit or cannot project their
  required structured result, through the native durable schedule without
  accepting fallback text. Use a plan-bound 30-second embedding deadline that
  matches the native memory provider default while keeping deadline and
  cancellation failures terminal. Report lexical scores separately from unmeasured semantic
  quality and expose capture, retrieval, and budget limits.
- Keep memory E2E strict capture on the runtime's authoritative structured
  result, including reconciliation projection, and pin real requests to SSE
  with no transport retry. Report output reservations as provider hints and
  refuse known Codex routes that cannot enforce the requested wire output cap.

- Return managed `WebSearch` and `WebFetch` results as a compact JSON envelope
  with `status`, host-written summary, untrusted content or results, source and
  coverage metadata, and typed `next_actions`. Add deterministic `WebFetch`
  `focus` block filtering and bounded `include_links` from static HTML
  extraction; both reuse the cached extraction without added requests.

- Fix an explicitly remembered fact being silently lost when capture later
  refined it. A `Remember` write is content-addressed — its id is the SHA-256 of
  its own text — but reconciliation could merge new wording into that bullet in
  place, leaving the id asserting a hash of text it no longer held. Remembering
  the original fact again then matched that id and reported a false duplicate,
  so the fact was never stored. Reconciliation now keeps a remembered bullet
  exactly as written and records the refinement as a separate memory, which is
  linked to the original when it is close enough to be threaded. Refinement is
  not treated as contradiction, so the remembered fact is never invalidated or
  superseded, and ordinary (non-remembered) memories still merge in place as
  before. This protects new reconciliation only: records already rewritten this
  way are not detected or repaired, and a capture already queued before the
  upgrade can still apply its original in-place edit when it is replayed.
- Report memory lifecycle state in `MemoryRecall` results. Recall returns
  completed, scheduled, and migrated records alongside open ones, but the tool
  previously showed only a score and the text, so a finished or deferred item
  could read as a current fact — a distinction automatic recall already made
  through its status-bearing bullet marker. A result whose status is not `open`
  is now prefixed with that status, and structured results carry `type` and
  `status` when the backend supplies them. Open records render exactly as
  before, a backend that reports neither keeps its previous result shape, and
  which records are retrieved, ranked, or excluded is unchanged.

- Let a cron job declare a deterministic `preflight` argv evaluated before the
  model responder. `{"run":false}` ends the firing as `skipped_gate` with no
  model turn or notification; `{"run":true,"input":"…"}` runs the job with the
  input appended in one `<preflight-input>` block. Every gate failure — non-zero
  exit, signal, spawn failure, timeout, malformed verdict, or output over the
  caps — fails open with the plain prompt and records a bounded code-only audit
  record per firing. Bound it with `preflightTimeoutMs` (default 5000, cap
  60000), separate from `maxRunMs`; a manual run always runs and keeps the input.

- Recognize scope-qualified choice questions in automatic memory recall, so
  `What color did Mira select for the Velin launch?` can be answered by a
  record that names both the property and the scope. A scope is not a property,
  scopes are compared conservatively so distinct projects, numbers and
  identifying prefixes such as `A-team` stay distinct,
  and contradictory values for the same subject/property/scope abstain instead
  of injecting either. Unscoped behaviour, score thresholds, caching and the
  `MemoryRecall` tool are unchanged, and no extra retrieval or model call added.

- Make supported Anthropic prompt-cache retention one hour by default, including
  child routes. Set `providers.piNative.cacheRetention` to `"short"` to opt out
  of the higher cache-write price; resolved settings override Pi ambient env.
- Replace WebSearch `auto` routing with explicit provider names or ordered
  chains, defaulting to Parallel then local Ollama; keep keyless engines opt-in.
  Report the previous explicit chain when migrating an `auto` configuration.
- Add anonymous Parallel MCP search and extraction with bounded, sandbox-gated
  transport, batched search alternates, run-scoped sessions, and optional
  credential environment variables. Keep local WebFetch as the default and
  reject incompatible Parallel-only raw, header, and browser options.
- Make WebSearch providers source-registerable without chain-body changes,
  preserving request budgets, relevance gates, and provider cooldowns.

- Fix turns waiting forever behind cancelled or failed continuity publication:
  return a retryable error after 30 seconds by default without bypassing pending
  history, with a host-overridable wait budget and bounded progress warnings.

- Remove `Monitor` / `MonitorStop`, their CLI and console surfaces (breaking).
  Use background process jobs for finite work. Legacy `monitors` config is
  accepted with a deprecation warning but has no effect; historical storage
  remains dormant. Old conversations containing monitor activity stay readable,
  but that activity no longer renders and is discarded if ordinary recovery
  rewrites its message.

- Fix `WebSearch` budgets to charge answered searches, refund failed providers,
  and count Ollama endpoint probes once. Bound network dispatches separately
  and include provider failures in budget-exhaustion messages.
- Fix `WebSearch` tight-budget snippet truncation to keep the visible truncation
  marker for highly escapable content instead of emptying the snippet, while
  staying within the 64 KiB structured results bound.

- Fix conversation render crashes when switching between cached transcripts of
  different shapes. Add local technical details and copyable diagnostics to the
  conversation recovery panel, without uploading error reports.

- Add an isolated, opt-in conversational memory benchmark with production
  completed-turn capture, readiness checks, recall tools, and five baseline
  arms. Keep offline contract results separate from unmeasured model quality.
  Bound provider waits and cleanup, retain uncertain stores, and rebuild a
  source-pinned dependency closure before real-provider admission.

- Record structured benchmark provider-failure categories on meter events,
  trials and summaries without storing raw errors, and stop further provider
  admission after a fatal auth/quota failure while still cleaning up owned
  stores. Remaining trials report as unstarted, never as quality results.

- Let the opt-in memory benchmark select an explicit Pi auth file with
  `--pi-auth-path` for real runs, wired into both model runtimes through the
  existing credential resolver. Plans bind only its fingerprint, never the
  path or credential bytes. Finish the standalone command after its report is
  durable even when successful provider transports retain process handles.

- Let `AgentSend` accept and ignore an optional `description` when stopping a
  subagent, and explain invalid stop requests with specific codes and messages.

- Tolerate transient discovery gaps in the web console. Inconclusive
  presence samples no longer drop a discovered agent at once, so a busy
  event loop or a briefly missing endpoint does not read as a dead agent.

- Require every pull request to file an `Unreleased` changelog entry, cut
  release notes with a refusing-when-empty script, and publish the filed
  section as the GitHub Release body.

- Preserve local lexical memory matches during recognized embedding-provider
  outages, while clearly marking automatic and explicit recall as degraded,
  keeping statusless recall strict, and warning instead of serving meaningless
  fragments when the automatic-context byte budget is too small.

- Let the read-only `ProviderUsage` tool force a current quota read with an
  optional `refresh: true` argument; absent or `false` keeps the five-minute
  cached read. Forced reads join the shared in-flight fetch and never bypass
  error backoff or `Retry-After`; the tool still changes no routing and
  purchases no quota.

- **Breaking: simplify framework configuration, runtime and memory contracts.**
  Remove inert permission/recall options, prose-triggered effort escalation,
  process-global tool configuration (direct public tool execution now requires
  an explicit `ToolContext`), legacy flat runtime settings, the legacy
  memory-write protocol and the standalone memory-recall binary. Phoenix moves
  to the explicitly installed, matching-version `@mono-agent/observability-phoenix`
  extra. Operator streaming, wire types, previews and channel redaction share
  canonical implementations. See the [migration guide](./docs/reference/framework-simplification-migration.md)
  before upgrading an existing consumer.


## 0.22.0 — Persistent subagents and Projects (2026-09-16)

### Persistent subagents

- Persistent Agent/AgentSend support detached process-job execution and exact-origin wakes, retaining busy ownership after unresolved cancellation.

- Let persistent children ask their parent for direction with child-only
  `AskParent`. Questions are durable before the child turn ends, and Agent results
  return successful `awaiting_reply` with structured question details. Reply with
  ordinary `AgentSend` in the same session; failed replies preserve the question.

- Keep a subagent's own context across conversation turns with
  `Agent({persist: true})` and `AgentSend`. Persistent instances survive restarts,
  appear in the Session envelope, and enforce idle expiry, capacity, turn limits,
  and exclusive execution. `AgentSend` can close an instance when work is done;
  `restart --clear-sessions` clears their registries and transcripts.

- Let `Agent` calls select a model from `subagents.models` and set effort for
  configured, authored, or general-purpose helpers. Call-time values override
  profile pins; unpinned children inherit the parent's effective model and effort.
  Report requested and executed routes when a child route is pinned or overridden.

- Recover restart-safe persistent subagent ownership, let the parent stop a
  busy persistent subagent and resume it later, bound a detached child's
  foreground commands by its process job, and keep turn-continuity
  publication resilient when a handoff races the parent.

- Show detached subagents as lifecycle rows with a scrollable progress card,
  fold the background launch call into its job-started row, and show the
  child-busy notice only for terminal jobs.

- Badge a subagent's model and effort from delegation start, show run
  attribution only for deviations, and mark a conversation's model changes in
  its transcript.

- Compact context mid-turn, not only before the turn, so long delegated runs
  stay within budget without waiting for a turn boundary.

### Projects and tags

- Add Projects to the web console: per-agent named containers of conversations
  with a free-text context (at most 4,000 characters) that is prepended,
  operator-facing text only and at dispatch time, to every turn of every member
  conversation, so existing conversations pick it up on their next turn. The
  Dashboard lists projects between Running and Recent, a project page shows the
  context card and member conversations, and the conversation menu moves chats
  in and out. Archiving a project hides its entry while keeping chats,
  membership, and injection; deleting one detaches its chats back to the agent.
  Project summaries carry conversation, running, and monthly-priced-usage
  counts over `GET/POST /api/v1/projects`, `PATCH/DELETE
  /api/v1/projects/:id`, thread `projectId` membership, and
  `projects.changed` events. Storage migrates to schema 26
  with `projects` and `threads.project_id`.

- Add project colors, a tinted chat badge, and persisted join/leave/move markers.
  Membership changes wait for the active turn boundary; steering retains frozen
  project context. Busy deletion and pending-destination archival return conflicts.
  Add authenticated, source-scoped console project/conversation MCP tools with
  atomic create-and-attach and operation receipts, plus `SearchConversations`
  (the search bar's full-text search) and archived/limit options on
  `ListConversations`. Storage appends migration 27.

- Label a conversation that belongs to a project wherever it is listed: on its
  row in the console's conversation list and archive shelf, on its card in
  Active now, and on a search hit. Conversation summaries carry the project's
  name as `projectName`, so a card for another agent's project can name it
  without that agent's project list. The chat header's project badge is set in
  sentence case at the conversation title's left edge.

- Add agent-scoped conversation tags, polish conversation status and inline
  tags, and move the model-change notice above the composer input.

- Keep the dashboard Projects section collapsible with persisted state, close
  an open project page with a right swipe on mobile, and allow console
  project tools during background wakes.

### Dashboard and installed console

- Replace the agent rail and conversation sidebar with one Dashboard where
  Running speaks for the whole fleet, with device-local unread marks, settled
  reply excerpts up front, and a phone layout tightened from use.

- Focus dashboard search on results, omit idle Completed statuses from
  conversation rows, and open conversations straight from PWA notifications.

- Apply one palette across the console with cron jobs in the conversation
  list, and refresh the PWA console icon.

- Keep the installed console's status band aligned with its header on phones
  and tablets, tolerating sub-pixel drift and system-bar panning, and align
  mobile PWA Back with screen navigation.

- Sort Automations by recent invocation, and explain pending cron-Reply
  collisions with friendly copy carrying the pending-since time.

### Background jobs in the console

- Stack background jobs by conversation and show active jobs by default, with
  the job lifecycle visible in response activity and wakes rendered
  chronologically.

- Hold a process-job wake receipt until its follow-up turn is admitted, so a
  wake never lands before the work it announces.

- Widen and align the job card's tool-call list, keep job accent to Activity
  rows, and say when a background job has produced no output yet.

### Usage, cost, and providers

- Meter subscription usage in compact agent settings and a `ProviderUsage`
  tool, with GitHub Copilot meters over OAuth quota scoped to activated
  providers.

- Show completed agent-job cost, surface active provider usage in the context
  popover, and compact the settings touch controls.

- Stabilize tool definitions for prompt caching, add opt-in Anthropic cache
  retention, and route `deepseek-v4.1-flash` through the opencode-go catalog
  supplement.

### Input, replies, and platform

- Keep unsent composer text across app restarts, fix Enter behavior alongside
  cancelled-turn continuity, and keep a waiting follow-up at its turn's foot
  sized like a user message.

- Preserve reasoning-split replies with paged change markers, and keep a
  thought from splitting a live reply's sentence.

- Accept audio uploads as agent attachments, including Voice Memos reported
  as `audio/x-m4a`.

- Supersede stale reply-file publish failures on retry, record transcript
  markers as rows the agent can see, and move onboarding browser-first with
  explicit web sharing.

- Publish systemd dotenv snapshots with session environment attestation, and
  tolerate transient operator probe failures without dropping the agent.

### Tool output and model labels

- Per-tool output truncation now persists the full output in the configured
  app. Bash, Exec, NodeRepl, Read, WebFetch, Grep and Glob trim oversized
  results at their own character/line caps long before the 256 KiB tool-payload
  guard, and the code path that saves the trimmed remainder to disk only knew
  how to write under a `toolArtifactDir` that the configured app never sets —
  so the console saw `[truncated Bash output …]` with no file behind it. The
  per-run host artifact sink the payload guard already receives is now attached
  to the run's tool context and preferred by that spill path, so the full output
  lands under `artifacts.dir/tool-output/<runId>/` and the retained text ends
  with `Full output saved to: <path>`. Hosts that configure `toolArtifactDir`
  directly keep the previous behavior.

- An over-cap `Agent` (subagent) result is now spilled to the run's tool-output
  artifact directory instead of being silently cut. The retained tool result
  kept its 12,000-character answer cap and 24 KB byte cap, but the text beyond
  them was simply dropped — a long research report from a subagent lost its
  tail with no way to recover it. When the answer exceeds the cap, the activity
  log is elided, or the byte cap fires, the complete result is written through
  the same host artifact sink the tool-payload guard uses, the retained text
  names the file directly under its header
  (`[result truncated; full result saved to: …]`), and the path is recorded as
  a `tool_payload_saved_paths` artifact reference in tool history. Without a
  sink the text says the full result was not saved.

- Conversation rows now show compact current model and effort labels across the
  dashboard, running cards, and search results. Subagent activity shows a smaller
  per-call route label, retaining fallback warnings and effective-effort details.
  Model versions remain visible, with signal bars reflecting each model's
  advertised effort levels (text when unknown). Phone layouts give delegation
  tasks priority over their compact routing and timing metadata.

## 0.21.1 — Image cap and upload fixes (2026-09-10)

- Cap every inline image handed to a model at 2,000 px per edge, down from
  8,000 px, and apply the same normalization to MCP tool results. Anthropic
  tightens its per-image dimension limit from 8,000 px to 2,000 px once a single
  request carries more than 20 image blocks, counting images inside tool results
  and every image replayed from earlier turns. A screenshot-heavy conversation
  crosses that threshold easily, and one oversized capture then rejected the
  whole request with an `invalid_request_error` that no retry or model failover
  could clear, leaving the conversation permanently stuck. MCP screenshots
  previously bypassed dimension checks entirely because they were measured only
  in bytes, so a wide desktop capture passed every guard. Images already within
  the ceiling are forwarded byte-identical, and source files are never modified.

- Quiet the background-job surfaces: drop the empty-body padding, redraw
  event rows without the quote-bar stripe, and stop listing host-local
  artifact paths the console cannot open.

- Stop declaring `Content-Length` on Slack external file uploads.

## 0.21.0 — Turn continuity and console scale (2026-09-10)

### Continuity and recovery

- Preserve natural conversation continuity after any admitted, non-isolated run
  settles as cancelled or failed before its success commit. The next turn
  receives a 48 KiB redacted account of the request, partial assistant output,
  completed tool pairs, in-flight work, omissions, and typed settlement
  provenance; durable Pi epochs rotate so provider state and canonical history
  stay aligned. Cancelled and failed turns remain excluded from memory capture,
  while `RunHistory` and `SessionHistory` keep the deeper evidence.
  Partial assistant collection stays incrementally bounded to an 8 KiB UTF-8
  prefix on every run, with omissions counted per assistant runtime event.
  Runtime/provider cancellation or failure codes and details remain only in
  tag-safe JSON explicitly framed as untrusted evidence and cannot select host
  provenance. A hard process death that never unwinds through the harness
  remains artifact/web reconciliation only and cannot publish canonical history.

- Resume warm durable Pi sessions after cancelled or transiently failed turns,
  keeping model-override conversations on a warm session bound to the
  requested model, and keep the primary's durable Pi session when fallbacks
  are configured.

- Preserve and account for compaction summaries across turns, guide
  interrupted-run recovery in the app, surface the policy reason when
  `PublishReplyFile` rejects a file, and reconcile deferred tool history
  writes so late results land safely.

### Search, models, and effort

- Add explicit Ollama Web Search alongside the existing SearXNG, Codex, and
  keyless routes. Preserve `auto` as SearXNG → Codex → keyless, repair the
  canonical nested SearXNG config while retaining its legacy endpoint alias,
  bind hosted Ollama bearer credentials to the exact official origin, and keep
  strict-provider failures visible. WebFetch now adds deterministic charset and
  parser handling, safer HTML-to-Markdown conversion, structured failures, and
  explicit browser-first rendering through an isolated `agent-browser` session
  without treating authentication or access challenges as bypassable.

- Bound every WebSearch backend to 4,000-character marked snippets and a 64 KiB
  ranked body, pass Ollama the caller's result limit, and preserve complete
  trust framing. Oversized text tool results now retain a framed UTF-8-safe
  head/tail sample, while configured app runs persist raw blocks best-effort in
  owner-private `tool-output/<runId>` files that can become opaque
  `SessionHistory` references. Publication creates and verifies directory
  components individually at mode `0700`, accepts pre-existing owner-controlled
  components only when they are not group- or world-writable, rechecks the
  run-directory identity after opening, and removes identity-proven files after
  final validation failure; Node's lack
  of fd-relative `openat` leaves a documented residual same-user rename window.

- Extend the configured app's startup-and-hourly artifact retention sweep to
  own raw `tool-output/<runId>/` directories under the existing
  `artifacts.retention` age, count, and dry-run policy. Selection is path/mtime
  based so aged recordless orphans are cleaned; running, uncertain, or recently
  modified directories are kept conservatively, symlinked or unsafe paths fail closed, and
  pruned opaque `SessionHistory` references degrade to `available: false`.

- Make web-console model routing explicit per run: requested, attempted, and
  answering models, classified fallback/retry history, Pi's effective thinking
  level, and nested subagent attribution are now visible without exposing raw
  provider diagnostics. Standalone process-job and Monitor revival turns now
  reuse the conversation's remembered web model/effort snapshot.

- Resolve inherited reasoning effort per selected model route. Model-only web,
  Slack, Telegram, cron, and webhook overrides now keep `runtime.effort` only
  for the configured primary or a model whose advertised ladder admits it;
  configured fallbacks use their own pinned effort or provider default. The web
  console labels provider-default inheritance accurately, and explicit effort
  overrides remain unchanged.

- Upgrade the exact-pinned Pi AI, Agent Core, and TUI dependencies to 0.85.1,
  exposing GPT-6 Astra as `openai:gpt-6-astra` for OpenAI API keys and
  `openai-codex:gpt-6-astra` for Codex subscriptions. Adopt Pi's corrected
  30-minute long prompt-cache request shape for GPT-5.6+ OpenAI Responses
  models, plus its fullscreen Alt-wheel and list-hover TUI fixes.

- Expose prompt-cache measurements, stabilize provider prompt caching, keep
  tool definitions stable across turn admission, and add opt-in Anthropic
  cache retention with per-request cohort summaries.

- Enable keyless provider auth in the operator adapter.

### Console performance and sync

- Serve the console faster: compress responses, cache immutable assets,
  refresh only what each event invalidates, and read threads through indexes
  of turns by thread and messages by turn.

- Resync cheaply: boot from one bucket with thread-event summaries and shaped
  transcripts, then stay current through a sync core of conversation cache,
  subscribed stream, conditional resync, and on-device persistence.

### Conversations and input

- Add per-agent web-console defaults for the model and effort of new
  conversations, with SQLite persistence, config/override source labels, and a
  one-click revert to resolved config. Existing threads and non-web channels
  remain unaffected.

- Preserve no-expiry `AskUser` waits in web and remote-TUI turns by removing
  Undici's implicit five-minute inactivity deadline from long-lived operator
  streams. Host-wake delivery keeps its explicit ten-minute request bound.

- Stream message deltas to the subscribed thread, time the Activity header by
  the turn's wall-clock window, and keep the console mounted across switches
  with scroll reset and explicit loading and recovery states.

- Reconcile the selected conversation after the first stream ready, and show
  pending state while restoring and creating conversations.

- Add an explicit Steer action to the composer, shown only while a turn runs.

- Restore live input for interactive model overrides, and make live-input
  consumption settlement reliable from entry id to acknowledgement.

- Migrate both schema-17 message layouts safely.

- Coalesce consecutive monitor activity turns, avoid redundant status wakes,
  and preserve meaningful web replies before terminal no-ops.

### Process jobs, cron, and memory

- Fold the process-job card into the activity log, show live output tails,
  drop the trailing progress indicator after running jobs, keep workflows
  moving after background jobs complete, and show the current conversation
  and background-job status together.

- Answer cron results from the console with a simpler footer, render imported
  cron reply context as a card, show a quiet read-only cron schedule, and
  hide silent cron runs at the storage read boundary.

- Browse the memory journal within bounds with evidence routing, naming
  memory tools in guidance and showing cursor and coverage in text.

### Console appearance and devices

- Stabilize per-chat model selection, hide removed agents and embedding
  models without losing selector focus, and keep the persisted catalog model
  selected.

- Polish console drafts, model labels, attribution, and the composer model
  selector; keep a finished turn settled when its stale start arrives, keep a
  selected conversation at the bottom, and stop announcing an agent change on
  every discovery heartbeat.

- Name the installed console with reversible overrides, complete badge
  handling on Android, and align PWA chrome with the header.

- Add mobile drawer swipe gestures, streamline mobile conversation controls,
  keep the composer toolbar on one row, show the scroll control only when
  needed, and pin short chat composers to the bottom.

- Coordinate local agent research with reusable page slices, add a data mode
  with byte meter, fetch images once, load MCP apps on demand, and make
  automatic search resilient.

- Add provider re-authentication, preserve the provider-auth capability in
  bootstrap, verify authentication with safe login restart, and compact the
  scrollable provider-auth settings.

### Channels, lifecycle, and platform

- Add a Facebook Messenger channel plugin with signed webhooks, per-sender
  queues, typing indicators, and chunked Send API delivery.

- Add Linux systemd user lifecycle commands with hardened edge cases.

- **Breaking: framework self-configuration has been removed.** The dedicated
  SELF-CONFIG session, `ProposeAgentConfiguration`, `mono-agent tui --configure`,
  `/configure`, host-side proposal review/apply/restart transaction, and bundled
  `mono-agent-configure` skill no longer exist. Edit `mono-agent.config.json` or
  `IDENTITY.md`, run `mono-agent validate`, restart, and use the ordinary TUI.
  Existing `mono-agent-configure` selections are ignored at runtime and reported
  as waiting by validation so running consumers do not break. With index
  disclosure, active selected skill bodies load in full without `ReadSkill`
  until the retired selector is removed. Run
  `mono-agent install-skill --project --check`, then `--update` to retire exact
  manifest-owned legacy state. Modified or colliding copies are preserved and
  require operator resolution.

- **Breaking: the minimum supported Node.js version is now 24.15.0** (previously
  22.19.0). Node 22 bundles ICU 77, whose `windows-1252` decoder maps the C1
  bytes to raw control characters instead of the WHATWG code points, so
  `WebFetch` returned `U+0093`/`U+0094` where a cp1252 page meant curly quotes.
  ICU 78, shipped from Node 24.14.0 onward, decodes them correctly. Rather than
  carry two decoding behaviours across the supported range, the floor moves to a
  Node line that decodes retrieved documents correctly. Upgrade Node before
  installing or updating mono-agent.

## 0.20.14 — Release retry (2026-09-04)

- Ship the lockstep 0.20.14 release with no product change beyond awaiting
  durable monitor events in the race-sensitive tests.

## 0.20.13 — Release recovery (2026-09-04)

- Republish the 0.20.12 payload as 0.20.13 after the 0.20.12 run stopped
  before publication, isolating the post-timeout test from host scheduling
  latency.

## 0.20.12 — Pi-only runtime with provider catalogs (2026-09-04)

### Single Pi runtime

- **Breaking: mono-agent runs only its Pi implementation.** The `claude-sdk`,
  `claude-code-cli`, `codex-app-cli`, `opencode-app-cli` and `acp-stdio` runtime
  bridges are removed, along with the backend dispatch table. The ACP *server*
  bridge, `install-skill --target claude|codex`, `docs-mcp-pairing` and the Codex
  web-search backend are unaffected.

- **Breaking: model references are `<provider>:<model>`,** split at the first
  colon only. A leading `pi:` is canonicalized away; `codex:`, `claude:`,
  `claude-code:`, `codex-cli:`, `acp:` and `vercel:` are rejected at load with
  the replacement named.

- **Breaking: `runtime.executionMode`, `memory.llm.executionMode`,
  `runtime.routeSafety` and `runtime.fallbackModels` are retired,** together with
  their environment twins `MONO_AGENT_EXECUTION_MODE`,
  `MONO_AGENT_MEMORY_LLM_EXECUTION_MODE`, `MONO_AGENT_ROUTE_SAFETY` and
  `MONO_AGENT_FALLBACK_MODELS`. Each now fails at load with the exact repair for
  the surface it was set on — the environment variables name an environment
  repair (`MONO_AGENT_FALLBACK_MODELS` -> `MONO_AGENT_FALLBACKS_JSON`), not a JSON
  key the operator may not have — rather than a generic unknown-key error. One
  load names every retired key in one message, and every retired variable in one
  message, instead of one per run; a config carrying both stops at the key and
  names the variable on the next run. An empty assignment (`KEY=`) is still
  treated as unset.

### Provider-widened selection

- **New `providers` config map** declaring which providers an agent supports,
  widening selection to those providers' advertised catalogs instead of just
  `runtime.model` and its fallbacks. Each provider advertises at most
  `maxAdvertisedModels` models (default 100) unless it declares an explicit
  `models` allowlist. `ollama` and `lmstudio` are zero-config autodiscovered.
  Agents advertise it additively — a slim `providers` array on `/v1/info` plus a
  lazy `GET /v1/models` — with no wire-schema bump.

- **Per-conversation model and effort overrides persist server-side** (web store
  v10 → v12: v11 adds per-thread `run_model`/`run_effort`, v12 adds
  `agents.providers_json`), so a choice made on the desktop shows up on the phone
  instead of living in one browser's localStorage. The console selector groups
  and filters by provider.

- Harden the new selection surface: gate `providers` as a real boundary,
  canonicalize catalog choices, advertise only runnable routes, resolve channel
  projections once, measure the `/v1/info` payload instead of estimating it,
  stop the `/v1/info` budget from discarding valid configured routes, drop the
  configured-route ceiling, follow catalog cursors, honour thread overrides,
  stop rejecting catalog efforts, and let the environment override the
  provider map.

- Bind console catalog and thread writes to a generation and order them, so a
  failed write can neither destroy what it replaced nor read as a no-op, and
  keep agent invalidations compact.

- Gate subagent models on the provider map, withdraw dead run options, and
  stop `doctor` from false-warning on effort.

### Operate and migrate

- **Retired config keys, retired environment variables and non-Pi model
  references are migrated by hand.** Each fails at load naming its own repair —
  including the concrete replacement for a rejected model reference, which the
  parser knew and earlier builds discarded before it reached `doctor`, `validate`
  or the startup error. The load stops at the first failing class, so expect a few
  `mono-agent validate` passes per agent rather than one. See
  `packages/agent-runtime/MIGRATION.md` for the per-config checklist (config file,
  environment, and trigger frontmatter) and the deployment order, and
  `docs/reference/deprecations.md` for the retired-surface reference.
  `configVersion: 1` files are outside that checklist: that schema was never
  accepted by the shipped loader and is rejected whole, so re-author them.

- **Operator-authored text is bounded wherever a diagnostic quotes it back.**
  `doctor` and `validate` truncate every model, provider and reason they echo, so
  a mistyped megabyte in `runtime.model` no longer produces a megabyte of report.
  Webhook endpoint `name` and `path` are held to 255 bytes of printable
  single-line text — the cap POSIX already puts on a `webhook/<name>.md` file, so
  nothing authorable as a file is refused — and rejected rather than truncated,
  because silently shortening an identity changes which route a request reaches.

- Assert webhook endpoint identity where endpoints are built.

### Memory and monitors

- Add the `Remember` memory tool and refocus `SetConversationTitle`.

- Add conversation monitors with Monitor wake turns in web conversations,
  presented as compact activity.

## 0.20.11 — Inline console images (2026-09-03)

- Show images inline in console messages: render them as a grid inside the
  message with a single image uncropped, open full size with paging, counter,
  and download, and keep generated reply images so they survive their source
  deadline.

- Render a displayable raster image as just the image, moving file metadata
  into the lightbox, and share one sideways-scrolling row for adjacent images
  so a set reads as a set.

- Remove the repository-owned final-agent and SearXNG demos together with their
  root commands, build provenance, verification, CI, and documentation wiring.

- Configure native Slack message unfurls.

## 0.20.10 — Activity log redesign (2026-08-30)

- Rebuild the activity log around a single row shape — glyph, name, summary,
  failure tag, duration, chevron — for single calls, `Read ×4` clusters,
  thoughts, and delegations alike, repairing what the 0.20.9 clustering hid.

## 0.20.9 — Conversation search and timeline (2026-08-30)

- Search every conversation's message text from the console sidebar, backed by
  a transactional full-text index that backfills existing stores, and cluster
  the activity timeline around the same read path.

- Keep Telegram reply history so responses preserve their native reply
  context.

- Constrain the console's model effort choices to the levels each model
  actually supports.

## 0.20.8 — Conversation titles and model catalog (2026-08-28)

- Add agent-managed conversation titles to the web console.

- Show safe purpose descriptions on background process jobs.

- Upgrade the exact-pinned Pi AI catalog and TUI to 0.84.3, including GitHub
  Copilot support for Gemini 3.7 Flash and Grok 4.6, provider-required OAuth
  cancellation signals, and the current GPT-5.6 Terra pricing metadata. Keep
  Pi Agent Core at 0.83.0 because 0.84.3's replacement durable harness does not
  yet implement mono-agent's prompt, subscription, compaction, or abort paths.

## 0.20.7 — Slack upload encoding fix (2026-08-27)

- Send Slack external-upload metadata form-encoded so reply-file uploads
  succeed.

## 0.20.6 — Slack upload diagnostics (2026-08-27)

- Expose safe Slack reply-file upload diagnostics: name the failed
  external-upload phase with bounded, redacted error fields while keeping
  textual fallback behavior unchanged.

## 0.20.5 — Background jobs and memory repairs (2026-08-25)

- Let background jobs outlive the foreground timeout: derive their budget from
  the requested `timeout_ms` without the 120-second clamp, and report the
  granted budget back to the model.

- Make console MCP App cards reversible: a Hide/Show toggle replaces the
  terminal Close, degraded and never-loaded cards explain why and offer
  Reopen, and tall apps are no longer clipped.

- Repair memory capture and retention: state the BuJo length limit as its own
  rule, repair noncausal retained supersedes, and stop rejecting tool-less
  memory providers under private-state protection.

- Harden process supervision: reap sandboxed grandchildren as a group with
  escalation to SIGKILL, and keep background file proofs stable across
  reboot.

## 0.20.4 — Cron, failover, and AskUser fixes (2026-08-23)

- Quiet tool-history bookkeeping in rendered turns so successful persistence
  shows nothing and only a failed write names its error code, slim the
  context chip to the remaining percentage with the rest in its popover, and
  document background-job expectations alongside the capability.

- Fail over to the next configured model when a provider stream ends without
  a finish reason, instead of treating the run as terminal.

- Keep cron operator actions enabled after a config-view reload, and focus
  the cron dialog on open.

- Keep an answered AskUser card answered across re-renders and reloads.

## 0.20.3 — Subscription-backed web search (2026-08-17)

- Add an ordered WebSearch pipeline that tries a configured local SearXNG
  service first, a serialized Codex app-server turn authenticated by the
  existing ChatGPT subscription second, and keyless providers last.
- Preserve quoted phrases and `site:` constraints across every backend, and
  require domain and meaningful relevance before accepting a result set.
- Add typed backend/model configuration, environment overrides, doctor
  readiness checks, and a loopback-only Yahoo SearXNG companion configuration.

## 0.20.2 — Background wake delivery and context clarity (2026-08-16)

- Deliver completed background-process results as visible agent turns across
  Slack, Telegram, TUI/web, and WhatsApp, preserving adapter-specific routing,
  structured reply parts, durable retries, and exactly-once settlement.
- Normalize context-window accounting so persisted managed-tool history and ACP
  usage no longer inflate the remaining-context meter.
- Clarify Web Console model controls by naming inherited choices `Default` and
  showing the resolved default effort when it is known.

## 0.20.1 — Trusted-host ProcessJobs compatibility (2026-08-16)

- Add the explicit `processJobs.unsafeAllowUnprotectedState` compatibility
  posture for trusted Pi-native hosts that intentionally run with
  `sandbox.mode: "off"`, while keeping the default ProcessJobs state boundary
  fail-closed and preserving provider-zero recovery failures.

## 0.20.0 — Background jobs, rich replies, and session tool history (2026-08-16)

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

- Added durable, bounded managed-tool lifecycle persistence plus the read-only,
  request-scoped `SessionHistory` search/get surface for completed prior calls
  in the current logical session.
- Managed `tool_use` / `tool_result` stream blocks intentionally gain
  host-authored `history` metadata with opaque record identity, persistence,
  bounds, and terminal state; provider-authored lookalikes remain untrusted and
  are removed.
- A configured app intentionally keeps the canonical managed-tool sidecar and
  `SessionHistory` capability when a programmatic caller supplies a custom
  message-history store. The custom store remains the sole owner of messages;
  the sidecar remains a separate lifecycle contract.
- Lazy writer acquisition keeps one bounded restart-handoff attempt, then
  fails fast for already-started turns and new turns during a progressive
  30-second-to-5-minute cooldown. A later probe or serialized explicit reset
  re-arms acquisition; closed/dead cached handles are retired before the
  recovered handle is shared.
  Reset and retention clear only incidents whose durable identity becomes
  unretryable. A delayed real result safely supersedes a finalization/recovery
  result for the same call without creating a permanent conflict.
- Model-visible `RunHistory` projections now sanitize ordinary filesystem spans
  in place to bounded `[host-path]` forms while continuing to omit credentials,
  private run-artifact content, and raw host roots.

### Rich replies and MCP Apps

- Added bounded rich reply parts. `PublishReplyFile` copies a generated
  workspace file into owner-private artifact storage and returns an opaque,
  integrity-bound attachment reference; Pi-native MCP tools can also publish
  MCP Apps using the 2026-01-26 or 2025-11-21 protocol revision. One shared
  20-part budget applies per run.
- Slack now delivers reply files through its external upload flow and Telegram
  sends them as native documents. Confirmed uploads are destination-bound and
  deduplicated; failed uploads keep a concise human-readable fallback without
  exposing private paths or capability URLs. OpenAI-compatible, webhook, A2A,
  and cron/verbatim responses remain unchanged when they cannot represent a
  rich part.
- The web console persists message-bound attachment and MCP App references,
  serves integrity-checked downloads, and hosts apps in a nonce-bound
  double-frame sandbox. Remote CSP origins are denied unless the host explicitly
  allowlists them, server resource origins never become script origins, bridge
  actions use bounded confirmation previews, and arbitrary resource reads are
  denied.
- Reply/App publication now stages outside the live namespace and commits with
  one directory rename. Terminal failure/cancellation removes unpublished run
  state; stale staging cleanup cannot collect an active publication. Retained
  MCP connections are LRU/idle bounded and closed on eviction, bridge requests
  are rate-limited, and per-app audit logs rotate within fixed bounds.
- Publication refuses host-private roots even when they sit inside the
  workspace. Reply files, MCP App payloads, and the independently admitted MCP
  audit reserve stay within one 256 MiB aggregate storage ceiling. When the
  model-fillable publication budget is full, only the new rich part fails
  safely and retained content is not evicted.
- MCP App audit admission inventories each artifact root once per lifecycle,
  maintains exact gated byte accounting thereafter, reclaims rotated history
  before inactive owners' active files, and never reclaims a live or protected
  active confirmation. Poisoned foreign owners use bounded conservative
  accounting and remain quarantined for the process lifetime; recovery requires
  a process restart and fresh root inventory. They cannot redirect reclamation
  through a symlink or replacement owner.
  Audit mutations revalidate the root, parent, and singly linked file identities
  immediately before use. Tool calls reserve confirmation and completion bytes
  before execution; model-filled
  values never enter audit records, and a real unrecorded post-tool completion
  remains the non-retryable `app_audit_incomplete` outcome through operator and
  web transport.

### Operator compatibility

- Kept producer NDJSON frames bounded while restoring the web consumer's legacy
  8 MiB ceiling, so a new console can still read larger frames from an older
  agent. Reply downloads explicitly advertise `Accept-Ranges: none`.

### Background process jobs

- Added opt-in Pi-native background execution to the existing `Exec` and `Bash`
  tools. The host owns queued and running process groups, persists bounded output,
  and wakes the exact originating Slack thread, Telegram chat, or web-console
  conversation after completion.
- Restart recovery, cancellation, timeouts, retention, lifecycle cards, operator
  commands, and exact-origin delivery are durable and bounded. Non-Pi provider
  routes fail closed while private process state is present.
- A monotonic owner-private root registry retains every initialized process-job
  state root across disablement, config changes, and restarts. Interrupted
  registry publication recovers before request-time inspection or mutation.

### Portable memory bundles

- Added `mono-agent memory export` and two-phase `memory import prepare` / `apply`
  for owner-private, integrity-checked backups, machine migration, and seeding one
  agent from another without copying provider-specific derived indexes.
- Imports revalidate the source bundle and merge plan, create an fsync-verified
  backup, preserve canonical ids and provenance, and rebuild embeddings under the
  destination agent's configured provider.

### Runtime and delivery reliability

- `WebSearch` now reports an unavailable or blocked backend as a tool failure;
  `No results.` is reserved for a successful search with a genuine empty set.
- Recorded `AskUser` answers are visible across Slack, Telegram, and the web
  console. Slack socket callbacks are deduplicated and triggering bot mentions
  remain readable without changing routing.
- Direct Codex sandbox configuration can explicitly allow network access, A2A
  preserves in-doubt admissions through shutdown, and managed web/launchd log
  checks remain bounded without mutating state for informational CLI commands.

### Release coordination

- All 22 catalog-publishable packages move together to 0.20.0. Keep every
  `@mono-agent/*` package and `create-mono-agent` on the same exact version.

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

## 0.17.0 — ACP bridge and activity consolidation (2026-08-02)

### ACP bridge

- Add an ACP bridge for managed instances, omitting unsupported tool
  environments.

### Console activity

- Fold a finished turn into one activity log that a console thread can
  resume, render a subagent delegation as a folded tree, stop re-slicing a
  turn's answer across the prose before it, and make shell tool previews say
  something.
- Unbreak console prose, fit the tree on a phone, and own subagent cost.

### Memory and Slack

- Offer known entity ids back to capture extraction.
- Choose Slack's message boundaries instead of letting Slack split them, use
  query transport for read methods, tell the agent which surface it is
  talking in, and stop two Slack threads from sharing one run.

## 0.16.0 — Subagent skills and Slack context (2026-07-30)

- Let subagents inherit the parent skill index.
- Send the surrounding Slack conversation as turn context and resolve real
  speaker names for inbound turns.
- Surface provider failover to whoever is watching the run, and settle a
  subagent header when its launch was rejected.

## 0.15.4 — Same-model retries and the Agent tool (2026-07-29)

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

### Fixes

- `provider_status.from` / `.to` are populated again. The router emitted model
  references as objects while the responder read them as strings, so both fields
  were silently dropped and the TUI rendered `failover ? -> ?`.

### Research and attribution

- Add local-first web research tools, render GitHub-Flavored Markdown tables
  in the console, and bound browser socket identifiers.
- Render subagent activity grouped under its agent, author specialized
  subagents at call time with relativized tool paths, make the agent aware of
  who is speaking, treat a trailing NOTHING_TO_REPORT as silence, show the
  command in shell activity ledger lines, and surface Telegram taps that
  match no callback protocol.

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
