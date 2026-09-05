// @ts-check

const OPENCODE_HOST = "opencode.ai";
const OPENCODE_PROVIDERS = new Set(["opencode", "opencode-go"]);
const REQUEST_METHODS = new Set([
  "stream",
  "complete",
  "streamSimple",
  "completeSimple",
  "streamDeferred",
  "fetchDeferred",
  "cancelDeferred",
]);

/** @typedef {import("@earendil-works/pi-ai").Models} Models */
/** @typedef {import("@earendil-works/pi-ai").ProviderHeaders} ProviderHeaders */

/**
 * Match Pi's OpenCode attribution boundary without accepting deceptive suffixes
 * or subdomains. Provider ids remain authoritative for callers that deliberately
 * route OpenCode through a nonstandard endpoint.
 *
 * @param {{provider?: string, baseUrl?: string}} model
 */
export function isOpenCodeModel(model) {
  if (OPENCODE_PROVIDERS.has(model?.provider)) return true;
  if (typeof model?.baseUrl !== "string") return false;
  try {
    return new URL(model.baseUrl).hostname === OPENCODE_HOST;
  } catch {
    return false;
  }
}

/**
 * Add one default without replacing an auth/model/request value, including a
 * caller's case-insensitive null suppression.
 *
 * @param {ProviderHeaders} headers
 * @param {string} name
 * @param {string} value
 * @returns {ProviderHeaders}
 */
function addDefaultHeader(headers, name, value) {
  const lowerName = name.toLowerCase();
  if (Object.keys(headers).some((existingName) => existingName.toLowerCase() === lowerName)) {
    return headers;
  }
  return { ...headers, [name]: value };
}

/**
 * @param {Object<string, *>|undefined} options
 * @param {string} sessionId
 * @returns {Object<string, *>}
 */
function withOpenCodeHeaderTransform(options, sessionId) {
  const previousTransform = options?.transformHeaders;
  return {
    ...(options ?? {}),
    transformHeaders: async (headers) => {
      let attributed = addDefaultHeader(headers, "x-opencode-session", sessionId);
      attributed = addDefaultHeader(attributed, "x-opencode-client", "mono-agent");
      return typeof previousTransform === "function"
        ? await previousTransform(attributed)
        : attributed;
    },
  };
}

/**
 * Decorate every Pi Models request path for one run. Non-request methods stay
 * bound to the original Models instance because its state lives in private
 * fields; matching is performed on the actual model dispatched by Pi, covering
 * builtin, custom-provider, compaction, deferred, and advanced/test models.
 *
 * @param {Models} models
 * @param {string} sessionId
 * @returns {Models}
 */
export function withOpenCodeSessionHeaders(models, sessionId) {
  const wrappers = new Map();
  return /** @type {Models} */ (new Proxy(models, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof property !== "string" || typeof value !== "function") return value;
      if (!REQUEST_METHODS.has(property)) return value.bind(target);

      let wrapper = wrappers.get(property);
      if (wrapper === undefined) {
        wrapper = (model, input, options) => value.call(
          target,
          model,
          input,
          isOpenCodeModel(model) ? withOpenCodeHeaderTransform(options, sessionId) : options,
        );
        wrappers.set(property, wrapper);
      }
      return wrapper;
    },
  }));
}
