# 03 · Runtime host lifecycle (agent-app)

**Scope:** host startup/shutdown, launchd install/manage, managed-runtime and sandbox-runtime materialization, config-approval transaction machinery, and process-incarnation-based locking in `packages/agent-app`.

**Maturity grade:** B+ (verifier-adjusted, unchanged). This is the most defensively engineered territory in the audit — every shared-filesystem touchpoint does TOCTOU-safe stat-before/after checks and fails closed — and after adversarial verification it produces **zero freeze-blockers**: the one finding proposed as blocking (F1) was confirmed real but downgraded to a non-blocking test-coverage gap, and one dead-code claim (F2) was outright refuted — `attestManagedBackgroundRuntime` turned out to be live production code reached from `scripts/` rather than from within the package. The remaining picture is unchanged from the raw audit: a god-object controller, a correctness primitive (owner-private incarnation lock) hand-rolled four times, and small cosmetic/hardening gaps.

## Findings

**F1 — [P1] [verifier: CONFIRMED, freeze-blocker REJECTED] — `packages/agent-app/src/runtime-option-extensions.ts:49-67`** (also exercised from `configured-agent.ts:399-407` and `app.ts:1567-1575`)
`preserveMcpServersUnderOverride` is the mechanism that keeps the app-owned, read-only `MemoryRecall` MCP server registered even when a later, authoritative extension (e.g. `/configure`) clamps `toolPolicyOverride` down to a tiny allowlist. Its doc comment states an explicit security property ("an arbitrary caller cannot preserve a server by merely reusing a trusted server name"), but the verifier confirmed no test ever exercises this branch: the only `composeRuntimeOptionExtensions` test (`request-model-override.test.ts:599-630`) passes no options object and uses an override that never emits `toolPolicyOverride`, so lines 49-67 never execute. The verifier found the code itself **correct and in production** (identity `Set`, used correctly at `configured-agent.ts:406`) — so this is a missing-test regression risk, not a shipped defect, and does not falsify honest ops or block a DoD clause.
```
if (toolPolicyOverride !== undefined) {
  const preservedServers: Record<string, unknown> = {};
  const preservedExtensions = new Set(options.preserveMcpServersUnderOverride ?? []);
```

**F2 — [REFUTED — not a finding] — see Quarantine.**

**F3 — [P2] [verifier: CONFIRMED] — `packages/agent-app/src/app.ts:284-2090`** (~1806 LOC, verifier's exact count; raw audit's "~1900" was a mild overstatement)
`MonoAgentAppController` owns channel lifecycle, traceability registration + registry mirroring + periodic refresh, sandbox status, a 30-second memory-health poll loop with its own generation/single-flight bookkeeping, the interaction bridge, the continuation service, the shared memory store, the artifact-retention scheduler, session-event tracking, and the entire per-channel `AgentResponder` composition. The verifier confirmed this as a genuine "lean, understandable core" premise hit, not style noise: ten-plus concerns living in one instance means a change to any one (e.g. continuation wiring) must be reasoned about against the state of nine others.

**F4 — [P2] [verifier: CONFIRMED] — duplicated lock primitive across four files**
```
acquireBackgroundWorkerLease   background-worker-lease.ts:91-192
acquireFilesystemLifecycleLock background.ts:1369-1496
acquireRuntimeLock             background-runtime.ts:1318-1382
acquireInstallLock (+ acquireInstallGuard) sandbox-manager.ts:1043-1170
```
All four independently re-implement "mkdir an owner-private directory, write `owner.json` with PID + process-incarnation, detect staleness via `isSameProcessIncarnation`, rename the stale directory to quarantine before retrying" — each with its own constants and copy of the identity-comparison helpers. The verifier confirmed all four sites and the real risk: a correctness fix discovered in one copy (e.g. a TOCTOU gap in the stale-rename race) is not guaranteed to propagate to its three siblings.

