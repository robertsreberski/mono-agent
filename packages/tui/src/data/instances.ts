import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { listTraceSources } from "@mono-agent/observability";
import type { TraceSourceListItem } from "@mono-agent/observability";

export type { TraceSourceListItem } from "@mono-agent/observability";

/** The default machine-wide registry dir every agent writes to unless overridden. */
export function defaultTraceRegistryDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.MONO_AGENT_TRACE_REGISTRY_DIR?.trim();
  if (override !== undefined && override.length > 0) {
    return resolve(override);
  }
  return resolve(homedir(), ".mono-agent", "trace-sources");
}

export interface DiscoverInstancesOptions {
  readonly registryDir?: string;
  readonly staleAfterMs?: number;
  readonly env?: Record<string, string | undefined>;
}

export interface DiscoveredInstance {
  readonly source: TraceSourceListItem;
  /** The tui-adapter base URL published by the agent's tui channel, when running. */
  readonly tuiBaseUrl?: string;
  /** dirname(configPath): where replay/config data lives relative to. */
  readonly agentDir?: string;
}

/**
 * Discover mono-agent instances via the trace-source registry. Stopped sources
 * are filtered out; stale ones stay listed (marked by health) because a busy
 * agent can miss heartbeats while remaining connectable.
 */
export async function discoverInstances(
  options: DiscoverInstancesOptions = {},
): Promise<{ instances: readonly DiscoveredInstance[]; registryDir: string; warnings: readonly string[] }> {
  const registryDir = options.registryDir ?? defaultTraceRegistryDir(options.env);
  const result = await listTraceSources({
    registryDir,
    ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
  });
  const instances = result.sources
    .filter((source) => source.health !== "stopped")
    .map((source) => toInstance(source));
  return { instances, registryDir, warnings: result.warnings };
}

export function toInstance(source: TraceSourceListItem): DiscoveredInstance {
  const tuiBaseUrl = tuiBaseUrlFromMetadata(source.metadata);
  return {
    source,
    ...(tuiBaseUrl === undefined ? {} : { tuiBaseUrl }),
    ...(source.configPath === undefined ? {} : { agentDir: dirname(source.configPath) }),
  };
}

function tuiBaseUrlFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  const channels = metadata?.channels;
  if (typeof channels !== "object" || channels === null) {
    return undefined;
  }
  const tui = (channels as Record<string, unknown>).tui;
  if (typeof tui !== "object" || tui === null) {
    return undefined;
  }
  const record = tui as Record<string, unknown>;
  if (record.kind !== "running") {
    return undefined;
  }
  return typeof record.baseUrl === "string" && record.baseUrl.length > 0 ? record.baseUrl : undefined;
}

/**
 * Best-effort apiKey resolution for a discovered agent: the registry never
 * carries secrets, so read the agent's own config file (`tui.apiKey` /
 * `MONO_AGENT_TUI_API_KEY` env of THIS process). Failures resolve undefined —
 * a keyless connect against a keyed agent surfaces as 401 with a hint.
 */
export async function resolveInstanceApiKey(
  instance: DiscoveredInstance,
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  const fromEnv = env.MONO_AGENT_TUI_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  const configPath = instance.source.configPath;
  if (configPath === undefined) {
    return undefined;
  }
  try {
    const { readFile } = await import("node:fs/promises");
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      tui?: { apiKey?: unknown };
    };
    // Trim to match the adapter's own loader (normalizeOptionalString): the
    // server compares against the trimmed key, so an untrimmed client 401s.
    const apiKey = typeof parsed.tui?.apiKey === "string" ? parsed.tui.apiKey.trim() : undefined;
    return apiKey !== undefined && apiKey.length > 0 ? apiKey : undefined;
  } catch {
    return undefined;
  }
}
