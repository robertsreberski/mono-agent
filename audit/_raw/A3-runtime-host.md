# A3-runtime-host — agent-app runtime host lifecycle

## 1 Verdict & maturity grade

**Grade: B+**

This territory (host startup/shutdown, launchd install/manage, managed-runtime and sandbox-runtime materialization, the config-approval transaction machinery, and process-incarnation-based locking) is the most defensively engineered code in the package: every file that touches a shared filesystem location performs stat-before/after TOCTOU checks, verifies ownership/mode, and fails closed on any ambiguity. Docs (`docs/tools/sandbox.md`) were spot-checked against `sandbox-manager.ts` and matched precisely — no dishonest claims found. No secrets, fake-success paths, or "claims applied but wasn't" patterns were found anywhere in scope.

The grade is not higher because this territory strains the "lean, understandable core" premise: `app.ts`'s `MonoAgentAppController` is a ~1900-line god-object spanning ten-plus concerns, the same "owner-private directory lock with incarnation-based staleness" primitive is hand-rolled four separate times across four files, there is a fully-implemented-and-tested but completely unreferenced 150-line function (`attestManagedBackgroundRuntime`), and one genuinely security-relevant composition path (`preserveMcpServersUnderOverride` in `runtime-option-extensions.ts`) has zero test coverage despite guarding the exact boundary that keeps a trusted MCP server alive under a hostile/restrictive tool-policy override.

This is a static-code review; no live launchd instance or on-disk lock/lease state was inspected, so no separate Framework-fit grade applies.

## 2 Findings

**F1 — P1 — `packages/agent-app/src/runtime-option-extensions.ts:49-67`** (also exercised from `configured-agent.ts:399-407` and `app.ts:1567-1575`)
```
if (toolPolicyOverride !== undefined) {
  const preservedServers: Record<string, unknown> = {};
  const preservedExtensions = new Set(options.preserveMcpServersUnderOverride ?? []);
```
`preserveMcpServersUnderOverride` is the mechanism that keeps the app-owned, read-only `MemoryRecall` MCP server registered even when a later, authoritative extension (e.g. the `/configure` conversational-mode extension in `local-configuration.ts`) clamps `toolPolicyOverride` down to a tiny allowlist. The doc comment on the option is explicit that this is a security boundary ("an arbitrary caller cannot preserve a server by merely reusing a trusted server name"). Searching the entire `__tests__` directory found not one reference to `preserveMcpServersUnderOverride`; `request-model-override.test.ts` exercises `composeRuntimeOptionExtensions` only for the no-override sibling-merge case. A regression here (e.g. someone "simplifying" the identity-based `Set` to a name-based check while refactoring) would silently either strip MemoryRecall availability during `/configure`, or — worse — let a spoofed extension keep an arbitrary server alive under an authoritative override, and no test would catch it either way.

