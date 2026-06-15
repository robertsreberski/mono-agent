import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { listTraceSources } from "@mono-agent/observability";
import type { TraceSourceListItem } from "@mono-agent/observability";

import { resolveAppTraceRegistryDir, resolveAppTraceStaleAfterMs } from "./app-config.js";
import {
  bootout,
  bootstrap,
  buildPlistXml,
  defaultPathEnv,
  deriveLaunchdLabel,
  isLoaded,
  kickstartRestart,
  launchdPathsFor,
  makeLaunchctlRunner,
} from "./launchd.js";
import type { LaunchctlResult, LaunchctlRunner, LaunchdPaths } from "./launchd.js";

/**
 * Background-service orchestration for the mono-agent CLI. The interactive
 * control commands never talk to the worker directly: they derive a stable
 * launchd label + the trace-source registry location from the resolved config
 * path, drive `launchctl`, and read the worker's published manifest to learn
 * when it is up and what to print.
 */

export interface BackgroundCliArgs {
  readonly configPath?: string;
  readonly envFile?: string;
  readonly port?: number;
  readonly noConsole: boolean;
}

export interface InstanceTarget {
  readonly cwd: string;
  readonly configPath: string;
  readonly label: string;
  readonly registryDir: string;
  readonly staleAfterMs: number;
  readonly paths: LaunchdPaths;
  readonly nodePath: string;
  readonly cliPath: string;
  readonly envFile?: string;
  readonly port?: number;
  readonly noConsole: boolean;
  readonly pathEnv: string;
}

export interface ResolveInstanceTargetInput {
  readonly args: BackgroundCliArgs;
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  /** Absolute path to the running cli.js, baked into the plist. */
  readonly cliPath: string;
}

/**
 * Resolve everything the control commands need from CLI args. The registry dir
 * and config path are resolved exactly as the worker will resolve them, so the
 * detached launcher can find the worker's manifest without any IPC.
 */
export async function resolveInstanceTarget(input: ResolveInstanceTargetInput): Promise<InstanceTarget> {
  const cwd = resolve(input.cwd);
  const configPath = resolve(cwd, input.args.configPath ?? "mono-agent.config.json");
  const configInput = { env: input.env, cwd, configPath };
  const [registryDir, staleAfterMs] = await Promise.all([
    resolveAppTraceRegistryDir(configInput),
    resolveAppTraceStaleAfterMs(configInput),
  ]);
  const label = deriveLaunchdLabel(configPath);
  return {
    cwd,
    configPath,
    label,
    registryDir,
    staleAfterMs,
    paths: launchdPathsFor(label),
    nodePath: process.execPath,
    cliPath: input.cliPath,
    // Bake an explicit --env-file (resolved absolute) into the plist so the
    // launchd worker loads the same env file the launcher did.
    ...(input.args.envFile === undefined ? {} : { envFile: resolve(cwd, input.args.envFile) }),
    ...(input.args.port === undefined ? {} : { port: input.args.port }),
    noConsole: input.args.noConsole,
    pathEnv: defaultPathEnv(input.env),
  };
}

export interface BackgroundDeps {
  readonly runner: LaunchctlRunner;
  readonly getuid: () => number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly listTraceSources: typeof listTraceSources;
  readonly writeFile: (path: string, data: string) => Promise<void>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly rm: (path: string) => Promise<void>;
  /** True when a pid is still alive (or alive but owned by another user). */
  readonly isAlive: (pid: number) => boolean;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Run `tail` with inherited stdio; resolves with its exit code. */
  readonly spawnTail: (args: readonly string[]) => Promise<number>;
}

export function defaultBackgroundDeps(): BackgroundDeps {
  return {
    runner: makeLaunchctlRunner(),
    getuid: () => process.getuid?.() ?? 0,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    listTraceSources,
    writeFile: (path, data) => writeFile(path, data, "utf8"),
    mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
    rm: (path) => rm(path, { force: true }),
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM means the process exists but is owned by someone else.
        return isErrno(error, "EPERM");
      }
    },
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    spawnTail: (args) =>
      new Promise<number>((resolvePromise) => {
        const child = spawn("tail", [...args], { stdio: "inherit" });
        child.on("error", () => resolvePromise(127));
        child.on("close", (code) => resolvePromise(code ?? 0));
      }),
  };
}

export interface PollOptions {
  readonly timeoutMs: number;
  readonly intervalMs: number;
}

