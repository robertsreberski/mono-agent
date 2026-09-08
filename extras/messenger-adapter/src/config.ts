import {
  fieldSpecMappings,
  layerJsonOntoEnv,
  normalizeOptionalString,
  readBoolean,
  readChoice,
  readCsv,
  readInteger,
  readJsonSection,
  readSettingsJson,
  readString,
} from "@mono-agent/agent-contracts";
import type { JsonEnvFieldSpec, SettingsJson } from "@mono-agent/agent-contracts";

export const MESSENGER_MESSAGING_TYPES = ["RESPONSE", "UPDATE", "MESSAGE_TAG"] as const;
export type MessengerMessagingType = (typeof MESSENGER_MESSAGING_TYPES)[number];

export const DEFAULT_MESSENGER_HOST = "127.0.0.1";
export const DEFAULT_MESSENGER_PORT = 8650;
export const DEFAULT_MESSENGER_WEBHOOK_PATH = "/messenger/webhook";
export const DEFAULT_MESSENGER_API_VERSION = "v21.0";

export interface MessengerAdapterConfig {
  readonly enabled: boolean;
  readonly pageAccessToken: string;
  readonly appSecret: string;
  readonly verifyToken: string;
  /** Page-scoped user ids (PSIDs) allowed to talk to the agent. */
  readonly allowedUserIds: readonly string[];
  readonly allowAllUsers: boolean;
  readonly host: string;
  readonly port: number;
  readonly webhookPath: string;
  readonly apiVersion: string;
  readonly allowNonLoopback: boolean;
  /**
   * `messaging_type` used for proactive (cron/webhook) deliveries. Ordinary
   * replies always use `RESPONSE`. Meta requires `MESSAGE_TAG` plus a policy
   * `tag` outside the 24-hour standard messaging window.
   */
  readonly proactiveMessagingType: MessengerMessagingType;
  readonly proactiveTag?: string;
}

export interface RedactedMessengerAdapterConfig {
  readonly enabled: boolean;
  readonly pageAccessToken: { readonly present: boolean; readonly redacted: true };
  readonly appSecret: { readonly present: boolean; readonly redacted: true };
  readonly verifyToken: { readonly present: boolean; readonly redacted: true };
  readonly allowedUserIds: { readonly count: number };
  readonly allowAllUsers: boolean;
  readonly host: string;
  readonly port: number;
  readonly webhookPath: string;
  readonly apiVersion: string;
  readonly allowNonLoopback: boolean;
  readonly proactiveMessagingType: MessengerMessagingType;
  readonly proactiveTag?: string;
}

export type MessengerAdapterConfigErrorCode =
  | "missing_required_config"
  | "invalid_config";

export interface MessengerAdapterConfigErrorDetails {
  readonly code?: MessengerAdapterConfigErrorCode;
  readonly env?: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

export class MessengerAdapterConfigError extends Error {
  readonly code: MessengerAdapterConfigErrorCode;
  readonly details: MessengerAdapterConfigErrorDetails;

  constructor(
    code: MessengerAdapterConfigErrorCode,
    message: string,
    details: MessengerAdapterConfigErrorDetails = {},
  ) {
    super(message);
    this.name = "MessengerAdapterConfigError";
    this.code = code;
    this.details = { ...details, code };
  }
}

export interface LoadMessengerAdapterConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
}

const invalidConfig = (message: string, details?: Record<string, unknown>): MessengerAdapterConfigError =>
  new MessengerAdapterConfigError("invalid_config", message, details);

const missingRequiredConfig = (message: string, details?: Record<string, unknown>): MessengerAdapterConfigError =>
  new MessengerAdapterConfigError("missing_required_config", message, details);

/**
 * Credentials the adapter accepts ONLY from the environment. They are never
 * layered from JSON, and a JSON section that carries one is rejected outright
 * rather than silently ignored — an operator who put a Page token in a
 * world-readable config file must be told, not quietly left unauthenticated.
 */
