// @ts-check

// Strict, bounded ACP v1 newline transport for an owned stdio child process.
// The SDK's stock ndJsonStream intentionally tolerates malformed input and its
// line buffer is unbounded, which is a poor fit for a long-lived host boundary.

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const MAX_MAX_LINE_BYTES = 16 * 1024 * 1024;

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

  const readable = new ReadableStream({
    start(controller) {
      let pending = Buffer.alloc(0);
      let settled = false;

      const cleanup = () => {
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("error", onError);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        controller.error(error instanceof Error
          ? error
          : new AcpTransportError("transport_failed", "ACP stdout failed."));
      };
      const onData = (chunk) => {
        if (settled) return;
        const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        pending = pending.length === 0 ? next : Buffer.concat([pending, next]);
        for (;;) {
          const newline = pending.indexOf(0x0a);
          if (newline === -1) break;
          let line = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
          if (line.length > maxLineBytes) {
            fail(new AcpTransportError("line_too_large", "ACP peer exceeded the inbound line limit."));
            return;
          }
          try {
            controller.enqueue(decodeLine(line));
          } catch (error) {
            fail(error);
            return;
          }
        }
        if (pending.length > maxLineBytes + 1) {
          fail(new AcpTransportError("line_too_large", "ACP peer exceeded the inbound line limit."));
        }
      };
      const onEnd = () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (pending.length > 0) {
          controller.error(new AcpTransportError(
            "unterminated_line",
            "ACP peer closed stdout with an unterminated JSON-RPC line.",
          ));
          return;
        }
        controller.close();
      };
      const onError = () => fail(new AcpTransportError("transport_failed", "ACP stdout failed."));

      input.on("data", onData);
      input.once("end", onEnd);
      input.once("error", onError);
    },
    cancel() {
      input.destroy();
    },
  });

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
    abort(error) {
      output.destroy(error instanceof Error ? error : undefined);
    },
  });

  return { readable, writable };
}

export const ACP_DEFAULT_MAX_LINE_BYTES = DEFAULT_MAX_LINE_BYTES;
