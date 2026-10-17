// @ts-check

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { capChars } from "../shared/output-truncation.js";
import { killProcessGroup } from "./process-runner.js";
import { requireToolContext, resolveSandboxPolicy } from "../shared/tool-context.js";

const DEFAULT_NODE_REPL_TIMEOUT_MS = 120_000;
const NODE_REPL_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const NODE_REPL_MAX_FRAME_BYTES = NODE_REPL_MAX_BUFFER_BYTES * 3;
const KILL_GRACE_MS = 1_000;

// Kept self-contained so the sandboxed child can start from `node --eval`
// without needing read access to agent-runtime's installed package directory.
function nodeReplWorkerMain(frameToken: any) {
  const repl = require("node:repl");
  const { PassThrough } = require("node:stream");
  const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
  const MAX_FRAME_BYTES = MAX_BUFFER_BYTES * 3;
  const input = new PassThrough();
  const output = new PassThrough();
  const protocolWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const server = repl.start({
    input,
    output,
    prompt: "",
    terminal: false,
    useGlobal: false,
  });
  const replServer = /** @type {any} */ ((server) as any);
  let active: { id: any; output: string; stdout: string; stderr: string; bytes: number; [key: string]: any } | null = null;
  let protocolBuffer = Buffer.alloc(0);

  function encodeFrame(message: any) {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    return Buffer.concat([
      Buffer.from(`${frameToken}:${payload.length}\n`, "utf8"),
      payload,
    ]);
  }

  function send(message: any) {
    try {
      protocolWrite(encodeFrame(message));
    } catch {
      process.exit(1);
    }
  }

  function errorText(error: any) {
    const cause = error?.err ?? error;
    return String(cause?.stack || cause?.message || cause || "Node REPL evaluation failed.");
  }

  function finish(ok: any, text: any, reset: boolean = false) {
    const request = active;
    if (!request) return;
    active = null;
    const value = String(text || "");
    const responseBytes = Buffer.byteLength(value, "utf8")
      + Buffer.byteLength(request.stdout, "utf8")
      + Buffer.byteLength(request.stderr, "utf8");
    if (responseBytes > MAX_BUFFER_BYTES) {
      send({
        type: "result",
        id: request.id,
        ok: false,
        reset: true,
        text: `Node REPL output exceeded ${MAX_BUFFER_BYTES} bytes.`,
        stdout: request.stdout.slice(0, MAX_BUFFER_BYTES),
        stderr: request.stderr,
      });
      setImmediate(() => process.exit(1));
      return;
    }
    send({
      type: "result",
      id: request.id,
      ok,
      reset,
      text: value,
      stdout: request.stdout,
      stderr: request.stderr,
    });
  }

  function captureProcessWrite(field: any, originalWrite: any) {
    return function capturedWrite(chunk: any, encoding?: any, callback?: any) {
      if (!active) return originalWrite(chunk, encoding, callback);
      const resolvedEncoding = typeof encoding === "string" ? encoding : "utf8";
      const resolvedCallback = typeof encoding === "function" ? encoding : callback;
      const buffer = typeof chunk === "string"
        ? Buffer.from(chunk, /** @type {any} */ ((resolvedEncoding) as any))
        : Buffer.from(/** @type {any} */ ((chunk) as any));
      active.bytes += buffer.length;
      if (active.bytes > MAX_BUFFER_BYTES) {
        finish(false, `Node REPL output exceeded ${MAX_BUFFER_BYTES} bytes.`, true);
        setImmediate(() => process.exit(1));
        return false;
      }
      active[field] += buffer.toString("utf8");
      if (typeof resolvedCallback === "function") queueMicrotask(resolvedCallback);
      return true;
    };
  }

  process.stdout.write = captureProcessWrite("stdout", protocolWrite);
  process.stderr.write = captureProcessWrite("stderr", originalStderrWrite);

  output.on("data", (chunk: Buffer) => {
    if (!active) return;
    active.bytes += chunk.length;
    if (active.bytes > MAX_BUFFER_BYTES) {
      finish(false, `Node REPL output exceeded ${MAX_BUFFER_BYTES} bytes.`, true);
      setImmediate(() => process.exit(1));
      return;
    }
    active.output += chunk.toString("utf8");
  });

  // Runtime exceptions from the default evaluator are printed through the
  // REPL output stream and completed by displayPrompt(), rather than passed to
  // eval's callback. Intercept that public completion point while retaining the
  // default evaluator's `_error` behavior.
  replServer.displayPrompt = () => {
    if (!active) return;
    finish(false, active.output.trimEnd() || "Node REPL evaluation failed.");
  };

  function evaluate(requestMessage: any) {
    if (!requestMessage || requestMessage.type !== "evaluate") return;
    if (active) {
      send({ type: "result", id: requestMessage.id, ok: false, text: "Node REPL is already evaluating code." });
      return;
    }
    if (typeof requestMessage.code !== "string" || requestMessage.code.trim().length === 0) {
      send({ type: "result", id: requestMessage.id, ok: false, text: "Node REPL code must not be empty." });
      return;
    }
    active = { id: requestMessage.id, output: "", stdout: "", stderr: "", bytes: 0 };
    try {
      replServer.eval(requestMessage.code, replServer.context, "<mono-agent-node-repl>", (error: any, value: any) => {
        if (!active || active.id !== requestMessage.id) return;
        if (error) {
          if (!replServer.underscoreErrAssigned) replServer.lastError = error;
          finish(false, [active.output.trimEnd(), errorText(error)].filter(Boolean).join("\n"));
          return;
        }
        if (!replServer.underscoreAssigned) replServer.last = value;
        let rendered;
        try {
          rendered = replServer.writer(value);
        } catch (writerError) {
          finish(false, [active.output.trimEnd(), errorText(writerError)].filter(Boolean).join("\n"));
          return;
        }
        finish(true, `${active.output}${rendered}`.trimEnd());
      });
    } catch (error: any) {
      finish(false, [active.output.trimEnd(), errorText(error)].filter(Boolean).join("\n"));
    }
  }

  function consumeFrames(chunk: any) {
    protocolBuffer = Buffer.concat([protocolBuffer, chunk]);
    if (protocolBuffer.length > MAX_FRAME_BYTES) process.exit(1);
    while (protocolBuffer.length > 0) {
      const newline = protocolBuffer.indexOf(0x0a);
      if (newline < 0) return;
      const header = protocolBuffer.subarray(0, newline).toString("utf8");
      const prefix = `${frameToken}:`;
      if (!header.startsWith(prefix)) process.exit(1);
      const lengthText = header.slice(prefix.length);
      if (!/^\d+$/.test(lengthText)) process.exit(1);
      const length = Number(lengthText);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FRAME_BYTES) process.exit(1);
      const frameEnd = newline + 1 + length;
      if (protocolBuffer.length < frameEnd) return;
      const payload = protocolBuffer.subarray(newline + 1, frameEnd);
      protocolBuffer = protocolBuffer.subarray(frameEnd);
      try {
        evaluate(JSON.parse(payload.toString("utf8")));
      } catch {
        process.exit(1);
      }
    }
  }

  process.stdin.on("data", consumeFrames);
  process.stdin.on("end", () => {
    server.close();
    process.exit(0);
  });
}

