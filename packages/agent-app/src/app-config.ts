import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";

import type { ChannelConfigInput } from "@mono-agent/agent-contracts";
import {
  loadMonoAgentConfigWithSources,
  MonoAgentConfigError,
  readMonoAgentConfigJson,
} from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";

import { accountHomeDirectory } from "./account-home.js";
import { assertKnownAppConfigKeys } from "./config-reference.js";

// The structural shape moved to @mono-agent/agent-contracts (ChannelConfigInput)
// so channel drivers can be authored against the neutral contract; this alias
// preserves the historical app-side name.
export type MonoAgentAppConfigInput = ChannelConfigInput;

export async function loadAppCoreConfig(
  input: MonoAgentAppConfigInput,
  options: { readonly warnOnDeprecatedConfig?: boolean } = {},
): Promise<MonoAgentConfig> {
  const { json } = await readMonoAgentConfigJson(input.configPath);
  assertKnownAppConfigKeys(json);
  return await loadMonoAgentConfigWithSources({
    env: input.env,
    cwd: input.cwd,
    jsonPath: input.configPath,
    ...options,
  });
}

export function isAppCoreConfigError(error: unknown): error is MonoAgentConfigError {
  return error instanceof MonoAgentConfigError;
}

const DEFAULT_TRACE_HEARTBEAT_MS = 10_000;
const DEFAULT_TRACE_STALE_AFTER_MS = 30_000;
const DEFAULT_TRACE_SOURCE_ID_PREFIX = "mono-agent";
const DEFAULT_TRACE_SOURCE_LABEL = "Mono Agent";

/**
 * Trace defaults a host can override without touching the user's config file,
 * such as a host-specific source label.
 */
export interface AppTraceDefaults {
  readonly sourceIdPrefix?: string;
  readonly sourceLabel?: string;
}

/**
 * The resolvers below intentionally tolerate an incomplete or invalid config
 * file: traceability must stay usable while the user is still
 * fixing their config, so they fall back to defaults instead of throwing on
 * unreadable JSON.
 */
export async function resolveAppArtifactDir(input: MonoAgentAppConfigInput): Promise<string> {
  const envDir = input.env.MONO_AGENT_ARTIFACT_DIR?.trim();
  if (envDir !== undefined && envDir.length > 0) {
    return resolve(input.cwd, envDir);
  }

  try {
    const { json } = await readMonoAgentConfigJson(input.configPath);
    const configDir = typeof json.artifacts?.dir === "string" ? json.artifacts.dir.trim() : "";
    if (configDir.length > 0) {
      return resolve(input.cwd, configDir);
    }
  } catch {
    // Fall through to the default below.
  }

  return resolve(input.cwd, ".mono-agent", "artifacts");
}

/**
 * Resolve the durable pi-session store the runtime resumes from, the same way the
 * runtime does: the `MONO_AGENT_PI_SESSIONS_ROOT` env override first, then
 * `providers.piNative.piSessionsRoot` from the config file. Returns undefined when
 * neither is set — that means sessions are kept in-memory only, so there is nothing
 * on disk to purge. Tolerates an unreadable config like the resolvers above.
 */
export async function resolveAppSessionsRoot(input: MonoAgentAppConfigInput): Promise<string | undefined> {
  const envDir = input.env.MONO_AGENT_PI_SESSIONS_ROOT?.trim();
  if (envDir !== undefined && envDir.length > 0) {
    return resolve(input.cwd, envDir);
  }

  try {
    const { json } = await readMonoAgentConfigJson(input.configPath);
    const configDir =
      typeof json.providers?.piNative?.piSessionsRoot === "string"
        ? json.providers.piNative.piSessionsRoot.trim()
        : "";
    if (configDir.length > 0) {
      return resolve(input.cwd, configDir);
    }
  } catch {
    // Tolerate an unreadable config; there is nothing to purge if we cannot resolve it.
  }

  return undefined;
}

