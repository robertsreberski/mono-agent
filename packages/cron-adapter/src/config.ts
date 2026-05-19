import {
  defineFieldGroup,
  readSettingsJson,
} from "@worklab-ai/settings";
import type { FieldGroup, SettingsJson } from "@worklab-ai/settings";

import { CronAdapterError } from "./scheduler.js";

export interface CronJobConfig {
  readonly id: string;
  readonly enabled: boolean;
  readonly expression: string;
  readonly timezone: string;
  readonly prompt: string;
  readonly conversationId?: string;
}

export interface CronAdapterConfig {
  readonly jobs: readonly CronJobConfig[];
}

export type RedactedCronAdapterConfig = CronAdapterConfig;

export interface LoadCronAdapterConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
}

const DEFAULT_JOB_ID = "default";
const DEFAULT_TIMEZONE = "UTC";

export const cronFieldGroup: FieldGroup = defineFieldGroup({
  id: "cron",
  label: "Cron",
  description: "Optional single-job cron invocation configuration. Use JSON for multiple jobs.",
  fields: [
    {
      id: "cron.enabled",
      label: "Enable cron",
      description: "Enable the default scheduled agent job.",
      kind: "switch",
      path: ["cron", "enabled"],
    },
    {
      id: "cron.expression",
      label: "Cron expression",
      description: "Five-field cron expression for the default job.",
      kind: "string",
      placeholder: "0 * * * *",
      path: ["cron", "expression"],
    },
    {
      id: "cron.timezone",
      label: "Timezone",
      description: "IANA timezone used to calculate scheduled runs.",
      kind: "string",
      placeholder: "UTC",
      path: ["cron", "timezone"],
    },
    {
      id: "cron.prompt",
      label: "Prompt",
      description: "Prompt sent to the agent for the default scheduled job.",
      kind: "string",
      path: ["cron", "prompt"],
    },
    {
      id: "cron.conversationId",
      label: "Conversation id",
      description: "Optional conversation id for memory/history continuity.",
      kind: "string",
      path: ["cron", "conversationId"],
    },
  ],
});

export async function loadCronAdapterConfig(input: LoadCronAdapterConfigInput): Promise<CronAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const jobsJson = normalizeOptionalString(input.env.MONO_AGENT_CRON_JOBS_JSON);
  if (jobsJson !== undefined) {
    return { jobs: readJobsJson(jobsJson) };
  }
  const env = layerCronJsonOntoEnv(json, input.env);
  const enabled = readBoolean(env.MONO_AGENT_CRON_ENABLED, false, "MONO_AGENT_CRON_ENABLED");
  const expression = normalizeOptionalString(env.MONO_AGENT_CRON_EXPRESSION);
  const prompt = normalizeOptionalString(env.MONO_AGENT_CRON_PROMPT);
  if (!enabled && expression === undefined && prompt === undefined) {
    return { jobs: [] };
  }
  if (expression === undefined) {
    throw new CronAdapterError("invalid_config", "Cron expression is required when cron is configured.");
  }
  if (prompt === undefined) {
    throw new CronAdapterError("invalid_config", "Cron prompt is required when cron is configured.");
  }
  const conversationId = normalizeOptionalString(env.MONO_AGENT_CRON_CONVERSATION_ID);
  return {
    jobs: [{
      id: DEFAULT_JOB_ID,
      enabled,
      expression,
      timezone: normalizeOptionalString(env.MONO_AGENT_CRON_TIMEZONE) ?? DEFAULT_TIMEZONE,
      prompt,
      ...(conversationId === undefined ? {} : { conversationId }),
    }],
  };
}

export function redactCronAdapterConfig(config: CronAdapterConfig): RedactedCronAdapterConfig {
  return {
    jobs: config.jobs.map((job) => ({ ...job })),
  };
}

function readJobsJson(value: string): readonly CronJobConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new CronAdapterError("invalid_config", "MONO_AGENT_CRON_JOBS_JSON must contain valid JSON.", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (!Array.isArray(parsed)) {
    throw new CronAdapterError("invalid_config", "MONO_AGENT_CRON_JOBS_JSON must be an array.");
  }
  return parsed.map((entry, index) => normalizeJobConfig(entry, index));
}

function normalizeJobConfig(entry: unknown, index: number): CronJobConfig {
  if (!isRecord(entry)) {
    throw new CronAdapterError("invalid_config", "Cron job entries must be objects.", { index });
  }
  const id = normalizeOptionalString(entry.id);
  const expression = normalizeOptionalString(entry.expression);
  const prompt = normalizeOptionalString(entry.prompt);
  if (id === undefined || expression === undefined || prompt === undefined) {
    throw new CronAdapterError("invalid_config", "Cron jobs require id, expression, and prompt.", { index });
  }
  const conversationId = normalizeOptionalString(entry.conversationId);
  return {
    id,
    enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
    expression,
    timezone: normalizeOptionalString(entry.timezone) ?? DEFAULT_TIMEZONE,
    prompt,
    ...(conversationId === undefined ? {} : { conversationId }),
  };
}

function layerCronJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const section = readCronSection(json);
  const fromJson: Record<string, string | undefined> = {};
  setBoolean(fromJson, "MONO_AGENT_CRON_ENABLED", section.enabled);
  setString(fromJson, "MONO_AGENT_CRON_EXPRESSION", section.expression);
  setString(fromJson, "MONO_AGENT_CRON_TIMEZONE", section.timezone);
  setString(fromJson, "MONO_AGENT_CRON_PROMPT", section.prompt);
  setString(fromJson, "MONO_AGENT_CRON_CONVERSATION_ID", section.conversationId);

  const layered: Record<string, string | undefined> = { ...fromJson };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      layered[key] = value;
    }
  }
  return layered;
}

function readCronSection(json: SettingsJson): Record<string, unknown> {
  const section = json.cron;
  if (section !== null && typeof section === "object" && !Array.isArray(section)) {
    return section as Record<string, unknown>;
  }
  return {};
}

function readBoolean(raw: string | undefined, defaultValue: boolean, envName: string): boolean {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return defaultValue;
  }
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new CronAdapterError("invalid_config", `${envName} must be true or false.`);
}

function setString(out: Record<string, string | undefined>, key: string, value: unknown): void {
  if (typeof value === "string") {
    out[key] = value;
  }
}

function setBoolean(out: Record<string, string | undefined>, key: string, value: unknown): void {
  if (typeof value === "boolean") {
    out[key] = value ? "true" : "false";
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
