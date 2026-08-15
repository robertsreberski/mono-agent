export const MCP_APP_PROXY_PATH = "/api/v1/mcp-app-proxy";

const APP_HTML_MAX_BYTES = 2 * 1024 * 1024;
const BRIDGE_MESSAGE_MAX_BYTES = 1024 * 1024 + 64 * 1024;

/**
 * This policy applies only to the fixed, opaque-origin proxy document. The
 * nested app srcdoc inherits it, so inline script must remain available there;
 * no remote script or network source is admitted by this outer envelope.
 */
export const MCP_APP_PROXY_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src blob:",
  "connect-src 'none'",
  "frame-src 'self'",
  "child-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "navigate-to 'none'",
  "frame-ancestors 'self'",
].join("; ");

/**
 * Fixed trusted outer proxy for the MCP Apps double-iframe model.
 *
 * Invocation-specific values never enter this response or its URL. The direct
 * parent supplies one bounded configuration message after load; the proxy
 * derives the parent origin from the browser-authenticated MessageEvent and
 * permanently binds that document to the first valid identity tuple.
 */
export const MCP_APP_PROXY_DOCUMENT = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light">
<style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}iframe{width:100%;height:100%;display:block;border:0}</style>
</head>
<body>
<div id="root" aria-live="polite"></div>
<script>
(() => {
  "use strict";
  const parentWindow = window.parent;
  const root = document.getElementById("root");
  if (parentWindow === window || root === null) return;
  let config = null;
  let hostReady = false;
  let appFrame = null;
  let appFrameLoads = 0;
  let readyAttempts = 0;
  let readyTimer = null;
  const byteLength = (value) => {
    try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
    catch { return Number.POSITIVE_INFINITY; }
  };
  const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const isBoundedIdentity = (value) => typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !/[\\u0000-\\u001f\\u007f]/u.test(value);
  const isHostOrigin = (value) => {
    if (typeof value !== "string" || value === "null" || value.length > 2048) return false;
    try {
      const parsed = new URL(value);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === value;
    } catch {
      return false;
    }
  };
  const isConfiguration = (value) => {
    if (!isRecord(value) || byteLength(value) > 4096) return false;
    const keys = Object.keys(value);
    return keys.length === 5
      && keys.every((key) => key === "type" || key === "nonce" || key === "invocationId"
        || key === "connectionId" || key === "clipboardWrite")
      && value.type === "mono-agent:mcp-app-proxy-config"
      && isBoundedIdentity(value.nonce)
      && isBoundedIdentity(value.invocationId)
      && isBoundedIdentity(value.connectionId)
      && typeof value.clipboardWrite === "boolean";
  };
  const isRpc = (value) => isRecord(value)
    && value.jsonrpc === "2.0"
    && (typeof value.method === "string" || "id" in value);
  const identityMatches = (value) => config !== null
    && isRecord(value)
    && value.nonce === config.nonce
    && value.invocationId === config.invocationId
    && value.connectionId === config.connectionId;
  const sendHost = (value) => {
    if (config === null) return;
    try { parentWindow.postMessage(value, config.hostOrigin); }
    catch { /* A detached or navigated parent fails closed. */ }
  };
  const announceReady = () => {
    if (config === null || hostReady || readyAttempts++ >= 20) {
      if (readyTimer !== null) window.clearInterval(readyTimer);
      return;
    }
    sendHost({
      type: "mono-agent:mcp-app-proxy-ready",
      nonce: config.nonce,
      invocationId: config.invocationId,
      connectionId: config.connectionId,
    });
  };
  const configure = (event) => {
    if (config !== null || event.source !== parentWindow || !isHostOrigin(event.origin)) return;
    let candidate;
    try { candidate = event.data; }
    catch { return; }
    if (!isConfiguration(candidate)) return;
    config = Object.freeze({
      nonce: candidate.nonce,
      invocationId: candidate.invocationId,
      connectionId: candidate.connectionId,
      clipboardWrite: candidate.clipboardWrite,
      hostOrigin: event.origin,
    });
    readyTimer = window.setInterval(announceReady, 250);
    announceReady();
  };
  const mountResource = (params) => {
    if (config === null || appFrame !== null || !isRecord(params) || typeof params.html !== "string"
      || new TextEncoder().encode(params.html).byteLength > ${APP_HTML_MAX_BYTES}) return;
    const frame = document.createElement("iframe");
    frame.setAttribute("title", "MCP App content");
    frame.setAttribute("sandbox", "allow-scripts");
    if (config.clipboardWrite) frame.setAttribute("allow", "clipboard-write");
    frame.referrerPolicy = "no-referrer";
    frame.srcdoc = params.html;
    frame.addEventListener("load", () => {
      appFrameLoads += 1;
      if (appFrameLoads <= 1 || appFrame !== frame) return;
      appFrame = null;
      frame.remove();
      root.textContent = "App navigation was blocked.";
    });
    appFrame = frame;
    root.replaceChildren(frame);
  };
  window.addEventListener("message", (event) => {
    if (config === null) {
      configure(event);
      return;
    }
    if (event.source === parentWindow) {
      if (event.origin !== config.hostOrigin) return;
      if (event.data?.type === "mono-agent:mcp-app-host-ready") {
        if (!identityMatches(event.data) || hostReady) return;
        hostReady = true;
        if (readyTimer !== null) window.clearInterval(readyTimer);
        sendHost({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} });
        return;
      }
      if (!hostReady || !isRpc(event.data)) return;
      const max = event.data.method === "ui/notifications/sandbox-resource-ready"
        ? ${APP_HTML_MAX_BYTES + 64 * 1024}
        : ${BRIDGE_MESSAGE_MAX_BYTES};
      if (byteLength(event.data) > max) return;
      if (event.data.method === "ui/notifications/sandbox-resource-ready") {
        mountResource(event.data.params);
        return;
      }
      appFrame?.contentWindow?.postMessage(event.data, "*");
      return;
    }
    if (!hostReady || appFrame === null || event.source !== appFrame.contentWindow || event.origin !== "null") return;
    if (!isRpc(event.data) || byteLength(event.data) > ${BRIDGE_MESSAGE_MAX_BYTES}) return;
    if (event.data.method === "ui/notifications/sandbox-proxy-ready"
      || event.data.method === "ui/notifications/sandbox-resource-ready") return;
    sendHost(event.data);
  });
})();
</script>
</body>
</html>`;
