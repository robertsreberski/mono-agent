import { isIP } from "node:net";

import {
  fieldSpecMappings,
  isLoopbackHost,
  layerJsonOntoEnv,
  normalizeOptionalString,
  readBoolean,
  readChoice,
  readCsv,
  readInteger,
  readJsonSection,
  readSettingsJson,
  readString,
  redactedSecret,
} from "@mono-agent/agent-contracts";
import type {
  JsonEnvFieldSpec,
  RedactedSecretValue,
  SettingsJson,
} from "@mono-agent/agent-contracts";

import { AdvisorError } from "./errors.js";

export const DEFAULT_ADVISOR_ALLOWED_HOSTS = Object.freeze([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

export const ADVISOR_EFFORT_LEVELS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const);

export type AdvisorEffort = (typeof ADVISOR_EFFORT_LEVELS)[number];

/** The hard HTTP request ceiling. Configuration may only lower this value. */
export const ADVISOR_MAX_REQUEST_BYTES = 4 * 1_024 * 1_024;

export interface AdvisorConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly allowNonLoopback: boolean;
  readonly requireBearer: boolean;
  readonly bearerToken?: string;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly model?: string;
  readonly effort?: AdvisorEffort;
  readonly maxRequestBytes: number;
  readonly maxPatchChars: number;
  readonly maxVerificationChars: number;
  readonly maxIntentChars: number;
  readonly maxOutputChars: number;
  readonly maxResponseBytes: number;
  readonly maxRunMs: number;
  readonly maxConcurrentReviews: number;
  readonly maxSessions: number;
  readonly sessionTtlMs: number;
  readonly namespace: string;
  readonly operatorPrompt?: string;
}

export interface RedactedAdvisorConfig extends Omit<AdvisorConfig, "bearerToken"> {
  readonly bearerToken: RedactedSecretValue;
}