export async function resolveAppTraceRegistryDir(input: MonoAgentAppConfigInput): Promise<string> {
  const envDir = input.env.MONO_AGENT_TRACE_REGISTRY_DIR?.trim();
  if (envDir !== undefined && envDir.length > 0) {
    return resolve(input.cwd, envDir);
  }

  try {
    const { json } = await readMonoAgentConfigJson(input.configPath);
    const registryDir = typeof json.traceability?.registryDir === "string" ? json.traceability.registryDir.trim() : "";
    if (registryDir.length > 0) {
      return resolve(input.cwd, registryDir);
    }
  } catch {
    // Fall through to the default below.
  }

  return resolve(accountHomeDirectory(), ".mono-agent", "trace-sources");
}

export async function resolveAppTraceSourceId(
  input: MonoAgentAppConfigInput,
  defaults?: AppTraceDefaults,
  /** Canonical public identity path when `input.configPath` is an immutable private read copy. */
  fallbackConfigPath: string = input.configPath,
): Promise<string> {
  const envSourceId = input.env.MONO_AGENT_TRACE_SOURCE_ID?.trim();
  if (envSourceId !== undefined && envSourceId.length > 0) {
    return envSourceId;
  }

  try {
    const { json } = await readMonoAgentConfigJson(input.configPath);
    const sourceId = typeof json.traceability?.sourceId === "string" ? json.traceability.sourceId.trim() : "";
    if (sourceId.length > 0) {
      return sourceId;
    }
  } catch {
    // Use the deterministic cwd/config fallback below.
  }

  const hash = createHash("sha256")
    .update(resolve(input.cwd))
    .update("\0")
    .update(resolve(fallbackConfigPath))
    .digest("hex")
    .slice(0, 12);
  return `${defaults?.sourceIdPrefix ?? DEFAULT_TRACE_SOURCE_ID_PREFIX}-${hash}`;
}

export async function resolveAppTraceSourceLabel(
  input: MonoAgentAppConfigInput,
  defaults?: AppTraceDefaults,
): Promise<string> {
  const envLabel = input.env.MONO_AGENT_TRACE_SOURCE_LABEL?.trim();
  if (envLabel !== undefined && envLabel.length > 0) {
    return envLabel;
  }

  let jsonAgentName = "";
  try {
    const { json } = await readMonoAgentConfigJson(input.configPath);
    const label = typeof json.traceability?.sourceLabel === "string" ? json.traceability.sourceLabel.trim() : "";
    if (label.length > 0) {
      return label;
    }
    jsonAgentName = typeof json.agent?.name === "string" ? json.agent.name.trim() : "";
  } catch {
    // Keep the default label below.
  }

  const envAgentName = input.env.MONO_AGENT_NAME?.trim();
  if (envAgentName !== undefined && envAgentName.length > 0) {
    return envAgentName;
  }
  if (jsonAgentName.length > 0) return jsonAgentName;

  return defaults?.sourceLabel ?? DEFAULT_TRACE_SOURCE_LABEL;
}

export async function resolveAppTraceHeartbeatMs(input: MonoAgentAppConfigInput): Promise<number> {
  return await resolveTraceInteger({
    input,
    envName: "MONO_AGENT_TRACE_HEARTBEAT_MS",
    jsonKey: "heartbeatMs",
    defaultValue: DEFAULT_TRACE_HEARTBEAT_MS,
    min: 250,
    max: 86_400_000,
  });
}

export async function resolveAppTraceStaleAfterMs(input: MonoAgentAppConfigInput): Promise<number> {
  return await resolveTraceInteger({
    input,
    envName: "MONO_AGENT_TRACE_STALE_AFTER_MS",
    jsonKey: "staleAfterMs",
    defaultValue: DEFAULT_TRACE_STALE_AFTER_MS,
    min: 1_000,
    max: 604_800_000,
  });
}

/**
 * The machine-wide default registry every agent's manifest mirrors into
 * (unless it opts out via `traceability.globalDiscovery: false`), independent
 * of any per-instance `traceability.registryDir` override — this is
 * deliberately NOT read from the local config file, since the whole point is
 * to find agents whose OWN registry is somewhere else. The env override is a
 * seam for tests/ops (relocating the machine-wide default, e.g. a shared
 * mount) and must never be confused with `MONO_AGENT_TRACE_REGISTRY_DIR`
 * (which overrides a single instance's own registry).
 */
export function resolveGlobalTraceRegistryDir(env: Record<string, string | undefined>): string {
  const override = env.MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR?.trim();
  if (override !== undefined && override.length > 0) {
    return resolve(override);
  }
  return resolve(accountHomeDirectory(), ".mono-agent", "trace-sources");
}

