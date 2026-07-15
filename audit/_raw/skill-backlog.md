# Skill backlog — v1-freeze audit consolidation

Source: every `## 6 Skill-worthy flags` section across the 24 audit artifacts
(`audit/_raw/{A1..A6,B1..B3,C1..C7,D1,E1..E4,F1,F2,G1}.md`), cross-referenced
against the 8 existing engineering skills (`skills/{verify-green,worktree-feature,
fleet-deploy,live-smoke,release-lockstep,docs-sync,pi-upstream-recon,new-package}`).

Flags are addressed to the engineering skills that Claude Code / Codex load when
developing **this repo** (via `.claude/skills` / `.agents/skills`), not to
mono-agent runtime instances.

Every flag is tagged `<artifact>-<letter>` and appears in exactly **one** of the
three sections below. 61 flag-bullets total (the audit's "~58" plus a few
meta/"no-other-issues" bullets). Assignment index is at the very bottom.

- **Section 1 — New skills (3):** `dead-code-audit`, `repo-hygiene-gc`,
  `ops-log-hygiene`.
- **Section 2 — Amendments (39 seed-entries across 8 skills):** grouped per existing skill.
- **Section 3 — Not skill-worthy (10):** code fixes, CI checks, one-offs.

---

## 1. NEW SKILLS

### 1.1 `dead-code-audit`

**One-line:** Prove-or-remove protocol for dead exports, orphaned wiring, and
deprecated surfaces across the *whole* monorepo — the pre-freeze / post-refactor
cleanup discipline.

