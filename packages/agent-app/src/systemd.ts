import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import { acquireFilesystemLifecycleLock } from "./launchd-lifecycle-lock.js";

export interface SystemdResult { readonly code: number; readonly stdout: string; readonly stderr: string }
export interface SystemdDeps {
  readonly run?: (command: string, args: readonly string[]) => Promise<SystemdResult>;
  readonly journal?: (args: readonly string[]) => Promise<number>;
  readonly homeDir?: string;
  readonly configDir?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly stdout?: { write(text: string): unknown };
  readonly stderr?: { write(text: string): unknown };
}

export interface SystemdDefinition {
  readonly identity: string;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

export interface SystemdService {
  readonly loadState: string;
  readonly activeState: string;
  readonly subState: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly enabled: boolean;
  readonly fragmentPath: string;
}

const MARKER = "# mono-agent systemd user service v1 ";
export const SYSTEMD_WEB_IDENTITY = "web";

export function systemdUnitName(identity: string): string {
  return identity === SYSTEMD_WEB_IDENTITY ? "mono-agent-web.service"
    : `mono-agent-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}.service`;
}

export function systemdUnitPath(identity: string, deps: SystemdDeps = {}): string {
  const root = deps.configDir ?? (deps.homeDir === undefined ? process.env.XDG_CONFIG_HOME : undefined) ?? join(deps.homeDir ?? homedir(), ".config");
  if (!isAbsolute(root)) throw new Error("XDG_CONFIG_HOME must be absolute.");
  return join(root, "systemd", "user", systemdUnitName(identity));
}

/** systemd syntax is not shell syntax: quote whitespace, disable specifiers and dollar expansion. */
function quote(value: string, exec = false): string {
  if (/[\x00-\x1f\x7f]/u.test(value)) throw new Error("Service values must not contain control characters.");
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `"${exec ? escaped.replaceAll("$", () => "$$") : escaped}"`;
}

export function renderSystemdUnit(definition: SystemdDefinition): string {
  if (!isAbsolute(definition.cwd) || !isAbsolute(definition.argv[0] ?? "")) {
    throw new Error("Service working directory and executable must be absolute.");
  }
  if (definition.cwd.trim() !== definition.cwd || /[\x00-\x1f\x7f"\\]/u.test(definition.cwd)) {
    throw new Error("Service working directory must not contain quotes, backslashes, control characters, or edge whitespace.");
  }
  return [
    MARKER + Buffer.from(JSON.stringify(definition)).toString("base64"),
    "[Unit]", "Description=Mono-agent (dev, unmanaged runtime)", "StartLimitIntervalSec=60", "StartLimitBurst=5", "",
    "[Service]", "Type=exec", `WorkingDirectory=${definition.cwd.replaceAll("%", "%%")}`,
    `ExecStart=${definition.argv.map((arg) => quote(arg, true)).join(" ")}`,
    ...Object.entries(definition.environment).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error("Invalid service environment name.");
      return `Environment=${quote(`${name}=${value}`)}`;
    }),
    "Restart=on-failure", "RestartSec=5", "TimeoutStopSec=60", "KillMode=mixed", "UMask=0077",
    "StandardOutput=journal", "StandardError=journal", "", "[Install]", "WantedBy=default.target", "",
  ].join("\n");
}

