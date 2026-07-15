# A2-diagnostics-provider — agent-app diagnostics & provider setup

## 1 Verdict & maturity grade

**Grade: A-** (**Framework-fit: A-**, per the recon-hint live check below).

This is one of the most carefully engineered corners of the codebase. `provider-setup.ts` and `pi-auth-store-inspection.ts` implement genuinely rigorous TOCTOU-safe credential handling (O_NOFOLLOW opens, dev/ino/mtime/ctime snapshot comparisons, exclusive-link atomic promotion with backup preservation, stale-lock liveness proofs via `kill(pid, 0)`), and `doctor.ts`/`readiness-probe.ts` perform real, honest liveness probes (a live OTLP POST to Phoenix, a real one-turn no-tool provider call in an isolated worker thread, a real SQLite open+`indexMetadata()` smoke test) rather than papering over gaps with structural checks alone. Test coverage is exceptionally deep for `doctor.ts` (4654 test lines), `provider-setup.ts` (1496 test lines covering dozens of adversarial TOCTOU/interruption/cleanup scenarios) and `readiness-probe.ts` (631 test lines). Two concrete cracks in the "honest ops" premise remain: the Supermemory backend gets zero liveness verification (silent `ok` even when totally unreachable), and the readiness worker's own code (`readiness-probe-worker.ts`) is never actually executed under test — every test substitutes a synthetic stand-in script. Neither is a security hole or a fabricated success in the sense of lying about a check that ran; both are check-never-ran gaps that the report presents as clean anyway.

I also verified the recon hint about managed-runtime-snapshot vs. dev-dist ambiguity against the live `personal-agent` instance (read-only: launchd plist, `~/.mono-agent/runtimes/...` snapshot directory, source maps). The mechanism itself resolves soundly — the plist pins an exact content-addressed closure directory, which is a real independent file copy (not a symlink into the repo), and its source maps/`src/` folder are self-contained inside that same closure. The "ambiguity" is real but narrower than the hint suggested: it is that **`doctor`/`validate` never tells an operator which install root or closure is running**, not that the mechanism itself is broken.

## 2 Findings

**F1 [P1] — Supermemory memory backend gets no liveness check anywhere in `doctor`, unlike every other network resource it validates.**
`packages/agent-app/src/doctor.ts:1375-1426`
```ts
// External backend (e.g. supermemory): mode/embeddings/llm are bujo-only and ignored, so report the
// backend's own shape. We do not ping the instance here (config-shape check); the playbook covers
// starting the server.
```
The function returns `status: "ok"` unconditionally (after a pure config-shape check) regardless of the `liveness` flag. Contrast with the very next code paths in the same file: Ollama (`fetchOllamaModels`, `localEmbeddingLivenessWarnings`) and Phoenix (`probeExporterEndpoint`, a real POST of a valid empty OTLP payload) both get bounded real reachability probes and downgrade to `waiting` on failure. `mono-agent validate`/`doctor` on an agent configured for Supermemory will report "Memory: ok" even when the configured Supermemory server (`sm.baseUrl`) is completely down — directly contradicting the "honest ops" premise clause for a shipped, documented backend (external-memory-backends, PR #52). Verified via full grep that no readiness/first-run file touches Supermemory reachability either (`grep -rn "supermemory" readiness-probe.ts first-run-readiness.ts provider-setup.ts` → no hits).

**F2 [P1] — `readiness-probe-worker.ts`'s actual code has zero test coverage; every test substitutes a synthetic replacement.**
`packages/agent-app/src/readiness-probe-worker.ts` (whole file) vs. `packages/agent-app/src/__tests__/readiness-probe.test.ts:16-49`
```ts
async function syntheticReadinessWorker(): Promise<{ readonly url: URL; readonly cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-readiness-worker-test-"));
  const path = join(dir, "worker.mjs");
  await writeFile(path, `...synthetic postMessage logic, not the real worker...`
```
Every test that exercises the `startReadinessWorker`/real-`Worker` transport in `readiness-probe.ts` passes `workerUrl: synthetic.url` (a hand-written fixture script), never the compiled `readiness-probe-worker.js`. `trackPiCredentialResolverSecrets` is the only export from the worker file that is unit-tested directly; the file's private logic — `readWorkerData` validation, `toolActionInEvent`/`normalizedEventType` tool-detection, the `run()` abort/dispose orchestration, and critically `safeWorkerMessage`'s credential redaction — is never executed by the test suite at all (confirmed: `grep -rln "readiness-probe-worker" src/__tests__` matches only the transport test, which never loads the real file as a worker). This is the ONLY code path that performs the "exact live route proof" that first-run readiness's whole honesty claim rests on (per `first-run-readiness.ts`'s own `evaluateFirstRunReadiness` doc comment: "not verified until a live model turn succeeds"). A regression in this file's own logic would not be caught by any automated test.

