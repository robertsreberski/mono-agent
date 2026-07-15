---
name: ops-log-hygiene
description: Keep the live fleet's logs bounded and catch crash-loops / restart-churn. Use for live-fleet log health, after any deploy or restart, when asked to "check the agents' logs", "rotate logs", "are they crash-looping?", or "are the agents healthy".
---

# Ops log hygiene

This is the standing "are the live agents' logs healthy?" discipline. It is
distinct from `fleet-deploy` (deploy-time provenance: build marker, plist
reconciliation) and `live-smoke` (validates a *change* against throwaway dirs) —
neither of those ever looks at whether the running instances' logs are bounded or
whether a service is silently crash-looping. Run this after any deploy/restart and
periodically; a merely "loaded" service can be crash-looping or drowning in an
unrotated log while both other skills report green.

## Where the logs live

Two log conventions coexist in the current fleet; discover the exact path from
each plist, never assume:

- The `com.mono-agent.*` launchd instances write to
  `~/.mono-agent/logs/<label>.{out,err}.log` (`StandardOutPath` /
  `StandardErrorPath`). The four fleet instances give four label-named out/err
  pairs, plus any operator-rolled `.log.1` sidecar.
- The separately-managed `~/a8c-agents` fleet writes to
  `~/Library/Logs/a8c-agents/<service>.log` (9 services) — a different namespace.

```bash
plutil -p ~/Library/LaunchAgents/<label>.plist | grep -E 'Standard(Out|Error)Path'
```

## 1. Log-size caps every deploy

Nothing in `mono-agent`/`agent-app` caps or rotates the launchd
`StandardOutPath`/`StandardErrorPath`. personal-agent's unrotated err log silently
grew to **1.23 GB** (`~/.mono-agent/logs/com.mono-agent.personal-agent-059657c8.err.log.1`
= 1,233,420,489 bytes, three weeks `2026-06-15`→`2026-07-06`) before anyone
noticed. On every deploy, size each instance's log paths against a cap and fail
the deploy above it:

```bash
# Per instance: size out+err logs AND any operator-rolled .1 sidecar against a cap.
for f in ~/.mono-agent/logs/*.log ~/.mono-agent/logs/*.log.1; do
  [ -f "$f" ] || continue
  bytes=$(stat -f%z "$f")
  (( bytes > 100*1024*1024 )) && echo "OVER CAP: $f ($bytes bytes)"
done
```

Over the cap (~50–100 MB) ⇒ truncate/archive and wire real rotation
(newsyslog/logrotate, or a size probe in the watchdog that fails the deploy
check). The `.log.1` is the operator's hand-rolled rotation — it is **not**
auto-managed and is exactly the file that grew to 1.23 GB, so count it, don't
skip it.

**Same pass — pinned-snapshot wrapper verification.** Every CLI wrapper an
instance ships (`bin/mono-agent`, `bin/agent-watchdog`, `bin/session-web`, or
equivalents) must resolve the **pinned runtime snapshot** the live plist actually
execs, not a mutable monorepo checkout path. The live plist runs
`~/.mono-agent/runtimes/agent-app/<version>/darwin-arm64-abi-<abi>/…/node_modules/@mono-agent/agent-app/dist/cli.js`;
personal-agent's wrappers instead hardcoded
`…/Personal_Repositories/mono-agent/packages/agent-app/dist/cli.js`. This is a
pattern risk for **every** instance, because that same monorepo is under
continuous active development on the same machine — a routine `pnpm build` on a
WIP branch silently changes what the watchdog's `mono-agent memory audit --strict`
health check executes while the serving process keeps running the older pinned
snapshot: a false-green/false-red health read decoupled from what's actually live.

```bash
# The dist path the plist actually execs (look for the pinned .mono-agent/runtimes path):
plutil -p ~/Library/LaunchAgents/<label>.plist | grep cli.js
# Any shipped wrapper pointing at a monorepo-checkout dist is a provenance split:
grep -rnE "Personal_Repositories/mono-agent/packages/.*/dist/cli\.js" <instanceDir>/bin
# Each wrapper's --version must equal the plist's pinned snapshot version, not the checkout's:
<instanceDir>/bin/mono-agent --version
```

## 2. Post-restart crash-loop tail — FAIL the deploy, "loaded" is not "healthy"

Every launchd plist this fleet generates uses `KeepAlive=true` + a flat
`ThrottleInterval` (10 s) with no consecutive-failure counter, so a bad or
partially-rotated credential restarts the process indefinitely at a fixed cadence
rather than failing once, loudly, and staying down. brain-core crash-looped
**108 times** on 2026-07-13 — 108 identical
`A8C_BRAIN_ATTENTION_TOKEN must contain at least 32 characters.` lines
(`~/Library/Logs/a8c-agents/brain-core.log:45-152`, ~18 min minimum) — before a
human intervened. A crash-looping service still reads as "up" to `launchctl list`
and to `fleet-deploy`'s PID check.

After restarting/deploying any launchd-managed service, tail its log for N (e.g.
5) identical failure lines in a short window and **fail** the deploy rather than
declaring success once the process is merely "loaded":

```bash
tail -n 20 <service log> | sort | uniq -c | sort -rn | head -1
# top count over a small threshold AND the message looks like an error ⇒ deploy FAILED
```

Run this per instance after the rolling restart, before reporting green.

## 3. Channel-restart churn detection

`fleet-deploy`'s PID check and `live-smoke`'s throwaway-dir validation never see
chronic in-channel churn. personal-agent's Telegram channel logged **~4,500**
`getUpdates` timeout → 500 ms-backoff-restart cycles over ~5 weeks (~130/day),
each self-healing with `Telegram channel degraded; transport is recovering.` — a
chronic degradation of the instance's single interactive channel, invisible to the
operator and to the watchdog (which only checks process liveness), discoverable
only by grepping multi-hundred-MB logs.

Grep a bounded recent window for repeated degraded/restart pairs and threshold the
rate against the instance's baseline:

```bash
# Whole-log counts (bound the window in practice — these logs get large):
grep -c "channel degraded" <service log>
grep -c "scheduling restart" <service log>
# Tighter: the last hour only (macOS date):
grep "$(date -u -v-1H +%Y-%m-%dT%H)" <service log> | grep -c "channel degraded"
```

A rate materially above the instance's own baseline (personal-agent's ~130/day was
pathological and never surfaced) ⇒ open a finding: it's a chronic transport
degradation, not a one-off.

## Report format

Per instance, state the exact numbers: log-path sizes vs cap, wrapper provenance
(pinned snapshot vs monorepo checkout), crash-loop tail top-count, and
channel-churn rate. A size over cap, a wrapper resolving the monorepo checkout, a
crash-loop top-count over threshold, or an anomalous churn rate is each a fail —
name the instance and the number. Never paste raw log bytes, tokens, or absolute
paths into a shared report; sanitize tokens first the way `fleet-deploy` does
(`sed -E 's/[0-9]{6,}:[A-Za-z0-9_-]{20,}/<BOT_TOKEN>/g'`).
