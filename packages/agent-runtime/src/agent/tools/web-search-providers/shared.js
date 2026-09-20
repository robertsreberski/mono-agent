// @ts-check
import { coordinatedWebRequest, webRequestFailure } from "../web-request.js";
import { createCountingSemaphore } from "../shared/semaphore.js";
import { claimWebSearchRequest } from "../web-search-state.js";
const SEARCH_TIMEOUT_MS = 15_000;
const SEARCH_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
// Keyless engines rate-limit by source IP, and one agent can hammer them from
// many directions at once: a single WebSearch fans out to up to four queries,
// and every subagent runs its own web controller, so nothing below this module
// sees the aggregate. Measured against html.duckduckgo.com: ~8 requests in ~4s
// served normally, ~12 in ~5s tripped an `HTTP 202` anomaly page that persisted
// for over two minutes. These bounds therefore live at MODULE scope so they
// apply process-wide (one process is one agent instance), not per run.
const KEYLESS_DEFAULT_THROTTLE = {
  // Simultaneous in-flight keyless requests across the whole process.
  maxConcurrency: 3,
  // Minimum gap between two requests to the SAME keyless backend, i.e. ~0.67/s
  // against roughly 2.4/s measured to trip a ban. The asymmetry is deliberate:
  // being too slow costs a few seconds on a multi-query search, while being too
  // fast costs a five-minute outage that escalates from a 202 challenge to an
  // outright 403. Only the fan-out pays it — a single-query search never waits.
  minSpacingMs: 1_500,
  // How long a backend stays skipped after it signals rate limiting. Observed
  // blocks outlasted several minutes, so this is deliberately longer.
  cooldownMs: 5 * 60_000,
};
// Markers that identify an interstitial/bot-gate body served with a 2xx status.
// The last two are Anubis, the proof-of-work gate Startpage now fronts its
// results with. It says none of the classic things — no captcha, no anomaly,
// just "Verifying your request..." — so without these it read as a clean 200
// that happened to parse to nothing, which is exactly the lie this guard exists
// to prevent.
const CHALLENGE_BODY_RE =
  /anomaly|unusual traffic|captcha|are you a robot|challenge-(?:platform|form)|anubis[_-]?challenge|verifying your request/iu;
// Reasons SearXNG reports for an engine that is being throttled or gated rather
// than merely erroring, e.g. "CAPTCHA", "too many requests", "Suspended: CAPTCHA".

// Statuses these engines use to say "you are sending too much", all of which
// must put the backend into cooldown rather than be retried next search.
const RATE_LIMIT_STATUSES = new Set([202, 403, 429]);

let keylessThrottle = { ...KEYLESS_DEFAULT_THROTTLE };
let keylessSemaphore = createCountingSemaphore(keylessThrottle.maxConcurrency);
/** @type {Map<string, number>} Backend -> epoch ms until which it is skipped. */
const backendCooldownUntil = new Map();
/** @type {Map<string, number>} Backend -> epoch ms its next request may start. */
const backendNextAvailableAt = new Map();
/** @type {Map<string, ReturnType<typeof createCountingSemaphore>>} */
const processProviderSemaphores = new Map();
const TRACKING_PARAMETERS = new Set([
  "dclid",
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "mkt_tok",
  "msclkid",
  "ref_src",
  "s_cid",
  "vero_conv",
  "vero_id",
]);
export function backendInCooldown(backend, key = backend) {
  const cooldownKey = processCooldownKey(backend, key);
  const until = backendCooldownUntil.get(cooldownKey);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    backendCooldownUntil.delete(cooldownKey);
    return false;
  }
  return true;
}

export function processCooldownKey(backend, key) {
  return `${backend}:${String(key)}`;
}

export function processCooldownRemaining(backend, key = backend) {
  return Math.max(0, (backendCooldownUntil.get(processCooldownKey(backend, key)) ?? Date.now()) - Date.now());
}

/**
 * Atomically claims this backend's next send slot and reports how long the
 * caller must wait for it. Synchronous on purpose: concurrent callers each
 * reserve a distinct slot instead of all reading the same "last sent at".
 *
 * @returns {number} Milliseconds to wait before sending.
 */
export function reserveKeylessSlot(backend) {
  const now = Date.now();
  const earliest = Math.max(now, backendNextAvailableAt.get(backend) ?? 0);
  backendNextAvailableAt.set(backend, earliest + keylessThrottle.minSpacingMs);
  return earliest - now;
}

