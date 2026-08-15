import {
  AppBridge,
  PostMessageTransport,
  buildAllowAttribute,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { DataMessagePartProps } from "@assistant-ui/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { api, isReplyAccessExpired, sameOriginReplyUrl } from "../api";
import { isMcpAppProtocolVersion } from "../mcp-app-protocol";
import type { McpAppPart, McpAppResource, MessagePart } from "../types";
import { Icon } from "./Icon";

const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
const APP_HTML_MAX_BYTES = 2 * 1024 * 1024;
const BRIDGE_MESSAGE_MAX_BYTES = 1024 * 1024 + 64 * 1024;
const APP_MIN_HEIGHT = 160;
const APP_MAX_HEIGHT = 800;

type ReplyAttachmentPart = Extract<MessagePart, { readonly type: "attachment" }>;
type ReplyFailurePart = Extract<MessagePart, { readonly type: "failure" }>;
type CallToolResult = Awaited<ReturnType<NonNullable<AppBridge["oncalltool"]>>>;
type ReadResourceResult = Awaited<ReturnType<NonNullable<AppBridge["onreadresource"]>>>;

interface SafeResourceMetadata {
  readonly csp?: McpUiResourceCsp;
  readonly permissions?: McpUiResourcePermissions;
}

export interface McpAppHostOriginAllowlist {
  readonly connectOrigins?: readonly string[];
  readonly resourceOrigins?: readonly string[];
  readonly frameOrigins?: readonly string[];
  readonly baseUriOrigins?: readonly string[];
}

interface ConfirmationRequest {
  readonly id: number;
  readonly title: string;
  readonly detail: string;
  readonly preview?: string;
  readonly resolve: (confirmed: boolean) => void;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const byteSize = (value: string): number => new TextEncoder().encode(value).byteLength;

const boundedText = (value: unknown, maxLength: number): string | undefined =>
  typeof value === "string" && value.trim().length > 0
    ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, maxLength)
    : undefined;

const SECRET_ARGUMENT_KEY = /(?:authorization|auth|token|api[_-]?key|password|passwd|secret|cookie|credential|session)/iu;
const ARGUMENT_PREVIEW_MAX_BYTES = 2_048;

const previewValue = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 240);
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return `[${typeof value}]`;
  if (depth >= 4) return "[depth limit]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, 12).map((item) => previewValue(item, depth + 1, seen));
    if (value.length > 12) result.push(`[${String(value.length - 12)} more items]`);
    return result;
  }
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 16);
  for (const [key, item] of entries) {
    result[key.slice(0, 120)] = SECRET_ARGUMENT_KEY.test(key)
      ? "[redacted]"
      : previewValue(item, depth + 1, seen);
  }
  if (Object.keys(value).length > entries.length) result["…"] = "[more fields]";
  return result;
};

/** Bounded, depth-limited, secret-key-redacted preview for confirmation dialogs. */
export const mcpAppArgumentPreview = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  let rendered: string;
  try {
    rendered = JSON.stringify(previewValue(value, 0, new WeakSet()), null, 2);
  } catch {
    rendered = "[unavailable]";
  }
  if (byteSize(rendered) <= ARGUMENT_PREVIEW_MAX_BYTES) return rendered;
  let end = Math.min(rendered.length, ARGUMENT_PREVIEW_MAX_BYTES);
  while (end > 0 && byteSize(`${rendered.slice(0, end)}…`) > ARGUMENT_PREVIEW_MAX_BYTES) end -= 1;
  return `${rendered.slice(0, end)}…`;
};

export type ExternalWindowOpener = (url: string, target: string, features: string) => Window | null;

/** `noopener` intentionally permits a successful open to return null. */
export const openExternalMcpAppLink = (
  url: string,
  opener: ExternalWindowOpener = (href, target, features) => window.open(href, target, features),
): boolean => {
  try {
    const opened = opener(url, "_blank", "noopener,noreferrer");
    if (opened !== null) {
      try {
        opened.opener = null;
      } catch {
        // The new browsing context is already isolated by noopener.
      }
    }
    return true;
  } catch {
    return false;
  }
};

