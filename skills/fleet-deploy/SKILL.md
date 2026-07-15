---
name: fleet-deploy
description: Deploy repo changes to the live launchd mono-agent fleet and restart/verify every current instance. Use when asked to "deploy", "restart the agents", "get this live", or after merging changes the fleet should run.
---

# Fleet deploy

The fleet's deploy checkout is a **normal (non-bare) checkout of `main`** that is
frozen for deployment use: update the tree, rebuild in place, and restart every
instance there, but do all development in isolated worktrees (see
`worktree-feature`). Never edit, test feature branches, commit, or stash WIP in
the deploy checkout.

## Fleet map

The daily tracker and the installed `com.mono-agent.*` launchd plists are the
authoritative fleet map; do not restrict a deploy to the two historically
documented instances. The current mono-agent fleet is exactly four active,
running agents: `finances`, `inner-child`, `personal-agent`, and `transcription`.
The separately managed `~/a8c-agents` services use their own launchd namespace
and status command; do not silently mix stopped A8C services into this gate. A missing PID,
an extra matching plist, or any row that cannot be reconciled is a fleet blocker.

Run the exact host gate under "Daily green check" before changing anything and
again after deployment. Reconcile every expected row; a missing, extra, stale,
or invalid plist is a fleet blocker, not an instance to omit from the report.

| Instance | Config / label | Notes |
|---|---|---|
| `~/personal/finances` | `mono-agent.config.json` / `com.mono-agent.finances-e9c073d7` | Telegram, webhook, bujo memory |
| `~/agents/inner-child` | `mono-agent.config.json` / `com.mono-agent.inner-child-fdfc3392` | Telegram, webhook, cron, native sandbox, bujo memory |
| `~/agents/transcription` | `mono-agent.config.json` / `com.mono-agent.transcription-f4a742c8` | Telegram, no configured memory |
| `~/personal-agent` | `mono-agent.config.json` / `com.mono-agent.personal-agent-059657c8` | Telegram, webhook, OpenAI API :4312/v1, cron, bujo memory, restart last |

**Deploy mechanism:** the source CLI verifies and copies its exact package closure
into an owner-private managed runtime under `~/.mono-agent/runtimes`, and the
canonical hardened plists execute that copied CLI through `/usr/bin/env -i`.
**Building this repo and restarting every instance IS deploying.** A successful root `pnpm run build`
also atomically publishes the ignored, owner-only `.mono-agent-build.json`
completion marker on supported POSIX/macOS deploy hosts. The marker binds that
build to the full checkout SHA, source state, Node version, modules ABI,
completion instant, a deterministic digest of every deploy output, and a
separate digest of the installed root/workspace dependency topology, modes, and bytes
(including native addons). The
wrapper holds the exclusive `.mono-agent-build.lock` from before it clears the
old marker through output sync and marker publication. A failed, interrupted, or
overlapping build therefore cannot leave stale dist certified. Running instances
keep old in-memory code until restarted.

## Standard deploy (main = normal checkout)

Run from the fleet checkout (`cd "$(git rev-parse --show-toplevel)"`), working
tree clean. Do steps 1–4 in one uninterrupted pass:

```bash
git fetch origin main && git reset --hard <sha>   # 1. or: git pull --ff-only; tree MUST be clean first
pnpm install --frozen-lockfile                     # 2.
pnpm run build                                     # 3. builds dist, finalizes executable modes, then publishes the marker
# 4. rolling restart: finances, inner-child, transcription, personal-agent LAST
```

**Never leave the tree between install and restart.** `pnpm install` rewrites
`node_modules` symlinks, so the old dist the running instances still exec can
break the moment step 2 lands — rebuild (3) and restart (4) before walking away.
Do not replace step 3 with `pnpm -r --sort run build`: that command is useful for
a development-worktree dist baseline, but it deliberately does not publish the
root deployment marker.

If `.mono-agent-build.lock` remains after a crashed build, first prove that no
root build is active. Only then remove the stale lock and rerun the complete root
build. Never remove an active or uncertain lock to make the fleet check pass.

## Main has WIP (stop — never stash)

A detached-worktree build copied into a different checkout cannot honestly bind
the resulting dist to that checkout's HEAD. The loaded-code gate therefore
rejects the old rsync fallback. Preserve the WIP, finish or move it through the
ordinary worktree workflow, and deploy only from a clean main checkout. Do not
stash, copy a marker, fabricate its timestamp, or bypass the `loaded` failure.

## Restart + verify

Roll all four instances one at a time, **personal-agent last**. Every instance
must be running at the end. Discover each working
directory and label from its plist/tracker row instead of guessing; after the
first three instances, finish with:

