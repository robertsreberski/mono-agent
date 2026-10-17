import { parseMonoRuntimeModelReference } from "@mono-agent/turn/host/config";
import type { RuntimeModelReference } from "@mono-agent/turn/host/types";
import type { MonoAgentConfig } from "@mono-agent/config";
import { hasUsablePiOAuthClientId, piAuthRecoveryCommand } from "../provider-setup.js";
import { inspectPiAuthStore, type PiAuthStoreInspection, type PiAuthStoreUnsafeReason } from "../pi-auth-store-inspection.js";
import type { ValidationSection, ValidationStatus } from "../doctor-types.js";
import { configuredRuntimeRouteChecks } from "./runtime.js";
import { referenceOf, displayReferenceOf, displayText } from "./format.js";

interface PiAuthEntry {
  readonly type?: string;
  readonly key?: string;
  readonly access?: string;
  readonly expires?: number;
  readonly refresh?: string;
  readonly clientId?: string;
}

const PI_API_KEY_ENV_BY_PROVIDER: Readonly<Record<string, string>> = {
  "opencode-go": "OPENCODE_API_KEY",
  openai: "OPENAI_API_KEY",
};

/** Inspects Pi credentials without following aliases or reading unbounded input. */
async function readPiAuthProviders(path: string): Promise<
  | { readonly status: "ok"; readonly providers: Readonly<Record<string, PiAuthEntry>> }
  | Exclude<PiAuthStoreInspection, { readonly status: "ok" }>
> {
  const inspection = await inspectPiAuthStore(path);
  if (inspection.status !== "ok") return inspection;
  return { status: "ok", providers: inspection.auth as Readonly<Record<string, PiAuthEntry>> };
}

/**
 * Checks that every referenced model (primary, fallbacks, and the agent-host memory LLM)
 * has discoverable credentials, so a keyless or expired-OAuth provider is caught at
 * `validate` time instead of degrading crons/memory silently at runtime (the failure mode
 * that broke memory capture for ~10 days when an auth-store OAuth token quietly expired.
 *
 * The read-only check inspects the auth store (`piAuthPath`) and the config's own
 *   `providers.local` custom providers. A custom/local provider follows its declared
 *   `apiKey` / `apiKeyEnv` contract instead of Pi OAuth; an OAuth provider absent from
 *   the store, or whose access token has expired, is flagged `waiting` with a re-auth hint.
 *
 * `waiting` (never `error`) keeps the verdict non-fatal, mirroring the Ollama
 * probes — the goal is visibility, not blocking start.
 */
export async function credentialsSection(
  config: MonoAgentConfig,
  env: Record<string, string | undefined>,
  verifiedCredentialModelRefs: readonly string[] = [],
  staticTriggerRefs: readonly { label: string; ref: RuntimeModelReference }[] = [],
): Promise<ValidationSection> {
  const refs: { label: string; ref: RuntimeModelReference }[] = [
    { label: "Primary", ref: config.runtime.model },
    ...configuredRuntimeRouteChecks(config).slice(1).map((route) => ({
      label: "Fallback",
      ref: route.model,
    })),
    ...staticTriggerRefs,
  ];
  if (config.memory?.llm?.provider === "agent-host") {
    try {
      refs.push({ label: "Memory LLM", ref: parseMonoRuntimeModelReference(config.memory.llm.model) });
    } catch {
      // A malformed memory model reference is surfaced by the memory/runtime shape checks.
    }
  }
  if (config.memory?.capture?.reconcileModel !== undefined) {
    try {
      refs.push({ label: "Capture reconcile model", ref: parseMonoRuntimeModelReference(config.memory.capture.reconcileModel) });
    } catch {
      // The capture model's shape is checked in the memory section.
    }
  }

  const authenticatedRefs = refs;
  if (authenticatedRefs.length === 0) {
    return {
      id: "credentials",
      label: "Provider credentials",
      status: "disabled",
      details: ["No provider-authenticated models referenced."],
    };
  }

  const details: string[] = [];
  let status: ValidationStatus = "ok";
  const verified = new Set(verifiedCredentialModelRefs);
  for (const { label, ref } of authenticatedRefs) {
    // The set holds whole canonical references, so the LOOKUP key stays whole;
    // only the printed form is bounded.
    if (verified.has(referenceOf(ref))) {
      details.push(`${label} ${displayReferenceOf(ref)}: credentials verified by a successful live model check.`);
    }
  }
  const unverifiedRefs = authenticatedRefs.filter(({ ref }) => !verified.has(referenceOf(ref)));
  if (unverifiedRefs.length > 0) {
    const piStatus = await appendPiCredentialDetails(config, unverifiedRefs, details, env);
    if (piStatus === "waiting") {
      status = "waiting";
    }
  }

  return { id: "credentials", label: "Provider credentials", status, details };
}