**Why existing skills can't absorb it:** `verify-green` runs the CI gate (it only
knows pass/fail on tests that already exist — a dead-but-well-tested path is green
to it). `worktree-feature` is about isolation, not reachability. `pi-upstream-recon`
is explicitly about *external* pi APIs, not internal dead code. Six auditors
(A1, A4, A6, B1, B2, plus C3's dead public API) independently hit the same shape:
a symbol has good unit coverage but zero live callers, and nothing systematically
catches it. The removability triage is a genuine multi-step process no current
skill encodes.

**SKILL.md outline (exact commands / gotchas from the flags):**

1. **Whole-monorepo dead-export grep** *(B1-b)* — good test coverage of an
   exported symbol is not evidence it is live. For each symbol in a package's
   public `index.ts`, grep the *rest* of the monorepo (not just the owning
   package) for a non-test caller:
   ```bash
   grep -rln "<symbol>" packages/*/src extras/*/src --include="*.ts" | grep -v __tests__
   ```
   Zero non-owning callers + no `@deprecated`/`@experimental` label ⇒ candidate
   for removal. (Dead public search API in memory was found exactly this way.)

2. **Maintenance-routine call-site check** *(A4-a)* — when a diff adds an exported
   `compact*`/`prune*`/`rotate*`/`gc*` function, it must have a non-test call site
   in the runtime lifecycle. The correct pattern already exists
   (`pruneTraceSources` called from `web-command.ts`/`tui-command.ts` at startup);
   `compactPostedMessageIndex` shipped tested-but-never-wired.
   ```bash
   git diff --name-only | xargs grep -l "^export.*function.*\(compact\|prune\|rotate\|gc\)"
   grep -rl "<fnName>(" <package>/src | grep -v __tests__   # must return > the definition file
   ```

3. **Orphaned-wiring after a "shared/pooled/cached" refactor** *(A6-b)* — every
   time a refactor introduces a shared/pooled version of an existing per-request
   mechanism, grep for and *remove or justify* the old mechanism's exports in the
   same pass. Dead `createMemoryRecallRuntimeExtension` survived this shape; the
   pattern recurs (runtime live-sessions redesign, agent-runtime kernel redesign).

4. **Duplicated-primitive sweep before hand-rolling** *(A1-a, A6-a)* — before
   writing any non-trivial parser/algorithm/primitive, grep the monorepo
   (especially packages already in this package's `package.json` deps) for an
   existing implementation:
   ```bash
   grep -rln "<primitive-name>" packages/*/src --include="*.ts" | grep -v __tests__
   ```
   Real misses: `memory-rituals.ts`'s hand-rolled cron parser; the same
   mkdir/owner.json/incarnation/quarantine singleton-lock choreography re-derived
   four times (worker lease, CLI lifecycle lock, managed-runtime install lock, SRT
   install lock — all already share `process-incarnation.ts`).

5. **The 5-step deprecation-removability protocol** *(B2-a)* — a shallow single
   grep produces wrong verdicts; run all five before declaring "removable":
   1. grep the symbol across all non-test app/cli source,
   2. grep `demos/` and `scripts/`,
   3. grep **both** live-instance directories **and every launchd plist**,
   4. grep `docs/` to tell *documented-as-intentionally-retained legacy* from
      *accidentally-orphaned*,
   5. if a CLI binary is involved, check `package.json`'s `bin` — a *published*
      contract raises the bar past "no current caller."

   This produced two different verdicts for one-looking deprecations
   (`reflect.ts` fn = **keep**, `store.ts` methods = **remove**); a shallower
   check would have lumped them together.

6. **Prove live-usage from manifests, read-only** *(B2-b)* — for
   content-addressed / manifest-based subsystems, read the live instance's
   manifest/runtime sidecars directly (`mode=ro`, never write) before declaring a
   path exercised or unused:
   ```bash
   # read-only — turns "is this used?" from speculative into proven-with-a-timestamp
   ~/personal-agent/.mono-agent/memory/.index/manifest.json
   ~/personal-agent/.mono-agent/memory/.index/runtime.json
   ~/personal-agent/.mono-agent/memory/.memory-forget-backup-*/manifest.json
   ```

**Source flags:** A1-a, A4-a, A6-a, A6-b, B1-b, B2-a, B2-b.

---

### 1.2 `repo-hygiene-gc`

**One-line:** Periodic branch/worktree garbage collection plus the post-merge
cleanup protocol that keeps the repo from drowning in dead branches and worktrees.

**Why existing skills can't absorb it:** `worktree-feature` is scoped to *one*
in-flight feature (create → ship → remove that one worktree); it owns no periodic
bulk sweep and no repo-level GitHub settings. Nothing in the current set owns
"the repo has accumulated 47 branches / 50 worktrees — clean it up," which is a
distinct janitorial trigger from shipping a feature. (A small post-merge step is
*also* added to `worktree-feature` — see §2.6 — but that only covers the
per-feature case; the bulk sweep needs its own owner.)

**Evidence — the #167 regression:** the freeze-audit progenitor #167 verified a
clean state of **2 branches / 3 worktrees**; 8 days of continued goal-loop
velocity regressed it to **47 branches / 50 worktrees**
(`git branch --list | wc -l` = 47, `git worktree list | wc -l` = 50). The remote
side never self-cleans because `delete_branch_on_merge` is off:
```bash
gh api repos/robertsreberski/mono-agent --jq .delete_branch_on_merge   # => false
```

**SKILL.md outline:**

1. **Turn on server-side automation (one-time):** set
   `delete_branch_on_merge: true` on the repo so merged remote branches auto-delete
   (via `gh api -X PATCH repos/robertsreberski/mono-agent -f delete_branch_on_merge=true`).
2. **Local branch sweep:** list branches already merged into `main`, excluding
   `main`/current, and delete them:
   ```bash
   git branch --merged main | grep -vE '^\*|(^|\s)main$' | xargs -r git branch -d
   ```
3. **Worktree sweep:** for each worktree whose branch is merged, remove it, then
   prune stale registrations:
   ```bash
   git worktree list                       # audit
   git worktree remove <path>              # per merged worktree
   git worktree prune
   ```
4. **Post-merge protocol (the discipline that prevents regrowth):** after any
   `gh pr merge` confirms merged → `git worktree remove <path>` → `git branch -d
   <branch>`. Pair with the `delete_branch_on_merge` setting above so remote and
   local both self-clean. (This same step is folded into `worktree-feature`'s
   "Ship" flow — §2.6.)
5. **Cadence:** run the full sweep whenever `git worktree list | wc -l` or
   `git branch --list | wc -l` climbs into double digits, or as a standing item
   at the end of a goal-loop wave.

**Source flags:** E3-a (bulk-sweep + repo-setting half; the per-feature post-merge
half is mirrored into `worktree-feature` §2.6).

---

### 1.3 `ops-log-hygiene`

**One-line:** Keep the live fleet's logs bounded and catch crash-loops /
restart-churn — log-size caps, crash-loop tailing, degraded-channel churn
detection.

**Why existing skills can't absorb it:** `fleet-deploy` is deploy-time provenance
(build marker, plist reconciliation) and `live-smoke` validates a *change* against
throwaway dirs — neither is a standing "are the live agents' logs healthy?"
discipline. The F1/F2 auditors each recommended splitting these checks across
`fleet-deploy` *and* `live-smoke`; centralizing them under one owner avoids two
drifting copies and gives the distinct "check the agents' logs / rotate logs /
are they crash-looping?" trigger a home. (F1 wrote "no new skill needed"; I
disagree — three findings, each with an exact seed command and hard evidence
[1.23 GB, ~4,500 cycles, 108 crashes], recur and deserve one owner rather than
being duplicated into two skills.)

**SKILL.md outline (exact commands / gotchas from the flags):**

1. **Log-size caps every deploy** *(F1-a)* — an unrotated launchd
   `StandardOutPath`/`StandardErrorPath` silently grew to **1.23 GB** before
   anyone noticed. On every deploy, check each instance's log paths against a cap
   and wire rotation (newsyslog/logrotate or a size probe that fails the deploy
   check above the cap). Same pass: verify every CLI wrapper an instance ships
   (`bin/mono-agent`, `bin/agent-watchdog`, `bin/session-web` or equivalents)
   resolves the **pinned runtime snapshot** the live plist uses, not a mutable
   monorepo checkout path — a pattern risk for every instance because this
   monorepo is under continuous active development on the same machine.
2. **Post-restart crash-loop tail** *(F2-a)* — after restarting/deploying any
   launchd-managed service, tail its log for N (e.g. 5) identical failure lines in
   a short window and **fail** the deploy rather than declaring success once the
   process is merely "loaded." brain-core crashed **108 times** on 2026-07-13
   before detection.
   ```bash
   tail -n 20 <service log> | sort | uniq -c | sort -rn | head -1
   # top count over a small threshold AND the message looks like an error ⇒ deploy failed
   ```
3. **Channel-restart churn detection** *(F1-b)* — grep the last hour of logs for
   repeated `channel degraded` / `scheduling restart` pairs above a threshold; one
   instance accumulated **~4,500** such cycles over 5 weeks with nothing in the
   standard smoke/verify flow ever surfacing it.

**Source flags:** F1-a, F1-b, F2-a.

---

### Considered but rejected as a standalone skill: `fleet-green-window`

The 7-day DoD tracker (`scripts/fleet-green-check.mjs`, the #168→#119 window) and
the honest-fleet-claims concern are already **fully owned** by `fleet-deploy`'s
"Daily green check" section. The real gaps — the nightly job may be documented but
not actually installed *(E2-c)*, and live-instance manifests should be read as
ground truth *(B2-b)* — are verification amendments, not a missing process. A
parallel skill would duplicate `fleet-deploy`. So E2-c lands as a `fleet-deploy`
amendment (§2.5) and B2-b strengthens `dead-code-audit` (§1.1 step 6); actually
re-installing/verifying the LaunchAgent is a one-off action (§3).

---

## 2. AMENDMENTS TO EXISTING SKILLS

### 2.1 `verify-green` — add a "Co-located proof" review checklist + phantom-gate + superset correction

Add a new `## Review checklist (prove it in the same diff)` section:

- **Redaction-helper reuse** *(A2-a)* — before writing a new secret-redaction
  regex set, grep for the existing helper; if a second impl is truly needed, add a
  test proving both are equivalent on the same fixture. Seed: *"grep for
  `safeMessage`/`safeWorkerMessage`/`redactionValues` before hand-rolling a new
  redactor."* (Two independently-drifted redactors already exist across one worker
  boundary.)
- **Security-boundary comment ⇒ security-boundary test** *(A3-b)* — when a diff
  adds an option whose doc comment states a security property (e.g.
  `preserveMcpServersUnderOverride`: "an arbitrary caller cannot X"), require a
  co-located test asserting exactly that property before merge.
- **Snapshot-vs-dynamic drift ⇒ a test they can't disagree** *(A4-b)* — if a diff
  adds a `*Fallback*`/`*Cached*`/`*Snapshot*` value alongside an existing dynamic
  resolver of the same fact (e.g. `inferUniqueNotifyDestination`), add a test
  proving they can't diverge, or document why staleness is safe.
- **Error-taxonomy completeness for provider-shaped code** *(B3-c)* — when
  wrapping an external network call in a typed-error class, cover the
  timeout / `AbortError` / connection-refused paths, not just non-2xx and
  malformed-body.
- **`enabled` early-out ordering across config loaders** *(C5-a)* — for every
  field parsed in a `loadXConfig`, confirm it is parsed strictly *after* that
  function's own `if (!enabled) return` guard (or has a comment saying why it's
  exempt). The exact same bug shipped in both `telegram-adapter/config.ts` and
  `slack-adapter/config.ts`.
