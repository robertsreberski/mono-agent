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
 * This is a CONTAINMENT bound, not a display one. Its job is that no unbounded, externally
 * supplied identifier flows into a log line, a cache key or a wire payload -- a model
 * reference reaches all three, and both its halves come from outside this process (an
 * operator's config field, or a local endpoint's `/v1/models` answer). What it is emphatically
 * NOT is an opinion about how wide an operator's terminal is: how long a model may legitimately
 * be called is decided by providers, and a diagnostic that cannot fit one is bounded by
 * TRUNCATING it -- see `MODEL_REFERENCE_ECHO_MAX_BYTES` in @mono-agent/runtime-adapter, which is
 * now a separate number for a separate concern. Collapsing the two into one 96-byte constant
 * made this ceiling reject a real, current Hugging Face GGUF repo documented for Ollama at
 * 100 bytes; you can bound an echo by truncating, you cannot bound reality.
 *
 * Measured, then derived. What references actually are, as of this change:
 *  - Pi's built-in catalog: 1312 entries across 39 providers, p99 61 bytes, longest 77
 *    (`cloudflare-ai-gateway:workers-ai/@cf/mistralai/mistral-small-3.1-24b-instruct`);
 *    longest built-in provider id 26 (`qwen-token-plan-individual`).
 *  - Live `discoverLocalProviderModels` against this machine's Ollama (:11434) and LM Studio
 *    (:1234): 17 refs, longest 52 (`lmstudio:text-embedding-nomic-embed-text-v1.5@q4_k_m`).
 *  - The long tail is the Hugging Face GGUF form an Ollama route may name directly. Rendering
 *    the 4000 most-downloaded GGUF repos as `ollama:hf.co/<org>/<repo>:Q4_K_M` gives p50 59,
 *    p99 101, longest 120 -- 66 of those 4000 are past 96, which is how the old ceiling came
 *    to refuse a working model.
 *
 * So the ceiling is the structural worst case of that longest form, not a percentile of it:
 *
 *     ollama:hf.co/   13   fixed prefix
 *     <namespace>     32   Hugging Face namespace; max observed 30 over 3395 sampled
 *     /                1
 *     <repo>          96   Hugging Face's own documented repo-name cap (`huggingface_hub`
 *                          rejects longer); over 11325 sampled ids the max is exactly 96
 *     :                1
 *     <quant>         16   GGUF quant tag; longest of 53 distinct real tags is 10
 *                          (`UD-Q4_K_XL`)
 *                    ---
 *                    159  -> 160
 *
 * That leaves the built-in catalog 83 bytes of headroom and admits every real reference above,
 * while still refusing anything that is a payload rather than an identifier: the 400-byte,
 * 70,000-byte and 270,000-byte "model ids" that previous review rounds had riding the
 * `/v1/info` wire twice each are all still refused here, at the one place a reference is
 * constructed.
 */
export const MAX_MODEL_REFERENCE_BYTES = 160;

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
 * Two independent guarantees about a parsed reference, which is handed to every operator
 * surface that names a model and quoted verbatim by each of them without re-validation.
 *
 * CONTENT is absolute and cannot be repaired downstream: a control or formatting code point
 * moves the cursor or hides itself, which is what lets a model id restyle the diagnostic
 * quoting it or forge a second line inside it. No legitimate model id contains one, and every
 * renderer is line-oriented, so this is refused at the source rather than escaped six times over.
 *
 * LENGTH is a containment bound and nothing more (see `MAX_MODEL_REFERENCE_BYTES`). It is
 * deliberately NOT the width any particular renderer can print: a surface too narrow for a
 * legitimate reference truncates it -- `sanitizeModelReferenceText` in
 * @mono-agent/runtime-adapter, on that layer's own `MODEL_REFERENCE_ECHO_MAX_BYTES` -- and
 * truncating an echo costs a diagnostic some characters, whereas refusing a reference costs an
 * operator a model that works.
 *
 * Runs last, after `rejectRemovedRuntimeReference`, so a retired backend still gets its
 * concrete repair named (`codex:x` -> `openai-codex:x`) instead of a generic shape complaint.
 * Rejection messages are operator-supplied text too, but they are bounded where they are
 * rendered, by `sanitizeModelReferenceText`; the two halves compose.
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
