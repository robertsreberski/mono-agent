# Engineering skills (for developing mono-agent itself)

These are **project-level engineering skills** for Claude Code / Codex sessions
working on this repository. They are loaded via the `.claude/skills` and
`.codex/skills` symlinks at the repo root.

They are **NOT runtime skills for mono-agent instances** — those live in each
agent's own folder (e.g. `~/personal-agent/skills/`) and are selected via
`context.selectedSkills` in `mono-agent.config.json`.

The content was mined from real development-session history (Claude Code +
Codex sessions on this repo, June–July 2026): command frequencies, exact
observed command forms, and the gotchas that repeatedly cost time (worktree
dist resolution, npm registry proxy, fleet-dist deploys, pi version behavior).

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
