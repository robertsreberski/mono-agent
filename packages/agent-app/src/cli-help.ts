import { createRequire } from "node:module";

import { EFFORT_LEVELS } from "@mono-agent/config";

import { readinessProbeTimeoutDescription } from "./readiness-probe.js";
import * as ui from "./ui.js";

interface HelpEntry {
  readonly signature: string;
  readonly lines: readonly string[];
}

const HELP_COMMANDS: readonly HelpEntry[] = [
  {
    signature: "mono-agent init [--preset <id>] [--with <csv>] [--yes] [--auth] [--dry-run]\n" +
      "                [--name <display-name>] [--model <ref>] [--effort <level>]\n" +
      "                [--fallback <ref> [--fallback-effort <provider-default|level>]]...\n" +
      "                [--fallback-models <csv>] [--route-safety uniform|per-route-native]\n" +
      "                [--codex-auth browser|device] [--memory lite|journal|bujo]",
    lines: [
      "Fast scaffold-only path: flags or non-TTY input; without explicit --auth,",
      "it makes no provider call and never claims readiness. Bare init on a TTY runs",
      "a real no-tool model call per selected route before committing the scaffold,",
      `with timeouts of ${readinessProbeTimeoutDescription()}.`,
      "--preset seeds a blueprint; --with adds channels.",
      `Effort levels: ${EFFORT_LEVELS.join(", ")}; an omitted fallback effort uses that provider's default.`,
      "--fallback-models is deprecated and will be removed in v2.0.0; repeat --fallback for new scripts.",
      "Reasoning-capable pi:* maps ultra to LOW; Pi without reasoning uses OFF; direct codex:* forwards ultra unchanged.",
      "Mono-agent rejects ultra on its Claude SDK route because the pinned SDK public contract ends at max (the SDK JavaScript itself forwards the value).",
      "The Claude CLI route passes --effort ultra, but both tested Claude Code binaries (SDK-bundled 2.1.206 and local 2.1.210) warn that it is unknown, ignore it, and use default effort.",
      "Direct OpenCode rejects explicit effort. Ranking above max only prevents keyword downgrade.",
      "--auth runs supported provider auth/preflight before writing; --codex-auth device supports headless hosts.",
      "--dry-run previews only. Existing scaffold/config files are not overwritten;",
      "guided secret setup may securely update .env and .gitignore after explicit review.",
    ],
  },
  {
    signature: "mono-agent setup",
    lines: ["Alias of `init`."],
  },
  {
    signature: "mono-agent presets list | show <id>",
    lines: [
      "List the built-in setup presets, or show one's generated config,",
      ".env.example, and follow-up checklist.",
    ],
  },
  {
    signature: "mono-agent validate [--preset <id>] [--consumer <path>] [--config <path>] [--env-file <path>] [--json]",
    lines: [
      "Load every config section and report what would run, wait, or fail.",
      "--consumer validates another agent folder read-only, including its .env.",
      "With --preset, also report whether the preset's capabilities are live.",
      "`mono-agent doctor` is an alias for this command.",
    ],
  },
  {
    signature: "mono-agent auth login <provider|codex> [--pi-auth-path <path>] [--api-key-stdin]\n" +
      "                       [--codex-auth browser|device] [--config <path>]",
    lines: [
      "Run a supported bundled Pi provider login, or direct Codex browser/device login.",
      "Pi credentials are promoted with owner-only no-clobber checks.",
      "API-key providers prompt securely on a TTY; --api-key-stdin explicitly reads a redirected secret.",
      "Path precedence: --pi-auth-path, MONO_AGENT_PI_AUTH_PATH, providers.piAuthPath, then Pi's default.",
      "Supported Pi targets: anthropic, github-copilot, openai-codex, and opencode-go.",
    ],
  },
  {
    signature: "mono-agent sandbox status | setup | check",
    lines: [
      "Inspect, install, or functionally prove the pinned SRT sandbox runtime.",
      "Managed setup is macOS-only and installs into the user's cache; it never changes PATH,",
      "global npm packages, system packages, or another user's files.",
    ],
  },
  {
    signature: "mono-agent config [--config <path>] [--env-file <path>]",
    lines: [
      "Print the resolved config field-by-field, tagging each value with where",
      "it came from (env / json / default), plus the channel summary. Read-only.",
    ],
  },
  {
    signature: "mono-agent start [--config <path>] [--env-file <path>] [--foreground|-f]",
    lines: [
      "Start the agent as a background macOS service (launchd), print its",
      "instance info, and return. Re-running restarts the running instance.",
      "Refuses to start without a valid mono-agent.config.json in the folder.",
      "Use --foreground (-f) to run in the blocking foreground instead.",
    ],
  },
  {
    signature: "mono-agent restart [--config <path>] [--force]",
    lines: [
      "Restart the background instance for this config (starts it if stopped).",
      "--force clears persisted pi sessions and active conversation history so",
      "the agent starts fresh. Durable memory and run artifacts are untouched.",
    ],
  },
  {
    signature: "mono-agent stop [--config <path>]",
    lines: ["Stop the background instance and remove its LaunchAgent."],
  },
  {
    signature: "mono-agent status [--config <path>]",
    lines: ["Show this config's instance plus any other running instances."],
  },
  {
    signature: "mono-agent logs [--config <path>] [--follow|-f] [--lines <n>]",
    lines: ["Print (and optionally follow) the background instance's log files."],
  },
  {
    signature: "mono-agent tui [--agent <label|sourceId>] [--conversation <id>]\n" +
      "               [--configure | --local]",
    lines: [
      "Open the operator console from any directory: live chat with structured",
      "thinking/tool/telemetry insight, recorded-run replay, and config view.",
      "Discovers running agents via the trace-source registry; one running",
      "agent connects directly, several open a picker.",
      "--configure opens the guided configuration chat on the authoritative",
      "background agent; --local is an ordinary in-process chat only.",
    ],
  },
  {
    signature: "mono-agent web [--host <addr>] [--port <n>] [--no-open] [--allow-non-loopback] [--show-auth-url] [--include-memory] [--max-runs <n>] [--config <path>] [--env-file <path>]",
    lines: [
      "Serve the read-only Session Recorder web PWA from any directory: a live",
      "flight-recorder over every agent's runs (prompt, reasoning, tools, cost).",
      "Discovers running agents via the trace-source registry — the same",
      "mechanism as `tui` — and streams new/updated runs in real time.",
      "--include-memory also shows memory-maintenance runs. --max-runs (default",
      "200) bounds the in-memory working set; the UI still pages the full",
      "on-disk history via \"Load older\".",
      "Non-loopback service use requires MONO_AGENT_WEB_AUTH_TOKEN; an",
      "interactive run may generate one. --show-auth-url reveals a configured",
      "token only to an interactive terminal. Authenticated URLs are not",
      "auto-opened through process arguments.",
    ],
  },
  {
    signature: "mono-agent install-skill [--target claude|codex|both] [--force]\n" +
      "                         --project (--check|--update)",
    lines: [
      "Copy the bundled mono-agent-composer skill into ~/.claude/skills and",
      "~/.agents/skills (default: both). Refuses to overwrite without --force.",
      "Project mode checks or safely updates the two managed skills generated",
      "by init; modified copies are never overwritten and updates retain backups.",
    ],
  },
  {
    signature:
      "mono-agent backfill (--run <id> | --all) [--since <iso>] [--until <iso>]\n" +
      "                    [--include-memory] [--dry-run] [--config <path>] [--env-file <path>]",
    lines: [
      "Export already-recorded agent-run artifacts to the configured Phoenix exporter",
      "with their historical timestamps. Trace ids are deterministic per run, so",
      "re-running overwrites rather than duplicating. --dry-run maps and",
      "serializes without sending. --include-memory adds memory-run artifacts",
      "for --all; explicit --run can target a memory run directly.",
    ],
  },
  {
    signature:
      "mono-agent audit-runs [--artifact-dir <path> | --consumer <path>]\n" +
      "                      [--include-memory] [--config <path>] [--env-file <path>] [--stale-after-ms <n>] [--json]",
    lines: [
      "Read local agent-run summary artifacts without rewriting them. Reports parse",
      "failures, status and failure-kind histograms, stale running summaries,",
      "and per-failure-kind rates. --include-memory includes memory-run artifacts.",
    ],
  },
  {
    signature:
      "mono-agent metrics [--artifacts <path>] [--since <iso>] [--until <iso>]\n" +
      "                   [--include-memory] [--by model|channel|failureKind] [--json] [--config <path>] [--env-file <path>]",
    lines: [
      "Aggregate local agent-run summaries into status rates, failure-kind rates,",
      "duration percentiles, and total/per-run cost. Read-only and offline.",
      "--include-memory includes memory-run artifacts.",
    ],
  },
  {
    signature:
      "mono-agent memory [stats|today|show <date>|search <query>|top|audit|inspect [id]|retry [id]|resolve <id> <reason>|rebuild|rollback|adopt-replay]\n" +
      "mono-agent memory forget prepare --ids-file <file> --reason <slug> --plan <file>\n" +
      "mono-agent memory forget apply --plan <file> | forget restore --backup <dir>\n" +
      "                  [--limit <n>] [--strict] [--json] [--config <path>] [--env-file <path>]",
    lines: [
      "Preview the configured memory store from an agent folder. Reads the",
      "memory block from mono-agent.config.json, not the standalone memory-bujo",
      "env workflow. Human-first output by default; audit --strict --json is a",
      "metadata-only health gate. Intake inspect/retry/resolve never print payload content.",
      "adopt-replay is an explicit stopped-agent, SSH-safe BuJo trust-on-first-use",
      "operation. It returns metadata only and requires rebuild before restart.",
      "forget uses an explicit, content-free plan plus a full owner-private backup;",
      "apply and restore require the configured agent to be stopped.",
    ],
  },
  {
    signature:
      "mono-agent continuations [list [--limit <n>] [--cursor <opaque>]|health|retry <id>|cancel <id>|resolve <id> delivered|not-delivered|dead-lettered [delivery-id]] [--json]",
    lines: [
      "Inspect and operate the authenticated durable-continuation service.",
      "Ambiguous delivery cannot be retried until it is explicitly resolved;",
      "no command accepts or changes a channel destination.",
    ],
  },
];

