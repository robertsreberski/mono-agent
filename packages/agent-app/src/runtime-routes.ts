import type { MonoAgentConfig } from "@mono-agent/config";
import {
  assertParsedRuntimeModelReference,
  modelReferenceKey,
  parseMonoRuntimeModelReference,
  type RuntimeModelReference,
} from "@mono-agent/runtime-adapter";

type RuntimeConfig = MonoAgentConfig["runtime"];

/** Return the configured fallback models in their declared order. */
export function configuredRuntimeFallbackModels(
  runtime: Pick<RuntimeConfig, "fallbacks">,
): readonly RuntimeModelReference[] {
  return runtime.fallbacks?.map((entry) => entry.model) ?? [];
}

export function configuredRuntimeModels(
  runtime: Pick<RuntimeConfig, "model" | "fallbacks">,
): readonly RuntimeModelReference[] {
  return [runtime.model, ...configuredRuntimeFallbackModels(runtime)];
}

/**
 * Whether every statically configured model-capable surface that can share the
 * app's ProcessJobs authority is Pi-native. Request-scoped overrides are
 * checked separately against their resolved route before provider work.
 */
export function configuredProcessJobsRoutesOnlyPiNative(config: MonoAgentConfig): boolean {
  try {
    const [primary, ...fallbacks] = configuredRuntimeModels(config.runtime);
    assertParsedRuntimeModelReference(primary);
    const primaryKey = modelReferenceKey(primary);
    const fallbackKeys = new Set<string>();
    for (const fallback of fallbacks) {
      assertParsedRuntimeModelReference(fallback);
      const key = modelReferenceKey(fallback);
      if (key === primaryKey) continue;
      if (fallbackKeys.has(key)) return false;
      fallbackKeys.add(key);
    }

    if (config.subagents?.enabled === true) {
      for (const definition of config.subagents.definitions ?? []) {
        if (definition.model !== undefined) {
          assertParsedRuntimeModelReference(definition.model);
        }
      }
    }
    const memoryLlm = config.memory?.llm;
    if (memoryLlm?.provider === "agent-host") {
      assertParsedRuntimeModelReference(parseMonoRuntimeModelReference(memoryLlm.model));
    }
    return true;
  } catch {
    return false;
  }
}

export function hasConfiguredRuntimeFallbacks(
  runtime: Pick<RuntimeConfig, "fallbacks">,
): boolean {
  return configuredRuntimeFallbackModels(runtime).length > 0;
}

/**
 * Whether runs are served by the fallback router rather than the plain runtime.
 *
 * This is NOT the same question as "are backups configured": a primary with
 * `runtime.retry.primaryAttempts > 1` gets a retry-only single-entry chain, and
 * the router freezes the model chain either way. Anything that must survive the
 * router — notably per-trigger model overrides, which the router would otherwise
 * overwrite with the chain primary — has to key off this, not off the backups.
 */
export function runtimeUsesFallbackRouter(
  runtime: Pick<RuntimeConfig, "fallbacks" | "retry">,
): boolean {
  return hasConfiguredRuntimeFallbacks(runtime) || (runtime.retry?.primaryAttempts ?? 1) > 1;
}
