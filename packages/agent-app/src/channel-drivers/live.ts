import type {
  LiveAdapterConfig,
  LiveAdapterHandle,
  LiveAdapterOptions,
} from "@mono-agent/operator-adapter";

import { buildChannelConfigView } from "../channel-config-view.js";
import type { ChannelDriver } from "../channels.js";

type LiveAdapterModule = typeof import("@mono-agent/operator-adapter");

let liveModule: LiveAdapterModule | undefined;
const loadLiveModule = async (): Promise<LiveAdapterModule> =>
  (liveModule ??= await import("@mono-agent/operator-adapter"));

export interface LiveChannelOverrides {
  readonly adapterFactory?: (options: LiveAdapterOptions) => Promise<LiveAdapterHandle>;
}

/**
 * The live event relay is enabled by default on loopback so `mono-agent web`
 * can observe a running agent without a per-agent config edit.
 */
export function createLiveChannelDriver(
  overrides: LiveChannelOverrides = {},
): ChannelDriver<LiveAdapterConfig> {
  return {
    id: "live",
    label: "Live",
    async configView(input) {
      const adapter = await loadLiveModule();
      return await buildChannelConfigView(this, adapter.LIVE_CONFIG_FIELDS, input, { jsonKey: "live" });
    },
    async loadConfig(input) {
      const adapter = await loadLiveModule();
      return await adapter.loadLiveAdapterConfig({ env: input.env, jsonPath: input.configPath });
    },
    isConfigError(error) {
      return liveModule !== undefined && error instanceof liveModule.LiveAdapterError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "Live event relay is disabled.";
    },
    async start(input) {
      const adapterModule = await loadLiveModule();
      const adapterFactory = overrides.adapterFactory ?? adapterModule.startLiveAdapter;
      const bus = input.liveEventBus ?? adapterModule.createLiveEventBus();
      const adapter = await adapterFactory({
        bus,
        host: input.config.host,
        port: input.config.port,
        basePath: input.config.basePath,
        allowNonLoopback: input.config.allowNonLoopback,
        ...(input.config.apiKey === undefined ? {} : { apiKey: input.config.apiKey }),
        onServerError: (reason) => input.onFailure(reason),
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      });
      return {
        summary: { baseUrl: adapter.baseUrl },
        stop: () => adapter.stop(),
      };
    },
  };
}
