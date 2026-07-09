---
title: "CLI command reference"
sidebar:
  order: 3
---

# CLI command reference

This page documents every `mono-agent` command and its flags, verified against the CLI implementation. It also covers the two cross-cutting behaviors you hit on most invocations: automatic `.env` loading and the per-section reports `validate` and `start` print.

Run `mono-agent help` (or `mono-agent`, `--help`, `-h`) at any time for the built-in usage screen. An unknown command or flag prints the error plus the help screen and exits with code `2`.

## Command summary

| Command | Purpose | Key flags |
| --- | --- | --- |
| `init` | Scaffold `mono-agent.config.json`, `IDENTITY.md`, and `.mono-agent/` in the current folder. On a TTY with no flags it runs the step-by-step wizard (including model discovery, effort, provider setup review, and the tools step); any flag or a non-TTY writes the scaffold non-interactively. Never overwrites existing files. | `--preset <id>`, `--with <csv>`, `--yes`, `--auth`, `--dry-run`, `--model <ref>`, `--fallback-models <csv>`, `--effort <level>`, `--memory lite\|journal\|bujo` |
| `setup` | Alias of `init`. | (same as `init`) |
| `presets` | List the built-in setup presets or show a preset's generated config, `.env.example`, and checklist. Replaces `recipes` (still an alias). | `list`, `show <id>` |
| `validate` | Load every config section and report what would run, wait, or fail (`doctor` is an alias). With `--preset <id>`, also report whether the preset's promised capabilities are live. | `--preset <id>`, `--consumer <path>`, `--config <path>`, `--env-file <path>` |
| `config` | Print the resolved config field-by-field with each value's source (`env` / `json` / `default`), including every channel section, plus secret-placement warnings. | `--config <path>`, `--env-file <path>` |
| `memory` | Preview the configured memory store from an agent folder: stats, daily logs, search, and top salient memories. | `stats`, `today`, `show <date>`, `search <query>`, `top`, `--limit <n>`, `--json`, `--config <path>`, `--env-file <path>` |
| `start` | Start the agent as a background launchd service (or foreground worker). | `--config <path>`, `--env-file <path>`, `--foreground` / `-f` |
| `restart` | Restart the background instance for this config (starts it if stopped). | `--config <path>`, `--force` |
| `stop` | Stop the background instance and remove its LaunchAgent. | `--config <path>` |
| `status` | Show this config's instance plus any other running instances. | `--config <path>` |
| `logs` | Print (and optionally follow) the background instance's log files. | `--config <path>`, `--follow` / `-f`, `--lines <n>` |
| `web` | Serve the read-only Session Recorder web PWA for every discovered running agent. | `--host <addr>`, `--port <n>`, `--no-open`, `--allow-non-loopback`, `--include-memory`, `--max-runs <n>`, `--config <path>` |
| `install-skill` | Copy the bundled `mono-agent-composer` skill into the agent skill folders. | `--target claude\|codex\|both`, `--force` |
| `backfill` | Export already-recorded run artifacts to the Phoenix exporter with their historical timestamps. | `--run <id>`, `--all`, `--since <iso>`, `--until <iso>`, `--dry-run`, `--config <path>`, `--env-file <path>` |
| `audit-runs` | Read local run summaries without rewriting them and report parse/status/failure-kind/stale-running totals. | `--artifact-dir <path>`, `--consumer <path>`, `--stale-after-ms <n>`, `--json`, `--config <path>`, `--env-file <path>` |
| `metrics` | Aggregate local run summaries into status rates, failure-kind rates, duration percentiles, and cost totals. | `--artifacts <path>`, `--since <iso>`, `--until <iso>`, `--by model\|channel\|failureKind`, `--json`, `--config <path>`, `--env-file <path>` |
| `help` | Print the usage screen. | — |

Every command is `cli` coverage. `start`, `restart`, `stop`, `status`, and `logs` are the background service commands; `start --foreground` is the cross-platform fallback. `stop`, `logs`, and `start --foreground` are real commands (they were absent from older feature listings).

## `.env` auto-load