// Deliberately NOT unref'd: this delay is part of an in-flight search the
// caller is awaiting. An unref'd timer lets the event loop drain while the
// search is still pending, and a one-shot CLI turn then exits mid-query.
// Cancellation is the signal's job, not the timer's.
export function sleep(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      clearTimeout(timer);
      // Named so fetchFailure classifies it alongside every other abort.
      rejectPromise(Object.assign(new Error("WebSearch was aborted."), { name: "AbortError" }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolvePromise();
    }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/**
 * Test hook: restores the shipped throttle values and clears cooldown/spacing
 * state. Module-scoped state would otherwise leak between test cases.
 *
 * @param {{maxConcurrency?: number, minSpacingMs?: number, cooldownMs?: number}} [overrides]
 */
export function __resetWebSearchThrottleForTests(overrides = {}) {
  keylessThrottle = { ...KEYLESS_DEFAULT_THROTTLE, ...overrides };
  keylessSemaphore = createCountingSemaphore(keylessThrottle.maxConcurrency);
  backendCooldownUntil.clear();
  backendNextAvailableAt.clear();
  processProviderSemaphores.clear();
}

export async function keylessHtmlSearch(spec, options) {
  if (!options.sandbox.networkAllowsUrl(options.policy, spec.url)) {
    return { ok: false, backend: spec.backend, message: "Network access denied by sandbox policy.", retryable: false };
  }
  let release;
  try {
    release = await keylessSemaphore.acquire(options.signal);
  } catch {
    // Queued behind the concurrency bound when the turn was cancelled.
    return { ok: false, backend: spec.backend, message: "WebSearch was aborted.", retryable: false };
  }
  try {
    const waitMs = reserveKeylessSlot(spec.backend);
    if (waitMs > 0) await sleep(waitMs, options.signal);
    // Query variants all clear the cooldown check together and then queue here,
    // so by the time this one is admitted a sibling may already have been
    // blocked. Without this second look the very first block still costs a full
    // round of requests against a backend we know is refusing them.
    if (backendInCooldown(spec.backend, spec.backend)) {
      return {
        ok: false,
        backend: spec.backend,
        message: `${spec.backend} skipped: cooling down after rate limiting.`,
        retryable: true,
        cooldown: true,
      };
    }
    claimWebSearchRequest(options.searchState, spec.backend, options.callClaims);
    const response = await options.fetchImpl(spec.url, {
      // "manual", not "error": these engines answer a throttled query with a
      // redirect to a captcha page, and "error" collapses that into an opaque
      // `TypeError: fetch failed` with no way to tell it from a real outage.
      // The redirect is still never followed, so the open-redirect guard holds.
      redirect: "manual",
      ...(spec.init || {}),
      // Headers are merged last on purpose: spreading `spec.init` afterwards
      // would replace the whole headers object with the backend's few extra
      // entries, and a Startpage POST without a User-Agent gets bot-gated.
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": options.language || "en-US,en;q=0.8",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) mono-agent-web/1",
        ...(spec.init?.headers || {}),
      },
      signal: requestSignal(options.signal),
    });
    const html = await readLimitedText(response);
    // Startpage answers a blocked source IP with `303 -> /sp/captcha-block`.
    // The destination is the block itself, never results, so following it only
    // costs a round trip and still parses to nothing.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") || "";
      return rateLimited(spec, /captcha|blocked|sorry|challenge/iu.test(location)
        ? "captcha redirect"
        : `HTTP ${response.status} redirect`);
    }
    // 202 is DuckDuckGo's soft challenge (and is `ok`, so status alone would let
    // an interstitial through as an empty success); 403 is what it escalates to
    // once it stops asking politely. No credentials are ever sent to these
    // endpoints, so a 403 can only mean "blocked", never "unauthorized".
    if (RATE_LIMIT_STATUSES.has(response.status)) {
      return rateLimited(spec, `HTTP ${response.status}`, response);
    }
    if (!response.ok) {
      return {
        ok: false,
        backend: spec.backend,
        message: `${spec.label} HTTP ${response.status}`,
        retryable: response.status >= 500,
      };
    }
    const results = spec.parse(html);
    // A 200 that parses to nothing is ambiguous: either a genuinely empty
    // result set or a bot gate. Only the body markers tell them apart, and
    // conflating them is what made a ban look like "No results."
    if (results.length === 0 && CHALLENGE_BODY_RE.test(html)) {
      return rateLimited(spec, "interstitial challenge page");
    }
    return { ok: true, backend: spec.backend, results };
  } catch (error) {
    return fetchFailure(spec.backend, error, spec.label);
  } finally {
    release();
  }
}

