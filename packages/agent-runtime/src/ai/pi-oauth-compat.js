// @ts-check

// Adapter over pi-ai's provider-owned OAuth surface.
//
// pi-ai 0.83.0 removed the generic OAuth registry — `getOAuthApiKey`,
// `getOAuthProvider` and `getOAuthProviders` are gone, and the
// `@earendil-works/pi-ai/oauth` entry point is now type-only (`export {}` at
// runtime). The per-provider implementations (`anthropicOAuth`, …) live under
// `dist/auth/oauth/*`, which has no entry in the package's `exports` map, so
// they cannot be imported. The supported surface is `provider.auth.oauth`,
// reached through the provider factories.
//
// mono-agent resolves providers dynamically from `pi:<provider>:<model>`, so it
// needs a lookup by id — this module rebuilds that over `builtinProviders()` and
// preserves the old call contracts exactly, keeping the migration confined here.
//
// Deliberately NOT using `createModels({credentials})`: that hands credential
// locking and persistence to pi, while mono-agent already owns `auth.json`
// through `pi-auth.js` (serialized writes, atomic 0600 rename). `refresh()` and
// `toAuth()` are callable directly, so the pure caller-persists contract stays.

import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

/**
 * @typedef {import("@earendil-works/pi-ai").OAuthAuth} OAuthAuth
 * @typedef {import("@earendil-works/pi-ai").OAuthCredential} OAuthCredential
 * @typedef {import("@earendil-works/pi-ai").ProviderAuthInteraction} ProviderAuthInteraction
 * @typedef {import("@earendil-works/pi-ai").AuthPrompt} AuthPrompt
 * @typedef {import("@earendil-works/pi-ai").AuthEvent} AuthEvent
 * @typedef {import("@earendil-works/pi-ai/oauth").OAuthLoginCallbacks} OAuthLoginCallbacks
 */

/** @type {Map<string, import("@earendil-works/pi-ai").Provider>|undefined} */
let providerIndexCache;

/**
 * `builtinProviders()` freshly constructs every provider (~37 objects) on each
 * call, and `pi-auth.js` sits on the per-request credential path. The catalog is
 * static for the process lifetime, so index it once.
 *
 * @returns {Map<string, import("@earendil-works/pi-ai").Provider>}
 */
function providerIndex() {
  if (providerIndexCache === undefined) {
    providerIndexCache = new Map(builtinProviders().map((provider) => [provider.id, provider]));
  }
  return providerIndexCache;
}

/** @internal Exported only so tests can force a rebuild of the memoized index. */
export function resetPiProviderIndexForTests() {
  providerIndexCache = undefined;
}

/**
 * The OAuth implementation for a Pi provider id, or undefined when the provider
 * is unknown or supports only API-key auth (e.g. `opencode-go`).
 *
 * @param {string} providerId
 * @returns {OAuthAuth|undefined}
 */
export function getPiOAuthAuth(providerId) {
  if (typeof providerId !== "string" || providerId.length === 0) return undefined;
  return providerIndex().get(providerId)?.auth?.oauth;
}

/**
 * Every Pi provider id that supports OAuth. Replaces
 * `getOAuthProviders().map((provider) => provider.id)`.
 *
 * @returns {string[]}
 */
export function getPiOAuthProviderIds() {
  const ids = [];
  for (const [id, provider] of providerIndex()) {
    if (provider.auth?.oauth !== undefined) ids.push(id);
  }
  return ids;
}

/**
 * Resolve an API key from stored OAuth credentials, refreshing first when the
 * token has expired.
 *
 * Reproduces pi-ai 0.80.6's `getOAuthApiKey(providerId, credentials)` contract
 * so its call sites keep their shape: takes the whole provider-keyed credential
 * map, returns `null` when this provider has no stored credential, and is
 * *pure* — the refreshed credential comes back as `newCredentials` for the
 * caller to persist rather than being written here.
 *
 * The refresh trigger is deliberately the old exact-expiry check. pi's own
 * `Models.getAuth()` refreshes five minutes ahead of expiry; matching that would
 * change live token rotation timing, which this migration does not intend.
 *
 * @param {string} providerId
 * @param {Record<string, *>|undefined} credentials Provider-keyed credential map.
 * @returns {Promise<{newCredentials: OAuthCredential, apiKey: string|undefined}|null>}
 */
