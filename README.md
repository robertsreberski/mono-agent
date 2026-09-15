# mono-agent

**Your agents. Your models. Your workspace.**

mono-agent turns a folder into an AI agent you work with in a persistent web workspace. Point it at a research folder and it plans, drafts, and summarizes; hand it a codebase and it reads code, edits files, runs commands, and explains what failed. One `mono-agent.config.json` defines the whole agent — model, tools, skills, memory, and channels — so what you configured is something you can read, review, version, and move instead of host glue you maintain.

The same agent can answer in the browser console, over Telegram or Slack, through a webhook or an OpenAI-compatible endpoint, or on a cron schedule, all from that one config file. Everything runs local-first: model requests go where you point them, credentials stay in a dotenv file or the provider's own auth store, and run artifacts stay on your machine. Tools are powerful and the defaults are open, so read [Safety and privacy](#safety-and-privacy) before you expose the agent to a network.

## Release status

These docs describe the current `main` source. The latest published npm release is `create-mono-agent@0.21.1` (published 2026-09-10), so a global npm install does not yet contain everything documented here: console projects and tags, durable background subagents, and subscription usage meters are source-only examples. [Release status](./docs/reference/release-status.md) lists the current gap and the source-build alternative.

## What you can do

- **Work in a codebase** — open a project folder as the agent workspace and ask it to fix a failing test, review a diff, trace a bug, or run and interpret commands. With the [native sandbox](./docs/tools/sandbox.md) enabled, tool subprocesses are confined to the roots you allow and network access is deny-by-default.
- **Research, write, and plan** — give it source material and a role, then have it draft, compare, summarize, and keep notes; optional [memory tiers](./docs/memory/index.md) carry what it learns into later conversations.
- **Keep the work organized** — conversations can be grouped into projects and tagged, and console project tools let the agent act on that workspace state instead of only replying. Source-only for now: see [Release status](./docs/reference/release-status.md).
- **Delegate sustained work** — durable subagent sessions keep working on longer tasks in the background and report back into the conversation, including questions they need you to answer. Source-only for now: see [Release status](./docs/reference/release-status.md).
- **Automate a routine** — schedule a recurring digest, accept requests on a [webhook](./docs/channels/webhook.md), publish an [OpenAI-compatible endpoint](./docs/channels/openai-api.md), or talk to the agent from [Telegram](./docs/channels/telegram.md) and [Slack](./docs/channels/slack.md).
- **Bring your own models** — route to subscription/API providers such as OpenAI Codex, Anthropic, GitHub Copilot, and OpenCode-Go, or run entirely local with Ollama or LM Studio. Fallback routes keep a turn alive when the primary provider fails.
- **Extend it as configuration** — add [skills](./docs/context/skills.md), [MCP servers](./docs/tools/mcp.md), [tool policy](./docs/tools/policy.md), and preset-seeded capability modules without writing a host.

```json
{
  "runtime": { "model": "openai-codex:gpt-5.6-terra", "workspace": "." },
  "context": { "identityPath": "./IDENTITY.md" },
  "telegram": { "enabled": true }
}
```

## Quickstart: An Agent Folder From One Config File

Any folder — empty or already holding knowledge (`AGENTS.md`, `CLAUDE.md`, docs) — can become a running agent from one `mono-agent.config.json`. You need Node.js 24.15.0 or newer and credentials for the model you choose; a local provider such as Ollama works too.