export function rateLimited(spec, detail, response) {
  const retryAfterMs = parseRetryAfter(response) ?? keylessThrottle.cooldownMs;
  const retryAtMs = Date.now() + retryAfterMs;
  backendCooldownUntil.set(processCooldownKey(spec.backend, spec.backend), retryAtMs);
  return {
    ok: false,
    backend: spec.backend,
    message: `${spec.label} rate-limited (${detail})`,
    retryAfterMs,
    retryAtMs,
    retryable: true,
    rateLimited: true,
  };
}

export function normalizedResult(entry, backend) {
  if (!entry || typeof entry !== "object") return [];
  const url = canonicalizeSearchUrl(entry.url);
  if (!url) return [];
  return [{
    title: collapseWhitespace(entry.title) || url,
    url,
    snippet: collapseWhitespace(entry.content || entry.snippet),
    backend,
  }];
}

export function canonicalizeSearchUrl(value, base) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  let parsed;
  try { parsed = new URL(value, base); } catch { return null; }
  const wrapped = ["uddg", "url", "u", "target"].map((key) => parsed.searchParams.get(key)).find(Boolean);
  if (wrapped && (
    (parsed.hostname === "duckduckgo.com" || parsed.hostname.endsWith(".duckduckgo.com"))
    || (parsed.hostname === "startpage.com" || parsed.hostname.endsWith(".startpage.com"))
  )) {
    try { parsed = new URL(wrapped); } catch { /* keep the wrapper URL */ }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.searchParams.sort();
  if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) {
    parsed.port = "";
  }
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return parsed.href;
}

export function cooldownBackendNames(searchState) {
  const processNames = [...backendCooldownUntil.keys()].map((key) => key.split(":", 1)[0]);
  const runNames = [...(searchState?.deferredProviders?.keys?.() ?? [])];
  return [...new Set([...processNames, ...runNames])];
}

export function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

export function escapeMarkdownLabel(value) {
  return collapseWhitespace(value).replace(/[[\]\\]/gu, "\\$&");
}

export function requestSignal(signal) {
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function readLimitedText(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > SEARCH_RESPONSE_MAX_BYTES) {
      throw Object.assign(new Error(`search response exceeded ${SEARCH_RESPONSE_MAX_BYTES} bytes`), { code: "response_too_large" });
    }
    return text;
  }
  const chunks = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > SEARCH_RESPONSE_MAX_BYTES) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw Object.assign(new Error(`search response exceeded ${SEARCH_RESPONSE_MAX_BYTES} bytes`), { code: "response_too_large" });
    }
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// undici reports transport problems as a bare `TypeError: fetch failed` and
// keeps the real reason on `error.cause` — dropping it is what left an
// "unexpected redirect" looking like an unexplained network fault.
const RETRYABLE_FETCH_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function fetchFailure(backend, error, label = backend) {
  const name = error?.name;
  const code = error?.code ?? error?.cause?.code;
  const retryable = code !== "search_budget_exhausted" && (name === "AbortError"
    || name === "TimeoutError"
    || RETRYABLE_FETCH_CODES.has(code));
  const message = error?.message || String(error);
  const cause = error?.cause?.message;
  const detail = cause && cause !== message ? `${message} (${cause})` : message;
  return {
    ok: false,
    backend,
    message: `${label} request failed: ${detail}`,
    retryable,
    ...(code === undefined ? {} : { code }),
    ...(error?.reason === "dispatch_ceiling" ? { reason: "dispatch_ceiling" } : {}),
  };
}

