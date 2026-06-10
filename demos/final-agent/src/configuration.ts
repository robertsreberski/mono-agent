import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";

import {
  CORE_AGENT_FIELD_GROUPS,
  loadMonoAgentConfigWithSources,
  MonoAgentConfigError,
  readMonoAgentConfigJson,
  redactMonoAgentConfig,
} from "@mono-agent/config";
import type {
  MonoAgentConfig,
  RedactedMonoAgentConfig,
} from "@mono-agent/config";
import type { FieldGroup } from "@mono-agent/settings";
import {
  a2aFieldGroup,
  A2AConsumerError,
  A2AProviderError,
  loadA2AAdapterConfig,
  redactA2AAdapterConfig,
} from "@mono-agent/a2a-adapter";
import type {
  A2AAdapterConfig,
  RedactedA2AAdapterConfig,
} from "@mono-agent/a2a-adapter";
import {
  loadTelegramAdapterConfig,
  redactTelegramAdapterConfig,
  telegramFieldGroup,
  TelegramAdapterConfigError,
} from "@mono-agent/telegram-adapter";
import type {
  RedactedTelegramAdapterConfig,
  TelegramAdapterConfig,
} from "@mono-agent/telegram-adapter";
import {
  loadWebhookAdapterConfig,
  redactWebhookAdapterConfig,
  webhookFieldGroup,
  WebhookAdapterError,
} from "@mono-agent/webhook-adapter";
import type {
  RedactedWebhookAdapterConfig,
  WebhookAdapterConfig,
} from "@mono-agent/webhook-adapter";
import {
  loadOpenAIApiAdapterConfig,
  openAIApiFieldGroup,
  OpenAIApiAdapterError,
  redactOpenAIApiAdapterConfig,
} from "@mono-agent/openai-api-adapter";
import type {
  OpenAIApiAdapterConfig,
  RedactedOpenAIApiAdapterConfig,
} from "@mono-agent/openai-api-adapter";
import {
  cronFieldGroup,
  CronAdapterError,
  loadCronAdapterConfig,
  redactCronAdapterConfig,
} from "@mono-agent/cron-adapter";
import type {
  CronAdapterConfig,
  RedactedCronAdapterConfig,
} from "@mono-agent/cron-adapter";

export const FINAL_DEMO_FIELD_GROUPS: readonly FieldGroup[] = [
  ...CORE_AGENT_FIELD_GROUPS,
  telegramFieldGroup,
  a2aFieldGroup,
  webhookFieldGroup,
  openAIApiFieldGroup,
  cronFieldGroup,
];

export interface FinalAgentDemoConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly configPath: string;
}

export interface LoadedFinalAgentDemoConfig {
  readonly coreConfig: MonoAgentConfig;
  readonly telegramConfig?: TelegramAdapterConfig;
  readonly a2aConfig?: A2AAdapterConfig;
  readonly webhookConfig?: WebhookAdapterConfig;
  readonly openAIApiConfig?: OpenAIApiAdapterConfig;
  readonly cronConfig?: CronAdapterConfig;
}

export interface RedactedFinalAgentDemoConfig {
  readonly core: RedactedMonoAgentConfig;
  readonly telegram?: RedactedTelegramAdapterConfig;
  readonly a2a?: RedactedA2AAdapterConfig;
  readonly webhook?: RedactedWebhookAdapterConfig;
  readonly openaiApi?: RedactedOpenAIApiAdapterConfig;
  readonly cron?: RedactedCronAdapterConfig;
}

const DEFAULT_TRACE_HEARTBEAT_MS = 10_000;
const DEFAULT_TRACE_STALE_AFTER_MS = 30_000;

export type FinalAgentDemoConfigError =
  | MonoAgentConfigError
  | TelegramAdapterConfigError
  | A2AProviderError
  | A2AConsumerError
  | WebhookAdapterError
  | OpenAIApiAdapterError
  | CronAdapterError;

export async function loadFinalAgentCoreConfig(
  input: FinalAgentDemoConfigInput,
): Promise<MonoAgentConfig> {
  return await loadMonoAgentConfigWithSources({
    env: input.env,
    cwd: input.cwd,
    jsonPath: input.configPath,
  });
}

