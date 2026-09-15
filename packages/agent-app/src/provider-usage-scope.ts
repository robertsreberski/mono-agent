import {
  PROVIDER_USAGE_IDS, PROVIDER_USAGE_SCHEMA,
  type ProviderUsageId, type ProviderUsageOperator,
} from "@mono-agent/agent-contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
import type { MonoAgentAppConfigInput } from "./app-config.js";
import type { ChannelDriver } from "./channels.js";
import { collectUsedProviderReferences } from "./provider-auth-status.js";

/** Agent/config scope only: credential identity, backoff and flights belong to the shared service. */
export function createAgentProviderUsage(options: {
  readonly config: MonoAgentConfig;
  readonly drivers: readonly ChannelDriver[];
  readonly input: MonoAgentAppConfigInput;
  readonly service: Required<ProviderUsageOperator>;
}): Required<ProviderUsageOperator> {
  async function read(method: "snapshot" | "refresh", provider?: ProviderUsageId) {
    // Reload channel references just like auth status. Never retain a mutable
    // allowlist in the path-shared service or across config generations.
    const refs = await collectUsedProviderReferences(options.config, options.drivers, options.input);
    const active = new Set(refs.map(({ ref }) => ref.provider as string));
    const ids = PROVIDER_USAGE_IDS.filter((id) => active.has(id) && (provider === undefined || id === provider));
    const snapshots = await Promise.all(ids.map((id) => options.service[method](id)));
    return { schema: PROVIDER_USAGE_SCHEMA, providers: snapshots.flatMap((snapshot) => snapshot.providers) };
  }
  return {
    snapshot: (provider) => read("snapshot", provider),
    refresh: (provider) => read("refresh", provider),
  };
}
