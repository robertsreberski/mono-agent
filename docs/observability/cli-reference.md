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
| `init` | Scaffold `mono-agent.config.json`, `IDENTITY.md`, and `.mono-agent/` in the current folder (never overwrites existing files). | `--model <ref>`, `--fallback-models <csv>`, `--memory lite\|journal\|bujo` |
| `validate` | Load every config section and report what would run, wait, or fail. | `--config <path>`, `--env-file <path>` |
| `start` | Start the agent as a background launchd service (or foreground worker). | `--config <path>`, `--env-file <path>`, `--foreground` / `-f` |
| `restart` | Restart the background instance for this config (starts it if stopped). | `--config <path>`, `--force` |
| `stop` | Stop the background instance and remove its LaunchAgent. | `--config <path>` |
| `status` | Show this config's instance plus any other running instances. | `--config <path>` |
| `logs` | Print (and optionally follow) the background instance's log files. | `--config <path>`, `--follow` / `-f`, `--lines <n>` |
| `install-skill` | Copy the bundled `mono-agent-composer` skill into the agent skill folders. | `--target claude\|codex\|both`, `--force` |
| `backfill` | Export already-recorded run artifacts to the Phoenix exporter with their historical timestamps. | `--run <id>`, `--all`, `--since <iso>`, `--until <iso>`, `--dry-run`, `--config <path>`, `--env-file <path>` |
| `audit-runs` | Read local run summaries without rewriting them and report parse/status/failure-kind/stale-running totals. | `--artifact-dir <path>`, `--consumer <path>`, `--stale-after-ms <n>`, `--json`, `--config <path>`, `--env-file <path>` |
| `help` | Print the usage screen. | — |

Every command is `cli` coverage. `start`, `restart`, `stop`, `status`, and `logs` are the background service commands; `start --foreground` is the cross-platform fallback. `stop`, `logs`, and `start --foreground` are real commands (they were absent from older feature listings).

## `.env` auto-load

On every invocation the CLI loads a dotenv file before dispatching the command. By default it looks for `.env` in the current working directory; pass `--env-file <path>` to point elsewhere. The file is resolved relative to the current folder.

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

| Flag | Effect |
| --- | --- |
| `--model <ref>` | Seed the primary model reference (e.g. `claude:claude-sonnet-4-6`). |
| `--fallback-models <csv>` | Comma-separated ordered fallback chain. |
| `--memory lite\|journal\|bujo` | Pick the memory tier to scaffold. Any other value errors. |

Model references look like `claude:claude-sonnet-4-6`, `codex:gpt-5.5`, or `pi:<provider>:<model>` (e.g. `pi:ollama:gemma4:31b`).

```bash
mono-agent init --model claude:claude-sonnet-4-6 \
  --fallback-models "codex:gpt-5.5,pi:ollama:gemma4:31b" \
  --memory bujo
```

The generated config matches [the config blueprint](/config/blueprint/). See [Backends](/runtime/backends/) for the model reference grammar, [Fallback](/runtime/fallback/) for the chain, and [Capture & recall](/memory/capture-and-recall/) for the memory tiers.

## `validate`

Loads every config section and prints a status report, then exits `0` when the config is ready to start and `1` otherwise. By default it reads `mono-agent.config.json` from the current folder; override with `--config <path>`. It also honors `--env-file <path>` for the dotenv load above.

```bash
mono-agent validate
mono-agent validate --config ./agents/support.config.json --env-file ./.env.staging
```

Each section prints a status badge, a label, and its details. The statuses are:

| Status | Meaning |
| --- | --- |
| `ok` | The section is configured and ready. |
| `waiting` | Configured but a runtime dependency is not up yet (e.g. Ollama or Phoenix not reachable), or a credential is missing/expired. Runtime-soft — never blocks start. Advisory detail lines are prefixed `[WARN]`. |
| `disabled` | The section is intentionally off — a channel with `enabled: false`, or no models of a kind that needs this check. Never blocks start. |
| `error` | A structural problem that must be fixed; any `error` section fails the run. |

`validate` runs liveness probes, so it can show `waiting` for unreachable network dependencies. The Phoenix exporter check additionally POSTs an empty protobuf to confirm export compatibility, not just reachability — see [Phoenix & backfill](/observability/phoenix-and-backfill/).