Guided setup is authentic and not instant: it signs you in to the provider you choose and makes one real model request for every selected route to prove the route answers. That can take several minutes and counts as usage on your account. Running with flags, `--yes`, or without a TTY skips all of it and writes the scaffold only; add `--auth` if you want provider setup on that automated path too. [Setup details](#setup-details) list the exact deadlines, flags, and files.

### 1. Install the CLI

```bash
npm i -g create-mono-agent
```

`create-mono-agent` puts the natural `mono-agent` command on your `PATH`. It needs Node.js 24.15.0 or newer and no pnpm. Prefer a one-shot scaffold or a pinned install? [Install & prerequisites](./docs/getting-started/install.md) covers `npm create`, `npm exec`, the scoped package, and building from source.

### 2. Create the agent folder

```bash
mkdir my-agent
cd my-agent
mono-agent init
```

Bare `init` on a terminal is the guided wizard: name the agent, write its Role, choose models and capabilities, and complete any provider setup. It proves each selected route before it calls the folder ready, and on macOS it also starts the agent. Any flag, or a non-TTY run, writes the scaffold only and makes no readiness claim — then validate and start it yourself.

### 3. Validate and start the agent

```bash
mono-agent validate
mono-agent start                  # background service on macOS and Linux
mono-agent status                 # confirm the running instance
```

If guided init already started the agent, `status` confirms it in place of `start`; on Linux, guided setup prints this start step for you to run yourself. Without a usable service manager, run `mono-agent start --foreground` and keep that terminal open.

### 4. Open the web workspace

Run the browser console in its own terminal, bound to this computer, and open the URL it prints:

```bash
mono-agent web run --loopback
```

Open <http://127.0.0.1:5050>, choose the running agent, and start a conversation. Conversations and in-flight turns live in the service, so refreshing or closing a tab does not abort the work — but keep this terminal open. If you started the agent with `--foreground` too, that is a second terminal.

Want the console to keep running in the background? `mono-agent web start` installs it as a service instead. On macOS, managed startup also publishes the console through its own Tailscale Serve HTTPS route — `--loopback` narrows only the local listener, so it does not make a managed console local — and there is still no application login, so anyone who can reach that route can operate the discovered agents. Foreground `web run` never configures that route and never removes one an earlier managed start created. [Install & prerequisites](./docs/getting-started/install.md#run-the-browser-console) covers both modes and how to check the effective URLs.

The same agent is also reachable from the terminal console and, once you enable them, from channels. [Your first agent](./docs/getting-started/quickstart.md) walks the wizard branches, the scriptable webhook smoke request, and the per-platform start paths; [Setup security and managed runtime](./docs/reference/setup-security.md) documents the managed-start and secret-persistence trust model behind them.

## Setup details

Bare `mono-agent init` on a terminal is the guided wizard. It asks for the agent name and the exact Role destined for `IDENTITY.md` → `## Role`, searches the provider catalogs, and then proves every selected route with one disposable no-tool model call, sequentially, with timeouts of 90s for each cloud route and 240s for each local route. An interrupted preflight can resume the routes that already passed under the same non-secret plan fingerprint. On macOS the **Agent ready** gate additionally starts the managed background agent and proves its live snapshot before printing the handoff; on Linux the same route and configuration checks run, and then `init` prints a **Manual start required** handoff instead of installing the systemd user service for you.

Passing any flag, `--yes`, or running without a TTY skips the wizard: `init` writes the scaffold only, runs no readiness proof, starts no process, and never labels the result ready. `--auth` adds provider setup to that automated path. The flags, the files a scaffold writes, the full generated config, and the guided secret handling are documented in [Your first agent](./docs/getting-started/quickstart.md#setup-details-guided-init-flags-and-files).

## Make it yours

Everything below is configuration in the same one file. Edit `mono-agent.config.json` (and `IDENTITY.md`), then apply the change with `mono-agent validate` followed by `mono-agent restart` — a running agent keeps serving the old config until that restart. Start with the defaults, then add what you need:

- **Models and fallbacks** — `runtime.model` takes any `<provider>:<model>` ref; add ordered `runtime.fallbacks` and per-route effort. Local providers use `providers.local`. Start with [Runtime & providers](./docs/runtime/index.md).
- **Tools and safety** — the tool surface is allow-all by default; narrow it with `tools.allowedTools`, or go chat-only with `[]`. [Tool policy](./docs/tools/policy.md) and the [sandbox](./docs/tools/sandbox.md) are the two separate controls.
- **Skills and MCP** — select `SKILL.md` instruction sets for the context, and attach MCP servers for extra tools. See [Selected skills](./docs/context/skills.md) and [MCP servers](./docs/tools/mcp.md).
- **Channels** — turn on a transport with its `enabled` flag and keep its credentials in `.env`: [Telegram](./docs/channels/telegram.md), [Slack](./docs/channels/slack.md), [webhook](./docs/channels/webhook.md), [OpenAI-compatible API](./docs/channels/openai-api.md), [cron](./docs/channels/cron.md), and plugin channels such as [A2A](./docs/channels/a2a.md) or [WhatsApp](./docs/channels/whatsapp.md). Each channel keeps its own conversation history.
- **Memory (optional)** — tiered capture and recall, from a simple journal to semantic recall with local embeddings; the external Supermemory backend is an explicitly installed plugin. See [Memory](./docs/memory/index.md) and [Backends compared](./docs/memory/backends-comparison.md).
- **Presets and the wizard** — `mono-agent presets list` shows the built-in answer sets, and `mono-agent init --preset <id> --yes` scaffolds one non-interactively: [Presets & capability modules](./docs/reference/presets.md).
- **A composer skill for authoring** — the bundled `mono-agent-composer` skill walks an agent through building a folder with the same flow; `mono-agent install-skill` installs it and pairs the docs MCP companion: [Documentation MCP](./docs/tools/documentation-mcp.md).

## Safety and privacy

mono-agent is local-first and single-owner by default, and two defaults deserve attention before anything is network-reachable:

- **The web console has no application login.** The foreground console (`mono-agent web run --loopback`) keeps its listener on this computer and touches no proxy configuration. Managed startup (`mono-agent web start`) binds `0.0.0.0:5050` by default, and on macOS it also claims its own Tailscale Serve HTTPS route — even with `--loopback`, which narrows only the local listener. Because anyone who can reach the console operates the discovered agents and can complete provider sign-in, read [the console's security boundary](./docs/observability/web-console.md#security-boundary-trusted-network-no-login) before using a managed service or a broader bind.
- **Tools are allow-all by default and the sandbox is opt-in.** A fresh agent can run shell commands, read and write files, and fetch pages unless you narrow `tools.allowedTools`. The native sandbox confines Pi-owned commands to declared roots with a deny-by-default network policy and fails closed when no usable engine exists, so a command fails instead of silently running unsandboxed.

Secrets belong in an owner-only `.env` or the provider's auth store, never in JSON or chat; guided setup fails closed rather than guessing where a secret may be written. Read [SECURITY.md](./SECURITY.md) for the trust boundaries, [Setup security and managed runtime](./docs/reference/setup-security.md) for the managed-runtime and secret-persistence contracts, and [Run artifacts & traces](./docs/observability/artifacts-and-traces.md) for what is recorded locally and how redaction is bounded.

## Documentation

- **Documentation site** — <https://mono-agent-docs.vercel.app/> renders everything under [`docs/`](./docs/): getting started, configuration, runtime, channels, memory, tools, programmatic use, playbooks, and reference material.
- **Architecture and packages** — [`ARCHITECTURE.md`](./ARCHITECTURE.md) maps the system and where changes belong; [`PACKAGES.md`](./PACKAGES.md) is the generated package directory and dependency graph.
- **Contributing** — [`CONTRIBUTING.md`](./CONTRIBUTING.md) covers the workspace setup, verification lane, and pull-request expectations. The repository requires Node.js 24.15.0 or newer and pins its own pnpm (currently `11.18.0`, engine range `>=10.16.0`).
- **Support and reporting** — security reports follow [`SECURITY.md`](./SECURITY.md); issues and questions belong in the [repository issue tracker](https://github.com/robertsreberski/mono-agent/issues).

## License

Mono-agent and every publishable package in this workspace are licensed under
`GPL-3.0-only`. See [LICENSE](./LICENSE) for the complete terms.
