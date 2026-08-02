// @ts-check

import { AsyncLocalStorage } from "node:async_hooks";

// Strict, bounded ACP v1 newline transport for an owned stdio child process.
// The SDK's stock ndJsonStream intentionally tolerates malformed input and its
// line buffer is unbounded, which is a poor fit for a long-lived host boundary.

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const MAX_MAX_LINE_BYTES = 16 * 1024 * 1024;

// @agentclientprotocol/sdk 1.3.0 sends the trailing arguments of these
// diagnostics directly to console. Those values include raw JSON-RPC payloads
// (and, for malformed notifications, Zod error details derived from them).
// Preserve the useful classification while dropping payload-bearing details.
const ACP_SDK_PAYLOAD_DIAGNOSTICS = Object.freeze({
  error: new Set([
    "Invalid message",
    "Error handling notification",
    "Got response to unknown request",
    "Failed to parse JSON message:",
    "ACP connection router stopped unexpectedly:",
  ]),
  warn: new Set([
    "Skipping JSON line that is not an object:",
  ]),
});
const acpSdkDiagnosticScope = new AsyncLocalStorage();
let activeAcpSdkDiagnosticGuards = 0;
/** @type {null|{
 *   originalError: typeof console.error,
 *   originalWarn: typeof console.warn,
 *   guardedError: typeof console.error,
 *   guardedWarn: typeof console.warn,
 * }} */
let acpSdkConsoleGuard = null;

function installAcpSdkConsoleGuard() {
  activeAcpSdkDiagnosticGuards += 1;
  if (acpSdkConsoleGuard) return;

  const originalError = console.error;
  const originalWarn = console.warn;
  /** @type {typeof console.error} */
  const guardedError = (...args) => {
    const contentFree = args[0];
    if (acpSdkDiagnosticScope.getStore() === true
      && typeof contentFree === "string"
      && ACP_SDK_PAYLOAD_DIAGNOSTICS.error.has(contentFree)) {
      Reflect.apply(originalError, console, [contentFree]);
      return;
    }
    Reflect.apply(originalError, console, args);
  };
  /** @type {typeof console.warn} */
  const guardedWarn = (...args) => {
    const contentFree = args[0];
    if (acpSdkDiagnosticScope.getStore() === true
      && typeof contentFree === "string"
      && ACP_SDK_PAYLOAD_DIAGNOSTICS.warn.has(contentFree)) {
      Reflect.apply(originalWarn, console, [contentFree]);
      return;
    }
    Reflect.apply(originalWarn, console, args);
  };

  acpSdkConsoleGuard = { originalError, originalWarn, guardedError, guardedWarn };
  console.error = guardedError;
  console.warn = guardedWarn;
}

function releaseAcpSdkConsoleGuard() {
  activeAcpSdkDiagnosticGuards = Math.max(0, activeAcpSdkDiagnosticGuards - 1);
  if (activeAcpSdkDiagnosticGuards !== 0 || !acpSdkConsoleGuard) return;
  const guard = acpSdkConsoleGuard;
  acpSdkConsoleGuard = null;
  if (console.error === guard.guardedError) console.error = guard.originalError;
  if (console.warn === guard.guardedWarn) console.warn = guard.originalWarn;
}

/**
 * Open one SDK connection inside an async context that strips payload-bearing
 * SDK console arguments. The SDK starts its detached receive loop during
 * `connect`, so descendants retain this scope without muting concurrent host
 * work or other ACP connections.
 *
 * @template {{closed: Promise<unknown>}} T
 * @param {() => T} connect
 * @returns {T}
 */
export function connectWithSafeAcpSdkDiagnostics(connect) {
  installAcpSdkConsoleGuard();
  let connection;
  try {
    connection = acpSdkDiagnosticScope.run(true, connect);
  } catch (error) {
    releaseAcpSdkConsoleGuard();
    throw error;
  }
  void Promise.resolve(connection.closed).then(
    releaseAcpSdkConsoleGuard,
    releaseAcpSdkConsoleGuard,
  );
  return connection;
}

export class AcpTransportError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "AcpTransportError";
    this.code = code;
  }
}

/**
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function normalizeAcpMaxLineBytes(value, fallback = DEFAULT_MAX_LINE_BYTES) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < 1024 || Number(value) > MAX_MAX_LINE_BYTES) {
    throw new AcpTransportError(
      "invalid_transport_policy",
      `ACP maxLineBytes must be an integer between 1024 and ${MAX_MAX_LINE_BYTES}.`,
    );
  }
  return Number(value);
}

/**
 * The transport only accepts individual JSON-RPC 2.0 objects. Batches are not
 * part of ACP v1 and are rejected before the SDK sees them.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isIndividualJsonRpcMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (record.jsonrpc !== "2.0") return false;

  const hasId = Object.hasOwn(record, "id");
  const hasMethod = Object.hasOwn(record, "method");
  const hasParams = Object.hasOwn(record, "params");
  const hasResult = Object.hasOwn(record, "result");
  const hasError = Object.hasOwn(record, "error");

  const validId = !hasId
    || record.id === null
    || typeof record.id === "string"
    || (typeof record.id === "number" && Number.isFinite(record.id));
  if (!validId) return false;

  if (hasMethod) {
    if (typeof record.method !== "string" || record.method.length === 0) return false;
    if (hasParams) {
      const params = record.params;
      if (!params || typeof params !== "object") return false;
    }
    return !hasResult && !hasError;
  }

  if (!hasId || hasParams || hasResult === hasError) return false;
  if (!hasError) return true;
  if (!record.error || typeof record.error !== "object" || Array.isArray(record.error)) return false;
  const error = /** @type {Record<string, unknown>} */ (record.error);
  return Number.isInteger(error.code) && typeof error.message === "string";
}

