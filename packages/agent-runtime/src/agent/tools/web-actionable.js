// @ts-check
/**
 * Shared managed web-research response contract for WebSearch and WebFetch.
 *
 * Interaction design is Hound-inspired (compact actionable envelope, focused
 * views, typed continuations); this envelope module remains independently
 * implemented. Native extraction adaptations carry their own source and
 * license notices.
 * Provider selection, admission, budget, cooldown, and sandbox enforcement
 * stay in the existing controller and providers — this module only shapes what
 * the model sees and guarantees the typed action surface.
 *
 * Envelope statuses (exact):
 * - ok: complete usable output.
 * - partial: usable but incomplete output. Lossy search truncation, Parallel
 *   excerpts-only extraction, a static fallback after render failure, a
 *   focus-filtered page subset, or a focus with no matching blocks.
 * - blocked: policy, access, or budget prevents progress. Sandbox network
 *   denial, site access challenge/authentication, rate limit/cooldown,
 *   exhausted search budget, or unavailable coordination. Never retry these
 *   blindly and never suggest a bypass.
 * - error: execution or provider failure. Invalid input, transport failures,
 *   HTTP errors, extraction failures, oversize input, aborts, and deadlines.
 *
 * Model-facing payload is compact JSON text. Fields that carry untrusted
 * provider or page text are named in `untrusted_fields`; host-generated
 * summary, coverage, and next_actions never quote provider prose, page bodies,
 * headers, or credentials. Absent optional fields are omitted, never padded.
 * The structured `outcome` mirrors the envelope's status, code, coverage, and
 * next_actions rather than diverging from them.
 */

/** @type {readonly ["ok", "partial", "blocked", "error"]} */
export const WEB_RESEARCH_STATUSES = Object.freeze(["ok", "partial", "blocked", "error"]);

export const WEB_RESEARCH_STATUS_DOC = Object.freeze({
  ok: "Complete usable output.",
  partial: "Usable but incomplete output (lossy truncation, excerpts-only, static render fallback, or a focus-filtered subset).",
  blocked: "Policy, access, or budget prevents progress; do not retry blindly or bypass.",
  error: "Execution or provider failure.",
});

/**
 * Terminal failure codes that classify as `blocked` (policy/access/budget
 * prevents progress). Every other failure code classifies as `error`.
 * `http_429` is the local fetch encoding of a rate limit: the server refused
 * the request for budget reasons, so it is blocked rather than a generic
 * execution error. Other `http_*` codes stay errors. Success and
 * partial-success codes (`ok`, `no_results`, `ok_static_render_failed`,
 * `ok_excerpts_only`, `focus_no_match`, `focus_applied`) are assigned by the
 * caller, never through this mapping.
 * @type {ReadonlySet<string>}
 */
export const BLOCKED_WEB_CODES = Object.freeze(new Set([
  "network_denied",
  "redirect_network_denied",
  "access_challenge",
  "authentication_required",
  "search_budget_exhausted",
  "coordination_unavailable",
  "rate_limited",
  "http_429",
  "quota_unavailable",
  "quota_reserved",
]));

/**
 * @param {unknown} code
 * @returns {"blocked"|"error"}
 */
export function webStatusForCode(code) {
  return typeof code === "string" && BLOCKED_WEB_CODES.has(code) ? "blocked" : "error";
}

/**
 * @param {unknown} code
 */
export function isBlockedWebCode(code) {
  return typeof code === "string" && BLOCKED_WEB_CODES.has(code);
}

export const WEB_FOCUS_MAX_CHARS = 500;
export const WEB_FETCH_LINK_LIMIT = 20;
export const WEB_FETCH_LINK_URL_MAX_CHARS = 2000;
export const WEB_FETCH_LINK_TEXT_MAX_CHARS = 200;
export const WEB_NEXT_ACTION_REASON_MAX_CHARS = 300;

