---
name: verify-green
description: Run the mono-agent verification gate — full repo green or fast single-package iteration. Use before claiming any change works, before committing, before PRs, or when asked to "verify", "run the gate", "make it green", or "check architecture".
---

# Verify green

"Green" means the exact CI sequence passes (`.github/workflows/ci.yml`), in this order. Nothing is green because it "looks fine".

## Full gate (CI order)

```bash
node scripts/pnpm-release-age-policy.mjs  # direct pre-install guard; do not route through pnpm
pnpm run check:node
pnpm run check:secrets
pnpm run check:oss-hygiene
pnpm run check:licenses
pnpm run check:codex-discoverability  # skills/agents Codex parity (wired into CI + verify:all by PR #142)
pnpm run check:architecture     # catalog + README sections + dependency categories
pnpm run build                  # packages + demos, then strict deploy-output marker on POSIX/macOS
pnpm run typecheck
pnpm test                       # includes release:test + scripts:test + all packages + demos
pnpm run test:demo
git diff --check                # whitespace — CI runs this too
```

`pnpm run verify:all` is the closest single command — it adds alpha/beta
consumer verification (`verify:consumers`) on top of the gate above:

```bash
pnpm run verify:all
```

It is **not** a one-shot equivalent of CI, and neither side is a strict superset
of the other: `verify:all` omits `release:validate`/`release:pack`/`release:consumer`
(CI runs these — see the tarball-sanity block below), and CI omits
`verify:consumers` (only `verify:all` runs it). Run both surfaces before claiming
a change is green.

On supported POSIX/macOS hosts, the root build holds an exclusive ignored build
lock, clears any prior marker, builds packages and demos, syncs the output tree,
and atomically publishes an owner-only marker containing the full source SHA,
source state, Node/ABI, completion time, and deterministic output digest. A
concurrent build fails closed. Windows and unsupported hosts still run the
normal build commands but do not publish this deploy proof. If a crash leaves a
lock, remove it only after confirming no root build is still active, then rerun
the whole build.

Release-relevant tarball sanity (CI runs both on every push; `<version>` = `packages/agent-app/package.json` version):

```bash
pnpm run release:validate -- --tag v<version>
pnpm run release:pack -- --tag v<version>
```

## Fast iteration loop (while developing)

Do not run the full gate per edit. Iterate on one package:

```bash
pnpm --filter @mono-agent/<pkg> run build
pnpm --filter @mono-agent/<pkg> test            # or append: -- src/__tests__/<file>.test.ts --runInBand
pnpm --filter @mono-agent/<pkg> run typecheck
pnpm --filter @mono-agent/<pkg>... build        # trailing ... also builds its workspace dependencies
```

Single test file, directly:

```bash
pnpm --dir packages/<pkg> exec vitest run src/__tests__/<file>.test.ts
```

## Cross-package rebuild rule (stale-dist gotcha)

`pnpm test` / `pnpm typecheck` do NOT build first. Cross-package imports resolve
against each package's built `dist/` (tsconfig NodeNext, `exports` point at dist —
no src aliases). After editing package A, rebuild A **before** building, testing,
or typechecking any dependent B, or B silently runs against A's stale dist.
Intra-package vitest uses `src` via relative imports and is unaffected — a
package's own tests passing proves nothing about its dependents.

In worktrees this is worse: missing worktree dist falls through to the MAIN
repo's dist (see the `worktree-feature` skill).

## Review checklist (prove it in the same diff)

The mechanical gate only knows pass/fail on tests that already exist. These are
the diff-review checks that catch what a green gate can't — each already shipped
broken at least once. The rule is the same every time: prove the property in the
**same diff**.

- **Redaction-helper reuse** — before writing a new secret-redaction regex set,
  grep for the existing helper; if a second impl is truly needed, add a test
  proving both are equivalent on the same fixture. Two independently-drifted
  redactors already exist across one worker boundary.

```bash
grep -rn "safeMessage\|safeWorkerMessage\|redactionValues" packages/*/src --include=*.ts | grep -v __tests__
```

- **Security-boundary comment ⇒ security-boundary test** — when a diff adds an
  option whose doc comment states a security property (e.g.
  `preserveMcpServersUnderOverride`: "an arbitrary caller cannot X"), require a
  co-located test asserting exactly that property before merge.