/**
 * @param {Buffer} line
 * @returns {Record<string, unknown>}
 */
function decodeLine(line) {
  if (line.length === 0) {
    throw new AcpTransportError("invalid_jsonrpc", "ACP peer emitted an empty NDJSON line.");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(line);
  } catch {
    throw new AcpTransportError("invalid_utf8", "ACP peer emitted invalid UTF-8.");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AcpTransportError("invalid_jsonrpc", "ACP peer emitted malformed JSON.");
  }
  if (!isIndividualJsonRpcMessage(parsed)) {
    throw new AcpTransportError("invalid_jsonrpc", "ACP peer emitted a non-ACP JSON-RPC message.");
  }
  return parsed;
}

/**
 * Build the Stream shape consumed by @agentclientprotocol/sdk from a child
 * process's stdin/stdout. Both inbound and outbound payloads are capped.
 *
 * @param {{stdin: import('node:stream').Writable|null, stdout: import('node:stream').Readable|null}} child
 * @param {{maxLineBytes?: number}} [options]
 * @returns {{readable: ReadableStream<any>, writable: WritableStream<any>}}
 */
export function createBoundedAcpStdioStream(child, options = {}) {
  const maxLineBytes = normalizeAcpMaxLineBytes(options.maxLineBytes);
  if (!child.stdin || !child.stdout) {
    throw new AcpTransportError("stdio_unavailable", "ACP child stdio is unavailable.");
  }
  const input = child.stdout;
  const output = child.stdin;

  let pending = Buffer.alloc(0);
  let settled = false;
  let inputEnded = false;
  /** @type {ReadableStreamDefaultController<any>|null} */
  let readableController = null;

  const cleanupReadable = () => {
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("error", onError);
  };
  const failReadable = (error) => {
    if (settled) return;
    settled = true;
    input.pause();
    cleanupReadable();
    readableController?.error(error instanceof Error
      ? error
      : new AcpTransportError("transport_failed", "ACP stdout failed."));
  };
  const firstPendingLineIsTooLarge = () => {
    const newline = pending.indexOf(0x0a);
    if (newline !== -1) {
      const contentBytes = newline > 0 && pending[newline - 1] === 0x0d ? newline - 1 : newline;
      return contentBytes > maxLineBytes;
    }
    if (pending.length <= maxLineBytes) return false;
    return pending.length > maxLineBytes + 1 || pending[pending.length - 1] !== 0x0d;
  };
  const finishReadableIfEnded = () => {
    if (!inputEnded || settled || !readableController) return false;
    if (pending.length === 0) {
      settled = true;
      cleanupReadable();
      readableController.close();
      return true;
    }
    if (pending.indexOf(0x0a) === -1) {
      failReadable(new AcpTransportError(
        "unterminated_line",
        "ACP peer closed stdout with an unterminated JSON-RPC line.",
      ));
      return true;
    }
    return false;
  };
  const drainPending = () => {
    if (settled || !readableController) return;
    while (readableController.desiredSize !== null && readableController.desiredSize > 0) {
      const newline = pending.indexOf(0x0a);
      if (newline === -1) break;
      let line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      if (line.length > maxLineBytes) {
        failReadable(new AcpTransportError("line_too_large", "ACP peer exceeded the inbound line limit."));
        return;
      }
      try {
        readableController.enqueue(decodeLine(line));
      } catch (error) {
        failReadable(error);
        return;
      }
    }
    if (firstPendingLineIsTooLarge()) {
      failReadable(new AcpTransportError("line_too_large", "ACP peer exceeded the inbound line limit."));
      return;
    }
    if (finishReadableIfEnded()) return;
    if (readableController.desiredSize !== null
      && readableController.desiredSize > 0
      && pending.indexOf(0x0a) === -1) {
      input.resume();
    }
  };
  const onData = (chunk) => {
    if (settled) return;
    input.pause();
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = pending.length === 0 ? next : Buffer.concat([pending, next]);
    drainPending();
  };
  const onEnd = () => {
    if (settled) return;
    inputEnded = true;
    drainPending();
  };
  const onError = () => failReadable(new AcpTransportError("transport_failed", "ACP stdout failed."));

  const readable = new ReadableStream({
    start(controller) {
      readableController = controller;
      input.pause();
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("error", onError);
      drainPending();
    },
    pull() {
      drainPending();
    },
    cancel() {
      if (!settled) {
        settled = true;
        cleanupReadable();
      }
      input.destroy();
    },
  }, { highWaterMark: 1 });

  const writable = new WritableStream({
    async write(message) {
      let json;
      try {
        json = JSON.stringify(message);
      } catch {
        throw new AcpTransportError("invalid_outbound_json", "ACP outbound message is not JSON serializable.");
      }
      if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > maxLineBytes) {
        throw new AcpTransportError("line_too_large", "ACP outbound message exceeded the line limit.");
      }
      if (output.destroyed || output.writableEnded) {
        throw new AcpTransportError("transport_closed", "ACP stdin is closed.");
      }
      await new Promise((resolve, reject) => {
        output.write(`${json}\n`, (error) => error ? reject(error) : resolve(undefined));
      });
    },
    close() {
      if (!output.destroyed && !output.writableEnded) output.end();
    },
    abort() {
      output.destroy();
    },
  });

  return { readable, writable };
}

export const ACP_DEFAULT_MAX_LINE_BYTES = DEFAULT_MAX_LINE_BYTES;