On every invocation the CLI loads a dotenv file before dispatching the command. By default it looks for `.env` in the current working directory; pass `--env-file <path>` to point elsewhere. The file is resolved relative to the current folder. For `validate --consumer <path>`, the default `.env` and any relative `--env-file` path are resolved inside the consumer folder, not the caller's current directory.

Variables already present in the process environment are never overwritten, so **exported shell variables win** over the file. A missing or unreadable file is silently ignored — it is not an error.

```bash
# uses ./.env if present
mono-agent start

# load secrets from a non-default file
mono-agent validate --env-file ./secrets/.env.prod

# exported var beats the file's value
TELEGRAM_BOT_TOKEN=xoxb-override mono-agent start
```

Background commands (`start`, `restart`, `stop`, `status`, `logs`) require macOS (launchd). On other platforms use `mono-agent start --foreground`. See [Sessions & concurrency](/runtime/sessions-concurrency/) for how the background worker keeps conversations alive.

## `init`

Scaffolds a new agent in the current folder. Existing `mono-agent.config.json`, `IDENTITY.md`, and `.mono-agent/` files are kept, not overwritten — re-running is safe.

On an interactive terminal with **no flags**, `init` launches the **step-by-step wizard**: pick a preset or "custom", then answer model, effort, channels (multiselect), memory, **tools** (a multiselect pre-checked with a safe read-only default plus your channels' send tools — it warns loudly if you deselect everything), sandbox (only when shell/file tools are chosen), and observability, ending on a review-and-confirm. The model step defaults to `pi:openai-codex:gpt-5.5` and discovers Pi OpenAI-Codex, OpenCode-Go, Ollama, and LM Studio candidates best-effort with short timeouts. Missing Pi auth leaves `pi:openai-codex:gpt-5.5` selectable as setup-required instead of skipping it; direct `codex:gpt-5.5` and Claude remain selectable fallbacks. The optional fallback step reuses the discovered choices, excludes the selected primary and prior fallbacks, and adds backups one at a time. Discovered OpenCode choices are recorded as `pi:opencode-go:*` so they run through the Pi SDK path. The effort step starts from the selected primary model's derived default (`medium` for Claude/Codex/Pi OpenAI-Codex and reasoning-capable discovered local models, `none` for non-reasoning local models); choosing "Default" still leaves `runtime.effort` unset. The review shows the supported provider setup plan and can run auth/preflight commands before files are written, including creating the Pi auth directory and running bundled `pi-ai login openai-codex` for OAuth providers or saving an OpenCode-Go API key into the Pi auth store. It then scaffolds and immediately runs `validate`. With `--yes` or **any** flag (`--preset`, `--model`, `--with`, `--memory`, `--fallback-models`, `--effort`, `--auth`, `--dry-run`), or when stdin is not a TTY, `init` skips the wizard and writes the default/preset scaffold non-interactively. `mono-agent setup` is an alias of `init`.

| Flag | Effect |
| --- | --- |
| `--preset <id>` | Seed a blueprint from a saved preset (see [Presets & capability modules](/reference/recipes/)). Skips the wizard. |
| `--with <csv>` | Add channels on top of the preset/default config. Valid values: `telegram`, `slack`, `webhook`, `openaiApi`, `cron`. |
| `--yes` | Write the default/preset scaffold without prompting. |
| `--auth` | Opt in to supported provider setup before writing files in non-interactive init: Claude/Codex login commands, Pi OAuth login from the `providers.piAuthPath` directory, OpenCode-Go API-key save from `OPENCODE_API_KEY`, and local provider preflight checks. Ignored by `--dry-run`, which never launches commands. |
| `--dry-run` | Preview the files that would be created without writing or validating. |
| `--model <ref>` | Seed the primary model reference (default `pi:openai-codex:gpt-5.5`). |
| `--fallback-models <csv>` | Comma-separated ordered fallback chain. |
| `--effort <level>` | Write `runtime.effort`. Valid values: `none`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `--memory lite\|journal\|bujo` | Pick the memory tier to scaffold. Any other value errors. |

Init model references look like `claude:claude-sonnet-4-6`, `codex:gpt-5.5`, or `pi:<provider>:<model>` (e.g. `pi:openai-codex:gpt-5.5`, `pi:opencode-go:kimi-k2.6`, `pi:ollama:gemma4:31b`, or `pi:lmstudio:<model>`). The wizard's manual Pi path asks separately for provider id and model id, with `openai-codex`, `opencode-go`, `ollama`, and `lmstudio` as the expected built-in/local provider ids. It does not create a generic `pi:openai:*` shortcut. The wizard discovers OpenCode models through `opencode models --json` and records them as `pi:opencode-go:<model>` for Pi SDK setup; direct `opencode:<provider>:<model>` refs remain a runtime backend for hand-authored config, not a first-class init wizard selection.

```bash
mono-agent init                              # interactive wizard on a TTY
mono-agent init --preset telegram-assistant --yes
mono-agent init --model pi:openai-codex:gpt-5.5 \
  --fallback-models "pi:opencode-go:kimi-k2.6,pi:ollama:gemma4:31b" \
  --effort high \
  --memory bujo
```

The generated config matches [the config blueprint](/config/blueprint/). See [Backends](/runtime/backends/) for the model reference grammar, [Fallback](/runtime/fallback/) for the chain, [Capture & recall](/memory/capture-and-recall/) for the memory tiers, and [Presets & capability modules](/reference/recipes/) for the wizard's tools step and the no-tools guardrail.

The deprecated `--recipe <id>` flag still works: it maps a retired recipe id to the preset that replaced it (with a deprecation notice), or errors with a pointer to the wizard for the fully-retired blueprints. See [Deprecations](/reference/recipes/#deprecations).

## `presets`

Presets are saved wizard answer-sets. `presets list` shows the ids, titles, descriptions, and risk levels; `presets show <id>` prints the generated `mono-agent.config.json`, any `.env.example` placeholders, scaffolded files, and the validation checklist. `mono-agent recipes …` remains as a deprecated alias.

```bash
mono-agent presets list
mono-agent presets show telegram-assistant
```

## `validate`

Loads every config section and prints a status report, then exits `0` when the config is ready to start and `1` otherwise. `mono-agent doctor` is an alias — same flags, same report. By default it reads `mono-agent.config.json` from the current folder; override with `--config <path>`. Use `--consumer <path>` to run the same readiness report against a downstream agent folder without changing the current directory or creating missing memory roots there. With `--consumer`, a relative `--config` points inside the consumer folder and the consumer `.env` is loaded by default. It also honors `--env-file <path>` for the dotenv load above.

```bash
mono-agent validate
mono-agent validate --preset code-sandbox
mono-agent validate --config ./agents/support.config.json --env-file ./.env.staging
mono-agent validate --consumer ../local-agent-alpha
```

| Flag | Effect |
| --- | --- |
| `--preset <id>` | Also report whether the preset's promised capabilities are live — each expectation is checked against the doctor report. The deprecated `--recipe <id>` alias maps to the replacing preset. |
| `--consumer <path>` | Validate another agent folder read-only. Relative `--config` and `--env-file` paths resolve inside that folder. |
| `--config <path>` | Use a non-default config file. With `--consumer`, relative paths are inside the consumer folder. |
| `--env-file <path>` | Load secrets from a non-default dotenv file. With `--consumer`, relative paths are inside the consumer folder. |

Each section prints a status badge, a label, and its details. The statuses are:

| Status | Meaning |
| --- | --- |
| `ok` | The section is configured and ready. |
| `waiting` | Configured but a runtime dependency is not up yet (e.g. Ollama or Phoenix not reachable), or a credential is missing/expired. Runtime-soft — never blocks start. Advisory detail lines are prefixed `[WARN]`. |
| `disabled` | The section is intentionally off — a channel with `enabled: false`, or no models of a kind that needs this check. Never blocks start. |
| `error` | A structural problem that must be fixed; any `error` section fails the run. |

`validate` runs liveness probes, so it can show `waiting` for unreachable network dependencies. The Phoenix exporter check additionally POSTs an empty protobuf to confirm export compatibility, not just reachability — see [Phoenix & backfill](/observability/phoenix-and-backfill/).

The **Tools & MCP** section reports the tool policy: allow-all (the default) shows `All tools allowed.` (or `All tools allowed (except: …)` when a `disallowedTools` list is present), while an **explicit empty** `tools.allowedTools: []` flags the no-tools trap — `waiting` (never a silent `ok`), because the agent could chat but cannot read files, run commands, or send proactively. For a specific allowlist it also flags an unknown tool name with a "did you mean" hint (pi silently drops unknown names) and cross-checks adapter send tools against enabled channels. See [Presets & capability modules](/reference/recipes/#the-tools-step-and-the-no-tools-guardrail) for the full contract.

### Provider credentials

`validate` includes a **Provider credentials** section that resolves every referenced Pi model — the primary `runtime.model`, every `runtime.fallbackModels` entry, and the `agent-host` `memory.llm` model — against the Pi auth store (`providers.piAuthPath`) and its sibling `models.json`. It is **static and read-only**: it never mints tokens or hits the network. For each Pi provider:

- A provider configured via `models.json` (custom/local) needs no OAuth → `ok`.
- A provider **absent** from both the auth store and `models.json` → `waiting`, with a `[WARN]` line and a `pi-ai login <provider>` hint to run from the directory containing `providers.piAuthPath`.
- An OAuth provider whose access token has **expired** → `waiting`, with a `[WARN]` line noting the expiry and the `pi-ai login <provider>` re-auth hint (the runtime auto-refreshes, but a dead refresh shows up as `No API key for provider: <provider>` at run time).
- If no Pi provider-key models are referenced at all (e.g. an all-`claude:` config), the section reports `disabled` — SDK-authenticated models are checked by their own SDK.

This catches the class of silent failure where an expired OAuth token quietly breaks crons or memory capture without any structural config error. Because the worst it returns is `waiting`, it never blocks `start` — read the section.

### Runs health

`validate` includes a **Runs health** section that reads the configured local run artifact directory only. It prints the exact corpus size as `Recorded runs: <N> total; showing <M> recent (max 50).`, a `Last runs: <runId> <status> <age> ago, ...` line (relative ages render as `Ns/Nm/Nh/Nd ago`, or `age unknown` when the timestamp is missing or unparseable; capped at 5 examples with an `and N more` suffix), reports recent counts by status, warns for stale `running` summaries, surfaces `cancelled` / `interrupted` runs, and prints a compact failure-kind breakdown with explanations and next steps for known kinds such as `usage_limit`, `process_death`, `cancelled`, `provider_unavailable`, and `provider_unavailable_exhausted`. Unknown kinds use a generic "inspect the artifact summary and logs" explanation. Advisory lines use the `[WARN]` prefix and yield `waiting`, not `error`.

An empty or missing artifact directory prints `No runs recorded yet.`, reports `disabled`, and stays non-fatal. The section does not read event JSONL files, export anything, reconcile stale runs, or add network probes to the `start` / `restart` preflight.

`status` and foreground `start --foreground` use the same local run-summary display for the running instance when the trace-source manifest includes an artifact directory, so operators can see active selected skills, the exact recorded-run count, the most recent run ids with status and age, failure-kind counts with explanations, and any `running` summaries whose owner process is gone without running a separate validation command.

### Secret placement

`validate` includes a **Secret placement** section that warns when a secret-marked config field is resolved from the committed `mono-agent.config.json` rather than from `.env`. It covers the core secrets (`memory.embeddings.apiKey`, `memory.supermemory.apiKey`) and every channel credential — `telegram.botToken`, `slack.botToken` / `slack.appToken`, `openaiApi.apiKey`, and the A2A bearer tokens. The section reports `waiting` — it is advisory and never `error`, so it never blocks `start`. Each detail line is prefixed `[WARN]` and names the matching `MONO_AGENT_*` env var to move the secret to, e.g.:

```text
[WARN] telegram.botToken is a secret read from mono-agent.config.json — move it to .env (MONO_AGENT_TELEGRAM_BOT_TOKEN).
```

The warning prints only the stable field id and env-var name — never the secret value. The section is omitted entirely when no secret is JSON-sourced (e.g. when the same secret is supplied via `.env`). The same warnings are printed by [`mono-agent config`](/config/) after the resolved-config view.

## `config`

Prints the resolved configuration read-only: every core section field-by-field, each value tagged with its origin — `[env]`, `[json]`, or `[default]` — followed by a **Channels** block with the same per-field provenance for every built-in and configured plugin channel (composed from each adapter's field registry, so it can never disagree with what the adapter actually reads), any JSON-secret placement warnings, and the channel status summary. Secret fields are shown only as `set` / `unset`, never as values.

```bash
mono-agent config
mono-agent config --config ./agents/support.config.json --env-file ./.env.staging
```

| Flag | Effect |
| --- | --- |
| `--config <path>` | Use a non-default config file. |
| `--env-file <path>` | Load secrets from a non-default dotenv file. |

## `memory`

Previews the configured memory store from an agent folder without using the standalone `memory-bujo <root>` env workflow. It reads `memory` from `mono-agent.config.json` through the normal app config loader, so relative paths resolve the same way they do for the running agent. Output is human-first by default; pass `--json` for scripts.

```bash
mono-agent memory stats
mono-agent memory today
mono-agent memory show 2026-07-06
mono-agent memory search "deployment notes"
mono-agent memory top --limit 20
```

| Subcommand | Effect |
| --- | --- |
| `stats` | Shows backend, configured/effective tier, write mode, recall-tool state, local root, memory/entity counts, store sizes, last capture/access/consolidation signals, and top entities. For Supermemory it reports the known remote endpoint/container and explicitly lists fields that are not knowable locally. |
| `today` | Renders today's local BuJo daily log. |
| `show <YYYY-MM-DD>` | Renders one local BuJo daily log by date. Both current `daily/YYYY-MM-DD.md` and older root-level `YYYY-MM-DD.md` layouts are recognized. |
| `search <query>` | Uses the same recall-store construction as `MemoryRecall`. Local BuJo/journal search returns scores plus sources; if configured embeddings are unavailable, it retries FTS-only and prints a warning. Supermemory search proxies the remote API. |
| `top` | Shows highest-salience local BuJo/journal memories with salience, type/status, and source. Supermemory has no local salience ranking, so it tells you to use search. |

| Flag | Effect |
| --- | --- |
| `--limit <n>` | Limits search hits, top memories, and stats entity preview rows (1-100). |
| `--json` | Prints the machine-readable result instead of the human view. |
| `--config <path>` | Use a non-default config file. |
| `--env-file <path>` | Load secrets from a non-default dotenv file before resolving the config. |

## `start`

Starts the agent. Without `--foreground`, it registers a background macOS service (launchd) for the config, prints the instance info, and returns; re-running restarts the running instance. Both modes refuse to start unless a valid `mono-agent.config.json` is present in the folder.

| Flag | Effect |
| --- | --- |
| `--config <path>` | Use a non-default config file. |
| `--env-file <path>` | Load secrets from a non-default dotenv file. |
| `--foreground` / `-f` | Run the blocking foreground worker instead of backgrounding. |

The start preflight requires the config **file** to exist (a folder with only env vars is not a configured agent → exit `2`) and runs structural validation with network probes skipped (so probes only yield `waiting`, never `error`); any `error` section refuses the start with exit `1`. `waiting` never blocks.

```bash
# background launchd service (macOS)
mono-agent start

# blocking foreground worker (any platform; ends on SIGINT/SIGTERM)
mono-agent start --foreground
```

On start the CLI prints per-section status blocks:

- **instance** — the resolved config path and traceability status (`running (source <id>)`, or `<kind>: <reason>`).
- **observability** — the exporter status: when configured, the Phoenix endpoint, the Phoenix app URL, any last warning/error, and where JSONL artifacts remain local. When `includeSensitiveData` is enabled it surfaces an explicit yellow `[WARN] includeSensitiveData=true exports redacted/capped user input, assistant replies, tool args/results, and system prompt to Phoenix at <endpoint>; substantive run content leaves this machine.` line (also emitted across `validate` / `status` / background output). The export remains a valid opt-in — this warning does not flip `report.ok` or the `validate` status.
- **channels** — one line per configured channel with a status badge: `running` (plus a `key=value` summary of its facts) or `<kind>: <reason>` (e.g. `disabled`, `waiting`, `degraded`). A channel rendered `degraded: <reason>` carries a warning badge — it is a non-fatal, still-serving state where the live transport dropped but the responder is kept alive and the adapter is self-recovering (e.g. a Telegram poll crash on a network switch). `degraded` counts as an active/serving transport (not idle, not failed) and flips back to `running` once the transport recovers.
- **runs health** — in foreground mode, the active selected skills, local artifact directory, total recorded summaries, last runs with relative ages, status counts, stale/process-gone `running` summaries, and compact failure-kind counts with explanations.

A channel shown as `disabled` is opted out via its `enabled` flag rather than misconfigured. See [Channels overview](/channels/) and [Artifacts & traces](/observability/artifacts-and-traces/).

## `restart`

Restarts the background instance for this config, starting it if stopped. Like `start`, it gates on a present, valid config before touching launchd.

| Flag | Effect |
| --- | --- |
| `--config <path>` | Target a non-default config. |
| `--force` | Stop, then purge the persisted pi-session store (`providers.piNative.piSessionsRoot`), then start fresh. |

`--force` clears resumable provider sessions so the agent starts with fresh conversations instead of resuming saved transcripts. Durable memory under `memory.path` is untouched, and it is a no-op when sessions are in-memory (`piSessionsRoot` unset).

```bash
mono-agent restart
mono-agent restart --force   # also purges piSessionsRoot
```

`piSessionsRoot` is set via `providers.piNative.piSessionsRoot` (env `MONO_AGENT_PI_SESSIONS_ROOT`), e.g. `.mono-agent/sessions`; leaving it unset keeps sessions in memory.

:::caution
`--force` permanently deletes saved transcripts for this instance. The agent's durable memory is preserved, but in-flight resumable conversations are dropped.
:::

## `stop`, `status`, `logs`

These three commands stay ungated, so a broken or misconfigured instance can still be inspected and torn down.

```bash
mono-agent stop                  # stop and remove the LaunchAgent
mono-agent status                # this config's instance + other running instances
mono-agent logs --follow         # stream the log files
mono-agent logs --lines 500      # print the last 500 lines and exit
```

| Command | Flag | Effect |
| --- | --- | --- |
| `stop` | `--config <path>` | Target a non-default config. |
| `status` | `--config <path>` | Target a non-default config. |
| `logs` | `--config <path>` | Target a non-default config. |
| `logs` | `--follow` / `-f` | Keep streaming new output (`tail -F`). |
| `logs` | `--lines <n>` | Number of trailing lines to print (1–100000, default 200). |

For `logs`, `-f` means **follow**; for `start`, `-f` means **foreground**. A `--lines` value outside `1`–`100000` (or non-integer) errors.

`status` prints the same compact **runs health** block for the detached instance after the instance, observability, and channel details. Missing or empty artifact directories show `No runs recorded yet.` and do not change the command's existing exit-code semantics.

## `tui`

Opens the [operator console](/observability/tui/) from **any directory**: live chat with full thinking/tool/telemetry insight, recorded-run replay, and a source-annotated config view. Discovers running agents via the trace-source registry — zero running agents prints a `mono-agent start` hint and exits `1`, one connects directly, several open an in-TUI picker. Requires an interactive TTY.

```bash
mono-agent tui                          # discover + connect
mono-agent tui --agent personal-agent   # connect by label or sourceId
mono-agent tui --conversation ops       # chat under a stable conversation id
```

| Flag | Effect |
| --- | --- |
| `--agent <label\|sourceId>` | Connect to a specific running instance; errors with the available list when there is no match. |
| `--conversation <id>` | Conversation id for the chat (default `tui-<sourceId>`). |
| `--config <path>` | Resolve a custom `traceability.registryDir` from this config (for agents registered outside the global registry). |

The live-chat connection uses the agent's [`tui` channel](/channels/tui/) (on by default); an agent with the channel disabled still gets replay and config views.

## `web`

Serves the read-only [Session Recorder web PWA](/observability/) from any directory. It discovers running agents through the same trace-source registries as `mono-agent tui`, reads their recorded run artifacts, connects to each agent's default-on `live` event relay when available, and streams session updates to the browser.

```bash
mono-agent web
mono-agent web --port 4599 --no-open
mono-agent web --host 0.0.0.0 --allow-non-loopback
mono-agent web --include-memory
mono-agent web --max-runs 500
```

| Flag | Effect |
| --- | --- |
| `--host <addr>` | Bind address for the PWA backend (default `127.0.0.1`). |
| `--port <n>` | Bind port (default `4599`, printed on start for reverse-proxy targets). |
| `--no-open` | Do not launch the browser after the backend starts. |
| `--allow-non-loopback` | Permit a non-loopback bind. The command generates a bearer token and prints/opens a tokenized URL; `/api/*` and `/api/stream` require it. |
| `--include-memory` | Include memory-maintenance runs from both the `memory/` artifact namespace and legacy mixed directories. Defaults to agent runs only. |
| `--max-runs <n>` | Cap the per-instance in-memory working set and the initial browser snapshot (positive integer, default `200`). Disk paging via "Load older" still reaches the full on-disk history, so this only bounds memory — not history reachability. |
| `--config <path>` | Resolve a custom `traceability.registryDir` from this config, in addition to the global registry. |

Run history and live updates default to agent runs only; memory-maintenance runs are hidden plumbing unless you pass `--include-memory`. Loopback mode prints both the exact reverse-proxy target and a `tailscale serve` hint for HTTPS/PWA installation. Non-loopback mode remains read-only but exposes prompts, cwd/artifact paths, tool events, and run text to anyone with the tokenized URL, so prefer Tailscale or another trusted network boundary.

The web API returns recent sessions first and supports paged older history with
`instance`, `limit`, and `offset` query parameters on `/api/sessions`. The PWA
uses those pages behind its "Load older" action, projects stale `running`
summaries as `stalled`, shows failure/error/failover details when present, and
formats single-instance run lists in the instance's discovered timezone.
Cap-eviction of completed runs from the in-memory working set is silent, so
every recorded run stays reachable through "Load older" regardless of the
`--max-runs` bound.

Each run's detail view carries a **Context (this turn)** section that surfaces
the context every provider call was driven with: recalled long-term memory (with
its source), the replayed prior conversation messages (role-badged), and the
full compiled system prompt behind a collapsible raw view. When the provider
session already held the transcript — a warm in-process session or a durable
cross-restart resume (also turn 1 of a brand-new conversation under a derived
durable session id) — it reads *context carried by the provider session*. Runs
recorded before this feature fall back to the raw compiled prompt only; runs with
neither show no section.

## `install-skill`

Copies the bundled `mono-agent-composer` skill into the agent skill folders (`~/.claude/skills` and/or `~/.agents/skills`). Refuses to overwrite an existing copy unless `--force` is passed.

| Flag | Effect |
| --- | --- |
| `--target claude\|codex\|both` | Where to install (default `both`). Any other value errors. |
| `--force` | Overwrite an existing installed skill. |

```bash
mono-agent install-skill                       # both targets
mono-agent install-skill --target claude --force
```

See [Skills](/context/skills/) for how skills are surfaced to the agent.

## `audit-runs`

Audits recorded run summary artifacts without exporting, reconciling, or rewriting anything. By default it audits agent runs only, excluding memory-maintenance `mem-*` runs from both the legacy mixed namespace and the `memory/` namespace. Use it when you need a structural inventory of a consumer's local artifact directory: how many summaries parse, which statuses and production failure kinds are present, whether any values are unrecognized, how many `running` summaries are stale, and the per-failure-kind rates.

| Flag | Effect |
| --- | --- |
| `--artifact-dir <path>` | Read this artifact directory directly. Wins over config-based resolution. |
| `--consumer <path>` | Resolve `artifacts.dir` and `traceability.staleAfterMs` relative to this consumer folder. |
| `--config <path>` | Use a non-default config file when resolving a consumer. |
| `--env-file <path>` | Load secrets or env overrides from a non-default dotenv file. |
| `--stale-after-ms <n>` | Override the stale-running cutoff interval. |
| `--include-memory` | Include memory-maintenance summaries in addition to agent runs. |
| `--json` | Print the full machine-readable audit report. |

```bash
mono-agent audit-runs --consumer ~/local-agent-alpha --json
mono-agent audit-runs --artifact-dir ./.mono-agent/artifacts --stale-after-ms 30000
```

The command only reads `*.summary.json` files. A malformed summary is reported as a parse failure, and a stale `running` summary is reported without being rewritten. Startup reconciliation is still the only path that changes stale `running` summaries to `interrupted`.

## `metrics`

Aggregates recorded run summary artifacts without exporting, reconciling, or rewriting anything. By default it reports agent-run metrics only, excluding memory-maintenance `mem-*` runs from both the legacy mixed namespace and the `memory/` namespace. Use it when you need latency, cost, and failure-rate numbers over the whole local corpus or a time window.

| Flag | Effect |
| --- | --- |
| `--artifacts <path>` | Read this artifact directory directly. Wins over config-based `artifacts.dir` resolution. |
| `--config <path>` | Use a non-default config file when resolving `artifacts.dir`. |
| `--env-file <path>` | Load env overrides before resolving `MONO_AGENT_ARTIFACT_DIR`. |
| `--since <iso>` | Only summaries whose `startedAt` is at or after this ISO instant. |
| `--until <iso>` | Only summaries whose `startedAt` is at or before this ISO instant. |
| `--by model\|channel\|failureKind` | Add grouped buckets after the overall totals. |
| `--include-memory` | Include memory-maintenance summaries in addition to agent runs. |
| `--json` | Print the full machine-readable metrics report. |

```bash
mono-agent metrics --artifacts ./.mono-agent/artifacts
mono-agent metrics --by model --since 2026-06-01T00:00:00Z --json
```

The command reports total runs, status counts/rates, failure-kind rates, `durationMs` p50/p90/p99/max, and cost totals. Cost prefers `cost.cumulativeUsd`, then `cost.totalUsd`, then `usage.cost_usd`; malformed or redacted non-numeric values are ignored. Channel grouping is derived from the `conversationId` prefix before `:`, so treat it as best-effort until summaries persist a first-class channel field.

See [Artifacts & traces](/observability/artifacts-and-traces/#artifact-metrics) for the full report contract and window semantics.

## `backfill`

Exports already-recorded run artifacts to the configured Phoenix exporter with their historical timestamps. `--all` defaults to agent runs only; add `--include-memory` to export memory-maintenance runs from both the legacy mixed namespace and the `memory/` namespace. Explicit `--run mem-*` reads the requested memory run even without `--include-memory`. Trace ids are deterministic per run, so re-running overwrites rather than duplicating. Honors `--config <path>` and `--env-file <path>`.

| Flag | Effect |
| --- | --- |
| `--run <id>` | Export exactly this run id. |
| `--all` | Export every recorded run. |
| `--since <iso>` | Only runs whose `startedAt` is ≥ this ISO instant. |
| `--until <iso>` | Only runs whose `startedAt` is ≤ this ISO instant. |
| `--include-memory` | With `--all`, include memory-maintenance runs in addition to agent runs. |
| `--dry-run` | Map and serialize but do not POST. |
| `--config <path>` | Use a non-default config. |
| `--env-file <path>` | Load secrets from a non-default dotenv file. |

```bash
# one run
mono-agent backfill --run 2026-06-21T10-15-03Z-abcd

# a window, mapped but not sent
mono-agent backfill --all --since 2026-06-01T00:00:00Z \
  --until 2026-06-21T00:00:00Z --dry-run
```

The exporter is configured under `observability.exporters[]` (env `MONO_AGENT_OBSERVABILITY_EXPORTERS`, a JSON array):

```json
{
  "observability": {
    "exporters": [
      {
        "type": "phoenix",
        "endpoint": "http://localhost:6006",
        "projectName": "support-agent",
        "includeSensitiveData": false,
        "headers": {},
        "timeoutMs": 5000
      }
    ]
  }
}
```

Full backfill semantics and the JSONL artifact format live in [Phoenix & backfill](/observability/phoenix-and-backfill/) and [Artifacts & traces](/observability/artifacts-and-traces/).

## See also

- [Observability overview](/observability/)
- [Live TUI](/observability/tui/)
- [Config blueprint](/config/blueprint/) and [Environment variables](/config/env-vars/)
- [Programmatic composition](/programmatic/) for embedding the host without the CLI