export interface LoadAdvisorConfigInput {
  readonly env: Record<string, string | undefined>;
  readonly json?: SettingsJson;
  readonly jsonPath?: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4_312;
const DEFAULT_PATH = "/mcp";
const DEFAULT_MAX_REQUEST_BYTES = ADVISOR_MAX_REQUEST_BYTES;
const DEFAULT_MAX_PATCH_CHARS = 400_000;
const DEFAULT_MAX_VERIFICATION_CHARS = 120_000;
const DEFAULT_MAX_INTENT_CHARS = 4_000;
const DEFAULT_MAX_OUTPUT_CHARS = 64_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1_024;
const DEFAULT_MAX_RUN_MS = 900_000;
const DEFAULT_MAX_CONCURRENT_REVIEWS = 2;
const DEFAULT_MAX_SESSIONS = 64;
const DEFAULT_SESSION_TTL_MS = 21_600_000;
const DEFAULT_NAMESPACE = "default";

const invalidConfig = (
  message: string,
  details?: Record<string, unknown>,
): AdvisorError => new AdvisorError("invalid_config", message, details);

/**
 * Advisor config registry. The plugin owns this section, so it deliberately
 * does not participate in agent-app's built-in config-reference generator.
 */
export const ADVISOR_CONFIG_FIELDS: readonly JsonEnvFieldSpec[] = [
  { id: "advisor.enabled", env: "MONO_AGENT_ADVISOR_ENABLED", kind: "boolean", fromJson: (section) => section.enabled },
  { id: "advisor.host", env: "MONO_AGENT_ADVISOR_HOST", fromJson: (section) => section.host },
  { id: "advisor.port", env: "MONO_AGENT_ADVISOR_PORT", kind: "integer", fromJson: (section) => section.port },
  { id: "advisor.path", env: "MONO_AGENT_ADVISOR_PATH", fromJson: (section) => section.path },
  { id: "advisor.allowNonLoopback", env: "MONO_AGENT_ADVISOR_ALLOW_NON_LOOPBACK", kind: "boolean", fromJson: (section) => section.allowNonLoopback },
  { id: "advisor.requireBearer", env: "MONO_AGENT_ADVISOR_REQUIRE_BEARER", kind: "boolean", fromJson: (section) => section.requireBearer },
  { id: "advisor.bearerToken", env: "MONO_AGENT_ADVISOR_BEARER_TOKEN", secret: true, fromJson: (section) => section.bearerToken },
  { id: "advisor.allowedHosts", env: "MONO_AGENT_ADVISOR_ALLOWED_HOSTS", kind: "csv", fromJson: (section) => section.allowedHosts },
  { id: "advisor.allowedOrigins", env: "MONO_AGENT_ADVISOR_ALLOWED_ORIGINS", kind: "csv", fromJson: (section) => section.allowedOrigins },
  { id: "advisor.model", env: "MONO_AGENT_ADVISOR_MODEL", fromJson: (section) => section.model },
  { id: "advisor.effort", env: "MONO_AGENT_ADVISOR_EFFORT", fromJson: (section) => section.effort },
  { id: "advisor.maxRequestBytes", env: "MONO_AGENT_ADVISOR_MAX_REQUEST_BYTES", kind: "integer", fromJson: (section) => section.maxRequestBytes },
  { id: "advisor.maxPatchChars", env: "MONO_AGENT_ADVISOR_MAX_PATCH_CHARS", kind: "integer", fromJson: (section) => section.maxPatchChars },
  { id: "advisor.maxVerificationChars", env: "MONO_AGENT_ADVISOR_MAX_VERIFICATION_CHARS", kind: "integer", fromJson: (section) => section.maxVerificationChars },
  { id: "advisor.maxIntentChars", env: "MONO_AGENT_ADVISOR_MAX_INTENT_CHARS", kind: "integer", fromJson: (section) => section.maxIntentChars },
  { id: "advisor.maxOutputChars", env: "MONO_AGENT_ADVISOR_MAX_OUTPUT_CHARS", kind: "integer", fromJson: (section) => section.maxOutputChars },
  { id: "advisor.maxResponseBytes", env: "MONO_AGENT_ADVISOR_MAX_RESPONSE_BYTES", kind: "integer", fromJson: (section) => section.maxResponseBytes },
  { id: "advisor.maxRunMs", env: "MONO_AGENT_ADVISOR_MAX_RUN_MS", kind: "integer", fromJson: (section) => section.maxRunMs },
  { id: "advisor.maxConcurrentReviews", env: "MONO_AGENT_ADVISOR_MAX_CONCURRENT_REVIEWS", kind: "integer", fromJson: (section) => section.maxConcurrentReviews },
  { id: "advisor.maxSessions", env: "MONO_AGENT_ADVISOR_MAX_SESSIONS", kind: "integer", fromJson: (section) => section.maxSessions },
  { id: "advisor.sessionTtlMs", env: "MONO_AGENT_ADVISOR_SESSION_TTL_MS", kind: "integer", fromJson: (section) => section.sessionTtlMs },
  { id: "advisor.namespace", env: "MONO_AGENT_ADVISOR_NAMESPACE", fromJson: (section) => section.namespace },
  { id: "advisor.operatorPrompt", env: "MONO_AGENT_ADVISOR_OPERATOR_PROMPT", fromJson: (section) => section.operatorPrompt },
];

export async function loadAdvisorConfig(
  input: LoadAdvisorConfigInput,
): Promise<AdvisorConfig> {
  const json = input.json
    ?? (input.jsonPath === undefined ? {} : (await readSettingsJson(input.jsonPath)).json);
  const section = readJsonSection(json, "advisor");
  validateAdvisorJsonSection(section);
  const env = layerJsonOntoEnv(
    input.env,
    fieldSpecMappings(section, ADVISOR_CONFIG_FIELDS),
  );
  const enabled = readBoolean(
    env.MONO_AGENT_ADVISOR_ENABLED,
    "MONO_AGENT_ADVISOR_ENABLED",
    false,
    invalidConfig,
  );
  const host = readString(env.MONO_AGENT_ADVISOR_HOST, DEFAULT_HOST);
  const bearerToken = normalizeOptionalString(env.MONO_AGENT_ADVISOR_BEARER_TOKEN);
  const allowedHostsExplicit = env.MONO_AGENT_ADVISOR_ALLOWED_HOSTS !== undefined;
  const allowedHosts = allowedHostsExplicit
    ? readCsv(env.MONO_AGENT_ADVISOR_ALLOWED_HOSTS)
    : isLoopbackHost(host)
      ? [...new Set([...DEFAULT_ADVISOR_ALLOWED_HOSTS, hostHeaderName(host)])]
      : [...DEFAULT_ADVISOR_ALLOWED_HOSTS];
  const allowedOrigins = readCsv(env.MONO_AGENT_ADVISOR_ALLOWED_ORIGINS);
  const model = normalizeOptionalString(env.MONO_AGENT_ADVISOR_MODEL);
  const rawEffort = normalizeOptionalString(env.MONO_AGENT_ADVISOR_EFFORT);
  const operatorPrompt = normalizeOptionalString(env.MONO_AGENT_ADVISOR_OPERATOR_PROMPT);

  const config: AdvisorConfig = {
    enabled,
    host,
    port: readInteger(env.MONO_AGENT_ADVISOR_PORT, "MONO_AGENT_ADVISOR_PORT", DEFAULT_PORT, invalidConfig, { min: 0, max: 65_535 }),
    path: readString(env.MONO_AGENT_ADVISOR_PATH, DEFAULT_PATH),
    allowNonLoopback: readBoolean(env.MONO_AGENT_ADVISOR_ALLOW_NON_LOOPBACK, "MONO_AGENT_ADVISOR_ALLOW_NON_LOOPBACK", false, invalidConfig),
    requireBearer: readBoolean(env.MONO_AGENT_ADVISOR_REQUIRE_BEARER, "MONO_AGENT_ADVISOR_REQUIRE_BEARER", false, invalidConfig),
    ...(bearerToken === undefined ? {} : { bearerToken }),
    allowedHosts,
    allowedOrigins,
    ...(model === undefined ? {} : { model }),
    ...(rawEffort === undefined
      ? {}
      : {
          effort: readChoice(
            rawEffort,
            "MONO_AGENT_ADVISOR_EFFORT",
            ADVISOR_EFFORT_LEVELS,
            "none",
            invalidConfig,
          ),
        }),
    maxRequestBytes: readInteger(env.MONO_AGENT_ADVISOR_MAX_REQUEST_BYTES, "MONO_AGENT_ADVISOR_MAX_REQUEST_BYTES", DEFAULT_MAX_REQUEST_BYTES, invalidConfig, { min: 1_024, max: ADVISOR_MAX_REQUEST_BYTES }),
    maxPatchChars: readInteger(env.MONO_AGENT_ADVISOR_MAX_PATCH_CHARS, "MONO_AGENT_ADVISOR_MAX_PATCH_CHARS", DEFAULT_MAX_PATCH_CHARS, invalidConfig, { min: 1, max: 25_000_000 }),
    maxVerificationChars: readInteger(env.MONO_AGENT_ADVISOR_MAX_VERIFICATION_CHARS, "MONO_AGENT_ADVISOR_MAX_VERIFICATION_CHARS", DEFAULT_MAX_VERIFICATION_CHARS, invalidConfig, { min: 1, max: 25_000_000 }),
    maxIntentChars: readInteger(env.MONO_AGENT_ADVISOR_MAX_INTENT_CHARS, "MONO_AGENT_ADVISOR_MAX_INTENT_CHARS", DEFAULT_MAX_INTENT_CHARS, invalidConfig, { min: 1, max: 100_000 }),
    maxOutputChars: readInteger(env.MONO_AGENT_ADVISOR_MAX_OUTPUT_CHARS, "MONO_AGENT_ADVISOR_MAX_OUTPUT_CHARS", DEFAULT_MAX_OUTPUT_CHARS, invalidConfig, { min: 1_024, max: 250_000 }),
    maxResponseBytes: readInteger(env.MONO_AGENT_ADVISOR_MAX_RESPONSE_BYTES, "MONO_AGENT_ADVISOR_MAX_RESPONSE_BYTES", DEFAULT_MAX_RESPONSE_BYTES, invalidConfig, { min: 16_384, max: 1_048_576 }),
    maxRunMs: readInteger(env.MONO_AGENT_ADVISOR_MAX_RUN_MS, "MONO_AGENT_ADVISOR_MAX_RUN_MS", DEFAULT_MAX_RUN_MS, invalidConfig, { min: 0, max: 86_400_000 }),
    maxConcurrentReviews: readInteger(env.MONO_AGENT_ADVISOR_MAX_CONCURRENT_REVIEWS, "MONO_AGENT_ADVISOR_MAX_CONCURRENT_REVIEWS", DEFAULT_MAX_CONCURRENT_REVIEWS, invalidConfig, { min: 1, max: 64 }),
    maxSessions: readInteger(env.MONO_AGENT_ADVISOR_MAX_SESSIONS, "MONO_AGENT_ADVISOR_MAX_SESSIONS", DEFAULT_MAX_SESSIONS, invalidConfig, { min: 1, max: 10_000 }),
    sessionTtlMs: readInteger(env.MONO_AGENT_ADVISOR_SESSION_TTL_MS, "MONO_AGENT_ADVISOR_SESSION_TTL_MS", DEFAULT_SESSION_TTL_MS, invalidConfig, { min: 60_000, max: 86_400_000 }),
    namespace: readString(env.MONO_AGENT_ADVISOR_NAMESPACE, DEFAULT_NAMESPACE),
    ...(operatorPrompt === undefined ? {} : { operatorPrompt }),
  };

  validatePath(config.path);
  validateAllowedHosts(config.allowedHosts);
  validateAllowedOrigins(config.allowedOrigins);
  validateNamespace(config.namespace);
  validateBoundedConfigStrings(config);
  if (enabled) {
    validateSafeBind(config, allowedHostsExplicit);
    validateExecutionSelection(config);
  }
  return config;
}

export function redactAdvisorConfig(config: AdvisorConfig): RedactedAdvisorConfig {
  const { bearerToken, ...safe } = config;
  return {
    ...safe,
    bearerToken: redactedSecret(bearerToken),
  };
}

function validateSafeBind(config: AdvisorConfig, allowedHostsExplicit: boolean): void {
  if (isLoopbackHost(config.host)) {
    if (config.requireBearer && config.bearerToken === undefined) {
      throw new AdvisorError(
        "missing_required_config",
        "MONO_AGENT_ADVISOR_BEARER_TOKEN is required when MONO_AGENT_ADVISOR_REQUIRE_BEARER=true.",
        { env: "MONO_AGENT_ADVISOR_BEARER_TOKEN" },
      );
    }
    return;
  }
  if (!config.allowNonLoopback) {
    throw new AdvisorError(
      "unsafe_host",
      "Advisor MCP refuses a non-loopback host unless MONO_AGENT_ADVISOR_ALLOW_NON_LOOPBACK=true.",
      { host: config.host },
    );
  }
  if (config.bearerToken === undefined) {
    throw new AdvisorError(
      "missing_required_config",
      "Advisor MCP requires MONO_AGENT_ADVISOR_BEARER_TOKEN for every non-loopback bind.",
      { env: "MONO_AGENT_ADVISOR_BEARER_TOKEN" },
    );
  }
  if (!allowedHostsExplicit || config.allowedHosts.length === 0) {
    throw new AdvisorError(
      "missing_required_config",
      "Advisor MCP requires an explicit non-empty MONO_AGENT_ADVISOR_ALLOWED_HOSTS list for every non-loopback bind.",
      { env: "MONO_AGENT_ADVISOR_ALLOWED_HOSTS" },
    );
  }
}

function validatePath(path: string): void {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#") || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw invalidConfig(
      "MONO_AGENT_ADVISOR_PATH must be an absolute path without a query string, fragment, or control characters.",
      { env: "MONO_AGENT_ADVISOR_PATH" },
    );
  }
}

