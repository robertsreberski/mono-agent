import {
  isLoopbackHost,
  layerJsonOntoEnv,
  normalizeOptionalString,
  readBoolean,
  readCsv,
  readInteger,
  readJsonSection,
  readRecord,
  readRequired,
  readSettingsJson,
  readString,
  redactedSecret,
} from "@mono-agent/settings";
import type { RedactedSecretValue, SettingsJson } from "@mono-agent/settings";

import type { A2AAgentSkillOptions } from "./card.js";
import { A2AProviderError } from "./errors.js";
import { A2AConsumerError } from "./errors.js";

export interface A2AAdapterProviderConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly publicBaseUrl?: string;
  readonly allowNonLoopback: boolean;
  readonly requireBearer: boolean;
  readonly bearerToken?: string;
}

export interface A2AAdapterAgentConfig {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly providerOrganization?: string;
  readonly providerUrl?: string;
}

export interface A2AAdapterConsumerConfig {
  readonly remoteAgentUrls: readonly string[];
  readonly defaultRemoteAgentUrl?: string;
  readonly bearerToken?: string;
  readonly timeoutMs: number;
}

export interface A2AAdapterConfig {
  readonly provider: A2AAdapterProviderConfig;
  readonly agent?: A2AAdapterAgentConfig;
  readonly skill?: A2AAgentSkillOptions;
  readonly consumer: A2AAdapterConsumerConfig;
}

export interface RedactedA2AAdapterConfig {
  readonly provider: Omit<A2AAdapterProviderConfig, "bearerToken"> & {
    readonly bearerToken: RedactedSecretValue;
  };
  readonly agent?: A2AAdapterAgentConfig;
  readonly skill?: A2AAgentSkillOptions;
  readonly consumer: Omit<A2AAdapterConsumerConfig, "bearerToken" | "remoteAgentUrls"> & {
    readonly remoteAgentUrls: { readonly count: number };
    readonly bearerToken: RedactedSecretValue;
  };
}

export interface LoadA2AAdapterConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const DEFAULT_TIMEOUT_MS = 30_000;

const invalidConfig = (message: string, details?: Record<string, unknown>): A2AProviderError =>
  new A2AProviderError("invalid_config", message, details);

export async function loadA2AAdapterConfig(
  input: LoadA2AAdapterConfigInput,
): Promise<A2AAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const env = layerA2AJsonOntoEnv(json, input.env);
  const enabled = readBoolean(env.MONO_AGENT_A2A_PROVIDER_ENABLED, "MONO_AGENT_A2A_PROVIDER_ENABLED", false, invalidConfig);
  const publicBaseUrl = normalizeOptionalString(env.MONO_AGENT_A2A_PUBLIC_BASE_URL);
  const providerBearerToken = normalizeOptionalString(env.MONO_AGENT_A2A_BEARER_TOKEN);
  const provider: A2AAdapterProviderConfig = {
    enabled,
    host: readString(env.MONO_AGENT_A2A_HOST, DEFAULT_HOST),
    port: readInteger(env.MONO_AGENT_A2A_PORT, "MONO_AGENT_A2A_PORT", DEFAULT_PORT, invalidConfig, { min: 0, max: 65535 }),
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
    allowNonLoopback: readBoolean(env.MONO_AGENT_A2A_ALLOW_NON_LOOPBACK, "MONO_AGENT_A2A_ALLOW_NON_LOOPBACK", false, invalidConfig),
    requireBearer: readBoolean(env.MONO_AGENT_A2A_REQUIRE_BEARER, "MONO_AGENT_A2A_REQUIRE_BEARER", false, invalidConfig),
    ...(providerBearerToken === undefined ? {} : { bearerToken: providerBearerToken }),
  };

  const consumerBearerToken = normalizeOptionalString(env.MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN);
  const defaultRemoteAgentUrl = normalizeOptionalString(env.MONO_AGENT_A2A_DEFAULT_REMOTE_AGENT_URL);
  const consumer: A2AAdapterConsumerConfig = {
    remoteAgentUrls: readCsv(env.MONO_AGENT_A2A_REMOTE_AGENT_URLS),
    ...(defaultRemoteAgentUrl === undefined ? {} : { defaultRemoteAgentUrl }),
    ...(consumerBearerToken === undefined ? {} : { bearerToken: consumerBearerToken }),
    timeoutMs: readInteger(env.MONO_AGENT_A2A_TIMEOUT_MS, "MONO_AGENT_A2A_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, invalidConfig, {
      min: 1,
      max: 600_000,
    }),
  };
  validateConsumer(consumer);

  if (!provider.enabled) {
    return { provider, consumer };
  }

  validateProvider(provider);
  const agent = readAgentConfig(env);
  const skill = readSkillConfig(env);
  return {
    provider,
    agent,
    skill,
    consumer,
  };
}

