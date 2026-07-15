# C2-runtime-adapter-vendored — runtime-adapter & vendored agent-runtime boundary

## 1 Verdict & maturity grade

**Grade: B.** The engineering at this boundary is genuinely strong: a compile-time structural contract test (`kernel-contract.test.ts`) keeps the facade's hand-written types honest against the vendored kernel's generated types with zero runtime leakage; the sandbox/SRT code (`sandbox.ts`, `sandbox-managed.ts`) is unusually careful supply-chain-integrity engineering (hash-pinned managed tree, monotonic policy merge, fail-closed everywhere, 43+ dedicated tests); the "only one facade may depend on agent-runtime" boundary is not just documented but mechanically enforced by `check:architecture` (verified: only `runtime-adapter/package.json` declares the dependency); and the "vendored" kernel is not a minified/opaque third-party bundle — it is fully readable, JSDoc-typed, hand-authored plain ES modules designed to be vendored-as-source by a second host (worklab), which is an honest and unusually transparent choice for a "bring any model" runtime kernel. Against that, two real gaps keep this from an A: (1) a licensing inconsistency — the GPL-3.0-only kernel is wrapped by an "UNLICENSED," publicly-published facade, and the rest of the framework has no root LICENSE at all, directly contradicting the project's own ADR claim that "mono-agent is GPLv3" — and (2) `createMonoRuntime`'s one documented sandbox-injection invariant is enforceable-bypassable via ordinary object-spread key collision, with zero test coverage of the invariant itself. Neither is exploited today by any in-repo call site, but both are cheap to close and both sit exactly on the "honest ops" / security-boundary clauses of the v1 premise. Not a live-instance part, so no separate Framework-fit grade applies.

## 2 Findings

**F1 — P1 — Licensing inconsistency: GPL-3.0-only kernel wrapped by an "UNLICENSED" facade, no root LICENSE, contradicting the project's own ADR.**
`packages/agent-runtime/package.json:6` declares `"license": "GPL-3.0-only"` and ships a genuine 674-line GPLv3 `packages/agent-runtime/LICENSE`. `packages/runtime-adapter/package.json` — the *only* package permitted to (and that does) statically import it — declares:
```
"license": "UNLICENSED",
"private": false,
"publishConfig": { "access": "public" }
```
Every other package in the monorepo (`agent-app`, `agent-harness`, `config`, all channel adapters, etc. — 16 of 17 published packages) is also `"UNLICENSED"`, and there is no root `LICENSE` file at all (`ls LICENSE*` → no matches; root `package.json` has no `license` field). Meanwhile `docs/reference/worklab-shared-kernel.md:39` states as settled fact: *"License and deployment mismatch: mono-agent is GPLv3 while Worklab has private deployment needs."* The ADR's own premise (mono-agent = GPLv3) is not what the shipped package metadata says. `runtime-adapter` directly, statically imports agent-runtime in-process (`import { createRuntime, createRouterRuntime } from "@mono-agent/agent-runtime"` — not a subprocess, not a stable network API), which is about as tight a linkage as JS permits; per the MEMORY record these packages are already live on npm (v0.3.0+ "all 29 pkgs live on npm"). Whether the correct fix is "relicense the wrapping stack as GPL-compatible" or "the ADR is wrong and a different consistent license should be chosen and documented," the current state is internally contradictory and leaves every consumer of the published packages with an unclear (and, read literally, non-existent) grant of rights. This is precisely the kind of "dishonest ops" gap the audit is chartered to catch, and it is scoped squarely inside this territory's boundary (runtime-adapter ↔ agent-runtime).