**F5 — [P3, amended from P2] [verifier: CONFIRMED code / AMENDED severity] — `packages/agent-app/src/app.ts:1255,1307`** (raw audit cited 1158-1178)
`rituals.stop()` and `scheduler.stop()` run synchronously with no try/catch in `stop()`, unlike every other teardown step in the same method, which is individually `.catch()`-guarded. If either throws, `resetSharedMemory()` (closes the memory DB handle) and `stopTraceSource("stop")` (marks the trace-source manifest stopped) never run. The verifier downgraded this from P2 to P3: the auditor's own note already concedes these calls are "almost certainly `clearTimeout`-shaped," so realistic throw probability is ≈0 — this is internal defensive-consistency polish, not a premise clause violation.
```
this.stopMemoryRituals();
this.stopArtifactRetentionScheduler();
await this.resetSharedMemory();
await this.stopTraceSource("stop");
```

**F6 — [P3] [verifier: CONFIRMED, dead code proven] — `packages/agent-app/src/background.ts:994-996`**
`findInstance` (singular) is not exported and has no caller anywhere in the package; only the plural `findInstances` is used. Verifier re-ran `grep -n "findInstance(" background.ts` and confirmed exactly one hit — the definition itself.
```
async function findInstance(target: InstanceTarget, deps: BackgroundDeps): Promise<TraceSourceListItem | undefined> {
  return (await findInstances(target, deps))[0];
}
```

**F7 — [P3] [verifier: CONFIRMED] — `packages/agent-app/src/app.ts:1937-1941`**
When a config reload leaves zero channels running/degraded/`waiting_for_config` (every configured channel intentionally `disabled`), this branch fires with `transports = []`, producing `"Saved config and reloaded ."` — a truncated, confusing status line on every `mono-agent config apply`-style flow that ends with a fully-disabled channel set. Cosmetic but user-facing.
```
return {
  kind: "applied",
  message: `Saved config and reloaded ${transports.join(", ")}.`,
  transports,
};
```

## Dead code & deprecation

**Proven dead:**

| Path | Why dead | Proof |
| --- | --- | --- |
| `background.ts:994-996` `findInstance` (singular) | Unused private helper; superseded everywhere by `findInstances` | `grep -n "findInstance(" packages/agent-app/src/background.ts` → 1 hit (the definition only) |

**Refuted — do NOT delete:**

- `background-runtime.ts:418-510` `attestManagedBackgroundRuntime` (+ its supporting types) was flagged by the raw audit as fully-implemented-and-tested but unreachable dead code (F2). **The verifier refuted this.** `scripts/managed-runtime-attestation-probe.mjs:71` imports and calls it; `scripts/fleet-green-check.mjs:1852-1861` spawns that probe via `runManagedRuntimeAttestation` for every managed-runtime instance, as part of the documented `observability.fleet-loaded-code` attestation (`feature-registry.md:156`) and the `fleet-deploy` skill's daily 7-day tracker. The raw audit's proof-grep was scoped only to `packages/agent-app/src` and missed this cross-package consumer in `scripts/`. Not being exported from `index.ts` is true but irrelevant — the probe imports the built `dist` module directly. **Anyone touching this function must know it is live production code, not cleanup fodder.**

**Deprecation (all load-bearing / transitional, no action required for freeze):**

| Item | Location | Classification |
| --- | --- | --- |
| `config.runtime.fallbackModels` (vs canonical `fallbacks`) | `runtime-routes.ts:6-13`, `configured-agent.ts:318-351,546-549`, `app.ts:1636-1639` | Load-bearing back-compat; verifier confirmed read at `runtime-routes.ts:8,12` |
| SRT install-lock schema v1 (`LegacyInstallLockRecord`, legacy lock kinds) | `sandbox-manager.ts:116,159-208,1283-1332` | Transitional/load-bearing; new writes are always schema v2 |
| `isProcessAlive` legacy fallback (pre-incarnation owner records) | `background.ts:1359-1364,1459-1470` | Low-risk legacy; open-ended, no sunset gate (see A3-8) |

## Actionable steps

