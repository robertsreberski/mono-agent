import {
  AppBridge,
  PostMessageTransport,
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

import { ApiError, api, isReplyAccessExpired, sameOriginReplyUrl } from "../api";
import { isMcpAppProtocolVersion } from "../mcp-app-protocol";
import type { McpAppPart, McpAppResource, MessagePart } from "../types";
import { Icon } from "./Icon";
import {
  mcpAppContentSecurityPolicy,
  secureMcpAppHtml,
} from "../../../src/mcp-app-document.js";

export { mcpAppContentSecurityPolicy, secureMcpAppHtml };

const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
const APP_MIN_HEIGHT = 160;
const APP_MAX_HEIGHT = 800;
const MCP_APP_PROXY_PATH = "/api/v1/mcp-app-proxy";

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

const createNonce = (): string => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
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

const attachmentIdentity = (part: ReplyAttachmentPart | undefined): string => JSON.stringify(part === undefined
  ? ["invalid"]
  : [
      part.id,
      part.artifactId,
      part.name,
      part.mediaType,
      part.sizeBytes,
      part.integrityId,
      part.expiresAt,
    ]);

const sameAttachmentIdentity = (left: ReplyAttachmentPart, right: ReplyAttachmentPart): boolean =>
  left.id === right.id
  && left.artifactId === right.artifactId
  && left.name === right.name
  && left.mediaType === right.mediaType
  && left.sizeBytes === right.sizeBytes
  && left.integrityId === right.integrityId
  && left.expiresAt === right.expiresAt;

type AttachmentDownloadState = "idle" | "refreshing" | "started" | "expired" | "error" | "unavailable";

interface AttachmentDownloadFeedback {
  readonly identity: string;
  readonly state: AttachmentDownloadState;
  readonly status: string;
}

class AttachmentIntegrityError extends Error {}
class AttachmentIncompleteTransferError extends Error {}

interface AttachmentAccessState {
  readonly identity: string;
  readonly declaredUrl: string | undefined;
  readonly currentUrl: string | undefined;
  readonly generation: number;
}

const TERMINAL_ATTACHMENT_ERROR_MESSAGES = new Map([
  ["reply_attachment_unavailable", "The attachment source is offline or incompatible."],
  ["reply_part_expired", "The reply part has expired."],
  ["reply_part_not_found", "The reply part is unavailable."],
]);
const SAFE_TERMINAL_ATTACHMENT_MESSAGES = new Map<string, ReadonlySet<string>>([
  ["reply_attachment_unavailable", new Set([
    "The attachment source is offline or incompatible.",
    "Attachment stream is unavailable.",
  ])],
  ["reply_part_expired", new Set(["The reply part has expired."])],
  ["reply_part_not_found", new Set(["The reply part is unavailable."])],
]);

const attachmentDownloadFailure = (error: unknown): Pick<AttachmentDownloadFeedback, "state" | "status"> => {
  if (isReplyAccessExpired(error)) {
    return { state: "expired", status: "Download access expired. Refresh and try again." };
  }
  if (error instanceof AttachmentIntegrityError) {
    return { state: "unavailable", status: "The downloaded file failed integrity validation." };
  }
  if (error instanceof AttachmentIncompleteTransferError) {
    return { state: "error", status: "The download was interrupted. Check your connection and try again." };
  }
  if (error instanceof ApiError) {
    const fallback = error.code === undefined ? undefined : TERMINAL_ATTACHMENT_ERROR_MESSAGES.get(error.code);
    if (fallback !== undefined && error.code !== undefined) {
      const message = SAFE_TERMINAL_ATTACHMENT_MESSAGES.get(error.code)?.has(error.message) === true
        ? error.message
        : fallback;
      return { state: "unavailable", status: `${message} (${error.code})` };
    }
  }
  return {
    state: "error",
    status: "The download was interrupted. Check your connection and try again.",
  };
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
  const identity = attachmentIdentity(part);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const mountedRef = useRef(false);
  const activeDownloadRef = useRef<{ readonly identity: string; readonly controller: AbortController } | null>(null);
  const accessRef = useRef<AttachmentAccessState | undefined>(undefined);
  const [downloadFeedback, setDownloadFeedback] = useState<AttachmentDownloadFeedback | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const active = activeDownloadRef.current;
      if (active?.identity === identity) {
        activeDownloadRef.current = null;
        active.controller.abort();
      }
    };
  }, [identity]);

  let declaredContentUrl: string | undefined;
  try {
    declaredContentUrl = part?.contentUrl === undefined ? undefined : sameOriginReplyUrl(part.contentUrl);
  } catch {
    declaredContentUrl = undefined;
  }
  const previousAccess = accessRef.current;
  if (previousAccess === undefined || previousAccess.identity !== identity) {
    accessRef.current = {
      identity,
      declaredUrl: declaredContentUrl,
      currentUrl: declaredContentUrl,
      generation: (previousAccess?.generation ?? 0) + 1,
    };
  } else if (previousAccess.declaredUrl !== declaredContentUrl) {
    // A freshly projected capability supersedes any URL adopted by an older
    // request, but it does not change the durable attachment generation.
    accessRef.current = {
      identity,
      declaredUrl: declaredContentUrl,
      currentUrl: declaredContentUrl,
      generation: previousAccess.generation + 1,
    };
  }

  if (part === undefined) {
    return <div className="reply-part-error" role="alert">An attachment reference was invalid.</div>;
  }

  const contentUrl = accessRef.current?.identity === identity ? accessRef.current.currentUrl : undefined;
  const downloadState = downloadFeedback?.identity === identity ? downloadFeedback.state : "idle";
  const unavailable = contentUrl === undefined || downloadState === "unavailable";
  const downloadStatus = unavailable
    ? (downloadFeedback?.identity === identity && downloadFeedback.state === "unavailable"
        ? downloadFeedback.status
        : "This file is no longer available.")
    : downloadFeedback?.identity === identity ? downloadFeedback.status : "";

  return (
    <section className="reply-attachment" aria-label={`File attachment: ${part.name}`}>
      <span className="reply-part-icon"><Icon name="file" size={16} /></span>
      <span className="reply-part-copy">
        <strong>{part.name}</strong>
        <span>{part.mediaType} · {formatBytes(part.sizeBytes)}</span>
      </span>
      {!unavailable && (
          <button
            type="button"
            className="reply-part-action"
            disabled={downloadState === "refreshing"}
            onClick={() => {
              if (activeDownloadRef.current?.identity === identity) return;
              const access = accessRef.current;
              if (access?.identity !== identity || access.currentUrl === undefined) return;
              const requestUrl = access.currentUrl;
              const accessGeneration = access.generation;
              const controller = new AbortController();
              activeDownloadRef.current = { identity, controller };
              setDownloadFeedback({ identity, state: "refreshing", status: "Refreshing download access…" });
              const isActive = (): boolean => mountedRef.current
                && !controller.signal.aborted
                && identityRef.current === identity
                && activeDownloadRef.current?.controller === controller;
              void (async () => {
                try {
                  const response = await api.replyAttachmentContent(
                    requestUrl,
                    controller.signal,
                    (refreshed) => {
                      if (!isActive() || !sameAttachmentIdentity(part, refreshed) || refreshed.contentUrl === undefined) {
                        return;
                      }
                      try {
                        const nextContentUrl = sameOriginReplyUrl(refreshed.contentUrl);
                        const currentAccess = accessRef.current;
                        if (currentAccess?.identity === identity && currentAccess.generation === accessGeneration) {
                          accessRef.current = { ...currentAccess, currentUrl: nextContentUrl };
                        }
                      } catch {
                        // The current retry still fails closed inside the API;
                        // never retain an off-origin companion capability.
                      }
                    },
                  );
                  if (!isActive()) return;
                  const declaredLength = response.headers.get("content-length");
                  if (
                    (declaredLength !== null && Number(declaredLength) !== part.sizeBytes)
                    || response.headers.get("x-mono-agent-integrity-id") !== part.integrityId
                  ) {
                    throw new AttachmentIntegrityError();
                  }
                  const blob = await response.blob();
                  if (!isActive()) return;
                  if (blob.size !== part.sizeBytes) {
                    if (declaredLength === null && blob.size < part.sizeBytes) {
                      throw new AttachmentIncompleteTransferError();
                    }
                    throw new AttachmentIntegrityError();
                  }
                  startReplyAttachmentDownload(blob, part.name);
                  if (!isActive()) return;
                  setDownloadFeedback({
                    identity,
                    state: "started",
                    status: "Download started with refreshed access.",
                  });
                } catch (error: unknown) {
                  if (!isActive()) return;
                  const failure = attachmentDownloadFailure(error);
                  setDownloadFeedback({ identity, ...failure });
                } finally {
                  if (activeDownloadRef.current?.controller === controller) {
                    activeDownloadRef.current = null;
                  }
                }
              })();
            }}
          >
            {downloadState === "expired" ? "Refresh access" : downloadState === "error" ? "Try again" : "Download"}
            <span className="sr-only"> {part.name}</span>
          </button>
        )}
      <span
        className={`reply-part-status${unavailable ? " is-unavailable" : ""}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >{downloadStatus}</span>
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

interface McpAppAccess {
  readonly resourceUrl: string;
  readonly bridgeUrl: string;
}

interface McpAppAccessState {
  readonly identity: string;
  readonly declaredKey: string;
  readonly current: McpAppAccess | undefined;
  readonly generation: number;
}

const mcpAppIdentity = (part: McpAppPart | undefined): string => JSON.stringify(part === undefined
  ? ["invalid"]
  : [
      part.id,
      part.invocationId,
      part.connectionId,
      part.serverName,
      part.toolName,
      part.resourceUri,
      part.mediaType,
      part.protocolVersion,
      part.title,
      part.description,
      part.expiresAt,
    ]);

const sameMcpAppIdentity = (left: McpAppPart, right: McpAppPart): boolean =>
  left.id === right.id
  && left.invocationId === right.invocationId
  && left.connectionId === right.connectionId
  && left.serverName === right.serverName
  && left.toolName === right.toolName
  && left.resourceUri === right.resourceUri
  && left.mediaType === right.mediaType
  && left.protocolVersion === right.protocolVersion
  && left.title === right.title
  && left.description === right.description
  && left.expiresAt === right.expiresAt;

const mcpAppAccess = (part: McpAppPart | undefined): McpAppAccess | undefined => {
  if (part?.resourceUrl === undefined || part.bridgeUrl === undefined) return undefined;
  try {
    return {
      resourceUrl: sameOriginReplyUrl(part.resourceUrl),
      bridgeUrl: sameOriginReplyUrl(part.bridgeUrl),
    };
  } catch {
    return undefined;
  }
};

const mcpAppAccessKey = (access: McpAppAccess | undefined): string => access === undefined
  ? "invalid"
  : JSON.stringify([access.resourceUrl, access.bridgeUrl]);

const MCP_APP_LOAD_ERROR_MESSAGES = new Map([
  ["mcp_app_unavailable", "The MCP App source is offline or incompatible."],
  ["mcp_app_identity_mismatch", "The MCP App identity changed after publication."],
]);

const mcpAppLoadErrorMessage = (error: unknown): string => {
  if (isReplyAccessExpired(error)) return "Interactive app access expired. Refresh access to reconnect.";
  if (error instanceof ApiError && error.code !== undefined) {
    return MCP_APP_LOAD_ERROR_MESSAGES.get(error.code) ?? "The MCP App could not be loaded.";
  }
  return "The MCP App could not be loaded.";
};

export function McpAppPart({ data }: DataMessagePartProps) {
  const part = parseMcpApp(data);
  const identity = mcpAppIdentity(part);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const mountedRef = useRef(false);
  const declaredAccess = mcpAppAccess(part);
  const declaredAccessKey = mcpAppAccessKey(declaredAccess);
  const accessRef = useRef<McpAppAccessState | undefined>(undefined);
  const previousAccess = accessRef.current;
  if (
    previousAccess === undefined
    || previousAccess.identity !== identity
    || previousAccess.declaredKey !== declaredAccessKey
  ) {
    // Declared access is authoritative for future operations. In particular,
    // a later SSE projection must not be replaced by a late refresh callback
    // that started with an older capability.
    accessRef.current = {
      identity,
      declaredKey: declaredAccessKey,
      current: declaredAccess,
      generation: (previousAccess?.generation ?? 0) + 1,
    };
  }
  const accessAvailable = accessRef.current?.current !== undefined;
  const [resource, setResource] = useState<McpAppResource | null>(null);
  const [status, setStatus] = useState<"loading" | "connecting" | "ready" | "closed" | "error">("loading");
  const [statusText, setStatusText] = useState("Loading interactive app…");
  const [height, setHeight] = useState(320);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const [accessExpired, setAccessExpired] = useState(false);
  const [reloadRevision, setReloadRevision] = useState(0);
  const confirmationRef = useRef<ConfirmationRequest | null>(null);
  const confirmationId = useRef(0);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const containerRef = useRef<HTMLElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const nonce = useMemo(createNonce, [part?.connectionId, part?.invocationId]);

  const adoptMcpAppAccess = useCallback((
    expectedIdentity: string,
    expectedPart: McpAppPart,
    expectedAccessGeneration: number,
    refreshed: McpAppPart,
  ) => {
    if (
      !mountedRef.current
      || identityRef.current !== expectedIdentity
      || !sameMcpAppIdentity(expectedPart, refreshed)
    ) return;
    const nextAccess = mcpAppAccess(refreshed);
    if (nextAccess === undefined) return;
    const currentAccess = accessRef.current;
    if (
      currentAccess?.identity !== expectedIdentity
      || currentAccess.generation !== expectedAccessGeneration
    ) return;
    accessRef.current = { ...currentAccess, current: nextAccess };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const settleConfirmation = useCallback((confirmed: boolean) => {
    const pending = confirmationRef.current;
    if (pending === null) return;
    const returnFocus = returnFocusRef.current;
    confirmationRef.current = null;
    returnFocusRef.current = null;
    setConfirmation(null);
    pending.resolve(confirmed);
    window.setTimeout(() => {
      if (mountedRef.current && returnFocus?.isConnected === true) returnFocus.focus();
    }, 0);
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

  const cancelConfirmation = useCallback(() => {
    const pending = confirmationRef.current;
    if (pending === null) return;
    const fallbackFocus = containerRef.current;
    confirmationRef.current = null;
    returnFocusRef.current = null;
    setConfirmation(null);
    pending.resolve(false);
    window.setTimeout(() => {
      if (mountedRef.current && fallbackFocus?.isConnected === true) fallbackFocus.focus();
    }, 0);
  }, []);

  useEffect(() => {
    if (confirmation !== null) confirmButtonRef.current?.focus();
  }, [confirmation]);

  useEffect(() => {
    cancelConfirmation();
    return cancelConfirmation;
  }, [cancelConfirmation, identity]);

  useEffect(() => {
    const accessState = accessRef.current;
    const access = accessState?.current;
    setResource(null);
    setAccessExpired(false);
    if (part === undefined || accessState?.identity !== identity || access === undefined) {
      setStatus("error");
      setStatusText("This MCP App does not have a valid private host endpoint.");
      return;
    }
    const expectedPart = part;
    const expectedIdentity = identity;
    const expectedAccessGeneration = accessState.generation;
    const controller = new AbortController();
    setStatus("loading");
    setStatusText("Loading interactive app…");
    const isActive = (): boolean => mountedRef.current
      && !controller.signal.aborted
      && identityRef.current === expectedIdentity;
    // React StrictMode tears down the first effect before this microtask. That
    // discarded generation therefore never starts a duplicate network fetch.
    void Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      return await api.mcpAppResource(
        access.resourceUrl,
        controller.signal,
        (refreshed) => {
          if (isActive()) {
            adoptMcpAppAccess(expectedIdentity, expectedPart, expectedAccessGeneration, refreshed);
          }
        },
      );
    }).then((loaded) => {
      if (!isActive()) return;
      if (!resourceIdentityMatches(expectedPart, loaded)) throw new Error("The MCP App identity changed during loading.");
      if (!loaded.connected) throw new Error("The originating MCP connection is no longer available.");
      setResource(loaded);
      setStatus("connecting");
      setStatusText("Starting the isolated app…");
    }).catch((error: unknown) => {
      if (!isActive()) return;
      const expired = isReplyAccessExpired(error);
      setAccessExpired(expired);
      setStatus("error");
      setStatusText(mcpAppLoadErrorMessage(error));
    });
    return () => controller.abort();
  }, [accessAvailable, adoptMcpAppAccess, identity, reloadRevision]);

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
  const clipboardWrite = metadata.permissions?.clipboardWrite !== undefined;
  const proxyInstanceKey = `${identity}:${clipboardWrite ? "clipboard" : "none"}`;
  const invocationId = part?.invocationId;
  const connectionId = part?.connectionId;
  const configureProxy = useCallback(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (frameWindow === undefined || frameWindow === null
      || invocationId === undefined || connectionId === undefined) return;
    // The proxy has an opaque origin, so it derives and locks the host origin
    // from this browser-authenticated parent MessageEvent instead of trusting a
    // value in the payload.
    frameWindow.postMessage({
      type: "mono-agent:mcp-app-proxy-config",
      nonce,
      invocationId,
      connectionId,
      clipboardWrite,
    }, "*");
  }, [clipboardWrite, connectionId, invocationId, nonce]);

  useEffect(() => {
    if (
      part === undefined
      || accessRef.current?.current === undefined
      || resource === null
      || securedHtml === undefined
      || accessExpired
      || status === "closed"
    ) return;
    const frameWindow = iframeRef.current?.contentWindow;
    if (frameWindow === undefined || frameWindow === null) return;
    let disposed = false;
    let bridge: AppBridge | undefined;
    let transport: PostMessageTransport | undefined;
    const controller = new AbortController();
    const expectedPart = part;
    const expectedIdentity = identity;
    const isActive = (): boolean => !disposed
      && mountedRef.current
      && !controller.signal.aborted
      && identityRef.current === expectedIdentity;
    const assertActive = (): void => {
      if (!isActive()) throw new DOMException("The MCP App instance is no longer active.", "AbortError");
    };

    const forward = async (
      method: "resources/read" | "tools/call" | "ui/open-link" | "ui/update-model-context",
      params: unknown,
      confirmed: boolean,
    ): Promise<unknown> => {
      try {
        assertActive();
        const accessState = accessRef.current;
        const bridgeUrl = accessState?.identity === expectedIdentity
          ? accessState.current?.bridgeUrl
          : undefined;
        if (bridgeUrl === undefined || accessState === undefined) {
          throw new Error("The MCP App host endpoint is unavailable.");
        }
        const result = await api.mcpAppRequest(
          bridgeUrl,
          method,
          params,
          confirmed,
          controller.signal,
          (refreshed) => {
            if (isActive()) {
              adoptMcpAppAccess(expectedIdentity, expectedPart, accessState.generation, refreshed);
            }
          },
        );
        assertActive();
        return result;
      } catch (error) {
        if (isActive() && isReplyAccessExpired(error)) {
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
        assertActive();
        bridge = new AppBridge(
          null,
          { name: "mono-agent web console", version: "0.4.0" },
          {
            openLinks: {},
            serverTools: {},
            serverResources: {},
            sandbox: {
              ...(clipboardWrite ? { permissions: { clipboardWrite: {} } } : {}),
              csp: {},
            },
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
          if (!isActive()) return;
          void bridge?.sendSandboxResourceReady({
            html: securedHtml,
            sandbox: "allow-scripts",
            ...(metadata.csp === undefined ? {} : { csp: metadata.csp }),
            ...(metadata.permissions === undefined ? {} : { permissions: metadata.permissions }),
          }).catch(() => {
            if (!isActive()) return;
            setStatus("error");
            setStatusText("The app sandbox rejected its resource.");
          });
        };
        bridge.oninitialized = () => {
          void (async () => {
            assertActive();
            await bridge?.sendToolInput({ arguments: toolArguments(resource.toolInput) });
            assertActive();
            await bridge?.sendToolResult(toolResult(resource.toolResult));
            if (isActive()) {
              setStatus("ready");
              setStatusText("Interactive app ready.");
            }
          })().catch(() => {
            if (!isActive()) return;
            setStatus("error");
            setStatusText("The app could not be initialized.");
          });
        };
        bridge.onsizechange = ({ height: requestedHeight }) => {
          if (isActive() && typeof requestedHeight === "number" && Number.isFinite(requestedHeight)) {
            setHeight(Math.round(Math.min(APP_MAX_HEIGHT, Math.max(APP_MIN_HEIGHT, requestedHeight))));
          }
        };
        bridge.oncalltool = async (params) => {
          assertActive();
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
          assertActive();
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
          assertActive();
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
          if (!isActive()) return;
          setStatus("closed");
          setStatusText("The interactive app closed.");
        };
        bridge.onerror = () => {
          if (!isActive()) return;
          setStatus("error");
          setStatusText("The app bridge reported an error.");
        };
        await bridge.connect(transport);
        if (!isActive()) return;
        bridgeRef.current = bridge;
        frameWindow.postMessage({
          type: "mono-agent:mcp-app-host-ready",
          nonce,
          invocationId: part.invocationId,
          connectionId: part.connectionId,
        }, "*");
      } catch {
        if (!isActive()) return;
        setStatus("error");
        setStatusText("The app bridge could not start.");
      }
    };
    const onReady = (event: MessageEvent) => { void ready(event); };
    window.addEventListener("message", onReady);
    // A matching configuration is the re-arm request. Install onReady before
    // sending it; onLoad remains the first-load fallback for a fresh document.
    configureProxy();
    return () => {
      disposed = true;
      controller.abort();
      cancelConfirmation();
      if (bridgeRef.current === bridge) bridgeRef.current = null;
      window.removeEventListener("message", onReady);
      void bridge?.teardownResource({}, { timeout: 500 }).catch(() => undefined).finally(() => {
        void transport?.close().catch(() => undefined);
      });
    };
  // The bridge lifecycle is one exact published app instance. Height updates
  // are sent through size notifications and must not recreate the transport.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessAvailable, accessExpired, adoptMcpAppAccess, cancelConfirmation, configureProxy, identity, metadata, nonce, part?.connectionId, part?.invocationId, reloadRevision, requestConfirmation, resource, securedHtml, status === "closed"]);

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
    <section
      ref={containerRef}
      className="mcp-app"
      aria-label={`Interactive app: ${part.title ?? part.toolName}`}
      tabIndex={-1}
    >
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
            onClick={() => setReloadRevision((revision) => revision + 1)}
          >Refresh app access<span className="sr-only"> for {part.title ?? part.toolName}</span></button>
        )}
      </header>
      <p className={`mcp-app-status is-${status}`} role="status">{statusText}</p>
      {resource !== null && securedHtml !== undefined && !accessExpired && status !== "closed" && (
        <iframe
          key={proxyInstanceKey}
          ref={iframeRef}
          className="mcp-app-frame"
          title={`${part.title ?? part.toolName} interactive app`}
          sandbox="allow-scripts"
          allow={clipboardWrite ? "clipboard-write" : undefined}
          referrerPolicy="no-referrer"
          inert={confirmation !== null}
          aria-hidden={confirmation !== null}
          tabIndex={confirmation === null ? 0 : -1}
          src={MCP_APP_PROXY_PATH}
          onLoad={configureProxy}
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
