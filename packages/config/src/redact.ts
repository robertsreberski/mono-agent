

import type { ProviderDefinition } from "@mono-agent/turn/host/types";

import { redactedSecret } from "@mono-agent/contracts";

import type { MonoAgentConfig, RedactedMonoAgentConfig } from "./types.js";

import { assertNoRetiredMonoAgentConfig } from "./retired-fields.js";

export function redactMonoAgentConfig(config: MonoAgentConfig): RedactedMonoAgentConfig {
  assertNoRetiredMonoAgentConfig(config);
  const { web: configuredWeb, ...toolsWithoutWeb } = config.tools;
  const configuredSearch = configuredWeb?.search;
  const {
    ollama: configuredOllamaSearch,
    codex: configuredCodexSearch,
    ...searchWithoutSecrets
  } = configuredSearch ?? { backend: ["parallel", "ollama"] as const, maxRequestsPerRun: 4 };
  const redacted: RedactedMonoAgentConfig = {
    ...(config.agent === undefined ? {} : { agent: { ...config.agent } }),
    runtime: { ...config.runtime },
    ...(config.concurrency === undefined ? {} : { concurrency: { ...config.concurrency } }),
    ...(config.peers === undefined ? {} : { peers: Object.fromEntries(Object.entries(config.peers).map(([name, peer]) => [name, { ...peer }])) }),
    context: { ...config.context, selectedSkills: [...config.context.selectedSkills] },
    tools: {
      ...toolsWithoutWeb,
      allowedTools: [...config.tools.allowedTools],
      disallowedTools: [...config.tools.disallowedTools],
      ...(config.tools.filesystem === undefined ? {} : {
        filesystem: {
          readableRoots: [...config.tools.filesystem.readableRoots],
          writableRoots: [...config.tools.filesystem.writableRoots],
        },
      }),
      ...(configuredWeb === undefined ? {} : {
        web: {
          coordination: configuredWeb.coordination ?? "process",
          search: {
            ...searchWithoutSecrets,
            ...(configuredOllamaSearch === undefined
              ? {}
              : { ollama: redactApiKeyBlock(configuredOllamaSearch) }),
            ...(configuredCodexSearch === undefined
              ? {}
              : { codex: { ...configuredCodexSearch } }),
          },
          fetch: { ...configuredWeb.fetch },
        },
      }),
    },
    ...(config.sandbox === undefined ? {} : { sandbox: { ...config.sandbox } }),
    artifacts: { ...config.artifacts },
    traceability: { ...config.traceability },
  };
  if (config.memory !== undefined) {
    // The only tolerated direct legacy shape is an inert empty tombstone. It is
    // compatibility input, not resolved output, so never carry it into views.
    const { embeddings, supermemory: _retiredSupermemory, ...memory } = config.memory as
      NonNullable<MonoAgentConfig["memory"]> & { readonly supermemory?: unknown };
    return withRedactedProviders({
      ...redacted,
      memory: {
        ...memory,
        ...(embeddings === undefined ? {} : { embeddings: redactApiKeyBlock(embeddings) }),
      },
    }, config);
  }
  return withRedactedProviders(redacted, config);
}

/** Replace an `apiKey` literal with a redacted secret marker, leaving the rest of the block intact. */
function redactApiKeyBlock<T extends { readonly apiKey?: string }>(
  block: T,
): Omit<T, "apiKey"> & { readonly apiKey?: ReturnType<typeof redactedSecret> } {
  const { apiKey, ...rest } = block;
  return {
    ...rest,
    ...(apiKey === undefined ? {} : { apiKey: redactedSecret(apiKey) }),
  };
}

function withRedactedProviders(
  redacted: RedactedMonoAgentConfig,
  config: MonoAgentConfig,
): RedactedMonoAgentConfig {
  if (config.providers === undefined) {
    return redacted;
  }
  return {
    ...redacted,
    providers: {
      ...(config.providers.piAuthPath === undefined ? {} : { piAuthPath: config.providers.piAuthPath }),
      // pi-native knobs carry no secrets — pass them through so redacted config
      // surfaces (e.g. the TUI config pane) still show them.
      ...(config.providers.piNative === undefined ? {} : { piNative: config.providers.piNative }),
      ...(config.providers.entries === undefined
        ? {}
        : {
            entries: config.providers.entries.map((provider) => redactProviderDefinition(provider)),
          }),
      ...(config.providers.local === undefined
        ? {}
        : {
            local: config.providers.local.map((provider) => redactProviderDefinition(provider)),
          }),
    },
  };
}

function redactProviderDefinition<T extends ProviderDefinition>(provider: T): Omit<T, "apiKey"> & {
  readonly apiKey?: ReturnType<typeof redactedSecret>;
} {
  const { apiKey, ...safeProvider } = provider;
  return {
    ...safeProvider,
    ...(apiKey === undefined ? {} : { apiKey: redactedSecret(apiKey) }),
  };
}
