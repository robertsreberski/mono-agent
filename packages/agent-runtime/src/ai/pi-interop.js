// Runtime-owned interoperability facade for Pi's built-in model and OAuth
// surfaces. Consumers should use these functions instead of importing pi-ai
// directly so the runtime's known-good Pi version remains authoritative.

import {
  builtinModels,
  builtinProviders,
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { getPiOAuthAuth, resolveOAuthApiKey, toAuthInteraction } from "./pi-oauth-compat.js";
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
 *   id: string,
 *   label: string
 * }} PiBuiltinProviderSnapshot
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
 * @typedef {{
 *   providerId: string,
 *   label: string,
 *   methods: Array<{type: "oauth"|"api_key", label: string, interactive: boolean}>
 * }} PiProviderAuthDescription
 */

/**
 * @typedef {{source: "stored"|"environment"|"ambient", type: "oauth"|"api_key"}} PiProviderAuthCheck
 */

/**
 * @typedef {{
 *   type: "text"|"secret"|"select"|"manual_code",
 *   message: string,
 *   placeholder?: string,
 *   allowEmpty?: boolean,
 *   options?: ReadonlyArray<{id: string, label: string, description?: string}>,
 *   signal?: AbortSignal
 * }} PiProviderAuthPrompt
 */

/**
 * @typedef {{
 *   signal?: AbortSignal,
 *   prompt: (prompt: PiProviderAuthPrompt) => Promise<string>,
 *   notify: (event: *) => void
 * }} PiProviderAuthInteraction
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

let builtinProviderLabels;
function builtinProviderLabelMap() {
  // `getBuiltinProviders()` is the authoritative static catalog set (39 ids),
  // but it returns bare ids — the human display label lives on the constructed
  // `Provider.name`, which only `builtinProviders()` exposes. Build the name
  // lookup once from the constructed providers and gate what we ADVERTISE on
  // the static id set below, so the dynamic "radius" gateway (present in
  // `builtinProviders()` but absent from `getBuiltinProviders()`) never enters
  // the advertised catalog. A throwing construction degrades to id-as-label.
  builtinProviderLabels ??= (() => {
    try {
      return new Map(builtinProviders().map((provider) => [provider.id, provider.name]));
    } catch {
      return new Map();
    }
  })();
  return builtinProviderLabels;
}

/**
 * List defensive snapshots of Pi's static built-in providers (id + display
 * label). The dynamic "radius" gateway is deliberately excluded: it has no
 * static catalog and must not be advertised as a browsable provider.
 *
 * @returns {PiBuiltinProviderSnapshot[]}
 */
export function listPiBuiltinProviders() {
  const labels = builtinProviderLabelMap();
  return getBuiltinProviders().map((id) => ({
    id,
    label: labels.get(id) ?? id,
  }));
}

/**
 * Describe one static Pi built-in provider by id, or `undefined` for unknown
 * ids (including the dynamic "radius" gateway).
 *
 * @param {string} providerId
 * @returns {PiBuiltinProviderSnapshot|undefined}
 */
export function describePiBuiltinProvider(providerId) {
  const id = String(providerId);
  if (!getBuiltinProviders().includes(/** @type {any} */ (id))) {
    return undefined;
  }
  return {
    id,
    label: builtinProviderLabelMap().get(id) ?? id,
  };
}

/**
 * Describe one provider's supported authentication methods without exposing
 * Pi provider objects across the runtime boundary.
 *
 * @param {string} providerId
 * @returns {PiProviderAuthDescription|undefined}
 */
export function describePiProviderAuth(providerId) {
  let provider;
  try {
    provider = builtinProviders().find((candidate) => candidate.id === providerId);
  } catch {
    return undefined;
  }
  if (provider === undefined) return undefined;
  const methods = [];
  if (provider.auth.oauth !== undefined) {
    methods.push({
      type: /** @type {const} */ ("oauth"),
      label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
      interactive: true,
    });
  }
  if (provider.auth.apiKey !== undefined) {
    methods.push({
      type: /** @type {const} */ ("api_key"),
      label: provider.auth.apiKey.name,
      interactive: typeof provider.auth.apiKey.login === "function",
    });
  }
  return cloneInteropValue({ providerId: provider.id, label: provider.name, methods });
}