- **Snapshot-vs-dynamic drift ⇒ a test they can't disagree** — if a diff adds a
  `*Fallback*`/`*Cached*`/`*Snapshot*` value alongside an existing dynamic
  resolver of the same fact (e.g. `inferUniqueNotifyDestination`), add a test
  proving they can't diverge, or document why staleness is safe.
- **Error-taxonomy completeness for provider-shaped code** — when wrapping an
  external network call in a typed-error class, cover the timeout / `AbortError` /
  connection-refused paths, not just non-2xx and malformed-body.
- **`enabled` early-out ordering across config loaders** — for every field parsed
  in a `loadXConfig`, confirm it is parsed strictly *after* that function's own
  `if (!enabled) return` guard (or carries a comment saying why it's exempt). The
  exact same bug shipped in both `telegram-adapter/config.ts` and
  `slack-adapter/config.ts`.
- **Live↔replay rendering parity** — when adding rendering for a new
  `runtime_telemetry`/stream-event kind, grep the sibling surface and add matching
  treatment (don't leave replay falling back to raw JSON). `turn-presenter.ts` ↔
  `replay-detail.ts`; the step-kind switch in
  `session-web/webapp/src/views/DetailView.tsx`.

```bash
grep -rn "session_boundary" packages/tui/src packages/session-web/webapp/src
```

- **Webapp component smoke-render** — require at least a mount+assert test for any
  new top-level view component, not only its extracted pure helpers.
  `grep -rL "render("` finds pure-only coverage:

```bash
grep -rL "render(" packages/*/webapp/src/views/*.test.ts
```

## Gotchas

- The demo gate is chained into `pnpm run build` / `pnpm test` — demos are not optional extras; a demo break is a gate break.
- A failure may pre-exist on main. The normal non-bare `main` checkout is frozen
  for fleet deployment, not development. Never edit or `git stash` it; check
  main via a detached worktree instead:

```bash
git worktree add --detach /tmp/base-check origin/main
cd /tmp/base-check && pnpm install --frozen-lockfile && pnpm --filter @mono-agent/<pkg> test
git worktree remove /tmp/base-check
```

- `git diff --check` failures (trailing whitespace) fail CI — run it locally.
- `check:codex-discoverability` enforces skills/agents Codex parity: editing an
  `agents/*.md` template requires syncing its `agents/*.toml` companion (and vice
  versa) or the gate fails (`codex-agent-toml-missing` / `-orphan`).
- Do NOT run `check:architecture` in parallel with the website build:
  `website/scripts/sync-content.mjs` deletes and recreates the synced docs dir,
  and the two race (observed on goal #124). Run them sequentially.
- `pnpm --filter <pkg> exec mono-agent …` resolves the Homebrew/global binary,
  NOT your worktree build — so it silently verifies the wrong code. Invoke the
  worktree CLI explicitly: `node packages/agent-app/dist/cli.js …` (bit goals
  #122 and #139's executor).
- **Phantom gates** — any `scripts/*.mjs` with real logic and an `isCli`/`main()`
  entry must be a *named* `pnpm run check:<name>` wired into `repoGate` in
  `scripts/verify-all.mjs`. A check that "works" only because a non-mocked test
  happens to call it (`verify-deep-imports.mjs`,
  `check-getting-started-version-pins.mjs` — both independently found) is
  invisible in `package.json` and fragile to test-glob refactors. Audit it: every
  `scripts/*.mjs` with an `isCli` block must appear in **both** `package.json`'s
  `check:*` scripts and `verify-all.mjs`'s `repoGate` array; one in neither is a
  phantom gate. `grep -rl "const isCli" scripts/*.mjs` lists the candidates. Also:
  "deep-imports ok" should still show in `pnpm run test` output whenever
  `scripts:test`'s glob changes.
- **DDL-migration guard** — before a `schema.ts` edit lands, diff it against the
  previous release tag and confirm no *existing* `CREATE TABLE` column list
  changed (only new statements appended); a changed column list on a live table
  needs a migration:

```bash
git diff <last-release-tag> -- packages/memory/src/store/schema.ts
```

- **gitleaks self-test (periodic, not every-PR)** — a secret-scanning gate that
  silently no-ops is worse than an absent one. Periodically run a scratch-repo
  test with synthetic Telegram/Slack/OpenAI-shaped tokens against `.gitleaks.toml`
  to prove it still catches them.

## Report format

State exactly which commands you ran and their outcomes. "Green" claims without
command evidence are worthless; quote the failing test name and file on red.