### Provider credentials

`validate` includes a **Provider credentials** section that resolves every referenced Pi model — the primary `runtime.model`, every `runtime.fallbackModels` entry, and the `agent-host` `memory.llm` model — against the Pi auth store (`providers.piAuthPath`) and its sibling `models.json`. It is **static and read-only**: it never mints tokens or hits the network. For each Pi provider:

- A provider configured via `models.json` (custom/local) needs no OAuth → `ok`.
- A provider **absent** from both the auth store and `models.json` → `waiting`, with a `[WARN]` line and a `pi auth login <provider>` hint.
- An OAuth provider whose access token has **expired** → `waiting`, with a `[WARN]` line noting the expiry and the `pi auth login <provider>` re-auth hint (the runtime auto-refreshes, but a dead refresh shows up as `No API key for provider: <provider>` at run time).
- If no Pi provider-key models are referenced at all (e.g. an all-`claude:` config), the section reports `disabled` — SDK-authenticated models are checked by their own SDK.

This catches the class of silent failure where an expired OAuth token quietly breaks crons or memory capture without any structural config error. Because the worst it returns is `waiting`, it never blocks `start` — read the section.

### Runs health

`validate` includes a **Runs health** section that reads the configured local run artifact directory only. It inspects the most recent recorded summaries, reports recent counts by status, warns for stale `running` summaries, surfaces `cancelled` / `interrupted` runs, and prints a compact failure-kind breakdown. Advisory lines use the `[WARN]` prefix and yield `waiting`, not `error`.

An empty or missing artifact directory reports `disabled` and stays non-fatal. The section does not read event JSONL files, export anything, reconcile stale runs, or add network probes to the `start` / `restart` preflight.

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
- **observability** — the exporter status: when configured, the Phoenix endpoint, the Phoenix app URL, `includeSensitiveData=true` when enabled, any last warning/error, and where JSONL artifacts remain local.
- **channels** — one line per configured channel with a status badge: `running` (plus a `key=value` summary of its facts) or `<kind>: <reason>` (e.g. `disabled`, `waiting`).

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

## `install-skill`

Copies the bundled `mono-agent-composer` skill into the agent skill folders (`~/.claude/skills` and/or `~/.codex/skills`). Refuses to overwrite an existing copy unless `--force` is passed.

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

Audits recorded run summary artifacts without exporting, reconciling, or rewriting anything. Use it when you need a structural inventory of a consumer's local artifact directory: how many summaries parse, which statuses and production failure kinds are present, whether any values are unrecognized, how many `running` summaries are stale, and the per-failure-kind rates.

| Flag | Effect |
| --- | --- |
| `--artifact-dir <path>` | Read this artifact directory directly. Wins over config-based resolution. |
| `--consumer <path>` | Resolve `artifacts.dir` and `traceability.staleAfterMs` relative to this consumer folder. |
| `--config <path>` | Use a non-default config file when resolving a consumer. |
| `--env-file <path>` | Load secrets or env overrides from a non-default dotenv file. |
| `--stale-after-ms <n>` | Override the stale-running cutoff interval. |
| `--json` | Print the full machine-readable audit report. |

```bash
mono-agent audit-runs --consumer ~/personal-agent --json
mono-agent audit-runs --artifact-dir ./.mono-agent/artifacts --stale-after-ms 30000
```

The command only reads `*.summary.json` files. A malformed summary is reported as a parse failure, and a stale `running` summary is reported without being rewritten. Startup reconciliation is still the only path that changes stale `running` summaries to `interrupted`.

## `backfill`

Exports already-recorded run artifacts to the configured Phoenix exporter with their historical timestamps. Trace ids are deterministic per run, so re-running overwrites rather than duplicating. Honors `--config <path>` and `--env-file <path>`.

| Flag | Effect |
| --- | --- |
| `--run <id>` | Export exactly this run id. |
| `--all` | Export every recorded run. |
| `--since <iso>` | Only runs whose `startedAt` is ≥ this ISO instant. |
| `--until <iso>` | Only runs whose `startedAt` is ≤ this ISO instant. |
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