**F2 — P1 — `createMonoRuntime`'s sandbox injection is silently overridable via an ordinary object-spread key collision.**
`packages/runtime-adapter/src/sandbox-impl.ts:8-11` documents: *"This module is the ONE place a mono-agent host's sandbox policy actually gets enforced: every `createMonoRuntime(...)` call injects `monoSandboxImpl`..."* The construction is:
```ts
// runtime-adapter.ts:217
const hostWithSandbox = { sandbox: monoSandboxImpl, ...hostOptions } as unknown as KernelHostOptions;
```
`CreateMonoRuntimeOptions` extends `MonoRuntimeHostOptions extends RuntimeToolOptions`, and both carry `readonly [key: string]: unknown` (`types.ts:220`, `types.ts:288`) — neither declares a `sandbox` field, but the index signature lets a caller pass one anyway, and because the spread order puts `...hostOptions` *after* the default, any `sandbox` key present in `hostOptions` silently wins over `monoSandboxImpl`. Agent-runtime's own `HOST_KEYS`/`TOOL_RUNTIME_KEYS` in `packages/agent-runtime/src/runtime.js:64-71` explicitly includes `"sandbox"` in the keys it reads once, at construction time, into the long-lived per-instance `ToolContext` — so an accidental collision is not per-run, it silently governs the sandbox enforcement for the runtime's entire lifetime. No test in `runtime-adapter.test.ts`, `sandbox-impl.test.ts`, or `kernel-contract.test.ts` exercises this invariant (grepped: zero mentions of `sandbox` in `runtime-adapter.test.ts`). Mitigating factor: agent-runtime's `passthroughSandbox` fails *closed* (denies) rather than open when no real implementation is present, so an accidental `sandbox: undefined` breaks availability rather than security; and no current in-repo call site (`configured-agent.ts`, `readiness-probe-worker.ts`) passes a `sandbox` key today (only `sandboxPolicy`/`sandboxEngine`), so this is latent, not actively exploited. It is nonetheless a one-line-fixable gap in the single most security-relevant seam in this boundary.

**F3 — P2 — Five publicly-exported helpers in `runtime-helpers.ts` have zero consumers anywhere outside their own test file.**
`assertBaseRunOptions`, `readLastStringUserMessage`, `buildRuntimeResult`, `applyTemporaryEnv`, and `withTemporaryEnv` (`runtime-helpers.ts:35,62,104,137,154`) are exported through the package's public `index.ts` and documented as shared scaffolding "each SDK runtime" duplicated ("Codex previously kept ~4 byte-identical copies of this," `runtime-helpers.ts:9-14`). A repo-wide grep finds these five used only inside `runtime-helpers.test.ts` — never by `agent-app`, `agent-harness`, or any other in-repo consumer. `git log --follow --diff-filter=A` traces the file to the very first commit (`53a118e2`, "align packages onto shared substrate"), i.e. from before agent-runtime was split out as a zero-workspace-dependency vendored kernel. Once that split happened, these helpers became structurally unreachable from the very "SDK runtimes" they were built to dedupe (agent-runtime cannot import from runtime-adapter without creating the exact circular dependency the whole boundary is designed to avoid) — they are load-bearing-shaped orphans left behind by an architecture change, still advertised as live public API.

