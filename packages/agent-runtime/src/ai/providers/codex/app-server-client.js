import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CODEX_DIAGNOSTIC_BYTES = 8 * 1024;
const CODEX_STDERR_TAIL_BYTES = 8 * 1024;
const CODEX_SHUTDOWN_GRACE_MS = 1_000;
const CODEX_KILL_GRACE_MS = 1_000;
export const CODEX_APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"];
export const CODEX_APP_SERVER_ISOLATED_ARGS = [
  ...CODEX_APP_SERVER_ARGS,
  "-c",
  "project_doc_max_bytes=0",
];

const SENSITIVE_ASSIGNMENT_RE = /((?:api[_-]?key|private[_-]?key|access[_-]?key|authorization|authentication|auth|bearer|cookie|credential|password|signature|sig|secret|token)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,\r\n]+)/giu;
const SENSITIVE_HEADER_RE = /((?:(?:proxy-)?authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]*/giu;
const SENSITIVE_JSON_LINE_RE = /("(?:api[_-]?key|private[_-]?key|access[_-]?key|authorization|authentication|auth|bearer|cookie|credential|password|signature|sig|secret|token)"\s*:\s*)[^\r\n]*/giu;
const SENSITIVE_ESCAPED_JSON_LINE_RE = /(\\"(?:api[_-]?key|private[_-]?key|access[_-]?key|authorization|authentication|auth|bearer|cookie|credential|password|signature|sig|secret|token)\\"\s*:\s*)[^\r\n]*/giu;

export function normalizedSensitiveName(name) {
  return String(name || "")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

export function isSensitivePayloadField(name) {
  const normalized = normalizedSensitiveName(name);
  return /(?:^|_)(?:token|secret|password|authorization|api_key|apikey|credential|cookie|auth|authentication|bearer|private_key|access_key|signature|sig)$/u.test(normalized);
}

function isSensitiveEnvironmentKey(name) {
  const normalized = normalizedSensitiveName(name);
  return /(?:^|_)(?:token|secret|password|authorization|api_key|apikey|credential|cookie|auth|authentication|bearer|private_key|access_key|signature|sig)(?:_|$)/u.test(normalized);
}

function boundedTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : fallback;
}

export function sensitiveEnvironmentValues(env) {
  return [...new Set(Object.entries(env || {})
    .filter(([key, value]) => isSensitiveEnvironmentKey(key) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value))]
    .sort((left, right) => right.length - left.length);
}

export function addOpaqueSensitiveValue(target, value, { splitCredentials = false } = {}) {
  if (typeof value !== "string" || value.length < 8) return;
  target.add(value);
  if (!splitCredentials) return;
  const schemeMatch = value.match(/^\s*(Bearer|Basic|Token)\s+(.+?)\s*$/iu);
  const payload = schemeMatch?.[2];
  if (payload?.length >= 8) target.add(payload);
  if (schemeMatch?.[1]?.toLowerCase() === "basic" && payload && payload.length <= 16 * 1024) {
    try {
      const decoded = Buffer.from(payload, "base64").toString("utf8");
      if (decoded && !decoded.includes("\uFFFD")) {
        addOpaqueSensitiveValue(target, decoded);
        const separator = decoded.indexOf(":");
        if (separator >= 0) {
          addOpaqueSensitiveValue(target, decoded.slice(0, separator));
          addOpaqueSensitiveValue(target, decoded.slice(separator + 1));
        }
      }
    } catch {
      // The raw Basic payload remains protected even if it is malformed.
    }
  }
}

function leadingSensitiveOverlap(text, sensitiveValue) {
  const maxLength = Math.min(text.length, sensitiveValue.length, CODEX_STDERR_TAIL_BYTES);
  if (maxLength < 8) return 0;
  const pattern = text.slice(0, maxLength);
  const failure = new Array(pattern.length).fill(0);
  for (let index = 1, matched = 0; index < pattern.length; index += 1) {
    while (matched > 0 && pattern[index] !== pattern[matched]) matched = failure[matched - 1];
    if (pattern[index] === pattern[matched]) matched += 1;
    failure[index] = matched;
  }
  let matched = 0;
  for (const character of sensitiveValue.slice(-maxLength)) {
    while (matched > 0 && character !== pattern[matched]) matched = failure[matched - 1];
    if (character === pattern[matched]) matched += 1;
  }
  return matched >= 8 ? matched : 0;
}

export function redactCodexDiagnostic(text, sensitiveValues, truncatedStart = false) {
  let redacted = String(text || "");
  for (const value of sensitiveValues) {
    if (truncatedStart) {
      const overlap = leadingSensitiveOverlap(redacted, value);
      if (overlap > 0) redacted = `[REDACTED]${redacted.slice(overlap)}`;
    }
    redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted
    .replace(SENSITIVE_HEADER_RE, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|pk|sess|oauth)[-_][A-Za-z0-9._-]{12,}\b/giu, "[REDACTED]")
    .replace(SENSITIVE_ESCAPED_JSON_LINE_RE, '$1\\"[REDACTED]\\"')
    .replace(SENSITIVE_JSON_LINE_RE, '$1"[REDACTED]"')
    .replace(SENSITIVE_ASSIGNMENT_RE, "$1[REDACTED]");
}

export function utf8Head(text, limit) {
  if (limit <= 0) return "";
  const bytes = Buffer.from(String(text || ""));
  if (bytes.length <= limit) return bytes.toString("utf8");
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function boundCodexDiagnostic(text, limit = CODEX_DIAGNOSTIC_BYTES) {
  const value = String(text || "");
  const byteLength = Buffer.byteLength(value);
  if (byteLength <= limit) return value;
  let droppedBytes = byteLength - limit;
  let marker = `\n[truncated ${droppedBytes} later bytes]`;
  let bodyLimit = Math.max(0, limit - Buffer.byteLength(marker));
  droppedBytes = byteLength - bodyLimit;
  marker = `\n[truncated ${droppedBytes} later bytes]`;
  bodyLimit = Math.max(0, limit - Buffer.byteLength(marker));
  return utf8Head(value, bodyLimit) + marker;
}

function safeDiagnosticString(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error && typeof value.message === "string") return value.message;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : String(value ?? "");
  } catch {
    try {
      return String(value);
    } catch {
      return "Codex app-server diagnostic unavailable";
    }
  }
}