export function ollamaFetchFailure(error, signal) {
  const base = fetchFailure("ollama", error, "Ollama Web Search");
  const abortCode = signal?.aborted
    ? (signal.reason?.code === "deadline_exceeded" ? "deadline_exceeded" : "aborted")
    : undefined;
  const suppliedCode = error?.code ?? error?.cause?.code;
  const code = abortCode
    || (suppliedCode === "search_budget_exhausted" ? "search_budget_exhausted" : undefined)
    || (suppliedCode === "deadline_exceeded" ? "deadline_exceeded" : undefined)
    || (suppliedCode === "response_too_large" ? "response_too_large" : undefined)
    || (suppliedCode === "invalid_response" ? "invalid_response" : undefined)
    || (error?.name === "AbortError" ? "aborted" : undefined)
    || (error?.name === "TimeoutError" ? "timeout" : undefined)
    || "provider_unavailable";
  return {
    ...base,
    code,
    retryable: !["aborted", "response_too_large", "invalid_response", "search_budget_exhausted"].includes(code),
  };
}

export async function guardedSearch(kind, key, options, execute) {
  try {
    // Preserve the keyless pre-admission fast skip: a process cooldown must not
    // reserve a spacing slot or wait for either local or host admission.
    if (options.admission?.processPolicy === "keyless" && backendInCooldown(kind, key)) {
      const retryAfterMs = processCooldownRemaining(kind, key);
      return { ok: false, backend: kind, message: `${kind} skipped: cooling down after rate limiting.`,
        retryable: true, cooldown: true, retryAfterMs, retryAtMs: Date.now() + retryAfterMs };
    }
    if (options.coordinator || options.admission?.processPolicy !== "endpoint") {
      return await coordinatedWebRequest(options.coordinator, kind, key, options.signal, execute);
    }
    const cooldown = processCooldownRemaining(kind, key);
    if (cooldown > 0) return processCooldownResult(kind, cooldown);
    const scopedKey = processCooldownKey(kind, key);
    let semaphore = processProviderSemaphores.get(scopedKey);
    if (!semaphore) {
      semaphore = createCountingSemaphore(1);
      processProviderSemaphores.set(scopedKey, semaphore);
    }
    const release = await semaphore.acquire(options.signal);
    try {
      const queuedCooldown = processCooldownRemaining(kind, key);
      if (queuedCooldown > 0) return processCooldownResult(kind, queuedCooldown);
      const result = await execute();
      if (result?.rateLimited) {
        const retryAfterMs = result.retryAfterMs ?? keylessThrottle.cooldownMs;
        const retryAtMs = Date.now() + retryAfterMs;
        backendCooldownUntil.set(scopedKey, retryAtMs);
        return { ...result, retryAfterMs, retryAtMs };
      }
      return result;
    } finally {
      release();
    }
  }
  catch (error) { return webRequestFailure(error, kind, options.signal); }
}

export function processCooldownResult(backend, retryAfterMs) {
  return {
    ok: false,
    backend,
    code: "rate_limited",
    message: `${backend} is cooling down.`,
    retryable: true,
    cooldown: true,
    rateLimited: true,
    retryAfterMs,
    retryAtMs: Date.now() + retryAfterMs,
  };
}

export function parseRetryAfter(response) {
  const raw = response?.headers?.get("retry-after");
  if (!raw) return undefined;
  const now = Date.now();
  const value = raw.trim();
  let ms;
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) return undefined;
    ms = seconds * 1000;
  } else {
    // Retry-After allows only an integer delta-seconds or an HTTP date. Do not
    // let Date.parse reinterpret malformed numeric values such as "1.5" as a
    // calendar date.
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(value)) return undefined;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return undefined;
    ms = parsed - now;
  }
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(8_640_000_000_000_000 - now, Math.max(1000, ms));
}


/** Shared process-wide pacing for native composite engine/robots requests.
 * The caller gates the exact URL and obtains host admission before this slot.
 * Ordinary keyless providers use the same semaphore/spacing/cooldown state.
 */
export async function acquireKeylessRequestSlot(backend, signal) {
  const release = await keylessSemaphore.acquire(signal);
  try {
    if (backendInCooldown(backend)) throw Object.assign(new Error("Engine is cooling down."), { code: "rate_limited", retryAfterMs: processCooldownRemaining(backend) });
    await sleep(reserveKeylessSlot(backend), signal);
    signal?.throwIfAborted();
    if (backendInCooldown(backend)) throw Object.assign(new Error("Engine is cooling down."), { code: "rate_limited", retryAfterMs: processCooldownRemaining(backend) });
    return release;
  } catch (error) { release(); throw error; }
}