const safeDeclaredOrigin = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    const localHttp = url.protocol === "http:"
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (url.protocol !== "https:" && !localHttp) return undefined;
    if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
};

const declaredOrigins = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const origins = [...new Set(value.map(safeDeclaredOrigin).filter((item): item is string => item !== undefined))];
  return origins.length > 0 ? origins.slice(0, 64) : undefined;
};

const intersectDeclaredOrigins = (
  declared: unknown,
  allowed: readonly string[] | undefined,
): string[] | undefined => {
  const allowlist = new Set(
    (allowed ?? []).map(safeDeclaredOrigin).filter((item): item is string => item !== undefined),
  );
  if (allowlist.size === 0) return undefined;
  const effective = declaredOrigins(declared)?.filter((origin) => allowlist.has(origin));
  return effective === undefined || effective.length === 0 ? undefined : effective;
};

/** Reduce server-declared policy to capabilities this console actually grants. */
export const safeMcpAppResourceMetadata = (
  value: unknown,
  hostAllowlist: McpAppHostOriginAllowlist = {},
): SafeResourceMetadata => {
  const outer = record(value);
  const ui = record(outer?.ui) ?? outer;
  const cspInput = record(ui?.csp);
  const permissionsInput = record(ui?.permissions);
  const connectDomains = intersectDeclaredOrigins(cspInput?.connectDomains, hostAllowlist.connectOrigins);
  const resourceDomains = intersectDeclaredOrigins(cspInput?.resourceDomains, hostAllowlist.resourceOrigins);
  const frameDomains = intersectDeclaredOrigins(cspInput?.frameDomains, hostAllowlist.frameOrigins);
  const baseUriDomains = intersectDeclaredOrigins(cspInput?.baseUriDomains, hostAllowlist.baseUriOrigins);
  const csp = cspInput === undefined ? undefined : {
    ...(connectDomains === undefined ? {} : { connectDomains }),
    ...(resourceDomains === undefined ? {} : { resourceDomains }),
    ...(frameDomains === undefined ? {} : { frameDomains }),
    ...(baseUriDomains === undefined ? {} : { baseUriDomains }),
  };
  // Camera, microphone, and geolocation remain unavailable. Clipboard writes
  // are the only optional browser permission intersected by this host.
  const permissions = record(permissionsInput?.clipboardWrite) === undefined
    ? undefined
    : { clipboardWrite: {} };
  return {
    ...(csp === undefined ? {} : { csp }),
    ...(permissions === undefined ? {} : { permissions }),
  };
};

/** Build the inner document policy from already intersected host grants. */
export const mcpAppContentSecurityPolicy = (metadata: SafeResourceMetadata): string => {
  const resources = metadata.csp?.resourceDomains ?? [];
  const connects = metadata.csp?.connectDomains ?? [];
  const frames = metadata.csp?.frameDomains ?? [];
  const bases = metadata.csp?.baseUriDomains ?? [];
  const sources = (items: readonly string[], extras: readonly string[] = []) =>
    [...extras, ...items].join(" ") || "'none'";
  return [
    "default-src 'none'",
    // Server-declared resource origins never become executable-script origins.
    "script-src 'unsafe-inline'",
    `style-src 'unsafe-inline'${resources.length > 0 ? ` ${resources.join(" ")}` : ""}`,
    `img-src ${sources(resources, ["data:", "blob:"])}`,
    `font-src ${sources(resources, ["data:"])}`,
    `media-src ${sources(resources, ["blob:"])}`,
    `connect-src ${sources(connects)}`,
    `frame-src ${sources(frames)}`,
    `base-uri ${sources(bases)}`,
    "form-action 'none'",
    "object-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "navigate-to 'none'",
  ].join("; ");
};

const htmlAttribute = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;");

