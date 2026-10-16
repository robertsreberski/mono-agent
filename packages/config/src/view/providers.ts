

import type { RedactedProviderDefinition } from "../types.js";

import type { BuildMonoAgentConfigViewInput, ConfigViewSection } from "./types.js";

import { PLACEHOLDER, toField } from "./fields.js";

function formatProviders(
  providers: readonly RedactedProviderDefinition[],
): string {
  if (providers.length === 0) {
    return "none";
  }
  return providers.map((provider) => provider.type === undefined
    ? provider.id
    : `${provider.id} (${provider.type})`).join(", ");
}

export function buildProvidersSection(input: BuildMonoAgentConfigViewInput): ConfigViewSection {
  const { redacted, json } = input;
  const providers = redacted.providers;
  const present = providers !== undefined;
  const entries = providers?.entries ?? providers?.local ?? [];
  const configuredProviderIds = Object.keys(json.providers ?? {}).filter((key) =>
    key !== "local" && key !== "piAuthPath" && key !== "piNative",
  );
  const providerMapPresent = json.providers?.local !== undefined || configuredProviderIds.length > 0;
  return {
    id: "providers",
    label: "Providers",
    status: present ? "active" : "disabled",
    fields: [
      toField({
        id: "providers.piAuthPath",
        label: "Pi auth path",
        value: providers?.piAuthPath ?? PLACEHOLDER,
        jsonPresent: json.providers?.piAuthPath !== undefined,
      }),
      toField({
        id: "providers.piNative.transport",
        label: "Pi transport",
        value: providers?.piNative?.transport ?? "auto",
        jsonPresent: json.providers?.piNative?.transport !== undefined,
      }),
      toField({
        id: "providers.piNative.promptCacheDiagnostics",
        label: "Pi prompt cache diagnostics",
        value: String(providers?.piNative?.promptCacheDiagnostics ?? false),
        jsonPresent: json.providers?.piNative?.promptCacheDiagnostics !== undefined,
      }),
      toField({
        id: "providers.piNative.cacheRetention",
        label: "Anthropic cache retention",
        value: providers?.piNative?.cacheRetention ?? PLACEHOLDER,
        jsonPresent: json.providers?.piNative?.cacheRetention !== undefined,
      }),

      toField({
        id: "providers.piNative.piMaxRetries",
        label: "Pi max retries",
        value: providers?.piNative?.piMaxRetries === undefined ? "default" : String(providers.piNative.piMaxRetries),
        jsonPresent: json.providers?.piNative?.piMaxRetries !== undefined,
      }),
      toField({
        id: "providers.piNative.maxRetryDelayMs",
        label: "Pi max retry delay (ms)",
        value: providers?.piNative?.maxRetryDelayMs === undefined ? "default" : String(providers.piNative.maxRetryDelayMs),
        jsonPresent: json.providers?.piNative?.maxRetryDelayMs !== undefined,
      }),
      toField({
        id: "providers",
        label: "Configured providers",
        value: formatProviders(entries),
        jsonPresent: providerMapPresent,
      }),
    ],
  };
}