```bash
cd ~/personal/finances && mono-agent restart
cd ~/agents/inner-child && mono-agent restart
cd ~/agents/transcription && mono-agent restart
cd ~/personal-agent && mono-agent restart 2>&1 | tail -25
cd ~/personal-agent && mono-agent validate 2>&1 | tail -45
mono-agent status
mono-agent logs --lines 30
```

`mono-agent restart` reuses the same service label (hash of the absolute config
path) — no duplicates. When pasting status/validate output anywhere, sanitize
tokens first:

```bash
mono-agent status 2>&1 | sed -E 's/[0-9]{6,}:[A-Za-z0-9_-]{20,}/<BOT_TOKEN>/g'
```

## Daily green check

`scripts/fleet-green-check.mjs` is the read-only daily tracker for the v1 7-day
window (#168 → #119). It discovers the launchd instances, requires a running PID
for every service, checks loaded-code provenance, exact launchd Node
version/modules ABI, deployed `validate --json`, strict memory health, and
last-24h run health, then prints
`instance | service | loaded | runtime | validate | memory | runs-24h | notes`
plus `VERDICT: GREEN|RED`. Run the authoritative gate from the deployed checkout
(or an exact checkout that implements the same build-marker schema). Runtime
and CLI probes use each hardened plist's exact worker Node and copied cli.js,
never the ambient shell's `node` or the checker's CLI. Pin the deploy source
tree with `--repo`; the checker then proves the canonical private runtime path,
v4 marker/manifest, complete cached execution closure, and unchanged install-time
filesystem proof for package entries, links, and resolution-path directories inside the private install
root against that exact checkout, including config-selected plugins; canonical ancestors above it must
remain owner-private. The running process must start after the conservative finalized-runtime boundary.
The build-provenance probe belongs to the checker checkout, so a newer
checker intentionally fails closed on an older marker schema instead of
claiming cross-version proof:

```bash
DEPLOY_REPO=/Users/example/Personal_Repositories/mono-agent
FLEET_LABELS='com.mono-agent.finances-e9c073d7,com.mono-agent.inner-child-fdfc3392,com.mono-agent.personal-agent-059657c8,com.mono-agent.transcription-f4a742c8'

# Exact host gate: print only.
node scripts/fleet-green-check.mjs --dry-run \
  --repo "$DEPLOY_REPO" \
  --expect-labels "$FLEET_LABELS" \
  --expect-sha <full-sha> --expect-node 24.15.0 --expect-abi 137

# Exact host gate: also post to #119.
node scripts/fleet-green-check.mjs \
  --repo "$DEPLOY_REPO" \
  --expect-labels "$FLEET_LABELS" \
  --expect-sha <full-sha> --expect-node 24.15.0 --expect-abi 137

# Generic discovery is useful for diagnosis, but does not pin this host's topology.
node scripts/fleet-green-check.mjs --dry-run

# Deliberate missing-label simulation; never break a live instance.
node scripts/fleet-green-check.mjs --labels com.mono-agent.bogus  # simulate RED (never break a live instance)
```

The expected runtime defaults are Node `24.15.0` and modules ABI `137`; keep
them explicit in deploy evidence and update them deliberately during a fleet
runtime migration. Generic auto-discovery checks every matching plist it finds;
it cannot prove that a removed plist still belongs to the fleet. The nightly
`fleet-green-check` job — *if it is actually installed*, which this skill has
before wrongly assumed as fact (re-verify it against `launchctl list`; see
Gotchas) — and all deployment evidence therefore use `--expect-labels` with the
exact four-label set above. Missing or extra labels drive RED before any row can
be treated as healthy. `--expect-sha` accepts a full SHA and applies it
independently to every instance; multiple deploy checkouts do not weaken that
requirement.

Canonical managed plists use control-free, structurally compared
`ProgramArguments`, an allowlisted `/usr/bin/env -i` wrapper, absolute
executable/config paths, and a label derived from that exact config path.
Discovery converts
them with `/usr/bin/plutil` and checks service state with `/bin/launchctl`, both
under a closed system environment instead of the interactive `PATH`. For every
PID, `loaded` requires launchd's loaded structured arguments and log paths plus
the running Node executable and cwd to match that canonical plist contract
exactly, an absent build lock, and an exact owner-only build marker.
The checkout must be clean and remain on the same full SHA across both reads;
the marker SHA must equal that SHA and the expected SHA, its Node/ABI must equal
the running runtime, and its recorded output and dependency digests must equal
fresh digests of the current deploy outputs and installed dependency tree. The
process must start after build completion. The checker repeats the marker,
digests, and checkout-state probes, revalidates the exact selected plist
fingerprint, then performs one global final launchd PID/state pass only after
every expensive fleet row has finished. A concurrent build, output/dependency
mutation, persisted-plist replacement, checkout change, or early-row PID restart
fails closed instead of blessing either side of the race. The memory
probe is `memory audit --strict --json`.
`healthy` passes, `in_progress` warns without making the verdict red,
`not_configured` skips, and `degraded`, `unhealthy`, `unknown`, malformed JSON,
or a status/exit mismatch drive RED. Exit `1` is still parsed because it is the
strict command's valid degraded/unhealthy/unknown result, not an excuse to drop
the structured report.

Its only write is the `gh issue comment 119`; it never restarts or reconfigures
an instance. No comment on a given day = not a green day (the counter resets).
Runs-24h tolerates only a transient `provider_unavailable` failover (#136's
healthy-failover evidence); every other failure kind, an unclassified failure,
or a tolerated kind that dominates the window (all runs failed, or >50% over
>=5 runs) drives RED. `--strict-runs` fails on any failed run; `--min-runs <n>`
fails a too-quiet instance; zero runs shows a non-RED `idle?` warning. A
prefix-matching `.plist` that fails conversion is a RED row, never a silent drop.
Probe stderr, provider/native errors, paths from memory results, payloads, and
arbitrary JSON fields are never copied into the report; fleet output is limited
to closed health states and aggregate run counts. Build/provenance failures use
the same closed diagnostics and never print marker bytes, absolute paths,
commands, working directories, or timestamps. Multi-checkout diagnostics report
only the number of deploy checkouts, never their locations.

Dates and the 24h window are **UTC-anchored** (the verdict date is `toISOString`
UTC). The 7-day counter is audited from these dates, so run the check at a
consistent local time each day to avoid a UTC day-boundary splitting one run
across two dated comments (or two runs landing on one date).

## Gotchas

- **Zombie service after config rename:** the label keys off the abs config path;
  renaming a config spawns a duplicate. Fix:

```bash
launchctl bootout gui/$(id -u)/<label>
rm ~/Library/LaunchAgents/<label>.plist
```

- Orchestrator fallback `pi:opencode-go:glm-5.2` has no creds in
  `~/.pi/a8c-agent/auth.json` — validate warns; pre-existing, not your bug.
- The Session Web app (`mono-agent web`, :4599) runs separately from the agent
  launchd fleet, so restarting agents does not restart it. A wildcard bind is
  directly reachable over private LAN/Tailscale HTTP without Tailscale Serve.
  Serve is optional only when HTTPS and installable/offline PWA behavior are
  wanted. Moving agents onto the `live` channel is a separate config step.
- Deploy = build + restart. Verify the restart actually picked up your change
  (e.g. a log line or behavior probe), not just that the service came back.
- macOS process start evidence has one-second resolution. If a restart happens
  in the exact second the marker is published, the strict comparison may report
  `process predates build`; restart that instance once more after the clock has
  advanced rather than weakening or editing the marker.
- **Re-verify the nightly green-check job is actually installed — don't trust
  this doc.** "Daily green check" describes a job that runs nightly, but that
  claim has drifted *documented-but-not-installed*. Confirm the LaunchAgent is
  loaded on the real host before assuming the 7-day counter is advancing:

```bash
launchctl list | grep -i fleet-green   # a matching row => loaded; empty => NOT installed
```

  Empty output means the counter is silently frozen (no `gh issue comment 119`,
  so those days never count). Reinstall/verify the job, then treat green days
  from there.
- **Credential rotation is validate-after-write, not validate-at-next-start.**
  Immediately after writing any owner-only env file (`.brain.env`, per-service
  secrets), re-read it and re-run the exact check the consuming service performs
  (e.g. token length ≥ its minimum), failing the rotation command itself on a bad
  value. The generators are correct (`openssl rand -hex 32` /
  `randomBytes(32).toString("hex")` = 64 hex chars), yet a sub-32-char token once
  reached `.brain.env` — hand-edited outside the generator — and crash-looped the
  service. Do not defer discovery to the next process start:

```bash
# after writing .brain.env, before walking away — re-read and re-validate the rotated value:
val=$(grep -E '^<SECRET_VAR>=' .brain.env | cut -d= -f2-)
[ "${#val}" -ge 32 ] || { echo "rotated secret too short: ${#val} chars — rotation FAILED"; false; }
```

- **Package layout is 17 directories under `packages/` (16 core + the
  `create-mono-agent` alias) and four publishable plugin extras under `extras/`.** After a
  consolidation deploy, retired packages leave behind their git-ignored `dist/`
  once their source is gone — remove those leftover dirs so nothing stale stays
  loadable, and verify the entry point still comes up
  (`node packages/agent-app/dist/cli.js --help`).
