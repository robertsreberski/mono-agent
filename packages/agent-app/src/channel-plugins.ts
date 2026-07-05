import { readSettingsJson } from "@mono-agent/agent-contracts";
import type { ChannelConfigViewSection, SettingsJson, SettingsJsonValue } from "@mono-agent/agent-contracts";

import type { MonoAgentAppConfigInput } from "./app-config.js";
import { isChannelConfigured } from "./channel-gate.js";
import type { ChannelGateSpec } from "./channel-gate.js";
import type { ChannelDriver } from "./channels.js";

export type ChannelPluginConfigErrorCode =
  | "invalid_plugin_config"
  | "plugin_import_failed"
  | "malformed_plugin_export";

export interface ChannelPluginConfigErrorDetails {
  readonly code?: ChannelPluginConfigErrorCode;
  readonly packageName?: string;
  readonly pluginId?: string;
  readonly reason?: string;
}

export class ChannelPluginConfigError extends Error {
  readonly code: ChannelPluginConfigErrorCode;
  readonly details: ChannelPluginConfigErrorDetails;

  constructor(
    code: ChannelPluginConfigErrorCode,
    message: string,
    details: ChannelPluginConfigErrorDetails = {},
  ) {
    super(message);
    this.name = "ChannelPluginConfigError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export interface ChannelPluginEntry {
  readonly packageName: string;
  readonly id?: string;
  readonly label?: string;
  readonly config?: RawPluginConfig;
}

type RawPluginConfig = Readonly<Record<string, SettingsJsonValue>>;

interface InvalidChannelPluginEntry {
  readonly id: string;
  readonly label: string;
  readonly packageName?: string;
  readonly message: string;
}

type ParsedChannelPluginEntry = ChannelPluginEntry | InvalidChannelPluginEntry;

interface ChannelPluginFactoryInput {
  readonly id?: string;
  readonly label?: string;
  readonly config?: RawPluginConfig;
  readonly [key: string]: unknown;
}

type ChannelPluginFactory = (input?: ChannelPluginFactoryInput) => unknown | Promise<unknown>;

interface ExternalPackageChannelDriverOptions {
  readonly packageName: string;
  readonly id: string;
  readonly label: string;
  readonly gate: ChannelGateSpec;
  readonly unconfiguredConfig: unknown;
  readonly unconfiguredDisabledReason: string;
  readonly factoryOptions?: Record<string, unknown>;
}

export async function resolveConfiguredChannelPlugins(
  input: MonoAgentAppConfigInput,
): Promise<readonly ChannelDriver[]> {
  const entries = await readConfiguredChannelPluginEntries(input.configPath);
  const drivers: ChannelDriver[] = [];
  for (const entry of entries) {
    drivers.push(await resolveChannelPlugin(entry));
  }
  return drivers;
}

export function createExternalPackageChannelDriver(
  options: ExternalPackageChannelDriverOptions,
): ChannelDriver {
  let driver: ChannelDriver | undefined;
  let loading: Promise<ChannelDriver> | undefined;

  const loadDriver = async (): Promise<ChannelDriver> => {
    loading ??= loadChannelPluginDriver({
      packageName: options.packageName,
      id: options.id,
      label: options.label,
      ...(options.factoryOptions === undefined ? {} : { factoryOptions: options.factoryOptions }),
    });
    try {
      driver = await loading;
      return driver;
    } catch (error) {
      loading = undefined;
      throw error;
    }
  };

  return {
    id: options.id,
    label: options.label,
    async configView(input) {
      if (!(await isChannelConfigured(input, options.gate))) {
        return { id: options.id, label: options.label, status: "disabled", fields: [] };
      }
      const resolved = await loadDriver();
      return await fallbackConfigView(resolved, input);
    },
    async loadConfig(input) {
      if (!(await isChannelConfigured(input, options.gate))) {
        return options.unconfiguredConfig;
      }
      return await (await loadDriver()).loadConfig(input);
    },
    isConfigError(error) {
      return error instanceof ChannelPluginConfigError || driver?.isConfigError(error) === true;
    },
    disabledReason(config) {
      if (config === options.unconfiguredConfig) {
        return options.unconfiguredDisabledReason;
      }
      return driver?.disabledReason?.(config);
    },
    waitingReason(config) {
      return driver?.waitingReason?.(config);
    },
    configIssues(config) {
      return driver?.configIssues?.(config) ?? [];
    },
    async start(input) {
      return await (await loadDriver()).start(input);
    },
  };
}

async function readConfiguredChannelPluginEntries(
  configPath: string,
): Promise<readonly ParsedChannelPluginEntry[]> {
  let json: SettingsJson;
  try {
    json = (await readSettingsJson(configPath)).json;
  } catch {
    return [];
  }

  const channels = json.channels;
  if (channels === undefined) {
    return [];
  }
  if (!isSettingsRecord(channels)) {
    return [
      {
        id: "channel-plugin",
        label: "Channel plugin",
        message: "channels must be an object when channel plugins are configured.",
      },
    ];
  }
  const plugins = channels.plugins;
  if (plugins === undefined) {
    return [];
  }
  if (!Array.isArray(plugins)) {
    return [
      {
        id: "channel-plugin",
        label: "Channel plugin",
        message: "channels.plugins must be an array.",
      },
    ];
  }

  return plugins.map((entry, index) => parseChannelPluginEntry(entry, index));
}

function parseChannelPluginEntry(entry: SettingsJsonValue, index: number): ParsedChannelPluginEntry {
  const fallbackId = `channel-plugin-${index + 1}`;
  if (!isSettingsRecord(entry)) {
    return {
      id: fallbackId,
      label: "Channel plugin",
      message: `channels.plugins[${index}] must be an object.`,
    };
  }

  const explicitId = readOptionalNonEmptyString(entry.id);
  const explicitLabel = readOptionalNonEmptyString(entry.label);
  const packageName = readOptionalNonEmptyString(entry.package);
  const id = explicitId ?? (packageName === undefined ? fallbackId : channelIdFromPackageName(packageName));
  const label = explicitLabel ?? labelFromChannelId(id);

  if (packageName === undefined) {
    return {
      id,
      label,
      message: `channels.plugins[${index}].package must be a non-empty package name.`,
    };
  }

  let config: RawPluginConfig | undefined;
  if (entry.config !== undefined) {
    if (!isSettingsRecord(entry.config)) {
      return {
        id,
        label,
        packageName,
        message: `channels.plugins[${index}].config must be an object.`,
      };
    }
    config = entry.config;
  }

  return {
    packageName,
    ...(explicitId === undefined ? {} : { id: explicitId }),
    ...(explicitLabel === undefined ? {} : { label: explicitLabel }),
    ...(config === undefined ? {} : { config }),
  };
}

async function resolveChannelPlugin(entry: ParsedChannelPluginEntry): Promise<ChannelDriver> {
  if ("message" in entry) {
    return createUnavailablePluginDriver(entry.id, entry.label, entry.message, entry.packageName);
  }
  try {
    return await loadChannelPluginDriver(entry);
  } catch (error) {
    const id = entry.id ?? channelIdFromPackageName(entry.packageName);
    const label = entry.label ?? labelFromChannelId(id);
    const message = error instanceof ChannelPluginConfigError
      ? error.message
      : `Cannot load channel plugin ${entry.packageName}: ${reasonOf(error)}. Install the package or remove it from channels.plugins.`;
    const code = error instanceof ChannelPluginConfigError ? error.code : "plugin_import_failed";
    return createUnavailablePluginDriver(id, label, message, entry.packageName, code);
  }
}

async function loadChannelPluginDriver(input: ChannelPluginEntry & { readonly factoryOptions?: Record<string, unknown> }): Promise<ChannelDriver> {
  let mod: unknown;
  try {
    mod = await import(input.packageName);
  } catch (error) {
    throw new ChannelPluginConfigError(
      "plugin_import_failed",
      `Cannot load channel plugin ${input.packageName}: ${reasonOf(error)}. Install the package or remove it from channels.plugins.`,
      { packageName: input.packageName, ...(input.id === undefined ? {} : { pluginId: input.id }), reason: reasonOf(error) },
    );
  }

  const factory = channelDriverFactory(mod);
  if (factory === undefined) {
    throw malformedPluginExport(input.packageName, input.id);
  }

  let driver: unknown;
  try {
    driver = await factory({
      ...(input.factoryOptions ?? {}),
      ...(input.id === undefined ? {} : { id: input.id }),
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.config === undefined ? {} : { config: input.config }),
    });
  } catch (error) {
    throw new ChannelPluginConfigError(
      "malformed_plugin_export",
      `Channel plugin ${input.packageName} failed while creating its driver: ${reasonOf(error)}`,
      { packageName: input.packageName, ...(input.id === undefined ? {} : { pluginId: input.id }), reason: reasonOf(error) },
    );
  }