export interface ReadyPollOptions extends PollOptions {
  /** Only accept a worker that started at or after this time (restart safety). */
  readonly sinceMs: number;
}

const DEFAULT_POLL: PollOptions = { timeoutMs: 18_000, intervalMs: 400 };
const SINCE_SKEW_MS = 2_000;

export async function startBackground(
  target: InstanceTarget,
  deps: BackgroundDeps,
  poll: PollOptions = DEFAULT_POLL,
): Promise<number> {
  return await launchBackground(target, deps, poll);
}

/** Restart is behaviourally identical: ensure a single fresh running instance. */
export async function restartBackground(
  target: InstanceTarget,
  deps: BackgroundDeps,
  poll: PollOptions = DEFAULT_POLL,
): Promise<number> {
  return await launchBackground(target, deps, poll);
}

async function launchBackground(target: InstanceTarget, deps: BackgroundDeps, poll: PollOptions): Promise<number> {
  const uid = deps.getuid();
  await writePlist(target, deps);
  const sinceMs = deps.now();
  const outcome = await bootstrapOrRestart(target, deps, uid);
  if (!outcome.ok) {
    return failLaunch(target, deps, outcome.restarted ? "restart" : "start", outcome.failure);
  }
  const ready = await pollInstanceReady(target, deps, { ...poll, sinceMs });
  if (ready === undefined) {
    return reportTimeout(target, deps);
  }
  printInstanceInfo(ready, target, deps, outcome.restarted ? "restarted" : "started");
  return 0;
}

async function writePlist(target: InstanceTarget, deps: BackgroundDeps): Promise<void> {
  // launchd will not create the log file's parent directory, so make both dirs
  // before writing the plist that references them.
  await deps.mkdir(target.paths.logDir);
  await deps.mkdir(target.paths.launchAgentsDir);
  const xml = buildPlistXml({
    label: target.label,
    nodePath: target.nodePath,
    cliPath: target.cliPath,
    configPath: target.configPath,
    cwd: target.cwd,
    ...(target.envFile === undefined ? {} : { envFile: target.envFile }),
    ...(target.port === undefined ? {} : { port: target.port }),
    noConsole: target.noConsole,
    stdoutPath: target.paths.stdoutPath,
    stderrPath: target.paths.stderrPath,
    pathEnv: target.pathEnv,
  });
  await deps.writeFile(target.paths.plistPath, xml);
}

interface LaunchOutcome {
  readonly ok: boolean;
  readonly restarted: boolean;
  readonly failure?: LaunchctlResult;
}

/**
 * Idempotent: bootstrap when not loaded, otherwise `kickstart -k` to restart.
 * `bootstrap` reporting "already bootstrapped" (or any non-zero) is tolerated as
 * long as a follow-up `print` confirms the service is loaded.
 */
async function bootstrapOrRestart(target: InstanceTarget, deps: BackgroundDeps, uid: number): Promise<LaunchOutcome> {
  if (!(await isLoaded(deps.runner, target.label, uid))) {
    const booted = await bootstrap(deps.runner, target.paths.plistPath, uid);
    if (booted.code === 0 || (await isLoaded(deps.runner, target.label, uid))) {
      return { ok: true, restarted: false };
    }
    return { ok: false, restarted: false, failure: booted };
  }

  const restart = await kickstartRestart(deps.runner, target.label, uid);
  if (restart.code === 0) {
    return { ok: true, restarted: true };
  }
  // Fallback: a full unload + reload cycle.
  await bootout(deps.runner, target.label, uid);
  const booted = await bootstrap(deps.runner, target.paths.plistPath, uid);
  if (booted.code === 0 || (await isLoaded(deps.runner, target.label, uid))) {
    return { ok: true, restarted: true };
  }
  return { ok: false, restarted: true, failure: booted };
}