/** Place the restrictive policy before any server-controlled markup executes. */
export const secureMcpAppHtml = (html: string, metadata: SafeResourceMetadata): string => {
  if (byteSize(html) > APP_HTML_MAX_BYTES) throw new Error("The MCP App resource is too large.");
  const csp = htmlAttribute(mcpAppContentSecurityPolicy(metadata));
  return `<!doctype html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"></head>${html}`;
};

const createNonce = (): string => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
};

/**
 * Trusted outer proxy for the MCP Apps double-iframe model.
 *
 * It has an opaque origin and no ambient capabilities. The app receives a
 * second opaque origin and can exchange only bounded JSON-RPC messages with
 * the one host instance that completed this nonce/identity handshake.
 */
export const mcpAppSandboxProxyDocument = (input: {
  readonly nonce: string;
  readonly invocationId: string;
  readonly connectionId: string;
  readonly hostOrigin: string;
  readonly allow: string;
}): string => {
  const config = JSON.stringify(input).replaceAll("<", "\\u003c");
  return `<!doctype html>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; child-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; navigate-to 'none'">
<meta name="referrer" content="no-referrer">
<style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}iframe{width:100%;height:100%;display:block;border:0}</style>
<div id="root" aria-live="polite"></div>
<script>
(() => {
  "use strict";
  const config = ${config};
  const root = document.getElementById("root");
  let hostReady = false;
  let appFrame = null;
  let appFrameLoads = 0;
  let readyAttempts = 0;
  const byteLength = (value) => {
    try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
    catch { return Number.POSITIVE_INFINITY; }
  };
  const isRpc = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
    && value.jsonrpc === "2.0"
    && (typeof value.method === "string" || "id" in value);
  const identityMatches = (value) => value !== null && typeof value === "object"
    && value.nonce === config.nonce
    && value.invocationId === config.invocationId
    && value.connectionId === config.connectionId;
  const sendHost = (value) => window.parent.postMessage(value, config.hostOrigin);
  const mountResource = (params) => {
    if (appFrame || !params || typeof params.html !== "string"
      || new TextEncoder().encode(params.html).byteLength > ${APP_HTML_MAX_BYTES}) return;
    const frame = document.createElement("iframe");
    frame.setAttribute("title", "MCP App content");
    frame.setAttribute("sandbox", "allow-scripts");
    if (config.allow) frame.setAttribute("allow", config.allow);
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
    if (event.source === window.parent) {
      if (event.origin !== config.hostOrigin) return;
      if (event.data?.type === "mono-agent:mcp-app-host-ready") {
        if (!identityMatches(event.data) || hostReady) return;
        hostReady = true;
        window.clearInterval(readyTimer);
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
      // The inner sandbox has an opaque origin, so an exact target origin is
      // impossible here; source-window and bounded-RPC checks are the binding.
      appFrame?.contentWindow?.postMessage(event.data, "*");
      return;
    }
    if (!hostReady || !appFrame || event.source !== appFrame.contentWindow || event.origin !== "null") return;
    if (!isRpc(event.data) || byteLength(event.data) > ${BRIDGE_MESSAGE_MAX_BYTES}) return;
    if (event.data.method === "ui/notifications/sandbox-proxy-ready"
      || event.data.method === "ui/notifications/sandbox-resource-ready") return;
    sendHost(event.data);
  });
  const announceReady = () => {
    if (hostReady || readyAttempts++ >= 20) {
      window.clearInterval(readyTimer);
      return;
    }
    sendHost({
      type: "mono-agent:mcp-app-proxy-ready",
      nonce: config.nonce,
      invocationId: config.invocationId,
      connectionId: config.connectionId,
    });
  };
  const readyTimer = window.setInterval(announceReady, 250);
  announceReady();
})();
</script>`;
};

const formatBytes = (size: number): string => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
};

const parseAttachment = (value: unknown): ReplyAttachmentPart | undefined => {
  const part = record(value);
  return part?.type === "attachment"
    && typeof part.id === "string"
    && typeof part.name === "string"
    && typeof part.mediaType === "string"
    && Number.isSafeInteger(part.sizeBytes)
    && typeof part.integrityId === "string"
    ? part as unknown as ReplyAttachmentPart
    : undefined;
};