function workerSource(frameToken: any) {
  return `(${nodeReplWorkerMain.toString()})(${JSON.stringify(frameToken)});`;
}

function encodeFrame(frameToken: any, message: any) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`${frameToken}:${payload.length}\n`, "utf8"),
    payload,
  ]);
}

function errorMessage(error: any) {
  return error instanceof Error ? error.message : String(error);
}

function appendStderr(record: any, chunk: any) {
  record.directOutputBytes += chunk.length;
  if (record.directOutputBytes > NODE_REPL_MAX_BUFFER_BYTES) {
    record.failureReason = `Node REPL output exceeded ${NODE_REPL_MAX_BUFFER_BYTES} bytes.`;
    void terminateRecord(record);
    return;
  }
  record.stderr.push(chunk);
}

function directOutput(record: any, capturedStdout: string = "", capturedStderr: string = "") {
  const sections = [];
  const stdout = String(capturedStdout || "").trimEnd();
  const stderr = `${capturedStderr}${Buffer.concat(record.stderr).toString("utf8")}`.trimEnd();
  if (stdout) sections.push(`STDOUT:\n${stdout}`);
  if (stderr) sections.push(`STDERR:\n${stderr}`);
  return sections.join("\n");
}

function clearRequestOutput(record: any) {
  record.stderr = [];
  record.directOutputBytes = 0;
  record.failureReason = null;
}

