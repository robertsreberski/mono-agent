// MCP connection and shared close/cancel lifecycle authority.
import { isAbsolute, resolve } from "node:path";
import { requireToolContext, resolveSandboxPolicy } from "../shared/tool-context.js";
import { passthroughSandbox } from "../../agent/sandbox-seam.js";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { MCP_APP_RESOURCE_MIME_TYPE, MCP_APPS_EXTENSION_ID } from "@mono-agent/contracts";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomUUID } from "node:crypto";
import { sandboxFailureDiagnostic } from "../shared/sandbox-diagnostics.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const PRIVATE_CAPABILITY_URL = Symbol.for("@mono-agent/private-capability-url");

export function resolveMcpStdioCwd(cfg?: {}, cwd?: any): any;
export function resolveMcpStdioCwd(cfg: any = {}, cwd: any = null): any {
  const configured = cfg.cwd || null;
  if (configured && isAbsolute(configured)) return configured;
  if (configured) return resolve(cwd || process.cwd(), configured);
  return cwd || process.cwd();
}

export function prepareMcpStdioCommand(cfg?: {}, options?: { cwd?: any; sandboxPolicy?: any; sandboxEngine?: any; ctx?: any }): Promise<import("../../agent/sandbox-seam.js").PreparedSandboxCommand>;
export async function prepareMcpStdioCommand(cfg: any = {}, { cwd = null, sandboxPolicy = null, sandboxEngine = null, ctx = null }: { cwd?: any; sandboxPolicy?: any; sandboxEngine?: any; ctx?: any } = {}): Promise<import("../../agent/sandbox-seam.js").PreparedSandboxCommand> {
  const resolvedCtx = requireToolContext(ctx);
  const sandbox = resolvedCtx.sandbox ?? passthroughSandbox;
  const appOwnedLocalBinding = cfg[Symbol.for("@mono-agent/app-owned-local-binding")] === true;
  return sandbox.prepareCommand({
    policy: resolveSandboxPolicy(resolvedCtx, sandboxPolicy),
    engine: sandboxEngine ?? resolvedCtx.sandboxEngine ?? undefined,
    command: {
      command: cfg.command,
      args: cfg.args || [],
      // Never fall back to process.cwd(): the explicit context's workspace is the
      // only host-independent default for a per-instance runtime.
      cwd: resolveMcpStdioCwd(cfg, cwd ?? resolvedCtx.workspace),
      ...(cfg.env && typeof cfg.env === "object" ? { env: cfg.env } : {}),
      ...(appOwnedLocalBinding ? { allowLocalBinding: true } : {}),
    },
  });
}