/**
 * Validate the research-contract fetch options shared by the controller fast
 * path and the local/parallel execution paths. Focus and link selection are
 * post-extraction views: they never change transport or cache identity.
 *
 * @param {{focus?: unknown, include_links?: unknown}} params
 * @returns {{focus: string|undefined, includeLinks: boolean, error?: {code: string, message: string}}}
 */
export function normalizeWebResearchOptions(params) {
  let focus;
  if (params.focus !== undefined) {
    if (typeof params.focus !== "string" || !params.focus.trim()) {
      return { focus: undefined, includeLinks: false, error: { code: "invalid_focus", message: "Error: WebFetch focus must be a non-empty string." } };
    }
    const trimmed = params.focus.trim();
    if ([...trimmed].length > WEB_FOCUS_MAX_CHARS) {
      return { focus: undefined, includeLinks: false, error: { code: "invalid_focus", message: `Error: WebFetch focus must be at most ${WEB_FOCUS_MAX_CHARS} characters.` } };
    }
    focus = trimmed;
  }
  if (params.include_links !== undefined && typeof params.include_links !== "boolean") {
    return { focus: undefined, includeLinks: false, error: { code: "invalid_include_links", message: "Error: WebFetch include_links must be a boolean." } };
  }
  return { focus, includeLinks: params.include_links === true };
}

/**
 * Deterministic post-extraction focus: keep the blocks (blank-line separated
 * paragraphs) relevant to the focus string, preserving document order and
 * provenance. No model, no network, no randomness. A focus with no usable
 * terms constrains nothing and returns the full body.
 *
 * @param {unknown} body
 * @param {string} focus
 * @returns {{text: string, matchedBlocks: number, totalBlocks: number}}
 */
export function applyFocusFilter(body, focus) {
  const source = String(body ?? "");
  const blocks = source.split(/\n\s*\n/u).map((block) => block.trim()).filter(Boolean);
  const totalBlocks = blocks.length;
  if (totalBlocks === 0) return { text: "", matchedBlocks: 0, totalBlocks: 0 };
  const terms = uniqueTerms(comparableText(focus));
  const required = terms.length >= 3 ? 2 : terms.length >= 1 ? 1 : 0;
  if (required === 0) return { text: source, matchedBlocks: totalBlocks, totalBlocks };
  const matched = blocks.filter((block) => {
    const haystack = comparableText(block);
    let hits = 0;
    for (const term of terms) {
      if (haystack.includes(term)) hits += 1;
      if (hits >= required) return true;
    }
    return false;
  });
  return { text: matched.join("\n\n"), matchedBlocks: matched.length, totalBlocks };
}

/**
 * Build one typed host-generated next action. The tool name and arguments are
 * validated against the built-in schemas so the model receives only
 * immediately callable, policy-safe continuations. Returns null when the
 * candidate is not schema-valid — callers omit it rather than emitting a
 * broken or executable-from-prose hint. Continuations reuse the existing
 * line-range parameters and preserve the caller's extraction options.
 *
 * @param {unknown} tool
 * @param {any} args
 * @param {unknown} [reason]
 * @returns {{tool: string, args: any, reason?: string}|null}
 */
export function buildWebNextAction(tool, args, reason) {
  if (tool !== "WebFetch" && tool !== "WebSearch") return null;
  const valid = tool === "WebFetch" ? validWebFetchArgs(args) : validWebSearchArgs(args);
  if (valid === null) return null;
  /** @type {{tool: string, args: any, reason?: string}} */
  const action = { tool, args: valid };
  const note = typeof reason === "string" ? reason.trim().replace(/\s+/gu, " ") : "";
  if (note) action.reason = [...note].length > WEB_NEXT_ACTION_REASON_MAX_CHARS
    ? `${[...note].slice(0, WEB_NEXT_ACTION_REASON_MAX_CHARS - 1).join("").trimEnd()}…`
    : note;
  return action;
}

/**
 * Serialize the actionable envelope for the model. Compact single-line JSON;
 * undefined fields are omitted, never padded.
 * @param {Record<string, any>} envelope
 */