function resultText(record: any, text: any, stdout: any, stderr: any) {
  return [directOutput(record, stdout, stderr), String(text || "").trimEnd()].filter(Boolean).join("\n");
}

async function cleanupPrepared(record: any) {
  if (record.cleaned) return;
  record.cleaned = true;
  try { await record.prepared.cleanup?.(); } catch { /* best-effort teardown */ }
}

async function terminateRecord(record: any) {
  if (record.closed) {
    await record.done;
    return;
  }
  killProcessGroup(record.child, "SIGTERM", { fallbackToChildPid: true });
  if (!record.killTimer) {
    record.killTimer = setTimeout(
      () => killProcessGroup(record.child, "SIGKILL", { fallbackToChildPid: true }),
      KILL_GRACE_MS,
    );
    record.killTimer.unref?.();
  }
  await record.done;
}

function consumeWorkerFrames(record: any, chunk: any, onMessage: any) {
  record.protocolBuffer = Buffer.concat([record.protocolBuffer, chunk]);
  if (record.protocolBuffer.length > NODE_REPL_MAX_FRAME_BYTES) {
    record.failureReason = "Node REPL protocol frame exceeded its byte limit.";
    void terminateRecord(record);
    return;
  }
  while (record.protocolBuffer.length > 0) {
    const newline = record.protocolBuffer.indexOf(0x0a);
    if (newline < 0) return;
    const header = record.protocolBuffer.subarray(0, newline).toString("utf8");
    const prefix = `${record.frameToken}:`;
    if (!header.startsWith(prefix)) {
      record.failureReason = "Node REPL protocol framing was corrupted.";
      void terminateRecord(record);
      return;
    }
    const lengthText = header.slice(prefix.length);
    if (!/^\d+$/.test(lengthText)) {
      record.failureReason = "Node REPL protocol frame length was invalid.";
      void terminateRecord(record);
      return;
    }
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length < 0 || length > NODE_REPL_MAX_FRAME_BYTES) {
      record.failureReason = "Node REPL protocol frame length was out of range.";
      void terminateRecord(record);
      return;
    }
    const frameEnd = newline + 1 + length;
    if (record.protocolBuffer.length < frameEnd) return;
    const payload = record.protocolBuffer.subarray(newline + 1, frameEnd);
    record.protocolBuffer = record.protocolBuffer.subarray(frameEnd);
    try {
      onMessage(JSON.parse(payload.toString("utf8")));
    } catch {
      record.failureReason = "Node REPL protocol payload was invalid JSON.";
      void terminateRecord(record);
      return;
    }
  }
}

function codedError(message: any, code: any) {
  const error = /** @type {Error & {code?: string}} */ ((new Error(message)) as Error & {code?: string});
  error.code = code;
  return error;
}

/**
 * One lazy Node REPL process owned by a single Pi run.
 * @param {{cwd?: string, maxOutputChars?: number, sandboxPolicy?: any, sandboxEngine?: any, ctx?: any}} [options]
 */
