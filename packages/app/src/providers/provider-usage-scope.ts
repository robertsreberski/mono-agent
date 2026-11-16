import {
  PROVIDER_USAGE_IDS, PROVIDER_USAGE_SCHEMA,
  type ProviderUsageId, type ProviderUsageOperator,
} from "@mono-agent/contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
import type { MonoAgentAppConfigInput } from "../composition/app-config.js";
import type { ChannelDriver } from "../channels/types.js";
import { collectUsedProviderReferences } from "./provider-auth-status.js";

/** Agent/config scope only: credential identity, backoff and flights belong to the shared service. */
export function createAgentProviderUsage(options: {
  readonly config: MonoAgentConfig;
  readonly drivers: readonly ChannelDriver[];
  readonly input: MonoAgentAppConfigInput;
  readonly service: ProviderUsageOperator & Required<Pick<ProviderUsageOperator, "snapshot" | "refresh">>;
}): ProviderUsageOperator & Required<Pick<ProviderUsageOperator, "snapshot" | "refresh">> {
  async function activeIds(provider?: ProviderUsageId) {
    // Reload channel references just like auth status. Never retain a mutable
    // allowlist in the path-shared service or across config generations.
    const refs = await collectUsedProviderReferences(options.config, options.drivers, options.input);
    const active = new Set(refs.map(({ ref }) => ref.provider as string));
    return PROVIDER_USAGE_IDS.filter((id) => active.has(id) && (provider === undefined || id === provider));
  }
  async function read(method: "snapshot" | "refresh", provider?: ProviderUsageId) {
    const ids = await activeIds(provider);
    const snapshots = await Promise.all(ids.map((id) => options.service[method](id)));
    return { schema: PROVIDER_USAGE_SCHEMA, providers: snapshots.flatMap((snapshot) => snapshot.providers) };
  }
  return {
    snapshot: (provider) => read("snapshot", provider),
    refresh: (provider) => read("refresh", provider),
    ...(options.service.history === undefined ? {} : {
      async history(query: Parameters<NonNullable<ProviderUsageOperator["history"]>>[0]) {
        const ids = await activeIds(query.provider);
        const snapshots = await Promise.all(ids.map(provider => options.service.history!({ ...query, provider })));
        const { provider: _provider, ...range } = query;
        return { schema: "mono-agent.provider-usage-history.v1" as const, ...range, retentionDays: 90 as const,
          storage: snapshots.some(s => s.storage === "unavailable") ? "unavailable" as const : "ready" as const,
          providers: snapshots.some(s => s.storage === "unavailable") ? [] : snapshots.flatMap(s => s.providers) };
      },
    }),
    ...(options.service.clearHistory === undefined ? {} : {
      async clearHistory(provider?: ProviderUsageId) {
        for (const id of await activeIds(provider)) await options.service.clearHistory!(id);
      },
    }),
  };
}