export function redactA2AAdapterConfig(
  config: A2AAdapterConfig,
): RedactedA2AAdapterConfig {
  return {
    provider: {
      ...withoutBearer(config.provider),
      bearerToken: redactedSecret(config.provider.bearerToken),
    },
    ...(config.agent === undefined ? {} : { agent: config.agent }),
    ...(config.skill === undefined ? {} : { skill: config.skill }),
    consumer: {
      remoteAgentUrls: { count: config.consumer.remoteAgentUrls.length },
      ...(config.consumer.defaultRemoteAgentUrl === undefined
        ? {}
        : { defaultRemoteAgentUrl: config.consumer.defaultRemoteAgentUrl }),
      timeoutMs: config.consumer.timeoutMs,
      bearerToken: redactedSecret(config.consumer.bearerToken),
    },
  };
}

function readRequiredEnv(raw: string | undefined, envName: string): string {
  return readRequired(
    raw,
    envName,
    () =>
      new A2AProviderError(
        "missing_required_config",
        `${envName} is required when A2A provider is enabled.`,
        { env: envName },
      ),
  );
}

function readAgentConfig(env: Record<string, string | undefined>): A2AAdapterAgentConfig {
  const providerOrganization = normalizeOptionalString(env.MONO_AGENT_A2A_PROVIDER_ORGANIZATION);
  const providerUrl = normalizeOptionalString(env.MONO_AGENT_A2A_PROVIDER_URL);
  return {
    name: readRequiredEnv(env.MONO_AGENT_A2A_AGENT_NAME, "MONO_AGENT_A2A_AGENT_NAME"),
    description: readRequiredEnv(env.MONO_AGENT_A2A_AGENT_DESCRIPTION, "MONO_AGENT_A2A_AGENT_DESCRIPTION"),
    version: readRequiredEnv(env.MONO_AGENT_A2A_AGENT_VERSION, "MONO_AGENT_A2A_AGENT_VERSION"),
    ...(providerOrganization === undefined ? {} : { providerOrganization }),
    ...(providerUrl === undefined ? {} : { providerUrl }),
  };
}

function readSkillConfig(env: Record<string, string | undefined>): A2AAgentSkillOptions {
  return {
    id: readRequiredEnv(env.MONO_AGENT_A2A_SKILL_ID, "MONO_AGENT_A2A_SKILL_ID"),
    name: readRequiredEnv(env.MONO_AGENT_A2A_SKILL_NAME, "MONO_AGENT_A2A_SKILL_NAME"),
    description: readRequiredEnv(env.MONO_AGENT_A2A_SKILL_DESCRIPTION, "MONO_AGENT_A2A_SKILL_DESCRIPTION"),
    tags: readCsv(env.MONO_AGENT_A2A_SKILL_TAGS),
  };
}

