import { parseMonoRuntimeModelReference } from "@mono-agent/turn/host/config";

import { inspectPiAuthStore } from "./pi-auth-store-inspection.js";
import { isRecord, isUsableStoredPiCredential, PI_API_KEY_PROVIDERS } from "./credential-values.js";
import { piAuthPathForSetup } from "./oauth-command.js";
import type { DetectProviderCredentialStatesOptions, ProviderCredentialState } from "./setup-types.js";

/**
 * Detect credential/sign-in postconditions without authenticating or claiming
 * provider readiness. Only an exact live route probe may promote these states
 * to `verified`.
 */
export async function detectProviderCredentialStates(
  options: DetectProviderCredentialStatesOptions,
): Promise<Readonly<Record<string, ProviderCredentialState>>> {
  const states: Record<string, ProviderCredentialState> = {};
  const refs = options.modelRefs.flatMap((raw) => {
    try {
      return [parseMonoRuntimeModelReference(raw)];
    } catch {
      return [];
    }
  });
  const persistedEnv = options.persistedEnv ?? {};
  const piProviders = new Set(
    refs.map((ref) => ref.provider),
  );
  if (piProviders.size > 0) {
    const detected = await safelyDetectedPiCredentialProviders(
      piAuthPathForSetup(options.piAuthPath, options.cwd),
    );
    for (const provider of piProviders) {
      const apiKeyEnv = PI_API_KEY_PROVIDERS[provider];
      states[provider] = detected.has(provider)
        || (apiKeyEnv !== undefined && hasNonEmptyPersistedValue(persistedEnv[apiKeyEnv]))
        ? "credential_detected"
        : "auth_required";
    }
  }
  return states;
}

function hasNonEmptyPersistedValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

async function safelyDetectedPiCredentialProviders(path: string): Promise<Set<string>> {
  const inspection = await inspectPiAuthStore(path);
  if (inspection.status !== "ok") return new Set();
  const nested = isRecord(inspection.auth.providers) ? inspection.auth.providers : {};
  const entries = Object.entries({
    ...nested,
    ...Object.fromEntries(Object.entries(inspection.auth).filter(([key]) => key !== "providers")),
  });
  return new Set(entries
    .filter(([provider, credential]) => isUsableStoredPiCredential(provider, credential))
    .map(([provider]) => provider));
}