**F3 [P2] — Two independently-drifted secret-redaction implementations straddle the worker trust boundary.**
`packages/agent-app/src/readiness-probe.ts:153-197` (`safeMessage`/`redactionValues`) vs. `packages/agent-app/src/readiness-probe-worker.ts:135-177` (`safeWorkerMessage`)
```ts
// worker-side only:
.replace(/\b[A-Za-z0-9_+/=-]{24,}\b/gu, "[REDACTED]")
```
The worker's redaction additionally does a blanket env-value scan (any env value ≥4 chars or credential-named) and a generic 24+-char token catch-all; the parent's `safeMessage`/`redactionValues` only redacts the wizard's own `secretValues` plus sensitively-*named* host env vars and `Bearer`/`api-key=`-labeled patterns — no length-based or generic-token catch-all. In production, real provider errors always cross the worker boundary first (already redacted by the stronger implementation) before the parent's weaker pass runs on top, so the two layers are not actually redundant despite doing the "same" job — a gap in the worker's redaction has no independent second line of defense at the parent, and any future edit to one implementation will not propagate to the other.

**F4 [P2] — No runtime-provenance / install-root visibility anywhere in `doctor.ts`'s report.**
`packages/agent-app/src/doctor.ts` (whole file — confirmed via `grep -n "installRoot\|closureId\|snapshot\|managedRuntime"` → no hits) and `packages/agent-app/src/managed-runtime-packages.ts:35-46`
```ts
const appBase = import.meta.url;
const cwdBase = pathToFileURL(join(cwd, "package.json")).href;
```
`resolveConfiguredManagedRuntimePackages` resolves plugin packages relative to wherever the currently-executing `managed-runtime-packages.js` happens to live — correct in design (it reflects the actual running file), but `doctor`'s validation report never surfaces which physical install root, content-addressed closure id, or dev-vs-managed provenance is in play. Verified live (read-only) against the `personal-agent` launchd instance: its plist points at `~/.mono-agent/runtimes/agent-app/0.11.2/darwin-arm64-abi-137/<64-char-hash>-<64-char-hash>/node_modules/@mono-agent/agent-app/dist/cli.js` — a real, distinct file copy (not a symlink to the repo), byte-identical to the repo's current dist at the time of inspection, with its own bundled `src/` and non-absolute source maps. The mechanism itself is sound, but nothing in `doctor`/`validate` output would tell an operator (a) which closure is currently running, (b) whether it matches the nominal "0.11.2" version folder it lives under (the folder groups multiple content-hash closures, so a WIP/dev build and the officially published npm 0.11.2 could coexist under the same version-labeled directory, disambiguated only by the closure hash), or (c) that a stale/mismatched closure is in play after a rebuild.

**F5 [P3] — Validated manifest fields are silently dropped from the doctor report, and the type predicate misstates what it actually requires.**
`packages/agent-app/src/doctor.ts:2446-2487` (type return omits fields it requires) and `:2163-2169`/`:2219-2225` (details never mention them)
```ts
): value is {
  readonly stats: {
    readonly records: number; readonly active: number; /* …no `compacted` … */
    readonly limits: { readonly terminalMaxRecords: number; readonly capturedTextMaxRecords: number; /* …no MaxAgeMs… */ };
  };
} {
  ...
  return [
    value.stats.records, /* … */ value.stats.compacted, /* … */
    value.stats.limits.terminalMaxAgeMs, /* … */ value.stats.limits.capturedTextMaxAgeMs,
  ].every((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0);
```
`isContinuationStoreManifest` actually *requires* `stats.compacted`, `stats.limits.terminalMaxAgeMs`, and `stats.limits.capturedTextMaxAgeMs` to be present safe non-negative integers (confirmed real manifests do carry them, via `doctor.test.ts:230-237` fixtures) — a manifest lacking any of the three would be rejected as malformed. Yet the TypeScript `value is {...}` predicate doesn't declare them, so downstream code cannot type-safely reference them, and in practice none of the three is ever shown in the `mono-agent doctor` output (only count-based `terminalMaxRecords`/`capturedTextMaxRecords` retention limits are printed; the time-based `MaxAgeMs` limits and the `compacted` count are validated then discarded). An operator asking "how many stale continuations were garbage-collected" or "how long are records retained by age" gets no answer despite the data being on hand and already checked.

