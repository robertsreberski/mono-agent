import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

/** Conservative opt-in window; eligibility is catalog inference, not entitlement. */
export const CONTEXT_1M_TOKENS = 1_000_000;

/**
 * Only built-in chat models with Pi's long-input pricing tier qualify.
 * @param {string} reference Canonical provider:model reference.
 * @returns {boolean}
 */
export function supportsPiContext1M(reference) {
  if (typeof reference !== "string") return false;
  const separator = reference.indexOf(":");
  const provider = reference.slice(0, separator);
  const id = reference.slice(separator + 1);
  if (separator < 0 || !["openai", "openai-codex"].includes(provider) || !id.startsWith("gpt-")) return false;
  const model = getBuiltinModel(/** @type {any} */ (provider), id);
  return model?.contextWindow === 272_000
    && model.cost?.tiers?.some((tier) => tier.inputTokensAbove === 272_000) === true;
}

/** @param {any} model @param {Record<string, boolean>|undefined} policy */
export function withContext1M(model, policy) {
  if (!model) return model;
  const reference = `${model.provider}:${model.id}`;
  return policy?.[reference] === true && supportsPiContext1M(reference)
    ? { ...model, contextWindow: CONTEXT_1M_TOKENS }
    : model;
}

const REQUEST_METHODS = new Set([
  "stream", "complete", "streamSimple", "completeSimple", "streamDeferred", "fetchDeferred", "cancelDeferred",
]);

/**
 * Pi re-resolves model metadata at lane binding and dispatch. Keep both views
 * run-scoped, including restored lanes, without mutating the shared catalog.
 * @param {import("@earendil-works/pi-ai").Models} models
 * @param {Record<string, boolean>|undefined} policy
 * @returns {import("@earendil-works/pi-ai").Models}
 */
export function withContext1MModels(models, policy) {
  if (!policy || !Object.values(policy).some((value) => value === true)) return models;
  return new Proxy(models, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "getModel") return (...args) => withContext1M(value.apply(target, args), policy);
      if (typeof property === "string" && REQUEST_METHODS.has(property)) {
        return (model, ...args) => value.call(target, withContext1M(model, policy), ...args);
      }
      return value.bind(target);
    },
  });
}
