import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { request } from "node:http";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

export const PROBE_TIMEOUT_MS = 1500;
export const PROBE_MAX_BYTES = 64 * 1024;
/** Presence only: never launch an optional model CLI just to inspect the host. */
export async function toolAvailable(command: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try { await access(join(directory, command), constants.X_OK); return true; } catch { /* next PATH entry */ }
  }
  return false;
}
export interface ProcessProbe { readonly ok: boolean; readonly stdout: string; readonly code: string }
interface ProcessProbeOptions {
  readonly graceful?: boolean;
  readonly tempRoot?: string;
}
/** Native hangs receive SIGKILL. Sandbox gets one second to abort/clean up first. */
export function boundedProcess(command: string, args: readonly string[], timeout = PROBE_TIMEOUT_MS, options: ProcessProbeOptions = {}): Promise<ProcessProbe> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    if (options.tempRoot !== undefined) {
      env.TMPDIR = options.tempRoot;
      env.TMP = options.tempRoot;
      env.TEMP = options.tempRoot;
    }
    let timedOut = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(command, [...args], { maxBuffer: PROBE_MAX_BYTES, env }, (error, stdout) => {
      clearTimeout(deadline);
      clearTimeout(force);
      const code = timedOut ? "probe_timeout" : error === null ? "ok"
        : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "probe_output_limit" : "probe_failed";
      resolve({ ok: error === null && !timedOut, stdout: String(stdout), code });
    });
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill(options.graceful === true ? "SIGTERM" : "SIGKILL");
      if (options.graceful === true) force = setTimeout(() => { child.kill("SIGKILL"); }, 1000);
    }, timeout);
  });
}
export async function isolatedProbe(kind: "memory" | "sharp" | "sandbox"): Promise<{ ok: boolean; observed: Readonly<Record<string, unknown>>; error: string; code: string }> {
  const sandbox = kind === "sandbox";
  // Parent-owned temporary root also removes functional-proof leftovers after a
  // worker crash/hard timeout. Never stage anything in the consumer folder.
  const tempRoot = sandbox ? await mkdtemp(join(tmpdir(), "mono-agent-host-probe-")) : undefined;
  try {
    const result = await boundedProcess(process.execPath, [fileURLToPath(new URL("./host-native-worker.js", import.meta.url)), kind], sandbox ? 20000 : 10000,
      tempRoot === undefined ? {} : { graceful: true, tempRoot });
    if (result.code === "probe_timeout" || result.code === "probe_output_limit") {
      return { ok: false, observed: {}, error: "", code: result.code };
    }
    try {
      const data: unknown = JSON.parse(result.stdout);
      if (typeof data === "object" && data !== null && "ok" in data) {
        const value = data as { ok: boolean; observed?: Record<string, unknown>; error?: string };
        return { ok: result.ok && value.ok === true, observed: value.observed ?? {}, error: String(value.error ?? ""), code: result.code };
      }
    } catch { /* crashes and non-protocol stdout are failures, not success */ }
    return { ok: false, observed: {}, error: "", code: result.code === "ok" ? "probe_protocol_failed" : result.code };
  } finally {
    if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true });
  }
}

/** Literal IPv4 loopback, direct HTTP (no proxy env), no redirects, hard wall/byte limits. */
export function loopbackProbe(port: number, path: "/api/tags" | "/v1/models", timeout = PROBE_TIMEOUT_MS): Promise<{ ok: boolean; code: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, code: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ ok, code });
    };
    const req = request({ host: "127.0.0.1", port, path, method: "GET", agent: false, headers: { Accept: "application/json" } }, (response) => {
      if (response.statusCode !== 200) { response.destroy(); finish(false, "http_status"); return; }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > PROBE_MAX_BYTES) { response.destroy(); finish(false, "response_too_large"); }
        else chunks.push(chunk);
      });
      response.on("error", () => finish(false, "response_failed"));
      response.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { models?: unknown; data?: unknown } | null;
          finish(data !== null && Array.isArray(path === "/api/tags" ? data.models : data.data), "model_endpoint_response");
        } catch { finish(false, "invalid_json"); }
      });
    });
    const timer = setTimeout(() => finish(false, "probe_timeout"), timeout);
    req.on("error", () => finish(false, "connection_failed"));
    req.end();
  });
}
export function bindLoopback(port: number): Promise<{ ok: boolean; port: number }> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve({ ok: false, port }));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      const address = server.address();
      const actual = typeof address === "object" && address !== null ? address.port : port;
      server.close(() => resolve({ ok: true, port: actual }));
    });
  });
}
