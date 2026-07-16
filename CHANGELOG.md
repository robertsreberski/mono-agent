# Release notes

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
