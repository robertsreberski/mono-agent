import {
  defineFieldGroup,
  readSettingsJson,
} from "@mono-agent/settings";
import type { FieldGroup, SettingsJson } from "@mono-agent/settings";

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
    readonly bearerToken: { readonly present: boolean; readonly redacted: true };
  };
  readonly agent?: A2AAdapterAgentConfig;
  readonly skill?: A2AAgentSkillOptions;
  readonly consumer: Omit<A2AAdapterConsumerConfig, "bearerToken" | "remoteAgentUrls"> & {
    readonly remoteAgentUrls: { readonly count: number };
    readonly bearerToken: { readonly present: boolean; readonly redacted: true };
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

export const a2aFieldGroup: FieldGroup = defineFieldGroup({
  id: "a2a",
  label: "A2A",
  description: "Optional A2A provider and consumer configuration.",
  fields: [
    {
      id: "a2a.provider.enabled",
      label: "Enable provider",
      description: "Expose this Mono Agent as an A2A provider.",
      kind: "switch",
      path: ["a2a", "provider", "enabled"],
    },
    {
      id: "a2a.provider.host",
      label: "Provider host",
      description: "Bind host. Defaults to 127.0.0.1.",
      kind: "string",
      placeholder: "127.0.0.1",
      path: ["a2a", "provider", "host"],
    },
    {
      id: "a2a.provider.port",
      label: "Provider port",
      description: "Bind port. Use 0 to choose a free loopback port.",
      kind: "integer",
      min: 0,
      max: 65535,
      placeholder: "0",
      path: ["a2a", "provider", "port"],
    },
    {
      id: "a2a.provider.publicBaseUrl",
      label: "Public base URL",
      description: "Advertised base URL for Agent Card interfaces.",
      kind: "string",
      placeholder: "http://127.0.0.1:4300",
      path: ["a2a", "provider", "publicBaseUrl"],
    },
    {
      id: "a2a.provider.allowNonLoopback",
      label: "Allow non-loopback",
      description: "Explicitly allow public/non-loopback binding or advertised URLs.",
      kind: "switch",
      path: ["a2a", "provider", "allowNonLoopback"],
    },
    {
      id: "a2a.provider.requireBearer",
      label: "Require bearer",
      description: "Require Authorization: Bearer for A2A message and task endpoints.",
      kind: "switch",
      path: ["a2a", "provider", "requireBearer"],
    },
    {
      id: "a2a.provider.bearerToken",
      label: "Provider bearer token",
      description: "Token required when bearer auth is enabled. Never returned to the UI after save.",
      kind: "secret",
      path: ["a2a", "provider", "bearerToken"],
    },
    {
      id: "a2a.agent.name",
      label: "Agent name",
      description: "Human-readable Agent Card name.",
      kind: "string",
      path: ["a2a", "agent", "name"],
    },
    {
      id: "a2a.agent.description",
      label: "Agent description",
      description: "Human-readable Agent Card description.",
      kind: "string",
      path: ["a2a", "agent", "description"],
    },
    {
      id: "a2a.agent.version",
      label: "Agent version",
      description: "Agent version advertised in the Agent Card.",
      kind: "string",
      placeholder: "0.1.0",
      path: ["a2a", "agent", "version"],
    },
    {
      id: "a2a.agent.providerOrganization",
      label: "Provider organization",
      description: "Optional provider organization for the Agent Card.",
      kind: "string",
      path: ["a2a", "agent", "providerOrganization"],
    },
    {
      id: "a2a.agent.providerUrl",
      label: "Provider URL",
      description: "Optional provider URL for the Agent Card.",
      kind: "string",
      path: ["a2a", "agent", "providerUrl"],
    },
    {
      id: "a2a.skill.id",
      label: "Skill id",
      description: "A2A skill identifier.",
      kind: "string",
      path: ["a2a", "skill", "id"],
    },
    {
      id: "a2a.skill.name",
      label: "Skill name",
      description: "A2A skill name.",
      kind: "string",
      path: ["a2a", "skill", "name"],
    },
    {
      id: "a2a.skill.description",
      label: "Skill description",
      description: "A2A skill description.",
      kind: "string",
      path: ["a2a", "skill", "description"],
    },
    {
      id: "a2a.skill.tags",
      label: "Skill tags",
      description: "Comma-separated A2A skill tags.",
      kind: "csv",
      path: ["a2a", "skill", "tags"],
    },
    {
      id: "a2a.consumer.remoteAgentUrls",
      label: "Remote agent URLs",
      description: "Comma-separated base or Agent Card URLs for remote A2A agents.",
      kind: "csv",
      path: ["a2a", "consumer", "remoteAgentUrls"],
    },
    {
      id: "a2a.consumer.defaultRemoteAgentUrl",
      label: "Default remote URL",
      description: "Default remote A2A agent URL for hosts that need one.",
      kind: "string",
      path: ["a2a", "consumer", "defaultRemoteAgentUrl"],
    },
    {
      id: "a2a.consumer.bearerToken",
      label: "Consumer bearer token",
      description: "Bearer token used when calling remote A2A agents.",
      kind: "secret",
      path: ["a2a", "consumer", "bearerToken"],
    },
    {
      id: "a2a.consumer.timeoutMs",
      label: "Consumer timeout",
      description: "Per-call timeout in milliseconds.",
      kind: "integer",
      min: 1,
      max: 600_000,
      placeholder: "30000",
      path: ["a2a", "consumer", "timeoutMs"],
    },
  ],
});

export async function loadA2AAdapterConfig(
  input: LoadA2AAdapterConfigInput,
): Promise<A2AAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const env = layerA2AJsonOntoEnv(json, input.env);
  const enabled = readBoolean(env.MONO_AGENT_A2A_PROVIDER_ENABLED, false, "MONO_AGENT_A2A_PROVIDER_ENABLED");
  const provider: A2AAdapterProviderConfig = {
    enabled,
    host: readString(env.MONO_AGENT_A2A_HOST, DEFAULT_HOST),
    port: readInteger(env.MONO_AGENT_A2A_PORT, DEFAULT_PORT, "MONO_AGENT_A2A_PORT", { min: 0, max: 65535 }),
    ...(readOptionalString(env.MONO_AGENT_A2A_PUBLIC_BASE_URL) === undefined
      ? {}
      : { publicBaseUrl: readOptionalString(env.MONO_AGENT_A2A_PUBLIC_BASE_URL) as string }),
    allowNonLoopback: readBoolean(env.MONO_AGENT_A2A_ALLOW_NON_LOOPBACK, false, "MONO_AGENT_A2A_ALLOW_NON_LOOPBACK"),
    requireBearer: readBoolean(env.MONO_AGENT_A2A_REQUIRE_BEARER, false, "MONO_AGENT_A2A_REQUIRE_BEARER"),
    ...(readOptionalString(env.MONO_AGENT_A2A_BEARER_TOKEN) === undefined
      ? {}
      : { bearerToken: readOptionalString(env.MONO_AGENT_A2A_BEARER_TOKEN) as string }),
  };

  const consumerBearerToken = readOptionalString(env.MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN);
  const defaultRemoteAgentUrl = readOptionalString(env.MONO_AGENT_A2A_DEFAULT_REMOTE_AGENT_URL);
  const consumer: A2AAdapterConsumerConfig = {
    remoteAgentUrls: readCsv(env.MONO_AGENT_A2A_REMOTE_AGENT_URLS),
    ...(defaultRemoteAgentUrl === undefined ? {} : { defaultRemoteAgentUrl }),
    ...(consumerBearerToken === undefined ? {} : { bearerToken: consumerBearerToken }),
    timeoutMs: readInteger(env.MONO_AGENT_A2A_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "MONO_AGENT_A2A_TIMEOUT_MS", {
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
      bearerToken: {
        present: config.provider.bearerToken !== undefined && config.provider.bearerToken.length > 0,
        redacted: true,
      },
    },
    ...(config.agent === undefined ? {} : { agent: config.agent }),
    ...(config.skill === undefined ? {} : { skill: config.skill }),
    consumer: {
      remoteAgentUrls: { count: config.consumer.remoteAgentUrls.length },
      ...(config.consumer.defaultRemoteAgentUrl === undefined
        ? {}
        : { defaultRemoteAgentUrl: config.consumer.defaultRemoteAgentUrl }),
      timeoutMs: config.consumer.timeoutMs,
      bearerToken: {
        present: config.consumer.bearerToken !== undefined && config.consumer.bearerToken.length > 0,
        redacted: true,
      },
    },
  };
}

function readAgentConfig(env: Record<string, string | undefined>): A2AAdapterAgentConfig {
  const providerOrganization = readOptionalString(env.MONO_AGENT_A2A_PROVIDER_ORGANIZATION);
  const providerUrl = readOptionalString(env.MONO_AGENT_A2A_PROVIDER_URL);
  return {
    name: readRequired(env.MONO_AGENT_A2A_AGENT_NAME, "MONO_AGENT_A2A_AGENT_NAME"),
    description: readRequired(env.MONO_AGENT_A2A_AGENT_DESCRIPTION, "MONO_AGENT_A2A_AGENT_DESCRIPTION"),
    version: readRequired(env.MONO_AGENT_A2A_AGENT_VERSION, "MONO_AGENT_A2A_AGENT_VERSION"),
    ...(providerOrganization === undefined ? {} : { providerOrganization }),
    ...(providerUrl === undefined ? {} : { providerUrl }),
  };
}

function readSkillConfig(env: Record<string, string | undefined>): A2AAgentSkillOptions {
  return {
    id: readRequired(env.MONO_AGENT_A2A_SKILL_ID, "MONO_AGENT_A2A_SKILL_ID"),
    name: readRequired(env.MONO_AGENT_A2A_SKILL_NAME, "MONO_AGENT_A2A_SKILL_NAME"),
    description: readRequired(env.MONO_AGENT_A2A_SKILL_DESCRIPTION, "MONO_AGENT_A2A_SKILL_DESCRIPTION"),
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
  const section = readRecord(json.a2a);
  const provider = readRecord(section.provider);
  const agent = readRecord(section.agent);
  const skill = readRecord(section.skill);
  const consumer = readRecord(section.consumer);
  const fromJson: Record<string, string | undefined> = {};

  setBoolean(fromJson, "MONO_AGENT_A2A_PROVIDER_ENABLED", provider.enabled);
  setString(fromJson, "MONO_AGENT_A2A_HOST", provider.host);
  setInteger(fromJson, "MONO_AGENT_A2A_PORT", provider.port);
  setString(fromJson, "MONO_AGENT_A2A_PUBLIC_BASE_URL", provider.publicBaseUrl);
  setBoolean(fromJson, "MONO_AGENT_A2A_ALLOW_NON_LOOPBACK", provider.allowNonLoopback);
  setBoolean(fromJson, "MONO_AGENT_A2A_REQUIRE_BEARER", provider.requireBearer);
  setString(fromJson, "MONO_AGENT_A2A_BEARER_TOKEN", provider.bearerToken);

  setString(fromJson, "MONO_AGENT_A2A_AGENT_NAME", agent.name);
  setString(fromJson, "MONO_AGENT_A2A_AGENT_DESCRIPTION", agent.description);
  setString(fromJson, "MONO_AGENT_A2A_AGENT_VERSION", agent.version);
  setString(fromJson, "MONO_AGENT_A2A_PROVIDER_ORGANIZATION", agent.providerOrganization);
  setString(fromJson, "MONO_AGENT_A2A_PROVIDER_URL", agent.providerUrl);

  setString(fromJson, "MONO_AGENT_A2A_SKILL_ID", skill.id);
  setString(fromJson, "MONO_AGENT_A2A_SKILL_NAME", skill.name);
  setString(fromJson, "MONO_AGENT_A2A_SKILL_DESCRIPTION", skill.description);
  setCsv(fromJson, "MONO_AGENT_A2A_SKILL_TAGS", skill.tags);

  setCsv(fromJson, "MONO_AGENT_A2A_REMOTE_AGENT_URLS", consumer.remoteAgentUrls);
  setString(fromJson, "MONO_AGENT_A2A_DEFAULT_REMOTE_AGENT_URL", consumer.defaultRemoteAgentUrl);
  setString(fromJson, "MONO_AGENT_A2A_CONSUMER_BEARER_TOKEN", consumer.bearerToken);
  setInteger(fromJson, "MONO_AGENT_A2A_TIMEOUT_MS", consumer.timeoutMs);

  const layered: Record<string, string | undefined> = { ...fromJson };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      layered[key] = value;
    }
  }
  return layered;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readRequired(value: string | undefined, envName: string): string {
  const normalized = readOptionalString(value);
  if (normalized === undefined) {
    throw new A2AProviderError("missing_required_config", `${envName} is required when A2A provider is enabled.`, {
      env: envName,
    });
  }
  return normalized;
}

function readString(raw: string | undefined, defaultValue: string): string {
  return readOptionalString(raw) ?? defaultValue;
}

function readOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function readCsv(raw: string | undefined): readonly string[] {
  const normalized = readOptionalString(raw);
  if (normalized === undefined) {
    return [];
  }
  return normalized
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function readBoolean(raw: string | undefined, defaultValue: boolean, envName: string): boolean {
  const normalized = readOptionalString(raw);
  if (normalized === undefined) {
    return defaultValue;
  }
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new A2AProviderError("invalid_config", `${envName} must be true or false.`, { env: envName });
}

function readInteger(
  raw: string | undefined,
  defaultValue: number,
  envName: string,
  bounds: {
    readonly min: number;
    readonly max: number;
  },
): number {
  const normalized = readOptionalString(raw);
  if (normalized === undefined) {
    return defaultValue;
  }
  if (!/^\d+$/u.test(normalized)) {
    throw new A2AProviderError("invalid_config", `${envName} must be an integer.`, { env: envName });
  }
  const value = Number.parseInt(normalized, 10);
  if (value < bounds.min || value > bounds.max) {
    throw new A2AProviderError(
      "invalid_config",
      `${envName} must be between ${bounds.min} and ${bounds.max}.`,
      { env: envName },
    );
  }
  return value;
}

function setString(target: Record<string, string | undefined>, key: string, value: unknown): void {
  if (typeof value === "string") {
    target[key] = value;
  }
}

function setBoolean(target: Record<string, string | undefined>, key: string, value: unknown): void {
  if (typeof value === "boolean") {
    target[key] = value ? "true" : "false";
  }
}

function setInteger(target: Record<string, string | undefined>, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isInteger(value)) {
    target[key] = String(value);
  }
}

function setCsv(target: Record<string, string | undefined>, key: string, value: unknown): void {
  if (Array.isArray(value)) {
    target[key] = value.filter((item): item is string => typeof item === "string").join(",");
  }
}

function withoutBearer(
  provider: A2AAdapterProviderConfig,
): Omit<A2AAdapterProviderConfig, "bearerToken"> {
  const { bearerToken: _bearerToken, ...safeProvider } = provider;
  return safeProvider;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("127.");
}