const HELP_NOTES = `Background mode runs the agent under launchd, keeping it alive across logins
(auto-restarting only on crash) until you run stop. Secrets are read from the
.env file in the working directory, the same as foreground mode. The background
commands require macOS; elsewhere use start --foreground.

Init model references look like pi:<provider>:<model>, claude:claude-sonnet-4-6,
codex:gpt-5.6-terra, codex:gpt-5.6-sol, or opencode:<provider>:<model>. The init wizard
selects the live provider-declared default when available and falls back offline to
codex:gpt-5.6-terra. Direct and Pi OpenAI-Codex Sol choices remain selectable.
Direct GPT-5.6 routes require Codex CLI 0.144.0 or newer. Guided Pi authentication
covers Anthropic, GitHub Copilot, OpenAI Codex, and OpenCode-Go. Claude remains selectable;
direct opencode:<provider>:<model> refs are for
hand-authored runtime backend config and are rejected by guided selection/readiness.

Mixed fallback chains are allowed. runtime.routeSafety=uniform (the default)
requires one compatibility-preserving contract across every route;
per-route-native makes each route's exact safety boundary explicit (Pi SRT,
Claude provider-owned permissions, Codex native sandbox, or OpenCode native).

Native mono-agent srt policy is enforced by Pi-owned tools. In uniform mode,
Claude, direct Codex, and direct OpenCode cannot silently weaken that policy.
In per-route-native mode, validate reports each provider-owned safety contract
and rejects capabilities that the selected route cannot represent.
Direct OpenCode's bridge cannot enforce an explicit runtime.effort; omit effort and
configure runtime.permissionMode deliberately for hand-authored direct routes.
It is per-run/non-resumable and rejects MCP (including auto-provisioned memory
or send tools), positive maxTurns, index skill disclosure, structured output,
live input, fast mode, and native subagents instead of silently dropping them.

A .env file in the current folder is loaded automatically when present;
already-exported shell variables take precedence.
`;

/** Build the colorized help screen (plain text when color is disabled). */
export function renderHelp(): string {
  let out = ui.banner("mono-agent", "config-first agent host") + "\n";
  out += ui.heading("Usage");
  for (const entry of HELP_COMMANDS) {
    const [first, ...rest] = entry.signature.split("\n");
    out += `  ${ui.style.bold(ui.style.cyan(first ?? ""))}\n`;
    for (const cont of rest) {
      out += `  ${ui.style.cyan(cont)}\n`;
    }
    for (const line of entry.lines) {
      out += `      ${ui.style.dim(line)}\n`;
    }
    out += "\n";
  }
  out += ui.style.dim(HELP_NOTES);
  return out;
}

/**
 * The published CLI version, read from this package's own package.json at
 * runtime. `../package.json` resolves the same from both `src/cli.ts` (tests) and
 * the built `dist/cli.js` (one level below the package root in both layouts), and
 * npm always ships package.json in the tarball. Best-effort: a read failure yields
 * "unknown" rather than crashing `--version`.
 */
export function monoAgentVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}
