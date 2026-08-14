#!/usr/bin/env node

import { basename, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  deriveLaunchdLabel,
  INTERNAL_LAUNCHD_LOG_MAINTENANCE_COMMAND,
  launchdMaintenanceDispersionSeconds,
  launchdPathsFor,
  MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV,
} from "./launchd.js";
import type { LaunchdPaths } from "./launchd.js";
import { MANAGED_LAUNCHD_MAINTENANCE_ENTRY_FILE } from "./launchd-maintenance-command.js";
import type { LaunchdMaintenanceCommandArgs } from "./launchd-maintenance-command.js";
import {
  defaultLaunchdMaintenanceGateDependencies,
  withLaunchdMaintenanceControllerLock,
} from "./launchd-maintenance-gate.js";
import type {
  LaunchdMaintenanceGateDependencies,
  LaunchdMaintenanceLifecycleLease,
} from "./launchd-maintenance-gate.js";
import { sanitizeManagedLaunchdLogMaintenanceEnvironment } from "./managed-launchd-maintenance-environment.js";
import {
  verifyManagedRuntimeMaintenanceEntrypoint,
} from "./managed-runtime-maintenance-entry.js";

interface HeavyMaintenanceModule {
  readonly runLaunchdLogMaintenanceCommandWithLifecycleLease: (
    args: LaunchdMaintenanceCommandArgs,
    ownership: LaunchdMaintenanceLifecycleLease,
  ) => Promise<number>;
}

export interface LaunchdMaintenanceEntryDependencies {
  readonly gate: LaunchdMaintenanceGateDependencies;
  readonly pathsForLabel: (label: string) => LaunchdPaths;
  readonly verifyEntrypoint: typeof verifyManagedRuntimeMaintenanceEntrypoint;
  readonly loadHeavy: () => Promise<HeavyMaintenanceModule>;
  readonly currentEntrypointPath: string;
  readonly platform: NodeJS.Platform;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly stderr: (text: string) => void | Promise<void>;
}

export function defaultLaunchdMaintenanceEntryDependencies(): LaunchdMaintenanceEntryDependencies {
  return {
    gate: defaultLaunchdMaintenanceGateDependencies(),
    pathsForLabel: (label) => launchdPathsFor(label),
    verifyEntrypoint: verifyManagedRuntimeMaintenanceEntrypoint,
    loadHeavy: async () => await import("./cli-background-command.js"),
    currentEntrypointPath: fileURLToPath(import.meta.url),
    platform: process.platform,
    sleep: wait,
    stderr: (text) => void process.stderr.write(text),
  };
}

/** Dedicated entry: deterministic dispersion and the per-agent lease precede heavy imports. */
export async function runLaunchdMaintenanceEntry(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  deps: LaunchdMaintenanceEntryDependencies = defaultLaunchdMaintenanceEntryDependencies(),
): Promise<number> {
  const command = argv[0];
  const marked = env[MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV] === "1";
  if (command !== INTERNAL_LAUNCHD_LOG_MAINTENANCE_COMMAND) {
    safeStderr(
      deps,
      marked
        ? "The managed log-maintenance marker cannot authorize another command."
        : "The launchd maintenance entry only accepts its reserved managed command.",
    );
    return 2;
  }
  if (!marked) {
    safeStderr(deps, "The launchd log maintenance command is reserved for its managed LaunchAgent.");
    return 2;
  }
  sanitizeManagedLaunchdLogMaintenanceEnvironment(env);
  if (deps.platform !== "darwin") {
    safeStderr(deps, "Scheduled log maintenance is only available on macOS launchd.");
    return 1;
  }

  let args: LaunchdMaintenanceCommandArgs;
  try {
    args = parseManagedArguments(argv);
  } catch (error) {
    safeStderr(deps, safeError(error));
    return 2;
  }
  const configPath = resolve(args.configPath);
  const label = deriveLaunchdLabel(configPath);
  const target = { label, paths: deps.pathsForLabel(label) };
  try {
    // RunAtLoad starts every helper together. Preserve N/N recovery coverage
    // while spreading the heavy boundary deterministically without new lock
    // authority or stale-owner state.
    await deps.sleep(launchdMaintenanceDispersionSeconds(label) * 1_000);
    return await withLaunchdMaintenanceControllerLock(target, deps.gate, async (ownership) => {
      await deps.verifyEntrypoint({
        currentEntrypointPath: deps.currentEntrypointPath,
        launchProof: args.expectedManagedRuntimeLaunch,
      });
      const heavy = await deps.loadHeavy();
      return await heavy.runLaunchdLogMaintenanceCommandWithLifecycleLease(args, ownership);
    });
  } catch (error) {
    safeStderr(deps, `Scheduled recovery could not establish its dispersed attested ownership boundary: ${safeError(error)}`);
    return 1;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function parseManagedArguments(argv: readonly string[]): LaunchdMaintenanceCommandArgs {
  const required = [
    "--config",
    "--controller-cli",
    "--agent-cwd",
    "--agent-path",
    "--expected-managed-runtime-launch",
  ] as const;
  let index = 1;
  const values: string[] = [];
  for (const flag of required) {
    if (argv[index++] !== flag) throw new Error(`Managed launchd recovery requires ${flag}.`);
    const value = argv[index++];
    if (value === undefined || value.length === 0 || hasControlCharacter(value)) {
      throw new Error(`Managed launchd recovery received an invalid ${flag} value.`);
    }
    values.push(value);
  }
  let envFile: string | undefined;
  if (argv[index] === "--env-file") {
    envFile = argv[index + 1];
    index += 2;
    if (envFile === undefined || !isAbsolute(envFile) || hasControlCharacter(envFile)) {
      throw new Error("Managed launchd recovery received an invalid --env-file value.");
    }
  }
  if (index !== argv.length) throw new Error("Managed launchd recovery received unexpected arguments.");
  const [configPath, controllerCliPath, agentCwd, agentPath, expectedManagedRuntimeLaunch] = values as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (![configPath, controllerCliPath, agentCwd].every((path) => isAbsolute(path))) {
    throw new Error("Managed launchd recovery requires absolute config, controller CLI, and agent cwd paths.");
  }
  if (!/^[0-9A-Za-z_-]+$/u.test(expectedManagedRuntimeLaunch)) {
    throw new Error("Managed launchd recovery received a malformed runtime launch proof.");
  }
  return {
    configPath,
    controllerCliPath,
    agentCwd,
    agentPath,
    expectedManagedRuntimeLaunch,
    ...(envFile === undefined ? {} : { envFile }),
  };
}

function safeStderr(deps: Pick<LaunchdMaintenanceEntryDependencies, "stderr">, message: string): void {
  const line = `[error] ${message}\n`;
  try {
    const reported = deps.stderr(line);
    if (reported !== undefined) void Promise.resolve(reported).catch(() => undefined);
  } catch {
    // Reporter failure never becomes an unhandled rejection or widens authority.
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\b(token|secret|password|api[-_]?key|authorization)\s*[=:]\s*\S+/giu, "$1=<redacted>")
    .replace(/\bBearer\s+\S+/giu, "Bearer <redacted>")
    .replace(/(?:\/[A-Za-z0-9._~!$&'()+,;=:@%-]+){2,}/gu, "<path>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 512);
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

const entryName = process.argv[1] === undefined ? undefined : basename(process.argv[1]);
if (entryName === MANAGED_LAUNCHD_MAINTENANCE_ENTRY_FILE) {
  runLaunchdMaintenanceEntry(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`[error] Launchd maintenance failed: ${safeError(error)}\n`);
      process.exitCode = 1;
    });
}