**F6 [P3] — `piLoginCommandLine` (provider-setup.ts) is dead: zero callers anywhere in the repository.**
`packages/agent-app/src/provider-setup.ts:251-253`
```ts
export function piLoginCommandLine(provider: string): string {
  return piAuthRecoveryCommand(provider);
}
```
Full-repo grep (`grep -rn "\bpiLoginCommandLine\b"`) finds only its own declaration and the generated `.d.ts`. It is a near-duplicate of `piAuthRecoveryCommand(provider)` (same function, minus the optional `piAuthPath` argument).

**F7 [P3] — `runReadinessProbe`'s public single-route API has no production callers.**
`packages/agent-app/src/readiness-probe.ts:563-569`
`cli.ts` exclusively drives readiness through its own `runReadinessProbeWithSpinner` wrapper, which calls the ledger-returning `runAllRouteReadinessProbe`, never the exported `runReadinessProbe`. The latter's own doc comment says "legacy callers may keep using `runReadinessProbe`'s compact result," but no such caller exists anywhere in this repository — only its own test file (`readiness-probe.test.ts`) exercises it.

**F8 [P3] — `pi-oauth-login.ts`'s credential write has no symlink defense, inconsistent with every other `auth.json` touchpoint in this same area.**
`packages/agent-app/src/pi-oauth-login.ts:75-81`
```ts
const authPath = options.authPath ?? "auth.json";
const auth = await readAuth(authPath);
await writeFile(authPath, `${JSON.stringify({ ...auth, [providerId]: { type: "oauth", ...credentials } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
await chmod(authPath, 0o600);
```
No `O_NOFOLLOW`/`lstat` pre-check before this write, unlike `pi-auth-store-inspection.ts` (read side) and the extremely paranoid promotion machinery in `provider-setup.ts` (write side) that governs the exact same file in production. In practice this is low-risk today: `provider-setup.ts`'s `runPiLoginAction` always invokes this code with `cwd` set to a private `mkdtemp` staging directory it fully controls before atomically promoting the result. But `pi-oauth-login-main.ts` is also a documented, directly-invokable public CLI entry point (`mono-agent-pi-oauth-login-main.js <provider>`) with no such protection if ever run directly against a directory the user does not fully control.

**F9 [P3] — Guided Pi API-key setup recognizes only one provider by name, narrowing "bring any model" for automatic setup.**
`packages/agent-app/src/provider-setup.ts:187-189`, `:661-666`
```ts
const PI_API_KEY_PROVIDERS: Readonly<Record<string, string>> = {
  "opencode-go": "OPENCODE_API_KEY",
};
...
const envVar = PI_API_KEY_PROVIDERS[ref.provider];
if (envVar === undefined) continue;
```
Any Pi built-in provider that supports API-key login but isn't `opencode-go` is silently skipped by `planProviderSetup` — no setup action is offered, with only the comment "Never invent an environment name... their normal provider environment remains available as the explicit manual path" explaining why. This is a deliberate, documented scope limit (not a bug), but it means the *automatic* setup UX only really covers one non-OAuth Pi provider, while "bring any model" is a stated premise clause.

## 3 Dead code

| Path | Why dead | Proposed disposition | Proof hint |
|---|---|---|---|
| `provider-setup.ts:251` `piLoginCommandLine` | Zero callers repo-wide (only its own declaration/`.d.ts`); a near-duplicate of `piAuthRecoveryCommand(provider)` | Remove, or inline at any future call site | `grep -rn "\bpiLoginCommandLine\b" packages/` → only the definition |
| `readiness-probe.ts:563` `runReadinessProbe` (public single-route API) | No production callers; `cli.ts` uses `runAllRouteReadinessProbe` exclusively via a local wrapper | Either fold its test coverage onto `runAllRouteReadinessProbe` and remove the public export, or keep but mark clearly as an external-consumer convenience (this package is published to npm) | `grep -rln "runReadinessProbe" packages/ demos/` → only `readiness-probe.ts` (definition), `cli.ts` (unrelated local `runReadinessProbeWithSpinner`), and its own test file |

## 4 Deprecation & legacy

- **Continuation store v1 → v2 → v3 migration code** (`doctor.ts`: `isContinuationLedger`, `continuation-store-v2.json`/`-v3.json` handling, `CONTINUATION_V2_ROLLBACK_GUARD`) — **load-bearing**. Actively supports validating/migrating live state from older mono-agent versions; not removable while any deployed instance could still be on v1/v2 state. No in-code sunset marker exists; recommend documenting an explicit removal version once fleet telemetry confirms no v1/v2 stores remain.
- **`runtime.fallbackModels`** (legacy field, still read throughout `doctor.ts`/`readiness-probe.ts` alongside the newer `runtime.fallbacks`) — **load-bearing**. Per repo history (`per-trigger-model-effort` memory), this is an intentionally-retained back-compat field with different inheritance semantics from `fallbacks`; removing it is a breaking config change, not a cleanup.
- **`memory_recall` legacy tool-name alias** (`doctor.ts:1854`, `canonicalToolName(name) === "MemoryRecall"`) — **load-bearing**. Back-compat alias for the PascalCase tool rename (`init-wizard-capability-modules` memory); needed for existing configs' `allowedTools` entries.
- No `@deprecated` JSDoc tags exist anywhere in this scope.

## 5 Actionable steps

| ID | What | Why (premise/DoD link) | How | Effort | Acceptance-check | Freeze-blocking |
|---|---|---|---|---|---|---|
| A2-1 | Add a real, bounded liveness probe for the Supermemory backend in `memorySection` | "Honest ops" — doctor currently always reports `ok` regardless of whether the configured server is reachable (F1) | Mirror the Ollama/Phoenix pattern: bounded `fetch` (HEAD/GET or a documented health endpoint) against `sm.baseUrl` when `liveness=true`; downgrade to `waiting` (never `error`, consistent with other network probes) on failure | S | `mono-agent validate` against a config pointing at a closed port reports `waiting` with an actionable message, not `ok` | y |
| A2-2 | Add real test coverage for `readiness-probe-worker.ts`'s own logic | The worker is the sole code path proving live credential readiness; it currently has zero test coverage of its own code (F2) | Export the currently-private pure functions (`readWorkerData`, `toolActionInEvent`, `safeWorkerMessage`) for direct unit testing, and/or add one test that spins up the real compiled worker via `new Worker(new URL("../readiness-probe-worker.js", ...))` against an injectable fake `createMonoRuntime` | M | A deliberate regression in `readiness-probe-worker.ts` (e.g. break `readWorkerData`'s validation) fails a test | y |
| A2-3 | Consolidate `safeMessage`/`redactionValues` (parent) and `safeWorkerMessage` (worker) into one shared, tested redaction utility | Two independently-drifted secret-redaction implementations straddling a trust boundary is a defense-in-depth gap (F3) | Extract a shared `redactSecrets(message, {secretValues, env})` used by both `readiness-probe.ts` and `readiness-probe-worker.ts` (worker still applies it first, parent as best-effort second pass with the SAME rules) | S | One test suite proves both call sites redact identically for the same fixture input | n |
| A2-4 | Surface managed-runtime provenance (install root / closure id / dev-vs-managed) in `doctor`'s report | "Honest ops" — an operator has no way today to see which physical code is/will run (F4) | Add a small `runtime provenance` detail (or extend the existing `runtime` section) reading the `.mono-agent-runtime.json` marker (or equivalent) when running under a managed snapshot, falling back to "dev/unmanaged" otherwise | S | `mono-agent doctor` output includes a line naming the closure id or "dev (unmanaged)" | n |
| A2-5 | Fix `isContinuationStoreManifest`'s type predicate and surface `compacted`/age-based retention limits in doctor output | Legibility — validated data is silently dropped; type signature misstates its own contract (F5) | Add the 3 missing fields to the `value is {...}` predicate; add them to both the v3 and legacy-v2 detail-line builders | S | `doctor` output for an agent with continuations enabled shows a compacted count and both age-based limits | n |
| A2-6 | Remove `piLoginCommandLine`; decide the fate of the public `runReadinessProbe` export | Dead code / lean-core premise (F6, F7) | Delete `piLoginCommandLine`; either document `runReadinessProbe` as an intentional external-consumer API or fold it away | S | `grep` confirms no remaining references; build green | n |
| A2-7 | Add an O_NOFOLLOW/lstat symlink guard to `pi-oauth-login.ts`'s `auth.json` write | Defense-in-depth consistency with the rest of this credential-handling area (F8) | Reuse the same `open(path, O_WRONLY\|O_NOFOLLOW\|O_CREAT, 0o600)` pattern already used in `provider-setup.ts` | S | A symlinked `auth.json` in the CLI's cwd causes `runPiOAuthLogin` to refuse rather than follow it | n |

## 6 Skill-worthy flags

- **Redaction-logic drift (F3)**: whenever a new place surfaces raw provider/subprocess error text in a user-facing report, it should reuse ONE shared secret-redaction utility rather than hand-roll a new regex set. This repo already has two independently-drifted implementations of "redact secrets from an error string" on either side of a single worker boundary. Worth a small amendment to `verify-green` or `pi-upstream-recon`: *"grep for an existing redaction helper (`safeMessage`/`safeWorkerMessage`/`redactionValues`) before writing a new one; if you must add a second, add a test proving both are equivalent for the same fixture."*
- **New dynamically-resolved runtime surface ⇒ new doctor visibility line**: `managed-runtime-packages.ts`'s app-vs-cwd resolution pattern (and any future one like it) should always come with a corresponding `doctor`/`validate` detail line naming what was actually resolved and from where (F4). Worth a checklist item in `new-package` or `pi-upstream-recon`: *"if you add a new place mono-agent decides 'which physical package/closure is this' at runtime, add a doctor line that names it."*
- **`live-smoke` gap**: the skill's live-smoke scenarios should include at least one pass where `readiness-probe-worker.js` is actually spawned as a real `worker_threads.Worker` (not a synthetic replacement) against a local fake HTTP provider, since the unit-test suite structurally cannot exercise this file today (F2).

## 7 Coverage note

Read in full (every line):
- `packages/agent-app/src/doctor.ts` (2939 lines)
- `packages/agent-app/src/readiness-probe.ts` (992 lines)
- `packages/agent-app/src/readiness-probe-worker.ts` (340 lines)
- `packages/agent-app/src/first-run-readiness.ts` (923 lines)
- `packages/agent-app/src/provider-setup.ts` (2180 lines)
- `packages/agent-app/src/pi-oauth-login.ts` (102 lines)
- `packages/agent-app/src/pi-oauth-login-main.ts` (13 lines)
- `packages/agent-app/src/pi-auth-store-inspection.ts` (132 lines)
- `packages/agent-app/src/managed-runtime-packages.ts` (75 lines)

All 9 named files in scope exist; none were missing.

Skimmed for coverage adequacy only (not line-by-line audited), per method:
- `packages/agent-app/src/__tests__/doctor.test.ts` (4654 lines — describe-block structure + targeted greps for `piAuthPath`/`compacted`/manifest fixtures)
- `packages/agent-app/src/__tests__/first-run-readiness.test.ts` (1143 lines)
- `packages/agent-app/src/__tests__/managed-runtime-packages.test.ts` (84 lines, read in full)
- `packages/agent-app/src/__tests__/pi-oauth-login.test.ts` (75 lines)
- `packages/agent-app/src/__tests__/provider-setup.test.ts` (1496 lines — describe/it titles + targeted reads)
- `packages/agent-app/src/__tests__/readiness-probe.test.ts` (631 lines — read the synthetic-worker fixture and describe/it titles in full)

Read out-of-scope for context only (grep/targeted reads, not full audits, to verify the recon hint and cross-file wiring — not claimed as covered under this part's scope):
- `packages/agent-app/src/background-runtime.ts` (grep + targeted reads: managed-runtime install-root layout, closure staging)
- `packages/agent-app/src/background.ts` (grep: `resolveConfiguredManagedRuntimePackages` call site)
- `packages/agent-app/src/app.ts`, `packages/agent-app/src/cli.ts`, `packages/agent-app/src/configured-agent.ts`, `packages/agent-app/src/supermemory-plugin.ts` (grep: `preferAppPluginInstall` wiring, `runReadinessProbe`/`runAllRouteReadinessProbe`/`withExactProcessEnvironment` call sites)

Live evidence consulted (read-only, no mutation):
- `~/Library/LaunchAgents/com.mono-agent.personal-agent-059657c8.plist` and `~/Library/LaunchAgents/ai.mono-agent.final-demo-gemma4.plist`
- `~/.mono-agent/runtimes/agent-app/0.11.2/darwin-arm64-abi-137/<closure>/` directory contents, `cli.js`/`cli.js.map`/`doctor.js.map` (source-map `sources`/`sourcesContent` inspection), diff against the repo's current `packages/agent-app/dist/cli.js`
