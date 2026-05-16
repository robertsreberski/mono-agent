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
];

export interface FinalAgentDemoConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly configPath: string;
}

export interface LoadedFinalAgentDemoConfig {
  readonly coreConfig: MonoAgentConfig;
  readonly telegramConfig: TelegramAdapterConfig;
}

export interface RedactedFinalAgentDemoConfig {
  readonly core: RedactedMonoAgentConfig;
  readonly telegram: RedactedTelegramAdapterConfig;
}

export type FinalAgentDemoConfigError =
  | MonoAgentConfigError
  | TelegramAdapterConfigError;

export async function loadFinalAgentDemoConfig(
  input: FinalAgentDemoConfigInput,
): Promise<LoadedFinalAgentDemoConfig> {
  const coreConfig = await loadMonoAgentConfigWithSources({
    env: input.env,
    cwd: input.cwd,
    jsonPath: input.configPath,
  });
  const telegramConfig = await loadTelegramAdapterConfig({
    env: input.env,
    jsonPath: input.configPath,
  });
  return { coreConfig, telegramConfig };
}

export function redactFinalAgentDemoConfig(
  config: LoadedFinalAgentDemoConfig,
): RedactedFinalAgentDemoConfig {
  return {
    core: redactMonoAgentConfig(config.coreConfig),
    telegram: redactTelegramAdapterConfig(config.telegramConfig),
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
    error instanceof TelegramAdapterConfigError;
}
