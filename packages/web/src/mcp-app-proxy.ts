import { MCP_APP_SECURED_HTML_MAX_BYTES } from "./mcp-app-document.js";

export const MCP_APP_PROXY_PATH = "/api/v1/mcp-app-proxy";

const BRIDGE_MESSAGE_MAX_BYTES = 1024 * 1024 + 64 * 1024;

/**
 * This policy applies only to the fixed, opaque-origin proxy document. The
 * nested app srcdoc inherits it, so capability directives belong exclusively
 * to the canonical inner meta policy. This envelope admits only the proxy/app
 * inline bootstrap and style while retaining non-clipping containment.
 */
export const MCP_APP_PROXY_CONTENT_SECURITY_POLICY = [
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
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
 * parent supplies bounded configuration after load; the proxy derives the
 * parent origin from the browser-authenticated MessageEvent, permanently binds
 * the first valid identity tuple, and accepts only an exact repeated
 * configuration to re-arm it. Host-ready remains a one-shot acknowledgement.
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
  let appFrameGeneration = 0;
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
  const exactSources = (directive, name) => {
    const prefix = name + " ";
    if (!directive.startsWith(prefix)) return null;
    const value = directive.slice(prefix.length);
    if (value.length === 0 || value.trim() !== value || /\\s{2,}/u.test(value)) return null;
    return value.split(" ");
  };
  const sameSources = (left, right) => left.length === right.length
    && left.every((value, index) => value === right[index]);
  const isSanitizedOrigin = (value) => {
    if (typeof value !== "string" || value.length > 2048) return false;
    try {
      const parsed = new URL(value);
      const localHttp = parsed.protocol === "http:"
        && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
      return (parsed.protocol === "https:" || localHttp)
        && parsed.origin === value
        && !parsed.username
        && !parsed.password
        && (parsed.pathname === "/" || parsed.pathname === "")
        && !parsed.search
        && !parsed.hash;
    } catch {
      return false;
    }
  };
  const isOriginSources = (sources) => sources.length === 1 && sources[0] === "'none'"
    || sources.length > 0
      && sources.length <= 64
      && new Set(sources).size === sources.length
      && sources.every(isSanitizedOrigin);
  const isCanonicalSecuredHtml = (html) => {
    const start = '<!doctype html><head><meta http-equiv="Content-Security-Policy" content="';
    const end = '"><meta name="referrer" content="no-referrer"></head>';
    if (!html.startsWith(start)) return false;
    const endIndex = html.indexOf(end, start.length);
    if (endIndex < 0) return false;
    const directives = html.slice(start.length, endIndex).split("; ");
    if (directives.length !== 15
      || directives[0] !== "default-src 'none'"
      || directives[1] !== "script-src 'unsafe-inline'"
      || directives[9] !== "form-action 'none'"
      || directives[10] !== "object-src 'none'"
      || directives[11] !== "child-src 'none'"
      || directives[12] !== "worker-src 'none'"
      || directives[13] !== "manifest-src 'none'"
      || directives[14] !== "navigate-to 'none'") return false;
    const styles = exactSources(directives[2], "style-src");
    const images = exactSources(directives[3], "img-src");
    const fonts = exactSources(directives[4], "font-src");
    const media = exactSources(directives[5], "media-src");
    const connects = exactSources(directives[6], "connect-src");
    const frames = exactSources(directives[7], "frame-src");
    const bases = exactSources(directives[8], "base-uri");
    if (styles === null || images === null || fonts === null || media === null
      || connects === null || frames === null || bases === null) return false;
    const resources = styles[0] === "'unsafe-inline'" ? styles.slice(1) : null;
    return resources !== null
      && resources.length <= 64
      && new Set(resources).size === resources.length
      && resources.every(isSanitizedOrigin)
      && sameSources(images, ["data:", "blob:", ...resources])
      && sameSources(fonts, ["data:", ...resources])
      && sameSources(media, ["blob:", ...resources])
      && isOriginSources(connects)
      && isOriginSources(frames)
      && isOriginSources(bases);
  };
  const sendHost = (value) => {
    if (config === null) return;
    try { parentWindow.postMessage(value, config.hostOrigin); }
    catch { /* A detached or navigated parent fails closed. */ }
  };
  const stopReadyAnnouncements = () => {
    if (readyTimer === null) return;
    window.clearInterval(readyTimer);
    readyTimer = null;
  };
  const announceReady = () => {
    if (config === null || hostReady || readyAttempts++ >= 20) {
      stopReadyAnnouncements();
      return;
    }
    sendHost({
      type: "mono-agent:mcp-app-proxy-ready",
      nonce: config.nonce,
      invocationId: config.invocationId,
      connectionId: config.connectionId,
    });
  };
  const armReadiness = () => {
    stopReadyAnnouncements();
    readyAttempts = 0;
    readyTimer = window.setInterval(announceReady, 250);
    announceReady();
  };
  const retireAppFrame = () => {
    const retired = appFrame;
    appFrame = null;
    appFrameGeneration += 1;
    retired?.remove();
    root.textContent = "";
  };
  const configure = (event) => {
    if (event.source !== parentWindow || !isHostOrigin(event.origin)) return;
    let candidate;
    try { candidate = event.data; }
    catch { return; }
    if (!isConfiguration(candidate)) return;
    if (config === null) {
      config = Object.freeze({
        nonce: candidate.nonce,
        invocationId: candidate.invocationId,
        connectionId: candidate.connectionId,
        clipboardWrite: candidate.clipboardWrite,
        hostOrigin: event.origin,
      });
      armReadiness();
      return;
    }
    if (event.origin !== config.hostOrigin || !identityMatches(candidate)
      || candidate.clipboardWrite !== config.clipboardWrite || !hostReady) return;
    // Configuration is the re-arm request. A delayed duplicate host-ready must
    // never retire a live app whose host bridge has no remaining ready listener.
    hostReady = false;
    retireAppFrame();
    armReadiness();
  };
  const mountResource = (params) => {
    if (config === null || appFrame !== null || !isRecord(params) || typeof params.html !== "string"
      || new TextEncoder().encode(params.html).byteLength > ${MCP_APP_SECURED_HTML_MAX_BYTES}
      || !isCanonicalSecuredHtml(params.html)) return;
    const frame = document.createElement("iframe");
    frame.setAttribute("title", "MCP App content");
    frame.setAttribute("sandbox", "allow-scripts");
    if (config.clipboardWrite) frame.setAttribute("allow", "clipboard-write");
    frame.referrerPolicy = "no-referrer";
    const generation = ++appFrameGeneration;
    let frameLoads = 0;
    frame.srcdoc = params.html;
    frame.addEventListener("load", () => {
      if (appFrame !== frame || appFrameGeneration !== generation) return;
      frameLoads += 1;
      if (frameLoads <= 1) return;
      appFrame = null;
      appFrameGeneration += 1;
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
      if (event.data?.type === "mono-agent:mcp-app-proxy-config") {
        configure(event);
        return;
      }
      if (event.data?.type === "mono-agent:mcp-app-host-ready") {
        // Host-ready acknowledges only the current configuration arm. Repeated
        // or delayed copies are idempotently ignored while the app stays live.
        if (!identityMatches(event.data) || hostReady) return;
        hostReady = true;
        stopReadyAnnouncements();
        sendHost({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} });
        return;
      }
      if (!hostReady || !isRpc(event.data)) return;
      const max = event.data.method === "ui/notifications/sandbox-resource-ready"
        ? ${MCP_APP_SECURED_HTML_MAX_BYTES + 64 * 1024}
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
