import process from "node:process";

import {
  EFFORT_LEVELS,
  MAX_AGENT_NAME_LENGTH,
} from "@mono-agent/config";
import type { EffortLevel, RouteSafetyMode } from "@mono-agent/config";

import type { InstallSkillTarget } from "./install-skill.js";
import { INTERNAL_LAUNCHD_LOG_MAINTENANCE_COMMAND } from "./launchd.js";
import type { CodexLoginMode } from "./provider-setup.js";

const PUBLIC_COMMANDS = ["init", "setup", "validate", "doctor", "auth", "sandbox", "config", "recipes", "presets", "start", "restart", "stop", "status", "logs", "tui", "web", "sessions", "install-skill", "backfill", "audit-runs", "metrics", "memory", "continuations"] as const;
const KNOWN_COMMANDS = [...PUBLIC_COMMANDS, INTERNAL_LAUNCHD_LOG_MAINTENANCE_COMMAND] as const;

// `doctor`/`setup`/`recipes` never reach routing: parseCliArgs normalizes them to
// `validate`/`init`/`presets`. `help`/`version` are synthetic commands (not in
// KNOWN_COMMANDS) produced by the `--help`/`-h` and `--version`/`-v` flags before
// command validation.
type CliCommand = Exclude<(typeof KNOWN_COMMANDS)[number], "doctor" | "setup" | "recipes"> | "help" | "version";

export interface ParsedCliArgs {
  readonly command: CliCommand;
  readonly configPath?: string;
  readonly name?: string;
  readonly model?: string;
  /** @deprecated Removed in v2.0.0; use repeated `--fallback` entries. */
  readonly fallbackModels?: readonly string[];
  readonly fallbacks?: readonly CliFallbackArg[];
  readonly routeSafety?: RouteSafetyMode;
  readonly effort?: string;
  readonly memory?: "lite" | "journal" | "bujo";
  /** init/validate: build/check against this preset id. */
  readonly preset?: string;
  /** @deprecated Removed in v2.0.0; use `--preset`. */
  readonly recipe?: string;
  /** init: additional channels to enable on top of the preset/default config. */
  readonly withChannels?: readonly string[];
  /** init: skip the interactive wizard and write the default/preset scaffold. */
  readonly yes?: boolean;
  /** init: opt in to running provider auth/preflight commands before writing files. */
  readonly auth?: boolean;
  /** auth: explicit destination for the Pi auth store. */
  readonly piAuthPath?: string;
  /** auth: explicitly read one API key from redirected standard input. */
  readonly apiKeyStdin?: boolean;
  /** init/auth: direct Codex browser callback or headless device-code flow. */
  readonly codexAuthMode?: CodexLoginMode;
  /** Non-flag arguments (e.g. `presets show <id>`). */
  readonly positionals: readonly string[];
  readonly envFile?: string;
  /** Internal owner-private launchd transport; never a public start option. */
  readonly expectedBackgroundSnapshot?: string;
  /** Internal finalized-runtime proof; never a public start option. */
  readonly expectedManagedRuntimeLaunch?: string;
  readonly target?: InstallSkillTarget;
  readonly force: boolean;
  /** start: run the blocking foreground worker instead of backgrounding. */
  readonly foreground: boolean;
  /** logs: keep streaming new output (tail -F). */
  readonly follow: boolean;
  /** logs: number of trailing lines to print. */
  readonly lines?: number;
  /** backfill: export exactly this run id. */
  readonly run?: string;
  /** backfill: export every recorded run. */
  readonly all: boolean;
  /** backfill: only runs whose startedAt is >= this ISO instant. */
  readonly since?: string;
  /** backfill: only runs whose startedAt is <= this ISO instant. */
  readonly until?: string;
  /** backfill: map + serialize but do not POST. */
  readonly dryRun: boolean;
  /** audit-runs/metrics/backfill/sessions: include memory-run artifacts. */
  readonly includeMemory: boolean;
  /** audit-runs: read this artifact directory directly. */
  readonly artifactDir?: string;
  /** metrics: group totals by this summary dimension. */
  readonly groupBy?: "model" | "channel" | "failureKind";
  /** validate/audit-runs: resolve config, env, artifacts, and checks relative to this consumer folder. */
  readonly consumerPath?: string;
  /** tui: connect to this running agent (label or sourceId) directly. */
  readonly agent?: string;
  /** tui: conversation id to chat under. */
  readonly conversation?: string;
  /** tui: build the current-folder responder in-process. */
  readonly local?: boolean;
  /** tui: start with the conversational configuration invitation. */
  readonly configure?: boolean;
  /** install-skill: operate on the current agent's managed project skills. */
  readonly project?: boolean;
  /** install-skill --project: report drift without writing. */
  readonly check?: boolean;
  /** install-skill --project: safely update unchanged managed copies. */
  readonly update?: boolean;
  /** install-skill: copy the skill without pairing the version-matched documentation MCP. */
  readonly noDocsMcp?: boolean;
  /** audit-runs: override the stale-running cutoff interval. */
  readonly staleAfterMs?: number;
  /** audit-runs: print the full machine-readable report. */
  readonly json?: boolean;
  /** memory audit: fail closed on degraded or unknown health. */
  readonly strict?: boolean;
  /** memory: max rows for search/top/entity preview. */
  readonly limit?: number;
  /** continuations list: opaque keyset cursor from the previous page. */
  readonly cursor?: string;
  /** memory forget prepare: newline-delimited explicit memory ids. */
  readonly idsFile?: string;
  /** memory forget prepare: lowercase operator reason slug. */
  readonly reason?: string;
  /** memory forget prepare/apply: owner-private plan artifact. */
  readonly planPath?: string;
  /** memory forget restore: owner-private backup directory. */
  readonly backupPath?: string;
  /** web/sessions: bind host (web defaults to 0.0.0.0; sessions to 127.0.0.1). */
  readonly host?: string;
  /** web/sessions: bind port (web defaults to 5050; sessions to 4599). */
  readonly port?: number;
  /** web: narrow the default LAN bind to 127.0.0.1. */
  readonly loopback?: boolean;
  /** sessions: `--no-open` sets this false to suppress the browser launch. */
  readonly open?: boolean;
  /** sessions: `--allow-non-loopback` permits a non-loopback bind. */
  readonly allowNonLoopback?: boolean;
  /** sessions: reveal a configured auth token only to an interactive terminal. */
  readonly showAuthUrl?: boolean;
  /** sessions: `--max-runs` caps the per-instance in-memory working set (default 200). */
  readonly maxRunsPerInstance?: number;
}

