import type {
  ChannelConfigInput,
  ChannelConfigViewField,
  ChannelConfigViewSection,
  ChannelDriver,
  JsonEnvFieldSpec,
  SettingsJson,
  SettingsJsonValue,
} from "@mono-agent/agent-contracts";
import {
  encodeJsonEnvValue,
  normalizeOptionalString,
  readJsonSection,
  readSettingsJson,
} from "@mono-agent/agent-contracts";

import {
  ADVISOR_CONFIG_FIELDS,
  type AdvisorConfig,
  loadAdvisorConfig,
} from "./config.js";
import { AdvisorError } from "./errors.js";
import { REVIEW_ITERATION_TOOL_NAME } from "./protocol.js";
import { createAdvisorRunFactoryFromResponder } from "./run.js";
import {
  type RunningAdvisorServer,
  type StartAdvisorServerOptions,
  startAdvisorServer,
} from "./server.js";

export type AdvisorChannelRawConfig = Readonly<Record<string, SettingsJsonValue>>;

export interface AdvisorChannelDriverOptions {
  readonly id?: string;
  readonly label?: string;
  readonly config?: AdvisorChannelRawConfig;
  readonly serverFactory?: (options: StartAdvisorServerOptions) => Promise<RunningAdvisorServer>;
}

const DEFAULT_CHANNEL_ID = "advisor";
const DEFAULT_CHANNEL_LABEL = "Advisor MCP";
const CONFIG_VIEW_PLACEHOLDER = "—";

export function createAdvisorChannelDriver(
  options: AdvisorChannelDriverOptions = {},
): ChannelDriver<AdvisorConfig> {
  const id = normalizeIdentity(options.id, DEFAULT_CHANNEL_ID, "id");
  const label = normalizeIdentity(options.label, DEFAULT_CHANNEL_LABEL, "label");
  return {
    id,
    label,
    async configView(input) {
      const section = await readAdvisorConfigViewSection(options, input);
      let status: ChannelConfigViewSection["status"] = "active";
      try {
        const config = await loadAdvisorChannelConfig(options, input);
        if (!config.enabled) status = "disabled";
      } catch (error) {
        if (!(error instanceof AdvisorError)) throw error;
      }
      return {
        id,
        label,
        status,
        fields: ADVISOR_CONFIG_FIELDS.map((field) => toChannelConfigViewField(field, section, input.env)),
      };
    },
    async loadConfig(input) {
      return await loadAdvisorChannelConfig(options, input);
    },
    isConfigError(error) {
      return error instanceof AdvisorError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "Advisor MCP is disabled.";
    },
    async start(input) {
      const serverFactory = options.serverFactory ?? startAdvisorServer;
      const server = await serverFactory({
        config: input.config,
        runFactory: createAdvisorRunFactoryFromResponder(input.responder),
        ...(input.logger === undefined ? {} : { logger: input.logger }),
        onFailure: input.onFailure,
      });
      return {
        summary: {
          url: server.url,
          host: server.host,
          port: server.port,
          path: server.path,
          tool: REVIEW_ITERATION_TOOL_NAME,
          model: input.config.model,
          effort: input.config.effort,
        },
        stop: () => server.stop(),
      };
    },
  };
}

export const createChannelDriver: typeof createAdvisorChannelDriver = createAdvisorChannelDriver;

async function loadAdvisorChannelConfig(
  options: AdvisorChannelDriverOptions,
  input: ChannelConfigInput,
): Promise<AdvisorConfig> {
  if (options.config !== undefined) {
    return await loadAdvisorConfig({
      env: input.env,
      json: { advisor: options.config } satisfies SettingsJson,
    });
  }
  return await loadAdvisorConfig({ env: input.env, jsonPath: input.configPath });
}

async function readAdvisorConfigViewSection(
  options: AdvisorChannelDriverOptions,
  input: ChannelConfigInput,
): Promise<Record<string, unknown>> {
  if (options.config !== undefined) {
    return options.config as Record<string, unknown>;
  }
  const { json } = await readSettingsJson(input.configPath);
  return readJsonSection(json, DEFAULT_CHANNEL_ID);
}

function toChannelConfigViewField(
  field: JsonEnvFieldSpec,
  section: Record<string, unknown>,
  env: Record<string, string | undefined>,
): ChannelConfigViewField {
  const envValue = normalizeOptionalString(env[field.env]);
  const jsonValue = encodeJsonEnvValue(field.fromJson(section), field.kind ?? "string");
  const resolved = envValue ?? jsonValue;
  return {
    id: field.id,
    label: labelForFieldId(field.id),
    value: field.secret === true
      ? (resolved === undefined ? "unset" : "set")
      : boundedDisplayValue(resolved),
    source: envValue !== undefined ? "env" : jsonValue !== undefined ? "json" : "default",
    ...(field.secret === true ? { redacted: true } : {}),
    envKey: field.env,
  };
}

function boundedDisplayValue(value: string | undefined): string {
  if (value === undefined) return CONFIG_VIEW_PLACEHOLDER;
  if (value.length <= 256) return value;
  return `${value.slice(0, 255)}…`;
}

function labelForFieldId(id: string): string {
  const words = id
    .split(".")
    .slice(1)
    .join(" ")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function normalizeIdentity(value: string | undefined, fallback: string, field: string): string {
  const normalized = normalizeOptionalString(value) ?? fallback;
  if (normalized.length > 128 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new AdvisorError("invalid_config", `Advisor channel ${field} is invalid.`);
  }
  return normalized;
}
