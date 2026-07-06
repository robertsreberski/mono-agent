---
name: fleet-deploy
description: Deploy repo changes to the live launchd mono-agent fleet (~/personal-agent, ~/a8c-agents/orchestrator) and restart/verify them. Use when asked to "deploy", "restart the agents", "get this live", or after merging changes the fleet should run.
---

# Fleet deploy

> **CURRENT STATE (2026-07-06):** the fleet's deploy checkout is FROZEN as a bare
> tree at `90b97a9d` (pre-wave-0) — it does NOT yet carry the #137 provider-auth
> failover fix. The catch-up deploy + unfreeze decision is tracked in **issue
> #148**. Until that resolves, deploy is NOT "build in place": use a detached
> worktree at the target sha → `pnpm install --frozen-lockfile` → full
> `pnpm -r --sort run build` → rsync each surviving package's `dist/` into the
> frozen tree → `chmod +x` entry points → restart per instance (the "Clean
> deploy while main has WIP" flow below is exactly this).

## Fleet map

| Instance | Config / label | Notes |
|---|---|---|
| `~/personal-agent` | `mono-agent.config.json` / `com.mono-agent.personal-agent-059657c8` | Telegram (allowlist 183676192), webhook, OpenAI API :4312/v1, 4 cron jobs, bujo memory, piAuthPath `~/.pi/personal-agent/auth.json` |
| `~/a8c-agents/orchestrator` | `mono-agent.config.json` / `com.mono-agent.orchestrator-2146e3d3` | Slack Socket Mode, OpenAI API :4311/v1, journal memory, piAuthPath `~/.pi/a8c-agent/auth.json`, working dir `.a8c-agent/` (NOT `.mono-agent/`) |

**Deploy mechanism:** both plists hardcode `node <this repo>/packages/agent-app/dist/cli.js …`,
and the global `mono-agent` CLI is an npm-global symlink to the same package.
**Building this repo's dist IS deploying.** Running instances keep old in-memory
code until restarted.

## Clean deploy while main has WIP (never stash)

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

If main is clean, a plain `pnpm -r --sort run build` in the main repo is the deploy.

## Restart + verify

```bash
cd ~/personal-agent && mono-agent restart 2>&1 | tail -25
cd ~/personal-agent && mono-agent validate 2>&1 | tail -45
mono-agent status
mono-agent logs --lines 30
cd ~/a8c-agents/orchestrator && mono-agent restart   # or: npm run restart
```

`mono-agent restart` reuses the same service label (hash of the absolute config
path) — no duplicates. When pasting status/validate output anywhere, sanitize
tokens first:

```bash
mono-agent status 2>&1 | sed -E 's/[0-9]{6,}:[A-Za-z0-9_-]{20,}/<BOT_TOKEN>/g'
```

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
- **Package layout changed (31 → 17 packages + `extras/`):** after deploying a
  post-consolidation build into the frozen tree, retired packages' stale `dist/`
  dirs linger there and can still be loaded. Verify the entry point actually
  loads (`node packages/agent-app/dist/cli.js --help`) and prefer
  `rsync -a --delete` per surviving package so removed modules are dropped.