function validateAllowedHosts(hosts: readonly string[]): void {
  if (hosts.length > 64) {
    throw invalidConfig("MONO_AGENT_ADVISOR_ALLOWED_HOSTS may contain at most 64 entries.", {
      env: "MONO_AGENT_ADVISOR_ALLOWED_HOSTS",
    });
  }
  const invalid = hosts.find((host) => !isAllowedHostname(host));
  if (invalid !== undefined) {
    throw invalidConfig(
      "MONO_AGENT_ADVISOR_ALLOWED_HOSTS must contain host names or IP literals without schemes, paths, or control characters.",
      { env: "MONO_AGENT_ADVISOR_ALLOWED_HOSTS" },
    );
  }
  if (new Set(hosts.map((host) => host.toLowerCase())).size !== hosts.length) {
    throw invalidConfig(
      "MONO_AGENT_ADVISOR_ALLOWED_HOSTS must not contain duplicate entries.",
      { env: "MONO_AGENT_ADVISOR_ALLOWED_HOSTS" },
    );
  }
}

function isAllowedHostname(host: string): boolean {
  if (host.length === 0
    || host.length > 255
    || /[\u0000-\u0020\u007f/\\?#]/u.test(host)
    || host.includes("://")) {
    return false;
  }
  if (host.startsWith("[") || host.endsWith("]")) {
    return host.startsWith("[") && host.endsWith("]") && isIP(host.slice(1, -1)) === 6;
  }
  if (host.includes(":")) return false;
  if (isIP(host) === 4) return true;
  return host === "localhost"
    || (host.length <= 253
      && host.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label)));
}

