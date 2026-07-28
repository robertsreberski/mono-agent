# `@mono-agent/agent-runtime` — Migration Guide

Breaking and behavioral changes for consumers upgrading from `0.3.x` to the
current pre-1.0 contract. `createRuntime()` remains the package entry point;
`createMonoRuntime()` remains the typed facade in
`@mono-agent/runtime-adapter`. Provider-session input/output uses
`providerSessionId`, with `disposeSession()` and `disposeAllSessions()` retained.

Review every section that matches your usage. The package now has an explicit
exports map, a five-bridge lazy registry, typed policy objects, stricter sandbox
behavior, and revised provider-session semantics even when Pi is not your
primary route.

Migration policy: every newly introduced fail-closed validation belongs in the
first affected version section, even when it tightens behavior without changing
the configuration schema.

---

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
  `@mono-agent/agent-runtime/ai`. The runtime keeps Pi AI and Pi Agent Core
  exact-pinned at `0.80.6`; the façade returns cloned model and credential
  snapshots rather than exposing mutable upstream registries.
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

## 0.15.x baseline

This is the current published baseline for the detailed pre-1.0 reference
below. It includes the explicit exports map, the five-bridge lazy registry,
typed runtime policies, runtime-owned provider dependencies, and the
public-surface cleanup described in this guide.

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

Dependency bump: **`@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` are
now `0.80.6`** (the initial Pi 0.80 migration landed at `0.80.5`, from
`^0.79.1`). Compaction is driven natively (section 3). The `0.80.6` refresh also
preserves model-native `max` reasoning and Pi's request-wide pricing tiers.

### 11. Exports map: wildcards removed (explicit deep-path map)

The package's `./ai/*` and `./agent/*` **wildcard exports were replaced by an
explicit `exports` map**: 3 barrels (`.`, `./ai`, `./agent`) plus the generated
deep-path inventory below, with every entry carrying its own `types` condition.
A deep import that is not on the map **no longer resolves** — a wildcard used to
silently resolve anything under `src/`, so a moved/renamed/mistyped subpath is
now a loud failure (guarded by `scripts/verify-deep-imports.mjs`).

<!-- public-api-js-subpaths:start -->
<!-- Generated by scripts/generate-public-api-docs.mjs. Do not edit by hand. -->

The package exposes **21 named deep `.js` subpaths**:

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
@mono-agent/agent-runtime/ai/providers/claude-cli.js
@mono-agent/agent-runtime/ai/providers/claude-sdk-discovery.js
@mono-agent/agent-runtime/ai/providers/claude-sdk.js
@mono-agent/agent-runtime/ai/providers/codex-app.js
@mono-agent/agent-runtime/ai/providers/opencode-discovery.js
@mono-agent/agent-runtime/ai/runtime/context-windows.js
@mono-agent/agent-runtime/ai/runtime/fast-mode.js
@mono-agent/agent-runtime/ai/runtime/model-refs.js
@mono-agent/agent-runtime/ai/runtime/registry.js
@mono-agent/agent-runtime/ai/streaming/codex-events.js
```
<!-- public-api-js-subpaths:end -->

**Action:** if you deep-import a subpath not in this list, switch to the closest
supported one, a barrel (`./ai` / `./agent`), or the public runtime registry.
`pi-sdk.js` is gone and remains intentionally unexported (section 1). Import
`generatePiNativeResponse` from `@mono-agent/agent-runtime/ai` instead of adding
a compatibility subpath.

---

## Version

This guide describes the published `0.15.x` package contract. Keep
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
   that is complete, isolate the fixture or pin its development-only Pi
   dependency to exact `0.80.6` rather than a floating range. Do not restore the
   removed `pi-sdk.js` subpath.
3. **Use the public Pi surfaces.** Run models through
   `generatePiNativeResponse` or the runtime registry. Use
   `listPiBuiltinModels`, `getPiBuiltinModel`,
   `reasoningLevelsForPiModel`, `resolvePiOAuthApiKey`, and `loginPiOAuth` for
   catalog and OAuth integration. Those façades keep Pi mutable state and the
   exact `0.80.6` compatibility pin inside the runtime. OAuth login adapters
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