export const MESSENGER_ENV_ONLY_SECRET_KEYS = ["pageAccessToken", "appSecret", "verifyToken"] as const;

const ENV_KEY_BY_SECRET_JSON_KEY: Readonly<Record<(typeof MESSENGER_ENV_ONLY_SECRET_KEYS)[number], string>> = {
  pageAccessToken: "MONO_AGENT_MESSENGER_PAGE_ACCESS_TOKEN",
  appSecret: "MONO_AGENT_MESSENGER_APP_SECRET",
  verifyToken: "MONO_AGENT_MESSENGER_VERIFY_TOKEN",
};

/**
 * Reject any env-only credential supplied through inline or file JSON. Called
 * before layering so JSON can never satisfy a required secret.
 */
export function assertNoMessengerSecretsInJson(section: Record<string, unknown>): void {
  for (const key of MESSENGER_ENV_ONLY_SECRET_KEYS) {
    if (Object.prototype.hasOwnProperty.call(section, key) && section[key] !== undefined) {
      throw invalidConfig(
        `messenger.${key} cannot be set in JSON config; set ${ENV_KEY_BY_SECRET_JSON_KEY[key]} in the environment instead.`,
        { field: `messenger.${key}`, env: ENV_KEY_BY_SECRET_JSON_KEY[key], reason: "env_only_secret" },
      );
    }
  }
}

/**
 * The `messenger` section's field registry: the single source of truth for the
 * JSON→env layering and the app's config provenance view. The three credentials
 * read `undefined` from JSON by construction — see
 * {@link MESSENGER_ENV_ONLY_SECRET_KEYS}.
 */
export const MESSENGER_CONFIG_FIELDS: readonly JsonEnvFieldSpec[] = [
  { id: "messenger.enabled", env: "MONO_AGENT_MESSENGER_ENABLED", kind: "boolean", fromJson: (s) => s.enabled },
  { id: "messenger.pageAccessToken", env: "MONO_AGENT_MESSENGER_PAGE_ACCESS_TOKEN", secret: true, fromJson: () => undefined },
  { id: "messenger.appSecret", env: "MONO_AGENT_MESSENGER_APP_SECRET", secret: true, fromJson: () => undefined },
  { id: "messenger.verifyToken", env: "MONO_AGENT_MESSENGER_VERIFY_TOKEN", secret: true, fromJson: () => undefined },
  { id: "messenger.allowedUserIds", env: "MONO_AGENT_MESSENGER_ALLOWED_USER_IDS", kind: "csv", fromJson: (s) => s.allowedUserIds },
  { id: "messenger.allowAllUsers", env: "MONO_AGENT_MESSENGER_ALLOW_ALL_USERS", kind: "boolean", fromJson: (s) => s.allowAllUsers },
  { id: "messenger.host", env: "MONO_AGENT_MESSENGER_HOST", fromJson: (s) => s.host },
  { id: "messenger.port", env: "MONO_AGENT_MESSENGER_PORT", kind: "integer", fromJson: (s) => s.port },
  { id: "messenger.webhookPath", env: "MONO_AGENT_MESSENGER_WEBHOOK_PATH", fromJson: (s) => s.webhookPath },
  { id: "messenger.apiVersion", env: "MONO_AGENT_MESSENGER_API_VERSION", fromJson: (s) => s.apiVersion },
  { id: "messenger.allowNonLoopback", env: "MONO_AGENT_MESSENGER_ALLOW_NON_LOOPBACK", kind: "boolean", fromJson: (s) => s.allowNonLoopback },
  { id: "messenger.proactiveMessagingType", env: "MONO_AGENT_MESSENGER_PROACTIVE_MESSAGING_TYPE", fromJson: (s) => s.proactiveMessagingType },
  { id: "messenger.proactiveTag", env: "MONO_AGENT_MESSENGER_PROACTIVE_TAG", fromJson: (s) => s.proactiveTag },
];