export async function runSystemdTool(command: string, args: readonly string[]): Promise<SystemdResult> {
  try {
    const result = await promisify(execFile)(command, [...args], { timeout: 90_000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
    return { code: 0, ...result };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr || failure.message || "Command failed" };
  }
}

async function checked(args: readonly string[], deps: SystemdDeps): Promise<SystemdResult> {
  const result = await (deps.run ?? runSystemdTool)("systemctl", ["--user", ...args]);
  if (result.code !== 0) throw new Error(`systemctl --user ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}. A running systemd user manager is required.`);
  return result;
}

export async function inspectSystemd(identity: string, deps: SystemdDeps = {}): Promise<SystemdService> {
  const result = await (deps.run ?? runSystemdTool)("systemctl", ["--user", "show", systemdUnitName(identity),
    "--property=LoadState,ActiveState,SubState,MainPID,ExecMainStartTimestamp,UnitFileState,FragmentPath"]);
  const properties = Object.fromEntries(result.stdout.trim().split("\n").map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  if (result.code !== 0 && properties.LoadState !== "not-found") {
    throw new Error(`Cannot inspect systemd user service: ${result.stderr.trim() || "systemctl failed"}`);
  }
  if (!properties.LoadState || !properties.ActiveState) throw new Error("systemctl returned an incomplete service record.");
  const pid = Number(properties.MainPID ?? "0");
  if (!Number.isSafeInteger(pid) || pid < 0) throw new Error("systemctl returned an invalid PID.");
  return {
    loadState: properties.LoadState, activeState: properties.ActiveState, subState: properties.SubState ?? "unknown",
    pid, startedAt: properties.ExecMainStartTimestamp ?? "", enabled: properties.UnitFileState === "enabled",
    fragmentPath: properties.FragmentPath ?? "",
  };
}

async function ownedFile(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) {
      throw new Error(`Refusing unsafe service file ${path}.`);
    }
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readSystemdDefinition(identity: string, deps: SystemdDeps = {}): Promise<SystemdDefinition | undefined> {
  const contents = await ownedFile(systemdUnitPath(identity, deps));
  if (contents === undefined) return undefined;
  try {
    const first = contents.split("\n", 1)[0]!;
    if (!first.startsWith(MARKER)) throw new Error("missing ownership marker");
    const definition = JSON.parse(Buffer.from(first.slice(MARKER.length), "base64").toString("utf8")) as SystemdDefinition;
    if (definition.identity !== identity || renderSystemdUnit(definition) !== contents) throw new Error("modified unit");
    return definition;
  } catch {
    throw new Error(`Refusing to replace or remove an unrecognized service file: ${systemdUnitPath(identity, deps)}.`);
  }
}

async function ensureDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) {
    throw new Error(`Refusing unsafe service directory ${path}.`);
  }
}