function validateProvider(provider: A2AAdapterProviderConfig): void {
  if (provider.requireBearer && provider.bearerToken === undefined) {
    throw new A2AProviderError(
      "missing_required_config",
      "MONO_AGENT_A2A_BEARER_TOKEN is required when MONO_AGENT_A2A_REQUIRE_BEARER=true.",
      { env: "MONO_AGENT_A2A_BEARER_TOKEN" },
    );
  }
  if (!provider.allowNonLoopback && !isLoopbackHost(provider.host)) {
    throw new A2AProviderError(
      "unsafe_host",
      "A2A provider refuses non-loopback host without MONO_AGENT_A2A_ALLOW_NON_LOOPBACK=true.",
      { host: provider.host },
    );
  }
  if (provider.publicBaseUrl !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(provider.publicBaseUrl);
    } catch (error) {
      throw new A2AProviderError("invalid_config", "MONO_AGENT_A2A_PUBLIC_BASE_URL must be an absolute URL.", {
        env: "MONO_AGENT_A2A_PUBLIC_BASE_URL",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (!provider.allowNonLoopback && !isLoopbackHost(parsed.hostname)) {
      throw new A2AProviderError(
        "unsafe_host",
        "A2A provider refuses non-loopback publicBaseUrl without MONO_AGENT_A2A_ALLOW_NON_LOOPBACK=true.",
        { publicBaseUrl: provider.publicBaseUrl },
      );
    }
  }
}

function validateConsumer(consumer: A2AAdapterConsumerConfig): void {
  for (const url of [
    ...consumer.remoteAgentUrls,
    ...(consumer.defaultRemoteAgentUrl === undefined ? [] : [consumer.defaultRemoteAgentUrl]),
  ]) {
    try {
      new URL(url);
    } catch (error) {
      throw new A2AConsumerError("invalid_agent_card", "A2A remote agent URL must be absolute.", {
        url,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function layerA2AJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const section = readJsonSection(json, "a2a");
  const provider = readRecord(section.provider);
  const agent = readRecord(section.agent);
  const skill = readRecord(section.skill);
  const consumer = readRecord(section.consumer);

  return layerJsonOntoEnv(env, [
    { env: "MONO_AGENT_A2A_PROVIDER_ENABLED", value: provider.enabled, kind: "boolean" },
    { env: "MONO_AGENT_A2A_HOST", value: provider.host },
    { env: "MONO_AGENT_A2A_PORT", value: provider.port, kind: "integer" },
    { env: "MONO_AGENT_A2A_PUBLIC_BASE_URL", value: provider.publicBaseUrl },
    { env: "MONO_AGENT_A2A_ALLOW_NON_LOOPBACK", value: provider.allowNonLoopback, kind: "boolean" },
    { env: "MONO_AGENT_A2A_REQUIRE_BEARER", value: provider.requireBearer, kind: "boolean" },
    { env: "MONO_AGENT_A2A_BEARER_TOKEN", value: provider.bearerToken },

    { env: "MONO_AGENT_A2A_AGENT_NAME", value: agent.name },
    { env: "MONO_AGENT_A2A_AGENT_DESCRIPTION", value: agent.description },
    { env: "MONO_AGENT_A2A_AGENT_VERSION", value: agent.version },
    { env: "MONO_AGENT_A2A_PROVIDER_ORGANIZATION", value: agent.providerOrganization },
    { env: "MONO_AGENT_A2A_PROVIDER_URL", value: agent.providerUrl },

    { env: "MONO_AGENT_A2A_SKILL_ID", value: skill.id },
    { env: "MONO_AGENT_A2A_SKILL_NAME", value: skill.name },
    { env: "MONO_AGENT_A2A_SKILL_DESCRIPTION", value: skill.description },
    { env: "MONO_AGENT_A2A_SKILL_TAGS", value: skill.tags, kind: "csv" },

    { env: "MONO_AGENT_A2A_REMOTE_AGENT_URLS", value: consumer.remoteAgentUrls, kind: "csv" },
    { env: "MONO_AGENT_A2A_DEFAULT_REMOTE_AGENT_URL", value: consumer.defaultRemoteAgentUrl },
    { env: "MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN", value: consumer.bearerToken },
    { env: "MONO_AGENT_A2A_TIMEOUT_MS", value: consumer.timeoutMs, kind: "integer" },
  ]);
}

function withoutBearer(
  provider: A2AAdapterProviderConfig,
): Omit<A2AAdapterProviderConfig, "bearerToken"> {
  const { bearerToken: _bearerToken, ...safeProvider } = provider;
  return safeProvider;
}
