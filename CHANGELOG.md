# Release notes

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
