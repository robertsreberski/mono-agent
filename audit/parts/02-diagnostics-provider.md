# 02 · Diagnostics & provider setup

**Scope:** `packages/agent-app/src` doctor/readiness-probe/first-run-readiness/provider-setup/pi-oauth-login/pi-auth-store-inspection/managed-runtime-packages. **Maturity grade:** A- (verifier-adjusted). This is one of the most carefully engineered corners of the codebase — TOCTOU-safe credential handling and real liveness probes (Phoenix OTLP POST, isolated-worker provider turn, SQLite open+`indexMetadata()`) with exceptionally deep test coverage — but the adversarial verifier confirmed two real cracks (Supermemory gets no liveness check; the readiness worker's own logic has zero test coverage) while rejecting both as v1 freeze-blockers: the Supermemory gap is an opt-in, non-default backend whose `ok` line still carries an explicit "start the instance" caveat, and the worker-coverage gap is a missing-test risk on code that runs correctly in production today, not a demonstrated defect.

## Findings

1. **[P1] [verifier: CONFIRMED, freeze-blocker REJECTED]** — `packages/agent-app/src/doctor.ts:1375-1426`. The Supermemory memory backend returns `status: "ok"` unconditionally after a pure config-shape check, regardless of the `liveness` flag — unlike the very next code paths in the same file (Ollama, Phoenix), which perform real bounded reachability probes and downgrade to `waiting` on failure. `mono-agent validate`/`doctor` on a Supermemory-configured agent reports "Memory: ok" even when the configured server is completely down. Verifier: real consistency gap, but Supermemory is opt-in/non-default (default = bujo, which does get live probes) and the `ok` output carries an explicit "start the Supermemory instance… before sending turns" detail line, so honest ops is not falsified for any default config — a real fix, not a freeze gate.
   ```ts
   // External backend (e.g. supermemory): mode/embeddings/llm are bujo-only and ignored, so report the
   // backend's own shape. We do not ping the instance here (config-shape check); the playbook covers
   // starting the server.
   ```

2. **[P2, amended from P1] [verifier: CONFIRMED with severity AMENDED, freeze-blocker REJECTED]** — `packages/agent-app/src/readiness-probe-worker.ts` (whole file) vs. `packages/agent-app/src/__tests__/readiness-probe.test.ts:16-49`. Every test that exercises the real-`Worker` transport substitutes a hand-written synthetic fixture script; only `trackPiCredentialResolverSecrets` is unit-tested directly. `readWorkerData` validation, tool-detection, `run()` orchestration, and critically `safeWorkerMessage`'s credential redaction are never executed by the test suite. This is the sole code path proving live credential readiness. Verifier: confirmed the coverage gap but downgraded P1→P2 — the worker runs correctly in production daily; a missing test is a regression *risk*, not a shipped defect, and doesn't falsify a DoD clause.
   ```ts
   async function syntheticReadinessWorker(): Promise<{ readonly url: URL; readonly cleanup: () => Promise<void> }> {
     const dir = await mkdtemp(join(tmpdir(), "mono-agent-readiness-worker-test-"));
     ...synthetic postMessage logic, not the real worker...
   ```

3. **[P2] [verifier: CONFIRMED]** — `packages/agent-app/src/readiness-probe.ts:153-197` (`safeMessage`/`redactionValues`) vs. `packages/agent-app/src/readiness-probe-worker.ts:135-177` (`safeWorkerMessage`). Two independently-drifted secret-redaction implementations straddle the worker trust boundary: the worker's is strictly stronger (length-based + generic 24+-char token catch-all plus a blanket env scan), the parent's weaker pass runs second in production. A gap in the worker's redaction has no independent second line of defense at the parent, and edits to one will not propagate to the other.
   ```ts
   // worker-side only:
   .replace(/\b[A-Za-z0-9_+/=-]{24,}\b/gu, "[REDACTED]")
   ```

4. **[P2] [verifier: CONFIRMED]** — `packages/agent-app/src/doctor.ts` (whole file, `grep -n "installRoot|closureId|snapshot|managedRuntime"` → no hits) and `packages/agent-app/src/managed-runtime-packages.ts:35-46`. `doctor`'s report never surfaces which physical install root, content-addressed closure id, or dev-vs-managed provenance is running. Live-verified (read-only) against the `personal-agent` launchd instance: the plist points at a real, distinct content-addressed closure copy (not a symlink), correctly self-contained with its own `src/`/source maps — the mechanism is sound, but nothing in `doctor`/`validate` tells an operator which closure is currently running or whether a stale/mismatched one is in play after a rebuild.
   ```ts
   const appBase = import.meta.url;
   const cwdBase = pathToFileURL(join(cwd, "package.json")).href;
   ```

5. **[P3] [verifier: CONFIRMED]** — `packages/agent-app/src/doctor.ts:2446-2487` (type predicate) and `:2163-2169`/`:2219-2225` (report never surfaces the fields). `isContinuationStoreManifest` actually *requires* `stats.compacted`, `stats.limits.terminalMaxAgeMs`, and `stats.limits.capturedTextMaxAgeMs` as present, safe non-negative integers, but the `value is {...}` predicate omits all three, and none is ever shown in `mono-agent doctor` output — validated data is checked then silently discarded.
   ```ts
   ): value is {
     readonly stats: {
       readonly records: number; readonly active: number; /* …no `compacted` … */
       readonly limits: { readonly terminalMaxRecords: number; readonly capturedTextMaxRecords: number; /* …no MaxAgeMs… */ };
     };
   } {
   ```

6. **[P3] [verifier: CONFIRMED, dead-proven]** — `packages/agent-app/src/provider-setup.ts:251-253`. `piLoginCommandLine` has zero callers anywhere in the repository (full-repo grep finds only its own declaration/`.d.ts`); it is a near-duplicate of `piAuthRecoveryCommand(provider)` minus the optional `piAuthPath` argument.
   ```ts
   export function piLoginCommandLine(provider: string): string {
     return piAuthRecoveryCommand(provider);
   }
   ```

7. **[P3] [verifier: CONFIRMED, dead-proven, disposition AMENDED]** — `packages/agent-app/src/readiness-probe.ts:563-569`. `runReadinessProbe`'s public single-route API has no production callers; `cli.ts` exclusively drives readiness through `runAllRouteReadinessProbe` via its own wrapper. The raw audit hedged "keep as an external-consumer convenience (this package is published to npm)"; the verifier's cluster-wide **NEW-1** finding (this package's `exports` map exposes only `.` → `dist/index.js`, and `runReadinessProbe` is not re-exported from top-level `index.ts`) makes that hedge moot — no external consumer can reach it either. Cleanly deletable.

8. **[P3] [verifier: CONFIRMED]** — `packages/agent-app/src/pi-oauth-login.ts:75-81`. The `auth.json` write has no `O_NOFOLLOW`/`lstat` pre-check before writing, unlike `pi-auth-store-inspection.ts` (read side) and `provider-setup.ts`'s paranoid promotion machinery (write side) governing the same file in production. Low-risk today because `provider-setup.ts`'s `runPiLoginAction` always calls this against a private `mkdtemp` staging dir before atomic promotion — but `pi-oauth-login-main.ts` is also a documented, directly-invokable public CLI entry point with no such protection if run directly against an untrusted directory.
   ```ts
   const authPath = options.authPath ?? "auth.json";
   const auth = await readAuth(authPath);
   await writeFile(authPath, `${JSON.stringify({ ...auth, [providerId]: { type: "oauth", ...credentials } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
   ```

9. **[P3] [verifier: CONFIRMED]** — `packages/agent-app/src/provider-setup.ts:187-189`, `:661-666`. Guided Pi API-key setup recognizes only `opencode-go` by name; any other Pi built-in provider supporting API-key login is silently skipped by `planProviderSetup`. A deliberate, documented scope limit (not a bug), but it narrows "bring any model" for the automatic-setup UX to one non-OAuth provider.
   ```ts
   const PI_API_KEY_PROVIDERS: Readonly<Record<string, string>> = {
     "opencode-go": "OPENCODE_API_KEY",
   };
   ```

## Dead code & deprecation

**Proven dead:**
- `piLoginCommandLine` (`provider-setup.ts:251`) — `grep -rln "piLoginCommandLine"` (excl. dist/node_modules) → definition only; 0 hits in both live instances (`~/personal-agent`, `~/a8c-agents`). Near-dup of `piAuthRecoveryCommand`.
- `runReadinessProbe` public export (`readiness-probe.ts:563`) — `grep -rn "runReadinessProbe\b"` (excl. dist/node_modules, excl. `WithSpinner`) → definition + its own test file only; `cli.ts` uses `runAllRouteReadinessProbe` exclusively. Verifier's NEW-1 confirms it is unreachable externally too (not in `index.ts`, not in the package's `exports` map) — no "keep as npm-consumer API" hedge survives; cleanly deletable.

**Load-bearing (not dead — do not remove):**
- Continuation store v1→v2→v3 migration code (`doctor.ts`) — actively supports validating/migrating live state from older mono-agent versions.
- `runtime.fallbackModels` legacy field — intentionally-retained back-compat field with different inheritance semantics from `fallbacks`; verified read at `runtime-routes.ts:8,12`.
- `memory_recall` legacy tool-name alias (`doctor.ts:1854`) — back-compat for the PascalCase tool rename.

No entries in this territory were refuted as dead by the verifier (the sole cluster-wide refutation, `attestManagedBackgroundRuntime`, belongs to A3, not A2).

## Actionable steps

| ID | What | Why | How | Effort | Acceptance check | Freeze-blocking |
|---|---|---|---|---|---|---|
| A2-1 | Add a real, bounded liveness probe for the Supermemory backend in `memorySection` | Doctor always reports `ok` regardless of whether the configured server is reachable (F1) | Mirror the Ollama/Phoenix pattern: bounded `fetch` against `sm.baseUrl` when `liveness=true`; downgrade to `waiting` (never `error`) on failure | S | `mono-agent validate` against a config pointing at a closed port reports `waiting` with an actionable message, not `ok` | n |
| A2-2 | Add real test coverage for `readiness-probe-worker.ts`'s own logic | The worker is the sole code path proving live credential readiness; it has zero test coverage of its own code (F2) | Export the currently-private pure functions (`readWorkerData`, `toolActionInEvent`, `safeWorkerMessage`) for direct unit testing, and/or spin up the real compiled worker via `new Worker(...)` against an injectable fake `createMonoRuntime` | M | A deliberate regression in `readiness-probe-worker.ts` (e.g. break `readWorkerData`'s validation) fails a test | n |
| A2-3 | Consolidate `safeMessage`/`redactionValues` (parent) and `safeWorkerMessage` (worker) into one shared, tested redaction utility | Two independently-drifted secret-redaction implementations straddling a trust boundary (F3) | Extract a shared `redactSecrets(message, {secretValues, env})` used by both files (worker applies first, parent as best-effort second pass with the SAME rules) | S | One test suite proves both call sites redact identically for the same fixture input | n |
| A2-4 | Surface managed-runtime provenance (install root / closure id / dev-vs-managed) in `doctor`'s report | An operator has no way today to see which physical code is/will run (F4) | Add a small `runtime provenance` detail reading the closure marker when running under a managed snapshot, falling back to "dev/unmanaged" otherwise | S | `mono-agent doctor` output includes a line naming the closure id or "dev (unmanaged)" | n |
| A2-5 | Fix `isContinuationStoreManifest`'s type predicate and surface `compacted`/age-based retention limits in doctor output | Validated data is silently dropped; type signature misstates its own contract (F5) | Add the 3 missing fields to the `value is {...}` predicate; add them to both the v3 and legacy-v2 detail-line builders | S | `doctor` output for an agent with continuations enabled shows a compacted count and both age-based limits | n |
| A2-6 | Delete `piLoginCommandLine` and the public `runReadinessProbe` export | Dead code, proven unreachable both internally and externally (F6, F7, NEW-1) | Delete `piLoginCommandLine`; delete `runReadinessProbe`'s public export (no external-consumer hedge survives per NEW-1) or fold its test coverage onto `runAllRouteReadinessProbe` | S | `grep` confirms no remaining references; build green | n |
| A2-7 | Add an O_NOFOLLOW/lstat symlink guard to `pi-oauth-login.ts`'s `auth.json` write | Defense-in-depth consistency with the rest of this credential-handling area (F8) | Reuse the same `open(path, O_WRONLY\|O_NOFOLLOW\|O_CREAT, 0o600)` pattern already used in `provider-setup.ts` | S | A symlinked `auth.json` in the CLI's cwd causes `runPiOAuthLogin` to refuse rather than follow it | n |

## Quarantine (refuted/unproven)

No findings, dead-code claims, or actions from this part's raw audit were refuted by the verifier. Two proposed freeze-blockers were rejected (not refutations of the underlying finding — both findings stand, just not as v1 gates):

- **A2-1 freeze-blocker status** — rejected. Reason: Supermemory is an opt-in, non-default backend; the `ok` output still carries an explicit "start the instance before sending turns" caveat, so honest ops is not falsified for any default config. The finding (F1) and its fix action remain valid, just non-blocking.
- **A2-2 freeze-blocker status** — rejected. Reason: missing test coverage of code that runs correctly in production today is a regression-risk gap, not a demonstrated defect or a falsified DoD clause. The finding (F2, severity corrected P1→P2) and its fix action remain valid, just non-blocking.
