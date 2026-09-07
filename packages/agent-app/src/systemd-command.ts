import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listTraceSources } from "@mono-agent/observability";
import type { TraceSourceListItem } from "@mono-agent/observability";

import { canonicalBackgroundConfigPath, resolveInstanceTarget } from "./background.js";
import { selectBackgroundOperationalEnvironment } from "./background-environment.js";
import { loadDurableBackgroundEnvironment } from "./background-snapshot.js";
import type { ParsedCliArgs } from "./cli-args.js";
import { ensureStartable } from "./cli-background-command.js";
import { hasCompletedManagedStartup } from "./managed-startup.js";
import {
  inspectSystemd, isSystemdUserManagerUnavailable, readSystemdDefinition, startSystemd, stopSystemd, systemdLogs,
  systemdUnitName, withSystemdLock, SYSTEMD_WEB_IDENTITY,
} from "./systemd.js";
import type { SystemdDefinition, SystemdDeps, SystemdService } from "./systemd.js";
import type { RunWebCommandOptions } from "./web-command.js";

const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
type Action = "start" | "restart" | "stop" | "status" | "logs";

/** Clear the systemd manager's ambient environment; provider settings come from dotenv. */
function workerArgv(args: readonly string[], environment: Readonly<Record<string, string>>): readonly string[] {
  return ["/usr/bin/env", "-i", ...Object.entries(environment).map(([key, value]) => `${key}=${value}`), process.execPath, "--", cliPath, ...args];
}

function operationalEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const selected = { ...selectBackgroundOperationalEnvironment(env) };
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    if (env[key] !== undefined) selected[key] = env[key];
  }
  return selected;
}

function statusFields(identity: string, service: SystemdService, ready: boolean) {
  return { backend: "systemd-user", unit: systemdUnitName(identity), runtime: "dev (unmanaged)", ...service, ready } as const;
}

function report(identity: string, service: SystemdService, ready: boolean, deps: SystemdDeps): void {
  const status = statusFields(identity, service, ready);
  (deps.stdout ?? process.stdout).write(
    `${status.unit}: ${service.activeState}/${service.subState}; PID ${service.pid}; ready ${ready ? "yes" : "no"}\nRuntime: dev (unmanaged)\nStarted: ${service.startedAt || "—"}; boot enabled: ${service.enabled ? "yes" : "no"}\n`,
  );
}