function hostHeaderName(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host.toLowerCase();
}

function validateAllowedOrigins(origins: readonly string[]): void {
  if (origins.length > 64) {
    throw invalidConfig("MONO_AGENT_ADVISOR_ALLOWED_ORIGINS may contain at most 64 entries.", {
      env: "MONO_AGENT_ADVISOR_ALLOWED_ORIGINS",
    });
  }
  for (const origin of origins) {
    if (origin.length > 2_048) {
      throw invalidConfig(
        "MONO_AGENT_ADVISOR_ALLOWED_ORIGINS entries may contain at most 2048 characters.",
        { env: "MONO_AGENT_ADVISOR_ALLOWED_ORIGINS" },
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw invalidConfig(
        "MONO_AGENT_ADVISOR_ALLOWED_ORIGINS must contain absolute HTTP(S) origins.",
        { env: "MONO_AGENT_ADVISOR_ALLOWED_ORIGINS" },
      );
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.origin !== origin
      || parsed.username.length > 0
      || parsed.password.length > 0) {
      throw invalidConfig(
        "MONO_AGENT_ADVISOR_ALLOWED_ORIGINS must contain exact absolute HTTP(S) origins without credentials, paths, queries, or fragments.",
        { env: "MONO_AGENT_ADVISOR_ALLOWED_ORIGINS" },
      );
    }
  }
}

function validateNamespace(namespace: string): void {
  if (/^[\u0000-\u001f\u007f]*$/u.test(namespace)
    || /[\u0000-\u001f\u007f]/u.test(namespace)
    || Buffer.byteLength(namespace.normalize("NFKC"), "utf8") > 512) {
    throw invalidConfig(
      "MONO_AGENT_ADVISOR_NAMESPACE must contain visible text without control characters.",
      { env: "MONO_AGENT_ADVISOR_NAMESPACE" },
    );
  }
}

function validateBoundedConfigStrings(config: AdvisorConfig): void {
  assertBoundedConfigString(config.host, 255, "MONO_AGENT_ADVISOR_HOST");
  assertBoundedConfigString(config.path, 1_024, "MONO_AGENT_ADVISOR_PATH");
  assertBoundedConfigString(config.namespace, 128, "MONO_AGENT_ADVISOR_NAMESPACE");
  if (config.bearerToken !== undefined) {
    assertBoundedConfigString(config.bearerToken, 4_096, "MONO_AGENT_ADVISOR_BEARER_TOKEN");
  }
  if (config.model !== undefined) {
    assertBoundedConfigString(config.model, 512, "MONO_AGENT_ADVISOR_MODEL");
  }
  if (config.operatorPrompt !== undefined) {
    assertBoundedConfigString(config.operatorPrompt, 16_000, "MONO_AGENT_ADVISOR_OPERATOR_PROMPT");
  }
}

function assertBoundedConfigString(value: string, max: number, env: string): void {
  if (value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw invalidConfig(`${env} must contain at most ${max} characters and no unsafe control characters.`, {
      env,
    });
  }
}

function validateExecutionSelection(config: AdvisorConfig): void {
  if (config.model === undefined) {
    throw new AdvisorError(
      "missing_required_config",
      "MONO_AGENT_ADVISOR_MODEL is required when Advisor MCP is enabled.",
      { env: "MONO_AGENT_ADVISOR_MODEL" },
    );
  }
  if (config.effort === undefined) {
    throw new AdvisorError(
      "missing_required_config",
      "MONO_AGENT_ADVISOR_EFFORT is required when Advisor MCP is enabled.",
      { env: "MONO_AGENT_ADVISOR_EFFORT" },
    );
  }
}

function validateAdvisorJsonSection(section: Record<string, unknown>): void {
  const booleanFields = ["enabled", "allowNonLoopback", "requireBearer"];
  const integerFields = [
    "port",
    "maxRequestBytes",
    "maxPatchChars",
    "maxVerificationChars",
    "maxIntentChars",
    "maxOutputChars",
    "maxResponseBytes",
    "maxRunMs",
    "maxConcurrentReviews",
    "maxSessions",
    "sessionTtlMs",
  ];
  const stringFields = ["host", "path", "bearerToken", "namespace", "operatorPrompt", "model", "effort"];
  const knownFields = new Set([
    ...booleanFields,
    ...integerFields,
    ...stringFields,
    "allowedHosts",
    "allowedOrigins",
  ]);
  const unknownField = Object.keys(section).find((field) => !knownFields.has(field));
  if (unknownField !== undefined) {
    throw invalidConfig(`advisor.${unknownField} is not a recognized config field.`, {
      path: `advisor.${unknownField}`,
    });
  }
  for (const field of booleanFields) {
    validateJsonField(section, field, (value) => typeof value === "boolean", "a boolean");
  }
  for (const field of integerFields) {
    validateJsonField(section, field, (value) => typeof value === "number" && Number.isInteger(value), "an integer");
  }
  for (const field of stringFields) {
    validateJsonField(section, field, (value) => typeof value === "string", "a string");
  }
  for (const field of ["allowedHosts", "allowedOrigins"]) {
    validateJsonField(
      section,
      field,
      (value) => Array.isArray(value) && value.every((item) => typeof item === "string"),
      "an array of strings",
    );
  }
}

function validateJsonField(
  section: Record<string, unknown>,
  field: string,
  accepts: (value: unknown) => boolean,
  expected: string,
): void {
  if (!Object.prototype.hasOwnProperty.call(section, field)) return;
  if (!accepts(section[field])) {
    throw invalidConfig(`advisor.${field} must be ${expected}.`, {
      path: `advisor.${field}`,
    });
  }
}
