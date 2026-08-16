import type { MonoAgentConfig } from "@mono-agent/config";
import {
  parseMonoRuntimeModelReference,
  type RuntimeModelReference,
} from "@mono-agent/runtime-adapter";

type RuntimeConfig = MonoAgentConfig["runtime"];

/** Return the one effective fallback list while keeping legacy configs loadable. */
export function configuredRuntimeFallbackModels(
  runtime: Pick<RuntimeConfig, "fallbacks" | "fallbackModels">,
): readonly RuntimeModelReference[] {
  return (runtime.fallbacks?.length ?? 0) > 0
    ? runtime.fallbacks?.map((entry) => entry.model) ?? []
    : runtime.fallbackModels ?? [];
}

export function configuredRuntimeModels(
  runtime: Pick<RuntimeConfig, "model" | "fallbacks" | "fallbackModels">,
): readonly RuntimeModelReference[] {
  return [runtime.model, ...configuredRuntimeFallbackModels(runtime)];
}

/**
 * Whether every statically configured model-capable surface that can share the
 * app's ProcessJobs authority is Pi-native. Request-scoped overrides are
 * checked separately against their resolved route before provider work.
 */
export function configuredProcessJobsRoutesOnlyPiNative(config: MonoAgentConfig): boolean {
  const routes: RuntimeModelReference[] = [...configuredRuntimeModels(config.runtime)];
  if (config.subagents?.enabled === true) {
    for (const definition of config.subagents.definitions ?? []) {
      if (definition.model !== undefined) routes.push(definition.model);
    }
  }
  const memoryLlm = config.memory?.llm;
  if (memoryLlm?.provider === "agent-host") {
    try {
      routes.push(parseMonoRuntimeModelReference(memoryLlm.model));
    } catch {
      return false;
    }
  }
  return routes.length > 0 && routes.every((model) => model.sdk === "pi");
}

export function hasConfiguredRuntimeFallbacks(
  runtime: Pick<RuntimeConfig, "fallbacks" | "fallbackModels">,
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
  runtime: Pick<RuntimeConfig, "fallbacks" | "fallbackModels" | "retry">,
): boolean {
  return hasConfiguredRuntimeFallbacks(runtime) || (runtime.retry?.primaryAttempts ?? 1) > 1;
}