export function createNodeReplController({
  cwd,
  maxOutputChars,
  sandboxPolicy,
  sandboxEngine,
  ctx,
}: { cwd?: string; maxOutputChars?: number; sandboxPolicy?: any; sandboxEngine?: any; ctx?: any } = {}): { execute: ({ code }: { code: string }, { signal }?: { signal?: AbortSignal }) => Promise<any>; /** Structured result used by the Pi bridge so telemetry does not depend on text prefixes. */ executeDetailed(params: any, execution?: {}): Promise<{ text: any; outcome: { status: string; code: string; retryable: boolean; attempts: number; durationMs: number; bytes: number; truncated: boolean }; error: boolean } | { text: string; outcome: { status: string; code: any; retryable: boolean; attempts: number; durationMs: number; bytes: number; truncated: boolean }; error: boolean }>; close(): Promise<void> } {
  const resolvedCtx = requireToolContext(ctx);
  const sandbox = resolvedCtx.sandbox ?? passthroughSandbox;
  const policy = resolveSandboxPolicy(resolvedCtx, sandboxPolicy);
  const workdir = resolve(cwd || resolvedCtx.workspace || process.cwd());
  let current: NodeReplRecord | null = null;
  let starting: Promise<NodeReplRecord> | null = null;
  let permanentlyClosed = false;
  let nextRequestId = 0;

  async function startChild() {
    const frameToken = randomBytes(24).toString("hex");
    const prepared = await sandbox.prepareCommand({
      policy,
      engine: sandboxEngine ?? resolvedCtx.sandboxEngine ?? undefined,
      command: {
        command: process.execPath,
        args: ["--eval", workerSource(frameToken)],
        cwd: workdir,
      },
    });
    if (permanentlyClosed) {
      await prepared.cleanup?.();
      throw codedError("Node REPL run has already ended.", "closed");
    }

    let child;
    try {
      child = spawn(prepared.command, prepared.args || [], {
        cwd: prepared.cwd,
        detached: process.platform !== "win32",
        env: prepared.env ? { ...process.env, ...prepared.env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error: any) {
      await prepared.cleanup?.();
      throw error;
    }

    let resolveDone = () => {};
    const done = new Promise<void>((resolveDonePromise) => { resolveDone = () => resolveDonePromise(); });
    const record: NodeReplRecord = {
      child,
      prepared,
      done,
      resolveDone,
      frameToken,
      protocolBuffer: Buffer.alloc(0),
      closed: false,
      cleaned: false,
      killTimer: null,
      spawnError: null,
      failureReason: null,
      pending: null,
      stderr: [],
      directOutputBytes: 0,
    };
    current = record;

    child.stdout?.on("data", (chunk) => {
      consumeWorkerFrames(record, chunk, (message: any) => handleWorkerMessage(record, message));
    });
    child.stderr?.on("data", (chunk) => appendStderr(record, chunk));
    child.once("error", (error) => { record.spawnError = error; });
    child.once("close", (code, closeSignal) => {
      record.closed = true;
      if (record.killTimer) clearTimeout(record.killTimer);
      if (current === record) current = null;
      const pending = record.pending;
      record.pending = null;
      if (pending) {
        clearTimeout(pending.timeoutTimer);
        pending.signal?.removeEventListener?.("abort", pending.onAbort);
        const reason = record.failureReason
          || (record.spawnError ? errorMessage(record.spawnError) : null)
          || `Node REPL process exited before evaluation completed${closeSignal ? ` (${closeSignal})` : ` (code ${code ?? "unknown"})`}.`;
        pending.reject(codedError(`${reason} Session state was reset.`, "process_exit"));
      }
      void cleanupPrepared(record).finally(() => record.resolveDone());
    });
    return record;
  }

  function handleWorkerMessage(record: any, result: any) {
    const pending = record.pending;
    if (!pending || !result || result.type !== "result" || result.id !== pending.id) return;
    record.pending = null;
    clearTimeout(pending.timeoutTimer);
    pending.signal?.removeEventListener?.("abort", pending.onAbort);
    setImmediate(async () => {
      const text = resultText(record, result.text, result.stdout, result.stderr);
      if (result.reset) await terminateRecord(record);
      if (result.ok) {
        pending.resolve(capChars(text || "(no output)", {
          label: "NodeRepl",
          maxChars: maxOutputChars,
          strategy: "head_tail",
          ctx: resolvedCtx,
        } as Parameters<typeof capChars>[1]));
      } else {
        pending.reject(codedError(text || "Node REPL evaluation failed.", result.reset ? "output_limit" : "evaluation_error"));
      }
    });
  }

  async function ensureChild() {
    if (permanentlyClosed) throw codedError("Node REPL run has already ended.", "closed");
    if (current && !current.closed) return current;
    starting ??= startChild().finally(() => { starting = null; });
    return await starting;
  }

  async function resetForFailure(record: any, pending: any, message: any, code: any) {
    if (record.pending === pending) record.pending = null;
    clearTimeout(pending.timeoutTimer);
    pending.signal?.removeEventListener?.("abort", pending.onAbort);
    await terminateRecord(record);
    pending.reject(codedError(`${message} Session state was reset.`, code));
  }

  /**
   * @param {{code: string}} params
   * @param {{signal?: AbortSignal}} [execution]
   */
  async function execute({ code }: { code: string; }, { signal }: { signal?: AbortSignal; } = {}): Promise<any> {
    if (typeof code !== "string" || code.trim().length === 0) {
      throw codedError("Node REPL code must not be empty.", "invalid_code");
    }
    if (signal?.aborted) throw codedError("Node REPL execution aborted.", "aborted");
    const record = await ensureChild();
    if (signal?.aborted) {
      await terminateRecord(record);
      throw codedError("Node REPL execution aborted. Session state was reset.", "aborted");
    }
    if (record.pending) throw codedError("Node REPL is already evaluating code.", "busy");
    clearRequestOutput(record);
    const id = `node-repl-${++nextRequestId}`;

    return await new Promise((resolveResult, rejectResult) => {
      const pending: NodeReplPending = {
        id,
        resolve: resolveResult,
        reject: rejectResult,
        signal,
        onAbort: null as unknown as () => void,
        timeoutTimer: null as unknown as ReturnType<typeof setTimeout>,
      };
      pending.onAbort = () => {
        void resetForFailure(record, pending, "Node REPL execution aborted.", "aborted");
      };
      pending.timeoutTimer = setTimeout(() => {
        void resetForFailure(
          record,
          pending,
          `Node REPL execution timed out after ${DEFAULT_NODE_REPL_TIMEOUT_MS}ms.`,
          "timeout",
        );
      }, DEFAULT_NODE_REPL_TIMEOUT_MS);
      pending.timeoutTimer.unref?.();
      record.pending = pending;
      signal?.addEventListener?.("abort", pending.onAbort, { once: true });
      const frame = encodeFrame(record.frameToken, { type: "evaluate", id, code });
      record.child.stdin?.write(frame, (error) => {
        if (error && record.pending === pending) {
          void resetForFailure(record, pending, `Node REPL stream protocol failed: ${errorMessage(error)}.`, "protocol_error");
        }
      });
    });
  }

  return {
    execute,

    /** Structured result used by the Pi bridge so telemetry does not depend on text prefixes. */
    async executeDetailed(params, execution = {}) {
      const startedAt = Date.now();
      try {
        const text = await execute(params, execution);
        return {
          text,
          outcome: {
            status: "ok",
            code: "ok",
            retryable: false,
            attempts: 1,
            durationMs: Date.now() - startedAt,
            bytes: Buffer.byteLength(text, "utf8"),
            truncated: String(text).includes("[truncated NodeRepl output"),
          },
          error: false,
        };
      } catch (error: any) {
        const text = errorMessage(error);
        return {
          text,
          outcome: {
            status: "error",
            code: typeof error?.code === "string" ? error.code : "evaluation_error",
            retryable: false,
            attempts: 1,
            durationMs: Date.now() - startedAt,
            bytes: Buffer.byteLength(text, "utf8"),
            truncated: false,
          },
          error: true,
        };
      }
    },

    async close() {
      if (permanentlyClosed) return;
      permanentlyClosed = true;
      if (starting) {
        try { await starting; } catch { /* start failure already surfaced */ }
      }
      if (current) await terminateRecord(current);
    },
  };
}


type NodeReplPending = {
  id: string;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  signal: AbortSignal | undefined;
  onAbort: () => void;
  timeoutTimer: ReturnType<typeof setTimeout>;
};

type NodeReplRecord = {
  child: import("node:child_process").ChildProcessWithoutNullStreams;
  prepared: import("../../agent/sandbox-seam.js").PreparedSandboxCommand;
  done: Promise<void>;
  resolveDone: () => void;
  frameToken: string;
  protocolBuffer: Buffer;
  closed: boolean;
  cleaned: boolean;
  killTimer: ReturnType<typeof setTimeout> | null;
  spawnError: Error | null;
  failureReason: string | null;
  pending: NodeReplPending | null;
  stderr: Buffer[];
  directOutputBytes: number;
};