const parseFailure = (value: unknown): ReplyFailurePart | undefined => {
  const part = record(value);
  return part?.type === "failure" && typeof part.code === "string" && typeof part.message === "string"
    ? part as unknown as ReplyFailurePart
    : undefined;
};

const parseMcpApp = (value: unknown): McpAppPart | undefined => {
  const part = record(value);
  return part?.type === "mcp_app"
    && typeof part.id === "string"
    && typeof part.invocationId === "string"
    && typeof part.connectionId === "string"
    && typeof part.serverName === "string"
    && typeof part.toolName === "string"
    && typeof part.resourceUri === "string"
    && part.mediaType === MCP_APP_MIME_TYPE
    && isMcpAppProtocolVersion(part.protocolVersion)
    ? part as unknown as McpAppPart
    : undefined;
};

/** Download only bytes already fetched through an authorized same-origin request. */
export const startReplyAttachmentDownload = (blob: Blob, name: string): void => {
  const contentUrl = URL.createObjectURL(blob);
  const revokeObjectUrl = URL.revokeObjectURL.bind(URL);
  const link = document.createElement("a");
  link.href = contentUrl;
  link.download = name;
  link.rel = "noopener noreferrer";
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => revokeObjectUrl(contentUrl), 0);
  }
};

export function ReplyAttachmentPart({ data }: DataMessagePartProps) {
  const part = parseAttachment(data);
  const [downloadState, setDownloadState] = useState<"idle" | "refreshing" | "started" | "expired" | "error">("idle");
  const [downloadStatus, setDownloadStatus] = useState("");
  if (part === undefined) {
    return <div className="reply-part-error" role="alert">An attachment reference was invalid.</div>;
  }
  let contentUrl: string | undefined;
  try {
    contentUrl = part.contentUrl === undefined ? undefined : sameOriginReplyUrl(part.contentUrl);
  } catch {
    contentUrl = undefined;
  }
  return (
    <section className="reply-attachment" aria-label={`File attachment: ${part.name}`}>
      <span className="reply-part-icon"><Icon name="file" size={16} /></span>
      <span className="reply-part-copy">
        <strong>{part.name}</strong>
        <span>{part.mediaType} · {formatBytes(part.sizeBytes)}</span>
      </span>
      {contentUrl === undefined
        ? <span className="reply-part-unavailable" role="status">This file is no longer available.</span>
        : (
          <button
            type="button"
            className="reply-part-action"
            disabled={downloadState === "refreshing"}
            onClick={() => {
              setDownloadState("refreshing");
              setDownloadStatus("Refreshing download access…");
              void api.replyAttachmentContent(contentUrl).then(async (response) => {
                if (
                  Number(response.headers.get("content-length")) !== part.sizeBytes
                  || response.headers.get("x-mono-agent-integrity-id") !== part.integrityId
                ) {
                  throw new Error("The refreshed attachment metadata changed.");
                }
                const blob = await response.blob();
                if (blob.size !== part.sizeBytes) throw new Error("The refreshed attachment size changed.");
                startReplyAttachmentDownload(blob, part.name);
                setDownloadState("started");
                setDownloadStatus("Download started with refreshed access.");
              }).catch((error: unknown) => {
                const expired = isReplyAccessExpired(error);
                setDownloadState(expired ? "expired" : "error");
                setDownloadStatus(expired
                  ? "Download access expired. Refresh and try again."
                  : "Download access could not be refreshed. Try again.");
              });
            }}
          >
            {downloadState === "expired" ? "Refresh access" : downloadState === "error" ? "Try again" : "Download"}
            <span className="sr-only"> {part.name}</span>
          </button>
        )}
      {downloadStatus.length > 0 && <span className="reply-part-status" role="status" aria-live="polite">{downloadStatus}</span>}
    </section>
  );
}

