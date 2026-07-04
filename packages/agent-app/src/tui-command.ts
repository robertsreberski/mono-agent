import { dirname, resolve } from "node:path";

import { listTraceSources, mergeTraceSources, pruneTraceSources } from "@mono-agent/observability";
import type { TraceSourceListItem } from "@mono-agent/observability";
import { loadTuiAdapterConfig } from "@mono-agent/tui-adapter";

import { resolveAppTraceRegistryDir, resolveGlobalTraceRegistryDir } from "./app-config.js";

export interface RunTuiOptions {
  readonly configPath: string;
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  /** --agent: connect to this label or sourceId directly. */
  readonly agent?: string;
  /** --conversation: conversation id to chat under (default tui-<sourceId>). */
  readonly conversationId?: string;
}

/** Test seams: discovery + TUI boot are injectable. */
export interface RunTuiDeps {
  readonly listSources?: typeof listTraceSources;
  readonly startTui?: (options: Record<string, unknown>) => Promise<{ waitUntilExit(): Promise<void> }>;
  readonly isTty?: boolean;
  readonly stdout?: { write(text: string): void };
  readonly stderr?: { write(text: string): void };
}

export type TuiLaunchPlan =
  | { readonly kind: "none"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "connect"; readonly source: TraceSourceListItem }
  | { readonly kind: "picker"; readonly sources: readonly TraceSourceListItem[] };

/**
 * Pure selection logic for `mono-agent tui`: which running agent to connect
 * to, or whether to open the picker. `registryDirs` names every registry that
 * was consulted (one entry, or two when the configured registry and the
 * machine-wide global one differ) purely for the "nothing found" messaging.
 * Exported for unit tests.
 */
export function resolveTuiLaunch(
  sources: readonly TraceSourceListItem[],
  registryDirs: readonly string[],
  agentFilter: string | undefined,
): TuiLaunchPlan {
  const alive = sources.filter((source) => source.health !== "stopped");
  const registryLabel =
    registryDirs.length <= 1 ? `registry: ${registryDirs[0] ?? ""}` : `registries: ${registryDirs.join(", ")}`;
  if (agentFilter !== undefined) {
    const match = alive.find(
      (source) => source.label === agentFilter || source.sourceId === agentFilter,
    );
    if (match === undefined) {
      const available = alive.map((source) => `  ${source.label} (${source.sourceId})`).join("\n");
      return {
        kind: "error",
        message:
          `No running agent matches \`${agentFilter}\`.\n` +
          (alive.length === 0
            ? `No agents are running (${registryLabel}).`
            : `Running agents:\n${available}`),
      };
    }
    return { kind: "connect", source: match };
  }
  if (alive.length === 0) {
    return {
      kind: "none",
      message:
        `No running agents found (${registryLabel}).\n` +
        "Start one with `mono-agent start` in its folder, then run `mono-agent tui` again.",
    };
  }
  if (alive.length === 1 && alive[0] !== undefined) {
    return { kind: "connect", source: alive[0] };
  }
  return { kind: "picker", sources: alive };
}

/** Extract the tui channel's baseUrl from a manifest's channel summaries. */
export function tuiEndpointOf(source: TraceSourceListItem): string | undefined {
  const channels = source.metadata?.channels;
  if (typeof channels !== "object" || channels === null) {
    return undefined;
  }
  const tui = (channels as Record<string, unknown>).tui;
  if (typeof tui !== "object" || tui === null) {
    return undefined;
  }
  const record = tui as Record<string, unknown>;
  // Non-empty required: a malformed manifest with baseUrl "" must fall back to
  // discovery mode rather than attempt a broken connection.
  return record.kind === "running" && typeof record.baseUrl === "string" && record.baseUrl.length > 0
    ? record.baseUrl
    : undefined;
}

/**
 * `mono-agent tui`: discover running agents (machine-wide registry), resolve
 * the target's stream endpoint + key, and launch the operator console. Works
 * from any directory — with no local config the registry falls back to
 * ~/.mono-agent/trace-sources.
 */
