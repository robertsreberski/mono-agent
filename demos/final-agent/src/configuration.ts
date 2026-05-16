import { resolve } from "node:path";

import {
  CORE_AGENT_FIELD_GROUPS,
  loadMonoAgentConfigWithSources,
  MonoAgentConfigError,
  readMonoAgentConfigJson,
  redactMonoAgentConfig,
} from "@worklab-ai/config";
import type {
  MonoAgentConfig,
  RedactedMonoAgentConfig,
} from "@worklab-ai/config";
import type { FieldGroup } from "@worklab-ai/settings";
import {
  a2aFieldGroup,
  A2AConsumerError,
  A2AProviderError,
  loadA2AAdapterConfig,
  redactA2AAdapterConfig,
} from "@worklab-ai/a2a-adapter";
import type {
  A2AAdapterConfig,
  RedactedA2AAdapterConfig,
} from "@worklab-ai/a2a-adapter";
import {
  loadTelegramAdapterConfig,
  redactTelegramAdapterConfig,
  telegramFieldGroup,
  TelegramAdapterConfigError,
} from "@worklab-ai/telegram-adapter";
import type {
  RedactedTelegramAdapterConfig,
  TelegramAdapterConfig,
} from "@worklab-ai/telegram-adapter";

export const FINAL_DEMO_FIELD_GROUPS: readonly FieldGroup[] = [
  ...CORE_AGENT_FIELD_GROUPS,
  telegramFieldGroup,
  a2aFieldGroup,
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
}

export interface RedactedFinalAgentDemoConfig {
  readonly core: RedactedMonoAgentConfig;
  readonly telegram?: RedactedTelegramAdapterConfig;
  readonly a2a?: RedactedA2AAdapterConfig;
}

export type FinalAgentDemoConfigError =
  | MonoAgentConfigError
  | TelegramAdapterConfigError
  | A2AProviderError
  | A2AConsumerError;

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

export async function loadFinalAgentDemoConfig(
  input: FinalAgentDemoConfigInput,
): Promise<LoadedFinalAgentDemoConfig> {
  const coreConfig = await loadFinalAgentCoreConfig(input);
  const telegramConfig = await loadFinalAgentTelegramConfig(input);
  const a2aConfig = await loadFinalAgentA2AConfig(input);
  return { coreConfig, telegramConfig, a2aConfig };
}

export function redactFinalAgentDemoConfig(
  config: LoadedFinalAgentDemoConfig,
): RedactedFinalAgentDemoConfig {
  return {
    core: redactMonoAgentConfig(config.coreConfig),
    ...(config.telegramConfig === undefined ? {} : { telegram: redactTelegramAdapterConfig(config.telegramConfig) }),
    ...(config.a2aConfig === undefined ? {} : { a2a: redactA2AAdapterConfig(config.a2aConfig) }),
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

export function isFinalAgentDemoConfigError(
  error: unknown,
): error is FinalAgentDemoConfigError {
  return error instanceof MonoAgentConfigError ||
    error instanceof TelegramAdapterConfigError ||
    error instanceof A2AProviderError ||
    error instanceof A2AConsumerError;
}