function reportAgentJson(identity: string, installed: boolean, service: SystemdService, ready: boolean, deps: SystemdDeps): void {
  const status = { backend: "systemd-user", unit: systemdUnitName(identity), runtime: "dev (unmanaged)", ...service, ready };
  const present = installed || service.loadState !== "not-found";
  (deps.stdout ?? process.stdout).write(`${JSON.stringify({
    ok: ready,
    instance: present ? {
      pid: service.pid > 0 ? service.pid : null,
      health: ready ? "running" : service.activeState === "failed" ? "crashed" : "stopped",
      status: service.activeState,
      configPath: identity,
      startedAt: service.startedAt,
    } : null,
    others: [],
    ...status,
  })}\n`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function runSystemdAgentCommand(
  args: ParsedCliArgs, action: Action, env: Record<string, string | undefined>, deps: SystemdDeps = {},
): Promise<number> {
  const stderr = deps.stderr ?? process.stderr;
  try {
    const identity = await canonicalBackgroundConfigPath(process.cwd(), args.configPath);
    if (action === "logs") return await systemdLogs(identity, args.follow, args.lines ?? 200, deps);
    if (action === "stop") {
      await withSystemdLock(identity, deps, () => stopSystemd(identity, deps));
      (deps.stdout ?? process.stdout).write(`${systemdUnitName(identity)} stopped and removed.\n`);
      return 0;
    }
    if (action === "restart" && args.clearSessions) {
      throw new Error("Linux restart --clear-sessions is not supported yet. No service or conversation state was changed.");
    }
    // Read the installed cwd/env-file when inspecting or restarting from another directory.
    const installed = await readSystemdDefinition(identity, deps);
    const cwd = installed?.cwd ?? await realpath(process.cwd());
    const envIndex = installed?.argv.indexOf("--env-file") ?? -1;
    const envFile = args.envFile === undefined
      ? (envIndex >= 0 ? installed?.argv[envIndex + 1] : undefined) ?? resolve(cwd, ".env")
      : resolve(process.cwd(), args.envFile);
    const environment = operationalEnvironment(env);
    if (action === "status") {
      const service = await inspectSystemd(identity, deps);
      let healthy = false;
      if (installed && service.activeState === "active" && service.pid > 0) {
        try {
          const effective = { ...await loadDurableBackgroundEnvironment({ cwd, envFile, operationalEnvironment: environment }), ...environment };
          const target = await resolveInstanceTarget({ args: { configPath: identity, envFile }, env: effective, cwd, cliPath });
          const traces = await listTraceSources({ registryDir: target.registryDir, staleAfterMs: target.staleAfterMs });
          healthy = traces.sources.some((source) => source.configPath === identity && source.pid === service.pid && sourceReady(source));
        } catch {
          stderr.write("Service state is available, but config/trace readiness could not be read. Inspect validate and logs.\n");
        }
      }
      if (args.json === true) reportAgentJson(identity, installed !== undefined, service, healthy, deps);
      else report(identity, service, healthy, deps);
      return healthy ? 0 : 1;
    }
    const effective = { ...await loadDurableBackgroundEnvironment({ cwd, envFile, operationalEnvironment: environment }), ...environment };
    const target = await resolveInstanceTarget({ args: { configPath: identity, envFile }, env: effective, cwd, cliPath });
    const ready = async (service: SystemdService): Promise<boolean> => {
      const result = await listTraceSources({ registryDir: target.registryDir, staleAfterMs: target.staleAfterMs });
      return result.sources.some((source) => source.configPath === identity && source.pid === service.pid && sourceReady(source));
    };
    const preflight = await ensureStartable(args, effective, { cwd, configPath: identity });
    if (!preflight.ok) {
      stderr.write(preflight.kind === "missing-config" ? `No config at ${identity}. Run mono-agent init.\n`
        : `Cannot start: ${preflight.report.sections.filter((section) => section.status === "error").map((section) => `${section.label}: ${section.details.join("; ")}`).join("\n")}\n`);
      return preflight.code;
    }
    const definition: SystemdDefinition = { identity, cwd, environment: {}, argv: workerArgv([
      "start", "--foreground", "--config", identity, "--env-file", envFile,
    ], environment) };
    await withSystemdLock(identity, deps, async () => {
      // The foreground singleton lease is the final guard; fail before installing a unit when a live trace is already present.
      const current = await inspectSystemd(identity, deps);
      const traces = await listTraceSources({ registryDir: target.registryDir, staleAfterMs: target.staleAfterMs });
      const isAlive = deps.isAlive ?? processIsAlive;
      if (traces.sources.some((source) => source.configPath === identity && source.health === "running"
        && source.pid !== undefined && source.pid > 0 && source.pid !== current.pid && isAlive(source.pid))) {
        throw new Error("Another supervisor or foreground worker already runs this config. Stop it explicitly before installing a Mono systemd service.");
      }
      await startSystemd(definition, action === "restart", ready, deps);
    });
    report(identity, await inspectSystemd(identity, deps), true, deps);
    return 0;
  } catch (error) {
    stderr.write(`Linux lifecycle: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function sourceReady(source: TraceSourceListItem): boolean {
  if (source.health !== "running" || !hasCompletedManagedStartup(source) || source.memoryHealth?.status === "unhealthy") return false;
  const channels = source.metadata?.channels;
  return !channels || typeof channels !== "object" || !Object.values(channels).some((channel) =>
    channel !== null && typeof channel === "object" && (channel as { kind?: string }).kind === "failed");
}

export async function runSystemdWebCommand(options: RunWebCommandOptions, deps: SystemdDeps = {}): Promise<number> {
  const identity = SYSTEMD_WEB_IDENTITY;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const action = options.positionals[0] ?? "status";
  try {
    if (action === "logs") return await systemdLogs(identity, options.follow === true, options.lines ?? 200, deps);
    if (action === "stop") {
      await withSystemdLock(identity, deps, () => stopSystemd(identity, deps));
      stdout.write("Web systemd service stopped and removed; conversation data and external HTTPS routes retained.\n");
      return 0;
    }
    const installed = await readSystemdDefinition(identity, deps);
    const previousOption = (key: string): string | undefined => {
      const index = installed?.argv.indexOf(key) ?? -1;
      return index < 0 ? undefined : installed?.argv[index + 1];
    };
    const host = options.loopback ? "127.0.0.1" : options.host ?? previousOption("--host") ?? "0.0.0.0";
    const port = options.port ?? Number(previousOption("--port") ?? 5050);
    const theme = options.theme ?? previousOption("--theme") ?? "evergreen";
    // No default: an absent name means the worker falls back to the machine hostname.
    let consoleName = previousOption("--name");
    if (options.name !== undefined) {
      const requestedName = options.name.trim();
      consoleName = requestedName === "-" ? undefined : requestedName;
    }
    const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" || host === "[::]" ? "[::1]" : host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    const url = `http://${probeHost}:${port}/`;
    const { webHealthcheck } = await import("./web-command.js");
    const ready = async () => await webHealthcheck(`${url}healthz`);
    if (action === "status") {
      const service = await inspectSystemd(identity, deps);
      const healthy = service.activeState === "active" && service.pid > 0 && await ready();
      report(identity, service, healthy, deps);
      stdout.write(`Web: ${url}\nTheme: ${theme}\nName: ${consoleName ?? "— (machine hostname)"}\nHTTPS routes: externally managed; inspect tailscale serve status.\n`);
      return options.positionals.length === 0 ? 0 : healthy ? 0 : 1;
    }
    if (action !== "start" && action !== "restart") throw new Error(`Unsupported systemd web action: ${action}`);
    const environment = operationalEnvironment(options.env);
    const previousAllowed = installed?.argv.find((arg) => arg.startsWith("MONO_AGENT_WEB_ALLOWED_HOSTS="))?.slice("MONO_AGENT_WEB_ALLOWED_HOSTS=".length);
    const allowed = options.env.MONO_AGENT_WEB_ALLOWED_HOSTS ?? previousAllowed;
    if (allowed !== undefined) environment.MONO_AGENT_WEB_ALLOWED_HOSTS = allowed;
    const definition: SystemdDefinition = { identity, cwd: deps.homeDir ?? homedir(), environment: {},
      argv: workerArgv([
        "web", "run", "--host", host, "--port", String(port), "--theme", theme,
        ...(consoleName === undefined ? [] : ["--name", consoleName]),
      ], environment) };
    await withSystemdLock(identity, deps, async () => {
      const service = await inspectSystemd(identity, deps);
      const ownedServiceMayAnswer = installed !== undefined && service.pid > 0 && Number(previousOption("--port")) === port;
      if (!ownedServiceMayAnswer && await ready()) throw new Error("A web console already answers at this address. Stop its existing supervisor before installing this service.");
      await startSystemd(definition, action === "restart", ready, deps);
    });
    stdout.write(`Web ready: ${url}\nRuntime: dev (unmanaged); logs: mono-agent web logs\nHTTPS routes remain externally managed on Linux.\n`);
    return 0;
  } catch (error) {
    if (action === "status" && isSystemdUserManagerUnavailable(error)) throw error;
    stderr.write(`Linux web lifecycle: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
