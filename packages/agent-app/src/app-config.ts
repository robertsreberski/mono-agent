import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";

import type { ChannelConfigInput } from "@mono-agent/agent-contracts";
import {
  loadMonoAgentConfig,
  MonoAgentConfigError,
  readMonoAgentConfigJson,
} from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";

import { accountHomeDirectory } from "./account-home.js";
import { assertKnownAppConfigKeys } from "./config-reference.js";

// The structural shape moved to @mono-agent/agent-contracts (ChannelConfigInput)
// so channel drivers can be authored against the neutral contract; this alias
// preserves the historical app-side name.
export interface PrivateBackgroundRuntimePaths {
  readonly identityPath: string;
  readonly soulPath?: string;
  readonly mcpConfigPath?: string;
}

export type MonoAgentAppConfigInput = ChannelConfigInput & {
  /** Internal managed-worker paths to exact, attested private copies; never read from env. */
  readonly privateRuntimePaths?: PrivateBackgroundRuntimePaths;
};

export async function loadAppCoreConfig(
  input: MonoAgentAppConfigInput,
  options: { readonly warnOnDeprecatedConfig?: boolean } = {},
): Promise<MonoAgentConfig> {
  const { json } = await readMonoAgentConfigJson(input.configPath);
  assertKnownAppConfigKeys(json);
  const config = await loadMonoAgentConfig({
    cwd: input.cwd,
    jsonPath: input.configPath,
    ...options,
  });
  const paths = input.privateRuntimePaths;
  if (paths === undefined) return config;
  return {
    ...config,
    context: {
      ...config.context,
      identityPath: paths.identityPath,
      ...(paths.soulPath === undefined ? {} : { soulPath: paths.soulPath }),
    },
    tools: {
      ...config.tools,
      ...(paths.mcpConfigPath === undefined ? {} : { mcpConfigPath: paths.mcpConfigPath }),
    },
  };
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
 * runtime does: from `providers.piNative.piSessionsRoot` in the config file. Returns undefined when
 * neither is set — that means sessions are kept in-memory only, so there is nothing
 * on disk to purge. Tolerates an unreadable config like the resolvers above.
 */
export async function resolveAppSessionsRoot(input: MonoAgentAppConfigInput): Promise<string | undefined> {
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

  if (jsonAgentName.length > 0) return jsonAgentName;

  return defaults?.sourceLabel ?? DEFAULT_TRACE_SOURCE_LABEL;
}

export async function resolveAppTraceHeartbeatMs(input: MonoAgentAppConfigInput): Promise<number> {
  return await resolveTraceInteger({
    input,
    jsonKey: "heartbeatMs",
    defaultValue: DEFAULT_TRACE_HEARTBEAT_MS,
    min: 250,
    max: 86_400_000,
  });
}

export async function resolveAppTraceStaleAfterMs(input: MonoAgentAppConfigInput): Promise<number> {
  return await resolveTraceInteger({
    input,
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
  readonly jsonKey: "heartbeatMs" | "staleAfterMs";
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
}): Promise<number> {
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
