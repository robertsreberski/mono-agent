// MCP Apps negotiation and originating-connection retention.
import { MCP_APP_SUPPORTED_VERSIONS, MCP_APP_RESOURCE_MIME_TYPE } from "@mono-agent/contracts";
import { closeConnectedMcpClient } from "./connection.js";

const MCP_APP_RESOURCE_MAX_BYTES = 2 * 1024 * 1024;

export async function registerMcpAppForToolResult({
  mcpApps,
  onRichOutput,
  runId,
  serverName,
  connected,
  sourceTool,
  listedTools,
  toolCallId,
  toolInput,
  toolResult,
}) {
  const resourceUri = mcpAppResourceUri(sourceTool);
  if (!resourceUri) return;
  // A negotiated app can outlive the tool result; it is already visible even
  // when a later turn tries to terminate silently.
  onRichOutput?.();
  const fail = async (code, message) => {
    try {
      await mcpApps.recordFailure({
        ...(runId ? { runId } : {}),
        serverName,
        toolName: sourceTool.name,
        toolCallId,
        code,
        message,
      });
    } catch { /* A rich-part failure cannot turn a successful MCP call into a failed tool. */ }
  };

  if (!resourceUri.startsWith("ui://")) {
    await fail("app_resource_invalid", "The MCP App resource URI is invalid.");
    return;
  }
  const hostVersions = Array.isArray(mcpApps.protocolVersions)
    ? mcpApps.protocolVersions.filter((value) => typeof value === "string")
    : [];
  const protocolVersion = MCP_APP_SUPPORTED_VERSIONS.find((version) => hostVersions.includes(version));
  const hostMimeTypes = Array.isArray(mcpApps.mimeTypes)
    ? mcpApps.mimeTypes.filter((value) => typeof value === "string")
    : [];
  if (
    !protocolVersion
    || !hostMimeTypes.includes(MCP_APP_RESOURCE_MIME_TYPE)
  ) {
    await fail("app_capability_mismatch", "The MCP App protocol or resource MIME type is incompatible with this host.");
    return;
  }

  let resource;
  try {
    const response = await connected.client.readResource({ uri: resourceUri });
    resource = selectMcpAppResource(response, resourceUri);
  } catch {
    await fail("app_resource_invalid", "The MCP App resource could not be resolved through its originating connection.");
    return;
  }
  if (!resource) {
    await fail("app_resource_invalid", "The MCP App resource is missing, oversized, or has an incompatible MIME type.");
    return;
  }

  const connection = {
    connectionId: connected.connectionId,
    readResource: async (uri) => await connected.client.readResource({ uri }),
    // Same in-flight registration as the tool path: a retained MCP App
    // connection torn down mid-call must cancel on the wire, not be closed out
    // from under the request. See closeConnectedMcpClient.
    callTool: async (name, args, signal) => {
      const callAbort = new AbortController();
      const forwardAbort = () => callAbort.abort(signal?.reason);
      signal?.addEventListener("abort", forwardAbort, { once: true });
      const inFlight = { controller: callAbort, label: `${serverName}:${name}` };
      connected.inFlight.add(inFlight);
      try {
        return await connected.client.callTool(
          { name, arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {} },
          undefined,
          {
            timeout: 120_000,
            maxTotalTimeout: 120_000,
            signal: callAbort.signal,
          },
        );
      } finally {
        connected.inFlight.delete(inFlight);
        signal?.removeEventListener("abort", forwardAbort);
      }
    },
    close: async () => {
      connected.retainedByMcpApps = false;
      await closeConnectedMcpClient(connected, 5_000);
    },
  };
  try {
    const registered = await mcpApps.register({
      ...(runId ? { runId } : {}),
      serverName,
      toolName: sourceTool.name,
      ...(typeof sourceTool.title === "string" ? { title: sourceTool.title } : {}),
      ...(typeof sourceTool.description === "string" ? { description: sourceTool.description } : {}),
      toolCallId,
      resourceUri,
      protocolVersion,
      toolInput,
      toolResult,
      resource,
      appVisibleTools: listedTools
        .filter((tool) => mcpToolVisibleToApp(tool))
        .map((tool) => tool.name),
      connection,
    });
    if (registered?.retainConnection === true && registered.part?.type === "mcp_app") {
      connected.retainedByMcpApps = true;
    }
  } catch {
    await fail("app_resource_invalid", "The MCP App host could not persist the negotiated resource.");
  }
}

function mcpAppResourceUri(tool) {
  const meta = tool?._meta || tool?.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  if (meta.ui && typeof meta.ui === "object" && !Array.isArray(meta.ui)
    && typeof meta.ui.resourceUri === "string") return meta.ui.resourceUri;
  return typeof meta["ui/resourceUri"] === "string" ? meta["ui/resourceUri"] : null;
}

function mcpToolVisibleToApp(tool) {
  const meta = tool?._meta || tool?.meta;
  const visibility = meta?.ui?.visibility;
  return !Array.isArray(visibility) || visibility.includes("app");
}

function selectMcpAppResource(response, resourceUri) {
  const content = Array.isArray(response?.contents)
    ? response.contents.find((entry) => entry?.uri === resourceUri)
    : null;
  if (!content || typeof content.text !== "string") return null;
  const mimeType = content.mimeType || content.mime_type;
  if (mimeType !== MCP_APP_RESOURCE_MIME_TYPE) return null;
  if (Buffer.byteLength(content.text, "utf8") > MCP_APP_RESOURCE_MAX_BYTES) return null;
  return {
    uri: resourceUri,
    mimeType,
    text: content.text,
    ...(content._meta && typeof content._meta === "object" && !Array.isArray(content._meta)
      ? { _meta: content._meta }
      : {}),
  };
}