  if (!isChannelDriver(driver)) {
    throw malformedPluginExport(input.packageName, input.id);
  }
  return driver;
}

function channelDriverFactory(mod: unknown): ChannelPluginFactory | undefined {
  if (!isUnknownRecord(mod)) {
    return undefined;
  }
  const factory = mod.createChannelDriver ?? mod.default;
  return typeof factory === "function" ? (factory as ChannelPluginFactory) : undefined;
}

function createUnavailablePluginDriver(
  id: string,
  label: string,
  message: string,
  packageName?: string,
  code: ChannelPluginConfigErrorCode = packageName === undefined ? "invalid_plugin_config" : "plugin_import_failed",
): ChannelDriver {
  const error = new ChannelPluginConfigError(
    code,
    message,
    { ...(packageName === undefined ? {} : { packageName }), pluginId: id },
  );
  return {
    id,
    label,
    async configView() {
      return { id, label, status: "active", fields: [] };
    },
    async loadConfig() {
      throw error;
    },
    isConfigError(candidate) {
      return candidate instanceof ChannelPluginConfigError;
    },
    async start() {
      throw error;
    },
  };
}

async function fallbackConfigView(
  driver: ChannelDriver,
  input: MonoAgentAppConfigInput,
): Promise<ChannelConfigViewSection> {
  if (driver.configView !== undefined) {
    return await driver.configView(input);
  }
  let status: "active" | "disabled" = "active";
  try {
    const config = await driver.loadConfig(input);
    if (driver.disabledReason?.(config) !== undefined) {
      status = "disabled";
    }
  } catch (error) {
    if (!driver.isConfigError(error)) {
      throw error;
    }
  }
  return { id: driver.id, label: driver.label, status, fields: [] };
}

function malformedPluginExport(packageName: string, pluginId: string | undefined): ChannelPluginConfigError {
  return new ChannelPluginConfigError(
    "malformed_plugin_export",
    `Channel plugin ${packageName} must export createChannelDriver(options) returning a ChannelDriver.`,
    { packageName, ...(pluginId === undefined ? {} : { pluginId }) },
  );
}

function isChannelDriver(value: unknown): value is ChannelDriver {
  return (
    isUnknownRecord(value) &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    typeof value.label === "string" &&
    value.label.trim().length > 0 &&
    typeof value.loadConfig === "function" &&
    typeof value.isConfigError === "function" &&
    typeof value.start === "function"
  );
}

function isSettingsRecord(value: unknown): value is RawPluginConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalNonEmptyString(value: SettingsJsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function channelIdFromPackageName(packageName: string): string {
  const segment = packageName.split("/").pop() ?? packageName;
  return segment.endsWith("-adapter") ? segment.slice(0, -"-adapter".length) : segment;
}

function labelFromChannelId(id: string): string {
  return id
    .split(/[-_]+/u)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Channel plugin";
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