interface CliFallbackArg {
  readonly model: string;
  readonly effort?: EffortLevel;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { command: "help", positionals: [], force: false, foreground: false, follow: false, all: false, dryRun: false, includeMemory: false };
  }
  if (command === "version" || command === "--version" || command === "-v") {
    return { command: "version", positionals: [], force: false, foreground: false, follow: false, all: false, dryRun: false, includeMemory: false };
  }
  if (!(KNOWN_COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`Unknown command \`${command}\`. Expected ${PUBLIC_COMMANDS.join(", ")}.`);
  }
  // `doctor`/`setup`/`recipes` are aliases; normalize here so every downstream
  // path (routing, env-file resolution, --consumer) applies unchanged. `doctor`
  // → `validate`, `setup` → `init`, `recipes` → `presets`. The deprecated
  // `recipes` branch is removed in v2.0.0; no sunset is set for the other two.
  const cmd = (
    command === "doctor"
      ? "validate"
      : command === "setup"
        ? "init"
        : command === "recipes"
          ? "presets"
          : command
  ) as CliCommand;
  if (
    cmd === INTERNAL_LAUNCHD_LOG_MAINTENANCE_COMMAND
    && !(
      rest.length === 2
      && rest[0] === "--config"
      && rest[1] !== undefined
      && !rest[1].startsWith("--")
    )
  ) {
    throw new Error("The internal launchd log maintenance command accepts only --config <path> and requires it.");
  }
  const isLogs = cmd === "logs" || (cmd === "web" && rest[0] === "logs");

  let configPath: string | undefined;
  let name: string | undefined;
  let model: string | undefined;
  let fallbackModels: readonly string[] | undefined;
  const fallbacks: CliFallbackArg[] = [];
  let canAssignFallbackEffort = false;
  let routeSafety: RouteSafetyMode | undefined;
  let effort: string | undefined;
  let memory: "lite" | "journal" | "bujo" | undefined;
  let preset: string | undefined;
  let recipe: string | undefined;
  let withChannels: readonly string[] | undefined;
  let yes = false;
  let auth = false;
  let piAuthPath: string | undefined;
  let apiKeyStdin = false;
  let codexAuthMode: CodexLoginMode | undefined;
  const positionals: string[] = [];
  let envFile: string | undefined;
  let expectedBackgroundSnapshot: string | undefined;
  let expectedManagedRuntimeLaunch: string | undefined;
  let target: InstallSkillTarget | undefined;
  let force = false;
  let foreground = false;
  let follow = false;
  let lines: number | undefined;
  let run: string | undefined;
  let all = false;
  let since: string | undefined;
  let until: string | undefined;
  let dryRun = false;
  let includeMemory = false;
  let artifactDir: string | undefined;
  let groupBy: "model" | "channel" | "failureKind" | undefined;
  let consumerPath: string | undefined;
  let agent: string | undefined;
  let conversation: string | undefined;
  let local = false;
  let configure = false;
  let project = false;
  let check = false;
  let update = false;
  let noDocsMcp = false;
  let staleAfterMs: number | undefined;
  let json = false;
  let strict = false;
  let limit: number | undefined;
  let cursor: string | undefined;
  let idsFile: string | undefined;
  let reason: string | undefined;
  let planPath: string | undefined;
  let backupPath: string | undefined;
  let host: string | undefined;
  let port: number | undefined;
  let loopback = false;
  let open: boolean | undefined;
  let allowNonLoopback: boolean | undefined;
  let showAuthUrl: boolean | undefined;
  let maxRunsPerInstance: number | undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag !== "--fallback-effort") canAssignFallbackEffort = false;
    switch (flag) {
      case "--config":
        configPath = requireValue(rest, ++i, flag);
        break;
      case "--run":
        run = requireValue(rest, ++i, flag);
        break;
      case "--all":
        all = true;
        break;
      case "--since":
        since = requireValue(rest, ++i, flag);
        break;
      case "--until":
        until = requireValue(rest, ++i, flag);
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--include-memory":
        includeMemory = true;
        break;
      case "--artifact-dir":
        artifactDir = requireValue(rest, ++i, flag);
        break;
      case "--artifacts":
        artifactDir = requireValue(rest, ++i, flag);
        break;
      case "--by": {
        const raw = requireValue(rest, ++i, flag);
        if (raw !== "model" && raw !== "channel" && raw !== "failureKind") {
          throw new Error("--by must be model, channel, or failureKind.");
        }
        groupBy = raw;
        break;
      }
      case "--consumer":
        consumerPath = requireValue(rest, ++i, flag);
        break;
      case "--agent":
        agent = requireValue(rest, ++i, flag);
        break;
      case "--conversation":
        conversation = requireValue(rest, ++i, flag);
        break;
      case "--local":
        local = true;
        break;
      case "--configure":
        configure = true;
        break;
      case "--project":
        project = true;
        break;
      case "--check":
        check = true;
        break;
      case "--update":
        update = true;
        break;
      case "--no-docs-mcp":
        noDocsMcp = true;
        break;
      case "--stale-after-ms": {
        const raw = requireValue(rest, ++i, flag);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error("--stale-after-ms must be a positive integer.");
        }
        staleAfterMs = parsed;
        break;
      }
      case "--json":
        json = true;
        break;
      case "--strict":
        strict = true;
        break;
      case "--limit": {
        const raw = requireValue(rest, ++i, flag);
        const parsed = Number(raw);
        const maximum = cmd === "continuations" ? 500 : 100;
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
          throw new Error(`--limit must be an integer between 1 and ${String(maximum)}.`);
        }
        limit = parsed;
        break;
      }
      case "--cursor":
        cursor = requireValue(rest, ++i, flag).trim();
        if (cursor.length === 0 || cursor.length > 512) throw new Error("--cursor must be 1-512 characters.");
        break;
      case "--ids-file":
        idsFile = requireValue(rest, ++i, flag);
        break;
      case "--reason":
        reason = requireValue(rest, ++i, flag);
        break;
      case "--plan":
        planPath = requireValue(rest, ++i, flag);
        break;
      case "--backup":
        backupPath = requireValue(rest, ++i, flag);
        break;
      case "--host":
        host = requireValue(rest, ++i, flag);
        break;
      case "--port": {
        const raw = requireValue(rest, ++i, flag);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          throw new Error("--port must be an integer between 0 and 65535.");
        }
        port = parsed;
        break;
      }
      case "--loopback":
        loopback = true;
        break;
      case "--no-open":
        open = false;
        break;
      case "--allow-non-loopback":
        allowNonLoopback = true;
        break;
      case "--show-auth-url":
        showAuthUrl = true;
        break;
      case "--max-runs": {
        const raw = requireValue(rest, ++i, flag);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error("--max-runs must be a positive integer.");
        }
        maxRunsPerInstance = parsed;
        break;
      }
      case "--model":
        model = requireValue(rest, ++i, flag);
        break;
      case "--name":
        name = requireValue(rest, ++i, flag).trim();
        if (
          Array.from(name).length === 0
          || Array.from(name).length > MAX_AGENT_NAME_LENGTH
          || /[\u0000-\u001f\u007f]/u.test(name)
        ) {
          throw new Error(`--name must be 1-${MAX_AGENT_NAME_LENGTH} characters on one line.`);
        }
        break;
      case "--fallback-models":
        // Deprecated CLI spelling removed in v2.0.0. The similarly named JSON
        // and environment compatibility inputs are separate and remain supported.
        fallbackModels = requireValue(rest, ++i, flag)
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        break;
      case "--fallback": {
        const fallbackModel = requireValue(rest, ++i, flag).trim();
        if (fallbacks.some((entry) => entry.model === fallbackModel)) {
          throw new Error(`Duplicate --fallback model \`${fallbackModel}\`.`);
        }
        fallbacks.push({ model: fallbackModel });
        canAssignFallbackEffort = true;
        break;
      }
      case "--fallback-effort": {
        if (!canAssignFallbackEffort || fallbacks.length === 0) {
          throw new Error("--fallback-effort must immediately follow the --fallback it configures.");
        }
        const raw = requireValue(rest, ++i, flag);
        if (raw !== "provider-default" && !(EFFORT_LEVELS as readonly string[]).includes(raw)) {
          throw new Error(`--fallback-effort must be provider-default or ${EFFORT_LEVELS.join(", ")}.`);
        }
        if (raw !== "provider-default") {
          const current = fallbacks[fallbacks.length - 1]!;
          fallbacks[fallbacks.length - 1] = {
            ...current,
            effort: raw as EffortLevel,
          };
        }
        canAssignFallbackEffort = false;
        break;
      }
      case "--route-safety": {
        const raw = requireValue(rest, ++i, flag);
        if (raw !== "uniform" && raw !== "per-route-native") {
          throw new Error("--route-safety must be uniform or per-route-native.");
        }
        routeSafety = raw;
        break;
      }
      case "--effort": {
        const raw = requireValue(rest, ++i, flag);
        if (!(EFFORT_LEVELS as readonly string[]).includes(raw)) {
          throw new Error(`--effort must be ${EFFORT_LEVELS.join(", ")}.`);
        }
        effort = raw;
        break;
      }
      case "--memory": {
        const raw = requireValue(rest, ++i, flag);
        if (raw !== "lite" && raw !== "journal" && raw !== "bujo") {
          throw new Error("--memory must be lite, journal, or bujo.");
        }
        memory = raw;
        break;
      }
      case "--preset":
        preset = requireValue(rest, ++i, flag);
        break;
      case "--recipe":
        // Deprecated init/validate alias removed in v2.0.0.
        recipe = requireValue(rest, ++i, flag);
        break;
      case "--yes":
        yes = true;
        break;
      case "--auth":
        auth = true;
        break;
      case "--pi-auth-path":
        piAuthPath = requireValue(rest, ++i, flag);
        break;
      case "--api-key-stdin":
        apiKeyStdin = true;
        break;
      case "--codex-auth": {
        const raw = requireValue(rest, ++i, flag);
        if (raw !== "browser" && raw !== "device") {
          throw new Error("--codex-auth must be browser or device.");
        }
        codexAuthMode = raw;
        break;
      }
      case "--with":
        withChannels = requireValue(rest, ++i, flag)
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        break;
      case "--env-file":
        envFile = requireValue(rest, ++i, flag);
        break;
      case "--expected-background-snapshot":
        expectedBackgroundSnapshot = requireValue(rest, ++i, flag);
        break;
      case "--expected-managed-runtime-launch":
        expectedManagedRuntimeLaunch = requireValue(rest, ++i, flag);
        break;
      case "--target": {
        const raw = requireValue(rest, ++i, flag);
        if (raw !== "claude" && raw !== "codex" && raw !== "both") {
          throw new Error("--target must be claude, codex, or both.");
        }
        target = raw;
        break;
      }
      case "--force":
        force = true;
        break;
      case "--foreground":
        foreground = true;
        break;
      case "--follow":
        follow = true;
        break;
      // `-f` is foreground for start, follow for logs.
      case "-f":
        if (isLogs) {
          follow = true;
        } else {
          foreground = true;
        }
        break;
      case "--lines": {
        const raw = requireValue(rest, ++i, flag);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100_000) {
          throw new Error("--lines must be a positive integer between 1 and 100000.");
        }
        lines = parsed;
        break;
      }
      default:
        if (flag === undefined) {
          break;
        }
        if (flag.startsWith("--")) {
          throw new Error(`Unknown flag \`${flag}\` for \`mono-agent ${command}\`.`);
        }
        // Non-flag tokens are positional arguments (e.g. `recipes show <id>`).
        positionals.push(flag);
        break;
    }
  }

  if (consumerPath !== undefined && cmd !== "validate" && cmd !== "audit-runs") {
    throw new Error("--consumer is only supported for `mono-agent validate` and `mono-agent audit-runs`.");
  }
  if ((local || configure) && cmd !== "tui") {
    throw new Error("--local and --configure are only supported for `mono-agent tui`.");
  }
  if (configure && local) {
    throw new Error("--configure attaches to the authoritative background agent; omit --local.");
  }
  if ((project || check || update) && cmd !== "install-skill") {
    throw new Error("--project, --check, and --update are only supported for `mono-agent install-skill`.");
  }
  if ((check || update) && !project) {
    throw new Error("--check and --update require `mono-agent install-skill --project`.");
  }
  if (check && update) {
    throw new Error("Choose either --check or --update for project skills.");
  }
  if (noDocsMcp && cmd !== "install-skill") {
    throw new Error("--no-docs-mcp is only supported for `mono-agent install-skill`.");
  }

  if (
    (
      host !== undefined
      || port !== undefined
      || loopback
      || open !== undefined
      || allowNonLoopback !== undefined
      || showAuthUrl !== undefined
      || maxRunsPerInstance !== undefined
    ) &&
    cmd !== "web" && cmd !== "sessions"
  ) {
    throw new Error("--host and --port are only supported for `mono-agent web` or `mono-agent sessions`; --loopback is web-only; Session Recorder flags are sessions-only.");
  }
  if (loopback && cmd !== "web") {
    throw new Error("--loopback is only supported for `mono-agent web`.");
  }
  if ((open !== undefined || allowNonLoopback !== undefined || showAuthUrl !== undefined || maxRunsPerInstance !== undefined) && cmd !== "sessions") {
    throw new Error("--no-open, --allow-non-loopback, --show-auth-url, and --max-runs are only supported for `mono-agent sessions`.");
  }
  if (cmd === "web" && (configPath !== undefined || envFile !== undefined)) {
    throw new Error("The machine-wide `mono-agent web` console does not load an agent --config or --env-file; use `mono-agent sessions` for the recorder.");
  }
  if (includeMemory && cmd !== "audit-runs" && cmd !== "metrics" && cmd !== "backfill" && cmd !== "sessions") {
    throw new Error("--include-memory is only supported for `mono-agent audit-runs`, `mono-agent metrics`, `mono-agent backfill`, and `mono-agent sessions`.");
  }
  if (limit !== undefined && cmd !== "memory" && cmd !== "continuations") {
    throw new Error("--limit is only supported for `mono-agent memory` and `mono-agent continuations list`.");
  }
  if ((limit !== undefined || cursor !== undefined) && cmd === "continuations" && (positionals[0] ?? "list") !== "list") {
    throw new Error("--limit and --cursor are only supported for `mono-agent continuations list`.");
  }
  if (cursor !== undefined && cmd !== "continuations") {
    throw new Error("--cursor is only supported for `mono-agent continuations list`.");
  }
  if (strict && (cmd !== "memory" || (positionals[0] ?? "stats") !== "audit")) {
    throw new Error("--strict is only supported for `mono-agent memory audit`.");
  }
  if (
    (idsFile !== undefined || reason !== undefined || planPath !== undefined || backupPath !== undefined)
    && (cmd !== "memory" || positionals[0] !== "forget")
  ) {
    throw new Error("--ids-file, --reason, --plan, and --backup are only supported for `mono-agent memory forget`.");
  }
  if (auth && cmd !== "init") {
    throw new Error("--auth is only supported for `mono-agent init`.");
  }
  if (piAuthPath !== undefined && cmd !== "auth") {
    throw new Error("--pi-auth-path is only supported for `mono-agent auth`.");
  }
  if (apiKeyStdin && cmd !== "auth") {
    throw new Error("--api-key-stdin is only supported for `mono-agent auth login <provider>`.");
  }
  if (codexAuthMode !== undefined && cmd !== "init" && cmd !== "auth") {
    throw new Error("--codex-auth is only supported for `mono-agent init` and `mono-agent auth login codex`.");
  }
  if (fallbackModels !== undefined && fallbacks.length > 0) {
    throw new Error("Use either legacy --fallback-models or repeated --fallback flags, not both.");
  }
  if (fallbackModels !== undefined && new Set(fallbackModels).size !== fallbackModels.length) {
    throw new Error("--fallback-models contains a duplicate model reference.");
  }
  const selectedFallbackModels = fallbackModels ?? fallbacks.map((fallback) => fallback.model);
  if (model !== undefined && selectedFallbackModels.includes(model)) {
    throw new Error(`Primary --model \`${model}\` cannot also be a fallback.`);
  }

  return {
    command: cmd,
    ...(configPath === undefined ? {} : { configPath }),
    ...(name === undefined ? {} : { name }),
    ...(model === undefined ? {} : { model }),
    ...(fallbackModels === undefined ? {} : { fallbackModels }),
    ...(fallbacks.length === 0 ? {} : { fallbacks }),
    ...(routeSafety === undefined ? {} : { routeSafety }),
    ...(effort === undefined ? {} : { effort }),
    ...(memory === undefined ? {} : { memory }),
    ...(preset === undefined ? {} : { preset }),
    ...(recipe === undefined ? {} : { recipe }),
    ...(withChannels === undefined ? {} : { withChannels }),
    ...(yes ? { yes } : {}),
    ...(auth ? { auth } : {}),
    ...(piAuthPath === undefined ? {} : { piAuthPath }),
    ...(apiKeyStdin ? { apiKeyStdin } : {}),
    ...(codexAuthMode === undefined ? {} : { codexAuthMode }),
    positionals,
    ...(envFile === undefined ? {} : { envFile }),
    ...(expectedBackgroundSnapshot === undefined ? {} : { expectedBackgroundSnapshot }),
    ...(expectedManagedRuntimeLaunch === undefined ? {} : { expectedManagedRuntimeLaunch }),
    ...(target === undefined ? {} : { target }),
    force,
    foreground,
    follow,
    ...(lines === undefined ? {} : { lines }),
    ...(run === undefined ? {} : { run }),
    all,
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    dryRun,
    includeMemory,
    ...(artifactDir === undefined ? {} : { artifactDir }),
    ...(groupBy === undefined ? {} : { groupBy }),
    ...(consumerPath === undefined ? {} : { consumerPath }),
    ...(staleAfterMs === undefined ? {} : { staleAfterMs }),
    ...(json ? { json } : {}),
    ...(strict ? { strict } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(idsFile === undefined ? {} : { idsFile }),
    ...(reason === undefined ? {} : { reason }),
    ...(planPath === undefined ? {} : { planPath }),
    ...(backupPath === undefined ? {} : { backupPath }),
    ...(agent === undefined ? {} : { agent }),
    ...(conversation === undefined ? {} : { conversation }),
    ...(local ? { local } : {}),
    ...(configure ? { configure } : {}),
    ...(project ? { project } : {}),
    ...(check ? { check } : {}),
    ...(update ? { update } : {}),
    ...(noDocsMcp ? { noDocsMcp } : {}),
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(loopback ? { loopback } : {}),
    ...(open === undefined ? {} : { open }),
    ...(allowNonLoopback === undefined ? {} : { allowNonLoopback }),
    ...(showAuthUrl === undefined ? {} : { showAuthUrl }),
    ...(maxRunsPerInstance === undefined ? {} : { maxRunsPerInstance }),
  };
}

/**
 * Loads env vars from a dotenv file when it exists; already-set variables are
 * never overwritten, so exported shell variables take precedence. Returns
 * false when the file is missing or unreadable.
 */
export function loadCliEnvFile(path: string): boolean {
  try {
    process.loadEnvFile(path);
    return true;
  } catch {
    return false;
  }
}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Flag ${flag} requires a value.`);
  }
  return value;
}