| ID | What | Why | How | Effort | Acceptance check | Freeze-blocking |
| --- | --- | --- | --- | --- | --- | --- |
| A3-1 | Add direct unit tests for `composeRuntimeOptionExtensions`'s `preserveMcpServersUnderOverride` path (positive: preserved server survives an authoritative override; negative: an extension outside the preserve set does not) | F1 — closes zero-coverage on a documented security boundary; verifier confirmed the gap is real but the code path is currently correct | New `describe` block in a `runtime-option-extensions.test.ts` (currently absent), independent of `request-model-override.test.ts`'s incidental non-coverage | S | New test fails on a naive revert of the `preservedExtensions` `Set` identity check; passes on current code | n |
| A3-2 | ~~Wire `attestManagedBackgroundRuntime` into a real consumer, or delete it~~ — **DROP, moot.** Verifier confirmed it is already wired into `scripts/managed-runtime-attestation-probe.mjs` / `fleet-green-check.mjs`. If anything, add a `doctor` visibility line surfacing the attestation result, do not delete. | F2 refuted | n/a | — | — | n |
| A3-3 | Delete unused `findInstance` (singular) in `background.ts` | F6 — trivial proven dead code | Remove the function | S | `grep -n "findInstance("` shows only `findInstances` | n |
| A3-4 | Extract one shared "owner-private directory lock with incarnation staleness + quarantine" helper and rebuild the four call sites on top of it | F4 — quadruplicated correctness-critical logic; a fix to one copy does not propagate to its siblings | New module (e.g. `owner-private-lock.ts`) parameterized by path/grace-ms/schema-tag; each of the four sites becomes a thin wrapper | L | All four existing lock test suites pass unmodified (behavior-preserving refactor); combined line count drops materially | n |
| A3-5 | Wrap `rituals.stop()` and `scheduler.stop()` in the same `.catch()` discipline used by every other teardown step in `stop()`/`applyConfigChange()` | F5 — a throwing scheduler stop would skip memory-store close + trace-source stop-update, leaving stale "running" state after shutdown; verifier confirms low probability, still cheap hardening | Add try/catch (or `.catch(() => undefined)`) around both calls | S | Unit test: make a fake ritual/scheduler `.stop()` throw; assert `resetSharedMemory`/`stopTraceSource` still run | n |
| A3-6 | Fix the empty-transports wording in `applyResult()`'s final branch | F7 — confusing "Saved config and reloaded ." message when every channel is disabled | Detect `transports.length === 0` and emit an explicit "no active channel" message, mirroring the `waiting_for_config` branch's wording | S | Reload a config with every channel `enabled: false`; message reads accurately | n |
| A3-7 | Decompose `MonoAgentAppController` into cohesion-scoped collaborators (e.g. `TraceabilityPublisher`, `MemoryHealthMonitor`, `ChannelLifecycleManager`) composed by a thin top-level controller | F3 — god-object; directly opposes the "lean, understandable core" v1 premise | Incremental extraction behind the existing public `MonoAgentApp` interface; no behavior change per step | L | `app.ts` controller class line count drops below ~500; existing `app.test.ts` suite passes unmodified at each step | n |
| A3-8 | Add a schema-version gate (or a documented removal date) to the SRT v1 legacy lock-compat code and the `isProcessAlive`-only lifecycle-lock fallback | Deprecation table — both are open-ended "legacy forever" branches with no sunset trigger | Record the mono-agent version that introduced v2/incarnation locks; add a doctor/telemetry check or a dated code comment | S | A dated comment or tracked issue exists; no functional change required now | n |

No item in this territory is freeze-blocking: the verifier applied the two-key rule and rejected all three proposed blockers cluster-wide, including A3-1 (real security-boundary test gap, but the guarded code is correct and in production — a regression risk, not a live hole).

## Quarantine (refuted/unproven)

- **F2 — `attestManagedBackgroundRuntime` "dead code" — REFUTED.** The raw audit's proof-grep (`grep -rn attestManagedBackgroundRuntime packages/agent-app/src`) was scoped only to the `agent-app` package source and missed the real caller: `scripts/managed-runtime-attestation-probe.mjs:71` imports and invokes it, and `scripts/fleet-green-check.mjs:1852-1861` spawns that probe for every managed-runtime instance as part of the documented `observability.fleet-loaded-code` attestation and the `fleet-deploy` skill's daily tracker. Action A3-2 ("wire up or delete") is moot for the same reason. Kept here so nobody re-proposes deleting it from a repeat of the same narrow grep.
