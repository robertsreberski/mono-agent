---
title: "Set up with a coding agent"
description: "Let Claude Code, Codex, or another coding agent build and start a mono-agent for you with the bundled composer skill and the documentation MCP server."
sidebar:
  order: 3
---

If you already use a coding agent such as Claude Code or Codex, it can set up a mono-agent for you. You describe the agent you want; the coding agent writes `mono-agent.config.json` and `IDENTITY.md`, validates the folder, and starts it.

mono-agent ships the pieces for this in the CLI:

- **The `mono-agent-composer` skill.** Instructions that teach a coding agent the setup flow: ask what you want, check for a matching preset, scaffold, edit the config, run `mono-agent validate`, start the agent, and run a smoke test. It carries its own reference files for every config key.
- **The `mono-agent-docs` MCP server** (`@mono-agent/docs-mcp`). A read-only, offline search over the documentation for the same mono-agent version, so the coding agent looks things up instead of guessing.

`mono-agent install-skill` installs both. It is in the published `0.26.0` release, so this route works today. The skill's references always match the installed CLI version, so a 0.26.0 install knows nothing about features that are only in the current source, such as `mono-agent preflight` or the console Capabilities page.

## 1. Install the CLI yourself

Install the CLI as in [tutorial step 1](/getting-started/tutorial/#1-install-the-cli), activate the printed `PATH` line, and confirm it works:

```bash
mono-agent --version
```

Doing this yourself keeps the installer's output and any `PATH` change in your own shell. A coding agent can run the installer too, but the `export PATH=…` line it prints affects only the shell that runs it.

## 2. Install the composer skill and docs server

```bash
mono-agent install-skill
```

By default this targets both Claude Code and Codex. Use `--target claude` or `--target codex` for just one.

**You should see** one `installed` line per target, with the skill copied to `~/.claude/skills/mono-agent-composer` and/or `~/.agents/skills/mono-agent-composer`. Then you see a pairing line such as `claude:mono-agent-docs`, and a reminder to start a new session. The docs server is registered with each harness CLI (`claude`, `codex`) found on your `PATH`, pinned to your CLI's exact version.

**If it fails:**

| Message | What to do |
| --- | --- |
| `<target> CLI is unavailable; pair later with: <command>` | That harness CLI is not on your `PATH`. The skill was still installed; run the printed command after installing the harness. |
| `Cannot pair mono-agent-docs: none of the selected harness CLIs (…) are available on PATH.` | Install Claude Code or Codex first, or rerun with `--no-docs-mcp` to install only the skill. |
| `Cannot pair mono-agent-docs because npx is not available on PATH.` | The docs server runs through `npx` from your own Node.js. The private installer's Node is not on your `PATH`, so install Node.js and npm, or use `--no-docs-mcp`. |
| `Destination <path> already exists. Re-run with --force to overwrite.` | `install-skill` never overwrites an existing copy. Rerun with `--force` to replace it, for example after upgrading the CLI. |

[Documentation MCP companion](/tools/documentation-mcp/) covers manual registration, version matching, and diagnostics.

## 3. Ask the coding agent to build the agent

Make an empty folder, or open a folder that already holds the knowledge you want the agent to use, and start a **new** Claude Code or Codex session there so it loads the skill and the docs server. Then describe what you want. For example:

```text
Use the mono-agent-composer skill to set up a mono-agent in this folder.
I want a research assistant called "Research Companion" that uses
openai-codex:gpt-5.6-terra with a local Ollama fallback, Memory Lite,
and no external channels. Validate it, start it, and tell me how to open
the browser console.
```

The composer asks one question at a time for anything you left out. It scaffolds with the non-interactive form of `init` (for example `mono-agent init --preset <id> --yes`), edits the config, and then runs `mono-agent validate` until no section reports `[error]`. Last, it runs `mono-agent start` and a smoke test. It keeps existing `AGENTS.md`, `CLAUDE.md`, `README.md`, or `SOUL.md` files and references them from `IDENTITY.md` instead of copying them. Secrets go in `.env`, never in the config.

Things you still do yourself:

- **Provider sign-in.** Sign-in opens a browser and waits for you, so it is easiest to run it in your own terminal when the coding agent asks, for example `mono-agent auth login openai-codex`.
- **Review the tool access.** The composer is told to start narrow (no allowed tools and loopback-only networking until you opt in). Check `tools.allowedTools` and the `sandbox` block before you start relying on the agent.
- **Open the console.** Run `mono-agent web run --loopback` in your own terminal and continue with [tutorial step 4](/getting-started/tutorial/#4-start-the-console-and-send-a-first-message).

The non-interactive `init` the composer uses writes files only; it does not run the guided wizard's readiness proof. The proof that the agent works is `mono-agent validate` plus a real reply, in the smoke test or in the console.

## Other coding agents

`install-skill` registers the docs server only with the `claude` and `codex` CLIs, and copies the skill only into their skill folders. For another coding agent:

- Point it at the installed skill file, `~/.claude/skills/mono-agent-composer/SKILL.md` or `~/.agents/skills/mono-agent-composer/SKILL.md` (run `mono-agent install-skill --no-docs-mcp` first), and its `references/` folder.
- Register the docs server with that agent's MCP configuration as an `npx -y @mono-agent/docs-mcp@<your-mono-agent-version>` stdio server. [Manual registration](/tools/documentation-mcp/#manual-registration) shows the exact command and version lookup.
- Or point it at this documentation site, starting with the [tutorial](/getting-started/tutorial/) and the [config blueprint](/config/blueprint/).

Do not point a coding agent at the mono-agent repository's `AGENTS.md` to set up an agent. That file is for developing the framework itself. The composer skill specifically tells coding agents to use its references and the docs server rather than reading the framework source.

## Related

- [Tutorial: your first agent](/getting-started/tutorial/): the same setup by hand.
- [Selected skills](/context/skills/#installing-the-bundled-composer-skill): the composer skill and how skills work.
- [`install-skill` CLI reference](/observability/cli-reference/#install-skill): every flag.