export async function resolveOAuthApiKey(providerId, credentials) {
  const oauth = getPiOAuthAuth(providerId);
  if (oauth === undefined) {
    throw new Error(`Unknown OAuth provider: ${providerId}`);
  }

  const stored = credentials?.[providerId];
  if (stored === undefined || stored === null) return null;

  // 0.83.0's OAuthCredential carries a `type: "oauth"` discriminant that the
  // 0.80.6 shape did not. Stored entries written by mono-agent already have it;
  // tag defensively so hand-edited or externally written files still work.
  let credential = /** @type {OAuthCredential} */ ({ ...stored, type: "oauth" });

  if (Date.now() >= credential.expires) {
    try {
      // Pi 0.84 requires provider refreshes to receive an AbortSignal. This
      // legacy resolver has no cancellation input, so give the refresh its own
      // non-aborted signal while keeping the public contract unchanged.
      credential = await oauth.refresh(credential, new AbortController().signal);
    } catch {
      throw new Error(`Failed to refresh OAuth token for ${providerId}`);
    }
  }

  // `toAuth()` also derives a per-credential baseUrl (GitHub Copilot's
  // per-account proxy). 0.80.6 discarded it and callers here have no field for
  // it, so it stays dropped — behaviour preserved, worth revisiting separately.
  const auth = await oauth.toAuth(credential);
  return { newCredentials: credential, apiKey: auth?.apiKey };
}

/**
 * Bridge the legacy six-callback OAuth surface onto Pi's single
 * `prompt`/`notify` pair. Pi 0.84 requires every provider login interaction to
 * carry an AbortSignal, so callbacks without one receive a private non-aborted
 * signal.
 *
 * `manual_code` must stay wired to `onManualCodeInput`: Anthropic races its
 * localhost callback against a pasted redirect URL, and that path is the reason
 * `agent-app`'s `runPiOAuthLogin` exists at all.
 *
 * @param {OAuthLoginCallbacks} callbacks
 * @returns {ProviderAuthInteraction}
 */
export function toAuthInteraction(callbacks) {
  if (callbacks === null || typeof callbacks !== "object") {
    throw new TypeError("toAuthInteraction requires an OAuthLoginCallbacks object");
  }

  return {
    signal: callbacks.signal ?? new AbortController().signal,

    /** @param {AuthPrompt} prompt */
    async prompt(prompt) {
      if (prompt.type === "select") {
        const selected = await callbacks.onSelect({
          message: prompt.message,
          options: prompt.options.map((option) => ({ id: option.id, label: option.label })),
        });
        // The legacy callback resolves undefined when the user cancels; the new
        // contract requires a string and rejects on cancel.
        if (typeof selected !== "string") {
          throw new Error("OAuth provider selection was cancelled.");
        }
        return selected;
      }

      if (prompt.type === "manual_code" && typeof callbacks.onManualCodeInput === "function") {
        return await callbacks.onManualCodeInput();
      }

      return await callbacks.onPrompt({
        message: prompt.message,
        ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
      });
    },

    /** @param {AuthEvent} event */
    notify(event) {
      if (event.type === "auth_url") {
        callbacks.onAuth({
          url: event.url,
          ...(event.instructions === undefined ? {} : { instructions: event.instructions }),
        });
        return;
      }
      if (event.type === "device_code") {
        callbacks.onDeviceCode({
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          ...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }),
          ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
        });
        return;
      }
      callbacks.onProgress?.(event.message);
    },
  };
}
