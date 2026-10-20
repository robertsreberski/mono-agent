// @ts-check

import { access } from "node:fs/promises";
import { homedir } from "node:os";

import { generateEngineTurnResponse } from "../../execution/pi/run.js";

export type ProviderCheckOutcome = "passed" | "auth_failed" | "network_failed" | "quota_limited" | "model_not_entitled" | "inconclusive";

export type ProviderCheckCode = "passed" | "credential_rejected" | "provider_unavailable" | "quota_limited" | "model_not_entitled" | "forbidden" | "inconclusive" | "cancelled";

const SYSTEM_PROMPT = "Provider connectivity check. Reply OK.";
const USER_PROMPT = "OK";

/**
 * Execute one target-only Pi request. This intentionally bypasses the router:
 * a different provider or model must never prove the requested target healthy.
 * Provider output and raw errors are consumed here and never returned.
 */
export async function runPiProviderCheck(input: {
    model: {
        provider: string;
        model: string;
        reference?: string;
    };
    resolvePiApiKey?: Function;
    runtimeOptions?: Record<string, unknown>;
    environment?: Readonly<Record<string, string | undefined>>;
    abortSignal?: AbortSignal;
    execute?: typeof generateEngineTurnResponse;
}): Promise<{
    state: ProviderCheckOutcome;
    code: ProviderCheckCode;
    message: string;
}> {
  const execute = input.execute ?? generateEngineTurnResponse;
  const runtimeOptions = providerConstructionOptions(input.runtimeOptions);
  let result;
  try {
    result = await execute(SYSTEM_PROMPT, {
      ...runtimeOptions,
      model: {
        provider: input.model.provider,
        model: input.model.model,
        reference: input.model.reference ?? `${input.model.provider}:${input.model.model}`,
      },
      messages: [{ role: "user", content: USER_PROMPT }],
      effort: "none",
      allowedTools: [],
      disallowedTools: [],
      mcpServers: {},
      maxTurns: 1,
      piMaxRetries: 0,
      compaction: { enabled: false },
      providerCheckMaxTokens: 4,
      providerCheckAuthContext: {
        async env(name: string) { return input.environment?.[name]; },
        async fileExists(path: string) {
          try {
            await access(path.startsWith("~") ? homedir() + path.slice(1) : path);
            return true;
          } catch {
            return false;
          }
        },
      },
      ...(input.resolvePiApiKey === undefined ? {} : { resolvePiApiKey: input.resolvePiApiKey }),
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    });
  } catch (error) {
    if (input.abortSignal?.aborted === true) {
      return { state: "inconclusive", code: "cancelled", message: "The provider check did not complete." };
    }
    return classifyProviderCheckFailure(error instanceof Error ? error.message : "", undefined);
  }
  if (result?.cancelled === true || input.abortSignal?.aborted === true) {
    return { state: "inconclusive", code: "cancelled", message: "The provider check did not complete." };
  }
  if (!result?.error && result?.failureKind == null) {
    return { state: "passed", code: "passed", message: "Provider request succeeded." };
  }
  return classifyProviderCheckFailure(
    typeof result?.error === "string" ? result.error : "",
    typeof result?.failureKind === "string" ? result.failureKind : undefined,
  );
}

/**
 * Classify raw provider text inside the runtime boundary. The returned strings
 * are closed, fixed projections and contain no provider-controlled content.
 */
export function classifyProviderCheckFailure(text: string, failureKind: string | undefined): {
    state: ProviderCheckOutcome;
    code: ProviderCheckCode;
    message: string;
} {
  const value = String(text || "");
  if (failureKind === "provider_auth"
    || /(invalid api key|incorrect api key|no api key|missing api key|authentication failed|authorization failed|unauthorized|invalid[_ ]grant|token[_ ]revoked|revoked (?:oauth )?token|invalidated (?:oauth )?token|\b401\b)/i.test(value)) {
    return { state: "auth_failed", code: "credential_rejected", message: "Provider rejected the configured credential." };
  }
  if (failureKind === "usage_limit"
    || /(subscription_sharing_usage_limit_exceeded|rate limit|too many requests|insufficient[_ ]quota|quota exceeded|billing limit|\b429\b)/i.test(value)) {
    return { state: "quota_limited", code: "quota_limited", message: "Provider quota or rate limit prevented the check." };
  }
  if (/(model[_ -]?not[_ -]?found|unsupported model|no access to (?:the )?model|model entitlement|model[^\n]{0,120}(?:does not exist|not found|unavailable))/i.test(value)) {
    return { state: "model_not_entitled", code: "model_not_entitled", message: "The credential could not use the selected model." };
  }
  if (/forbidden|\b403\b/i.test(value)) {
    return { state: "inconclusive", code: "forbidden", message: "The provider refused the check for an unspecified reason." };
  }
  if (failureKind === "provider_unavailable"
    || /(econn|enotfound|etimedout|timed? ?out|service unavailable|gateway|fetch failed|network|websocket|\b5\d\d\b|\bconnection (?:error|refused|failed)\b)/i.test(value)) {
    return { state: "network_failed", code: "provider_unavailable", message: "The provider could not be reached." };
  }
  return { state: "inconclusive", code: "inconclusive", message: "The provider check failed without a safe diagnosis." };
}

/**
 * Keep the public check facade isolated from ordinary run state. These are the
 * only provider/model construction seams required by configured local
 * providers and deterministic faux-provider tests.
 */
function providerConstructionOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
  if (options === undefined) return {};
  const allowed = [
    "customProvider",
    "customModel",
    "modelCapabilities",
    "isPrivateProvider",
    "piResolvedModel",
    "piResolvedModels",
    "piResolvedCapabilities",
  ];
  return Object.fromEntries(allowed
    .filter((key) => Object.hasOwn(options, key))
    .map((key) => [key, options[key]]));
}
