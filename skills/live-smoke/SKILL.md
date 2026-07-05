---
name: live-smoke
description: Live smoke-test mono-agent surfaces against real runtimes — throwaway agent dir (CLI/e2e), TUI via tmux, web PWA via curl. Use before merging runtime/adapter/TUI/web changes, or when asked to "smoke test", "test it live", "drive the TUI".
---

# Live smoke

Live smoke finds what unit tests can't (real-pi parallel-batch turn segmentation
and the atomic trace-source write race were both found only this way). Rules:
real models/providers only — fixtures are for tests, not smoke (AGENTS.md:
"Prefer real execution paths in verification"). Smoke runs **dist**, so rebuild
the touched packages first: `pnpm --filter @mono-agent/<pkg>... build`.

## A. Throwaway agent e2e (CLI-level)

```bash
MONO_AGENT_REPO=${MONO_AGENT_REPO:-$HOME/Personal_Repositories/mono-agent}
SMOKE=$(mktemp -d /tmp/mono-agent-smoke.XXXX) && cd "$SMOKE"
CLI="$MONO_AGENT_REPO/packages/agent-app/dist/cli.js"
node $CLI init --model claude:claude-sonnet-4-6 --fallback-models pi:ollama:gemma4:31b
# or hand-write a minimal IDENTITY.md + mono-agent.config.json with a real pi model
# (e.g. pi:openai-codex:gpt-5.5), sandbox {"mode":"native","network":{"mode":"none"}},
# console/webhook disabled unless under test.
node $CLI validate; echo "validate exit: $?"
echo "$SMOKE" > /tmp/mono-agent-smoke-dir

node $CLI start > start.log 2>&1 &
sleep 3 && head -20 start.log            # channel-up lines, error strings
ls .mono-agent/artifacts .mono-agent/trace-sources 2>/dev/null
sqlite3 .mono-agent/memory/memory.db '.tables'   # when memory is under test
```

Cleanup — ALWAYS:

```bash
pkill -f "agent-app/dist/cli.js start"; sleep 1
rm -rf "$(cat /tmp/mono-agent-smoke-dir)" /tmp/mono-agent-smoke-dir
```

## B. TUI smoke via tmux (the `tuismoke` pattern)

```bash
pnpm --filter @mono-agent/tui... build 2>&1 | tail -2
tmux kill-session -t tuismoke 2>/dev/null
tmux new-session -d -s tuismoke -x 140 -y 36 "node packages/tui/dist/bin/mono-agent-tui.js <args>"
sleep 2; tmux capture-pane -t tuismoke -p | grep -v '^$' | tail -20
tmux send-keys -t tuismoke Enter          # keys: Enter, Down, Up, Escape, F3; literal text: -l "text"
sleep 1; tmux capture-pane -t tuismoke -p | grep -v '^$' | sed -n '7,18p'
```

Poll until ready instead of long sleeps:

```bash
for i in $(seq 1 20); do out=$(tmux capture-pane -t tuismoke -p | grep -v '^$'); \
  echo "$out" | grep -q '<ready marker>' && break; sleep 1; done
```

Teardown:

```bash
tmux send-keys -t tuismoke Escape 2>/dev/null; tmux send-keys -t tuismoke C-c C-c 2>/dev/null
sleep 1; tmux kill-session -t tuismoke 2>/dev/null
```

## C. Web PWA smoke (session-web)

```bash
node packages/agent-app/dist/cli.js web --port 4599 --no-open &
for i in $(seq 1 25); do curl -fsS --max-time 3 http://127.0.0.1:4599/api/instances >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:4599/api/instances    # assert on the JSON body
# LAN variant: web --host 0.0.0.0 --port 4599 --allow-non-loopback --no-open
```

## Gotchas

- pi 0.80 reports provider failures as a terse "Connection error." — failover
  noise, not necessarily your bug. Check which model actually answered.
- Verify WHICH dist you're exercising (worktree vs main repo) before trusting results.
- Never touch `~/personal-agent` or `~/a8c-agents/*` for smoke — that's the live
  fleet (see `fleet-deploy`). All smoke lives in `/tmp` throwaway dirs and named
  tmux sessions, and gets cleaned up.
- Capture evidence (pane captures, log greps, curl bodies) and quote it in your
  report; a smoke claim without captured output doesn't count.
