import { assertNoRetiredMonoAgentConfig } from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";
import { createMonoRuntime } from "@mono-agent/turn/host";
import { runtimeOptionsForLocalProvider } from "@mono-agent/turn/host/config";
import type { MonoRuntimeLike } from "@mono-agent/turn/host/types";

import type { ConfiguredAgentRuntimeOptions } from "./configured-agent-options.js";
import { configuredSandboxEngine, runtimeHostOptionsForConfig } from "./configured-runtime-options.js";
import { fallbackChainForConfig } from "./configured-runtime-routes.js";
import { wrapOwnedConfiguredRuntime } from "./runtime-ownership.js";

export function createConfiguredAgentRuntime(config: MonoAgentConfig): MonoRuntimeLike;
export function createConfiguredAgentRuntime(options: ConfiguredAgentRuntimeOptions): MonoRuntimeLike;
export function createConfiguredAgentRuntime(
  input: MonoAgentConfig | ConfiguredAgentRuntimeOptions,
): MonoRuntimeLike {
  const config = isRuntimeOptions(input) ? input.config : input;
  const options = isRuntimeOptions(input) ? input : undefined;
  return wrapOwnedConfiguredRuntime(
    createConfiguredAgentRuntimeBase(config, options),
    config,
    options?.cwd,
    options?.sandboxEngine,
  );
}

/** @internal App/harness seam; callers are already inside the shared root/request choke point. */
export function createConfiguredAgentRuntimeForApp(
  input: MonoAgentConfig | ConfiguredAgentRuntimeOptions,
  internal: { readonly suppressSandboxEngine?: boolean } = {},
): MonoRuntimeLike {
  const config = isRuntimeOptions(input) ? input.config : input;
  const options = isRuntimeOptions(input) ? input : undefined;
  return createConfiguredAgentRuntimeBase(config, options, internal.suppressSandboxEngine === true);
}

function createConfiguredAgentRuntimeBase(
  config: MonoAgentConfig,
  options: ConfiguredAgentRuntimeOptions | undefined,
  suppressSandboxEngine = false,
): MonoRuntimeLike {
  assertNoRetiredMonoAgentConfig(config);
  const fallback = fallbackChainForConfig(config, options);
  const sandboxEngine = suppressSandboxEngine || config.sandbox?.mode !== "native"
    ? undefined
    : configuredSandboxEngine(options?.sandboxEngine);
  const runtimeOptions: Parameters<typeof createMonoRuntime>[0] = {
    ...runtimeHostOptionsForConfig(config),
    ...(sandboxEngine === undefined ? {} : { sandboxEngine }),
    ...fallback,
    ...(fallback.fallbackChain === undefined
      ? {}
      : {
          ...(config.runtime.retry === undefined
            ? {}
            : {
                retry: {
                  backoffMs: config.runtime.retry.backoffMs,
                  maxBackoffMs: config.runtime.retry.maxBackoffMs,
                },
              }),
          // Resolve custom/local Pi options from the ACTUAL route selected by
          // the fallback router. Secrets stay inside this private return value
          // and are never copied into route metadata or events.
          // This resolver changes endpoint options only, never the native owner.
          sessionTurnReconciliation: "v1",
          resolveAttempt: ({ model }) => ({
            options: runtimeOptionsForLocalProvider(model, config.providers?.local),
          }),
        }),
  };
  return createMonoRuntime(runtimeOptions);
}

function isRuntimeOptions(value: MonoAgentConfig | ConfiguredAgentRuntimeOptions): value is ConfiguredAgentRuntimeOptions {
  return "config" in value;
}
