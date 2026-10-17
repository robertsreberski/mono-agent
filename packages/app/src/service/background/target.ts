import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

import {
  resolveAppTraceGlobalDiscovery,
  resolveAppTraceRegistryDir,
  resolveAppTraceStaleAfterMs,
  resolveGlobalTraceRegistryDir,
} from "../../composition/app-config.js";
import { defaultPathEnv, deriveLaunchdLabel, launchdPathsFor, MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV } from "../../launchd.js";
import { MANAGED_BACKGROUND_WORKER_ENV, selectBackgroundOperationalEnvironment } from "../../background-environment.js";
import { isErrno } from "../../background-lifecycle-utils.js";
import type { InstanceTarget, ResolveInstanceTargetInput } from "./types.js";

/** Exact non-secret environment materialised into a managed LaunchAgent. */
export function managedBackgroundEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return {
    ...selectBackgroundOperationalEnvironment(env),
    PATH: defaultPathEnv({ ...env }),
    // This is a lifecycle marker, not a config override. It tells cli.ts to
    // discard launchd's ambient environment before loading the chosen dotenv.
    [MANAGED_BACKGROUND_WORKER_ENV]: "1",
  };
}

/** Exact non-secret environment for the scheduled recovery/rotation controller. */
export function managedLaunchdLogMaintenanceEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return {
    ...selectBackgroundOperationalEnvironment(env),
    // This unattended helper needs only pinned system tools. Do not persist a
    // caller-controlled PATH that could shadow launchctl on a later run.
    PATH: "/usr/bin:/bin",
    [MANAGED_LAUNCHD_LOG_MAINTENANCE_ENV]: "1",
  };
}

/**
 * Resolve everything the control commands need from CLI args. The registry dir
 * and config path are resolved exactly as the worker will resolve them, so the
 * detached launcher can find the worker's manifest without any IPC.
 */
export async function resolveInstanceTarget(input: ResolveInstanceTargetInput): Promise<InstanceTarget> {
  const lexicalCwd = resolve(input.cwd);
  const [cwd, configPath] = await Promise.all([
    realpath(lexicalCwd),
    canonicalBackgroundConfigPath(lexicalCwd, input.args.configPath),
  ]);
  const configInput = { env: input.env, cwd, configPath };
  const [registryDir, staleAfterMs, globalDiscovery] = await Promise.all([
    resolveAppTraceRegistryDir(configInput),
    resolveAppTraceStaleAfterMs(configInput),
    resolveAppTraceGlobalDiscovery(configInput),
  ]);
  const globalRegistryDir = resolveGlobalTraceRegistryDir(input.env);
  const label = deriveLaunchdLabel(configPath);
  return {
    cwd,
    configPath,
    label,
    registryDir,
    ...(globalDiscovery && resolve(registryDir) !== globalRegistryDir ? { mirrorRegistryDir: globalRegistryDir } : {}),
    staleAfterMs,
    paths: launchdPathsFor(label),
    nodePath: process.execPath,
    cliPath: input.cliPath,
    controllerCliPath: input.cliPath,
    // Bake an explicit --env-file (resolved absolute) into the plist so the
    // launchd worker loads the same env file the launcher did.
    ...(input.args.envFile === undefined ? {} : { envFile: resolve(cwd, input.args.envFile) }),
    configurationEnvironment: { ...input.env },
    environment: managedBackgroundEnvironment(input.env),
  };
}

/**
 * Collapse symlinked parent aliases without following the config's final path
 * component. The final component is separately required to be a regular,
 * non-symlink file before start; keeping it unresolved preserves that check.
 * Missing parents remain addressable so stop/status/logs can still operate on
 * a previously installed label after an agent folder is damaged or removed.
 */
export async function canonicalBackgroundConfigPath(
  cwd: string,
  configuredPath?: string,
): Promise<string> {
  const lexical = resolve(cwd, configuredPath ?? "mono-agent.config.json");
  try {
    const candidate = join(await realpath(dirname(lexical)), basename(lexical));
    try {
      const details = await lstat(candidate);
      // Preserve the final-component symlink so the start-time regular-file
      // check can reject it. For a real file, realpath also canonicalises the
      // stored filename casing on the default case-insensitive macOS volume.
      return details.isSymbolicLink() ? candidate : await realpath(candidate);
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return candidate;
      throw error;
    }
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return lexical;
    throw error;
  }
}
