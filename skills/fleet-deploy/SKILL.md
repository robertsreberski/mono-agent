---
name: fleet-deploy
description: Deploy repo changes to the live launchd mono-agent fleet (~/personal-agent, ~/a8c-agents/orchestrator) and restart/verify them. Use when asked to "deploy", "restart the agents", "get this live", or after merging changes the fleet should run.
---

# Fleet deploy

The fleet's deploy checkout is a **normal (non-bare) checkout of `main`** again —
deploy = update the tree, rebuild in place, restart each instance (see "Standard
deploy"). History: it was frozen as a bare tree through waves 0–1 and restored to
a normal checkout on 2026-07-06 (#148).

## Fleet map

| Instance | Config / label | Notes |
|---|---|---|
| `~/personal-agent` | `mono-agent.config.json` / `com.mono-agent.personal-agent-059657c8` | Telegram (allowlist 183676192), webhook, OpenAI API :4312/v1, 4 cron jobs, bujo memory, piAuthPath `~/.pi/personal-agent/auth.json` |
| `~/a8c-agents/orchestrator` | `mono-agent.config.json` / `com.mono-agent.orchestrator-2146e3d3` | Slack Socket Mode, OpenAI API :4311/v1, journal memory, piAuthPath `~/.pi/a8c-agent/auth.json`, working dir `.a8c-agent/` (NOT `.mono-agent/`) |

**Deploy mechanism:** both plists hardcode `node <this repo>/packages/agent-app/dist/cli.js …`,
and the global `mono-agent` CLI is an npm-global symlink to the same package.
**Building this repo's dist IS deploying.** Running instances keep old in-memory
code until restarted.

## Standard deploy (main = normal checkout)

Run from the fleet checkout (`cd "$(git rev-parse --show-toplevel)"`), working
tree clean. Do steps 1–5 in one uninterrupted pass:

```bash
git fetch origin main && git reset --hard <sha>   # 1. or: git pull --ff-only; tree MUST be clean first
pnpm install --frozen-lockfile                     # 2.
pnpm run build                                     # 3.
chmod +x packages/agent-app/dist/cli.js \
         packages/tui/dist/bin/mono-agent-tui.js   # 4. tsc output isn't executable; the mono-agent symlink needs it
# 5. rolling restart, orchestrator FIRST, personal-agent LAST (see "Restart + verify")
```

**Never leave the tree between install and restart.** `pnpm install` rewrites
`node_modules` symlinks, so the old dist the running instances still exec can
break the moment step 2 lands — rebuild (3–4) and restart (5) before walking away.

## Deploy while main has WIP (fallback — never stash)

```bash
REPO=$(git rev-parse --show-toplevel)
git worktree add --detach /tmp/deploy-<sha> <commit>
cd /tmp/deploy-<sha> && pnpm install --frozen-lockfile && pnpm -r --sort run build
for pkg in <changed packages>; do
  rsync -a --delete /tmp/deploy-<sha>/packages/$pkg/dist/ \
    "$REPO/packages/$pkg/dist/"
done
chmod +x "$REPO/packages/agent-app/dist/cli.js" \
         "$REPO/packages/tui/dist/bin/mono-agent-tui.js"
git worktree remove /tmp/deploy-<sha>
```

- `--delete` matters: it drops files removed upstream (stale dist modules otherwise linger).
- `chmod +x` matters: tsc output isn't executable and `rsync -a` preserves that —
  the `mono-agent` symlink then fails with "permission denied" while the launchd
  `node …` execs keep working, which hides the breakage.

Use this only while the fleet checkout has uncommitted WIP; a clean tree uses
"Standard deploy" above.

## Restart + verify

Roll one instance at a time, **orchestrator first, personal-agent last**:

```bash
cd ~/a8c-agents/orchestrator && mono-agent restart   # or: npm run restart
cd ~/a8c-agents/orchestrator && mono-agent validate 2>&1 | tail -45
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
window (#168 → #119). It discovers the launchd instances, checks each one's
service (running pid or last exit 0), deployed-`validate`, and last-24h run
health, then prints a markdown table + `VERDICT: GREEN|RED`. Run it from any
checkout of this repo — it reads the deployed sha and `cli.js` from the plists,
not from the tree it runs in:

```bash
node scripts/fleet-green-check.mjs --dry-run                    # print only
node scripts/fleet-green-check.mjs                              # also posts to #119
node scripts/fleet-green-check.mjs --expect-sha <sha>           # window mode: fail on drift
node scripts/fleet-green-check.mjs --labels com.mono-agent.bogus  # simulate RED (never break a live instance)
```

Its only write is the `gh issue comment 119`; it never restarts or reconfigures
an instance. No comment on a given day = not a green day (the counter resets).
Runs-24h tolerates only a transient `provider_unavailable` failover (#136's
healthy-failover evidence); every other failure kind, an unclassified failure,
or a tolerated kind that dominates the window (all runs failed, or >50% over
>=5 runs) drives RED. `--strict-runs` fails on any failed run; `--min-runs <n>`
fails a too-quiet instance; zero runs shows a non-RED `idle?` warning. A
prefix-matching `.plist` that fails conversion is a RED row, never a silent drop.

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
- The session-web app (`mono-agent web`, :4599 behind `tailscale serve`) runs
  backgrounded, NOT via launchd — restarting agents does not restart it, and
  moving agents onto the `live` channel is a separate config step.
- Deploy = build + restart. Verify the restart actually picked up your change
  (e.g. a log line or behavior probe), not just that the service came back.
- **Package layout is 17 packages + `extras/`** (post-consolidation). After a
  consolidation deploy, retired packages leave behind their git-ignored `dist/`
  once their source is gone — remove those leftover dirs so nothing stale stays
  loadable, and verify the entry point still comes up
  (`node packages/agent-app/dist/cli.js --help`). The WIP fallback achieves the
  same with `rsync -a --delete` per surviving package.
