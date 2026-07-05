import type {
  ChannelDriver,
  SettingsJson,
  SettingsJsonValue,
} from "@mono-agent/agent-contracts";

import {
  type A2AAdapterConfig,
  loadA2AAdapterConfig,
} from "./config.js";
import {
  A2AConsumerError,
  A2AProviderError,
} from "./errors.js";
import {
  type A2AProviderOptions,
  type A2AProviderStartResult,
  startA2AProvider,
} from "./provider.js";

export type A2AAdapterRawConfig = Readonly<Record<string, SettingsJsonValue>>;

export interface A2AChannelDriverOptions {
  readonly id?: string;
  readonly label?: string;
  readonly config?: A2AAdapterRawConfig;
  readonly providerFactory?: (options: A2AProviderOptions) => Promise<A2AProviderStartResult>;
}

const DEFAULT_CHANNEL_ID = "a2a";
const DEFAULT_CHANNEL_LABEL = "A2A";
const DISABLED_REASON = "A2A provider is disabled.";
const MISSING_AGENT_SKILL_REASON = "A2A provider requires agent and skill configuration.";

export function createA2AChannelDriver(
  options: A2AChannelDriverOptions = {},
): ChannelDriver<A2AAdapterConfig> {
  return {
    id: options.id ?? DEFAULT_CHANNEL_ID,
    label: options.label ?? DEFAULT_CHANNEL_LABEL,
    async loadConfig(input) {
      if (options.config !== undefined) {
        return await loadA2AAdapterConfig({
          env: input.env,
          json: { a2a: options.config } satisfies SettingsJson,
        });
      }
      return await loadA2AAdapterConfig({ env: input.env, jsonPath: input.configPath });
    },
    isConfigError(error) {
      return error instanceof A2AProviderError || error instanceof A2AConsumerError;
    },
    disabledReason(config) {
      return config.provider.enabled ? undefined : DISABLED_REASON;
    },
    waitingReason(config) {
      if (config.agent === undefined || config.skill === undefined) {
        return MISSING_AGENT_SKILL_REASON;
      }
      return undefined;
    },
    async start(input) {
      const config = input.config;
      if (config.agent === undefined || config.skill === undefined) {
        throw new A2AProviderError("missing_required_config", MISSING_AGENT_SKILL_REASON);
      }
      const providerFactory = options.providerFactory ?? startA2AProvider;
      const provider = await providerFactory({
        host: config.provider.host,
        port: config.provider.port,
        ...(config.provider.publicBaseUrl === undefined ? {} : { publicBaseUrl: config.provider.publicBaseUrl }),
        allowNonLoopback: config.provider.allowNonLoopback,
        requireBearer: config.provider.requireBearer,
        ...(config.provider.bearerToken === undefined ? {} : { bearerToken: config.provider.bearerToken }),
        responder: input.responder,
        agent: {
          name: config.agent.name,
          description: config.agent.description,
          version: config.agent.version,
          ...(config.agent.providerOrganization === undefined || config.agent.providerUrl === undefined
            ? {}
            : {
                provider: {
                  organization: config.agent.providerOrganization,
                  url: config.agent.providerUrl,
                },
              }),
        },
        skill: config.skill,
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      });
      return {
        summary: { agentCardUrl: provider.agentCardUrl },
        stop: () => provider.stop(),
      };
    },
  };
}

export const createChannelDriver: typeof createA2AChannelDriver = createA2AChannelDriver;
