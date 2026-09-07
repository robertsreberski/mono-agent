// @ts-check

import { access } from "node:fs/promises";
import { homedir } from "node:os";

import { generatePiNativeResponse } from "./providers/pi-native.js";

const SYSTEM_PROMPT = "Provider connectivity check. Reply OK.";
const USER_PROMPT = "OK";

/** @typedef {"passed"|"auth_failed"|"network_failed"|"quota_limited"|"model_not_entitled"|"inconclusive"} ProviderCheckOutcome */

/**
 * Execute one target-only Pi request. This intentionally bypasses the router:
 * a different provider or model must never prove the requested target healthy.
 * Provider output and raw errors are consumed here and never returned.
 *
 * @param {{
 *   model: {provider: string, model: string, reference?: string},
 *   resolvePiApiKey?: Function,
 *   runtimeOptions?: Record<string, unknown>,
 *   environment?: Readonly<Record<string, string|undefined>>,
 *   abortSignal?: AbortSignal,
 *   execute?: typeof generatePiNativeResponse,
 * }} input
 * @returns {Promise<{state: ProviderCheckOutcome, code: string, message: string}>}
 */
export async function runPiProviderCheck(input) {
  const execute = input.execute ?? generatePiNativeResponse;
  let result;
  try {
    result = await execute(SYSTEM_PROMPT, {
      ...(input.runtimeOptions ?? {}),
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
      providerCheckMaxTokens: 4,
      providerCheckAuthContext: {
        async env(name) { return input.environment?.[name]; },
        async fileExists(path) {
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
 * @param {string} text
 * @param {string|undefined} failureKind
 * @returns {{state: ProviderCheckOutcome, code: string, message: string}}
 */
export function classifyProviderCheckFailure(text, failureKind) {
  const value = String(text || "");
  if (failureKind === "provider_auth"
    || /(invalid api key|incorrect api key|no api key|missing api key|authentication failed|authorization failed|unauthorized|invalid[_ ]grant|token[_ ]revoked|revoked (?:oauth )?token|invalidated (?:oauth )?token|\b401\b)/i.test(value)) {
    return { state: "auth_failed", code: "credential_rejected", message: "Provider rejected the configured credential." };
  }
  if (failureKind === "usage_limit"
    || /(rate limit|too many requests|insufficient[_ ]quota|quota exceeded|billing limit|\b429\b)/i.test(value)) {
    return { state: "quota_limited", code: "quota_limited", message: "Provider quota or rate limit prevented the check." };
  }
  if (/(model[_ ]not[_ ]found|unsupported model|no access to (?:the )?model|model entitlement|\b404\b)/i.test(value)) {
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

export const PROVIDER_CHECK_PROMPT = Object.freeze({ system: SYSTEM_PROMPT, user: USER_PROMPT, maxOutputTokens: 4 });
