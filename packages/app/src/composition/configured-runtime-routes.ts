import type { MonoAgentConfig } from "@mono-agent/config";
import { modelReferenceKey } from "@mono-agent/turn/host/config";
import type { MonoRuntimeFallbackChainEntry, RuntimeModelReference } from "@mono-agent/turn/host/types";

import type { ConfiguredAgentRuntimeOptions } from "./configured-agent-options.js";

/**
 * When backup models are configured, runs go through the turn fallback
 * router with the effective primary model first.
 */
export function fallbackChainForConfig(
  config: MonoAgentConfig,
  options: ConfiguredAgentRuntimeOptions | undefined,
): { fallbackChain?: readonly MonoRuntimeFallbackChainEntry[] } {
  const canonicalFallbacks = config.runtime.fallbacks;
  // The loader always materializes `retry`, but this package is published and
  // `createConfiguredAgentRuntime` accepts a caller-built MonoAgentConfig — an
  // older hand-built object must degrade to single-shot, not crash.
  const primaryAttempts = config.runtime.retry?.primaryAttempts ?? 1;
  if ((canonicalFallbacks?.length ?? 0) === 0) {
    // Without a chain `createMonoRuntime` takes the plain `createRuntime` path
    // and the router never runs — so same-model retries would silently do
    // nothing for every agent with no configured backups. Build a retry-only
    // single-entry chain instead whenever the primary asks for more than one
    // attempt. Both retry-only and multi-entry chains keep sessions on the
    // primary's first attempt; the router makes later attempts stateless.
    if (primaryAttempts <= 1) {
      return {};
    }
    return {
      fallbackChain: [{
        model: options?.model ?? config.runtime.model,
        attempts: primaryAttempts,
      }],
    };
  }
  const primaryModel = options?.model ?? config.runtime.model;
  // Drop any fallback equal to the primary so a per-trigger override that happens
  // to match a configured backup is not retried against itself before advancing.
  const primaryKey = modelReferenceKey(primaryModel);
  const fallbackEntries: readonly MonoRuntimeFallbackChainEntry[] = (canonicalFallbacks ?? [])
    .filter((entry) => modelReferenceKey(entry.model) !== primaryKey)
    .map((entry) => ({
      model: entry.model,
      // Canonical omission means provider default.
      effort: entry.effort ?? null,
      // Omitted per-route attempts stay single-shot: only the primary
      // retries unless a backup opts in explicitly.
      ...(entry.attempts === undefined ? {} : { attempts: entry.attempts }),
    }));
  return {
    fallbackChain: [
      {
        model: primaryModel,
        ...(primaryAttempts > 1 ? { attempts: primaryAttempts } : {}),
      },
      ...fallbackEntries,
    ],
  };
}

/**
 * Whether every configured route reachable behind `primary` is Pi-native.
 *
 * Returns a VERDICT, not a bare boolean: this fails closed on an unresolvable
 * chain, and a caller that turns `false` into a thrown
 * PROCESS_JOBS_PI_NATIVE_REQUIRED_ERROR would otherwise emit the same opaque
 * sentence for "could not resolve" as for "genuinely non-Pi" — the ambiguity
 * that made mono-agent#664 undiagnosable from outside.
 */
type ConfiguredRoutesPiNativeVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function configuredRoutesOnlyPiNative(
  config: MonoAgentConfig,
  primary: RuntimeModelReference,
): ConfiguredRoutesPiNativeVerdict {
  let routes: readonly RuntimeModelReference[];
  try {
    const fallback = fallbackChainForConfig(config, { config, model: primary });
    routes = fallback.fallbackChain?.map((entry) => entry.model) ?? [primary];
  } catch (error) {
    return {
      ok: false,
      reason: `the configured route chain could not be resolved (${
        error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (routes.length === 0) {
    return { ok: false, reason: "the configured route chain is empty" };
  }
  return { ok: true };
}