export async function resolveAppTraceGlobalDiscovery(input: MonoAgentAppConfigInput): Promise<boolean> {
  const envValue = input.env.MONO_AGENT_TRACE_GLOBAL_DISCOVERY?.trim();
  if (envValue !== undefined && envValue.length > 0) {
    return parseTraceBoolean(envValue, "MONO_AGENT_TRACE_GLOBAL_DISCOVERY");
  }

  try {
    const { json } = await readMonoAgentConfigJson(input.configPath);
    const value = json.traceability?.globalDiscovery;
    if (typeof value === "boolean") {
      return value;
    }
  } catch {
    // Use the default while the user fixes an incomplete or invalid config.
  }

  return true;
}

function parseTraceBoolean(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new MonoAgentConfigError("invalid_env", `${name} must be true or false.`, { env: name });
}

/**
 * The root under which a trace registry counts as ephemeral: mirror
 * registration is suppressed for registries below it, so throwaway test/CI
 * runs never pollute the developer's real global registry. Defaults to the
 * real OS tmp directory; the env override is a TEST seam (same pattern as
 * `MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR`) letting integration tests point the
 * guard elsewhere so a genuine `mkdtemp(tmpdir())` fixture can exercise the
 * mirror-happens path.
 */
export function resolveTraceTmpdirRoot(env: Record<string, string | undefined>): string {
  const override = env.MONO_AGENT_TRACE_TMPDIR_ROOT?.trim();
  if (override !== undefined && override.length > 0) {
    return resolve(override);
  }
  return resolve(tmpdir());
}

/**
 * True when `path` resolves inside `tmpRoot` (default the real OS tmp
 * directory). Exported so the mirror-registration safety guard below is
 * directly unit-testable without touching the filesystem.
 */
export function isPathUnderTmpdir(path: string, tmpRoot: string = tmpdir()): boolean {
  const root = resolve(tmpRoot);
  const target = resolve(path);
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(rootWithSep);
}

export interface ShouldMirrorTraceSourceGloballyInput {
  readonly registryDir: string;
  readonly globalRegistryDir: string;
  readonly globalDiscovery: boolean;
  /** Test seam: the tmp root {@link isPathUnderTmpdir} compares against; defaults to the real OS tmp dir. */
  readonly tmpdirRoot?: string;
}

/**
 * Gate for the best-effort global-registry mirror (see {@link resolveGlobalTraceRegistryDir}):
 * an agent whose own registry differs from the machine-wide default also
 * registers there, so machine-wide operator clients find it — UNLESS the agent opted out (`traceability.globalDiscovery: false`),
 * its own registry already IS the global one (nothing to mirror), or its
 * registry lives under the OS tmp directory (keeps throwaway test/ephemeral
 * runs from polluting the developer's real global registry).
 */
export function shouldMirrorTraceSourceGlobally(input: ShouldMirrorTraceSourceGloballyInput): boolean {
  if (!input.globalDiscovery) {
    return false;
  }
  if (resolve(input.registryDir) === resolve(input.globalRegistryDir)) {
    return false;
  }
  return !isPathUnderTmpdir(input.registryDir, input.tmpdirRoot);
}

async function resolveTraceInteger(options: {
  readonly input: MonoAgentAppConfigInput;
  readonly envName: string;
  readonly jsonKey: "heartbeatMs" | "staleAfterMs";
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
}): Promise<number> {
  const envValue = options.input.env[options.envName]?.trim();
  if (envValue !== undefined && envValue.length > 0) {
    return parseTraceInteger(envValue, options.envName, options.min, options.max);
  }

  try {
    const { json } = await readMonoAgentConfigJson(options.input.configPath);
    const value = json.traceability?.[options.jsonKey];
    if (value !== undefined) {
      return parseTraceInteger(value, `traceability.${options.jsonKey}`, options.min, options.max);
    }
  } catch {
    // Use the default while the user fixes an incomplete or invalid config.
  }

  return options.defaultValue;
}

function parseTraceInteger(value: unknown, name: string, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new MonoAgentConfigError(
      "invalid_env",
      `${name} must be an integer between ${min} and ${max}.`,
      { env: name, reason: "integer_range" },
    );
  }
  return parsed;
}
