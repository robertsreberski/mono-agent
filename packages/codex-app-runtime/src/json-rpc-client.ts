import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface JsonRpcClientOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly cwd?: string;
  readonly stderrTailBytes: number;
  readonly onNotification: (method: string, params: Record<string, unknown>) => void;
  readonly onWarning: (message: string) => void;
}

export interface JsonRpcRequest {
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly timeoutMs: number;
}

export interface JsonRpcClient {
  request(input: JsonRpcRequest): Promise<unknown>;
  close(): Promise<void>;
  stderrTail(): string;
}

interface PendingEntry {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class JsonRpcClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "JsonRpcClientError";
    this.code = code;
  }
}

export function createJsonRpcClient(options: JsonRpcClientOptions): JsonRpcClient {
  const child: ChildProcessWithoutNullStreams = spawn(options.command, [...options.args], {
    env: filterEnv(options.env),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map<number, PendingEntry>();
  let nextId = 1;
  let closed = false;
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;

  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
    stderrBytes += chunk.length;
    while (stderrBytes > options.stderrTailBytes && stderrChunks.length > 1) {
      const first = stderrChunks.shift();
      stderrBytes -= first?.length ?? 0;
    }
  });

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      options.onWarning(`Malformed Codex stdout line: ${truncate(trimmed, 240)}`);
      return;
    }
    if (!isObject(message)) {
      options.onWarning(`Unexpected Codex stdout shape: ${truncate(trimmed, 240)}`);
      return;
    }
    if (typeof message.id === "number" && (message.result !== undefined || message.error !== undefined)) {
      const entry = pending.get(message.id);
      if (entry === undefined) {
        return;
      }
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error !== undefined && message.error !== null) {
        const err = message.error as Record<string, unknown>;
        const errMessage = typeof err.message === "string" ? err.message : "Codex RPC error";
        entry.reject(new JsonRpcClientError("rpc_error", errMessage));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      const params = isObject(message.params) ? message.params : {};
      options.onNotification(message.method, params);
    }
  });

  child.on("exit", (code) => {
    closed = true;
    rejectAll(new JsonRpcClientError("process_exit", `Codex process exited with code ${code ?? "null"}.`));
  });

  child.on("error", (error) => {
    closed = true;
    rejectAll(new JsonRpcClientError("process_error", error.message));
  });

  function rejectAll(error: Error): void {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  return {
    async request(input: JsonRpcRequest): Promise<unknown> {
      if (closed) {
        throw new JsonRpcClientError("client_closed", "Codex RPC client is closed.");
      }
      const id = nextId++;
      const payload: Record<string, unknown> = {
        jsonrpc: "2.0",
        id,
        method: input.method,
      };
      if (input.params !== undefined) {
        payload.params = input.params;
      }
      const line = `${JSON.stringify(payload)}\n`;

      return await new Promise<unknown>((resolve, reject) => {
        const timer: NodeJS.Timeout = setTimeout(() => {
          pending.delete(id);
          reject(new JsonRpcClientError("request_timeout", `Codex RPC ${input.method} timed out after ${input.timeoutMs}ms.`));
        }, input.timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          child.stdin.write(line, (error) => {
            if (error !== undefined && error !== null) {
              pending.delete(id);
              clearTimeout(timer);
              reject(new JsonRpcClientError("write_error", error.message));
            }
          });
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new JsonRpcClientError("write_error", error instanceof Error ? error.message : String(error)));
        }
      });
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      try {
        rl.close();
      } catch {
        // ignore
      }
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
      try {
        child.kill();
      } catch {
        // ignore
      }
      rejectAll(new JsonRpcClientError("client_closed", "Codex RPC client closed by caller."));
    },
    stderrTail(): string {
      return Buffer.concat(stderrChunks).toString("utf8");
    },
  };
}

function filterEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
