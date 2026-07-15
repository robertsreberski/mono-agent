# Engineering skills (for developing mono-agent itself)

These are **project-level engineering skills** for Claude Code / Codex sessions
working on this repository. They are loaded via the `.claude/skills` and
`.agents/skills` symlinks at the repo root.

Each skill also carries `agents/openai.yaml` metadata so Codex can show concise
UI labels, descriptions, and default prompts while keeping `SKILL.md` as the
agent-facing workflow.

They are **NOT runtime skills for mono-agent instances** — those live in each
agent's own folder (e.g. `~/personal-agent/skills/`) and are selected via
`context.selectedSkills` in `mono-agent.config.json`.

The content was mined from real development-session history (Claude Code +
Codex sessions on this repo, June–July 2026): command frequencies, exact
observed command forms, and the gotchas that repeatedly cost time (worktree
dist resolution, npm registry proxy, fleet-dist deploys, pi version behavior).
Three skills (`dead-code-audit`, `repo-hygiene-gc`, `ops-log-hygiene`) plus
amendments across all eight originals were derived from the 2026-07-15
v1-freeze audit (`audit/agent-workflow-improvements.md`), which codified the
recurring failure shapes the audit proved out.

| Skill | Use when |
|---|---|
| `verify-green` | Verifying any change — full CI-order gate or single-package loop |
| `worktree-feature` | Starting isolated feature work; PR from a worktree |
| `fleet-deploy` | Deploying/restarting the live launchd agents |
| `live-smoke` | Real end-to-end smoke: throwaway agent dir, tmux TUI, web curl |
| `release-lockstep` | Cutting a lockstep npm release |
| `docs-sync` | Updating docs/ + website; PR-range docs audits |
| `pi-upstream-recon` | Reading vendored pi source before building; pi bumps |
| `new-package` | Adding a package that passes `check:architecture` first try |
| `dead-code-audit` | Prove-or-remove sweeps: dead exports, orphaned wiring, deprecation removability |
| `repo-hygiene-gc` | Periodic branch/worktree GC + the post-merge cleanup protocol |
| `ops-log-hygiene` | Live-fleet log health: size caps, crash-loop tails, restart-churn detection |
