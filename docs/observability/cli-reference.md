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
| `init` | On a TTY with no flags, run the guided readiness path: name and purpose the agent, search the Pi/Codex/Claude catalogs, configure exact route efforts/safety, verify every selected route, then enter the local configuration TUI. Any flag or non-TTY invocation is scaffold-only. | `--name`, `--model`, repeated `--fallback`/`--fallback-effort`, `--route-safety`, legacy `--fallback-models`, `--auth`, `--codex-auth`, `--memory` |
| `setup` | Alias of `init`. | (same as `init`) |
| `presets` | List the built-in setup presets or show a preset's generated config, `.env.example`, and checklist. Replaces `recipes` (still an alias). | `list`, `show <id>` |
| `auth login` | Run direct Codex browser/device login, Pi OAuth for Anthropic/GitHub Copilot/OpenAI Codex, or the OpenCode-Go API-key flow. OpenCode-Go uses masked TTY input by default; `--api-key-stdin` is the explicit headless input mode. Pi credentials are promoted under an owner-only lock with stale-lock repair only when safely proven. | `<provider\|codex>`, `--pi-auth-path <path>`, `--api-key-stdin`, `--codex-auth browser\|device`, `--config <path>` |
| `sandbox` | Inspect, install, or functionally prove the pinned SRT runtime. Managed setup is private-cache and macOS-only. | `status`, `setup`, `check` |
| `validate` | Load every config section and report what would run, wait, or fail (`doctor` is an alias). With `--preset <id>`, also report whether the preset's promised capabilities are live. | `--preset <id>`, `--consumer <path>`, `--config <path>`, `--env-file <path>`, `--json` |
| `config` | Print the resolved config field-by-field with each value's source (`env` / `json` / `default`), including every channel section, plus secret-placement warnings. | `--config <path>`, `--env-file <path>` |
| `memory` | Preview, strictly audit, and safely maintain the configured memory store and its durable completed-turn intake. | `stats`, `today`, `show`, `search`, `top`, `audit`, `inspect`, `retry`, `resolve`, `rebuild`, `rollback`; `--strict`, `--limit`, `--json` |
| `start` | Start the agent as a background launchd service (or foreground worker). | `--config <path>`, `--env-file <path>`, `--foreground` / `-f` |
| `restart` | Restart the background instance for this config (starts it if stopped). | `--config <path>`, `--force` |
| `stop` | Stop the background instance and remove its LaunchAgent. | `--config <path>` |
| `status` | Show this config's instance plus any other running instances. | `--config <path>` |
| `logs` | Print (and optionally follow) the background instance's log files. | `--config <path>`, `--follow` / `-f`, `--lines <n>` |
| `web` | Serve the read-only Session Recorder web PWA for every discovered running agent. | `--host <addr>`, `--port <n>`, `--no-open`, `--allow-non-loopback`, `--show-auth-url`, `--include-memory`, `--max-runs <n>`, `--config <path>` |
| `tui` | Open remote discovery/chat or build the current-folder responder in-process for local configuration. | `--agent`, `--conversation`, `--local`, `--configure` |
| `install-skill` | Copy the authoring composer to coding harnesses, or check/update managed project-local skills. | `--target claude\|codex\|both`, `--force`, `--project`, `--check`, `--update` |
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
MONO_AGENT_TELEGRAM_BOT_TOKEN=123456:ABC mono-agent start
```

Background commands (`start`, `restart`, `stop`, `status`, `logs`) require macOS (launchd). On other platforms use `mono-agent start --foreground`. See [Sessions & concurrency](/runtime/sessions-concurrency/) for how the background worker keeps conversations alive.

## `init`

Scaffolds a new agent in the current folder. Existing `mono-agent.config.json`, `IDENTITY.md`, and `.mono-agent/` scaffold files are kept, not overwritten. Generated scaffold targets and their parent chain must remain inside the agent directory and cannot be symbolic links; this write-time check also applies to **Save incomplete**, so recovery cannot bypass staging through a linked capability directory. Guided secret setup is the deliberate exception: after masked entry and review, it may harden/update `.env` and `.gitignore` under the transaction below.

On an interactive terminal with **no flags**, `init` launches the readiness-proven wizard. Pick a preset or custom setup, choose the public display name, and answer the same model, effort, fallback, channel, memory, tool/safety, and observability questions either way. Escape moves back one logical step; Ctrl-C asks before exiting. Primary and fallback pickers are real autocomplete fields over every bundled model for the guided Pi providers (Anthropic, GitHub Copilot, OpenAI Codex, and OpenCode-Go), Codex's live `model/list` catalog, the isolated Claude SDK catalog, and local discovery. Other hand-authored Pi refs remain compatible but are not advertised as guided cloud integrations. Catalog availability, credential detection, and live verification are separate. A live Codex provider default leads when available; curated Terra is the offline fallback. That offline entry exposes no guessed effort metadata, so it offers only **Provider default** until live discovery succeeds. GPT-5.6 Sol is selectable through direct Codex or Pi OpenAI-Codex.

The default **Allow all tools** choice means every built-in shell/file/web tool and every enabled channel's send/ask tool. For Pi/Claude the wizard states that scope before confirmation and requires a second explicit confirmation when no enforceable sandbox constrains it. Direct `codex:*` requires exact allow-all at the mono-agent layer and uses Codex's own sandbox. Use Pi when exact mono-agent roots, deny-write globs, or network policy must cover every attempt; per-route-native mixes only after the non-Pi contracts are shown and accepted.

Fallback choice is not capped. Canonical `runtime.fallbacks` stores a model plus optional effort per route; omission means provider default. `runtime.routeSafety: "uniform"` is the compatibility default and requires one common monotonic contract. Explicit `per-route-native` permits mixed Pi/Claude/Codex/OpenCode routes after a default-No review of the route matrix. Pi keeps mono-agent tools and optional SRT, Claude uses representable provider-native controls, and direct Codex/OpenCode use provider-native safety plus exact allow-all. Required capabilities are never silently removed.

The wizard separates three states:

- **Catalog available** — the model is selectable; this says nothing about authentication.
- **Credential detected** — Codex/Claude status or the Pi store contains a credential. Setup can skip redundant auth, but readiness is still pending.
- **Verified** — the exact selected route returned non-empty text in its disposable no-tool/no-MCP turn. Every selected route must verify before **Agent ready**.

After provider authentication/setup, the wizard stages the complete selected-capability configuration **before any real or potentially billed model route call**. It checks the effective post-init files (including existing files init preserves), channels, memory, tools, sandbox, observability, and secret-persistence feasibility; only a `waiting` credential that the exact live route can prove is deferred. A configuration failure prints the actionable capability detail and opens seeded repair at the implicated section when it is unambiguous. It does not misroute a cron or other capability error into authentication/model recovery. For cron, the five-field UTC expression is validated inline before `cron/digest.md` is scaffolded, and preflight includes every existing regular `cron/*.md` job that init will preserve.

Once configuration passes, routes run sequentially (90 seconds cloud / 240 seconds local per route). Escape or Ctrl-C interrupts status, sandbox, configuration, final-validation, and route preflights; interactive authentication uses Ctrl-C only so the parent does not compete with the provider child for terminal input. Cancellation waits for staging cleanup and opens the explicit resume/restart/edit/cancel recovery menu: configuration cancellation never advances into a model call, while later cancellation never advances to the next route or scaffold write. Recovery can resume verified routes and incomplete setup only when the non-secret plan fingerprint still matches, restart all checks while keeping completed auth/SRT setup, edit choices, or cancel without writing. Editing unrelated capabilities preserves the route-plan proofs; changing any route or effort invalidates all of them, and credential changes do the same. Ordinary route failures are collected so the final summary shows every result. Auth repair forces the relevant flow even if a credential was detected. An incomplete save never claims readiness or auto-starts.

Before setup, **Creation review** names the agent and lists routes/efforts, safety contracts, provider and SRT actions, exact files/secret destinations, total real model calls, and potentially billed calls. The prompt is `Create “<name>”?`; its primary action says **Run setup and readiness checks, then create agent** only when setup is needed, otherwise **Run readiness checks, then create agent**. **Edit choices** and **Cancel without writing** remain available.

With `--yes` or any flag, or without a TTY, `init` is scaffold-only: explicitly requested `--auth` may run, but the command never executes the all-route readiness proof or labels the result ready. `mono-agent setup` is an alias of `init`.

| Flag | Effect |
| --- | --- |
| `--name <display-name>` | Write public `agent.name`; never used for paths, service ids, sessions, or provider identity. |
| `--preset <id>` | Seed a blueprint from a saved preset (see [Presets & capability modules](/reference/recipes/)). Skips the wizard. |
| `--with <csv>` | Add channels on top of the preset/default config. Valid values: `telegram`, `slack`, `webhook`, `openaiApi`, `cron`. |
| `--yes` | Write the default/preset scaffold without prompting. |
| `--auth` | Opt in to provider setup before writing files: Claude, direct Codex, supported Pi OAuth/OpenCode-Go key flows, and local-provider preflight. Detected credentials are reused unless repair is forced. Ignored by `--dry-run`. |
| `--dry-run` | Preview the files that would be created without writing or validating. |
| `--model <ref>` | Seed the primary model reference (default `codex:gpt-5.6-terra`). |
| `--fallback <ref>` | Add one canonical fallback route; repeat without a product-imposed count limit. |
| `--fallback-effort <provider-default\|level>` | Configure the immediately preceding `--fallback`. |
| `--fallback-models <csv>` | Legacy global-effort-inheriting fallback form. Mutually exclusive with `--fallback`. |
| `--route-safety uniform\|per-route-native` | Select common monotonic or explicit provider-native route contracts. |
| `--codex-auth browser\|device` | Direct Codex login mode; `device` uses headless device auth. |
| `--effort <level>` | Write primary `runtime.effort`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`. |
| `--memory lite\|journal\|bujo` | Pick the memory tier to scaffold. Any other value errors. |

Init model references look like `claude:claude-sonnet-4-6`, `codex:gpt-5.6-terra`, `codex:gpt-5.6-sol`, or `pi:<provider>:<model>` (e.g. `pi:openai-codex:gpt-5.6-terra`, `pi:openai-codex:gpt-5.6-sol`, `pi:opencode-go:kimi-k2.6`, `pi:ollama:gemma4:31b`, or `pi:lmstudio:<model>`). The wizard's manual Pi path asks separately for provider id and model id. Its supported ids are `anthropic`, `github-copilot`, `openai-codex`, `opencode-go`, `ollama`, and `lmstudio`; other Pi providers require hand-authored configuration. It does not create a generic `pi:openai:*` shortcut. The wizard discovers OpenCode-Go models through a five-second-bounded `opencode models opencode-go --pure` run in disposable private XDG state, accepts only `opencode-go/` entries, and records them as `pi:opencode-go:<model>` for Pi SDK setup. Direct `opencode:<provider>:<model>` remains an advanced scaffold/hand-authored runtime backend; guided primary/fallback/repair selection rejects it because the wizard does not claim readiness for that native permission surface.

```bash
mono-agent init                              # interactive wizard on a TTY
mono-agent init --preset telegram-assistant --yes
mono-agent init --name "Research Companion" \
  --model pi:openai-codex:gpt-5.6-terra --effort high \
  --fallback codex:gpt-5.6-sol --fallback-effort xhigh \
  --fallback pi:ollama:gemma4:31b --fallback-effort provider-default \
  --route-safety per-route-native \
  --memory bujo
```

The generated config matches [the config blueprint](/config/blueprint/). See [Backends](/runtime/backends/) for the model reference grammar, [Fallback](/runtime/fallback/) for the chain, [Capture & recall](/memory/capture-and-recall/) for the memory tiers, and [Presets & capability modules](/reference/recipes/) for the wizard's tools step and the no-tools guardrail.

The deprecated `--recipe <id>` flag still works: it maps a retired recipe id to the preset that replaced it (with a deprecation notice), or errors with a pointer to the wizard for the fully-retired blueprints. See [Deprecations](/reference/recipes/#deprecations).

### Secret persistence

Selected required secrets are entered through masked prompts and values never appear in config JSON, `.env.example`, review output, logs, or file-change summaries. Existing non-empty `.env` assignments and comments are preserved. A shell-only selected secret does not skip the prompt: background start cannot inherit that shell, so the entered value must match every non-empty shell/dotenv copy and is persisted when the dotenv value is missing. Any mismatch blocks readiness and start.

The guided proof does not inherit shell-only provider keys or `MONO_AGENT_*` config overrides. It combines durable `.env` values with entered selected secrets, the resolved Pi auth path, and operational host state (`PATH`, `HOME`, and equivalent platform variables), then reuses that environment for the model check, staged/post-write validation, and immediate foreground or background preflight. Persisted non-secret `MONO_AGENT_*` overrides are rejected by exact name so they cannot silently replace wizard choices. After validation, the wizard rechecks the exact committed config plus `.env` mode, ignore status, and Git tracking immediately before it can print **Agent ready** or start the process.

Before writing on POSIX, init canonicalizes the target directory and requires it to be current-user-owned and not group/world-writable. Existing `.env` and `.gitignore` paths must be current-user-owned single-link regular files; `.env` must be untracked and neither path may be a symlink. Init adds exact root ignore rules for `.env` and its transaction temp/recovery names, removes group/world write access from the ignore guard, renders each entered value through the same dotenv parser used at runtime, and rejects malformed, conflicting, empty, NUL-containing, or non-round-trippable input. Every non-empty secret-shaped provider value already consumed from durable `.env` also triggers this preflight, `0600` mode tightening, and tracked-file refusal. Updates use an external owner-only transaction lock, an exclusive same-directory temporary file, flush, concurrent-change checks, and pathname no-clobber promotion. A pathname-based competitor remains at the target. The claimed inode is rechecked before installation and cleanup; if a write through an already-open descriptor is detected, both paths are reported and the bytes remain in an owner-only recovery copy. A non-cooperative POSIX writer that starts after the final check cannot be guaranteed. Hard-linked/foreign-owned paths, newly tracked `.env`, stale locks that cannot be proven safe, and unverifiable owner-only permissions fail closed; Windows therefore receives manual instructions and no automatic secret write. Never copy `.env.example` over an existing `.env`.

The result reports each path as created, updated, unchanged, or planned (dry run). `secretsPersisted` is true only after a changed `.env` was committed; a dry run or refusal never reports success.

## `auth login`

```bash
mono-agent auth login openai-codex
mono-agent auth login opencode-go                # masked TTY prompt
printf '%s\n' "$OPENCODE_API_KEY" | mono-agent auth login opencode-go --api-key-stdin
mono-agent auth login codex --codex-auth browser
mono-agent auth login codex --codex-auth device
```

Supported Pi login targets are `anthropic`, `github-copilot`, and `openai-codex` through their bundled OAuth flows, plus the `opencode-go` API-key flow. Other Pi runtime refs remain hand-authored configuration and are not implied interactive-login targets. Direct Codex is a separate `codex` target and never writes the Pi auth store. Pi path precedence is:

1. `--pi-auth-path`
2. `MONO_AGENT_PI_AUTH_PATH`
3. `providers.piAuthPath`
4. Pi default `~/.pi/agent/auth.json`

`~` expands to the current user's home directory. Relative values from the flag, environment, or config resolve against the agent/invocation working directory before the Pi OAuth flow is staged, so discovery, login, validation, readiness, and runtime all address the same absolute store. A missing config falls through to env/default resolution; a malformed or unreadable config is an error and never silently falls through.

Pi login never runs an unpinned global Pi command. mono-agent launches an app-owned terminal wrapper around the bundled Pi provider OAuth implementation against a private staged `auth.json`, validates the requested credential and unchanged siblings, then promotes under an owner-only identity-bound lock. Anthropic races its localhost callback against an active terminal prompt: a pasted final redirect URL is passed intact to Pi, which requires its authorization code and validates OAuth state before exchange. OpenCode-Go uses a masked prompt on a TTY; `--api-key-stdin` accepts exactly one explicitly redirected, bounded line for a headless invocation and is rejected for OAuth providers. Ambient `OPENCODE_API_KEY` is never copied implicitly. A pre-existing lock is removed only when its secure record remains identity-stable and the recorded PID is proven absent with `ESRCH`; active, permission-denied, malformed, or racing locks are preserved. Automatic credential persistence refuses Windows and Pi auth paths inside Git worktrees.

Exit codes are `0` for successful login/promotion, `1` for login/validation/persistence failure, `2` for invalid usage or an unavailable auth method, and `130` when masked input is cancelled.

## `sandbox`

```bash
mono-agent sandbox status
mono-agent sandbox setup
mono-agent sandbox check
```

`setup` is macOS-only and installs pinned SRT dependencies into a private per-user cache without changing `PATH`, global npm packages, or system packages. `status` verifies install integrity (or a compatible external command when no managed path exists). `check` runs deterministic filesystem and localhost/domain enforcement probes. A corrupt managed install never falls back to `PATH`; runtime commands revalidate the managed tree and fail closed.

## `presets`

Presets are saved wizard answer-sets. `presets list` shows the ids, titles, descriptions, and risk levels; `presets show <id>` prints the generated `mono-agent.config.json`, any `.env.example` placeholders, scaffolded files, and the validation checklist. `mono-agent recipes …` remains as a deprecated alias.

```bash
mono-agent presets list
mono-agent presets show telegram-assistant
```

## `validate`

Loads every config section and prints a status report. It exits `0` when the configuration is structurally valid, including non-fatal `waiting` sections, and `1` on errors. A clean report says it is ready to start; this is a config/liveness result, not the guided wizard's real all-route proof or full **Agent ready** claim. A report with `waiting` sections instead says it needs attention before start. `mono-agent doctor` is an alias — same flags, same report. By default it reads `mono-agent.config.json` from the current folder; override with `--config <path>`. Use `--consumer <path>` to run the same report against a downstream agent folder without changing the current directory or creating missing memory roots there. With `--consumer`, a relative `--config` points inside the consumer folder and the consumer `.env` is loaded by default. It also honors `--env-file <path>` for the dotenv load above.

```bash
mono-agent validate
mono-agent validate --preset code-sandbox
mono-agent validate --json
mono-agent validate --config ./agents/support.config.json --env-file ./.env.staging
mono-agent validate --consumer ../local-agent-alpha
```

| Flag | Effect |
| --- | --- |
| `--preset <id>` | Also report whether the preset's promised capabilities are live — each expectation is checked against the doctor report. The deprecated `--recipe <id>` alias maps to the replacing preset. |
| `--consumer <path>` | Validate another agent folder read-only. Relative `--config` and `--env-file` paths resolve inside that folder. |
| `--config <path>` | Use a non-default config file. With `--consumer`, relative paths are inside the consumer folder. |
| `--env-file <path>` | Load secrets from a non-default dotenv file. With `--consumer`, relative paths are inside the consumer folder. |
| `--json` | Write exactly one top-level JSON object with `ok: boolean` and `sections` (plus `preset` when requested), with no ANSI or human prose on stdout. Exit `0` exactly when `ok` is true. |

Each section prints a status badge, a label, and its details. The statuses are:

| Status | Meaning |
| --- | --- |
| `ok` | The section is configured and ready. |
| `waiting` | Configured but a runtime dependency is not up yet (e.g. Ollama or Phoenix not reachable), or a credential is missing/expired. Runtime-soft — never blocks start. Advisory detail lines are prefixed `[WARN]`. |
| `disabled` | The section is intentionally off — a channel with `enabled: false`, or no models of a kind that needs this check. Never blocks start. |
| `error` | A structural problem that must be fixed; any `error` section fails the run. |

`validate` runs liveness probes, so it can show `waiting` for unreachable network dependencies. The Phoenix exporter check additionally POSTs an empty protobuf to confirm export compatibility, not just reachability — see [Phoenix & backfill](/observability/phoenix-and-backfill/).

For built-in memory, Journal and BuJo require a valid managed `.index/manifest.json`; only Lite
may remain unmanaged. A missing/corrupt manifest, configured-versus-active tier/model/dimension
mismatch, or native SQLite module/ABI failure is an `error`, not a provider-liveness `waiting`
state. Fresh init creates an empty managed Journal/BuJo generation provider-free; it never changes
a pre-existing memory root. For an existing or damaged root, stop the agent, run
`mono-agent memory rebuild`, then validate again. Ollama/provider
reachability and missing pulled models remain operational `waiting` conditions.

The **Tools & MCP** section reports the tool policy: allow-all (the default) shows `All tools allowed.` (or `All tools allowed (except: …)` when a `disallowedTools` list is present). On Pi/Claude SDK, an **explicit empty** `tools.allowedTools: []` flags the no-tools trap as `waiting` because the agent could chat but cannot act. Direct Codex/OpenCode and Claude Code CLI reject that unenforceable empty policy as `error` before provider startup. Direct OpenCode also rejects every effective MCP source—`tools.mcpConfigPath`, `memory.recallTool`, hosted Supermemory MCP, and adapter send tools—and index skill disclosure; validation reports those combinations before a run. For a specific allowlist it also flags an unknown tool name with a "did you mean" hint (pi silently drops unknown names) and cross-checks adapter send tools against enabled channels. Under a native sandbox it additionally checks the enabled send tools' HTTP hosts against `sandbox.network`: Slack, Telegram (including a custom `apiRoot`), and the loopback interaction bridge for blocking ask tools. A missing host is `waiting` with the exact allowlist entry to add; an explicitly denied tool creates no endpoint requirement. See [Presets & capability modules](/reference/recipes/#the-tools-step-and-the-no-tools-guardrail) for the full contract.

### Provider credentials

`validate` includes a **Provider credentials** section covering the primary `runtime.model`, every canonical `runtime.fallbacks` (or legacy `runtime.fallbackModels`) entry, the `agent-host` `memory.llm` model, and every enabled static webhook/cron model override. Disabled channels/entries are ignored; a dynamic request-body override is checked when the request runs because its value does not exist at validate time. Each Pi runtime ref must resolve through an enabled `providers.local[]` entry or an exact model in Pi's built-in catalog. Built-in Pi credentials resolve against the same effective Pi auth path used by `auth login` (including `MONO_AGENT_PI_AUTH_PATH`); the Pi CLI's ambient sibling `models.json` is not imported by the mono-agent runtime. It never mints tokens or makes a model request. Static validation (`liveness: false`, including start preflight) launches no process. Live validation can detect unprobed SDK credentials with bounded, read-only `codex login status` or `claude auth status --json`, cached once per SDK; detection is not labelled as a verified model turn. During guided init, each exact selected route is promoted to verified only after its own live check succeeds.

- A provider configured through an enabled `providers.local[]` entry needs no OAuth. If it declares `apiKeyEnv`, that variable must resolve to a non-empty key (or an inline fallback must resolve); only providers with no key declaration are reported as intentionally keyless. Disabled provider/model entries are rejected.
- Without `providers.local[]`, the provider/model pair must exist exactly in Pi's built-in catalog. An unknown model is an `error`, even if an ambient `models.json` happens to name its provider.
- A built-in provider absent from the Pi auth store → `waiting`, with a `[WARN]` line and a `mono-agent auth login <provider>` hint.
- An OAuth provider whose access token has **expired** → `waiting`, with a `[WARN]` line noting the expiry and the `mono-agent auth login <provider>` re-auth hint. The credential is not considered ready until a request succeeds.
- If no authenticated model is referenced, the section reports `disabled`; direct Codex installation/login is discovered by the wizard. Read-only status can detect a credential, while only the exact guided route call records `verified`.
- A direct `opencode:<provider>:*` ref is `ok` only when its exact provider key has a valid entry in the standard OpenCode `auth.json`, the native migration marker exists, and live validation verifies stable OpenCode CLI >=1.15.0. Static/start preflight stays process-free and reports the CLI version as unverified (`waiting`).

This catches the class of silent failure where an expired OAuth token quietly breaks fallbacks, crons, or memory capture without a structural config error. Standalone `validate` keeps `waiting` non-fatal for partial operator-managed configurations, but the guided **Agent ready** gate requires every selected expectation to be `ok` and will not offer start otherwise.

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
mono-agent memory audit --json
mono-agent memory audit --strict --json
mono-agent memory inspect --json
mono-agent memory inspect <64-character-id> --json
mono-agent memory retry --json
mono-agent memory retry <64-character-id> --json
mono-agent memory resolve <64-character-id> <reason-slug> --json
mono-agent memory rebuild --json
mono-agent memory rollback --json
```

| Subcommand | Effect |
| --- | --- |
| `stats` | Shows backend, configured tier, write mode, recall-tool state, local root, memory/entity counts, store sizes, last capture/access/consolidation signals, and top entities. For Supermemory it reports the known remote endpoint/container and explicitly lists fields that are not knowable locally. |
| `today` | Renders today's local BuJo daily log. |
| `show <YYYY-MM-DD>` | Renders one local BuJo daily log by date. Both current `daily/YYYY-MM-DD.md` and older root-level `YYYY-MM-DD.md` layouts are recognized. |
| `search <query>` | Uses the same recall-store construction as `MemoryRecall`. Local BuJo/journal search returns scores plus sources; if configured embeddings are unavailable, it retries FTS-only and prints a warning. Supermemory search proxies the remote API. |
| `top` | Shows highest-salience local BuJo/journal memories with salience, type/status, and source. Supermemory has no local salience ranking, so it tells you to use search. |
| `audit` | Without `--strict`, emits detailed local operator telemetry: counts, bytes, duplicate ratio, vector coverage, access concentration, active generation/source accounting, configured paths/source locations, and available runtime queue/backlog/shutdown plus embedding/LLM call counts. With `--strict`, emits the exact provider-free content-free health schema: `schemaVersion`, `backend`, built-in `mode`, `status`, `checkedAt`, closed `issues`, and all eight closed `counts`. |
| `inspect [<id>]` | Reads built-in completed-turn intake metadata. It returns ids, state/timestamps, attempt/revision, due flags, bounded failure categories, and aggregate counts—never run/conversation ids, payload hashes, summary/capture text, paths, or raw errors. The optional id is exactly 64 lowercase hex characters. |
| `retry [<id>]` | With the configured agent stopped, moves selected dead letters back to pending and/or makes delayed pending work due. Omitting the id selects all eligible items. It does not process the work; start the store afterward. Check JSON `changed`/`retried`, because a successful no-op exits `0`. |
| `resolve <id> <reason>` | With the agent stopped, explicitly retires one pending/dead item as `operator_resolved` without claiming capture succeeded. The lowercase 1–64 character slug starts with a letter/digit, then permits letters/digits/underscores/hyphens. Permanent duplicate protection remains, retained semantic plans are refused, and a missing/already-resolved id is a successful `changed: false` no-op. |
| `rebuild` | Built-in Lite/Journal/BuJo only. Refuses a running configured agent, builds and fully validates a side-by-side generation from canonical files, then atomically activates it. It retains the previous generation only when that index has exact canonical-source parity (a Journal vector backlog is recoverable); a source-ahead/stale index is omitted rather than mislabeled as rollback-safe. It uses configured embeddings when the tier requires them and never calls a chat LLM. |
| `rollback` | Built-in Lite/Journal/BuJo only. Atomically swaps to the retained generation after verifying its tier/model/dimension and source fingerprint. Restore the prior config identity first when those settings changed. No embedding or chat-model request is made. |

| Flag | Effect |
| --- | --- |
| `--limit <n>` | Limits search hits, top memories, and stats entity preview rows (1-100). |
| `--strict` | Supported only with `memory audit`. `healthy`, `in_progress`, and `not_configured` exit `0`; `degraded`, `unhealthy`, and `unknown` exit `1`; flag/argument misuse exits `2`. |
| `--json` | Prints the machine-readable result instead of the human view. |
| `--config <path>` | Use a non-default config file. |
| `--env-file <path>` | Load secrets from a non-default dotenv file before resolving the config. |

Stop the configured agent before `retry`, `resolve`, `rebuild`, or `rollback`; each mutation also acquires the memory writer lease. `inspect` is read-only and can run live. Intake commands and index transitions reject Supermemory because that service owns its remote state. The strict audit itself makes no embedding/chat/provider request and never emits paths, filenames, ids, payloads, model text, raw errors, or arbitrary extras. See the [strict health and recovery contract](/memory/validation-and-cli/#strict-provider-free-health-gate), the [safe generation model](/memory/validation-and-cli/#safe-index-generations-rebuild-and-rollback), and the separate [product-v1 cutover checklist](/memory/validation-and-cli/#enable-v1-on-an-existing-agent).

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
mono-agent tui --local                  # current folder, no daemon
mono-agent tui --local --configure      # ask how to configure this agent
```

| Flag | Effect |
| --- | --- |
| `--agent <label\|sourceId>` | Connect to a specific running instance; errors with the available list when there is no match. |
| `--conversation <id>` | Conversation id for the chat (default `tui-<sourceId>`). |
| `--config <path>` | Resolve a custom `traceability.registryDir` from this config (for agents registered outside the global registry). |
| `--local` | Build the current folder's configured responder in-process. No channel service or launchd state is created. |
| `--configure` | Start a real recorded configuration invitation turn. Requires `--local`; `/configure` re-enters later. |

The remote live-chat connection uses the agent's [`tui` channel](/channels/tui/) (on by default); an agent with the channel disabled still gets replay and config views. Local configuration is OS-owner scoped: the folder and single-link config must be current-user-owned and not group/world writable; config, Identity, and `.mono-agent` transaction paths cannot traverse symlink parents. `ProposeAgentConfiguration` exists only for the marked local configuration turn. It can propose an RFC 6902 config patch and optional `## Role` body, but cannot write. That turn replaces ordinary action tools and configured MCP servers with a request-scoped read-only/proposal policy. The host uses a positive allowlist for public name, effort/turn/session UX, selected project skills/disclosure, memory size/MemoryRecall enablement, and tool-policy tightening; all paths, authority/network/provider surfaces, secrets, and unknown fields require the guided flow. Approval requires a separate TUI confirmation and performs the final exact source comparison plus rename without yielding after the replacement is staged and fsynced; queued input waits through the settled hook and responder rotation.

## `web`

Serves the read-only [Session Recorder web PWA](/observability/) from any directory. It discovers running agents through the same trace-source registries as `mono-agent tui`, reads their recorded run artifacts, connects to each agent's default-on `live` event relay when available, and streams session updates to the browser.

```bash
mono-agent web
mono-agent web --port 4599 --no-open
mono-agent web --host 0.0.0.0 --allow-non-loopback
mono-agent web --include-memory
mono-agent web --max-runs 500
```

For stable authenticated startup, put
`MONO_AGENT_WEB_AUTH_TOKEN=<strong-stable-token>` in the invocation folder's
owner-only `.env` (`chmod 600 .env`), then run the non-loopback command above.

| Flag | Effect |
| --- | --- |
| `--host <addr>` | Bind address for the PWA backend (default `127.0.0.1`). |
| `--port <n>` | Bind port (default `4599`, printed on start for reverse-proxy targets). |
| `--no-open` | Do not launch the browser after the backend starts. |
| `--allow-non-loopback` | Permit a non-loopback bind. `/api/*` and `/api/stream` require a bearer token: `MONO_AGENT_WEB_AUTH_TOKEN` for non-interactive/service use, or an interactively generated one-run token. |
| `--show-auth-url` | Reveal a configured token in the printed URL fragment. This opt-in works only when stdout is an interactive terminal; redirected/service output stays redacted. |
| `--include-memory` | Include memory-maintenance runs from both the `memory/` artifact namespace and legacy mixed directories. Defaults to agent runs only. |
| `--max-runs <n>` | Cap the per-instance in-memory working set and the initial browser snapshot (positive integer, default `200`). Disk paging via "Load older" still reaches the full on-disk history, so this only bounds memory — not history reachability. |
| `--config <path>` | Resolve a custom `traceability.registryDir` from this config, in addition to the global registry. |

Run history and live updates default to agent runs only; memory-maintenance runs are hidden plumbing unless you pass `--include-memory`. Loopback remains the default. With `--host 0.0.0.0 --allow-non-loopback`, startup prints usable loopback plus discovered private LAN and Tailscale IPv4 URLs instead of advertising `0.0.0.0`. Put a stable `MONO_AGENT_WEB_AUTH_TOKEN` in the invocation folder's owner-only `.env` (or the file selected by `--env-file`) for bookmarks and long-running services; a configured token is honored on loopback too. Non-interactive non-loopback startup refuses to generate a secret that would land in logs. Authenticated mode sends API and stream credentials only in the `Authorization` header. Explicitly revealed bootstrap URLs put the token in the URL fragment, which browsers do not send in HTTP requests or access logs, and the PWA removes it after capture.

Each discovered instance also carries an independent memory-health badge: healthy (green), in
progress (teal), degraded (amber), unhealthy (red), unknown/off (gray). Its accessible label and
tooltip contain only the status and stable closed issue codes. A memory-only registry change emits
an `instances` SSE frame, so the badge updates without requiring a process-health change or a new
run.

Direct authenticated HTTP over LAN or Tailscale does **not** require `tailscale serve`. Serve is optional; use it (or another HTTPS reverse proxy) only when you want HTTPS-dependent browser capabilities such as an installable/offline PWA. Non-loopback mode remains read-only but exposes prompts, cwd/artifact paths, tool events, and run text to anyone with the bearer token, so use a strong token and a trusted network boundary. Plain LAN HTTP is not transport-encrypted; direct access through Tailscale remains protected by the tailnet transport.

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
| `--project` | Operate on `skills/mono-agent-configure` and `skills/mono-agent-memory` in the current agent folder. |
| `--check` | Report version/hash drift without writing. Requires `--project`. |
| `--update` | Back up and atomically update missing/stale unchanged managed copies. Refuses modified/colliding copies. Requires `--project`. |

```bash
mono-agent install-skill                       # both targets
mono-agent install-skill --target claude --force
mono-agent install-skill --project --check
mono-agent install-skill --project --update
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
