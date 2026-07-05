# Engineering agent templates (for developing mono-agent itself)

These are **project-level subagent definitions** for Claude Code / Codex
sessions working on this repository. They are loaded via the `.claude/agents`
and `.codex/agents` symlinks at the repo root.

Each agent has two companion files with the same stem:

- `<name>.md` — Claude-style Markdown/YAML template.
- `<name>.toml` — Codex custom-agent config with `name`, `description`,
  `developer_instructions`, and `model_reasoning_effort`.

They are **NOT agent configs for mono-agent runtime instances** — live agents
are configured by `mono-agent.config.json` in their own folders (e.g.
`~/personal-agent`), not by these files.

The templates were designed from real development-session history (June–July
2026). The dominant observed workflow was adversarial review (thousands of
reviewer subagent sessions reading full files and diffing against merge-base),
followed by the single-package build/test/typecheck loop, worktree-isolated
feature work, live smoke testing, docs sync, and lockstep releases — each
template encodes the corresponding discipline.

| Agent | Role | Codex effort |
|---|---|---|
| `implementer` | Repo-disciplined feature/fix implementation (TDD, worktree, capability ladder) | high |
| `adversarial-reviewer` | Defect-hunting review loops until a clean round; read-only | high |
| `live-smoke-operator` | Drives throwaway-agent / tmux TUI / web curl smoke, reports with evidence | medium |
| `docs-curator` | Docs + website sync and PR-range audits | medium |
| `release-engineer` | Lockstep release preflight, tag, CI watch, post-verify | high |
