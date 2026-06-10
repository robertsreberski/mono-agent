import {
  defineFieldGroup,
  layerJsonOntoEnv,
  normalizeOptionalString,
  readBoolean,
  readJsonSection,
  readSettingsJson,
} from "@mono-agent/settings";
import type { FieldGroup, SettingsJson } from "@mono-agent/settings";

import { CronAdapterError, type CronJob } from "./scheduler.js";

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

const invalidConfig = (message: string, details?: Record<string, unknown>): CronAdapterError =>
  new CronAdapterError("invalid_config", message, details);

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
  const enabled = readBoolean(env.MONO_AGENT_CRON_ENABLED, "MONO_AGENT_CRON_ENABLED", false, invalidConfig);
  const expression = normalizeOptionalString(env.MONO_AGENT_CRON_EXPRESSION);
  const prompt = normalizeOptionalString(env.MONO_AGENT_CRON_PROMPT);
  if (!enabled && expression === undefined && prompt === undefined) {
    return { jobs: [] };
  }
  if (expression === undefined) {
    throw invalidConfig("Cron expression is required when cron is configured.");
  }
  if (prompt === undefined) {
    throw invalidConfig("Cron prompt is required when cron is configured.");
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

/**
 * Project the loaded config down to the runtime {@link CronJob} shape consumed
 * by {@link import("./scheduler.js").startCronAdapter}, dropping disabled jobs.
 * Hosts must route config jobs through this rather than spreading them directly,
 * otherwise the `enabled` flag is silently ignored and disabled jobs would run.
 */
export function toCronJobs(config: CronAdapterConfig): CronJob[] {
  return config.jobs
    .filter((job) => job.enabled)
    .map((job) => ({
      id: job.id,
      expression: job.expression,
      timezone: job.timezone,
      prompt: job.prompt,
      ...(job.conversationId === undefined ? {} : { conversationId: job.conversationId }),
    }));
}

export function redactCronAdapterConfig(config: CronAdapterConfig): RedactedCronAdapterConfig {
  // Cron config holds no secrets (the prompt is not treated as one), so
  // redaction is the identity transform; we only clone to preserve immutability.
  return {
    jobs: config.jobs.map((job) => ({ ...job })),
  };
}

function readJobsJson(value: string): readonly CronJobConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw invalidConfig("MONO_AGENT_CRON_JOBS_JSON must contain valid JSON.", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (!Array.isArray(parsed)) {
    throw invalidConfig("MONO_AGENT_CRON_JOBS_JSON must be an array.");
  }
  return parsed.map((entry, index) => normalizeJobConfig(entry, index));
}

function normalizeJobConfig(entry: unknown, index: number): CronJobConfig {
  if (!isRecord(entry)) {
    throw invalidConfig("Cron job entries must be objects.", { index });
  }
  const id = asOptionalString(entry.id);
  const expression = asOptionalString(entry.expression);
  const prompt = asOptionalString(entry.prompt);
  if (id === undefined || expression === undefined || prompt === undefined) {
    throw invalidConfig("Cron jobs require id, expression, and prompt.", { index });
  }
  const conversationId = asOptionalString(entry.conversationId);
  return {
    id,
    enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
    expression,
    timezone: asOptionalString(entry.timezone) ?? DEFAULT_TIMEZONE,
    prompt,
    ...(conversationId === undefined ? {} : { conversationId }),
  };
}

function layerCronJsonOntoEnv(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const section = readJsonSection(json, "cron");
  return layerJsonOntoEnv(env, [
    { env: "MONO_AGENT_CRON_ENABLED", value: section.enabled, kind: "boolean" },
    { env: "MONO_AGENT_CRON_EXPRESSION", value: section.expression },
    { env: "MONO_AGENT_CRON_TIMEZONE", value: section.timezone },
    { env: "MONO_AGENT_CRON_PROMPT", value: section.prompt },
    { env: "MONO_AGENT_CRON_CONVERSATION_ID", value: section.conversationId },
  ]);
}

/** Trim a JSON value to a non-empty string, treating non-strings as absent. */
function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
