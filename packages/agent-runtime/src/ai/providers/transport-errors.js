// Recover the real reason behind opaque provider transport failures.
//
// Node's fetch (undici) reports a cut response body as `TypeError: terminated`
// with the actual reason — UND_ERR_BODY_TIMEOUT, ECONNRESET, "other side
// closed" — only on `error.cause`. Several layers between the socket and us
// flatten errors to `error.message`, most notably pi-agent-core's
// `handleRunFailure`, which stores `error.message` and drops the cause before
// any mono-agent code sees the Error object. The result is a run that fails
// with the single uninformative word "terminated".
//
// Two recovery paths, in order of trustworthiness:
//
//   1. `describeErrorCause` walks the cause chain of an Error we still hold.
//      Exact, but only available where the original object survives.
//   2. `recentTransportErrorCode` reads a bounded ring of `undici:request:error`
//      diagnostics-channel events. This sees the error before any library
//      flattens it, at the cost of attribution: the channel is process-wide, so
//      with concurrent requests in flight we cannot prove which run a given
//      socket error belongs to. Correlation is reported as such, and a window
//      containing conflicting codes reports ambiguity instead of guessing.

import diagnosticsChannel from "node:diagnostics_channel";

// Messages that carry no diagnostic content on their own. Annotating only these
// keeps already-descriptive provider errors untouched.
const OPAQUE_ERROR_RE = /^(?:terminated|fetch failed|connection error\.?|network error|socket hang up|premature close|other side closed)$/i;

const MAX_RECORDED = 32;
// A stream cut is observed on the socket within milliseconds of the rejection
// surfacing. Anything older is a different request's failure.
const DEFAULT_CORRELATION_WINDOW_MS = 5_000;
const MAX_CAUSE_DEPTH = 5;

/** @type {{code: string, at: number, origin: string|null}[]} */
const recorded = [];
let installed = false;

function codeFromError(error) {
  if (!error || typeof error !== "object") return null;
  const code = error.code ?? error.errno;
  if (typeof code === "string" && code.trim()) return code.trim();
  // Undici's timeout errors expose a stable `name` even when `code` is absent.
  const name = typeof error.name === "string" ? error.name.trim() : "";
  if (name && name !== "Error" && name !== "TypeError") return name;
  return null;
}

/**
 * Walk an error's `cause` chain and return the first transport-level code found.
 * Returns null when the chain carries no code (i.e. nothing worth appending).
 * @param {unknown} error
 * @returns {string|null}
 */
export function describeErrorCause(error) {
  /** @type {any} */
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth += 1) {
    // Skip the outermost error: its code (if any) is what the caller already
    // has. We want the reason underneath it.
    if (depth > 0) {
      const code = codeFromError(current);
      if (code) return code;
    }
    current = current?.cause;
  }
  return null;
}

/**
 * Subscribe to undici's request-error channel. Idempotent and safe to call on
 * every run; a Node build without the channel simply records nothing.
 */
export function installTransportErrorProbe() {
  if (installed) return;
  installed = true;
  try {
    diagnosticsChannel.subscribe("undici:request:error", (/** @type {any} */ message) => {
      const error = message?.error;
      const code = codeFromError(error) || describeErrorCause(error);
      if (!code) return;
      /** @type {string|null} */
      let origin = null;
      try {
        const raw = message?.request?.origin;
        origin = typeof raw === "string" ? raw : (raw?.origin ?? null);
      } catch {
        origin = null;
      }
      recorded.push({ code, at: Date.now(), origin });
      if (recorded.length > MAX_RECORDED) recorded.splice(0, recorded.length - MAX_RECORDED);
    });
  } catch {
    // Channel unavailable on this runtime: fall back to cause-chain walking only.
    installed = false;
  }
}

/**
 * Most recent transport error code seen within the correlation window.
 * `ambiguous` is true when the window holds more than one distinct code, in
 * which case attribution to a specific run would be a guess.
 * @param {{withinMs?: number, now?: number}} [opts]
 * @returns {{code: string, ambiguous: boolean}|null}
 */
export function recentTransportErrorCode(opts = {}) {
  const withinMs = Number.isFinite(Number(opts.withinMs))
    ? Number(opts.withinMs)
    : DEFAULT_CORRELATION_WINDOW_MS;
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const fresh = recorded.filter((entry) => now - entry.at <= withinMs);
  if (fresh.length === 0) return null;
  const distinct = new Set(fresh.map((entry) => entry.code));
  return { code: fresh[fresh.length - 1].code, ambiguous: distinct.size > 1 };
}

/**
 * Append the underlying transport reason to an otherwise contentless provider
 * error. Descriptive messages, and messages that already name their cause, are
 * returned unchanged.
 *
 * @param {string|null} message normalized provider error text
 * @param {unknown} [error] the original Error, when it survived
 * @returns {{message: string|null, causeCode: string|null, causeSource: "cause_chain"|"transport_probe"|null}}
 */
export function annotateProviderErrorMessage(message, error) {
  const text = String(message || "").trim();
  if (!text) return { message: message ?? null, causeCode: null, causeSource: null };
  if (!OPAQUE_ERROR_RE.test(text)) return { message: text, causeCode: null, causeSource: null };

  const fromChain = describeErrorCause(error);
  if (fromChain) {
    return { message: `${text} (${fromChain})`, causeCode: fromChain, causeSource: "cause_chain" };
  }

  const correlated = recentTransportErrorCode();
  if (correlated && !correlated.ambiguous) {
    return {
      message: `${text} (${correlated.code}, correlated)`,
      causeCode: correlated.code,
      causeSource: "transport_probe",
    };
  }
  return { message: text, causeCode: null, causeSource: null };
}

/** Test seam: drop recorded transport errors. */
export function resetTransportErrorProbeForTests() {
  recorded.length = 0;
}

/** Test seam: record a transport error without a real socket. */
export function recordTransportErrorForTests(code, at = Date.now()) {
  recorded.push({ code, at, origin: null });
}