/**
 * Appends one detail line per Pi provider reference and returns "waiting" if any
 * was flagged (missing/expired), else "ok". Recognizes custom providers only
 * through the config's `providers.local` set, matching the runtime boundary.
 */
async function appendPiCredentialDetails(
  config: MonoAgentConfig,
  piRefs: readonly { label: string; ref: RuntimeModelReference }[],
  details: string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<ValidationStatus> {
  const authPath = config.providers?.piAuthPath;
  const needsStoredCredential = piRefs.some(({ ref }) => {
    const provider = ref.provider as string;
    const key = PI_API_KEY_ENV_BY_PROVIDER[provider];
    return provider === "openai" || key === undefined || !hasNonEmptyCredentialValue(env[key]);
  });
  const authInspection = authPath === undefined || !needsStoredCredential ? undefined : await readPiAuthProviders(authPath);
  const authProviders = authInspection?.status === "ok" ? authInspection.providers : undefined;
  // A matching `providers.local` entry owns the runtime route, even when its ID
  // collides with a Pi built-in provider. Report the local entry's declared auth
  // contract instead of consulting the unrelated Pi auth store. A disabled entry
  // remains authoritative because the runtime rejects it before credential use.
  const localProviders = new Map(
    (config.providers?.local ?? []).map((provider) => [provider.id, provider] as const),
  );
  const now = Date.now();
  let status: ValidationStatus = "ok";
  if (authPath !== undefined) {
    details.push(`Pi auth store: ${authPath}`);
  }

  for (const { label, ref } of piRefs) {
    const provider = ref.provider as string;
    // Display-only from here down: `provider` is still the lookup key into the
    // auth store and providers.local, `providerLabel` and `refStr` are what the
    // detail lines quote back at the operator.
    const providerLabel = displayText(provider);
    const refStr = displayReferenceOf(ref);
    const loginCommand = piAuthRecoveryCommand(providerLabel, authPath);
    const localProvider = localProviders.get(provider);
    if (localProvider !== undefined) {
      if (localProvider.enabled === false) {
        status = "waiting";
        details.push(
          `[WARN] ${label} ${refStr}: provider \`${providerLabel}\` is configured in providers.local but disabled (\`enabled: false\`); the runtime will throw \`provider disabled: ${providerLabel}\` on the first turn. Set \`enabled: true\` on that providers.local entry.`,
        );
      } else if (localProvider.apiKey !== undefined) {
        details.push(
          `${label} ${refStr}: provider \`${providerLabel}\` configured via config providers.local (API key configured); credential detected, live model verification is still pending.`,
        );
      } else if (localProvider.apiKeyEnv !== undefined) {
        if (hasNonEmptyCredentialValue(env[localProvider.apiKeyEnv])) {
          details.push(
            `${label} ${refStr}: provider \`${providerLabel}\` configured via config providers.local with ${localProvider.apiKeyEnv} present in the resolved environment; credential detected, live model verification is still pending.`,
          );
        } else {
          status = "waiting";
          details.push(
            `[WARN] ${label} ${refStr}: provider \`${providerLabel}\` declares apiKeyEnv \`${localProvider.apiKeyEnv}\`, but the resolved environment has no non-empty value and no inline apiKey fallback. Set ${localProvider.apiKeyEnv} before starting.`,
          );
        }
      } else {
        details.push(
          `${label} ${refStr}: provider \`${providerLabel}\` configured via config providers.local (keyless local provider; no API key declared).`,
        );
      }
      continue;
    }
    const apiKeyEnv = PI_API_KEY_ENV_BY_PROVIDER[provider];
    if (apiKeyEnv !== undefined && hasNonEmptyCredentialValue(env[apiKeyEnv])
      && (provider !== "openai" || authProviders?.[provider] === undefined)) {
      details.push(
        `${label} ${refStr}: Pi API-key credential for \`${providerLabel}\` present in the resolved environment (${apiKeyEnv}); credential detected, live model verification is still pending.`,
      );
      continue;
    }
    if (authInspection?.status === "unsafe") {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: Pi auth store was not trusted because ${describePiAuthStoreUnsafeReason(authInspection.reason)}. ` +
          `Move the unsafe entry aside if needed, then run \`${loginCommand}\` to create or atomically harden a current-user 0600 store. ` +
          "A current-user, non-writable legacy store can be replaced during this explicit repair, but is intentionally never trusted for credential detection. " +
          "No credential values or file contents were displayed.",
      );
      continue;
    }
    const entry = authProviders?.[provider];
    if (entry === undefined) {
      status = "waiting";
      details.push(apiKeyEnv === undefined
        ? `[WARN] ${label} ${refStr}: no Pi credentials found for provider \`${providerLabel}\` in the auth store. Authenticate it with \`${loginCommand}\`, or set providers.piAuthPath.`
        : `[WARN] ${label} ${refStr}: no Pi API key credentials found for provider \`${providerLabel}\` in the auth store or resolved environment. Run \`${loginCommand}\`, or set ${apiKeyEnv}.`);
      continue;
    }
    const isOAuth = entry.type === "oauth";
    const isApiKey = entry.type === "api_key";
    if (isApiKey && !hasNonEmptyCredentialValue(entry.key)) {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: stored API-key credential for \`${providerLabel}\` has no usable key. Run \`${loginCommand}\`; no secret value was displayed.`,
      );
      continue;
    }
    if (isOAuth && !hasNonEmptyCredentialValue(entry.access) && !hasNonEmptyCredentialValue(entry.refresh)) {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: stored OAuth credential for \`${providerLabel}\` has no usable access or refresh token. Re-authenticate with \`${loginCommand}\`; no secret value was displayed.`,
      );
      continue;
    }
    if (isOAuth && !hasUsablePiOAuthClientId(provider, entry)) {
      status = "waiting";
      details.push(`[WARN] ${label} ${refStr}: ChatGPT sign-in for \`${providerLabel}\` is missing its issued client ID. Reconnect with \`${piAuthRecoveryCommand(providerLabel, authPath)} --auth-method oauth\`; no credential value was displayed.`);
      continue;
    }
    if (!isOAuth && !isApiKey) {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: stored credential for \`${providerLabel}\` has an unsupported or missing type. Re-authenticate with \`${loginCommand}\`; no secret value was displayed.`,
      );
      continue;
    }
    const expired = typeof entry.expires === "number" && entry.expires < now;
    const whenNote = typeof entry.expires === "number" ? ` ${new Date(entry.expires).toISOString()}` : "";
    if (isOAuth && expired) {
      status = "waiting";
      details.push(
        `[WARN] ${label} ${refStr}: OAuth token for \`${providerLabel}\` expired${whenNote} — the runtime may auto-refresh, but this credential is not ready until a request succeeds; if runs fail with "No API key for provider: ${providerLabel}" re-authenticate with \`${loginCommand}\`.`,
      );
      continue;
    }
    details.push(
      isOAuth
        ? `${label} ${refStr}: OAuth credentials for \`${providerLabel}\` present (token valid${whenNote}); credential detected, live model verification is still pending.`
        : `${label} ${refStr}: API key credentials for \`${providerLabel}\` present; credential detected, live model verification is still pending.`,
    );
  }

  return status;
}

function describePiAuthStoreUnsafeReason(reason: PiAuthStoreUnsafeReason): string {
  switch (reason) {
    case "owner-check-unavailable": return "the current file owner could not be verified";
    case "symbolic-link": return "the configured entry is a symbolic link";
    case "not-regular-file": return "the configured entry is not a regular file";
    case "multiple-hard-links": return "the file has multiple hard links";
    case "oversized": return "the file exceeds the 1 MiB inspection limit";
    case "foreign-owner": return "the file is not owned by the current user";
    case "not-owner-only": return "its permissions are not owner-only";
    case "changed-during-read": return "its identity or metadata changed during inspection";
    case "malformed-json": return "it is not a valid JSON object";
    case "unreadable": return "it could not be opened and inspected safely";
  }
}

function hasNonEmptyCredentialValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 65_536 && !value.includes("\0");
}
