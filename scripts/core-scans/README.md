# Core source scans

From the repository root, with the supported Node/pnpm versions:

```bash
pnpm install --frozen-lockfile
pnpm run scan:core
```

Or run `pnpm run scan:dead-code` and `pnpm run scan:cycles` independently.
The dead-code scan runs Knip **5.88.1** in default, production, and
`--include-entry-exports` modes. The cycle scan runs Madge **8.0.0** separately on
contracts, config, turn, conversation, and app. Knip is an exact-pinned root
devDependency, invoked through `pnpm exec knip`; all three modes are a required
step in the existing CI verify job and local `verify:all` gate. Madge remains
pinned in the launcher and fetched with `pnpm dlx`, outside the CI guard.
No package build is needed. Madge first use needs registry access (or a warm dlx cache).

Both commands finish all scans even when findings exist. Exit codes are **0**
(clean), **1** (findings), and **2** (tool/configuration failure). A red scan is
not proof that a declaration is safe to delete. Reports and tool diagnostics are
replaced on each run under `node_modules/.cache/core-scans/`:

- `knip-{default,production,entry-exports}.json` and matching `.stderr.txt` files;
- `madge-{contracts,config,turn,conversation,app}.json` and matching `.stderr.txt` files.

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
- Existing package tsconfigs map normal `dist` exports back to source. Turn's
  mixed layout has source JS exports and four compiled `dist/host` entries but
  no `tsconfig.json`. `knip.ts` maps those **four exact package specifiers** to
  their TS sources in every workspace, and registers the host entries. This
  avoids a temporary turn tsconfig and works in an unbuilt checkout. Update
  those mappings alongside any future turn artifact/export-map migration.
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
| `packages/turn/src/engine/__tests__/fixtures/regenerate-projection-goldens.mjs` | By-path proof tool; regeneration workflow in [PROJECTION-GOLDENS.md](../../packages/turn/src/engine/__tests__/fixtures/PROJECTION-GOLDENS.md). Non-production entry. |
| `packages/turn/src/host/srt-embed-runner.mjs` | Worker loaded with `new URL` in `src/host/sandbox.ts`; production entry. |
| `packages/turn/package.json`: `@vscode/ripgrep` | String-resolved dependency in `src/agent/tools/shared/ripgrep.js` via `createRequire().resolve`; exact dependency exception, not an unused package. |
| `packages/conversation/src/tool-history-writer-worker.ts` | Worker loaded with `new URL` in `src/tool-history-store.ts`; production entry. |
| `packages/conversation/src/__tests__/fixtures/canonical-v5-fixture.d.mts` | By-path fixture declaration companion to imported `.mjs`; non-production entry, with only declaration exports exempted (they describe JS, not independent runtime values). |
| `packages/conversation/src/__tests__/fixtures/managed-native-switch-fixture.d.mts` | By-path fixture declaration companion to imported `.mjs`; same narrow treatment. |
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
  factory, not unused product features;
- deferred host-entry regrouping and the intentionally empty allowlists entry.

Only names needing a native Knip exception carry `@coreScanRetained`; the policy
test enforces exact agreement between annotations and the register. No ignored
name is justified solely by a generated inventory. The unused named stream and
provider-projection types lacking authored documentation were cut; declarations
required by retained function/class signatures remain private.

The five core packages must have zero findings in all three modes. Cycle findings
remain visible until the separate structural cleanup; exceptions do not hide
cycles or turn a nonzero tool result into success.