- **Live↔replay rendering parity** *(C4-a)* — when adding rendering for a new
  `runtime_telemetry`/stream-event kind, grep the sibling surface and add matching
  treatment (don't leave replay falling back to raw JSON). Seed:
  `grep -rn "session_boundary" packages/tui/src packages/session-web/webapp/src`
  (`turn-presenter.ts` ↔ `replay-detail.ts`; the step-kind switch in
  `session-web/webapp/src/views/DetailView.tsx`).
- **Webapp component smoke-render** *(C4-b)* — require at least a mount+assert test
  for any new top-level view component, not only its extracted pure helpers.
  `grep -rL "render(" packages/*/webapp/src/views/*.test.ts` finds pure-only
  coverage.

Add to `## Full gate` / `## Gotchas`:

- **Phantom gates** *(C2-a, E2-a)* — any `scripts/*.mjs` with real logic and an
  `isCli`/`main()` entry must be a *named* `pnpm run check:<name>` wired into
  `repoGate` in `scripts/verify-all.mjs`; a check that "works" only because a
  non-mocked test happens to call it (`verify-deep-imports.mjs`,
  `check-getting-started-version-pins.mjs` — both independently found) is invisible
  in `package.json` and fragile to test-glob refactors. Seed: `grep -L` every
  `scripts/*.mjs` with an `isCli` block against `package.json` + `verify-all.mjs`'s
  `repoGate` array; anything in neither is a phantom gate. Also note: "deep-imports
  ok" should still appear in `pnpm run test` output whenever `scripts:test`'s glob
  changes.
- **Correct the superset claim** *(E2-b)* — the current `SKILL.md:15-17`
  "one-shot equivalent" overstates overlap: `pnpm run verify:all` is **not** a
  strict superset of `.github/workflows/ci.yml` (missing
  `release:validate`/`release:pack`/`release:consumer`) and CI is **not** a strict
  superset of `verify:all` (missing `verify:consumers`). State both gaps.
- **DDL-migration guard** *(B3-a)* — before a `schema.ts` edit lands, diff it
  against the previous release tag and confirm no *existing* `CREATE TABLE` column
  list changed (only new statements appended), else a migration is required.
  Seed: `git diff <last-release-tag> -- packages/memory/src/store/schema.ts`.
- **gitleaks self-test (periodic, not every-PR)** *(E4-c)* — a scratch-repo test
  with synthetic Telegram/Slack/OpenAI-shaped tokens run against `.gitleaks.toml`,
  since a secret-scanning gate that silently no-ops is worse than an absent one.

### 2.2 `docs-sync` — README/index parity + registry-completeness + file-list widening

- **README "Public API" ↔ `src/index.ts` parity** *(C3-a, C6-a, B3-b)* — when a
  PR diff touches `packages/*/src/index.ts` (adds/removes an `export {…} from`),
  diff the touched package's README `## Public API` section too and flag any new
  export missing from it; as an occasional whole-package sweep, also confirm each
  README-listed symbol is imported by ≥1 other workspace package or carries an
  explicit deprecated/experimental label. Seed: extract backtick identifiers from
  the README's `## Public API` section and grep each against `dist/index.d.ts` or
  `src/index.ts`. (Caught the observability README drift, the `*FieldGroup`
  staleness in 3 READMEs, the missing `toCronJobs` bullet, and the dead memory
  search API.)
- **Rename ⇒ grep the old name across docs** *(C5-b)* — when a PR renames/removes
  an exported symbol, run `grep -rn '<old-name>' packages/*/README.md docs/`
  before closing the doc-sync pass (`telegramFieldGroup`/`slackFieldGroup` →
  `TELEGRAM_CONFIG_FIELDS`/`SLACK_CONFIG_FIELDS` left the README samples stale).
- **Behavior-prose drift on a new opt-in mode** *(C6-b)* — when a PR adds a new
  opt-in mode/enum, grep the package README prose for a stale absolute claim
  ("does not … X", "always Y, never Z") the new code just falsified. Real case:
  cron-adapter README line 87 "does not … queue overlapping jobs" vs. the new
  `overlap:"queue"`.
- **Cross-cutting operator tables** *(A5-a)* — when a PR introduces a new durable
  store, check any table/matrix that enumerates "what does X reset/purge/survive"
  (not just prose), by grepping the feature's new root/store name across
  `docs/**/*.md`. `docs/runtime/sessions-concurrency.md`'s boundary-rules table
  went silent on v0.11.0 durable conversation-history.
- **`config-reference.ts` ⇒ `feature-registry.md` row + prose page** *(E1-a)* — if
  a PR touches `packages/agent-app/src/config-reference.ts`, grep the new
  `jsonPath` against `docs/reference/feature-registry.md` and its prose page before
  calling the PR doc-complete. Exact command that would have caught F2/F3:
  ```bash
  comm -23 \
    <(grep -oE '"[a-z]+\.[a-zA-Z]+"' packages/agent-app/src/config-reference.ts | sort -u) \
    <(grep -oE '`[a-z]+\.[a-zA-Z]+`' docs/reference/feature-registry.md | tr -d '`' | sort -u)
  ```
- **Widen the file list to seed templates** *(C7-a)* — a docs-sync pass keyed only
  on `docs/` misses copy-paste templates that actively break a fresh agent when
  stale. Add `demos/*/IDENTITY.example.md`, `demos/*/SOUL.example.md`, and any
  other `*.example.md` seed files to the checklist whenever a memory/tool-surface
  PR lands.
- **Include the composer skill's references** *(G1-b)* — fold
  `packages/agent-app/skills/mono-agent-composer/references/*.md` into the "after
  any user-facing feature lands" doc-sync checklist; it silently drifted out of
  the loop for ≥3 PRs (native-notify #98, per-trigger-model-effort,
  external-memory-backends #52) and, because `SKILL.md` tells composing agents
  never to read `feature-registry.md` or package source, it is the single point of
  failure for "does the framework support X."
- **Website blind spots (backlog notes)** — *(E1-b)* add an orphaned-Starlight-
  asides check to the `website` CI remit; `check-links.mjs`'s doc comment claims a
  broader anti-rot mandate than it delivers, so treat it as a known blind spot.
  *(E1-c)* playbook `ts` code blocks aren't type-checked against the packages they
  demo (F5 slipped through); a lightweight `tsc --noEmit` over fenced `ts` blocks
  in `docs/playbooks/**` + `docs/programmatic/**` is a follow-up.

### 2.3 `new-package` — channel/adapter + lock + doctor + parity checklist items

- **Adapter-neutrality: grep the ENTIRE core surface** *(C1-a)* — the existing
  mechanical guard's scope (one package) and banned-word list (two literals) never
  grew as channels were added. Adding any channel/adapter must run a standing check
  of both `packages/agent-contracts/src` **and** `packages/agent-harness/src` for
  hardcoded references to any shipped `ChannelId`, sourced from the channel catalog
  rather than fixed literals:
  ```bash
  grep -riE "\b(telegram|whatsapp|slack|discord)\b" \
    packages/agent-contracts/src packages/agent-harness/src --include=*.ts | grep -v __tests__
  ```
- **Interactive-channel harness classification** *(C1-b)* — if a new channel
  produces interactive (human-attended) conversations, confirm the harness's
  per-turn model-facing framing (`sessionContextBlock` and any sibling logic keyed
  off conversationId shape) recognizes it; do not assume a hardcoded string-prefix
  allowlist elsewhere already covers it.
- **Singleton-lock convention** *(A3-a)* — checklist prompt "do you need a
  singleton lock?"; if so, reuse the shared mkdir/owner.json/incarnation/quarantine
  helper instead of re-deriving it (four current copies — worker lease, CLI
  lifecycle lock, managed-runtime install lock, SRT install lock — all already
  share `process-incarnation.ts` as their liveness primitive; only the
  directory/rename choreography is duplicated).
- **New runtime-resolution surface ⇒ doctor line** *(A2-b)* — if you add a new
  place mono-agent decides "which physical package/closure is this" at runtime
  (like `managed-runtime-packages.ts`'s app-vs-cwd resolution), add a
  `doctor`/`validate` detail line naming what was resolved and from where.
- **Sibling test-shape parity** *(C6-c)* — when a package has two
  structurally-parallel sub-modules (operator-adapter's `tui/` and `live/`), diff
  their `__tests__/` directory listings and flag any missing counterpart file
  (`live/` was missing the `config.test.ts` that `tui/` has, so `live/config.ts`'s
  secret-redaction path went untested).
- **MCP stateless-HTTP cleanup ordering** *(D1-a)* — for the ladder's rung-4 MCP
  servers/tools using `@modelcontextprotocol/sdk`, register
  `res.on('close', …)` **before** calling `handleRequest`, not after (the SDK
  examples show this order; `agent-orchestrator` got it backwards).
- **`demos/` without a `package.json` is expected** *(C7-b)* — a directory under
  `demos/` with no `package.json` is by design; check its own README before
  flagging it as dead/incomplete (`demos/final-agent`).

### 2.4 `release-lockstep` — attestation + version-derivation + pin/const guards

- **Supply-chain attestation** *(E4-a)* — call out `npm publish --provenance` (or
  trusted publishing) as a required step; nothing in the skill or release scripts
  mentions attestation today, so releases ship unattested. Seed:
  `npm publish <tarball> --access <access> --tag <tag> --provenance`.
- **Root devDependency pins** *(E2-d)* — spot-check the root `package.json`'s own
  `@mono-agent/*` devDependency pins against the target version during a release;
  `validateRelease` does not check this (issue #228).
- **Stale hardcoded `_VERSION` literals** *(C4-c)* — during the version-bump step,
  grep for hand-authored `_VERSION`/`_PACKAGE_VERSION` string literals across
  packages (or replace them with a build-time substitution from `package.json`);
  `TUI_PACKAGE_VERSION` drifted 11 minor versions.
- **Deprecation aliases carry a removal version** *(A1-b)* — when introducing a
  deprecation alias/flag (`--recipe`, `--fallback-models`, `LEGACY_TOOL_ALIASES`
  each shipped with a message but no sunset), record a target removal version/date
  in the same commit.
- **Single version-derivation point for downstream consumers** *(F2-c)* — when
  documenting how downstream fleets track lockstep releases, recommend deriving the
  expected `@mono-agent` version at runtime from the consumer's own `package.json`
  rather than literal-string duplication (one live instance hardcodes the release
  string in 6 separate files).

### 2.5 `fleet-deploy` — verify-the-automation + validate-after-write

- **Re-verify the nightly job actually exists** *(E2-c)* — `SKILL.md:153-155`
  documents "the installed nightly job" as fact; whenever the skill is invoked,
  re-verify it against `launchctl list` on the real host rather than trusting the
  doc — this documented-but-not-installed drift is exactly what the amendment
  should force a check for.
- **Credential rotation: validate-after-write, not validate-at-next-start**
  *(F2-b)* — immediately after writing any owner-only env file (`.brain.env` etc.),
  re-read it back and re-run the exact validation the consuming service performs,
  failing the rotation command itself rather than deferring discovery to the next
  process start. The generators are correct (`randomBytes(32)` / `openssl rand -hex
  32` = 64 hex chars) yet a sub-32-char token still reached `.brain.env` and
  crash-looped the service — the file was edited/rotated outside the generator once.

### 2.6 `worktree-feature` — durable-state + post-merge cleanup in "Ship"

- **New durable-state checklist** *(A5-b)* — add to the Ship checklist: "if this PR
  adds a new on-disk store under `.mono-agent/`, does an existing purge/reset/clear
  surface (CLI command, docs boundary table, `doctor` status) need to cover it
  too?" (session history, continuation ledger, memory index, …).
- **Post-merge cleanup step** *(E3-a, per-feature half)* — fold a mandatory cleanup
  into "Ship": on `gh pr merge` confirmation → `git worktree remove <path>` →
  `git branch -d <branch>`. (The periodic *bulk* sweep and the
  `delete_branch_on_merge` repo setting live in the new `repo-hygiene-gc` skill,
  §1.2.)

### 2.7 `pi-upstream-recon` — generalize native-first + vendoring guards

- **Prefer native provider capability, generalized beyond pi** *(B1-a)* — before
  hand-rolling output-shape recovery (JSON repair, etc.) for *any* provider
  integration, check that provider's native structured-output / JSON-mode first
  (the memory package hand-rolled `parseJsonLoose`/`parseJsonExact` instead of
  Ollama's `format: "json"`). Broaden the skill's native-first rule from "only pi"
  to any provider adapter.
- **License consistency across the vendoring boundary** *(C2-b)* — when
  auditing/porting a package designed to be vendored-as-source into a second host
  (agent-runtime → worklab), verify `package.json` `license` consistency across the
  boundary before treating a "wrap a GPL/AGPL kernel behind a differently-licensed
  facade" pattern as settled — each package is internally consistent even when the
  cross-boundary metadata is not.
- **Bleeding-edge pin guard** *(E4-b)* — when pinning a bleeding-edge dep (as
  `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude` does for pi /
  claude-agent-sdk), confirm `minimumReleaseAge` is actually configured, else the
  exclude is inert from the moment it's added: `pnpm config get minimumReleaseAge`
  must be nonzero before adding an exclude entry.

### 2.8 `live-smoke` — real worker-thread scenario

- **Spawn the readiness probe as a real Worker** *(A2-c)* — add at least one smoke
  scenario that spawns `readiness-probe-worker.js` as an actual
  `worker_threads.Worker` (not a synthetic replacement) against a local fake HTTP
  provider; the unit-test suite structurally cannot exercise this file today.

---

## 3. NOT SKILL-WORTHY

Better served by a code fix, a CI check, or a one-off action. Each routes to the
audit **actions table** (or the noted destination) rather than a skill.

- **B1-c** — `tsconfig.base.json` has no `noUnusedLocals`/`noUnusedParameters` and
  there's no repo-root ESLint config, so a fully-dead private function
  (`compareLocated`) shipped. A config/CI flip, not a skill; flag as a tracked
  follow-up (surfacing many pre-existing violations is expected). → **actions table
  / code change.**
- **C3-b** — the C3 redaction and crash-event-loss findings (F1/F2) are one-off
  engineering follow-ups, not a repeatable process gap. → **actions table (code
  fixes).**
- **C7-c** — `config-view-parity.test.ts`'s bidirectional regex-extract parity
  pattern is a *positive* convention worth reusing in any future "two surfaces must
  agree" package, not a gap. → **note only; no action.**
- **D1-b** — the D1 territory has no other recurring/process-shaped issue (the four
  packages are unusually careful). → **note only; no action.**
- **E3-b** — dev-tooling prose-vs-source drift (`release-lockstep` SKILL.md's
  hardcoded package counts; `agents/*.md` path claims vs `skills/*/SKILL.md`)
  wants an automated guard, not a skill: extend `check-codex-discoverability` or
  add `scripts/check-dev-tooling-consistency.mjs` to grep shared path/convention
  strings and fail on disagreement (the way `package-count-drift.test.mjs` already
  guards README/PACKAGES.md). → **actions table (new CI check).**
- **E3-c** — "epic Done-when corrections should edit the issue *body*, not just
  comment" is a goal-loop protocol amendment (edit `#119`'s DoD text via
  `gh issue edit` when a correction is recorded), outside the 8 engineering
  skills. → **actions table / goal-loop protocol.**