export async function loadFinalAgentTelegramConfig(
  input: FinalAgentDemoConfigInput,
): Promise<TelegramAdapterConfig> {
  return await loadTelegramAdapterConfig({
    env: input.env,
    jsonPath: input.configPath,
  });
}

export async function loadFinalAgentA2AConfig(
  input: FinalAgentDemoConfigInput,
): Promise<A2AAdapterConfig> {
  return await loadA2AAdapterConfig({
    env: input.env,
    jsonPath: input.configPath,
  });
}

export async function loadFinalAgentWebhookConfig(
  input: FinalAgentDemoConfigInput,
): Promise<WebhookAdapterConfig> {
  return await loadWebhookAdapterConfig({
    env: input.env,
    jsonPath: input.configPath,
  });
}

export async function loadFinalAgentOpenAIApiConfig(
  input: FinalAgentDemoConfigInput,
): Promise<OpenAIApiAdapterConfig> {
  return await loadOpenAIApiAdapterConfig({
    env: input.env,
    jsonPath: input.configPath,
  });
}

export async function loadFinalAgentCronConfig(
  input: FinalAgentDemoConfigInput,
): Promise<CronAdapterConfig> {
  return await loadCronAdapterConfig({
    env: input.env,
    jsonPath: input.configPath,
  });
}

export async function loadFinalAgentDemoConfig(
  input: FinalAgentDemoConfigInput,
): Promise<LoadedFinalAgentDemoConfig> {
  const coreConfig = await loadFinalAgentCoreConfig(input);
  const telegramConfig = await loadFinalAgentTelegramConfig(input);
  const a2aConfig = await loadFinalAgentA2AConfig(input);
  const webhookConfig = await loadFinalAgentWebhookConfig(input);
  const openAIApiConfig = await loadFinalAgentOpenAIApiConfig(input);
  const cronConfig = await loadFinalAgentCronConfig(input);
  return { coreConfig, telegramConfig, a2aConfig, webhookConfig, openAIApiConfig, cronConfig };
}

export function redactFinalAgentDemoConfig(
  config: LoadedFinalAgentDemoConfig,
): RedactedFinalAgentDemoConfig {
  return {
    core: redactMonoAgentConfig(config.coreConfig),
    ...(config.telegramConfig === undefined ? {} : { telegram: redactTelegramAdapterConfig(config.telegramConfig) }),
    ...(config.a2aConfig === undefined ? {} : { a2a: redactA2AAdapterConfig(config.a2aConfig) }),
    ...(config.webhookConfig === undefined ? {} : { webhook: redactWebhookAdapterConfig(config.webhookConfig) }),
    ...(config.openAIApiConfig === undefined ? {} : { openaiApi: redactOpenAIApiAdapterConfig(config.openAIApiConfig) }),
    ...(config.cronConfig === undefined ? {} : { cron: redactCronAdapterConfig(config.cronConfig) }),
  };
}

export async function resolveFinalDemoArtifactDir(
  input: FinalAgentDemoConfigInput,
): Promise<string> {
  const envDir = input.env.MONO_AGENT_ARTIFACT_DIR?.trim();
  if (envDir !== undefined && envDir.length > 0) {
    return resolve(input.cwd, envDir);
  }

  try {
    const { json } = await readMonoAgentConfigJson(input.configPath);
    const configDir = typeof json.artifacts?.dir === "string" ? json.artifacts.dir.trim() : "";
    if (configDir.length > 0) {
      return resolve(input.cwd, configDir);
    }
  } catch {
    // Keep Observability usable for already-written default artifacts even while
    // the user is fixing an incomplete or invalid demo config.
  }

  return resolve(input.cwd, ".mono-agent", "artifacts");
}

export async function resolveFinalDemoTraceRegistryDir(
  input: FinalAgentDemoConfigInput,
): Promise<string> {
  const envDir = input.env.MONO_AGENT_TRACE_REGISTRY_DIR?.trim();
  if (envDir !== undefined && envDir.length > 0) {
    return resolve(input.cwd, envDir);
  }

  try {
    const { json } = await readMonoAgentConfigJson(input.configPath);
    const registryDir = typeof json.traceability?.registryDir === "string" ? json.traceability.registryDir.trim() : "";
    if (registryDir.length > 0) {
      return resolve(input.cwd, registryDir);
    }
  } catch {
    // Keep the operator console usable while the user fixes config JSON.
  }

  return resolve(homedir(), ".mono-agent", "trace-sources");
}