export async function stopBackground(target: InstanceTarget, deps: BackgroundDeps): Promise<number> {
  const uid = deps.getuid();
  const existing = await findInstance(target, deps);
  const wasLoaded = await isLoaded(deps.runner, target.label, uid);
  const result = await bootout(deps.runner, target.label, uid);
  // Removing the plist stops it from relaunching at the next login.
  await deps.rm(target.paths.plistPath);
  await maybeUnlinkDeadManifest(target, deps, existing);

  // `bootout` also exits non-zero when the service was never loaded, which is
  // fine. A non-zero exit is only a real failure if the service is still loaded
  // afterwards — otherwise we'd silently swallow genuine stop failures.
  if (result.code !== 0 && (await isLoaded(deps.runner, target.label, uid))) {
    deps.stderr(`Failed to stop ${target.label}: launchctl bootout exited ${result.code}.\n`);
    const detail = (result.stderr || result.stdout).trim();
    if (detail.length > 0) {
      deps.stderr(`${detail}\n`);
    }
    deps.stderr(`The plist was removed, but the service is still running.\n`);
    return 1;
  }

  deps.stdout(
    wasLoaded
      ? `Stopped ${target.label} and removed its LaunchAgent.\n`
      : `${target.label} was not running; removed its LaunchAgent if present.\n`,
  );
  deps.stdout(`config  ${target.configPath}\n`);
  return 0;
}

export async function statusBackground(target: InstanceTarget, deps: BackgroundDeps): Promise<number> {
  const result = await deps.listTraceSources({ registryDir: target.registryDir, staleAfterMs: target.staleAfterMs });
  const current = result.sources.find((source) => matchesConfig(source, target.configPath));

  if (current === undefined) {
    deps.stdout(`No running mono-agent instance for ${target.configPath}.\n`);
    deps.stdout(`Start it with: mono-agent start${configFlag(target)}\n`);
  } else {
    writeInstanceDetail(current, target, deps);
  }

  // Only surface other instances that are live or crashed — cleanly stopped
  // manifests linger in the registry and would just be noise.
  const others = result.sources.filter(
    (source) => !matchesConfig(source, target.configPath) && source.health !== "stopped",
  );
  if (others.length > 0) {
    deps.stdout(`\nOther mono-agent instances:\n`);
    for (const source of others) {
      deps.stdout(`  ${formatOtherInstance(source)}\n`);
    }
  }

  return current?.health === "running" ? 0 : 1;
}

export interface LogOptions {
  readonly follow: boolean;
  readonly lines: number;
}

export async function tailLogs(target: InstanceTarget, deps: BackgroundDeps, options: LogOptions): Promise<number> {
  const args = [
    "-n",
    String(options.lines),
    ...(options.follow ? ["-F"] : []),
    target.paths.stderrPath,
    target.paths.stdoutPath,
  ];
  return await deps.spawnTail(args);
}

export async function pollInstanceReady(
  target: InstanceTarget,
  deps: BackgroundDeps,
  options: ReadyPollOptions,
): Promise<TraceSourceListItem | undefined> {
  const deadline = deps.now() + options.timeoutMs;
  const sinceFloor = options.sinceMs - SINCE_SKEW_MS;
  for (;;) {
    const match = await findInstance(target, deps);
    if (match !== undefined && isReady(match) && startedAtMs(match) >= sinceFloor) {
      return match;
    }
    if (deps.now() >= deadline) {
      return undefined;
    }
    await deps.sleep(options.intervalMs);
  }
}

export function printInstanceInfo(
  source: TraceSourceListItem,
  target: InstanceTarget,
  deps: BackgroundDeps,
  verb: string,
): void {
  const flag = configFlag(target);
  deps.stdout(`mono-agent ${verb} in the background.\n`);
  writeInstanceDetail(source, target, deps);
  deps.stdout(`\nStop with: mono-agent stop${flag}   ·   Logs: mono-agent logs${flag} --follow\n`);
}

async function findInstance(target: InstanceTarget, deps: BackgroundDeps): Promise<TraceSourceListItem | undefined> {
  const result = await deps.listTraceSources({ registryDir: target.registryDir, staleAfterMs: target.staleAfterMs });
  return result.sources.find((source) => matchesConfig(source, target.configPath));
}

async function maybeUnlinkDeadManifest(
  target: InstanceTarget,
  deps: BackgroundDeps,
  existing: TraceSourceListItem | undefined,
): Promise<void> {
  // Only clean up a manifest whose process is already gone; a worker that is
  // still shutting down will mark its own manifest stopped.
  if (existing?.pid === undefined || deps.isAlive(existing.pid)) {
    return;
  }
  await deps.rm(resolve(target.registryDir, `${existing.sourceId}.json`));
}

