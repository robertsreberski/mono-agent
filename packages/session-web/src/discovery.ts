/**
 * Instance discovery for the web operator surface. Reimplemented directly on
 * `@mono-agent/observability` (the trace-source registry) rather than importing
 * the TUI's `packages/tui/src/data/instances.ts`: both are `operator-surface`
 * packages and may not depend on each other. The logic mirrors the TUI's
 * (`discoverInstances`/`tuiBaseUrlFromMetadata`/`resolveInstanceApiKey`), but keyed
 * on the `live` channel (the sub-run SSE endpoint) rather than `tui`.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { listTraceSources, mergeTraceSources } from "@mono-agent/observability";
import type { TraceSourceListItem } from "@mono-agent/observability";

import type { WebInstance } from "./session-model.js";

/** The default machine-wide registry dir every agent writes to unless overridden. */
export function defaultTraceRegistryDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.MONO_AGENT_TRACE_REGISTRY_DIR?.trim();
  if (override !== undefined && override.length > 0) {
    return resolve(override);
  }
  return resolve(homedir(), ".mono-agent", "trace-sources");
}

export interface DiscoverWebInstancesOptions {
  /** Registries to consult (merged by sourceId — fresher heartbeat wins a duplicate). */
  readonly registryDirs: readonly string[];
  readonly staleAfterMs?: number;
  readonly env?: Record<string, string | undefined>;
}

/**
 * A discovered instance: the browser-facing {@link WebInstance} projection plus
 * the internal routing facts the aggregator needs — the winning manifest (for
 * `configPath`, health, metadata) and the resolved `live` SSE base URL. The
 * projection's `liveConnected` is always `false` and `counts.runs` always `0` at
 * discovery time; the aggregator overwrites both from its own live-connection and
 * session state before serving.
 */
export interface DiscoveredWebInstance {
  readonly instance: WebInstance;
  /** The winning trace-source manifest this instance was discovered from. */
  readonly source: TraceSourceListItem;
  /** The `live` channel's SSE base URL, when the instance publishes a running `live` endpoint. */
  readonly liveBaseUrl?: string;
}

/**
 * Discover mono-agent instances via one or more trace-source registries (merged
 * by sourceId). Stopped sources are filtered out; stale ones stay listed (marked
 * by health) because a busy agent can miss heartbeats while still connectable.
 */
export async function discoverWebInstances(
  options: DiscoverWebInstancesOptions,
): Promise<readonly DiscoveredWebInstance[]> {
  const registryDirs = normalizeRegistryDirs(options.registryDirs);
  const results = await Promise.all(
    registryDirs.map((registryDir) =>
      listTraceSources({
        registryDir,
        ...(options.staleAfterMs === undefined ? {} : { staleAfterMs: options.staleAfterMs }),
      }),
    ),
  );
  return mergeTraceSources(...results.map((result) => result.sources))
    .filter((source) => source.health !== "stopped")
    .map((source) => toDiscoveredInstance(source));
}

function toDiscoveredInstance(source: TraceSourceListItem): DiscoveredWebInstance {
  const liveBaseUrl = liveBaseUrlFromMetadata(source.metadata);
  const cwd = source.configPath !== undefined ? dirname(source.configPath) : dirname(source.artifactDir);
  const instance: WebInstance = {
    sourceId: source.sourceId,
    label: source.label,
    cwd,
    artifactDir: source.artifactDir,
    health: source.health,
    liveConnected: false,
    counts: { runs: 0 },
  };
  return {
    instance,
    source,
    ...(liveBaseUrl === undefined ? {} : { liveBaseUrl }),
  };
}

/**
 * Extract the `live` SSE base URL from a trace-source's metadata. Mirrors the
 * TUI's `tuiBaseUrlFromMetadata`, keyed on `channels.live` instead of
 * `channels.tui`: an instance that is not running its `live` channel (kind other
 * than "running", or an empty baseUrl) yields `undefined`, so the aggregator
 * simply won't open a sub-run stream to it.
 */
export function liveBaseUrlFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  const channels = metadata?.channels;
  if (typeof channels !== "object" || channels === null) {
    return undefined;
  }
  const live = (channels as Record<string, unknown>).live;
  if (typeof live !== "object" || live === null) {
    return undefined;
  }
  const record = live as Record<string, unknown>;
  if (record.kind !== "running") {
    return undefined;
  }
  return typeof record.baseUrl === "string" && record.baseUrl.length > 0 ? record.baseUrl : undefined;
}

/**
 * Best-effort apiKey for an instance's `live` endpoint. The registry never
 * carries secrets, so resolve from THIS process's `MONO_AGENT_LIVE_API_KEY`
 * first, else read the agent's own config file (`live.apiKey`). Failures resolve
 * `undefined` — a keyless connect against a keyed agent surfaces as a 401. Mirrors
 * the TUI's `resolveInstanceApiKey` (keyed on `live` rather than `tui`).
 */
export async function resolveLiveApiKey(
  instance: DiscoveredWebInstance,
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  const fromEnv = env.MONO_AGENT_LIVE_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  const configPath = instance.source.configPath;
  if (configPath === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as { live?: { apiKey?: unknown } };
    // Trim to match the adapter's own loader (normalizeOptionalString): the server
    // compares against the trimmed key, so an untrimmed client would 401.
    const apiKey = typeof parsed.live?.apiKey === "string" ? parsed.live.apiKey.trim() : undefined;
    return apiKey !== undefined && apiKey.length > 0 ? apiKey : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve + dedupe the requested registry list; empties fall back to the machine-wide default. */
function normalizeRegistryDirs(registryDirs: readonly string[]): string[] {
  const requested = registryDirs.length > 0 ? registryDirs : [defaultTraceRegistryDir()];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of requested) {
    const resolved = resolve(dir);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      dirs.push(resolved);
    }
  }
  return dirs;
}