export function formatActionableEnvelope(envelope) {
  return JSON.stringify(envelope);
}

/**
 * Parse a model-facing envelope back into an object. Used only by host code
 * (cache refresh); never applied to untrusted page or provider text.
 * @param {unknown} text
 * @returns {any|null}
 */
export function parseActionableEnvelope(text) {
  if (typeof text !== "string" || !text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Refresh a cached WebSearch envelope with the consuming run's budget without
 * re-querying. Returns the refreshed JSON text, or null when the cached text
 * is not a search envelope (legacy or corrupt entries fall back to a miss).
 *
 * @param {unknown} text
 * @param {{requestsUsed?: number, requestsThisCall?: number, requestsRemaining?: number, maxRequestsPerRun?: number, dispatchesUsed?: number, maxDispatches?: number, dispatchesRemaining?: number, retryInRun?: boolean}} budget
 * @param {unknown} requestedQuery
 */
export function refreshCachedSearchEnvelope(text, budget, requestedQuery) {
  const parsed = parseActionableEnvelope(text);
  if (!parsed || parsed.tool !== "WebSearch" || !parsed.coverage || typeof parsed.coverage !== "object") return null;
  const query = typeof requestedQuery === "string" ? requestedQuery.replace(/\s+/gu, " ").trim().slice(0, 500) : "";
  const requestsRemaining = budget.requestsRemaining ?? parsed.coverage.requestsRemaining;
  parsed.coverage = {
    ...parsed.coverage,
    requestsUsed: budget.requestsUsed ?? parsed.coverage.requestsUsed,
    requestsThisCall: 0,
    requestsRemaining,
    ...(budget.maxRequestsPerRun === undefined ? {} : { maxRequestsPerRun: budget.maxRequestsPerRun }),
    ...(budget.dispatchesUsed === undefined ? {} : { dispatchesUsed: budget.dispatchesUsed }),
    ...(budget.maxDispatches === undefined ? {} : { maxDispatches: budget.maxDispatches }),
    ...(budget.dispatchesRemaining === undefined ? {} : { dispatchesRemaining: budget.dispatchesRemaining }),
    retryInRun: typeof requestsRemaining === "number" ? requestsRemaining > 0 : parsed.coverage.retryInRun,
    cacheHit: true,
    attemptedBackends: [],
    actualQueries: query ? [query] : [],
    providerAttempts: [],
    failureSummary: [],
    providerFailureCount: 0,
    rateLimited: false,
    cooldownBackends: [],
    fallbackUsed: false,
  };
  return formatActionableEnvelope(parsed);
}

/**
 * Failure envelope shared by controller fast paths. Status derives from the
 * stable code via the blocked mapping; the summary is host-generated.
 *
 * @param {"WebSearch"|"WebFetch"} tool
 * @param {string} code
 * @param {string} summary
 * @param {{attempts?: number}} [telemetry]
 */
export function webFailureEnvelope(tool, code, summary, telemetry = {}) {
  const text = formatActionableEnvelope({ tool, status: webStatusForCode(code), code, summary });
  return {
    text,
    outcome: {
      status: webStatusForCode(code),
      code,
      retryable: false,
      attempts: telemetry.attempts ?? 0,
      backend: "none",
      cacheHit: false,
      durationMs: 0,
      bytes: Buffer.byteLength(text, "utf8"),
      truncated: false,
    },
    error: true,
  };
}

/**
 * Strip disallowed next actions from a model-facing envelope and its outcome.
 * The predicate receives each action and returns true to keep it; a throwing
 * predicate conservatively drops that action. Returns null when the text is
 * not an envelope, carries no next_actions, or nothing was removed — callers
 * keep their originals in that case. When actions are removed the envelope is
 * re-serialized without an empty next_actions key, outcome.next_actions is
 * updated or deleted to agree, and outcome.bytes is refreshed. Hints confer
 * no authority: only policy- and capability-allowed actions are emitted.
 *
 * @param {unknown} text
 * @param {any} outcome
 * @param {(action: any) => boolean} predicate
 * @returns {{text: string, outcome: any}|null}
 */
export function filterEnvelopeNextActions(text, outcome, predicate) {
  const parsed = parseActionableEnvelope(text);
  if (!parsed || !Array.isArray(parsed.next_actions)) return null;
  let kept;
  try {
    kept = parsed.next_actions.filter((action) => {
      try {
        return predicate(action) === true;
      } catch {
        return false;
      }
    });
  } catch {
    return null;
  }
  if (kept.length === parsed.next_actions.length) return null;
  const next = { ...parsed };
  if (kept.length > 0) next.next_actions = kept;
  else delete next.next_actions;
  const filteredText = formatActionableEnvelope(next);
  const nextOutcome = outcome && typeof outcome === "object" && !Array.isArray(outcome)
    ? { ...outcome }
    : {};
  if (kept.length > 0) nextOutcome.next_actions = kept;
  else delete nextOutcome.next_actions;
  nextOutcome.bytes = Buffer.byteLength(filteredText, "utf8");
  return { text: filteredText, outcome: nextOutcome };
}

function comparableText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function uniqueTerms(haystack) {
  const out = [];
  for (const term of haystack.split(" ")) {
    if (term.length < 3 || out.includes(term)) continue;
    out.push(term);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * @param {any} args
 */
function validWebFetchArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const { url, start_line, max_lines, format, render, focus, include_links } = args;
  if (typeof url !== "string" || !isHttpUrl(url) || url.length > 8192) return null;
  /** @type {Record<string, any>} */
  const valid = { url };
  if (start_line !== undefined) {
    if (!Number.isSafeInteger(start_line) || start_line < 1) return null;
    valid.start_line = start_line;
  }
  if (max_lines !== undefined) {
    if (!Number.isSafeInteger(max_lines) || max_lines < 1 || max_lines > 10000) return null;
    valid.max_lines = max_lines;
  }
  if (format !== undefined) {
    if (!["markdown", "text", "raw"].includes(format)) return null;
    valid.format = format;
  }
  if (render !== undefined) {
    if (!["never", "auto", "always"].includes(render)) return null;
    valid.render = render;
  }
  if (focus !== undefined) {
    if (typeof focus !== "string" || !focus.trim() || [...focus.trim()].length > WEB_FOCUS_MAX_CHARS) return null;
    valid.focus = focus.trim();
  }
  if (include_links !== undefined) {
    if (typeof include_links !== "boolean") return null;
    if (include_links) valid.include_links = true;
  }
  return valid;
}

/**
 * @param {any} args
 */
function validWebSearchArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const { query, limit, alternate_queries, domains, exclude_domains, language, time_range } = args;
  if (typeof query !== "string" || !query.trim() || query.trim().length > 500) return null;
  /** @type {Record<string, any>} */
  const valid = { query: query.trim() };
  if (limit !== undefined) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) return null;
    valid.limit = limit;
  }
  if (alternate_queries !== undefined) {
    if (!Array.isArray(alternate_queries) || alternate_queries.length > 3
      || alternate_queries.some((entry) => typeof entry !== "string" || !entry.trim())) return null;
    valid.alternate_queries = alternate_queries.map((entry) => entry.trim());
  }
  for (const key of ["domains", "exclude_domains"]) {
    const values = key === "domains" ? domains : exclude_domains;
    if (values !== undefined) {
      if (!Array.isArray(values) || values.length > 10 || values.some((entry) => typeof entry !== "string")) return null;
      valid[key] = values;
    }
  }
  if (language !== undefined) {
    if (typeof language !== "string") return null;
    valid.language = language;
  }
  if (time_range !== undefined) {
    if (!["day", "month", "year"].includes(time_range)) return null;
    valid.time_range = time_range;
  }
  return valid;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return false;
    return true;
  } catch {
    return false;
  }
}