/**
 * Run Pi's side-effect-free `Models.checkAuth()` against a caller-provided
 * credential/environment snapshot. OAuth refresh and live provider requests do
 * not occur. Only the non-secret source/type result crosses this facade.
 *
 * @param {string} providerId
 * @param {*} credential
 * @param {Readonly<Record<string, string|undefined>>} [environment]
 * @param {AbortSignal} [signal]
 * @returns {Promise<PiProviderAuthCheck|undefined>}
 */
export async function checkPiProviderAuth(providerId, credential, environment = {}, signal) {
  const credentials = memoryCredentialStore(credential === undefined ? {} : { [providerId]: credential });
  const models = builtinModels({
    credentials,
    authContext: {
      async env(name) { return environment[name]; },
      async fileExists(path) {
        try {
          const fs = await import("node:fs/promises");
          let resolved = path;
          if (resolved.startsWith("~")) {
            const os = await import("node:os");
            resolved = os.homedir() + resolved.slice(1);
          }
          await fs.access(resolved);
          return true;
        } catch {
          return false;
        }
      },
    },
  });
  const result = await models.checkAuth(providerId, signal === undefined ? undefined : { signal });
  if (result === undefined) return undefined;
  const source = result.type === "oauth" || result.source === "stored credential"
    ? "stored"
    : typeof result.source === "string"
      && typeof environment[result.source] === "string"
      && environment[result.source].trim().length > 0
      ? "environment"
      : "ambient";
  return cloneInteropValue({ source, type: result.type });
}

/**
 * Run a provider-owned Pi login into a process-local store. The returned
 * credential is a defensive snapshot; the caller remains responsible for its
 * hardened durable transaction.
 *
 * @param {string} providerId
 * @param {"oauth"|"api_key"} type
 * @param {PiProviderAuthInteraction} interaction
 * @returns {Promise<*>}
 */
export async function loginPiProviderAuth(providerId, type, interaction) {
  if (type !== "oauth" && type !== "api_key") {
    throw new TypeError("Pi provider auth type must be oauth or api_key");
  }
  if (typeof interaction?.prompt !== "function" || typeof interaction?.notify !== "function") {
    throw new TypeError("Pi provider auth interaction requires prompt() and notify()");
  }
  const models = builtinModels({ credentials: memoryCredentialStore({}) });
  const credential = await models.login(providerId, type, {
    signal: interaction.signal,
    prompt: async (prompt) => await interaction.prompt(prompt),
    notify: (event) => interaction.notify(cloneInteropValue(event)),
  });
  return cloneInteropValue(credential);
}

/** @param {Record<string, *>} initial */
function memoryCredentialStore(initial) {
  const held = new Map(Object.entries(initial));
  return {
    async read(providerId) { return held.get(providerId); },
    async list() {
      return [...held.entries()].flatMap(([providerId, credential]) =>
        credential?.type === "oauth" || credential?.type === "api_key"
          ? [{ providerId, type: credential.type }]
          : []);
    },
    async modify(providerId, fn) {
      const next = await fn(held.get(providerId));
      if (next !== undefined) held.set(providerId, next);
      return held.get(providerId);
    },
    async delete(providerId) { held.delete(providerId); },
  };
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
  const result = await resolveOAuthApiKey(
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
  const oauth = getPiOAuthAuth(providerId);
  if (!oauth || typeof oauth.login !== "function") {
    throw new Error(`Pi OAuth provider is unavailable: ${providerId}`);
  }
  for (const callbackName of ["onAuth", "onDeviceCode", "onPrompt", "onSelect"]) {
    if (typeof callbacks?.[callbackName] !== "function") {
      throw new TypeError(`loginPiOAuth requires callbacks.${callbackName}()`);
    }
  }
  const credentials = await oauth.login(
    toAuthInteraction(/** @type {any} */ ({ ...callbacks })),
  );
  return cloneInteropValue(credentials);
}