function failLaunch(
  target: InstanceTarget,
  deps: BackgroundDeps,
  verb: string,
  result: LaunchctlResult | undefined,
): number {
  deps.stderr(`Failed to ${verb} ${target.label} via launchctl${result === undefined ? "" : ` (exit ${result.code})`}.\n`);
  const detail = (result?.stderr || result?.stdout || "").trim();
  if (detail.length > 0) {
    deps.stderr(`${detail}\n`);
  }
  deps.stderr(`Logs: ${target.paths.stderrPath}\n`);
  return 1;
}

function reportTimeout(target: InstanceTarget, deps: BackgroundDeps): number {
  const flag = configFlag(target);
  deps.stderr(
    "mono-agent did not report ready within the timeout.\n" +
      "It may still be starting, or it may have failed. Inspect:\n" +
      `  logs:   ${target.paths.stderrPath}\n` +
      `          ${target.paths.stdoutPath}\n` +
      `  follow: mono-agent logs${flag} --follow\n` +
      `  status: mono-agent status${flag}\n` +
      `  stop:   mono-agent stop${flag}\n`,
  );
  return 1;
}

function writeInstanceDetail(source: TraceSourceListItem, target: InstanceTarget, deps: BackgroundDeps): void {
  const consoleUrl = consoleBaseUrl(source);
  if (consoleUrl !== undefined) {
    // The console's per-boot access token is not persisted to disk; the worker
    // prints the full tokenized URL to its log at startup.
    deps.stdout(`operator console  ${consoleUrl} (tokenized link in \`mono-agent logs${configFlag(target)}\`)\n`);
  }
  deps.stdout(`config            ${target.configPath}\n`);
  deps.stdout(`label             ${target.label}\n`);
  deps.stdout(`pid               ${source.pid ?? "unknown"}\n`);
  deps.stdout(`health            ${source.health}\n`);
  deps.stdout(`started           ${source.startedAt}\n`);
  deps.stdout(`logs              ${target.paths.stdoutPath}\n`);
  deps.stdout(`                  ${target.paths.stderrPath}\n`);
  const channelLines = formatChannels(source);
  if (channelLines.length > 0) {
    deps.stdout("channels\n");
    for (const line of channelLines) {
      deps.stdout(`${line}\n`);
    }
  }
}

function formatOtherInstance(source: TraceSourceListItem): string {
  const pid = source.pid === undefined ? "?" : String(source.pid);
  const config = source.configPath ?? "(unknown config)";
  return `${source.health.padEnd(8)} pid ${pid.padEnd(7)} ${source.sourceId}  ${config}`;
}

function matchesConfig(source: TraceSourceListItem, configPath: string): boolean {
  return source.configPath !== undefined && resolve(source.configPath) === configPath;
}

function isReady(source: TraceSourceListItem): boolean {
  return source.health === "running" && metadataReason(source) === "startup-complete";
}

function metadataReason(source: TraceSourceListItem): string | undefined {
  const reason = source.metadata?.reason;
  return typeof reason === "string" ? reason : undefined;
}

function startedAtMs(source: TraceSourceListItem): number {
  const parsed = Date.parse(source.startedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function consoleBaseUrl(source: TraceSourceListItem): string | undefined {
  const console = source.metadata?.operatorConsole;
  if (console === null || typeof console !== "object") {
    return undefined;
  }
  const url = (console as Record<string, unknown>).url;
  return typeof url === "string" && url.length > 0 ? url : undefined;
}

/** ` --config <path>` when a non-default config is in play, else empty. */
function configFlag(target: InstanceTarget): string {
  const defaultPath = resolve(target.cwd, "mono-agent.config.json");
  return target.configPath === defaultPath ? "" : ` --config ${target.configPath}`;
}

function formatChannels(source: TraceSourceListItem): string[] {
  const channels = source.metadata?.channels;
  if (channels === null || typeof channels !== "object") {
    return [];
  }
  return Object.entries(channels as Record<string, unknown>).map(
    ([id, value]) => `  ${id.padEnd(15)} ${describeChannelMetadata(value)}`,
  );
}

function describeChannelMetadata(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return String(value);
  }
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : "unknown";
  if (kind === "running") {
    const facts = Object.entries(record)
      .filter(([key]) => key !== "kind")
      .map(([key, fact]) => `${key}=${String(fact)}`)
      .join(" ");
    return facts.length === 0 ? "running" : `running (${facts})`;
  }
  const reason = typeof record.reason === "string" ? record.reason : "";
  return reason.length === 0 ? kind : `${kind}: ${reason}`;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