**F2 — P2 — `packages/agent-app/src/background-runtime.ts:418-510`**
```
export async function attestManagedBackgroundRuntime(
  input: ManagedBackgroundRuntimeAttestationInput,
```
`attestManagedBackgroundRuntime` (plus its ~40 lines of supporting interfaces) implements a read-only fleet-attestation proof of an already-materialized managed runtime. It is unit-tested in `background-runtime.test.ts`, but it is not exported from `index.ts` (whose "." export is the package's only public surface), not called from `cli.ts`, `doctor.ts`, `managed-runtime-packages.ts`, or any fleet script in the repo. It is dead product code — fully built, fully tested, unreachable.

**F3 — P2 — `packages/agent-app/src/app.ts:284-2090`**
`MonoAgentAppController` is one class spanning nearly the entire 2320-line file and owning: channel lifecycle, traceability registration + global-registry mirroring + periodic refresh, sandbox status, a 30-second memory-health poll loop with its own generation/single-flight bookkeeping, the interaction bridge, the continuation service, the shared memory store, the artifact-retention scheduler, session-event tracking, and the entire per-channel `AgentResponder` composition (memory recall, adapter-send tools, request-model override, run-history, local-configuration extensions). This is squarely a "god object" against the "lean, understandable core" premise: a change to any one concern (e.g. continuation wiring) has to be reasoned about against the state of nine other concerns living in the same instance.

**F4 — P2 — duplicated lock primitive across four files**
- `background-worker-lease.ts:91-192` (`acquireBackgroundWorkerLease`)
- `background.ts:1369-1496` (`acquireFilesystemLifecycleLock`)
- `background-runtime.ts:1318-1382` (`acquireRuntimeLock`)
- `sandbox-manager.ts:1043-1170` (`acquireInstallLock`, plus a second, separate `acquireInstallGuard` OS-flock mechanism in the same file)

All four independently re-implement the same shape: `mkdir` an owner-private directory, write an `owner.json` carrying PID + process-incarnation, detect staleness via `isSameProcessIncarnation`, and `rename` the stale directory to a quarantine path before retrying. Each has its own constants for grace period/poll interval/attempt count and its own copy of the identity-comparison helpers. A correctness fix discovered in one (e.g. a TOCTOU gap in the stale-rename race) is not guaranteed to be applied to its three siblings — this is exactly the kind of duplication the "lean, understandable core" premise warns against, and it roughly quadruples the reviewable surface for what is conceptually one primitive.

**F5 — P2 — `packages/agent-app/src/app.ts:1158-1178`**
```
this.stopMemoryRituals();
this.stopArtifactRetentionScheduler();
await this.resetSharedMemory();
await this.stopTraceSource("stop");
```
Every other step in `stop()` (and in `applyConfigChange()`'s teardown block) is individually `.catch()`-guarded — channel `stop()`/`dispose()`, `stopContinuationService()`, `stopInteractionBridge()` all swallow their own errors. `stopMemoryRituals()` and `stopArtifactRetentionScheduler()` call `rituals.stop()` / `scheduler.stop()` synchronously with no try/catch. If either throws, `resetSharedMemory()` (which closes the memory DB handle) and `stopTraceSource()` (which marks the trace-source manifest as stopped) never run — leaving an open DB handle and a trace-source registry entry that keeps reporting `"running"` after the process believes it has shut down. Low probability (the underlying `.stop()` calls are almost certainly `clearTimeout`-shaped) but inconsistent with the file's otherwise uniform defensive style.

**F6 — P3 — `packages/agent-app/src/background.ts:994-996`**
```
async function findInstance(target: InstanceTarget, deps: BackgroundDeps): Promise<TraceSourceListItem | undefined> {
  return (await findInstances(target, deps))[0];
}
```
Dead code: not exported, and grep across the whole package (including `dist/`) shows no caller. Only the plural `findInstances` is used throughout the file.

**F7 — P3 — `packages/agent-app/src/app.ts:1937-1941`**
```
return {
  kind: "applied",
  message: `Saved config and reloaded ${transports.join(", ")}.`,
  transports,
};
```
When a config reload leaves zero channels running/degraded and none in `waiting_for_config` (e.g. every configured channel is intentionally `disabled`), this branch is reached with `transports = []`, producing the message `"Saved config and reloaded ."` — a truncated, confusing status line rather than an accurate "nothing is running" statement. Cosmetic, but user-facing on every `mono-agent config apply`-style flow that ends with a fully-disabled channel set.

## 3 Dead code

| Path | Why dead | Proposed disposition | Proof hints |
| --- | --- | --- | --- |
| `background-runtime.ts:418-510` `attestManagedBackgroundRuntime` (+ `ManagedBackgroundRuntimeAttestationInput`/`ManagedBackgroundRuntimeAttestation`/`ManagedBackgroundRuntimeAttestationDeps` types) | Fully implemented, fully tested, never called by any product code path; not exported from `index.ts`. | Either wire it into a real consumer (e.g. a `mono-agent fleet attest` command or the `fleet-deploy` skill) or delete it and its test file together. | `grep -rn attestManagedBackgroundRuntime packages/agent-app/src` returns only the definition + its own test file. |
| `background.ts:994-996` `findInstance` (singular) | Unused private helper; superseded everywhere by `findInstances`. | Delete. | `grep -n "findInstance(" background.ts` — one hit, the definition itself. |

No other unreachable functions were found in scope; the rest of the code (including every lock/quarantine helper) is exercised from at least one real call site.

## 4 Deprecation & legacy

| Item | Location | Classification | Evidence |
| --- | --- | --- | --- |
| `config.runtime.fallbackModels` (vs canonical `config.runtime.fallbacks`) | `runtime-routes.ts:6-13`, `configured-agent.ts:318-351,546-549`, `app.ts:1636-1639` | **Load-bearing.** Actively read on every runtime/route construction so old configs keep working; not marked `@deprecated` in code but comments call it "legacy configs." | `configuredRuntimeFallbackModels` prefers `fallbacks` but falls back to `fallbackModels` whenever `fallbacks` is empty — a real compatibility branch, not vestigial. |
| SRT install-lock schema v1 (`LegacyInstallLockRecord`, `"legacy"`/`"legacy-publishing"` lock kinds, `readSecureLegacyInstallLock`) | `sandbox-manager.ts:116,159-208,1283-1332` | **Transitional/load-bearing for now.** Docs (`docs/tools/sandbox.md`, "Managed-SRT 0.9 lock migration") describe this as a one-time upgrade path from pre-0.9 installs. Every *newly written* lock is schema v2 (`writeInstallMarker`/`acquireInstallLock` always write `schemaVersion: 2`), so this branch only fires for an install that predates the current release. | Safe to remove once release notes/telemetry confirm no supported install base still holds a v1-schema lock; not urgent for the freeze itself. |
| "Legacy owner-record compatibility only" `isProcessAlive` fallback | `background.ts:1359-1364,1459-1470` | **Low-risk legacy.** `FilesystemLifecycleLockOptions.isProcessAlive` is consulted only when a persisted owner record lacks the newer `incarnation` field. Because these locks are short-lived (held only for the duration of one CLI lifecycle command) rather than durable state, the odds of an old-format record surviving into this release are minimal already. | Comment explicitly labels it legacy; no schema-version gate exists (unlike the SRT lock), so it is silently permanent unless someone removes it deliberately. |

No `@deprecated`-annotated APIs were found in scope.

## 5 Actionable steps

| ID | What | Why (premise/DoD link) | How | Effort | Acceptance-check | Freeze-blocking |
| --- | --- | --- | --- | --- | --- | --- |
| A3-1 | Add direct unit tests for `composeRuntimeOptionExtensions`'s `preserveMcpServersUnderOverride` path (both the "preserved server survives an authoritative override" case and the "an extension not in the preserve set cannot survive" negative case) | F1 — closes a zero-coverage gap on a documented security boundary ("missing test coverage of load-bearing behavior" hunt target) | New `describe` block in a `runtime-option-extensions.test.ts` (currently absent) exercising the option directly, independent of `request-model-override.test.ts`'s incidental coverage | S | New test fails on a naive revert of the `preservedExtensions`/`Set` identity check; passes on current code | y |
| A3-2 | Wire `attestManagedBackgroundRuntime` into a real consumer, or delete it + its dedicated tests | F2 — dead code contradicts "lean, understandable core"; a future maintainer will spend time understanding an API nothing calls | Decide: (a) surface as `mono-agent sandbox`/fleet attest command, or (b) `git rm` the function, its types, and the corresponding test file | S | `grep -rn attestManagedBackgroundRuntime packages/agent-app` returns either a real caller or nothing at all | n |
| A3-3 | Delete unused `findInstance` (singular) in `background.ts` | F6 — trivial dead code | Remove the function | S | `grep -n "findInstance("` shows only `findInstances` | n |
| A3-4 | Extract one shared "owner-private directory lock with incarnation staleness + quarantine" helper and rebuild the four call sites (`background-worker-lease.ts`, `background.ts`, `background-runtime.ts`, `sandbox-manager.ts`) on top of it | F4 — quadruplicated correctness-critical logic; a fix to one copy does not propagate | New module (e.g. `owner-private-lock.ts`) parameterized by path/grace-ms/schema-tag; each of the four call sites becomes a thin wrapper | L | All four existing lock test suites still pass unmodified (behavior-preserving refactor); line count of the four files drops materially | n |
| A3-5 | Wrap `rituals.stop()` and `scheduler.stop()` in the same `.catch()` discipline used by every other step of `MonoAgentAppController.stop()`/`applyConfigChange()` | F5 — one throwing scheduler stop would skip memory-store close + trace-source stop-update, leaving stale "running" state after shutdown | Add try/catch (or `.catch(() => undefined)` if made async) around both calls, matching the surrounding pattern | S | Unit test: make a fake ritual/scheduler `.stop()` throw; assert `resetSharedMemory`/`stopTraceSource` still run | n |
| A3-6 | Fix the empty-transports wording in `applyResult()`'s final branch | F7 — confusing "Saved config and reloaded ." message when every channel is disabled | Detect `transports.length === 0` and emit an explicit "no active channel" message, mirroring the `waiting_for_config` branch's wording | S | Reload a config with every channel `enabled: false`; message reads accurately | n |
| A3-7 | Decompose `MonoAgentAppController` into cohesion-scoped collaborators (e.g. a `TraceabilityPublisher`, `MemoryHealthMonitor`, `ChannelLifecycleManager`) composed by a thin top-level controller | F3 — god-object; directly opposes the "lean, understandable core" v1 premise | Incremental extraction behind the existing public `MonoAgentApp` interface; no behavior change per step | L | `app.ts` line count for the controller class drops below ~500; existing `app.test.ts` suite passes unmodified at each step | n |
| A3-8 | Add a schema-version gate (or a removal date) to the SRT v1 legacy lock-compat code and the `isProcessAlive`-only lifecycle-lock fallback | Deprecation §4 — both are open-ended "legacy forever" branches with no sunset trigger | Record the mono-agent version that introduced v2/incarnation locks; add a doctor/telemetry check (or just a code comment with a concrete removal-eligible version) so the branch has a defined lifetime | S | A dated comment or tracked issue exists; no functional change required now | n |

## 6 Skill-worthy flags

- **New "shared-lock-primitive" convention** (relates to `new-package` skill): every time this codebase needs "only one of me should touch this shared filesystem location," an engineer has hand-rolled the exact same mkdir/owner.json/incarnation/quarantine pattern from scratch (four times now: worker lease, CLI lifecycle lock, managed-runtime install lock, SRT install lock). The `new-package`/`worktree-feature` skills should flag "do you need a singleton lock?" and point at extracting/reusing a shared helper (see A3-4) instead of re-deriving the pattern. Concrete seed material: the four locations above, and the observation that all four already share `process-incarnation.ts` as their liveness primitive — only the directory/rename choreography around it is duplicated.
- **`verify-green`/`code-review` amendment**: when a PR adds a new composition option like `preserveMcpServersUnderOverride` whose doc comment states a security property ("an arbitrary caller cannot X"), require a co-located test asserting exactly that property before merge — this gap (F1) would have been caught by a lightweight review checklist item ("security-boundary comment ⇒ security-boundary test must exist in the same diff").

## 7 Coverage note

Source files read in full (every line):
- `packages/agent-app/src/app.ts` (2320 lines, read in six sequential chunks covering the entire file)
- `packages/agent-app/src/configured-agent.ts` (1041 lines)
- `packages/agent-app/src/app-config.ts` (562 lines)
- `packages/agent-app/src/local-configuration.ts` (1641 lines, read in two chunks covering the entire file)
- `packages/agent-app/src/background.ts` (1639 lines, read in two chunks covering the entire file)
- `packages/agent-app/src/background-runtime.ts` (1872 lines, read in two chunks covering the entire file)
- `packages/agent-app/src/background-worker-lease.ts` (457 lines)
- `packages/agent-app/src/background-snapshot.ts` (584 lines)
- `packages/agent-app/src/background-snapshot-key.ts` (257 lines)
- `packages/agent-app/src/background-environment.ts` (78 lines)
- `packages/agent-app/src/process-incarnation.ts` (232 lines)
- `packages/agent-app/src/sandbox-manager.ts` (1852 lines, read in two chunks covering the entire file)
- `packages/agent-app/src/launchd.ts` (269 lines)
- `packages/agent-app/src/runtime-option-extensions.ts` (118 lines)
- `packages/agent-app/src/runtime-routes.ts` (26 lines)
- `packages/agent-app/src/index.ts` (196 lines — catch-all: package barrel export, not claimed by any sibling scope)

All fifteen named files plus the catch-all (`index.ts`) exist and were read; no scoped file was missing.

Directory enumerated (`ls packages/agent-app/src/`) to confirm every top-level `*.ts` file was accounted for by either this scope or an explicitly named sibling scope (A1/A2/A4/A5/A6); no unclaimed top-level file was found besides `index.ts`.

Test files skimmed (not line-by-line audited) to judge coverage adequacy, via `wc -l` and targeted `grep`/partial reads:
- `__tests__/app.test.ts` (2390 lines), `__tests__/app-config.test.ts` (204), `__tests__/background.test.ts` (1382), `__tests__/background-runtime.test.ts` (896), `__tests__/background-snapshot.test.ts` (494), `__tests__/background-snapshot-key.test.ts` (127), `__tests__/background-worker-lease.test.ts` (254), `__tests__/process-incarnation.test.ts` (40), `__tests__/sandbox-manager.test.ts` (981), `__tests__/launchd.test.ts` (210), `__tests__/local-configuration.test.ts` (1447), `__tests__/runtime-routes.test.ts` (30)
- `__tests__/agent-host.test.ts` (opened partially — confirmed this file, not a dedicated `configured-agent.test.ts`, is what exercises `configured-agent.ts`'s exports)
- `__tests__/request-model-override.test.ts` (opened partially — confirmed the only, incidental, non-negative-case coverage of `composeRuntimeOptionExtensions`)

Cross-reference reads (out-of-scope files, consulted only to verify/refute a hypothesis about in-scope code, not audited as their own territory):
- `packages/agent-app/src/cli.ts` (lines ~4160–4260, to verify the environment passed into `captureBackgroundSnapshot` from the CLI background commands is pre-sanitized)
- `packages/agent-app/src/tui-command.ts` (lines ~200–260 and ~525–556, to verify the `/configure` remote-session environment is pre-sanitized via `loadDurableBackgroundEnvironment` before reaching `local-configuration.ts`'s `captureCommittedSnapshot`)
- `docs/tools/sandbox.md` (full file, to cross-check `sandbox-manager.ts`'s isolation/fallback claims against published documentation)

No repo source, config, or live instance was modified. No files outside `audit/_raw/A3-runtime-host.md` were written.
