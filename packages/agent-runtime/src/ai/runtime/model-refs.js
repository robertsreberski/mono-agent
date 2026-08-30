// @ts-check

/** @typedef {import('../types.js').RuntimeModelRef} RuntimeModelRef */

const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * @param {string} provider
 * @param {string} model
 */
function rejectRemovedRuntimeReference(provider, model) {
  if (provider === "codex") {
    throw new Error(`codex is no longer a runtime backend; use openai-codex:${model}`);
  }
  if (provider === "claude" || provider === "claude-code") {
    throw new Error(`${provider} is no longer a runtime backend; use anthropic:${model}`);
  }
  if (provider === "codex-cli") {
    throw new Error(`codex-cli is no longer a runtime backend; use openai-codex:${model}`);
  }
  if (provider === "acp") {
    throw new Error(
      "ACP is no longer a runtime backend; use <provider>:<model> for Pi models, or mono-agent bridge acp to serve mono-agent over ACP",
    );
  }
  if (provider === "vercel") {
    const replacement = model.includes(":") ? model : "<provider>:<model>";
    throw new Error(`vercel:<provider>:<model> is no longer supported; use ${replacement} directly`);
  }
  if (provider === "opencode" && model.includes(":")) {
    throw new Error(`the opencode:<provider>:<model> runtime form is no longer supported; use ${model}`);
  }
}

/** @param {string} provider */
function requireProvider(provider) {
  if (!PROVIDER_ID_RE.test(provider)) {
    throw new Error("invalid provider id; expected [A-Za-z0-9][A-Za-z0-9._-]*");
  }
}

/** @param {string} model */
function requireModel(model) {
  if (!model || model.trim() !== model) {
    throw new Error("model id must be a non-empty trimmed string");
  }
  if (["haiku", "sonnet", "opus"].includes(model)) {
    throw new Error("tier aliases are not valid model ids; use an exact model id");
  }
}

/**
 * Parse the provider/model pair after the optional legacy `pi:` wrapper has
 * been removed. Pi model ids are opaque and commonly contain further colons,
 * so only the first colon is structural.
 *
 * @param {string} value
 * @returns {RuntimeModelRef}
 */
function parseCanonicalReference(value) {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("invalid model reference; expected <provider>:<model>");
  }

  const provider = value.slice(0, separator);
  const model = value.slice(separator + 1);
  requireProvider(provider);
  requireModel(model);
  rejectRemovedRuntimeReference(provider, model);

  return { provider, model, reference: `${provider}:${model}` };
}

/**
 * @param {string} value
 * @returns {RuntimeModelRef}
 */
export function normalizeRuntimeModelReference(value) {
  return parseRuntimeModelReference(value);
}

/**
 * @param {string} value
 * @returns {RuntimeModelRef}
 */
export function parseRuntimeModelReference(value) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error("model reference must be a non-empty trimmed string");
  }

  if (value.startsWith("pi:")) {
    const wrapped = value.slice("pi:".length);
    if (wrapped.indexOf(":") <= 0 || wrapped.endsWith(":")) {
      throw new Error("invalid pi model reference; use pi:<provider>:<model>");
    }
    return parseCanonicalReference(wrapped);
  }

  return parseCanonicalReference(value);
}