export function connectMcpClient(name: any, cfg: any, { cwd, sandboxPolicy, sandboxEngine, ctx, mcpApps }?: { cwd?: any; sandboxPolicy?: any; sandboxEngine?: any; ctx?: any; mcpApps?: any; }): Promise<{ name: any; client: McpClient<{ method: string; params?: { [x: string]: unknown; _meta?: { [x: string]: unknown; progressToken?: string | number; "io.modelcontextprotocol/related-task"?: { taskId: string; }; }; }; }, { method: string; params?: { [x: string]: unknown; _meta?: { [x: string]: unknown; progressToken?: string | number; "io.modelcontextprotocol/related-task"?: { taskId: string; }; }; }; }, { [x: string]: unknown; _meta?: { [x: string]: unknown; progressToken?: string | number; "io.modelcontextprotocol/related-task"?: { taskId: string; }; }; }>; transport: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport; connectionId: `${string}-${string}-${string}-${string}-${string}`; retainedByMcpApps: boolean; privateCapabilityUrl: boolean; closed: boolean; inFlight: Set<any>; }>;
export async function connectMcpClient(name: any, cfg: any, { cwd, sandboxPolicy, sandboxEngine, ctx, mcpApps }: { cwd?: any; sandboxPolicy?: any; sandboxEngine?: any; ctx?: any; mcpApps?: any } = {}) {
  const brand = (requireToolContext(ctx)).runtimeBrand;
  const privateCapabilityUrl = cfg?.[PRIVATE_CAPABILITY_URL] === true;
  const client = new McpClient(
    { name: `${brand.mcpClientName}/${name}`, version: brand.mcpClientVersion },
    {
      capabilities: mcpApps?.mimeTypes?.includes?.(MCP_APP_RESOURCE_MIME_TYPE)
        ? {
            extensions: {
              [MCP_APPS_EXTENSION_ID]: {
                mimeTypes: [MCP_APP_RESOURCE_MIME_TYPE],
              },
            },
          }
        : {},
    },
  ) as unknown as Awaited<ReturnType<typeof connectMcpClient>>["client"];
  let transport;
  let preparedStdio;
  let startupStderr = "";
  let captureStderr;
  try {
    if (cfg.type === "http") {
      transport = new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers || {} } });
    } else if (cfg.type === "sse") {
      transport = new SSEClientTransport(new URL(cfg.url), {
        // SSE EventSourceInit's typed shape omits `headers`, but the transport
        // forwards them to the underlying EventSource — keep the header pass-through.
        eventSourceInit: (({ headers: cfg.headers || {} }) as any),
        requestInit: { headers: cfg.headers || {} },
      });
    } else {
      const prepared = await prepareMcpStdioCommand(cfg, { cwd, sandboxPolicy, sandboxEngine, ctx });
      preparedStdio = prepared;
      transport = new StdioClientTransport({
        ...(prepared.sandboxed ? { stderr: "pipe" } : {}),
        command: prepared.command,
        // Copy the (readonly) prepared args into the transport's mutable list.
        args: [...(prepared.args || [])],
        cwd: prepared.cwd,
        env: { ...process.env, ...(prepared.env || {}) } as Record<string, string>,
      });
      // Monkey-patched cleanup handle: not part of the MCP transport's typed shape.
 ((transport) as any).__monoSandboxCleanup = prepared.cleanup;
      if (prepared.sandboxed) {
        captureStderr = (chunk: any) => {
          // Preserve inherited-stderr operator visibility, including startup bytes.
          process.stderr.write(chunk);
          startupStderr = (startupStderr + String(chunk)).slice(0, 4096);
        };
        transport.stderr?.on("data", captureStderr);
      }
    }
    await client.connect(transport as Parameters<typeof client.connect>[0]);
    if (captureStderr && transport instanceof StdioClientTransport) {
      transport.stderr?.removeListener("data", captureStderr);
      // Keep forwarding for the server lifetime without retaining its output.
      transport.stderr?.on("data", (chunk: any) => { process.stderr.write(chunk); });
    }
    return {
      name,
      client,
      transport,
      connectionId: randomUUID(),
      retainedByMcpApps: false,
      privateCapabilityUrl,
      closed: false,
      // AbortControllers for calls currently on the wire. Teardown aborts these
      // BEFORE closing so the server is told to stop — see closeConnectedMcpClient.
      inFlight: new Set(),
    };
  } catch (error) {
    try { await transport?.close?.(); } catch { /* best-effort */ }
    try { await ((transport) as any)?.__monoSandboxCleanup?.(); } catch { /* best-effort */ }
    if (captureStderr && transport instanceof StdioClientTransport) transport.stderr?.removeListener("data", captureStderr);
    if (privateCapabilityUrl) throw new Error("Private request-scoped MCP server connection failed.");
    const diagnostic = sandboxFailureDiagnostic(preparedStdio?.sandboxed, startupStderr);
    if (diagnostic) {
      // This message becomes model-facing runtime_warning content. Neither raw
      // stderr nor transport errors are safe to publish (paths, env secrets).
      const failure = new Error(`${diagnostic.prefix}Stdio MCP startup failed.`);
 ((failure) as any).code = diagnostic.code ?? "sandboxed_mcp_startup_failed";
      throw failure;
    }
    throw error;
  }
}

async function closeWithTimeout(close: any, timeoutMs: any) {
  if (typeof close !== "function") return;
  const result = close();
  if (!(result && typeof result.then === "function")) return;
  let timer;
  try {
    await Promise.race([
      result,
      new Promise((resolve: (value: any) => void) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Cancel every call still on the wire, then close.
 *
 * Order matters. `Protocol._onclose` rejects pending requests LOCALLY with
 * ConnectionClosed and never notifies the server, and StdioClientTransport then
 * escalates stdin.end -> SIGTERM -> SIGKILL — so closing first kills a stdio
 * proxy mid-request with its upstream work still outstanding, and the caller
 * gets a bare "Connection closed" that cannot be told apart from a server that
 * died on its own. Aborting first makes the SDK emit `notifications/cancelled`
 * so the server can unwind, and rejects the caller with a sentence naming the
 * server and tool. See mono-agent#664.
 */
function cancelInFlightMcpCalls(connected: any) {
  const pending = connected?.inFlight;
  if (!pending || pending.size === 0) return;
  for (const entry of [...pending]) {
    try {
      entry.controller.abort(new McpError(
        ErrorCode.ConnectionClosed,
        `${entry.label} was cancelled because its MCP connection was torn down.`,
      ));
    } catch { /* best-effort */ }
  }
  pending.clear();
}

export async function closeConnectedMcpClient(connected: any, timeoutMs: any): Promise<void> {
  if (!connected || connected.closed === true) return;
  connected.closed = true;
  cancelInFlightMcpCalls(connected);
  const { client, transport } = connected;
  try { await closeWithTimeout(client?.close?.bind(client), timeoutMs); } catch { /* best-effort */ }
  try { await closeWithTimeout(transport?.close?.bind(transport), timeoutMs); } catch { /* best-effort */ }
  try { await transport?.__monoSandboxCleanup?.(); } catch { /* best-effort */ }
}