export function sanitizeCodexDiagnostic(value, sensitiveValues, limit = CODEX_DIAGNOSTIC_BYTES) {
  return boundCodexDiagnostic(
    redactCodexDiagnostic(safeDiagnosticString(value), sensitiveValues),
    limit,
  );
}

function sanitizeCodexProtocolCode(value, sensitiveValues) {
  return typeof value === "number"
    ? value
    : sanitizeCodexDiagnostic(value, sensitiveValues, 256);
}

function boundedCodexDiagnosticPayload(value, sensitiveValues, limit) {
  const sanitized = redactCodexPayload(value, sensitiveValues);
  try {
    if (Buffer.byteLength(JSON.stringify(sanitized) || "") <= limit) return sanitized;
  } catch {
    // Fall through to a safe string summary for non-serializable values.
  }
  return sanitizeCodexDiagnostic(value, sensitiveValues, limit);
}

export function redactCodexPayload(value, sensitiveValues, seen = new WeakSet(), depth = 0) {
  if (typeof value === "string") return redactCodexDiagnostic(value, sensitiveValues);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) {
    const errorCode = /** @type {any} */ (value).code;
    return {
      name: redactCodexDiagnostic(value.name || "Error", sensitiveValues),
      message: sanitizeCodexDiagnostic(value.message || value, sensitiveValues),
      ...(errorCode !== undefined
        ? { code: sanitizeCodexProtocolCode(errorCode, sensitiveValues) }
        : {}),
    };
  }
  if (depth >= 20) return "[truncated nested Codex payload]";
  if (seen.has(value)) return "[circular Codex payload]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => redactCodexPayload(entry, sensitiveValues, seen, depth + 1));
    seen.delete(value);
    return result;
  }
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = isSensitivePayloadField(key)
      ? "[REDACTED]"
      : redactCodexPayload(entry, sensitiveValues, seen, depth + 1);
  }
  seen.delete(value);
  return result;
}