export async function loadMessengerAdapterConfig(
  input: LoadMessengerAdapterConfigInput,
): Promise<MessengerAdapterConfig> {
  const json = input.json ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const section = readJsonSection(json, "messenger");
  assertNoMessengerSecretsInJson(section);
  const env = layerJsonOntoEnv(input.env, fieldSpecMappings(section, MESSENGER_CONFIG_FIELDS));

  const enabled = readBoolean(env.MONO_AGENT_MESSENGER_ENABLED, "MONO_AGENT_MESSENGER_ENABLED", false, invalidConfig);
  const pageAccessToken = normalizeOptionalString(env.MONO_AGENT_MESSENGER_PAGE_ACCESS_TOKEN) ?? "";
  const appSecret = normalizeOptionalString(env.MONO_AGENT_MESSENGER_APP_SECRET) ?? "";
  const verifyToken = normalizeOptionalString(env.MONO_AGENT_MESSENGER_VERIFY_TOKEN) ?? "";
  const allowedUserIds = readCsv(env.MONO_AGENT_MESSENGER_ALLOWED_USER_IDS);
  const allowAllUsers = readBoolean(env.MONO_AGENT_MESSENGER_ALLOW_ALL_USERS, "MONO_AGENT_MESSENGER_ALLOW_ALL_USERS", false, invalidConfig);
  const host = readString(env.MONO_AGENT_MESSENGER_HOST, DEFAULT_MESSENGER_HOST);
  const port = readInteger(env.MONO_AGENT_MESSENGER_PORT, "MONO_AGENT_MESSENGER_PORT", DEFAULT_MESSENGER_PORT, invalidConfig, { min: 1, max: 65_535 });
  const webhookPath = normalizeWebhookPath(readString(env.MONO_AGENT_MESSENGER_WEBHOOK_PATH, DEFAULT_MESSENGER_WEBHOOK_PATH));
  const apiVersion = normalizeApiVersion(readString(env.MONO_AGENT_MESSENGER_API_VERSION, DEFAULT_MESSENGER_API_VERSION));
  const allowNonLoopback = readBoolean(env.MONO_AGENT_MESSENGER_ALLOW_NON_LOOPBACK, "MONO_AGENT_MESSENGER_ALLOW_NON_LOOPBACK", false, invalidConfig);
  const proactiveMessagingType = readChoice(
    env.MONO_AGENT_MESSENGER_PROACTIVE_MESSAGING_TYPE,
    "MONO_AGENT_MESSENGER_PROACTIVE_MESSAGING_TYPE",
    MESSENGER_MESSAGING_TYPES,
    "RESPONSE",
    invalidConfig,
  );
  const proactiveTag = normalizeOptionalString(env.MONO_AGENT_MESSENGER_PROACTIVE_TAG);

  const config: MessengerAdapterConfig = {
    enabled,
    pageAccessToken,
    appSecret,
    verifyToken,
    allowedUserIds,
    allowAllUsers,
    host,
    port,
    webhookPath,
    apiVersion,
    allowNonLoopback,
    proactiveMessagingType,
    ...(proactiveTag === undefined ? {} : { proactiveTag }),
  };

  // A disabled channel never validates its secrets or allowlist: status reads it
  // as "disabled", not "waiting for config".
  if (!enabled) {
    return config;
  }
  assertValidMessengerAdapterConfig(config);
  return config;
}

/**
 * Validate a complete, enabled config. Split out of
 * {@link loadMessengerAdapterConfig} so every entry point that can reach a bind
 * — including a programmatically constructed config handed straight to
 * `startMessengerAdapter` — enforces the same rules. A disabled config is not
 * validated (nothing binds, nothing sends).
 */