**F4 — P2 (context: assessment of open issue #191) — `assertSecureRegularFile`'s blanket `nlink !== 1` rejection matches an already-filed, still-open compatibility gap.**
`packages/runtime-adapter/src/sandbox-managed.ts:245` rejects any trusted file (managed SRT tree, but also the *external* SRT executable and an *explicit* `nodePath`/`cliPath` pair via the same `resolveTrustedFile`/`assertSecureRegularFile` path) whenever `stat.nlink !== 1`. GitHub issue #191 ("Evaluate managed SRT compatibility with hard-linked Node executables," open, filed as a follow-up from the #185 security review) describes exactly this: single-link enforcement is appropriate for the private managed tree but can incorrectly reject a legitimate external Node launcher (NVM/Homebrew/hosted toolcaches) that happens to be hard-linked, since multiple hard links alone don't grant another principal write access — ownership/mode bits are the real boundary there. Verified the code still matches the issue's description exactly; no additional undiscovered instance of the bug was found. Disposition: correctly filed, correctly still open, not a new finding — carried forward for the synthesis pass.

**F5 — P3 — `MIGRATION.md` §11 undercounts its own exports map by one entry.**
`packages/agent-runtime/MIGRATION.md:195-221` states *"3 barrels... plus 21 named deep `.js` subpaths"* and enumerates exactly 21. The actual `package.json` `exports` map (`packages/agent-runtime/package.json`) has **22** deep subpaths — `./ai/providers/claude-sdk-discovery.js` is present and working (confirmed via `scripts/verify-deep-imports.mjs`'s real-resolution test, which passes) but is missing from MIGRATION.md's enumerated list. Low severity (the export itself works and is gated), but this document's entire purpose is being the authoritative list an external consumer (worklab, per its own appendix) reads before porting — an off-by-one here is exactly the kind of drift that erodes trust in a document whose job is precision.

**F6 — P3 — Recon-hint "76-subpath export surface" does not match the actual exports map; correcting the record.**
The real `package.json` `exports` map has **25** entries total (3 barrels + 22 deep `.js` subpaths — see F5), not 76. The full root barrel (`.`, which re-exports `./ai` and `./agent` via `export *`) surfaces 62 distinct named symbols at runtime (verified by importing `src/index.js` directly and counting `Object.keys`). Neither figure is 76 under any counting I could reconstruct. This is not a defect — the actual surface is smaller than the recon lead suggested — but it's worth explicitly correcting so downstream synthesis doesn't propagate an unverified number. Of the 22 mapped deep subpaths, only 3 (`ai/runtime/model-refs.js`, `ai/runtime/registry.js`, `agent/compaction.js`) are actually imported anywhere else in this monorepo today; the rest exist to serve worklab (an external, out-of-repo consumer documented in MIGRATION.md's appendix) and forward API stability. This is a bounded, actively-monitored liability (guarded by `scripts/verify-deep-imports.mjs`, which — contrary to what its own file-comment might suggest in isolation — **is** wired into the release-gate: `pnpm run test` → `scripts:test` → `vitest run scripts/__tests__/*.test.mjs`, which includes a real (non-mocked) resolution pass over the live exports map), not a silent-rot risk.

**F7 — P3 — Stray/uncontextualized provenance language in vendored doc comments.**
`packages/agent-runtime/src/agent/index.js:1-5` opens with: *"The kernel is consumed by the worker, the assistant, the Slack triage path, and the coordinator's run-spawn path."* None of "the assistant," "Slack triage path," or a bare "worker"/"coordinator" (without the "worklab's coordinator" qualifier used correctly elsewhere, e.g. `ai/failure.js:32`) are mono-agent concepts, and they are not identified as belonging to the external worklab host either. A stranger reading this vendored kernel's very first doc-comment — exactly the audience the "lean, understandable core" premise clause is written for — gets a description of consumers that don't exist anywhere in this repo, without a pointer to MIGRATION.md's worklab appendix that would explain the terms. Cosmetic, but real: this doc-comment pattern recurs across 7 files (`agent/index.js`, `agent/transcript.js`, `ai/live-input-prompt.js`, `ai/types.js`, `ai/failure.js`, `ai/providers/claude-cli.js`, `ai/providers/pi-native/session-lifecycle.js`), most of which correctly say "worklab's coordinator" — only `agent/index.js`'s opening summary doesn't.

## 3 Dead code

| Path | Why dead | Proposed disposition | Proof hints |
|---|---|---|---|
| `packages/runtime-adapter/src/runtime-helpers.ts` — `assertBaseRunOptions`, `readLastStringUserMessage`, `buildRuntimeResult` | Exported as public API, documented as shared scaffolding for "each SDK runtime," but agent-runtime's own bridges (the only plausible consumers) cannot import from runtime-adapter without violating the zero-workspace-dependency rule that defines the package boundary (see F3). Zero non-test consumers repo-wide. | Either (a) delete and let a future real dedup effort re-extract from the actual duplicated call sites if/when one exists, or (b) if kept for external (worklab-style) consumers, say so explicitly in the README's "Advanced exports" section the way the `ai/`/`agent/` deep paths already do. | `git log --follow --diff-filter=A` traces the file to the pre-agent-runtime-split first commit (`53a118e2`); `grep -rn "assertBaseRunOptions\|readLastStringUserMessage\|buildRuntimeResult" packages apps` outside `runtime-adapter/` returns nothing. |
| `packages/runtime-adapter/src/runtime-helpers.ts` — `applyTemporaryEnv`, `withTemporaryEnv` | Same pattern as above — env-restore scaffolding with no consumer outside its own test. | Same as above. | Same grep pattern, zero hits outside `runtime-adapter/`. |
| `packages/runtime-adapter/src/runtime-adapter.ts` — `acceptedSdkIdsForBackend`, `listMonoRuntimeSelectionTable` | Explicitly documented as "NOT wired into agent-host routing; consumers read it to align vocabularies" and "Runtime packages derive their... guard sets from these aliases" — a forward-looking building block with no current consumer anywhere in `agent-app`/`agent-harness`. Lower-severity than the runtime-helpers cluster because it's small, harmless, and honestly labeled as aspirational infrastructure rather than presented as active dedup. | Keep if a near-term consumer is planned (the doc comment implies intent); otherwise fold into the actionable-steps review alongside F3. | `grep -rn "acceptedSdkIdsForBackend\|listMonoRuntimeSelectionTable" packages apps` outside `runtime-adapter/` returns nothing. |
| `RuntimeToolLimits.bashTimeoutMs` (`types.ts:127`) | Explicitly and honestly labeled in its own doc comment: "Documented for forward-compat; NOT wired to any tool today." | No action — this is a disclosed stub, not a hidden dead path. Listed here only for completeness. | Type-level only; comment self-discloses. |

## 4 Deprecation & legacy

No `@deprecated`-tagged symbols exist in `packages/runtime-adapter/src/**`. The one legacy-shaped surface in scope is the `options.settings` flat bag documented in `MIGRATION.md` §8 as deprecated in favor of typed `toolLimits`/`compaction`:
- **Load-bearing, correctly kept**: `resolveRuntimePolicies()` (`runtime-policies.ts`) is the *supported, current* migration helper that projects the legacy bag into the typed replacement objects — this is not itself legacy, it's the bridge off legacy, and it is actively tested (`runtime-policies.test.ts`, including a parity test that the typed path resolves byte-identically to the raw bag). Nothing to remove; removing the legacy `settings` acceptance itself is a kernel-side (agent-runtime) decision, out of this territory's file scope, and MIGRATION.md already documents that the shim "keeps working with one deprecation warning per run" by design.
- **`pi-sdk.js` deep-import removal** (MIGRATION.md §1, §11): correctly and completely removed — not present in the current `exports` map, confirmed absent from `verify-deep-imports.test.mjs`'s explicit negative assertion (`expect(specifiers).not.toContain(".../pi-sdk.js")`). No orphaned reference to it remains in `runtime-adapter/src/**`.

## 5 Actionable steps

| ID | What | Why (premise/DoD link) | How | Effort | Acceptance-check | Freeze-blocking |
|---|---|---|---|---|---|---|
| A-C2-1 | Resolve the license inconsistency: add a root `LICENSE`, and make every package's `license` field consistent with a deliberate, documented decision (either align the wrapping stack to a GPL-compatible license matching the ADR's "mono-agent is GPLv3" claim, or explicitly re-scope/relicense and update the ADR to match reality) | "Honest ops" — a publicly-published framework cannot have package metadata that contradicts its own architecture decision record about what license the project is under (F1) | Legal/licensing decision by the maintainer first; then a small scripted pass to set consistent `license` fields + add root `LICENSE` + update `docs/reference/worklab-shared-kernel.md` if the decision changes its premise | S (once the decision is made) | `grep license packages/*/package.json` shows one consistent, intentional answer; root `LICENSE` exists; ADR text matches shipped metadata | y |
| A-C2-2 | Make the sandbox injection in `createMonoRuntime` unconditionally win: flip the spread order (`{ ...hostOptions, sandbox: monoSandboxImpl }`) and/or type `CreateMonoRuntimeOptions` as `Omit<MonoRuntimeHostOptions, "sandbox">` so passing `sandbox` is a compile error | Closes the silent-override footgun on the single most security-relevant seam in this boundary (F2) | Edit `runtime-adapter.ts:217`; add a regression test asserting a caller-supplied `sandbox` key is ignored/rejected | S | New test: `createMonoRuntime({ sandbox: fakeImpl })` still enforces `monoSandboxImpl`-equivalent behavior (or throws at compile/runtime) | y |
| A-C2-3 | Delete or explicitly re-document the 5 orphaned `runtime-helpers.ts` exports (`assertBaseRunOptions`, `readLastStringUserMessage`, `buildRuntimeResult`, `applyTemporaryEnv`, `withTemporaryEnv`) | "Lean, understandable core" — public API with zero real consumers is a legibility tax on every future reader (F3) | Remove from `index.ts` public exports (keep as internal `runtime-helpers.js` if still useful for a future dedup) or add a README note explaining they're pre-emptive/for external hosts | S | `grep` shows either the exports are gone from `index.ts` or the README documents an intended external consumer | n |
| A-C2-4 | Fix MIGRATION.md §11's "21 subpaths" count to 22 (add `claude-sdk-discovery.js` to the enumerated list) | Doc precision for the document whose entire job is being the authoritative deep-import list for worklab (F5) | One-line edit to `MIGRATION.md` | S | Enumerated list length matches `package.json` `exports` deep-path count | n |
| A-C2-5 | Reword `agent/index.js`'s opening doc-comment to either name worklab explicitly (like `ai/failure.js` does) or describe consumers generically without host-specific jargon | "A competent stranger must be able to understand the core" (F7) | One-comment edit | S | Comment no longer references consumers absent from both this repo and MIGRATION.md's appendix | n |
| A-C2-6 | Cross-link issue #191's disposition into `sandbox-managed.ts`'s doc comment so a future reader sees the compatibility tradeoff is a known, tracked, deliberate choice rather than an oversight | Traceability for an already-filed, still-open issue (F4) | One-comment addition citing #191 | S | Comment present near `assertSecureRegularFile` | n |

## 6 Skill-worthy flags

- **verify-green**: `scripts/verify-deep-imports.mjs` is *not* listed as a named step in `scripts/verify-all.mjs`'s `repoGate` array — it is only exercised indirectly because its own `scripts/__tests__/verify-deep-imports.test.mjs` happens to run a real (non-mocked) resolution pass under `pnpm run test` → `scripts:test`. This works today, but it's an implicit gate: a future refactor of `scripts:test`'s glob or of the test file could silently drop this coverage with no named-step failure to point at. Worth an amendment to `verify-green` (or a one-line addition to `verify-all.mjs`'s `repoGate` comment) noting that "deep-imports ok" should be checked to still appear in `pnpm run test` output whenever `scripts:test`'s test glob changes — this is exactly the kind of "gate exists but isn't named" gap the skill should catch systematically, not just for this one script.
- **pi-upstream-recon**: When auditing/porting a package like `agent-runtime` that is deliberately designed to be vendored-as-source into a second host (worklab), a recurring check worth adding to the skill: verify package.json `license` field consistency across the vendoring boundary *before* treating a "wrap a GPL/AGPL kernel behind a differently-licensed facade" pattern as settled — this is exactly the kind of cross-package licensing drift that's easy to miss because each package's own README/tests are internally consistent even when the metadata across the boundary is not.

## 7 Coverage note

Files read in full:
- `packages/runtime-adapter/README.md`
- `packages/runtime-adapter/package.json`
- `packages/runtime-adapter/src/index.ts`
- `packages/runtime-adapter/src/types.ts`
- `packages/runtime-adapter/src/runtime-adapter.ts`
- `packages/runtime-adapter/src/runtime-helpers.ts`
- `packages/runtime-adapter/src/mcp-servers.ts`
- `packages/runtime-adapter/src/runtime-policies.ts`
- `packages/runtime-adapter/src/sandbox-impl.ts`
- `packages/runtime-adapter/src/sandbox.ts`
- `packages/runtime-adapter/src/sandbox-managed.ts`
- `packages/runtime-adapter/src/local-providers.ts`
- `packages/runtime-adapter/src/__tests__/kernel-contract.test.ts`
- `packages/runtime-adapter/src/__tests__/sandbox-managed.test.ts`
- `packages/runtime-adapter/src/__tests__/runtime-helpers.test.ts`
- `packages/agent-runtime/package.json`
- `packages/agent-runtime/README.md`
- `packages/agent-runtime/ARCHITECTURE.md`
- `packages/agent-runtime/MIGRATION.md`
- `packages/agent-runtime/src/index.js`
- `packages/agent-runtime/src/runtime.js`
- `packages/agent-runtime/src/ai/index.js`
- `packages/agent-runtime/src/ai/registry.js`
- `packages/agent-runtime/src/agent/index.js`
- `packages/agent-runtime/src/agent/tools/index.js`
- `docs/reference/worklab-shared-kernel.md`
- `scripts/verify-deep-imports.mjs`
- `scripts/__tests__/verify-deep-imports.test.mjs`

Files skimmed (structure/describe-block/grep pass, not line-by-line, per test-code instruction):
- `packages/runtime-adapter/src/__tests__/runtime-adapter.test.ts` (all `describe`/`it` titles reviewed; sandbox-related sections confirmed absent via targeted grep)
- `packages/runtime-adapter/src/__tests__/sandbox-impl.test.ts`
- `packages/runtime-adapter/src/__tests__/sandbox-policy.test.ts` (43 test cases across 5 `describe` blocks, titles reviewed)
- `packages/runtime-adapter/src/__tests__/runtime-policies.test.ts`
- `packages/runtime-adapter/src/__tests__/local-providers.test.ts`
- `packages/agent-runtime/src/agent/sandbox-seam.js` (grep spot-check only, for the `passthroughSandbox` fail-closed claim — within the "skim types" allowance, not full-file read)
- `scripts/verify-all.mjs` (first ~100 lines, the `repoGate` definition)
- `scripts/package-catalog.mjs` (grepped for `agent-runtime`/`runtime-adapter`/`config` catalog entries)
- `scripts/check-package-architecture.mjs` (grepped for the category-dependency enforcement logic, lines ~30-105)

Auxiliary verification (not file reads, but load-bearing evidence-gathering):
- `python3`/`node` one-liners to count `package.json` `exports` entries (25), enumerate `license` fields across all `packages/*/package.json` (16 UNLICENSED + 1 GPL-3.0-only), and count distinct named exports from the root/`ai`/`agent` barrels (62)
- `git log --follow --diff-filter=A` on `runtime-helpers.ts` to establish provenance (F3)
- `gh issue view 190/191/226` to cross-check the named open issues against the current code
- `grep -r` sweeps across `packages/` and `apps/`-equivalent dirs for every symbol named in Findings/Dead-code, to confirm consumer counts before asserting "zero consumers"

Not read (out of scope per the assignment): the remaining ~115 vendored `.js` implementation files under `packages/agent-runtime/src/**` beyond the specified index.js spot-checks and the `sandbox-seam.js` grep; `packages/runtime-adapter/tsconfig*.json` (build config, not part of the audited boundary logic).
