// MCP tool invocation, progress/timeouts and run teardown.
import { MAX_TOOL_RESULT_BYTES, wrapToolsWithBloatGuard } from "../../agent/tool-bloat.js";
import { connectMcpClient, closeConnectedMcpClient } from "./connection.js";
import { objectSchema } from "../shared/tool-schema.js";
import { MCP_TEXT_RESULT_LIMIT, MCP_IMAGE_INLINE_MAX_BYTES, normalizeMcpToolParams, coerceMcpContent, mcpContentWasTruncated, compactRawMcpResult } from "./content.js";
import { DEFAULT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS } from "../../agent/mcp-timeouts.js";
import { registerMcpAppForToolResult } from "./apps.js";

function mcpToolName(serverName, toolName, reservedNames) {
  if (!reservedNames.has(toolName)) return toolName;
  return `mcp__${serverName}__${toolName}`;
}

// Inactivity wall clock around an MCP call. `registerReset` (optional) hands the
// caller a rearm function so tool progress notifications can keep a legitimately
// long call alive; the SDK's maxTotalTimeout stays the hard cap.
function withTimeout(promise, timeoutMs, signal, label, registerReset) {
  if (signal?.aborted) return Promise.reject(new Error("tool execution aborted"));
  const ms = Number(timeoutMs) || 120000;
  let timeout;
  const timer = new Promise((_, reject) => {
    const arm = () => setTimeout(() => reject(new Error(`${label || "MCP tool"} timed out after ${ms}ms`)), ms);
    timeout = arm();
    registerReset?.(() => {
      clearTimeout(timeout);
      timeout = arm();
    });
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
}

/**
 * @param {any} mcpConfig
 * @param {Set<any>} [reservedNames]
 * @param {{limits?: any, mcpCallNoTotalTimeoutTools?: readonly string[], cwd?: any, persistArtifact?: any, qaOutputDir?: any, onTruncate?: any, toolPayloadMaxBytes?: number, sandboxPolicy?: any, sandboxEngine?: any, onToolProgress?: any, ctx?: any, mcpApps?: any, onRichOutput?: () => void, runId?: string}} [options]
 */
export async function initPiMcpTools(mcpConfig, reservedNames = new Set(), {
  limits = {},
  mcpCallNoTotalTimeoutTools = [],
  cwd = null,
  persistArtifact = null,
  qaOutputDir = null,
  onTruncate = null,
  toolPayloadMaxBytes = MAX_TOOL_RESULT_BYTES,
  sandboxPolicy = null,
  sandboxEngine = null,
  onToolProgress = null,
  ctx = null,
  mcpApps = null,
  onRichOutput = null,
  runId = null,
} = {}) {
  const clients = [];
  const tools = [];
  const entries = Object.entries(mcpConfig || {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const settled = await Promise.allSettled(entries.map(([name, cfg]) => connectMcpClient(name, cfg, {
    cwd,
    sandboxPolicy,
    sandboxEngine,
    ctx,
    mcpApps,
  })));
  const warnings = [];
  const seen = new Set(reservedNames);

  // Phase 1: collect connected clients in entry order (so tool registration is
  // deterministic) and record connect failures.
  const connectedList = [];
  for (const [index, result] of settled.entries()) {
    const serverName = entries[index]?.[0];
    if (result.status !== "fulfilled") {
      warnings.push({
        type: "runtime_warning",
        warning_kind: "mcp_init_failed",
        ...(result.reason?.code === "sandbox_denied" ? { code: "sandbox_denied" } : {}),
        server: serverName,
        message: result.reason?.message || String(result.reason),
      });
      continue;
    }
    clients.push(result.value);
    connectedList.push({ serverName, connected: result.value });
  }

  // Phase 2: list tools from every connected server CONCURRENTLY (previously
  // serial, adding ~Nx the slowest listTools to turn startup, painful over a
  // SOCKS proxy). Results are awaited in entry order to keep registration stable.
  const listings = await Promise.all(connectedList.map(async ({ serverName, connected }) => {
    try {
      return { serverName, connected, listed: await connected.client.listTools() };
    } catch (err) {
      return { serverName, connected, error: err };
    }
  }));

  for (const { serverName, connected, listed, error } of listings) {
    if (error) {
      warnings.push({
        type: "runtime_warning",
        warning_kind: "mcp_list_tools_failed",
        server: serverName,
        message: connected.privateCapabilityUrl
          ? "Private request-scoped MCP server did not expose its tools."
          : error?.message || String(error),
      });
      continue;
    }

    for (const sourceTool of [...(listed.tools || [])].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = mcpToolName(serverName, sourceTool.name, seen);
      if (seen.has(name)) continue;
      seen.add(name);
      tools.push({
        name,
        label: sourceTool.title || sourceTool.name,
        description: sourceTool.description || `${serverName}:${sourceTool.name}`,
        parameters: sourceTool.inputSchema || /** @type {any} */ (sourceTool).input_schema || objectSchema({}),
        async execute(toolCallId, params, signal) {
          if (signal?.aborted) throw new Error("tool execution aborted");
          // OWN this request's abort signal rather than forwarding the caller's
          // directly, so run teardown can cancel the call ON THE WIRE. The SDK
          // turns an abort into `notifications/cancelled`; closing the client
          // only rejects the caller locally (Protocol._onclose) and then
          // SIGTERM/SIGKILLs a stdio child with its request still outstanding —
          // which is how a proxy's upstream work was left dangling in #664.
          const callAbort = new AbortController();
          const forwardAbort = () => callAbort.abort(signal?.reason);
          signal?.addEventListener("abort", forwardAbort, { once: true });
          const inFlight = { controller: callAbort, label: `${serverName}:${sourceTool.name}` };
          connected.inFlight.add(inFlight);
          try {
            return await callMcpTool();
          } finally {
            connected.inFlight.delete(inFlight);
            signal?.removeEventListener("abort", forwardAbort);
          }

          async function callMcpTool() {
          const textLimit = limits.mcpTextLimitChars || MCP_TEXT_RESULT_LIMIT;
          const imageInlineMaxBytes = limits.imageInlineMaxBytes ?? MCP_IMAGE_INLINE_MAX_BYTES;
          const normalizedParams = normalizeMcpToolParams(serverName, sourceTool.name, params || {}, { qaOutputDir, ctx });
          // Measure the MCP round-trip so observability can separate slow MCP
          // servers (e.g. context-example over a SOCKS proxy) from model latency.
          const mcpCallStartMs = Date.now();
          // The MCP SDK's per-request timeout defaults to 60s (DEFAULT_REQUEST_TIMEOUT_MSEC),
          // which would fire -32001 well before the outer withTimeout wall-clock cap — fatal for
          // in-process tools that run a whole agent turn (e.g. notify_conversation delivery).
          // Pass it explicitly so the SDK request timeout matches our cap instead of pre-empting it.
          const mcpCallTimeoutMs = limits.mcpCallTimeoutMs || 120000;
          // Inactivity vs total: mcpCallTimeoutMs is reset by every progress
          // notification. A host may exempt one exact server:tool lifecycle
          // from the total cap; abort and the resettable inactivity cap remain.
          const mcpCallMaxTotalTimeoutMs = Math.max(
            limits.mcpCallMaxTotalTimeoutMs || DEFAULT_MCP_CALL_MAX_TOTAL_TIMEOUT_MS,
            mcpCallTimeoutMs,
          );
          const hasTotalTimeout = !mcpCallNoTotalTimeoutTools.includes(`${serverName}:${sourceTool.name}`);
          // The SDK only attaches a progressToken (and thus honors
          // resetTimeoutOnProgress) when an onprogress callback is present, so one
          // is always attached: it rearms the outer wall clock and optionally
          // surfaces the notification to the host.
          let resetInactivityTimeout = null;
          const onprogress = (progress) => {
            resetInactivityTimeout?.();
            onToolProgress?.({
              type: "tool_progress",
              server: serverName,
              tool: sourceTool.name,
              toolCallId,
              ...(progress?.progress === undefined ? {} : { progress: progress.progress }),
              ...(progress?.total === undefined ? {} : { total: progress.total }),
              ...(progress?.message === undefined ? {} : { message: progress.message }),
            });
          };
          const request = connected.client.callTool(
            { name: sourceTool.name, arguments: normalizedParams || {} },
            undefined,
            // Forward the abort signal too, so a cancelled/timed-out call also cancels the
            // in-flight MCP request on the wire (otherwise the SDK keeps awaiting until its own
            // timeout, and an in-process loopback turn could post late after the bridge rejected).
            {
              timeout: mcpCallTimeoutMs,
              resetTimeoutOnProgress: true,
              ...(hasTotalTimeout ? { maxTotalTimeout: mcpCallMaxTotalTimeoutMs } : {}),
              signal: callAbort.signal,
              onprogress,
            },
          ).catch((error) => {
            if (connected.privateCapabilityUrl) {
              throw new Error("Private request-scoped MCP tool call failed.");
            }
            throw error;
          });
          const out = await withTimeout(
            request,
            mcpCallTimeoutMs,
            callAbort.signal,
            `${serverName}:${sourceTool.name}`,
            (reset) => {
              resetInactivityTimeout = reset;
            },
          );
          const mcpCallDurationMs = Date.now() - mcpCallStartMs;
          if (mcpApps) {
            await registerMcpAppForToolResult({
              mcpApps,
              onRichOutput,
              runId,
              serverName,
              connected,
              sourceTool,
              listedTools: listed.tools || [],
              toolCallId,
              toolInput: normalizedParams || {},
              toolResult: out,
            });
          }
          const imageTruncations = [];
          return {
            content: await coerceMcpContent(out, {
              textLimit,
              imageInlineMaxBytes,
              persistArtifact,
              toolName: name,
              toolUseId: toolCallId,
              onTruncate: (event) => {
                imageTruncations.push(event);
                onTruncate?.(event);
              },
            }),
            details: {
              server: serverName,
              tool: sourceTool.name,
              // pi-agent-core treats a resolved execute() call as successful.
              // Preserve the MCP protocol's explicit error bit in details so
              // the harness after-tool hook can replace that default without
              // throwing away the bounded content or structuredContent below.
              ...(out?.isError === true ? { mcp_result_is_error: true } : {}),
              mcp_call_duration_ms: mcpCallDurationMs,
              result_truncated: mcpContentWasTruncated(out, { textLimit }) || imageTruncations.length > 0,
              raw: compactRawMcpResult(out),
              ...(imageTruncations.length ? {
                tool_payload_truncated: true,
                tool_payload_original_bytes: imageTruncations.reduce((sum, event) => sum + (Number(event.original_bytes) || 0), 0),
                tool_payload_saved_paths: imageTruncations.flatMap((event) => event.saved_paths || []),
              } : {}),
            },
          };
          }
        },
      });
    }
  }
  return {
    clients,
    tools: wrapToolsWithBloatGuard(tools, {
      persistArtifact,
      maxBytes: toolPayloadMaxBytes,
      onTruncate,
    }),
    warnings,
  };
}

export async function closePiMcpClients(clients, { timeoutMs = 5000 } = {}) {
  // Close the client first (stop accepting messages) then the transport (tear
  // down I/O), each bounded by a timeout so a hung stdio pipe cannot stall
  // shutdown — a common source of "Connection closed" churn on reconnect.
  await Promise.all((clients || []).map(async (connected) => {
    if (connected?.retainedByMcpApps === true) return;
    await closeConnectedMcpClient(connected, timeoutMs);
  }));
}