export async function resolveFinalDemoTraceSourceId(
  input: FinalAgentDemoConfigInput,
): Promise<string> {
  const envSourceId = input.env.MONO_AGENT_TRACE_SOURCE_ID?.trim();
  if (envSourceId !== undefined && envSourceId.length > 0) {
    return envSourceId;
  }

  try {
    const { json } = await readMonoAgentConfigJson(input.configPath);
    const sourceId = typeof json.traceability?.sourceId === "string" ? json.traceability.sourceId.trim() : "";
    if (sourceId.length > 0) {
      return sourceId;
    }
  } catch {
    // Use the deterministic cwd/config fallback below.
  }

  const hash = createHash("sha256")
    .update(resolve(input.cwd))
    .update("\0")
    .update(resolve(input.configPath))
    .digest("hex")
    .slice(0, 12);
  return `final-agent-${hash}`;
}

export async function resolveFinalDemoTraceSourceLabel(
  input: FinalAgentDemoConfigInput,
): Promise<string> {
  const envLabel = input.env.MONO_AGENT_TRACE_SOURCE_LABEL?.trim();
  if (envLabel !== undefined && envLabel.length > 0) {
    return envLabel;
  }

  try {
    const { json } = await readMonoAgentConfigJson(input.configPath);
    const label = typeof json.traceability?.sourceLabel === "string" ? json.traceability.sourceLabel.trim() : "";
    if (label.length > 0) {
      return label;
    }
  } catch {
    // Keep the default label below.
  }

  return "Final Agent Demo";
}

export async function resolveFinalDemoTraceHeartbeatMs(
  input: FinalAgentDemoConfigInput,
): Promise<number> {
  return await resolveTraceInteger({
    input,
    envName: "MONO_AGENT_TRACE_HEARTBEAT_MS",
    jsonKey: "heartbeatMs",
    defaultValue: DEFAULT_TRACE_HEARTBEAT_MS,
    min: 250,
    max: 86_400_000,
  });
}

export async function resolveFinalDemoTraceStaleAfterMs(
  input: FinalAgentDemoConfigInput,
): Promise<number> {
  return await resolveTraceInteger({
    input,
    envName: "MONO_AGENT_TRACE_STALE_AFTER_MS",
    jsonKey: "staleAfterMs",
    defaultValue: DEFAULT_TRACE_STALE_AFTER_MS,
    min: 1_000,
    max: 604_800_000,
  });
}

async function resolveTraceInteger(options: {
  readonly input: FinalAgentDemoConfigInput;
  readonly envName: string;
  readonly jsonKey: "heartbeatMs" | "staleAfterMs";
  readonly defaultValue: number;
  readonly min: number;
  readonly max: number;
}): Promise<number> {
  const envValue = options.input.env[options.envName]?.trim();
  if (envValue !== undefined && envValue.length > 0) {
    return parseTraceInteger(envValue, options.envName, options.min, options.max);
  }

  try {
    const { json } = await readMonoAgentConfigJson(options.input.configPath);
    const value = json.traceability?.[options.jsonKey];
    if (value !== undefined) {
      return parseTraceInteger(value, `traceability.${options.jsonKey}`, options.min, options.max);
    }
  } catch {
    // Use the default while the user is fixing an incomplete or invalid config.
  }

  return options.defaultValue;
}

function parseTraceInteger(value: unknown, name: string, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new MonoAgentConfigError(
      "invalid_env",
      `${name} must be an integer between ${min} and ${max}.`,
      { env: name, reason: "integer_range" },
    );
  }
  return parsed;
}

export function isFinalAgentDemoConfigError(
  error: unknown,
): error is FinalAgentDemoConfigError {
  return error instanceof MonoAgentConfigError ||
    error instanceof TelegramAdapterConfigError ||
    error instanceof A2AProviderError ||
    error instanceof A2AConsumerError ||
    error instanceof WebhookAdapterError ||
    error instanceof OpenAIApiAdapterError ||
    error instanceof CronAdapterError;
}
