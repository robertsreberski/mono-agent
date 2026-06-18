# `@mono-agent/agent-runtime` — Migration Guide

Breaking and behavioral changes for consumers upgrading **from `0.3.x`** (the
`feat/runtime-live-sessions` line). The public entry points are unchanged —
`createRuntime` / `createMonoRuntime`, the run-options contract, and provider
session support (`sessionId` in, `provider_session_id` out, `disposeSession` /
`disposeAllSessions`) all keep their shapes. The changes below affect the **Pi
runtime bridge, a few run options, durable-session semantics, the fallback
router, and some diagnostics**.

If you only use the Claude SDK / Claude CLI / Codex backends and do not touch Pi
or durable sessions, this is a no-op upgrade.

---

## 1. Pi is now native-only (`pi-sdk.js` → `pi-native.js`)

The hand-rolled Pi bridge that drove the low-level `Agent` was replaced by a
bridge built on `@earendil-works/pi-agent-core`'s high-level `AgentHarness`. The
registry resolves `pi` → the native bridge unconditionally; there is no
`piEngine` flag.

- **Public runtime API** (`createRuntime`, model reference `"pi:<provider>:<model>"`)
  is unchanged — `pi:openai:gpt-5.5` etc. still work.
- **Deep imports** of `@mono-agent/agent-runtime/ai/providers/pi-sdk.js` still
  resolve via a **deprecated compatibility shim** that re-exports the native
  equivalents (`generatePiResponse` → `generatePiNativeResponse`,
  `piRuntimeBridge` → `piNativeRuntimeBridge`, `isContextLimitError`,
  `normalizePiErrorMessage`, and the `pi*Backend` symbols). **Action:** migrate
  deep imports to `./ai/providers/pi-native.js`; the shim may be removed in a
  future major.

## 2. Removed run options: `piReasoningSummary`, `piCodexTransport`

These were Pi-bridge knobs the native path does not consume.

- `piReasoningSummary` is **no longer read** and was removed from the run-options
  type. Pi-native derives reasoning from `effort` (`thinkingLevel`); the
  codex/claude CLIs emit reasoning summaries on their own. **Action:** stop
  passing `piReasoningSummary` — it was already a no-op on the native path; remove
  it from your call sites. (Host config `runtime.reasoningSummary` still validates
  for back-compat but is not wired to a runtime option.)
- `piCodexTransport` was doc-only and is removed. No replacement is needed.

## 3. Pi context compaction: no automatic in-loop summarization

The legacy Pi bridge wired `transformContext` / `afterToolCall` into the
low-level Agent loop. `AgentHarness` has no automatic compaction, so:

- Runs now report **`capabilitiesUsed.context_compaction_applied: null`**
  (unknown/unsupported) for Pi — previously `false`. If you assert on this value,
  update to expect `null` on the Pi path.
- The host **`onCompactionRecorded`** callback is **inert on the Pi path** (it
  never fires). `resolveAgentCompactionPolicy` / `createAgentCompactionManager`
  remain exported for back-compat but are not wired into a standard Pi run.
- Context handling is delegated to the provider (pi-ai / `AgentHarness`). If you
  relied on host-driven in-loop summarization for long Pi runs, drive
  `AgentHarness.compact()` yourself or budget context another way.

## 4. Durable Pi session resume: create-on-miss semantics

When a run supplies a `sessionId` **and** durable storage is configured
(`piSessionsRoot`), Pi-native now **creates the session with that id if no
on-disk JSONL exists** (create-on-miss), instead of returning
`session_not_found`. An existing JSONL is reopened and resumed as before.

This makes a **stable, conversation-derived session id resume across process
restarts** (the on-disk transcript is the durable history; the in-memory
conversation→session map is no longer required to resume). **Action:** if you
passed an arbitrary `sessionId` to a durable run expecting a hard
`session_not_found` on first use, note it now succeeds by creating that session.
The in-memory (non-durable) resume path still fast-fails `session_not_found` on a
miss.

## 5. Fallback router enforces requested native-subagent capability

Pi advertises `supports_native_subagents: false`. The fallback router now infers
a `supports_native_subagents` requirement when a run passes
`options.nativeSubagents.teammates` (non-empty), the same way it already infers
`structured_output` from `outputSchema`. A chain entry that cannot satisfy it
(e.g. a Pi fallback behind a Claude primary that was handed native teammates) is
**skipped** (`skipped_capability_mismatch`) rather than silently succeeding with
`nativeSubagentsUsed: []`. **Action:** if you configure fallback chains for
native-subagent runs, ensure at least one entry supports native subagents, or the
run reports exhausted instead of degrading silently.

## 6. Diagnostics & internal behavior changes (no API change)

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

---

## Version

These changes ship in the first `agent-runtime` release after `0.3.0` on the
`feat/runtime-live-sessions` line (a minor/major bump; see the release tag). The
paired `@mono-agent/runtime-adapter` drops the `piReasoningSummary` field from its
run-options type in lockstep.
