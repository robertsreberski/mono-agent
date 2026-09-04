// @ts-check

/** @typedef {import('../types.js').RuntimeModelRef} RuntimeModelRef */

const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Control (`Cc`), format (`Cf`), line- and paragraph-separator code points. Every one of them
 * either moves the cursor or is invisible, which is what lets a model id restyle or extend
 * the diagnostic that quotes it -- and an *accepted* reference is quoted verbatim, without
 * re-validation, by `mono-agent validate`, `doctor`, the TUI, the web console, the daemon log
 * and launchd's captured stdout, all of them line-oriented and durable.
 *
 * Deliberately the same set that `DIAGNOSTIC_UNSAFE_CHARACTERS` in @mono-agent/runtime-adapter
 * escapes when it quotes a *rejected* value: that layer makes an unparseable value safe to
 * print, this one makes a parsed value safe to print. runtime-adapter's model-reference bound
 * suite asserts the two agree code point by code point rather than by comment.
 */
const UNQUOTABLE_REFERENCE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

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
 * The one thing a parsed reference is guaranteed to CONTAIN nothing of.
 *
 * A reference this parser returns is handed to every operator surface that names a model and
 * quoted verbatim by each of them, without re-validation: `mono-agent validate`, `doctor`, the
 * TUI, the web console, the daemon log, launchd's captured stdout. All of them are
 * line-oriented and most are durable, so a control or formatting code point in the value is
 * enough to restyle the diagnostic quoting it or forge a second line inside it. No legitimate
 * model id contains one, nothing downstream can repair one after the fact, and escaping it at
 * six renderers is six chances to miss. So it is refused here, at the source, absolutely.
 *
 * There is deliberately NO length rule to go with it. A grammar layer does not get to decide
 * what a provider may call a model, and three rounds of trying produced three wrong answers:
 * 96 bytes refused a Hugging Face GGUF repo Ollama serves today, 160 bytes refused an
 * `ollama:<model>:<tag>` reference whose two halves Ollama itself validates at 80 bytes each,
 * and no maximum is published in common across Ollama, LM Studio, OpenRouter and custom
 * `openai_compat` endpoints from which a third guess would be any better. mono-agent's own
 * `discoverLocalProviderModels` was returning ids this parser then refused.
 *
 * The requirements that ceiling was carrying are all met by the layers that render or transmit
 * a reference, where the answer to "too long" is a shorter STRING rather than a lost route:
 *  - a diagnostic echo is clamped by truncation, marking the cut -- `sanitizeModelReferenceText`
 *    on `MODEL_REFERENCE_ECHO_MAX_BYTES`, @mono-agent/runtime-adapter;
 *  - an adapter error body is clamped by `sendJsonError`;
 *  - the `/v1/info` payload is bounded by per-contributor measured budgets and a total
 *    serializer fence that sheds whole fields (`channel-drivers/tui.ts`, `sendBoundedInfo`).
 * Each of those is asserted at its own layer; none of them is asserted here, because none of
 * them is this function's job.
 *
 * Runs last, after `rejectRemovedRuntimeReference`, so a retired backend still gets its
 * concrete repair named (`codex:x` -> `openai-codex:x`) instead of a generic shape complaint.
 * Rejection messages are operator-supplied text too, and are bounded where they are rendered.
 *
 * @param {string} reference
 */
function requireQuotableReference(reference) {
  if (UNQUOTABLE_REFERENCE_CHARACTERS.test(reference)) {
    throw new Error("model reference must not contain control or formatting characters");
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
  const reference = `${provider}:${model}`;
  requireProvider(provider);
  requireModel(model);
  rejectRemovedRuntimeReference(provider, model);
  requireQuotableReference(reference);

  return { provider, model, reference };
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
