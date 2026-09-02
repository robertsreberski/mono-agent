# `@mono-agent/agent-runtime` — Migration Guide

Breaking and behavioral changes for consumers upgrading from `0.3.x` to the
current pre-1.0 contract. `createRuntime()` remains the package entry point;
`createMonoRuntime()` remains the typed facade in
`@mono-agent/runtime-adapter`. Provider-session input/output uses
`providerSessionId`, with `disposeSession()` and `disposeAllSessions()` retained.

Review every section that matches your usage. As of `0.21.0` the package runs
exactly one runtime — Pi — behind an explicit exports map, with typed policy
objects, stricter sandbox behavior, and revised provider-session semantics.

Migration policy: every newly introduced fail-closed validation belongs in the
first affected version section, even when it tightens behavior without changing
the configuration schema.

---

## 0.21.0

**This is the largest breaking change since `0.3.x`.** mono-agent shipped six
runtime bridges behind a dispatch table; it now runs only its Pi implementation.
Read the whole section before upgrading a live agent, and run the codemod below
before restarting one.

### Deleted runtime bridges

`claude-sdk`, `claude-code-cli`, `codex-app-cli`, `opencode-app-cli` and
`acp-stdio` are gone. `pi-sdk` remains and is no longer *a* backend — it is the
runtime. The backend descriptor table, the selection table and
`MonoRuntimeBackendId` are removed with them.

### What is NOT deleted

Four surfaces share names with the deleted bridges and are unaffected. If you
use any of them, nothing changes:

- **The ACP *server* bridge** (`mono-agent bridge acp`) — mono-agent still
  serves ACP to clients. Only the ACP *client* backend was removed.
- **`install-skill --target claude|codex`** — writes skills into those tools'
  directories.
- **`docs-mcp-pairing`** — pairs the docs MCP with Claude Code and Codex.
- **The Codex web-search backend** (`tools.web.search.backend: "codex"`) — it
  drives a real Codex app-server through an extracted client.

Note also that `openai-codex` and `opencode-go` are **Pi provider ids**, not
references to the deleted bridges. Routes naming them keep working.

### Model reference grammar

Old: `<sdk>:[<provider>:]<model>`. New: **`<provider>:<model>`**, split at the
first colon only.

| before | after |
| --- | --- |
| `pi:openai-codex:gpt-5.6-sol` | `openai-codex:gpt-5.6-sol` |
| `pi:anthropic:claude-opus-5` | `anthropic:claude-opus-5` |
| `ollama:llama3.1:8b` | unchanged — only the first colon splits |
| `codex:gpt-5.6-terra` | **rejected**; no mechanical replacement |

A leading `pi:` is canonicalized away automatically, so those refs keep working
and the codemod rewrites them for you. `codex:`, `claude:`, `claude-code:`,
`codex-cli:`, `acp:` and `vercel:` are rejected at load with the replacement
named. They are **not** migrated automatically: `codex:gpt-5.6-terra` →
`openai-codex:gpt-5.6-terra` looks mechanical but changes which auth store the
agent reads, and refs paired with `executionMode: "cli"` have no Pi equivalent
at all. A human has to choose.

### Retired configuration keys

Each now fails at load with the repair, instead of a generic unknown-key error:

| key | replacement |
| --- | --- |
| `runtime.executionMode` | delete it — only the Pi runtime remains |
| `memory.llm.executionMode` | delete it, same reason |
| `runtime.routeSafety` | delete it — every route is Pi-native, so `per-route-native` has no meaning |
| `runtime.fallbackModels` | `runtime.fallbacks: [{ "model": "..." }]` |

`runtime.fallbacks` stays uncapped: `runtime.model` plus its fallbacks are the
default route and its backups, nothing more.

### New: `providers`

`providers` declares which providers the agent supports, and widens what is
*selectable* to those providers' full catalogs — previously you could only pick
`runtime.model` or a declared fallback, so trying a new model meant editing
config and restarting. `ollama` and `lmstudio` are zero-config autodiscovered on
`localhost:11434` and `localhost:1234`; an explicit entry only overrides
endpoint or credentials. `providers.local[]` migrates on load.

Agents advertise the catalog additively: a slim `providers` array on `/v1/info`
plus a lazy `GET /v1/models`. `TUI_WIRE_SCHEMA` is **not** bumped, so existing
consoles keep working.

### Removed deep exports

Subpath exports went from 26 to 17. The removed subpaths all belonged to deleted
bridges; import the Pi equivalents from the package root.

### Removed host options