export function assertValidMessengerAdapterConfig(config: MessengerAdapterConfig): void {
  if (!config.enabled) {
    return;
  }
  for (const [value, name] of [
    [config.pageAccessToken, "MONO_AGENT_MESSENGER_PAGE_ACCESS_TOKEN"],
    [config.appSecret, "MONO_AGENT_MESSENGER_APP_SECRET"],
    [config.verifyToken, "MONO_AGENT_MESSENGER_VERIFY_TOKEN"],
  ] as const) {
    if (value.length === 0) {
      throw missingRequiredConfig(`Messenger adapter requires ${name}.`, { env: name });
    }
  }
  if (!config.allowAllUsers && config.allowedUserIds.length === 0) {
    throw missingRequiredConfig(
      "Messenger adapter requires MONO_AGENT_MESSENGER_ALLOWED_USER_IDS or MONO_AGENT_MESSENGER_ALLOW_ALL_USERS=true.",
      { env: "MONO_AGENT_MESSENGER_ALLOWED_USER_IDS" },
    );
  }
  assertMessengerBindAllowed(config.host, config.allowNonLoopback);
  if (config.proactiveMessagingType === "MESSAGE_TAG" && config.proactiveTag === undefined) {
    throw invalidConfig(
      "Messenger adapter proactiveMessagingType MESSAGE_TAG requires MONO_AGENT_MESSENGER_PROACTIVE_TAG.",
      { env: "MONO_AGENT_MESSENGER_PROACTIVE_TAG" },
    );
  }
}

/**
 * The single non-loopback gate. Called during config load, again in
 * `startMessengerAdapter`, and once more immediately before `listen()`, so no
 * construction path can reach a public bind without the explicit opt-in.
 */
export function assertMessengerBindAllowed(host: string, allowNonLoopback: boolean): void {
  if (allowNonLoopback || isLoopbackHost(host)) {
    return;
  }
  throw invalidConfig(
    `Messenger adapter host ${host} is not loopback; set MONO_AGENT_MESSENGER_ALLOW_NON_LOOPBACK=true to bind it (put it behind a TLS reverse proxy or tunnel).`,
    { env: "MONO_AGENT_MESSENGER_HOST", reason: host },
  );
}

export function redactMessengerAdapterConfig(config: MessengerAdapterConfig): RedactedMessengerAdapterConfig {
  return {
    enabled: config.enabled,
    pageAccessToken: { present: config.pageAccessToken.length > 0, redacted: true },
    appSecret: { present: config.appSecret.length > 0, redacted: true },
    verifyToken: { present: config.verifyToken.length > 0, redacted: true },
    allowedUserIds: { count: config.allowedUserIds.length },
    allowAllUsers: config.allowAllUsers,
    host: config.host,
    port: config.port,
    webhookPath: config.webhookPath,
    apiVersion: config.apiVersion,
    allowNonLoopback: config.allowNonLoopback,
    proactiveMessagingType: config.proactiveMessagingType,
    ...(config.proactiveTag === undefined ? {} : { proactiveTag: config.proactiveTag }),
  };
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}

function normalizeWebhookPath(path: string): string {
  const trimmed = path.trim();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutTrailing = withSlash.length > 1 ? withSlash.replace(/\/+$/u, "") : withSlash;
  if (withoutTrailing === "/" || withoutTrailing.includes("?") || withoutTrailing.includes("#")) {
    throw invalidConfig("Messenger adapter webhookPath must be a non-root path without a query or fragment.", {
      env: "MONO_AGENT_MESSENGER_WEBHOOK_PATH",
      reason: path,
    });
  }
  return withoutTrailing;
}

function normalizeApiVersion(version: string): string {
  const trimmed = version.trim();
  const normalized = trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
  if (!/^v\d+(?:\.\d+)?$/u.test(normalized)) {
    throw invalidConfig("Messenger adapter apiVersion must look like v21.0.", {
      env: "MONO_AGENT_MESSENGER_API_VERSION",
      reason: version,
    });
  }
  return normalized;
}
