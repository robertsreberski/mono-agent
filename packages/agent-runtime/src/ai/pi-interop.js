// Runtime-owned interoperability facade for Pi's built-in model and OAuth
// surfaces. Consumers should use these functions instead of importing pi-ai
// directly so the runtime's known-good Pi version remains authoritative.

import { getBuiltinModel, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { getOAuthApiKey, getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { reasoningLevelsForPiModel as resolveReasoningLevels } from "./providers/pi-models.js";

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   api: string,
 *   provider: string,
 *   baseUrl: string,
 *   reasoning: boolean,
 *   input: Array<"text"|"image">,
 *   cost: {
 *     input: number,
 *     output: number,
 *     cacheRead: number,
 *     cacheWrite: number,
 *     tiers?: Array<{
 *       inputTokensAbove: number,
 *       input: number,
 *       output: number,
 *       cacheRead: number,
 *       cacheWrite: number
 *     }>
 *   },
 *   contextWindow: number,
 *   maxTokens: number,
 *   thinkingLevelMap?: Object<string, string|null>,
 *   compat?: Object<string, *>,
 *   headers?: Object<string, string>,
 *   [key: string]: *
 * }} PiBuiltinModelSnapshot
 */

/**
 * @typedef {"none"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"} PiReasoningLevel
 */

/**
 * @typedef {{
 *   refresh: string,
 *   access: string,
 *   expires: number,
 *   [key: string]: *
 * }} PiOAuthCredentialsSnapshot
 */

/**
 * @typedef {Object} PiOAuthLoginCallbacks
 * @property {(info: {url: string, instructions?: string}) => void} onAuth
 * @property {(info: {userCode: string, verificationUri: string, intervalSeconds?: number, expiresInSeconds?: number}) => void} onDeviceCode
 * @property {(prompt: {message: string, placeholder?: string, allowEmpty?: boolean}) => Promise<string>} onPrompt
 * @property {(message: string) => void} [onProgress]
 * @property {() => Promise<string>} [onManualCodeInput]
 * @property {(prompt: {message: string, options: Array<{id: string, label: string}>}) => Promise<string|undefined>} onSelect
 * @property {AbortSignal} [signal]
 */

/**
 * Clone provider-owned data before it crosses the public runtime boundary.
 * Pi's built-in models and OAuth credentials are structured data on the
 * supported version, and the package requires a Node release with
 * `structuredClone`.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function cloneInteropValue(value) {
  return structuredClone(value);
}

/**
 * List defensive snapshots of Pi's built-in models for one provider.
 *
 * @param {string} providerId
 * @returns {PiBuiltinModelSnapshot[]}
 */
export function listPiBuiltinModels(providerId) {
  const models = getBuiltinModels(/** @type {any} */ (providerId));
  return /** @type {PiBuiltinModelSnapshot[]} */ (cloneInteropValue(models));
}

/**
 * Read a defensive snapshot of one Pi built-in model.
 *
 * @param {string} providerId
 * @param {string} modelId
 * @returns {PiBuiltinModelSnapshot|undefined}
 */
export function getPiBuiltinModel(providerId, modelId) {
  const model = getBuiltinModel(
    /** @type {any} */ (providerId),
    /** @type {any} */ (modelId),
  );
  return model === undefined
    ? undefined
    : /** @type {PiBuiltinModelSnapshot} */ (cloneInteropValue(model));
}

/**
 * Translate Pi's model-native thinking levels to mono-agent effort spelling.
 *
 * @param {PiBuiltinModelSnapshot} model
 * @returns {PiReasoningLevel[]}
 */
export function reasoningLevelsForPiModel(model) {
  return /** @type {PiReasoningLevel[]} */ (resolveReasoningLevels(model));
}

/**
 * Resolve an OAuth-backed API key without allowing Pi to mutate the caller's
 * credential record or returning Pi-owned credential objects.
 *
 * @param {string} providerId
 * @param {Object<string, PiOAuthCredentialsSnapshot>} credentials
 * @returns {Promise<{apiKey: string, newCredentials: PiOAuthCredentialsSnapshot}|null>}
 */
export async function resolvePiOAuthApiKey(providerId, credentials) {
  const result = await getOAuthApiKey(
    providerId,
    /** @type {any} */ (cloneInteropValue(credentials)),
  );
  if (!result) return null;
  return {
    apiKey: result.apiKey,
    newCredentials: cloneInteropValue(result.newCredentials),
  };
}

/**
 * Run a supported Pi OAuth login flow without exposing Pi's mutable provider
 * registry or provider instances.
 *
 * @param {string} providerId
 * @param {PiOAuthLoginCallbacks} callbacks
 * @returns {Promise<PiOAuthCredentialsSnapshot>}
 */
export async function loginPiOAuth(providerId, callbacks) {
  const provider = getOAuthProvider(providerId);
  if (!provider || typeof provider.login !== "function") {
    throw new Error(`Pi OAuth provider is unavailable: ${providerId}`);
  }
  for (const callbackName of ["onAuth", "onDeviceCode", "onPrompt", "onSelect"]) {
    if (typeof callbacks?.[callbackName] !== "function") {
      throw new TypeError(`loginPiOAuth requires callbacks.${callbackName}()`);
    }
  }
  const credentials = await provider.login(/** @type {any} */ ({ ...callbacks }));
  return cloneInteropValue(credentials);
}