Three `createRuntime()` host options went with the ACP *client* backend that was
their only consumer: `resolveAcpProfile`, `onAcpInteractionRequest` and
`acpSessionTokenKey`. The `0.18.0` and `0.18.1` sections below still describe
them as required — that is a correct record of what those releases needed, and
those sections are deliberately unchanged. As of `0.21.0` the runtime no longer
binds them, and passing them is inert.

This does **not** affect the ACP *server* bridge (`mono-agent bridge acp`),
which never used them; see [What is NOT deleted](#what-is-not-deleted).

### Web console store

Schema v10 → v12, in two guarded steps: v11 adds per-thread `run_model` /
`run_effort`, and v12 adds `agents.providers_json`, the persisted summary of the
providers an agent advertises. Each step is guarded on `PRAGMA table_info` and
re-runnable, and adds columns only — no rows are rewritten. Per-conversation
model and effort overrides now persist server-side, so they roam between devices
instead of living in one browser's localStorage.

### The codemod

`mono-agent migrate-config` ships as a CLI subcommand, not a repo script:
deployed agents run immutable managed runtime snapshots under
`~/.mono-agent/runtimes/`, where a `scripts/` file is unreachable.

```bash
mono-agent migrate-config --check              # exit 1 while work remains
mono-agent migrate-config --write              # applies, writing <config>.bak
```

It deletes the retired keys, converts `fallbackModels` to `fallbacks`, and
strips `pi:` from `runtime.model` and `runtime.fallbacks[].model`. It strips it
from `memory.llm.model` too, but only under `provider: "agent-host"` — the one
provider for which that field is a runtime reference. Under the default
`ollama` provider it is a raw service model string, where the colon in
`qwen3:8b` is a tag separator and rewriting it would repoint memory at a model
that does not exist. Retired `memory.llm.*` keys are deleted either way.

It is not JSON-only. It also migrates the `model:` frontmatter of every `*.md`
in the cron and webhook trigger folders — honouring a renamed `cron.dir` /
`webhook.dir`, resolved relative to the config — and backs each rewritten file
up beside itself as `<name>.md.bak`.

It edits the source text in place, so untouched bytes stay byte-identical and
the `.bak` diff shows only real changes. It refuses to guess non-Pi prefixes,
and skips `configVersion: 1` files untouched. Re-running it is a no-op.

Because a live agent may be writing the same files, every file is re-read and
compared immediately before it is replaced; if the bytes moved meanwhile the
run stops non-zero having replaced nothing, rather than overwriting the other
writer (`--json` reports this as `config-changed-on-disk`). Backups inherit the
source file's permissions instead of the umask default, and a symlinked config
is resolved and written through to its target instead of being replaced by a
regular file.

### Deployment order

Run the check with the **new** CLI, **before** restarting — running it with the
old CLI does nothing useful:

```text
merge → release 0.21.0 → per consumer: mono-agent migrate-config --check
      → migrate → mono-agent restart
```

---

## 0.19.0

- **Oversized `Read` images:** raster image results with an edge above 8,000
  pixels are now normalized before provider embedding. Source files are never
  modified; safe images retain their exact bytes, resized GIF/WebP input keeps
  its animation, and resized BMP input becomes PNG. Undecodable image data now
  fails before the runtime creates an image content block.

## 0.18.2

- **Normalized native-subagent activity:** Claude SDK/CLI and Codex app-server
  children now emit the exact `subagent_activity` lifecycle. Treat
  `subagent.id` as the parent attachment key, `nativeId` only as provider
  correlation metadata, and `phase: "message"` as child prose rather than
  parent answer text or a completed tool call.
- **Explicit native configuration trust:** Claude SDK filesystem settings stay
  disabled unless `settingSources` opts into `user`, `project`, or `local`.
  Those sources may execute hooks and plugins, not only load agents. Codex
  repository instructions remain disabled unless `codexLoadProjectDocs` is
  true; explicit app-server arguments remain authoritative.
- **Provider-owned Codex agents:** non-empty caller-defined `nativeSubagents`
  teammates now fail direct Codex startup with `skipped_capability_mismatch` so
  a router may continue to Claude. Do not synthesize `collaborationMode` or
  assume Claude profile definitions are portable to Codex.
- **Per-attempt policy projection:** `resolveAttempt().policyOptions` may replace
  only `allowedTools`, `disallowedTools`, and `permissionMode` for the active
  route. General resolver `options` still cannot replace protected request
  fields.
- **Pi inline helper ceiling:** the runtime-owned `general-purpose` profile is
  limited to its read-only defaults intersected with `subagents.inline.allowedTools`.
  An empty intersection disables that fallback profile rather than restoring
  wider defaults.

## 0.15.2

- **Tool-policy capability discovery:** built-in bridge capabilities now report
  `tool_policy: "projected" | "allow_all_only"`. Pi, Claude SDK, and Claude Code
  report `projected`; direct Codex and direct OpenCode report
  `allow_all_only`. Custom structural bridges that omit the field have unknown
  capability.
- **Wildcard normalization:** any `allowedTools` list containing `"*"` is
  semantically allow-all. Direct Codex, direct OpenCode, and the public legacy
  Codex CLI export now accept forms such as `["*", "Read"]` when
  `disallowedTools` is empty. Named-only lists, `[]`, and every non-empty
  denylist still fail closed on those non-projecting routes. The guided Codex
  readiness probe retains its exact no-tool contract.
- **Telemetry compatibility:** the route-safety value
  `tools: "exact-allow-all"` is unchanged. It now explicitly denotes the
  effective unrestricted contract rather than requiring a literal one-element
  `["*"]` array.

## 0.15.1

- **Runtime-owned Pi interoperability:** consumers that directly import
  `@earendil-works/pi-ai` only for catalog, reasoning, or OAuth behavior should
  switch to `listPiBuiltinModels`, `getPiBuiltinModel`,
  `reasoningLevelsForPiModel`, `resolvePiOAuthApiKey`, and `loginPiOAuth` from
  `@mono-agent/agent-runtime/ai`. The runtime exact-pins Pi AI at `0.84.3` and Pi Agent Core at `0.83.0`;
  the façade returns cloned model and credential
  snapshots rather than exposing upstream provider objects.
- **Claude test seam:** downstream tests should pass
  `RuntimeRunOptions.claudeAgentQuery` instead of mocking
  `@anthropic-ai/claude-agent-sdk` by package name. Normal runs omit this option
  and use the runtime-owned SDK. Pi AI's `@anthropic-ai/sdk@0.91.1` pin and the
  Claude Agent SDK's `@anthropic-ai/sdk>=0.93.0` requirement intentionally
  remain as two isolated SDK versions.
- **Compaction policy cleanup:** the inert
  `toolPayloadCompactionTriggerChars` and `toolPruneTriggerTokens` properties
  were removed from `AgentCompactionPolicy`, policy resolution, defaults, and
  declarations. They had no supported typed/config path and did not activate
  runtime pruning, so no replacement is required.
- **Codex live-input teardown:** a Codex app-server transport death now also
  terminates a pending live-input read. Runs settle with the existing
  `provider_unavailable` / `codex_app_server_closed` classification instead of
  waiting forever for the input iterator. If a host `acknowledge` or `reject`
  callback throws, the already-decided native steering result remains
  authoritative and the runtime emits a bounded
  `live_input_callback_failed` warning.

## 0.18.1

- ACP provider-session ids and session-list cursors are now confidential,
  authenticated v2 handles. Hosts must persist one exact 32-byte binary
  `acpSessionTokenKey` and pass it to ACP task runs, list/delete helpers, and
  `validateAcpProviderSessionId(value, expectedProfileId, key)`. A changed or
  missing key fails before profile resolution or process spawn. Existing v1
  handles are rejected; discard them and obtain fresh v2 handles. Preserve the
  complete returned value for resume, pagination, validation, and delete, but
  do not compare ciphertexts for equality or parse/substitute the remote
  agent's raw session id or cursor.
- Payload-bearing diagnostics from the pinned ACP SDK are scoped to the owned
  ACP receive loop and reduced to content-free labels. Malformed or hostile
  agent notifications cannot copy elicitation values or URL secrets into
  process-wide console diagnostics.

## 0.18.0

- `acp:<profile-id>` is now a canonical runtime model reference when paired
  with `executionMode: "acp"`. Hosts must provide `resolveAcpProfile`; profiles
  define direct argv/environment values, client-versus-agent ownership,
  capability policy, session configuration, and bounded process policy.
- `onAcpInteractionRequest` is the host rendezvous for ACP permission and
  elicitation requests. Hosts must echo only advertised permission option ids,
  keep submitted form values out of durable logs, and fail closed on abort.
- ACP profile callbacks never receive raw protocol `sessionId`, `_meta`, or
  copied raw-id strings. Use the optional opaque
  `AcpCallbackContext.providerSessionId` for safe session correlation.
- ACP provider-session ids and session-list cursors are opaque, profile-bound
  runtime handles. Preserve the complete value returned by the runtime for
  resume, pagination, validation, and delete operations; do not parse or
  substitute the remote agent's raw session id or cursor. Raw ACP transport
  connections are internal; use the high-level management helpers.
- The stable ACP update stream is preserved as typed `acp_session_update`
  events and normalized assistant, thought, tool, plan, and cumulative usage
  events. Stable usage comes from `usage_update`, not experimental prompt
  response fields.
- ACP management helpers (`probeAcpProfile`, `authenticateAcpProfile`,
  `logoutAcpProfile`, `listAcpSessions`, and `deleteAcpSession`) use the same
  resolver and callback boundary as turns. Authentication always requires an
  explicitly selected advertised method id.

## 0.17.x baseline

This prior baseline carries the 0.16.x contract forward
and adds a host-only, request-scoped `toolEnvironment` boundary. Hosts may pass
validated values and PATH prefixes through the request, harness, and runtime;
the runtime applies them only when Bash, Exec, or a nested subagent process is
spawned. It does not mutate `process.env` or persist the values in prompts,
metadata, history, traces, or long-lived tool context.

- **0.17.1 Pi auth classification:** Pi 0.83 may report a missing credential as
  `Provider is not configured: <provider>`. The runtime now classifies that
  exact signature as `provider_auth`, allowing a configured fallback route to
  run while avoiding a same-route retry that cannot repair absent credentials.

## 0.16.x

This baseline carries the whole 0.15.x contract forward and adds:

- `skills` and `skillsRoot` on the run options. `skills` is the disclosed
  `{name, description}` set for a run; a non-empty value makes `supports_skills`
  a routing requirement, so a chain entry lacking it is skipped. `skillsRoot`
  names the directory holding `<name>/SKILL.md` and is required alongside
  `skills` for `ReadSkill` to exist. A subagent run now inherits both from its
  parent unless a host-supplied `run` withholds them, so a child no longer has
  to rediscover by trial and error what its parent could look up.
- Provider failover detail reaches whoever is watching the run rather than being
  flattened at the boundary.
- Pi AI 0.84.3 with Pi Agent Core 0.83.0.

## 0.15.x

- The explicit exports map, the five-bridge lazy registry, typed runtime
  policies, runtime-owned provider dependencies, and the public-surface cleanup
  described in this guide.

## 0.12.x

- Persistent provider context overflow is classified as `context_limit`, which
  lets a fallback router try its next model without conflating context capacity
  with quota, output, or max-turn `usage_limit` failures.
- Omitted Pi compaction values resolve from effective context window `W`:
  trigger ratio `0.70`, retained context `10%`, summary output `4%`, and minimum
  proactive savings `10%`, subject to the documented scalar clamps. Numeric
  provider limits and generic overflow evidence may lower a learned
  process-local ceiling; `contextWindowOverride` remains the persistent
  correction.

## 0.10.x

- Direct Codex normal runs introduced a fail-closed tool-policy gate: omitted
  `allowedTools` or the explicit `["*"]` sentinel was accepted with no denied
  tools, while named-only allowlists, `[]`, and deny lists were rejected before
  provider startup. Version 0.15.2 preserves that safety boundary while
  normalizing every wildcard-containing allowlist to the same effective
  allow-all meaning.
- `ReadSkill` returns complete skill instructions by default, including content
  beyond the former 12,000-character boundary. Programmatic callers of
  `formatSkillBodyWithPathNote()` opt into truncation by passing a positive
  `maxChars`; omitting it means no helper-level cap. The standard 256 KiB
  tool-payload guard remains in effect.

## 0.7.x

- Omitting Claude SDK effort now preserves the provider default instead of
  deriving a `thinking` option. Supported effort values are forwarded exactly;
  explicit `none` is unsupported (`skipped_capability_mismatch` through the
  bridge, while direct `claudeEffortOptions("none")` calls throw).
- Cancellation uses a private abort controller and closes the active Claude SDK
  `Query` with `Query.close()`. Test doubles must honor both boundaries rather
  than implementing only iterator `return()`.
- `Glob` and `Grep` prefer an explicit `ripgrepPath`, then the packaged
  `@vscode/ripgrep` binary on supported platforms, and finally `PATH`.

## 0.6.2

- Codex file edits use a flat top-level `file_change` event instead of synthetic
  assistant/user `file_edit` tool-use/tool-result pairs.
- The synthetic `createClaudeFileEditHooks`,
  `createFileEditToolUseEvent`, and `createFileEditToolResultEvent` exports were
  removed. Consumers should observe normalized runtime events or use the
  remaining file-change statistics helpers rather than recreating provider hook
  behavior.

---

## Detailed pre-1.0 reference

### Pre-1.0 public-surface cleanup

The compatibility entrypoints `./ai/backend.js` and `./ai/registry.js` were
removed after repository-wide reachability checks found no supported caller.
The old `findProviderForModel` / `listProviders` aliases and provider/backend
constant objects were removed at the same time. Import `resolveRuntimeBridge`
or `listRuntimeBridges` from `@mono-agent/agent-runtime` (or its `./ai` barrel)
instead. Runtime behavior and the canonical bridge descriptors are unchanged.

---

### 1. Pi is now native-only (`pi-sdk.js` → `pi-native.js`)

The hand-rolled Pi bridge that drove the low-level `Agent` was replaced by a
bridge built on `@earendil-works/pi-agent-core`'s high-level `AgentHarness`. The
registry resolves `pi` → the native bridge unconditionally; there is no
`piEngine` flag.

- **Public runtime API** (`createRuntime`, model reference `"pi:<provider>:<model>"`)
  is unchanged — `pi:openai:gpt-5.5` etc. still work.
- **Deep imports** of `@mono-agent/agent-runtime/ai/providers/pi-sdk.js` **no
  longer resolve**: the compatibility shim was removed and the explicit exports
  map has no provider wildcard. **Action:** import
  `generatePiNativeResponse` / `piNativeRuntimeBridge` from
  `@mono-agent/agent-runtime/ai`, or select Pi through the public runtime
  registry. `pi-errors.js` is internal and is not an exported replacement; use
  the normalized `RuntimeResult.failureKind` or the public failure helpers at
  `@mono-agent/agent-runtime/ai/failure.js`. The `pi*Backend` aliases are gone —
  all Pi routes through the native bridge.

### 2. Removed run options: `piReasoningSummary`, `piCodexTransport`

These were Pi-bridge knobs the native path does not consume.

- `piReasoningSummary` is **no longer read** and was removed from the run-options
  type. Pi-native derives reasoning from `effort` (`thinkingLevel`); the
  Codex and Claude CLI bridges emit their own reasoning events. **Action:**
  remove `piReasoningSummary` from call sites. The former
  `runtime.reasoningSummary` config field has also been removed.
- `piCodexTransport` was doc-only and is removed. No replacement is needed.

### 3. Pi context compaction: bridge-driven via AgentHarness.compact()

`AgentHarness` has no automatic compaction, so the pi bridge drives it directly
(the legacy low-level `transformContext` / `afterToolCall` hooks and
`createAgentCompactionManager` were removed):

- Before each turn the bridge estimates the running model's context usage and
  calls `AgentHarness.compact()` when near the window (proactive). If a turn still
  overflows the bridge compacts once and re-prompts (reactive recovery).
- Runs report **`capabilitiesUsed.context_compaction_applied`** as `true` (a
  compaction fired), `false` (enabled but not needed), or `null` (disabled via
  `runtime.compaction.enabled: false`). If you assert on this value, expect this
  tristate on the Pi path.
- The host **`onCompactionRecorded`** callback now **fires on each automatic
  compaction** on the Pi path (previously inert).
- The trigger and omitted budgets adapt to the model actually serving the
  request (`harness.getModel()`). Numeric overflow limits and generic failed
  request estimates lower a learned process-local ceiling; use
  `runtime.compaction.contextWindowOverride` for a persistent metadata
  correction. Deprecated programmatic `agent_compaction_*` settings and
  `resolveAgentCompactionPolicy` remain compatibility surfaces.

### 4. Durable Pi session resume: create-on-miss semantics

When a run supplies a `providerSessionId` (or the legacy `sessionId` alias) **and**
durable storage is configured (`piSessionsRoot`), Pi-native now **creates the
session with that id if no on-disk JSONL exists** (create-on-miss), instead of returning
`session_not_found`. An existing JSONL is reopened and resumed as before.

This makes a **stable, conversation-derived session id resume across process
restarts** (the on-disk transcript is the durable history; the in-memory
conversation→session map is no longer required to resume). **Action:** if you
passed an arbitrary `providerSessionId` to a durable run expecting a hard
`session_not_found` on first use, note it now succeeds by creating that session.
The in-memory (non-durable) resume path still fast-fails `session_not_found` on a
miss.

### 5. Fallback router enforces requested native-subagent capability

Pi advertises `supports_native_subagents: false`. The fallback router now infers
a `supports_native_subagents` requirement when a run passes
`options.nativeSubagents.teammates` (non-empty), the same way it already infers
`structured_output` from `outputSchema`. A chain entry that cannot satisfy it
(e.g. a Pi fallback behind a Claude primary that was handed native teammates) is
**skipped** (`skipped_capability_mismatch`) rather than silently succeeding with
`nativeSubagentsUsed: []`. **Action:** if you configure fallback chains for
native-subagent runs, ensure at least one entry supports native subagents, or the
run reports exhausted instead of degrading silently.

Caller-defined `nativeSubagents.teammates` are a Claude-only projection. Codex
still advertises and reports its provider-owned native collaboration surface,
but a direct Codex attempt now rejects configured teammate/profile definitions
with `codex_native_subagent_definitions_unsupported` before transport; a router
may then continue to Claude. Use `codexLoadProjectDocs: true` to enable Codex's
repository instructions, not to define Codex collaboration profiles.

### 6. Diagnostics & internal behavior changes (no API change)

- **Pi multimodal**: image inputs are delivered to the model as image content
  blocks (internal fix; affects behavior, not the call shape).
- **Tool-output limits**: settings-driven clamps (`agent_tool_text_limit_chars`,
  `agent_search_result_limit`, `toolPayloadMaxBytes`, …) are honored again on the
  Pi path (built-ins + MCP). The 256 KB tool-payload ceiling is unchanged.
- **WebFetch** retries transient network errors (timeout / ECONNRESET / 5xx)
  in-tool with backoff before returning an error.
- **Claude CLI**: the temporary `mcp.json` written for a CLI run is now created
  with `0600` (owner-only) permissions.
- Pi session lifecycle is hardened: aborts during setup are honored before the
  provider call, fresh durable sessions are deleted on setup/abort failure, and
  resumed sessions roll back to their pre-turn leaf on host-side (outer-catch)
  failures. These are correctness fixes with no API surface change.

### 7. Sandbox enforcement is now an injectable seam (agent-runtime has zero workspace-package dependencies)

`@mono-agent/agent-runtime` does not depend on `@mono-agent/runtime-adapter`. Sandbox
enforcement (command sandboxing, network-policy checks, and monotonic policy
merging) is now driven through an injectable `RuntimeSandbox` seam
(`agent/sandbox-seam.js`): `createRuntime({sandbox})` / `createRouterRuntime({host: {sandbox}})`
accept an implementation. `@mono-agent/runtime-adapter` injects the real
sandbox implementation automatically for every
`createMonoRuntime(...)` call, so behavior is **byte-identical** for existing
mono-agent hosts — no action needed if you build your runtime through
`@mono-agent/runtime-adapter`.

- **No sandbox policy configured, no implementation injected:** unchanged —
  every tool runs unsandboxed, exactly as before.
- **A sandbox policy IS configured, but no `RuntimeSandbox` implementation is
  injected** (only possible if you call `@mono-agent/agent-runtime`'s
  `createRuntime` directly, bypassing `@mono-agent/runtime-adapter`): **this
  now fails closed** with a `sandbox_unavailable` error instead of silently
  running the command unsandboxed. Previously `@mono-agent/agent-runtime`
  always bundled the real sandbox implementation and always enforced the policy; a
  host that built on `createRuntime` directly and relied on that implicit
  availability must now also inject a `RuntimeSandbox` implementation (the
  real one from `@mono-agent/runtime-adapter`, or a custom one) to keep policies
  enforced. **Action:** if you configure `sandboxPolicy` and call
  `createRuntime`/`createRouterRuntime` directly instead of going through
  `@mono-agent/runtime-adapter`, also pass a `sandbox` implementation, or drop
  the policy.

### 8. Typed run options replace the `settings` bag (`toolLimits` / `compaction` / `prompts`)

The flat `options.settings` bag is **deprecated** as the way to configure
tool-output clamps and context compaction. The supported replacements are typed,
per-run objects on `RuntimeRunOptions`:

- **`options.toolLimits`** (`RuntimeToolLimits`) — `toolTextLimitChars`,
  `bashOutputLimitChars`, `mcpTextLimitChars`, `searchResultLimit`,
  `imageInlineMaxBytes`, `toolPayloadMaxBytes`, `mcpCallTimeoutMs`,
  `mcpCallMaxTotalTimeoutMs`, `bashTimeoutMs`.
- **`options.compaction`** (`RuntimeCompactionPolicy`) — `enabled`,
  `triggerRatio`, `keepRecentTokens`, `summaryMaxTokens`, `minSavingsTokens`,
  `fixedOverheadEnabled`, `contextWindowOverride`.

Precedence is **per-group**: a present typed object wins wholesale for its group
and that group's legacy `settings` keys are ignored; an absent typed object lets
its group's `settings` keys through as a fallback. Consuming **any** legacy
`settings` key emits exactly one `runtime_warning` with
**`warning_kind: "deprecated_settings_option"`** per run (listing the consumed
keys). Passing no `settings` — or an empty/irrelevant bag — never warns.

`resolveAgentCompactionPolicy(settings, model)` stays exported (the canonical
clamp/mapper both paths route through), and `@mono-agent/runtime-adapter` exposes
`resolveRuntimePolicies(settings)` to map a legacy bag to the typed objects.
The migration helper preserves omitted legacy compaction values so adaptive
defaults are resolved later against the live model rather than frozen at the
mapper's fallback window.
**Action:** migrate `settings` → `toolLimits` / `compaction`; until then the shim
keeps working with one deprecation warning per run.

### 9. New per-run overrides: `sandbox`, `sandboxPolicy`, `prompts`

Beyond `toolLimits` / `compaction`, `RuntimeRunOptions` gained:

- **`sandbox`** — a per-run `RuntimeSandbox` implementation override. Precedence
  is run > host > passthrough; it overrides only the *enforcing code*, while the
  policy **data** still merges monotonically (I13, section 7).
- **`sandboxPolicy`** — per-run policy data, merged monotonically with the host
  policy (it can **tighten**, never weaken or disable).
- **`prompts`** (`RuntimePromptOverrides`) — per-run overrides of the kernel's
  built-in prompt fragments: `structuredOutputInstruction(systemPrompt)`,
  `structuredOutputFinalization()`, `liveInputGuidance(body)`. Run wins over the
  host-level `prompts` default; an absent field keeps the built-in string
  (byte-identical default). These are also accepted on `AgentRuntimeHostOptions`
  as the host-level default.

### 10. Pi 0.80 auth: `Models` credential store (`resolvePiApiKey` semantics preserved)

Pi 0.80 removed the harness `getApiKeyAndHeaders` hook; request auth now resolves
through a `Models` collection's `CredentialStore`. The bridge's **per-run
key-resolution contract is unchanged**: an `apiKeys` map entry wins, else the host
`resolvePiApiKey(provider)` callback is consulted; a callback failure emits a
`pi_auth_failed` runtime warning and proceeds keyless (a builtin provider then
falls back to its own env vars, exactly as returning `undefined` from the old hook
did). **No host action needed** — `resolvePiApiKey` behaves as before.

Dependency bump: **`@earendil-works/pi-ai` is now `0.84.3`; `@earendil-works/pi-agent-core` remains `0.83.0`**
(the initial Pi 0.80 migration landed at `0.80.5`, from `^0.79.1`, ran at
`0.80.6` until the 0.83 upgrade, and then at `0.83.0`). Agent Core 0.84.3 is
held back because its replacement durable harness does not yet implement the
prompt, subscription, compaction, or abort paths used here. Compaction is driven
natively (section 3), and model-native `max` reasoning plus Pi's request-wide
pricing tiers are preserved.

Packed npm consumers consequently retain Agent Core's nested Pi AI 0.83.0
compatibility copy beside the runtime-owned Pi AI 0.84.3 catalog/provider copy.
The release guard resolves and verifies both exact paths independently.

The 0.83 upgrade carries two upstream removals, both absorbed inside the runtime
so hosts need no action:

- `@earendil-works/pi-ai/oauth` became a type-only entry point. The generic
  registry (`getOAuthApiKey`, `getOAuthProvider`, `getOAuthProviders`) is gone,
  and the per-provider flows are not importable. `src/ai/pi-oauth-compat.js`
  rebuilds the same contracts over `provider.auth.oauth`, so `resolvePiApiKey`,
  `resolvePiOAuthApiKey`, and `loginPiOAuth` keep their existing signatures and
  behaviour, including the refresh-on-expiry trigger.
- `AgentHarnessOptions.env` was removed in favour of a per-turn `toolContext`.
  The runtime passes neither: it uses none of Pi's built-in file/shell tools.

### 11. Exports map: wildcards removed (explicit deep-path map)

The package's `./ai/*` and `./agent/*` **wildcard exports were replaced by an
explicit `exports` map**: 3 barrels (`.`, `./ai`, `./agent`) plus the generated
deep-path inventory below, with every entry carrying its own `types` condition.
A deep import that is not on the map **no longer resolves** — a wildcard used to
silently resolve anything under `src/`, so a moved/renamed/mistyped subpath is
now a loud failure (guarded by `scripts/verify-deep-imports.mjs`).

<!-- public-api-js-subpaths:start -->
<!-- Generated by scripts/generate-public-api-docs.mjs. Do not edit by hand. -->

The package exposes **14 named deep `.js` subpaths**:

```text
@mono-agent/agent-runtime/agent/allowlists.js
@mono-agent/agent-runtime/agent/compaction.js
@mono-agent/agent-runtime/agent/prompt/skill-index.js
@mono-agent/agent-runtime/agent/tools/index.js
@mono-agent/agent-runtime/agent/tools/shared/ripgrep.js
@mono-agent/agent-runtime/agent/tools/shared/runtime-context.js
@mono-agent/agent-runtime/agent/transcript.js
@mono-agent/agent-runtime/ai/cost.js
@mono-agent/agent-runtime/ai/failure.js
@mono-agent/agent-runtime/ai/file-change-stats.js
@mono-agent/agent-runtime/ai/live-input-prompt.js
@mono-agent/agent-runtime/ai/providers/codex/app-server-client.js
@mono-agent/agent-runtime/ai/runtime/model-refs.js
@mono-agent/agent-runtime/ai/runtime/registry.js
```
<!-- public-api-js-subpaths:end -->

**Action:** if you deep-import a subpath not in this list, switch to the closest
supported one, a barrel (`./ai` / `./agent`), or the public runtime registry.
`pi-sdk.js` is gone and remains intentionally unexported (section 1). Import
`generatePiNativeResponse` from `@mono-agent/agent-runtime/ai` instead of adding
a compatibility subpath.

---

## Version

This guide describes the published `0.20.x` package contract. Keep
`@mono-agent/agent-runtime`, `@mono-agent/runtime-adapter`, and other
`@mono-agent/*` packages on the same lockstep version when upgrading. The paired
runtime adapter no longer exposes `piReasoningSummary` in its run-options type.

---

## Appendix — Worklab shared-kernel adoption

Worklab should consume the published `@mono-agent/agent-runtime` package rather
than vendor or rename its source. The products remain separate, but provider
execution has one owner. Apply this downstream checklist when removing
Worklab's runtime fork:

1. **Install the lockstep runtime package.** Keep the `@mono-agent/*` packages a
   Worklab release uses on the same published version. Preserve the shared
   kernel's `GPL-3.0-only` distribution boundary.
2. **Remove direct provider ownership.** Delete Worklab production imports from
   `@earendil-works/pi-ai`, its separate Pi version constraint, and local copies
   of provider bridge code. Move tests off Pi's faux-provider helpers too; until
   that is complete, isolate the fixture or pin its development-only dependencies
   to the exact Pi AI `0.84.3` and Pi Agent Core `0.83.0` compatibility pins
   rather than floating ranges. Do not restore the
   removed `pi-sdk.js` subpath.
3. **Use the public Pi surfaces.** Run models through
   `generatePiNativeResponse` or the runtime registry. Use
   `listPiBuiltinModels`, `getPiBuiltinModel`,
   `reasoningLevelsForPiModel`, `resolvePiOAuthApiKey`, and `loginPiOAuth` for
   catalog and OAuth integration. Those façades keep Pi provider objects and the
   exact Pi AI `0.84.3` and Pi Agent Core `0.83.0` compatibility pins inside the runtime. OAuth login adapters
   must supply `onAuth`, `onDeviceCode`, `onPrompt`, and `onSelect`; the façade
   rejects an incomplete callback contract before starting provider login.
4. **Inject Claude tests.** Replace package-level mocks of
   `@anthropic-ai/claude-agent-sdk` with
   `RuntimeRunOptions.claudeAgentQuery`. Production calls omit the seam. Expect
   the runtime installation to retain Pi's Anthropic SDK `0.91.1` beside the
   newer Anthropic SDK required by Claude; do not force-deduplicate them.
5. **Preserve the sandbox boundary.** A direct runtime consumer that supplies
   `sandboxPolicy` must also inject a `RuntimeSandbox`; otherwise the runtime
   intentionally fails closed. With neither a policy nor an implementation,
   passthrough behavior remains unchanged.
6. **Use supported contracts.** Keep host callbacks within
   `AgentRuntimeHostOptions`, tool state within the exported tool-runtime
   context, and reads within `RuntimeResult`. Replace deprecated
   `options.settings` with typed `toolLimits` and `compaction` objects.
7. **Verify the installed package.** Run Worklab's provider and worker tests
   against the packed or published package, assert that no production import
   resolves Pi directly, and prove the injected Claude query performs no
   network call.
