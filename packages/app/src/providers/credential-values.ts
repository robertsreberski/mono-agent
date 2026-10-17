import { isDeepStrictEqual } from "node:util";

import { MAX_PI_AUTH_STORE_BYTES } from "../pi-auth-store-inspection.js";
export const PI_API_KEY_PROVIDERS: Readonly<Record<string, string>> = {
  "opencode-go": "OPENCODE_API_KEY",
  openai: "OPENAI_API_KEY",
};
const MAX_API_KEY_CREDENTIAL_STRING_LENGTH = 65_536;

function isBoundedCredentialString(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= MAX_API_KEY_CREDENTIAL_STRING_LENGTH
    && !value.includes("\0");
}

export function hasUsablePiOAuthClientId(provider: string, value: { readonly clientId?: unknown }): boolean {
  return provider !== "openai" || isBoundedCredentialString(value.clientId);
}

export function isUsableStoredPiCredential(provider: string, value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isBoundedCredentialValue(value)) return false;
  if (value.type === "oauth") {
    return (isBoundedCredentialString(value.access) || isBoundedCredentialString(value.refresh))
      && (value.expires === undefined || (typeof value.expires === "number" && Number.isFinite(value.expires)))
      && hasUsablePiOAuthClientId(provider, value);
  }
  if (value.type !== "api_key") return false;
  if (Object.keys(value).some((key) => key !== "type" && key !== "key" && key !== "env")) return false;
  if (isBoundedCredentialString(value.key)) return true;
  if (value.env === undefined) return Object.keys(value).length === 1;
  if (!isRecord(value.env)) return false;
  const entries = Object.entries(value.env);
  return entries.length > 0 && entries.length <= 64 && entries.every(([key, entry]) =>
    /^[A-Z][A-Z0-9_]{0,127}$/u.test(key) && isBoundedCredentialString(entry));
}

export function isBoundedCredentialValue(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_PI_AUTH_STORE_BYTES;
  } catch {
    return false;
  }
}

export function assertOAuthCredential(value: unknown, provider: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Bundled Pi login did not produce credentials for ${provider}; the configured store was not changed.`);
  }
  const credential = value as Record<string, unknown>;
  const access = typeof credential.access === "string" ? credential.access.trim() : "";
  const refresh = typeof credential.refresh === "string" ? credential.refresh.trim() : "";
  if (credential.type !== "oauth" || (access.length === 0 && refresh.length === 0)
    || !isUsableStoredPiCredential(provider, credential)) {
    throw new Error(`Bundled Pi login produced invalid OAuth credentials for ${provider}; the configured store was not changed.`);
  }
}

export function assertUnchangedSiblingCredentials(
  original: Readonly<Record<string, unknown>>,
  staged: Readonly<Record<string, unknown>>,
  provider: string,
): void {
  for (const [name, credential] of Object.entries(original)) {
    if (name !== provider && !isDeepStrictEqual(staged[name], credential)) {
      throw new Error(`Bundled Pi login unexpectedly changed sibling provider ${name}; the configured store was not changed.`);
    }
  }
  for (const name of Object.keys(staged)) {
    if (name !== provider && !Object.hasOwn(original, name)) {
      throw new Error(`Bundled Pi login unexpectedly added sibling provider ${name}; the configured store was not changed.`);
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