async function publish(path: string, contents: string): Promise<void> {
  const root = dirname(dirname(dirname(path)));
  for (const dir of [root, dirname(dirname(path)), dirname(path)]) await ensureDirectory(dir);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function withSystemdLock<T>(identity: string, deps: SystemdDeps, action: () => Promise<T>): Promise<T> {
  const root = join(deps.homeDir ?? homedir(), ".mono-agent");
  await ensureDirectory(root);
  const release = await acquireFilesystemLifecycleLock({ label: systemdUnitName(identity), paths: {
    logDir: join(root, "logs"), plistPath: systemdUnitPath(identity, deps), stdoutPath: "", stderrPath: "", launchAgentsDir: dirname(systemdUnitPath(identity, deps)),
  } });
  if (!release) throw new Error("Another lifecycle command is active for this service.");
  try { return await action(); } finally { await release(); }
}

async function assertFragment(identity: string, service: SystemdService, deps: SystemdDeps): Promise<void> {
  if (service.fragmentPath && service.fragmentPath !== systemdUnitPath(identity, deps)
    && await realpath(service.fragmentPath) !== await realpath(systemdUnitPath(identity, deps))) {
    throw new Error(`Refusing foreign unit ${service.fragmentPath}.`);
  }
}

export async function stopSystemd(identity: string, deps: SystemdDeps = {}): Promise<void> {
  const definition = await readSystemdDefinition(identity, deps);
  const service = await inspectSystemd(identity, deps);
  await assertFragment(identity, service, deps);
  if (!definition) {
    if (service.loadState !== "not-found") throw new Error("Service exists without an owned unit; refusing to stop it.");
    return;
  }
  await checked(["disable", "--now", systemdUnitName(identity)], deps);
  const stopped = await inspectSystemd(identity, deps);
  if (stopped.pid !== 0 || !["inactive", "failed"].includes(stopped.activeState)) throw new Error("Service did not stop; its unit was retained.");
  await unlink(systemdUnitPath(identity, deps));
  await checked(["daemon-reload"], deps);
}

export async function startSystemd(
  definition: SystemdDefinition,
  restart: boolean,
  ready: (service: SystemdService) => Promise<boolean>,
  deps: SystemdDeps = {},
): Promise<void> {
  const identity = definition.identity;
  const previous = await readSystemdDefinition(identity, deps);
  const priorService = await inspectSystemd(identity, deps);
  await assertFragment(identity, priorService, deps);
  if (!previous && priorService.loadState !== "not-found") throw new Error("Service exists without an owned unit; refusing to replace it.");
  const contents = renderSystemdUnit(definition);
  if (!restart && priorService.activeState === "active") {
    if (!previous || renderSystemdUnit(previous) !== contents) throw new Error("Service configuration changed; use restart to apply it.");
    if (!await ready(priorService)) throw new Error("Service is running but has not reported ready; inspect status and logs.");
    return;
  }
  try {
    await publish(systemdUnitPath(identity, deps), contents);
    await checked(["daemon-reload"], deps);
    await checked(["enable", systemdUnitName(identity)], deps);
    await checked([restart ? "restart" : "start", systemdUnitName(identity)], deps);
    const now = deps.now ?? Date.now;
    const deadline = now() + 30_000;
    for (;;) {
      const service = await inspectSystemd(identity, deps);
      if (service.activeState === "active" && service.pid > 0 && await ready(service)) break;
      if (service.activeState === "failed" || now() >= deadline) throw new Error("Service did not report ready; inspect journal logs.");
      await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(200);
    }
  } catch (error) {
    try {
      const failedService = await inspectSystemd(identity, deps);
      if (failedService.pid > 0 || !["inactive", "failed"].includes(failedService.activeState)) {
        await checked(["stop", systemdUnitName(identity)], deps);
      }
      const stopped = await inspectSystemd(identity, deps);
      if (stopped.pid !== 0 || !["inactive", "failed"].includes(stopped.activeState)) throw new Error("Replacement worker is still running.");
      if (previous) await publish(systemdUnitPath(identity, deps), renderSystemdUnit(previous));
      else {
        await checked(["disable", systemdUnitName(identity)], deps);
        await unlink(systemdUnitPath(identity, deps));
      }
      await checked(["daemon-reload"], deps);
      if (previous) {
        await checked([priorService.enabled ? "enable" : "disable", systemdUnitName(identity)], deps);
        if (priorService.activeState === "active") await checked(["start", systemdUnitName(identity)], deps);
      }
    } catch (rollback) {
      throw new Error(`${String(error)}; rollback failed: ${String(rollback)}`);
    }
    throw error;
  }
  const linger = await (deps.run ?? runSystemdTool)("loginctl", ["show-user", String(process.getuid?.()), "--property=Linger", "--value"]);
  if (linger.code !== 0 || linger.stdout.trim() !== "yes") {
    (deps.stderr ?? process.stderr).write("Boot persistence is not confirmed. Run `loginctl enable-linger` for this user to keep services running after logout.\n");
  }
}

export async function systemdLogs(identity: string, follow: boolean, lines: number, deps: SystemdDeps = {}): Promise<number> {
  if (!Number.isSafeInteger(lines) || lines < 0) throw new Error("Log lines must be a nonnegative integer.");
  const args = ["--user", "--unit", systemdUnitName(identity), "--no-pager", "--lines", String(lines), ...(follow ? ["--follow"] : [])];
  if (deps.journal) return await deps.journal(args);
  return await new Promise<number>((resolve) => {
    const child = spawn("journalctl", args, { stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
