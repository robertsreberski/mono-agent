import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";

import { accountHomeDirectory } from "./account-home.js";

/**
 * Thin, side-effect-light helpers around macOS launchd. The `launchctl` runner
 * is injectable so orchestration can be unit tested without touching the real
 * service domain. Everything here is pure except `makeLaunchctlRunner`.
 */

export interface LaunchctlResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type LaunchctlRunner = (args: readonly string[]) => Promise<LaunchctlResult>;

export interface LaunchdPaths {
  readonly plistPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly logDir: string;
  readonly launchAgentsDir: string;
}

export interface PlistInput {
  readonly label: string;
  readonly nodePath: string;
  readonly cliPath: string;
  readonly configPath: string;
  readonly cwd: string;
  readonly envFile?: string;
  /** Secret-free approved input identity, encoded for the internal worker. */
  readonly expectedBackgroundSnapshot: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  /** Deliberately allowlisted, non-secret worker environment. */
  readonly environment: Readonly<Record<string, string>>;
}

export interface LaunchdServiceInfo {
  readonly loaded: boolean;
  readonly pid?: number;
}

const LABEL_PREFIX = "com.mono-agent";
const MAX_FOLDER_SEGMENT = 40;
const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin";
const PATH_EXTRAS = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * A stable, launchd-legal label derived from the resolved config path. The
 * folder name keeps it human-readable; an 8-char hash of the absolute config
 * path disambiguates same-named folders and keeps the label deterministic so
 * `start`/`stop`/`status` all address the same service.
 */
export function deriveLaunchdLabel(configPath: string): string {
  const resolved = resolve(configPath);
  const folder = basename(dirname(resolved))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_FOLDER_SEGMENT)
    .replace(/-+$/gu, "");
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `${LABEL_PREFIX}.${folder.length === 0 ? "agent" : folder}-${hash}`;
}

export function launchdPathsFor(label: string, home: string = accountHomeDirectory()): LaunchdPaths {
  const launchAgentsDir = resolve(home, "Library", "LaunchAgents");
  const logDir = resolve(home, ".mono-agent", "logs");
  return {
    launchAgentsDir,
    logDir,
    plistPath: resolve(launchAgentsDir, `${label}.plist`),
    stdoutPath: resolve(logDir, `${label}.out.log`),
    stderrPath: resolve(logDir, `${label}.err.log`),
  };
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

/**
 * The plist runs the blocking worker through `/usr/bin/env -i`. Clearing the
 * launchd job's inherited environment before Node starts is important: Node
 * startup variables such as NODE_OPTIONS execute before cli.ts can sanitise
 * process.env. Only the explicit, non-secret operational allowlist is restored.
 */
export function buildPlistXml(input: PlistInput): string {
  const programArguments = buildLaunchdProgramArguments(input);
  for (const [name, value] of [
    ["launchd label", input.label],
    ["working directory", input.cwd],
    ["stdout path", input.stdoutPath],
    ["stderr path", input.stderrPath],
  ] as const) {
    assertControlFree(value, name);
  }
  const argsXml = programArguments.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(input.cwd)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(input.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(input.stderrPath)}</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;
}

/** Exact argv persisted by the managed LaunchAgent producer. */
export function buildLaunchdProgramArguments(input: PlistInput): readonly string[] {
  const environmentArguments = Object.entries(input.environment)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
        throw new Error("Launchd environment names must use the portable identifier grammar.");
      }
      assertControlFree(value, `launchd environment ${key}`);
      return `${key}=${value}`;
    });
  const arguments_ = [
    "/usr/bin/env",
    "-i",
    ...environmentArguments,
    input.nodePath,
    input.cliPath,
    "start",
    "--foreground",
    "--config",
    input.configPath,
    ...(input.envFile === undefined ? [] : ["--env-file", input.envFile]),
    "--expected-background-snapshot",
    input.expectedBackgroundSnapshot,
  ];
  for (const argument of arguments_) assertControlFree(argument, "launchd program argument");
  return arguments_;
}

function assertControlFree(value: string, label: string): void {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must not contain control characters.`);
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * PATH for the background worker: the launching shell's PATH (so the user's
 * toolchain is reachable) plus Homebrew/usr-local in case launchd started from
 * a bare login. Never includes anything secret.
 */
export function defaultPathEnv(env: Record<string, string | undefined> = process.env): string {
  const current = env.PATH?.trim();
  if (current === undefined || current.length === 0) {
    return FALLBACK_PATH;
  }
  const parts = current.split(":").filter((part) => part.length > 0);
  for (const extra of PATH_EXTRAS) {
    if (!parts.includes(extra)) {
      parts.push(extra);
    }
  }
  return parts.join(":");
}

export function domainTarget(uid: number): string {
  return `gui/${uid}`;
}

export function serviceTarget(label: string, uid: number): string {
  return `gui/${uid}/${label}`;
}

export function makeLaunchctlRunner(): LaunchctlRunner {
  return (args) =>
    new Promise<LaunchctlResult>((resolvePromise) => {
      const child = spawn("launchctl", [...args], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error: Error) => {
        resolvePromise({ code: 127, stdout, stderr: `${stderr}${error.message}` });
      });
      child.on("close", (code) => {
        resolvePromise({ code: code ?? 0, stdout, stderr });
      });
    });
}

/** True when the service is bootstrapped in the user's gui domain. */
export async function isLoaded(runner: LaunchctlRunner, label: string, uid: number): Promise<boolean> {
  return (await launchdServiceInfo(runner, label, uid)).loaded;
}

/** Read the launchd-owned process identity from `launchctl print`. */
export async function launchdServiceInfo(
  runner: LaunchctlRunner,
  label: string,
  uid: number,
): Promise<LaunchdServiceInfo> {
  const result = await runner(["print", serviceTarget(label, uid)]);
  if (result.code !== 0) return { loaded: false };
  const pid = parseLaunchdServicePid(result.stdout);
  return pid === undefined ? { loaded: true } : { loaded: true, pid };
}

/** Parse only launchd's top-level `pid = N` field; never infer a pid from noise. */
export function parseLaunchdServicePid(output: string): number | undefined {
  const match = /^\s*pid\s*=\s*(\d+)\s*$/mu.exec(output);
  if (match?.[1] === undefined) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** Bootstrap (load + RunAtLoad-launch) the plist. Caller tolerates "already bootstrapped". */
export async function bootstrap(runner: LaunchctlRunner, plistPath: string, uid: number): Promise<LaunchctlResult> {
  return await runner(["bootstrap", domainTarget(uid), plistPath]);
}

/**
 * Remove the service from the domain. Sends SIGTERM and — unlike a plain kill —
 * prevents KeepAlive from relaunching it. Caller tolerates "not loaded".
 */
export async function bootout(runner: LaunchctlRunner, label: string, uid: number): Promise<LaunchctlResult> {
  return await runner(["bootout", serviceTarget(label, uid)]);
}
