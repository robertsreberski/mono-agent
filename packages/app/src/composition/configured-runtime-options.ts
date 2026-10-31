import type { MonoAgentConfig } from "@mono-agent/config";
import { createPiOAuthApiKeyResolver } from "@mono-agent/turn";
import { createMonoRuntime } from "@mono-agent/turn/host";
import { createSrtSandboxEngine } from "@mono-agent/turn/host/sandbox";
import type { SandboxEngine } from "@mono-agent/turn/host/types";

import { createHostWebRequestCoordinator } from "../host/web-request-coordinator.js";
import type { StaticRuntimeOptions } from "./configured-agent-options.js";

export function configuredSandboxEngine(
  explicit: SandboxEngine | undefined,
): SandboxEngine {
  return explicit ?? createSrtSandboxEngine();
}

export function runtimeHostOptionsForConfig(config: MonoAgentConfig): NonNullable<Parameters<typeof createMonoRuntime>[0]> {
  return {
    workspace: config.runtime.workspace,
    ...(config.tools.filesystem === undefined
      ? {}
      : {
          additionalReadRoots: config.tools.filesystem.readableRoots,
          additionalWriteRoots: config.tools.filesystem.writableRoots,
        }),
    qaOutputDir: config.artifacts.dir,
    ...(config.providers?.piAuthPath === undefined
      ? {}
      : { resolvePiApiKey: createPiOAuthApiKeyResolver({ path: config.providers.piAuthPath }) }),
  };
}

export function mergeStaticRuntimeOptions(
  ...optionsList: readonly (StaticRuntimeOptions | undefined)[]
): StaticRuntimeOptions {
  const merged: Record<string, unknown> = {};
  for (const options of optionsList) {
    if (options === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined) {
        continue;
      }
      if (key === "allowedTools" || key === "disallowedTools") {
        merged[key] = mergeStringLists(merged[key], value);
        continue;
      }
      if (key === "mcpServers" || key === "toolExposure" || key === "hostCapabilities") {
        merged[key] = {
          ...(isRecord(merged[key]) ? merged[key] : {}),
          ...(isRecord(value) ? value : {}),
        };
        continue;
      }
      merged[key] = value;
    }
  }
  return merged;
}

function mergeStringLists(current: unknown, next: unknown): readonly string[] {
  const out: string[] = [];
  for (const value of [...stringList(current), ...stringList(next)]) {
    if (!out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


export function configRuntimeFlags(config: MonoAgentConfig): StaticRuntimeOptions | undefined {
  const { compaction } = config.runtime;
  // NOTE: there is intentionally no reasoning-summary runtime option. The sole pi
  // runtime (pi-native) derives reasoning from `effort` and does not consume an
  // explicit summary level, and the codex/claude CLIs emit summaries
  // unconditionally — so the former `piReasoningSummary` runtime option was dead
  // plumbing and the `runtime.reasoningSummary` config field was removed.
  const piNative = config.providers?.piNative;
  // Typed MCP limits override runtime defaults only when explicitly configured.
  const { mcpCallTimeoutMs, mcpCallMaxTotalTimeoutMs } = config.tools;
  const webSearchConfig = config.tools.web?.search;
  const webFetchConfig = config.tools.web?.fetch;
  const toolLimits = mcpCallTimeoutMs === undefined && mcpCallMaxTotalTimeoutMs === undefined
    ? undefined
    : {
        ...(mcpCallTimeoutMs === undefined ? {} : { mcpCallTimeoutMs }),
        ...(mcpCallMaxTotalTimeoutMs === undefined
          ? {}
          : { mcpCallMaxTotalTimeoutMs }),
      };
  if (
    piNative?.transport === undefined
    && piNative?.cacheRetention === undefined
    && piNative?.promptCacheDiagnostics === undefined
    && piNative?.piMaxRetries === undefined
    && piNative?.maxRetryDelayMs === undefined
    && compaction === undefined
    && config.runtime.context1MModels === undefined
    && toolLimits === undefined
    && webSearchConfig === undefined
    && webFetchConfig === undefined
  ) {
    return undefined;
  }
  return {
    ...configProviderOptions(config),
    ...(piNative?.cacheRetention === undefined ? {} : { cacheRetention: piNative.cacheRetention }),
    ...(piNative?.promptCacheDiagnostics === undefined ? {} : { promptCacheDiagnostics: piNative.promptCacheDiagnostics }),
    ...(compaction === undefined ? {} : { compaction }),
    ...(config.runtime.context1MModels === undefined ? {} : { context1MModels: config.runtime.context1MModels }),
    ...(toolLimits === undefined ? {} : { toolLimits }),
    ...(webSearchConfig === undefined ? {} : { webSearchConfig }),
    ...(webFetchConfig === undefined ? {} : { webFetchConfig }),
    ...(config.tools.web?.coordination === "host" ? { webRequestCoordinator: createHostWebRequestCoordinator() } : {}),
  };
}

/** Provider transport/retry policy only; never inherit parent execution authority. */
export function configProviderOptions(config: MonoAgentConfig, { subagent = false }: { subagent?: boolean } = {}): Partial<Pick<StaticRuntimeOptions, "piTransport" | "piMaxRetries" | "maxRetryDelayMs" | "piRequestRetryBudgetMs">> {
  const piNative = config.providers?.piNative;
  return {
    ...(subagent ? { piRequestRetryBudgetMs: config.subagents?.providerRetryBudgetMs ?? 120_000 } : {}),
    ...(piNative?.transport === undefined ? {} : { piTransport: piNative.transport }),
    ...(piNative?.piMaxRetries === undefined ? {} : { piMaxRetries: piNative.piMaxRetries }),
    ...(piNative?.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: piNative.maxRetryDelayMs }),
  };
}