export async function runTui(options: RunTuiOptions, deps: RunTuiDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  if ((deps.isTty ?? process.stdin.isTTY) !== true) {
    stderr.write("mono-agent tui needs an interactive terminal (stdin is not a TTY).\n");
    return 1;
  }

  const configuredRegistryDir = await resolveAppTraceRegistryDir({
    env: options.env,
    cwd: options.cwd,
    configPath: options.configPath,
  });
  const globalRegistryDir = resolveGlobalTraceRegistryDir(options.env);
  const listSources = deps.listSources ?? listTraceSources;

  // Use the registry's own echoed (normalized) dir from here on. The "does this
  // differ from the global registry" decision is made BEFORE querying (against
  // the resolvers' own output), not against the echoed result, since a listing
  // seam is free to echo back whatever registryDir it likes.
  const sameAsGlobal = resolve(configuredRegistryDir) === resolve(globalRegistryDir);
  const primary = await listSources({ registryDir: configuredRegistryDir });
  void pruneTraceSources({ registryDir: primary.registryDir });

  const merged = sameAsGlobal ? undefined : await listSources({ registryDir: globalRegistryDir });
  if (merged !== undefined) {
    void pruneTraceSources({ registryDir: merged.registryDir });
  }

  const sources = merged === undefined ? primary.sources : mergeTraceSources(primary.sources, merged.sources);
  // Every consulted registry, in precedence order. The TUI's discovery view
  // (picker, and its in-TUI `r`/`/agents` refresh) re-lists from these, so it
  // MUST see the full union: an agent present only in its local registry (a
  // globalDiscovery:false opt-out, or one still running a pre-mirror build)
  // stays visible from inside its own directory.
  const registryDirs = merged === undefined ? [primary.registryDir] : [primary.registryDir, merged.registryDir];
  const plan = resolveTuiLaunch(sources, registryDirs, options.agent);

  if (plan.kind === "none") {
    stdout.write(`${plan.message}\n`);
    return 1;
  }
  if (plan.kind === "error") {
    stderr.write(`${plan.message}\n`);
    return 1;
  }

  // Lazy: the TUI (and pi-tui) load only when this command actually runs.
  const startTui =
    deps.startTui ??
    (async (tuiOptions: Record<string, unknown>) => {
      const { startMonoAgentTui } = await import("@mono-agent/tui");
      return startMonoAgentTui(tuiOptions as never);
    });

  const common = {
    title: "mono-agent",
    env: options.env,
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
  };

  if (plan.kind === "picker") {
    const handle = await startTui({ ...common, discovery: { registryDirs } });
    await handle.waitUntilExit();
    return 0;
  }

  const source = plan.source;
  const baseUrl = tuiEndpointOf(source);
  const apiKey = await resolveAgentApiKey(source, options.env);
  const handle = await startTui({
    ...common,
    ...(baseUrl === undefined
      ? // No stream endpoint (tui channel disabled): replay/config still work.
        { discovery: { registryDirs } }
      : { connection: { baseUrl, ...(apiKey === undefined ? {} : { apiKey }) } }),
    instance: {
      label: source.label,
      artifactDir: source.artifactDir,
      ...(source.configPath === undefined ? {} : { configPath: source.configPath }),
    },
    ...(options.conversationId === undefined ? { conversationId: `tui-${source.sourceId}` } : {}),
    subtitle: source.configPath === undefined ? source.sourceId : dirname(resolve(source.configPath)),
  });
  if (baseUrl === undefined) {
    stdout.write(
      `Agent \`${source.label}\` has no tui stream endpoint (channel disabled?) — opening in discovery mode; replay/config remain available.\n`,
    );
  }
  await handle.waitUntilExit();
  return 0;
}

/**
 * The registry never carries secrets: read `tui.apiKey` through the adapter's
 * own loader against the agent's config file (json→env layering included).
 */
async function resolveAgentApiKey(
  source: TraceSourceListItem,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  if (source.configPath === undefined) {
    return env.MONO_AGENT_TUI_API_KEY;
  }
  try {
    const config = await loadTuiAdapterConfig({ env, jsonPath: source.configPath });
    return config.apiKey;
  } catch {
    return env.MONO_AGENT_TUI_API_KEY;
  }
}
