export const PROVIDER_AUTH_STATUS_SCHEMA = "mono-agent.provider-auth.v1" as const;
export const PROVIDER_AUTH_SESSION_SCHEMA = "mono-agent.provider-auth-session.v1" as const;

export const MAX_PROVIDER_AUTH_BODY_BYTES = 128 * 1024;
export const MAX_PROVIDER_AUTH_INPUT_BYTES = 65_536;
export const MAX_PROVIDER_AUTH_TEXT_INPUT_BYTES = 16 * 1024;
export const MAX_PROVIDER_AUTH_ITEMS = 64;
export const MAX_PROVIDER_AUTH_USAGES = 64;
export const MAX_PROVIDER_AUTH_METHODS = 8;
export const MAX_PROVIDER_AUTH_OPTIONS = 32;
export const MAX_PROVIDER_AUTH_STRING_BYTES = 4_096;

export type ProviderAuthState = "present" | "expired" | "missing" | "not_applicable";
export type ProviderAuthVerification = "not_verified" | "verified_by_live_request" | "not_applicable";
export type ProviderAuthType = "oauth" | "api_key";
export type ProviderAuthStrategy = "device_code" | "paste_back" | "provider_prompt" | "api_key_prompt";
export type ProviderAuthSessionState =
  | "pending"
  | "awaiting_input"
  | "awaiting_user"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ProviderAuthUsage {
  readonly kind: "primary" | "fallback" | "memory_llm" | "cron" | "webhook";
  readonly model: string;
  readonly label: string;
}

export interface ProviderAuthMethod {
  readonly authType: ProviderAuthType;
  readonly strategy: ProviderAuthStrategy;
  readonly label: string;
  readonly recommended: boolean;
}

export interface ProviderAuthProviderStatus {
  readonly providerId: string;
  readonly label: string;
  readonly usages: readonly ProviderAuthUsage[];
  readonly state: ProviderAuthState;
  readonly credentialType?: ProviderAuthType;
  readonly source?: "stored" | "environment" | "ambient" | "config";
  readonly expiresAt?: string;
  readonly verification: ProviderAuthVerification;
  readonly verifiedAt?: string;
  readonly methods: readonly ProviderAuthMethod[];
  readonly unavailableReason?: string;
  readonly lastFailure?: {
    readonly kind: "provider_auth" | "provider_unavailable";
    readonly message: string;
    readonly model: string;
    readonly observedAt: string;
  };
}

export interface ProviderAuthStatusSnapshot {
  readonly schema: typeof PROVIDER_AUTH_STATUS_SCHEMA;
  readonly generatedAt: string;
  readonly providers: readonly ProviderAuthProviderStatus[];
}

export interface ProviderAuthPrompt {
  readonly id: string;
  readonly type: "text" | "secret" | "select" | "manual_code";
  readonly message: string;
  readonly placeholder?: string;
  /** Only provider-declared optional text prompts may be submitted blank. */
  readonly allowEmpty?: boolean;
  readonly options?: readonly {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
  }[];
}

export interface ProviderAuthSessionSnapshot {
  readonly schema: typeof PROVIDER_AUTH_SESSION_SCHEMA;
  readonly id: string;
  readonly providerId: string;
  readonly authType: ProviderAuthType;
  readonly strategy: ProviderAuthStrategy;
  readonly state: ProviderAuthSessionState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly authUrl?: { readonly url: string; readonly instructions: string };
  readonly deviceCode?: {
    readonly verificationUri: string;
    readonly userCode: string;
    readonly expiresAt?: string;
  };
  readonly prompt?: ProviderAuthPrompt;
  readonly progress?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface ProviderAuthSessionStartInput {
  readonly providerId: string;
  readonly authType: ProviderAuthType;
  readonly strategy: ProviderAuthStrategy;
}

export interface ProviderAuthSessionInput {
  readonly promptId: string;
  /** Secret-bearing. Implementations must never return, log, or retain this value after consumption. */
  readonly value: string;
}

export interface ProviderAuthOperator {
  status(): Promise<ProviderAuthStatusSnapshot>;
  start(input: ProviderAuthSessionStartInput): Promise<ProviderAuthSessionSnapshot>;
  get(sessionId: string): Promise<ProviderAuthSessionSnapshot | undefined>;
  submit(sessionId: string, input: ProviderAuthSessionInput): Promise<ProviderAuthSessionSnapshot>;
  cancel(sessionId: string): Promise<void>;
  stop(): Promise<void>;
}

export type ProviderAuthErrorCode =
  | "provider_auth_invalid_request"
  | "provider_auth_not_found"
  | "provider_auth_conflict"
  | "provider_auth_too_large"
  | "provider_auth_upstream"
  | "provider_auth_unavailable";

export class ProviderAuthOperationError extends Error {
  readonly code: ProviderAuthErrorCode;
  readonly status: 400 | 404 | 409 | 413 | 502 | 503;