export function sanitizeCodexResponseError(error, sensitiveValues) {
  const sanitized = redactCodexPayload(error, sensitiveValues);
  let serialized;
  try {
    serialized = JSON.stringify(sanitized);
  } catch {
    serialized = "";
  }
  if (Buffer.byteLength(serialized || "") <= CODEX_DIAGNOSTIC_BYTES) return sanitized;

  const data = error && typeof error === "object" ? error.data : null;
  const nestedError = data && typeof data === "object" ? data.error : null;
  const info = data?.info ?? nestedError?.info ?? error?.info;
  return {
    ...(error?.code !== undefined
      ? { code: sanitizeCodexProtocolCode(error.code, sensitiveValues) }
      : {}),
    message: sanitizeCodexDiagnostic(codexErrorMessage(error), sensitiveValues, 6 * 1024),
    ...(info !== undefined
      ? { data: { info: boundedCodexDiagnosticPayload(info, sensitiveValues, 1_024) } }
      : {}),
    diagnostic_truncated: true,
  };
}

const CODEX_DIAGNOSTIC_NOTIFICATION_METHODS = new Set([
  "warning",
  "error",
  "configWarning",
  "guardianWarning",
]);

export function sanitizeCodexNotification(notification, sensitiveValues) {
  const safe = redactCodexPayload(notification, sensitiveValues);
  if (!safe || typeof safe !== "object") return safe;
  if (CODEX_DIAGNOSTIC_NOTIFICATION_METHODS.has(safe.method)) {
    const params = safe.params && typeof safe.params === "object" ? safe.params : {};
    return {
      ...safe,
      params: {
        ...(params.code !== undefined
          ? { code: sanitizeCodexProtocolCode(params.code, sensitiveValues) }
          : {}),
        message: sanitizeCodexDiagnostic(params.message || params.error || params, sensitiveValues),
      },
    };
  }
  if (safe.method === "turn/completed" && safe.params?.turn?.error !== undefined) {
    return {
      ...safe,
      params: {
        ...safe.params,
        turn: {
          ...safe.params.turn,
          error: sanitizeCodexResponseError(safe.params.turn.error, sensitiveValues),
        },
      },
    };
  }
  if ((safe.method === "item/started" || safe.method === "item/completed") && safe.params?.item?.error !== undefined) {
    return {
      ...safe,
      params: {
        ...safe.params,
        item: {
          ...safe.params.item,
          error: sanitizeCodexResponseError(safe.params.item.error, sensitiveValues),
        },
      },
    };
  }
  return safe;
}

function utf8Tail(text, limit) {
  if (limit <= 0) return "";
  const bytes = Buffer.from(String(text || ""));
  if (bytes.length <= limit) return bytes.toString("utf8");
  let start = bytes.length - limit;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function createCodexStderrTail(sensitiveValues, limit = CODEX_STDERR_TAIL_BYTES) {
  let buffer = Buffer.alloc(0);
  let bytesDropped = 0;
  return {
    push(chunk) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
      if (incoming.length === 0) return;
      if (incoming.length >= limit) {
        bytesDropped += buffer.length + incoming.length - limit;
        buffer = Buffer.from(incoming.subarray(incoming.length - limit));
        return;
      }
      const overflow = Math.max(0, buffer.length + incoming.length - limit);
      bytesDropped += overflow;
      buffer = Buffer.concat([buffer.subarray(overflow), incoming], Math.min(limit, buffer.length + incoming.length));
    },
    toString() {
      const redacted = redactCodexDiagnostic(
        buffer.toString("utf8").replace(/^\uFFFD/u, ""),
        sensitiveValues,
        bytesDropped > 0,
      ).trim();
      if (bytesDropped === 0) return utf8Tail(redacted, limit);
      const marker = `[truncated ${bytesDropped} earlier bytes]\n`;
      const bodyLimit = Math.max(0, limit - Buffer.byteLength(marker));
      return marker + utf8Tail(redacted, bodyLimit);
    },
  };
}

