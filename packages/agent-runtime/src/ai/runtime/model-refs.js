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

const UTF8_ENCODER = new TextEncoder();

/**
 * Ceiling on a canonical `<provider>:<model>`, in UTF-8 bytes.
 *
 * Measured rather than picked. Across all 1312 entries of Pi's built-in catalog (39
 * providers) the longest reference is 77 bytes
 * (`cloudflare-ai-gateway:workers-ai/@cf/mistralai/mistral-small-3.1-24b-instruct`) and the
 * longest provider id is 26. Local providers publish arbitrary ids from their own
 * `/v1/models`, so the ceiling has to clear those too, not just the catalog: live discovery
 * against Ollama and LM Studio returns 52 bytes at most
 * (`lmstudio:text-embedding-nomic-embed-text-v1.5@q4_k_m`), and the longest realistic Ollama
 * form -- a Hugging Face GGUF path carrying a quant tag, e.g.
 * `ollama:hf.co/bartowski/Qwen_Qwen3-235B-A22B-Instruct-2507-GGUF:Q4_K_M` -- is 68.
 *
 * 96 clears every one of those with room to spare, and is *the same* budget
 * @mono-agent/runtime-adapter uses to echo a reference into a diagnostic
 * (`MODEL_REFERENCE_ECHO_MAX_BYTES`, which is defined as this constant). That equality is the
 * rule, not the number: a reference is accepted exactly when every operator surface can quote
 * it whole, so a value too long to quote whole is not a reference.
 */
export const MAX_MODEL_REFERENCE_BYTES = 96;

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
 * A parsed reference is handed to every operator surface that names a model, and each of them
 * quotes it verbatim without re-validating it. Establishing here -- at the one place a
 * reference is ever constructed -- that it is printable single-line text that fits the echo
 * budget whole is what lets all of them quote it without a defence of their own; bounding any
 * single renderer would leave the composed line unbounded through the others.
 *
 * Runs last, after `rejectRemovedRuntimeReference`, so a retired backend still gets its
 * concrete repair named (`codex:x` -> `openai-codex:x`) instead of a generic shape complaint.
 * Rejection messages are operator-supplied text too, but they are bounded where they are
 * rendered, by runtime-adapter's `sanitizeModelReferenceText`; the two halves compose.
 *
 * @param {string} reference
 */
function requireQuotableReference(reference) {
  if (UNQUOTABLE_REFERENCE_CHARACTERS.test(reference)) {
    throw new Error("model reference must not contain control or formatting characters");
  }
  const bytes = UTF8_ENCODER.encode(reference).length;
  if (bytes > MAX_MODEL_REFERENCE_BYTES) {
    throw new Error(
      `model reference must be at most ${MAX_MODEL_REFERENCE_BYTES} bytes; got ${bytes}`,
    );
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