export function ReplyFailurePart({ data }: DataMessagePartProps) {
  const part = parseFailure(data);
  return (
    <div className="reply-part-error" role="alert">
      <strong>{part?.code ?? "Reply part unavailable"}</strong>
      <span>{part?.message ?? "A rich reply part could not be displayed."}</span>
    </div>
  );
}

const resourceIdentityMatches = (part: McpAppPart, resource: McpAppResource): boolean =>
  resource.app.invocationId === part.invocationId
  && resource.app.connectionId === part.connectionId
  && resource.app.resourceUri === part.resourceUri
  && resource.app.protocolVersion === part.protocolVersion
  && resource.app.mediaType === part.mediaType;

const toolArguments = (value: unknown): Record<string, unknown> | undefined => record(value);

const toolResult = (value: unknown): CallToolResult => {
  const result = record(value);
  if (Array.isArray(result?.content)) return value as CallToolResult;
  return {
    content: [{ type: "text", text: "The MCP tool returned an invalid app result." }],
    isError: true,
  };
};

const hostContext = (height: number) => ({
  theme: window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" as const : "light" as const,
  displayMode: "inline" as const,
  availableDisplayModes: ["inline" as const],
  containerDimensions: { maxWidth: 880, maxHeight: Math.min(APP_MAX_HEIGHT, Math.max(APP_MIN_HEIGHT, height)) },
  locale: navigator.language || "en",
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  userAgent: navigator.userAgent,
  platform: window.matchMedia?.("(max-width: 600px)").matches ? "mobile" as const : "web" as const,
  deviceCapabilities: {
    touch: navigator.maxTouchPoints > 0,
    hover: window.matchMedia?.("(hover: hover)").matches ?? false,
  },
});

