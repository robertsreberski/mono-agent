# Core source scans

From the repository root, with the supported Node/pnpm versions:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run scan:core
```

Or run `pnpm run scan:dead-code` and `pnpm run scan:cycles` independently.
The dead-code scan runs Knip **5.88.1** in default, production, and
`--include-entry-exports` modes. The cycle scan runs Madge **8.0.0** separately on
contracts, config, turn, conversation, and app. Knip is an exact-pinned root
devDependency, invoked through `pnpm exec knip`; all three modes are a required
step in the existing CI verify job and local `verify:all` gate. Madge remains
pinned in the launcher and fetched with `pnpm dlx`, outside the CI guard.
Run `pnpm run build` before dead-code scanning: Knip resolves cross-package
consumers through manifest runtime/declaration entry points. CI and `verify:all`
run the guard after the contiguous build-time doc/import/consumer gate sequence. The launcher refuses an unbuilt tree
with exit 2 and a build instruction, invalidating stale reports instead of
reporting misleading findings. It checks every core manifest export condition,
subpath and top-level types/main target. Existence is not a freshness proof;
rebuild after changing source or switching revisions. Madge alone has no build
precondition; its first use needs registry access (or a warm dlx cache).

Both commands finish all scans even when findings exist. Exit codes are **0**
(clean), **1** (findings), and **2** (tool/configuration failure). A red scan is
not proof that a declaration is safe to delete. Reports and tool diagnostics are
replaced on each run under `node_modules/.cache/core-scans/`:

- `knip-{default,production,entry-exports}.json` and matching `.stderr.txt` files;
- `madge-{contracts,config,turn,conversation,app}.json`, matching `.stderr.txt` files,
  and `.policy.json` files recording exact accepted, unexpected and stale cycles.

Knip prints per-package file, value-export, type-export, and other-issue counts.
Compare symbols/paths, not just totals; production-minus-default identifies
**test-only leads**, not necessarily dead implementations. An internal export
can be a necessary test seam while its implementation remains live in production.
“No dead code” means no findings in **all three** modes, apart from the exact
exceptions below. Existing findings are deliberately not grandfathered in.

## Discovery and resolution

- Knip workspace selectors report only the five core packages. Other workspace
  packages and root tooling remain consumers, so their imports count as usage;
  the launcher rejects reports containing findings outside the selected scope.
- Manifest exports/bins and Vitest test entries are discovered by Knip. Source
  projects are bounded to `src/` (plus app's proof scripts); build outputs are
  outside discovery, not exceptions. Test directories are non-production inputs,
  so production discovery excludes `src/**/__tests__/` including their helpers.
- Package tsconfigs and Knip's manifest-derived mappings resolve built entries
  to their authored TS/MTS owners. Turn's public and private targets all use
  dist; scanners read authored source directly, without product overlays or a
  hide/restore wrapper. Build preflight still validates every runtime/type
  target. No export ignores compensate for source-mapping gaps.
- Madge scans production source (`ts,js,mjs,mts`) with `__tests__` excluded.
  Type-only edges are included. It follows reachable source dependencies across
  core packages: repeated cycles with `../../` prefixes are expected. Do not
  sum package counts as unique cycles. Madge emits representative cycles, not
  every possible traversal of a strongly connected component; including tests
  can change that representative list. Keep warnings in view: unresolved edges
  are a static-analysis limitation, not proof of an acyclic graph.

## Exact exception register

By-path entries are modeled as roots rather than hidden wholesale. The two
fixture declarations exempt only declaration exports, and ripgrep exempts one
string-loaded dependency. Individual tagged exports are registered separately
below. There are no package-wide, all-types, or public-barrel ignores.

| Exact path / dependency | Reason and treatment |
| --- | --- |
| `packages/turn/src/engine/__tests__/fixtures/regenerate-projection-goldens.mts` | By-path proof tool; regeneration workflow in [PROJECTION-GOLDENS.md](../../packages/turn/src/engine/__tests__/fixtures/PROJECTION-GOLDENS.md). Non-production entry. |
| `packages/turn/src/engine/__tests__/fixtures/projection-parity-worker.mts` | Forked from the test-only compiler output by frozen parity and the manual regeneration tool; non-production entry. |
| `packages/turn/src/__tests__/fixtures/prepared-host-runtime.mts` | Authored fixture loaded by Vite source URL; separately compiled for plain-Node proofs. Non-production entry. |
| `packages/turn/src/__tests__/ai/fixtures/native-journal-storage-worker.mts` | Compiled test-only fixture loaded by path; non-production entry. |
| `packages/turn/src/__tests__/ai/fixtures/native-lifecycle-storage-worker.mts` | Compiled test-only fixture loaded by path; non-production entry. |
| `packages/turn/src/__tests__/ai/fixtures/native-writer-holder.mts` | Compiled test-only fixture loaded by path; non-production entry. |
| `packages/turn/src/engine/__tests__/fixtures/append-worker.mts` | Compiled test-only fixture loaded by path; non-production entry. |
| `packages/turn/src/engine/__tests__/fixtures/checkpoint-worker.mts` | Compiled test-only fixture loaded by path; non-production entry. |
| `packages/turn/src/engine/__tests__/fixtures/effect-worker.mts` | Compiled test-only fixture loaded by path; non-production entry. |
| `packages/turn/src/engine/__tests__/fixtures/import-worker.mts` | Compiled test-only fixture loaded by path; non-production entry. |
| `packages/turn/src/engine/__tests__/fixtures/lock-worker.mts` | Compiled test-only fixture loaded by path; non-production entry. |
| `packages/turn/src/engine/__tests__/fixtures/native-create-worker.mts` | Compiled test-only fixture loaded by path; non-production entry. |
| `packages/turn/src/engine/__tests__/fixtures/store-owner-worker.mts` | Compiled test-only fixture loaded by path; non-production entry. |
| `packages/turn/src/engine/__tests__/fixtures/turn-evidence-worker.mts` | Compiled test-only fixture loaded by path; non-production entry. |
| `packages/turn/src/host/sandbox/srt-embed-runner.mts` | Worker loaded with `new URL` in `src/host/sandbox/index.ts`; production entry. |
| `packages/turn/package.json`: `@vscode/ripgrep` | String-resolved dependency in `src/tools/shared/ripgrep.ts` via `createRequire().resolve`; exact dependency exception, not an unused package. |
| `packages/conversation/src/tool-history/writer-worker.ts` | Worker loaded with `new URL` in `src/tool-history/writer.ts`; production entry. |
| `packages/conversation/src/__tests__/fixtures/canonical-v5-fixture.d.mts` | By-path fixture declaration companion to imported `.mjs`; non-production entry, with only declaration exports exempted (they describe JS, not independent runtime values). |
| `packages/conversation/src/__tests__/fixtures/managed-native-switch-fixture.d.mts` | By-path fixture declaration companion to imported `.mjs`; same narrow treatment. |
| `packages/app/scripts/smoke-continuity-pack.mjs` | Built configured cold provider-request proof with local fictional mail; non-production entry; see app smoke index. |
| `packages/app/scripts/smoke-subagent-stop.mjs` | By-path proof program; non-production entry. Purpose and invocation in the [app smoke index](../../packages/app/scripts/README.md). |
| `packages/app/scripts/smoke-subagent-steer.mjs` | By-path proof program; non-production entry; see app smoke index. |
| `packages/app/src/__tests__/fixtures/managed-subagent-proof.mjs` | By-path proof program; non-production entry; see app smoke index. |
| `packages/app/src/__tests__/fixtures/subagent-observer-srt.mjs` | By-path proof program requiring real SRT; non-production entry; see app smoke index. |
| `packages/app/src/__tests__/fixtures/worker-maintenance-smoke.mjs` | By-path proof program; non-production entry; see app smoke index. |

Other literal `new URL` workers and by-path entry modules already understood by
Knip require no suppression. In particular app's readiness, memory-health,
OAuth-login, maintenance, and adapter-send entry modules remain analyzed.
Public exports remain reported in entry-export mode: an exception for a future
extension surface must name exact symbols and cite a **curated usage document**,
not just a generated API inventory. String-based consumers must be traced before
cutting an export; for example `scripts/verify-consumers.mjs` dynamically loads
app's `consumerContractNames` and `validateConsumerContractFixture`. Those leads
remain visible; no blanket app-entry exception is applied.

## Focused verification

```bash
pnpm exec vitest run scripts/__tests__/core-scans.test.mjs
pnpm run check:architecture
git diff --check
```

Hosted exact-head CI supplies the broad gate; these commands do not run it.
Registering a proof program does not execute it or claim it passes.

## Export-use rule and named exceptions

`ignoreExportsUsedInFile: true` preserves production-used local implementations
exported for internal tests, including necessary declaration shapes. A symbol
with no remaining in-file use is still reported. Knip 5.88.1 rejects this option
inside a workspace, so the narrowest supported scope is this dedicated config;
the launcher selects only the five core packages. It is not a package-root or
all-types ignore and does not make test-only implementations live.

The exact `retainedExports` and `retainedEntries` registers in
[`knip.ts`](./knip.ts) list names, reasons and citations for:

- curated extension documentation (including the source-documented pricing
  resolver contract and ENGINE.md's curated engine surface);
- two real built-module loaders: config-reference generation and runtime
  attestation;
- process-global cache/probe isolation controls and the runtime registry test
  factory, not unused product features.

Turn host entries now resolve through their real owners; no deferred host or
empty-entry exemptions remain.

Only names needing a native Knip exception carry `@coreScanRetained`; the policy
test enforces exact agreement between annotations and the register. No ignored
name is justified solely by a generated inventory. The unused named stream and
provider-projection types lacking authored documentation were cut; declarations
required by retained function/class signatures remain private.

Four compatibility aliases remain: public RuntimeBridge/RuntimeBridgeDescriptor
cite their exporting entry; RuntimeSdkId cites the runtime contract that uses
it; AgentRuntimeInstance cites the native prepared-dispatch test and runtime
factory signatures. The unused private RuntimeObserver, AuthPrompt and AuthEvent
aliases and their retention entries are removed. The policy test checks each
registered name is still exported at its exact source owner; no file-level or
all-types exception is used.

The five core packages must have zero findings in all three dead-code modes.

## Exact cycle policy

[`cycle-policy.mjs`](./cycle-policy.mjs) registers one directed **erased** cycle,
reported by the app traversal:
`packages/web/dist/console-tools.d.ts → packages/web/dist/store.d.ts → packages/web/dist/console-tools.d.ts`.
The source edges are `console-tools.ts → store.ts` (`import type WebStore`) and
`store.ts → console-tools.ts` (runtime console operations). The reverse edge is
absent from JavaScript: this is a concrete store/operation declaration
collaboration, not a runtime initialization cycle. A broad forwarding store port
solely to eliminate declaration traversal would add another owner without
removing a runtime dependency.

Raw Madge findings and diagnostics stay visible. Only this exact path/edge set
passes; an additional cycle **or a stale exception** fails with exit 1. Tool or
malformed-report errors still exit 2. Cycle rotation is equivalent, not a wildcard
path or SCC-wide waiver. The policy follows emitted JavaScript edges from
`console-tools.js` transitively and refuses any path back to `store.js`, including
static imports, value re-exports and literal dynamic imports. Missing emitted
files fail rather than establish erasure. Tests pin source import kinds and
reject each runtime-edge form, including a path through a third module.

## Consolidated owners and deliberately distinct policies

| Concern | Owner and retained boundary |
| --- | --- |
| SRT identity and verifier | turn host sandbox; app and host coordinator policies remain distinct |
| Null recorder | observability; importing the no-op does not enable telemetry |
| Process incarnation | conversation; platform identity/claim semantics remain local |
| Effort vocabulary | config; provider capability interpretation stays with its provider |
| Memory health facts | lightweight memory metadata; no eager memory backend loading |
| Retry facts / reply-file defaults | turn runtime / config respectively; coordinators retain budgets |
| Retired predicate / native-root probe | config / turn host respectively; rejection and disk-probe ordering unchanged |
| MCP transport | app/mcp; conversation transport retains its separate session lifecycle |
| File, lease and activity primitives | app/durable-state; service ownership policies remain at callers |
| Daily conversation grammar | conversation; BuJo daily semantics remain memory-owned |
| Runtime and process contracts | turn contract leaves; host adapters retain orchestration |
| MCP Apps constants / timeout | contracts / turn respectively; wire values stay fixed |
| Bash and Exec mechanics | turn command leaves; host capability/admission remains separate |
| Approved snapshots | app service leaves; publication and trust remain coordinator decisions |
| Read-only inspectors | storage owners; no mutation or permissive fallback added |
| Conversation titles | app producer and web consumer validators; real MCP parity tests pin names and bounds |

Do not merge conceptual lookalikes: tool and conversation semaphores have
separate capacity scopes; JSON/source parsing has different trust boundaries;
session, skill and process layers have distinct lifecycles. Redaction,
publication/truncation and locks preserve their owner-specific ordering and
failure policies. The title producer bounds trimmed raw input before collapse;
the web consumer bounds normalized completed output.

## Naming policy

Current package and source prose uses the current owners. Historical
changelog/migration/archive text, retired-name diagnostics and negative tests,
real upstream SDK names, and native/OS or architectural kernel vocabulary are
not aliases. Serialized diagnostic keys (including managed closure metadata)
are not cosmetic identifiers.

The explicit operational identities remain unchanged: turn runtime-brand's
`agent_runtime` schema prefix, `agent-runtime` MCP/client/service names,
`agent-runtime-cli-` temporary prefix, provider prefix, title/version and doctor
hint; persisted `pi-sdk`/`mono-harness`; managed-runtime `agent-app` filesystem,
marker and package identity values. Retired package mappings and their
rejection tests remain exact. This is not a new exception category or a stored
key migration.