- **G1-a** — composer-skill freshness wants a mechanical CI tripwire: fail when
  `docs/reference/feature-registry.md` gains a `config`-coverage row whose key
  isn't grep-able anywhere under
  `packages/agent-app/skills/mono-agent-composer/references/`. The *scope-inclusion*
  half is a docs-sync amendment (§2.2, G1-b); the *tripwire* is a CI check. →
  **actions table (new CI check).**
- **F1-c** — "no new skill needed beyond amendments to the two above" is the F1
  auditor's own meta-conclusion; superseded here by the decision to give those
  checks one owner (`ops-log-hygiene`, §1.3). → **note only; no action.**
- **E2-c one-off tail** — beyond the `fleet-deploy` amendment (§2.5), actually
  re-installing/verifying the 7-day-window LaunchAgent on the host is a discrete
  action, not a skill. → **actions table (one-off: confirm/reinstall the nightly
  `fleet-green-check` LaunchAgent).**
- **B2-b sidecar-read as a fleet concern** — already absorbed into
  `dead-code-audit` §1.1 step 6; no separate action.

---

## Assignment index (every flag → exactly one home)

| Flag | Destination |
|---|---|
| A1-a | NEW dead-code-audit (§1.1) |
| A1-b | AMEND release-lockstep (§2.4) |
| A2-a | AMEND verify-green (§2.1) |
| A2-b | AMEND new-package (§2.3) |
| A2-c | AMEND live-smoke (§2.8) |
| A3-a | AMEND new-package (§2.3) |
| A3-b | AMEND verify-green (§2.1) |
| A4-a | NEW dead-code-audit (§1.1) |
| A4-b | AMEND verify-green (§2.1) |
| A5-a | AMEND docs-sync (§2.2) |
| A5-b | AMEND worktree-feature (§2.6) |
| A6-a | NEW dead-code-audit (§1.1) |
| A6-b | NEW dead-code-audit (§1.1) |
| B1-a | AMEND pi-upstream-recon (§2.7) |
| B1-b | NEW dead-code-audit (§1.1) |
| B1-c | NOT skill-worthy (§3) |
| B2-a | NEW dead-code-audit (§1.1) |
| B2-b | NEW dead-code-audit (§1.1) |
| B3-a | AMEND verify-green (§2.1) |
| B3-b | AMEND docs-sync (§2.2) |
| B3-c | AMEND verify-green (§2.1) |
| C1-a | AMEND new-package (§2.3) |
| C1-b | AMEND new-package (§2.3) |
| C2-a | AMEND verify-green (§2.1) |
| C2-b | AMEND pi-upstream-recon (§2.7) |
| C3-a | AMEND docs-sync (§2.2) |
| C3-b | NOT skill-worthy (§3) |
| C4-a | AMEND verify-green (§2.1) |
| C4-b | AMEND verify-green (§2.1) |
| C4-c | AMEND release-lockstep (§2.4) |
| C5-a | AMEND verify-green (§2.1) |
| C5-b | AMEND docs-sync (§2.2) |
| C6-a | AMEND docs-sync (§2.2) |
| C6-b | AMEND docs-sync (§2.2) |
| C6-c | AMEND new-package (§2.3) |
| C7-a | AMEND docs-sync (§2.2) |
| C7-b | AMEND new-package (§2.3) |
| C7-c | NOT skill-worthy (§3) |
| D1-a | AMEND new-package (§2.3) |
| D1-b | NOT skill-worthy (§3) |
| E1-a | AMEND docs-sync (§2.2) |
| E1-b | AMEND docs-sync (§2.2) |
| E1-c | AMEND docs-sync (§2.2) |
| E2-a | AMEND verify-green (§2.1) |
| E2-b | AMEND verify-green (§2.1) |
| E2-c | AMEND fleet-deploy (§2.5) |
| E2-d | AMEND release-lockstep (§2.4) |
| E3-a | NEW repo-hygiene-gc (§1.2) + AMEND worktree-feature (§2.6) |
| E3-b | NOT skill-worthy (§3) |
| E3-c | NOT skill-worthy (§3) |
| E4-a | AMEND release-lockstep (§2.4) |
| E4-b | AMEND pi-upstream-recon (§2.7) |
| E4-c | AMEND verify-green (§2.1) |
| F1-a | NEW ops-log-hygiene (§1.3) |
| F1-b | NEW ops-log-hygiene (§1.3) |
| F1-c | NOT skill-worthy (§3) |
| F2-a | NEW ops-log-hygiene (§1.3) |
| F2-b | AMEND fleet-deploy (§2.5) |
| F2-c | AMEND release-lockstep (§2.4) |
| G1-a | NOT skill-worthy (§3) |
| G1-b | AMEND docs-sync (§2.2) |

**Totals:** 3 new skills · 39 amendment seed-entries (verify-green 11, docs-sync 8,
new-package 7, release-lockstep 5, pi-upstream-recon 3, fleet-deploy 2,
worktree-feature 2, live-smoke 1) · 10 not-skill-worthy. Several seed-entries
collapse multiple flags that are the same check hit by different auditors (e.g.
docs-sync's README↔index parity folds C3-a + C6-a + B3-b; verify-green's
phantom-gate folds C2-a + E2-a). E3-a lands in two homes (the new `repo-hygiene-gc`
skill for the bulk sweep + a `worktree-feature` amendment for the per-feature step)
and is counted once in the index.

**actionCount = 3 + 39 = 42** discrete work items.
