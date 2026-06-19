import { resolve } from "node:path";

import {
  defineFieldGroup,
  layerJsonOntoEnv,
  normalizeOptionalString,
  readBoolean,
  readJsonSection,
  readSettingsJson,
} from "@mono-agent/settings";
import type { FieldGroup, SettingsJson } from "@mono-agent/settings";

import { loadCronJobsFromDirectory } from "./jobs-dir.js";
import { CronAdapterError, type CronJob } from "./scheduler.js";

export interface CronJobConfig {
  readonly id: string;
  readonly enabled: boolean;
  readonly expression: string;
  readonly timezone: string;
  readonly prompt: string;
  readonly conversationId?: string;
  /**
   * Destination channel conversationId (`telegram:<chat>`, `slack:<ch>:<thread>`)
   * for a proactive notification. When set, the job's prompt runs as a turn on
   * that channel's own harness and is delivered there, instead of a headless run.
   */
  readonly notify?: string;
}

export interface CronAdapterConfig {
  readonly jobs: readonly CronJobConfig[];
}

export type RedactedCronAdapterConfig = CronAdapterConfig;

export interface LoadCronAdapterConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
  /** Base directory the cron jobs folder resolves against (usually the app cwd). */
  readonly cwd?: string;
  /** Overrides the cron jobs folder; defaults to `cron.dir` / `MONO_AGENT_CRON_DIR` / `cron`. */
  readonly dir?: string;
}

const DEFAULT_JOB_ID = "default";
const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_CRON_DIR = "cron";

const invalidConfig = (message: string, details?: Record<string, unknown>): CronAdapterError =>
  new CronAdapterError("invalid_config", message, details);

export const cronFieldGroup: FieldGroup = defineFieldGroup({
  id: "cron",
  label: "Cron",
  description: "Optional single-job cron invocation configuration. Use JSON for multiple jobs, or `*.md` files in the cron folder.",
  fields: [
    {
      id: "cron.dir",
      label: "Cron folder",
      description: "Folder of `*.md` cron jobs (frontmatter + prompt body), resolved against the app working directory.",
      kind: "string",
      placeholder: "cron",
      path: ["cron", "dir"],
    },
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
  const configJobs = loadConfigJobs(json, input.env);
  const directoryJobs = await loadDirectoryJobs(json, input);
  return { jobs: mergeJobs(configJobs, directoryJobs) };
}

/**
 * Jobs defined inline in config: `MONO_AGENT_CRON_JOBS_JSON` (highest), then the
 * `cron.jobs` array, then the single-job `MONO_AGENT_CRON_*` fields. Returns an
 * empty list when nothing is configured (the cron folder may still add jobs).
 */
function loadConfigJobs(
  json: SettingsJson,
  env: Record<string, string | undefined>,
): CronJobConfig[] {
  const jobsJson = normalizeOptionalString(env.MONO_AGENT_CRON_JOBS_JSON);
  if (jobsJson !== undefined) {
    return [...readJobsJson(jobsJson)];
  }
  const section = readJsonSection(json, "cron");
  if (section.jobs !== undefined) {
    if (!Array.isArray(section.jobs)) {
      throw invalidConfig("cron.jobs must be an array of job objects.");
    }
    return section.jobs.map((entry, index) => normalizeJobConfig(entry, index));
  }
  const layered = layerCronJsonOntoEnv(json, env);
  const enabled = readBoolean(layered.MONO_AGENT_CRON_ENABLED, "MONO_AGENT_CRON_ENABLED", false, invalidConfig);
  const expression = normalizeOptionalString(layered.MONO_AGENT_CRON_EXPRESSION);
  const prompt = normalizeOptionalString(layered.MONO_AGENT_CRON_PROMPT);
  if (!enabled && expression === undefined && prompt === undefined) {
    return [];
  }
  if (expression === undefined) {
    throw invalidConfig("Cron expression is required when cron is configured.");
  }
  if (prompt === undefined) {
    throw invalidConfig("Cron prompt is required when cron is configured.");
  }
  const conversationId = normalizeOptionalString(layered.MONO_AGENT_CRON_CONVERSATION_ID);
  const notify = normalizeOptionalString(layered.MONO_AGENT_CRON_NOTIFY);
  return [{
    id: DEFAULT_JOB_ID,
    enabled,
    expression,
    timezone: normalizeOptionalString(layered.MONO_AGENT_CRON_TIMEZONE) ?? DEFAULT_TIMEZONE,
    prompt,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(notify === undefined ? {} : { notify }),
  }];
}

/**
 * Jobs authored as `*.md` files in the cron folder. Skipped unless a base
 * directory (`input.cwd`) is known, so a loader called without a host (e.g. a
 * unit test) never scans the process working directory implicitly.
 */
async function loadDirectoryJobs(
  json: SettingsJson,
  input: LoadCronAdapterConfigInput,
): Promise<CronJobConfig[]> {
  if (input.cwd === undefined) {
    return [];
  }
  const section = readJsonSection(json, "cron");
  if (section.dir !== undefined && typeof section.dir !== "string") {
    throw invalidConfig("cron.dir must be a string.");
  }
  const dirName =
    normalizeOptionalString(input.dir) ??
    normalizeOptionalString(input.env.MONO_AGENT_CRON_DIR) ??
    asOptionalString(section.dir) ??
    DEFAULT_CRON_DIR;
  return await loadCronJobsFromDirectory(resolve(input.cwd, dirName));
}

/** Combine inline-config jobs with cron-folder jobs; a duplicate id is a hard error. */
function mergeJobs(configJobs: CronJobConfig[], directoryJobs: CronJobConfig[]): CronJobConfig[] {
  const merged: CronJobConfig[] = [];
  const sourceById = new Map<string, string>();
  const append = (job: CronJobConfig, source: string): void => {
    const prior = sourceById.get(job.id);
    if (prior !== undefined) {
      throw invalidConfig(`Duplicate cron job id "${job.id}" from ${prior} and ${source}.`, { id: job.id });
    }
    sourceById.set(job.id, source);
    merged.push(job);
  };
  for (const job of configJobs) {
    append(job, "config");
  }
  for (const job of directoryJobs) {
    append(job, "cron folder");
  }
  return merged;
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
      ...(job.notify === undefined ? {} : { notify: job.notify }),
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
  const notify = asOptionalString(entry.notify);
  return {
    id,
    enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
    expression,
    timezone: asOptionalString(entry.timezone) ?? DEFAULT_TIMEZONE,
    prompt,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(notify === undefined ? {} : { notify }),
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
    { env: "MONO_AGENT_CRON_NOTIFY", value: section.notify },
  ]);
}

/** Trim a JSON value to a non-empty string, treating non-strings as absent. */
function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