  constructor(code: ProviderAuthErrorCode, message: string, status: ProviderAuthOperationError["status"]) {
    super(message);
    this.name = "ProviderAuthOperationError";
    this.code = code;
    this.status = status;
  }
}

export function isTerminalProviderAuthSessionState(value: ProviderAuthSessionState): boolean {
  return value === "succeeded" || value === "failed" || value === "cancelled";
}

export function parseProviderAuthStatusSnapshot(value: unknown): ProviderAuthStatusSnapshot {
  const root = exactRecord(value, ["schema", "generatedAt", "providers"], "provider auth status");
  if (root.schema !== PROVIDER_AUTH_STATUS_SCHEMA || !isoDate(root.generatedAt)) invalid("provider auth status");
  const providers = boundedArray(root.providers, MAX_PROVIDER_AUTH_ITEMS, "provider auth providers")
    .map(parseProviderStatus);
  return { schema: PROVIDER_AUTH_STATUS_SCHEMA, generatedAt: root.generatedAt, providers };
}

export function parseProviderAuthSessionSnapshot(value: unknown): ProviderAuthSessionSnapshot {
  const root = exactRecord(value, [
    "schema", "id", "providerId", "authType", "strategy", "state", "createdAt", "updatedAt",
    "expiresAt", "authUrl", "deviceCode", "prompt", "progress", "error",
  ], "provider auth session", true);
  if (root.schema !== PROVIDER_AUTH_SESSION_SCHEMA
    || !boundedString(root.id)
    || !boundedString(root.providerId)
    || !authType(root.authType)
    || !strategy(root.strategy)
    || !sessionState(root.state)
    || !isoDate(root.createdAt)
    || !isoDate(root.updatedAt)
    || !isoDate(root.expiresAt)) invalid("provider auth session");
  return {
    schema: PROVIDER_AUTH_SESSION_SCHEMA,
    id: root.id,
    providerId: root.providerId,
    authType: root.authType,
    strategy: root.strategy,
    state: root.state,
    createdAt: root.createdAt,
    updatedAt: root.updatedAt,
    expiresAt: root.expiresAt,
    ...(root.authUrl === undefined ? {} : { authUrl: parseAuthUrl(root.authUrl) }),
    ...(root.deviceCode === undefined ? {} : { deviceCode: parseDeviceCode(root.deviceCode) }),
    ...(root.prompt === undefined ? {} : { prompt: parsePrompt(root.prompt) }),
    ...(root.progress === undefined ? {} : { progress: requiredString(root.progress, "progress") }),
    ...(root.error === undefined ? {} : { error: parseError(root.error) }),
  };
}

export function parseProviderAuthSessionStartInput(value: unknown): ProviderAuthSessionStartInput {
  const root = exactRecord(value, ["providerId", "authType", "strategy"], "provider auth start");
  if (!boundedString(root.providerId) || !authType(root.authType) || !strategy(root.strategy)) {
    invalid("provider auth start");
  }
  return { providerId: root.providerId, authType: root.authType, strategy: root.strategy };
}

export function parseProviderAuthSessionInput(value: unknown): ProviderAuthSessionInput {
  const root = exactRecord(value, ["promptId", "value"], "provider auth input");
  if (!boundedString(root.promptId) || typeof root.value !== "string") invalid("provider auth input");
  const bytes = Buffer.byteLength(root.value, "utf8");
  if (bytes > MAX_PROVIDER_AUTH_INPUT_BYTES || root.value.includes("\0")) {
    throw new ProviderAuthOperationError("provider_auth_too_large", "Provider authentication input is invalid or too large.", 413);
  }
  return { promptId: root.promptId, value: root.value };
}

function parseProviderStatus(value: unknown): ProviderAuthProviderStatus {
  const root = exactRecord(value, [
    "providerId", "label", "usages", "state", "credentialType", "source", "expiresAt",
    "verification", "verifiedAt", "methods", "unavailableReason", "lastFailure",
  ], "provider auth provider", true);
  if (!boundedString(root.providerId) || !boundedString(root.label)
    || !state(root.state) || !verification(root.verification)) invalid("provider auth provider");
  const usages = boundedArray(root.usages, MAX_PROVIDER_AUTH_USAGES, "provider auth usages").map(parseUsage);
  const methods = boundedArray(root.methods, MAX_PROVIDER_AUTH_METHODS, "provider auth methods").map(parseMethod);
  if (root.credentialType !== undefined && !authType(root.credentialType)) invalid("provider auth credential type");
  if (root.source !== undefined && !["stored", "environment", "ambient", "config"].includes(String(root.source))) invalid("provider auth source");
  if (root.expiresAt !== undefined && !isoDate(root.expiresAt)) invalid("provider auth expiry");
  if (root.verifiedAt !== undefined && !isoDate(root.verifiedAt)) invalid("provider auth verification time");
  return {
    providerId: root.providerId,
    label: root.label,
    usages,
    state: root.state,
    ...(root.credentialType === undefined ? {} : { credentialType: root.credentialType }),
    ...(root.source === undefined ? {} : {
      source: root.source as Exclude<ProviderAuthProviderStatus["source"], undefined>,
    }),
    ...(root.expiresAt === undefined ? {} : { expiresAt: root.expiresAt }),
    verification: root.verification,
    ...(root.verifiedAt === undefined ? {} : { verifiedAt: root.verifiedAt }),
    methods,
    ...(root.unavailableReason === undefined ? {} : { unavailableReason: requiredString(root.unavailableReason, "unavailable reason") }),
    ...(root.lastFailure === undefined ? {} : { lastFailure: parseFailure(root.lastFailure) }),
  };
}

function parseUsage(value: unknown): ProviderAuthUsage {
  const root = exactRecord(value, ["kind", "model", "label"], "provider auth usage");
  if (!["primary", "fallback", "memory_llm", "cron", "webhook"].includes(String(root.kind))
    || !boundedString(root.model) || !boundedString(root.label)) invalid("provider auth usage");
  return root as unknown as ProviderAuthUsage;
}

function parseMethod(value: unknown): ProviderAuthMethod {
  const root = exactRecord(value, ["authType", "strategy", "label", "recommended"], "provider auth method");
  if (!authType(root.authType) || !strategy(root.strategy) || !boundedString(root.label)
    || typeof root.recommended !== "boolean") invalid("provider auth method");
  return root as unknown as ProviderAuthMethod;
}

function parseAuthUrl(value: unknown): NonNullable<ProviderAuthSessionSnapshot["authUrl"]> {
  const root = exactRecord(value, ["url", "instructions"], "provider auth URL");
  if (!httpUrl(root.url) || !boundedString(root.instructions)) invalid("provider auth URL");
  return { url: root.url, instructions: root.instructions };
}

function parseDeviceCode(value: unknown): NonNullable<ProviderAuthSessionSnapshot["deviceCode"]> {
  const root = exactRecord(value, ["verificationUri", "userCode", "expiresAt"], "provider device code", true);
  if (!httpUrl(root.verificationUri) || !boundedString(root.userCode)
    || (root.expiresAt !== undefined && !isoDate(root.expiresAt))) invalid("provider device code");
  return {
    verificationUri: root.verificationUri,
    userCode: root.userCode,
    ...(root.expiresAt === undefined ? {} : { expiresAt: root.expiresAt }),
  };
}

function parsePrompt(value: unknown): ProviderAuthPrompt {
  const root = exactRecord(value, ["id", "type", "message", "placeholder", "allowEmpty", "options"], "provider auth prompt", true);
  if (!boundedString(root.id) || !["text", "secret", "select", "manual_code"].includes(String(root.type))
    || !boundedString(root.message)) invalid("provider auth prompt");
  if (root.placeholder !== undefined && !boundedString(root.placeholder)) invalid("provider auth prompt");
  if (root.allowEmpty !== undefined && typeof root.allowEmpty !== "boolean") invalid("provider auth prompt");
  const options = root.options === undefined ? undefined : boundedArray(root.options, MAX_PROVIDER_AUTH_OPTIONS, "provider auth options")
    .map((option) => {
      const item = exactRecord(option, ["id", "label", "description"], "provider auth option", true);
      if (!boundedString(item.id) || !boundedString(item.label)
        || (item.description !== undefined && !boundedString(item.description))) invalid("provider auth option");
      return {
        id: item.id,
        label: item.label,
        ...(item.description === undefined ? {} : { description: item.description }),
      };
    });
  if (root.type === "select" && (options === undefined || options.length === 0)) invalid("provider auth select prompt");
  if (root.type !== "select" && options !== undefined) invalid("provider auth prompt options");
  return {
    id: root.id,
    type: root.type as ProviderAuthPrompt["type"],
    message: root.message,
    ...(root.placeholder === undefined ? {} : { placeholder: root.placeholder }),
    ...(root.allowEmpty === undefined ? {} : { allowEmpty: root.allowEmpty }),
    ...(options === undefined ? {} : { options }),
  };
}

function parseError(value: unknown): NonNullable<ProviderAuthSessionSnapshot["error"]> {
  const root = exactRecord(value, ["code", "message"], "provider auth error");
  if (!boundedString(root.code) || !boundedString(root.message)) invalid("provider auth error");
  return { code: root.code, message: root.message };
}

function parseFailure(value: unknown): NonNullable<ProviderAuthProviderStatus["lastFailure"]> {
  const root = exactRecord(value, ["kind", "message", "model", "observedAt"], "provider auth failure");
  if ((root.kind !== "provider_auth" && root.kind !== "provider_unavailable")
    || !boundedString(root.message) || !boundedString(root.model) || !isoDate(root.observedAt)) invalid("provider auth failure");
  return root as unknown as NonNullable<ProviderAuthProviderStatus["lastFailure"]>;
}

function exactRecord(value: unknown, keys: readonly string[], label: string, optional = false): Record<string, unknown> {
  if (!record(value)) invalid(label);
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid(label);
  if (!optional && keys.some((key) => !Object.hasOwn(value, key))) invalid(label);
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function boundedArray(value: unknown, max: number, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(label);
  return value;
}

function boundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_PROVIDER_AUTH_STRING_BYTES;
}

function requiredString(value: unknown, label: string): string {
  if (!boundedString(value)) invalid(label);
  return value;
}

function isoDate(value: unknown): value is string {
  if (!boundedString(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function httpUrl(value: unknown): value is string {
  if (!boundedString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function authType(value: unknown): value is ProviderAuthType {
  return value === "oauth" || value === "api_key";
}

function strategy(value: unknown): value is ProviderAuthStrategy {
  return value === "device_code" || value === "paste_back"
    || value === "provider_prompt" || value === "api_key_prompt";
}

function state(value: unknown): value is ProviderAuthState {
  return value === "present" || value === "expired" || value === "missing" || value === "not_applicable";
}

function verification(value: unknown): value is ProviderAuthVerification {
  return value === "not_verified" || value === "verified_by_live_request" || value === "not_applicable";
}

function sessionState(value: unknown): value is ProviderAuthSessionState {
  return value === "pending" || value === "awaiting_input" || value === "awaiting_user"
    || value === "succeeded" || value === "failed" || value === "cancelled";
}

function invalid(label: string): never {
  throw new ProviderAuthOperationError("provider_auth_invalid_request", `Invalid ${label}.`, 400);
}