export function McpAppPart({ data }: DataMessagePartProps) {
  const part = parseMcpApp(data);
  const [resource, setResource] = useState<McpAppResource | null>(null);
  const [status, setStatus] = useState<"loading" | "connecting" | "ready" | "closed" | "error">("loading");
  const [statusText, setStatusText] = useState("Loading interactive app…");
  const [height, setHeight] = useState(320);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [accessExpired, setAccessExpired] = useState(false);
  const [accessRevision, setAccessRevision] = useState(0);
  const confirmationRef = useRef<ConfirmationRequest | null>(null);
  const confirmationId = useRef(0);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const containerRef = useRef<HTMLElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const nonce = useMemo(createNonce, [part?.invocationId]);

  const settleConfirmation = useCallback((confirmed: boolean) => {
    const pending = confirmationRef.current;
    if (pending === null) return;
    confirmationRef.current = null;
    setConfirmation(null);
    pending.resolve(confirmed);
    window.setTimeout(() => returnFocusRef.current?.focus(), 0);
  }, []);

  const requestConfirmation = useCallback((
    title: string,
    detail: string,
    preview?: string,
  ): Promise<boolean> => {
    if (confirmationRef.current !== null) return Promise.resolve(false);
    return new Promise((resolve) => {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const request = {
        id: ++confirmationId.current,
        title,
        detail,
        ...(preview === undefined ? {} : { preview }),
        resolve,
      };
      confirmationRef.current = request;
      setConfirmation(request);
    });
  }, []);

  useEffect(() => {
    if (confirmation !== null) confirmButtonRef.current?.focus();
  }, [confirmation]);

  useEffect(() => () => {
    const pending = confirmationRef.current;
    confirmationRef.current = null;
    pending?.resolve(false);
  }, []);

  useEffect(() => {
    if (part === undefined || part.resourceUrl === undefined || part.bridgeUrl === undefined) {
      setStatus("error");
      setStatusText("This MCP App does not have a valid private host endpoint.");
      return;
    }
    const controller = new AbortController();
    setResource(null);
    setAccessExpired(false);
    setStatus("loading");
    setStatusText("Loading interactive app…");
    void api.mcpAppResource(part.resourceUrl, controller.signal).then((loaded) => {
      if (!resourceIdentityMatches(part, loaded)) throw new Error("The MCP App identity changed during loading.");
      if (!loaded.connected) throw new Error("The originating MCP connection is no longer available.");
      setResource(loaded);
      setStatus("connecting");
      setStatusText("Starting the isolated app…");
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const expired = isReplyAccessExpired(error);
      setAccessExpired(expired);
      setStatus("error");
      setStatusText(expired
        ? "Interactive app access expired. Refresh access to reconnect."
        : error instanceof Error ? error.message : "The MCP App could not be loaded.");
    });
    return () => controller.abort();
  }, [accessRevision, part?.bridgeUrl, part?.connectionId, part?.invocationId, part?.resourceUrl]);

  const metadata = useMemo(
    () => safeMcpAppResourceMetadata(resource?.resourceMetadata),
    [resource?.resourceMetadata],
  );
  const secured = useMemo((): { readonly html?: string; readonly error?: string } => {
    if (resource === null) return {};
    try {
      return { html: secureMcpAppHtml(resource.html, metadata) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "The MCP App resource is invalid." };
    }
  }, [metadata, resource]);
  useEffect(() => {
    if (secured.error === undefined) return;
    setStatus("error");
    setStatusText(secured.error);
  }, [secured.error]);
  const securedHtml = secured.html;
  const allow = useMemo(() => buildAllowAttribute(metadata.permissions), [metadata.permissions]);
  const proxyDocument = useMemo(() => part === undefined ? "" : mcpAppSandboxProxyDocument({
    nonce,
    invocationId: part.invocationId,
    connectionId: part.connectionId,
    hostOrigin: window.location.origin,
    allow,
  }), [allow, nonce, part?.connectionId, part?.invocationId]);

  useEffect(() => {
    if (
      part === undefined
      || part.bridgeUrl === undefined
      || resource === null
      || securedHtml === undefined
      || status === "closed"
    ) return;
    const frameWindow = iframeRef.current?.contentWindow;
    if (frameWindow === undefined || frameWindow === null) return;
    let disposed = false;
    let bridge: AppBridge | undefined;
    let transport: PostMessageTransport | undefined;
    const bridgeUrl = part.bridgeUrl;

    const forward = async (
      method: "resources/read" | "tools/call" | "ui/open-link" | "ui/update-model-context",
      params: unknown,
      confirmed: boolean,
    ): Promise<unknown> => {
      try {
        return await api.mcpAppRequest(bridgeUrl, method, params, confirmed);
      } catch (error) {
        if (isReplyAccessExpired(error)) {
          setAccessExpired(true);
          setStatus("error");
          setStatusText("Interactive app access expired. Refresh access to reconnect.");
        }
        throw error;
      }
    };

    const ready = async (event: MessageEvent): Promise<void> => {
      if (
        event.source !== frameWindow
        || event.origin !== "null"
        || record(event.data)?.type !== "mono-agent:mcp-app-proxy-ready"
        || record(event.data)?.nonce !== nonce
        || record(event.data)?.invocationId !== part.invocationId
        || record(event.data)?.connectionId !== part.connectionId
      ) return;
      window.removeEventListener("message", onReady);
      try {
        bridge = new AppBridge(
          null,
          { name: "mono-agent web console", version: "0.4.0" },
          {
            openLinks: {},
            serverTools: {},
            serverResources: {},
            sandbox: { permissions: { clipboardWrite: {} }, csp: {} },
            updateModelContext: {
              text: {},
              resource: {},
              resourceLink: {},
              structuredContent: {},
            },
          },
          { hostContext: hostContext(height) },
        );
        transport = new PostMessageTransport(frameWindow, frameWindow);
        bridge.onsandboxready = () => {
          void bridge?.sendSandboxResourceReady({
            html: securedHtml,
            sandbox: "allow-scripts",
            ...(metadata.csp === undefined ? {} : { csp: metadata.csp }),
            ...(metadata.permissions === undefined ? {} : { permissions: metadata.permissions }),
          }).catch((error: unknown) => {
            if (disposed) return;
            setStatus("error");
            setStatusText(error instanceof Error ? error.message : "The app sandbox rejected its resource.");
          });
        };
        bridge.oninitialized = () => {
          void (async () => {
            await bridge?.sendToolInput({ arguments: toolArguments(resource.toolInput) });
            await bridge?.sendToolResult(toolResult(resource.toolResult));
            if (!disposed) {
              setStatus("ready");
              setStatusText("Interactive app ready.");
            }
          })().catch((error: unknown) => {
            if (disposed) return;
            setStatus("error");
            setStatusText(error instanceof Error ? error.message : "The app could not be initialized.");
          });
        };
        bridge.onsizechange = ({ height: requestedHeight }) => {
          if (typeof requestedHeight === "number" && Number.isFinite(requestedHeight)) {
            setHeight(Math.round(Math.min(APP_MAX_HEIGHT, Math.max(APP_MIN_HEIGHT, requestedHeight))));
          }
        };
        bridge.oncalltool = async (params) => {
          const name = boundedText(params.name, 256) ?? "requested tool";
          const confirmed = await requestConfirmation(
            "Allow app tool call?",
            `Run ${name} on ${part.serverName}.`,
            mcpAppArgumentPreview(params.arguments),
          );
          if (!confirmed) throw new Error("The user declined the MCP App tool call.");
          return await forward("tools/call", params, true) as CallToolResult;
        };
        bridge.onreadresource = async (params) =>
          await forward("resources/read", params, false) as ReadResourceResult;
        bridge.onopenlink = async (params) => {
          const url = boundedText(params.url, 8_192) ?? "the requested link";
          const confirmed = await requestConfirmation("Open external link?", url);
          if (!confirmed) return { isError: true };
          const result = record(await forward("ui/open-link", params, true));
          const approved = result?.allowed === true && typeof result.url === "string" ? result.url : undefined;
          if (approved === undefined) return { isError: true };
          if (!openExternalMcpAppLink(approved)) {
            setStatusText("The browser blocked the app's external link.");
            return { isError: true };
          }
          return {};
        };
        bridge.onupdatemodelcontext = async (params) => {
          const confirmed = await requestConfirmation(
            "Allow app context update?",
            "The app wants to prepare context for a future model turn.",
          );
          if (!confirmed) throw new Error("The user declined the MCP App context update.");
          const result = record(await forward("ui/update-model-context", params, true));
          if (result?.accepted !== true) {
            throw new Error(boundedText(result?.reason, 500) ?? "The host did not apply the context update.");
          }
          return {};
        };
        bridge.onrequestteardown = () => {
          setStatus("closed");
          setStatusText("The interactive app closed.");
        };
        bridge.onerror = (error) => {
          if (disposed) return;
          setStatus("error");
          setStatusText(error.message || "The app bridge reported an error.");
        };
        await bridge.connect(transport);
        if (disposed) return;
        bridgeRef.current = bridge;
        frameWindow.postMessage({
          type: "mono-agent:mcp-app-host-ready",
          nonce,
          invocationId: part.invocationId,
          connectionId: part.connectionId,
        }, "*");
      } catch (error) {
        if (disposed) return;
        setStatus("error");
        setStatusText(error instanceof Error ? error.message : "The app bridge could not start.");
      }
    };
    const onReady = (event: MessageEvent) => { void ready(event); };
    window.addEventListener("message", onReady);
    return () => {
      disposed = true;
      if (bridgeRef.current === bridge) bridgeRef.current = null;
      window.removeEventListener("message", onReady);
      void bridge?.teardownResource({}, { timeout: 500 }).catch(() => undefined).finally(() => {
        void transport?.close().catch(() => undefined);
      });
    };
  // The bridge lifecycle is one exact published app instance. Height updates
  // are sent through size notifications and must not recreate the transport.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadata, nonce, part?.bridgeUrl, part?.connectionId, part?.invocationId, requestConfirmation, resource, securedHtml, status === "closed"]);

  useEffect(() => {
    const syncHostContext = () => {
      const width = containerRef.current?.clientWidth ?? 880;
      bridgeRef.current?.setHostContext({
        ...hostContext(height),
        containerDimensions: {
          maxWidth: Math.max(240, Math.min(880, width)),
          maxHeight: Math.min(APP_MAX_HEIGHT, Math.max(APP_MIN_HEIGHT, height)),
        },
      });
    };
    const observer = typeof ResizeObserver === "function" && containerRef.current !== null
      ? new ResizeObserver(syncHostContext)
      : undefined;
    if (containerRef.current !== null) observer?.observe(containerRef.current);
    const theme = window.matchMedia?.("(prefers-color-scheme: dark)");
    window.addEventListener("resize", syncHostContext);
    theme?.addEventListener?.("change", syncHostContext);
    syncHostContext();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", syncHostContext);
      theme?.removeEventListener?.("change", syncHostContext);
    };
  }, [height]);

  if (part === undefined) {
    return <div className="reply-part-error" role="alert">An MCP App reference was invalid.</div>;
  }

  return (
    <section ref={containerRef} className="mcp-app" aria-label={`Interactive app: ${part.title ?? part.toolName}`}>
      <header inert={confirmation !== null} aria-hidden={confirmation !== null}>
        <span className="reply-part-icon"><Icon name="spark" size={16} /></span>
        <span className="reply-part-copy">
          <strong>{part.title ?? part.toolName}</strong>
          <span>{part.description ?? `${part.serverName} · ${part.toolName}`}</span>
        </span>
        {status !== "closed" && (
          <button
            type="button"
            className="reply-part-action"
            disabled={confirmation !== null}
            onClick={() => {
              setStatus("closed");
              setStatusText("The interactive app closed.");
            }}
          >Close<span className="sr-only"> {part.title ?? part.toolName}</span></button>
        )}
        {accessExpired && status !== "closed" && (
          <button
            type="button"
            className="reply-part-action"
            disabled={confirmation !== null}
            onClick={() => setAccessRevision((revision) => revision + 1)}
          >Refresh app access<span className="sr-only"> for {part.title ?? part.toolName}</span></button>
        )}
      </header>
      <p className={`mcp-app-status is-${status}`} role="status">{statusText}</p>
      {resource !== null && securedHtml !== undefined && status !== "closed" && (
        <iframe
          ref={iframeRef}
          className="mcp-app-frame"
          title={`${part.title ?? part.toolName} interactive app`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          inert={confirmation !== null}
          aria-hidden={confirmation !== null}
          tabIndex={confirmation === null ? 0 : -1}
          srcDoc={proxyDocument}
          style={{ height }}
        />
      )}
      {confirmation !== null && (
        <div
          className="mcp-app-confirmation"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`mcp-app-confirm-title-${confirmation.id}`}
          aria-describedby={[
            `mcp-app-confirm-detail-${confirmation.id}`,
            ...(confirmation.preview === undefined ? [] : [`mcp-app-confirm-preview-${confirmation.id}`]),
          ].join(" ")}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              settleConfirmation(false);
              return;
            }
            if (event.key === "Tab") {
              const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
              const first = buttons.at(0);
              const last = buttons.at(-1);
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
          }}
        >
          <strong id={`mcp-app-confirm-title-${confirmation.id}`}>{confirmation.title}</strong>
          <span id={`mcp-app-confirm-detail-${confirmation.id}`}>{confirmation.detail}</span>
          {confirmation.preview !== undefined && (
            <pre id={`mcp-app-confirm-preview-${confirmation.id}`} className="mcp-app-confirm-preview">
              {confirmation.preview}
            </pre>
          )}
          <span className="mcp-app-confirm-actions">
            <button type="button" onClick={() => settleConfirmation(false)}>Cancel</button>
            <button ref={confirmButtonRef} type="button" className="is-primary" onClick={() => settleConfirmation(true)}>Allow once</button>
          </span>
        </div>
      )}
    </section>
  );
}