export function codexErrorMessage(error) {
  if (!error) return "Codex app-server error";
  if (typeof error === "string") return error;
  const data = error.data || error.error || {};
  const info = data.info || data.code || error.code;
  if (info && typeof info === "object" && "activeTurnNotSteerable" in info) {
    return "Codex active turn is not steerable";
  }
  return error.message || data.message || safeDiagnosticString(error);
}

export function isCodexRequestTimeout(error, method = null) {
  return error?.code === "CODEX_APP_SERVER_REQUEST_TIMEOUT"
    && (!method || error.method === method);
}

/**
 * @param {{command?: string, args?: string[], cwd?: any, env?: any, redactionValues?: string[], onNotification?: (msg: any) => void, onServerRequest?: (msg: any) => Promise<any> | any, shutdownGraceMs?: number, killGraceMs?: number}} [options]
 */
export function createCodexAppServerClient({
  command = "codex",
  // project_doc_max_bytes=0 keeps codex from injecting its own project docs;
  // the host supplies the full context through developerInstructions.
  args = CODEX_APP_SERVER_ISOLATED_ARGS,
  cwd,
  env = {},
  redactionValues = [],
  onNotification = () => {},
  onServerRequest = (message) => {
    throw new Error(`Unsupported Codex app-server request: ${String(message?.method || "unknown")}`);
  },
  shutdownGraceMs = CODEX_SHUTDOWN_GRACE_MS,
  killGraceMs = CODEX_KILL_GRACE_MS,
} = {}) {
  const childEnv = { ...process.env, ...env };
  const configuredSensitiveValues = new Set();
  for (const value of redactionValues) {
    addOpaqueSensitiveValue(configuredSensitiveValues, value, { splitCredentials: true });
  }
  const sensitiveValues = [...new Set([
    ...sensitiveEnvironmentValues(childEnv),
    ...configuredSensitiveValues,
  ])].sort((left, right) => right.length - left.length);
  const child = spawn(command, args, {
    cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const stderrTail = createCodexStderrTail(sensitiveValues);
  const shutdownTimers = new Set();
  let nextId = 1;
  let closed = false;
  let processSettled = false;
  let closing = false;
  /** @type {Promise<void> | null} */
  let closePromise = null;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => { resolveClosed = resolve; });

  function rejectAll(err) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    pending.clear();
  }

  function safeTransportError(error) {
    const message = sanitizeCodexDiagnostic(error?.message || error || "codex app-server failed", sensitiveValues);
    const safe = new Error(message || "codex app-server failed");
    return error?.code === undefined ? safe : Object.assign(safe, { code: error.code });
  }

  function onStderrData(chunk) {
    stderrTail.push(chunk);
  }

  child.stderr.on("data", onStderrData);

  function writeProtocolMessage(payload) {
    if (closed || child.stdin?.destroyed || child.stdin?.writableEnded) return;
    child.stdin.write(`${JSON.stringify(payload)}\n`, () => {});
  }

  function respondToServerRequest(message) {
    // Preserve request visibility for the normal event/fail-fast path, then
    // always settle the JSON-RPC request. Never leave the app-server blocked on
    // an inbound request that this unattended client cannot service.
    const safeMessage = redactCodexPayload(message, sensitiveValues);
    onNotification(safeMessage);
    Promise.resolve()
      .then(() => onServerRequest(safeMessage))
      .then(
        (result) => writeProtocolMessage({ id: message.id, result: result ?? {} }),
        () => writeProtocolMessage({
          id: message.id,
          error: { code: -32601, message: `Unsupported Codex app-server request: ${String(message.method || "unknown")}` },
        }),
      );
  }

  const rl = createInterface({ input: child.stdout });
  function warnMalformedLine(line) {
    onNotification({
      method: "warning",
      params: {
        message: sanitizeCodexDiagnostic(
          `Malformed Codex app-server output: ${line}`,
          sensitiveValues,
        ),
      },
    });
  }

  function onLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      warnMalformedLine(line);
      return;
    }
    // A JSON-RPC frame is always a non-null object. Syntactically valid JSON
    // that is not one (`null`, a scalar, an array) must be rejected here: this
    // listener runs on readline's `line` event, so `hasOwnProperty.call(null,
    // ...)` would throw an uncaught TypeError and take the host process down
    // rather than degrading to a warning.
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      warnMalformedLine(line);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "id") && (message.result !== undefined || message.error !== undefined)) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const responseError = sanitizeCodexResponseError(message.error, sensitiveValues);
        entry.reject(Object.assign(
          new Error(sanitizeCodexDiagnostic(codexErrorMessage(responseError), sensitiveValues)),
          { responseError },
        ));
      }
      else entry.resolve(message.result);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
      respondToServerRequest(message);
      return;
    }
    if (message.method) onNotification(sanitizeCodexNotification(message, sensitiveValues));
  }
  rl.on("line", onLine);

  function cleanupTransport() {
    for (const timer of shutdownTimers) clearTimeout(timer);
    shutdownTimers.clear();
    rl.off("line", onLine);
    try { rl.close(); } catch {}
    child.stderr?.off?.("data", onStderrData);
    child.off("error", onChildError);
    child.off("close", onChildClose);
    try { child.stdin?.destroy?.(); } catch {}
    try { child.stdout?.destroy?.(); } catch {}
    try { child.stderr?.destroy?.(); } catch {}
  }

  function settleClosed(error) {
    if (processSettled) return;
    processSettled = true;
    closed = true;
    rejectAll(error);
    cleanupTransport();
    resolveClosed(error);
  }

  function onChildError(error) {
    const safe = safeTransportError(error);
    closed = true;
    rejectAll(safe);
    // A spawn failure has no live process and may not emit `close`. By contrast,
    // ChildProcess also emits `error` when signaling a live child fails (EPERM,
    // ESRCH races). Only `close` proves that such a process actually exited.
    if (child.pid === undefined) {
      settleClosed(safe);
      return;
    }
    if (!closing) void close();
  }

  function onChildClose(code, signal) {
    if (closing) {
      settleClosed(new Error("codex app-server closed"));
      return;
    }
    const summary = signal === null
      ? `codex app-server exited ${code ?? "unknown"}`
      : `codex app-server terminated by ${signal}`;
    const detail = stderrTail.toString();
    settleClosed(new Error(detail ? `${summary}: ${detail}` : summary));
  }

  child.on("error", onChildError);
  child.once("close", onChildClose);

  function request(method, params, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    if (closed || child.stdin?.destroyed || child.stdin?.writableEnded) {
      return Promise.reject(new Error("codex app-server is not running"));
    }
    const id = nextId++;
    const payload = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`codex app-server request timed out: ${method}`), {
          code: "CODEX_APP_SERVER_REQUEST_TIMEOUT",
          method,
          timeoutMs,
          stderrTail: stderrTail.toString(),
        }));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (!err) return;
        pending.delete(id);
        clearTimeout(timer);
        reject(safeTransportError(err));
      });
    });
  }

  function waitForProcessClose(timeoutMs) {
    if (processSettled) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (didClose) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          shutdownTimers.delete(timer);
        }
        resolve(didClose);
      };
      timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      shutdownTimers.add(timer);
      closedPromise.then(() => finish(true));
    });
  }

  function close() {
    if (closePromise !== null) return closePromise;
    closePromise = (async () => {
      closing = true;
      closed = true;
      rejectAll(new Error("codex app-server closed"));
      if (processSettled) return;

      try { child.stdin?.end?.(); } catch {}
      try { child.kill("SIGTERM"); } catch {}
      if (await waitForProcessClose(boundedTimeout(shutdownGraceMs, CODEX_SHUTDOWN_GRACE_MS))) return;

      try { child.kill("SIGKILL"); } catch {}
      if (await waitForProcessClose(boundedTimeout(killGraceMs, CODEX_KILL_GRACE_MS))) return;

      try { child.unref?.(); } catch {}
      settleClosed(new Error("codex app-server did not exit after SIGKILL"));
    })();
    return closePromise;
  }

  return { request, close, child, closed: closedPromise };
}
