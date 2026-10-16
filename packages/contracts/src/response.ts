

import { MCP_APP_RESOURCE_MIME_TYPE, MCP_APP_SUPPORTED_VERSIONS } from "./mcp-apps.js";

export type AgentResponseMetadata = Record<string, unknown> & {
  /** Host-certified terminal delivery intent; absence preserves legacy text classification. */
  readonly turnDisposition?: "silent" | "visible";
};

/**
 * Opaque durable reference to an app-owned artifact. The identifier is safe to
 * carry over ordinary transports; bytes and local paths are deliberately not
 * representable here.
 */
export interface AgentReplyArtifactReference {
  readonly scheme: "mono-agent-artifact";
  readonly id: string;
}

/** A generated file published alongside an assistant reply. */
export interface AgentReplyAttachmentPart {
  readonly type: "attachment";
  /** Stable part id within the reply. */
  readonly id: string;
  readonly reference: AgentReplyArtifactReference;
  /** Sanitized display-only filename; never a filesystem path. */
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  /** Content-addressed integrity id, currently `sha256:<lowercase hex>`. */
  readonly integrityId: string;
  /** ISO-8601 retention deadline, when the publisher assigned one. */
  readonly expiresAt?: string;
}

/** A spec-negotiated MCP App invocation available to a capable host. */
export interface AgentReplyMcpAppPart {
  readonly type: "mcp_app";
  /** Durable app invocation id, also used to isolate bridge instances. */
  readonly id: string;
  readonly invocationId: string;
  readonly connectionId: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly resourceUri: string;
  readonly mediaType: typeof MCP_APP_RESOURCE_MIME_TYPE;
  readonly protocolVersion: (typeof MCP_APP_SUPPORTED_VERSIONS)[number];
  readonly title?: string;
  readonly description?: string;
  /** ISO-8601 retention deadline for the persisted private host state. */
  readonly expiresAt?: string;
}

/** Non-blocking choices delivered with an assistant reply in the web console. */
export interface AgentReplyOptionsPart {
  readonly type: "reply_options";
  readonly id: string;
  readonly options: readonly string[];
}

/** Validate canonical labels at delivery/persistence boundaries without coercion. */
export function isAgentReplyOptions(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length >= 2 && value.length <= 8
    && Array.from(value).every((label) => typeof label === "string"
      && label === label.trim() && label.length >= 1 && label.length <= 75
      && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(label))
    && new Set(value).size === value.length;
}

/** A display-only restart suggestion. Target and authority are NEVER model-supplied. */
export interface AgentReplyRestartProposalPart {
  readonly type: "restart_proposal";
  /** Stable identifier within the assistant reply; not a restart operation id. */
  readonly id: string;
  readonly reason?: string;
}

/** Keep proposed reasons display-only, short, single-line and free of control characters. */
export function sanitizeRestartProposalReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 280);
  return normalized.length === 0 ? undefined : normalized;
}

/** One rich reply part failed while other text/parts remained deliverable. */
export interface AgentReplyPartFailure {
  readonly type: "failure";
  readonly id: string;
  readonly code:
    | "app_capability_mismatch"
    | "app_connection_closed"
    | "app_resource_invalid"
    | "artifact_expired"
    | "artifact_integrity_failed"
    | "artifact_missing"
    | "artifact_publish_failed"
    | "artifact_too_large"
    | "reply_part_too_large"
    | "unsupported_destination";
  readonly message: string;
  readonly relatedPartId?: string;
}

/**
 * Additive rich reply surface. Unknown future part records remain wire-tolerant
 * but are ignored by consumers until they understand their `type`.
 */
export type AgentReplyPart =
  | AgentReplyAttachmentPart
  | AgentReplyMcpAppPart
  | AgentReplyRestartProposalPart
  | AgentReplyOptionsPart
  | AgentReplyPartFailure;

export interface AgentMessageFinishOptions {
  readonly parts?: readonly AgentReplyPart[];
  /**
   * Human destinations render concise diagnostics for unsupported parts.
   * Machine/verbatim transports explicitly select `none` so model output stays
   * byte-for-byte suitable for downstream parsing or notification delivery.
   */
  readonly unsupportedPartFallback?: "human" | "none";
}

/** Authorized, integrity-checked artifact stream returned by a responder. */
export interface AgentReplyArtifactStream {
  readonly attachment: AgentReplyAttachmentPart;
  readonly body: AsyncIterable<Uint8Array>;
}

export interface AgentReplyArtifactOpenRequest {
  readonly conversationId: string;
  readonly reference: AgentReplyArtifactReference;
  /** Reject a durable record that no longer matches the message metadata. */
  readonly expectedIntegrityId?: string;
}

/** Private host payload used to initialize one sandboxed MCP App instance. */
export interface AgentMcpAppResource {
  readonly app: AgentReplyMcpAppPart;
  readonly html: string;
  readonly toolInput?: unknown;
  readonly toolResult?: unknown;
  readonly resourceMetadata?: Readonly<Record<string, unknown>>;
  /** False after restart, expiry, or an originating MCP disconnect. */
  readonly connected: boolean;
}

export interface AgentMcpAppLoadRequest {
  readonly conversationId: string;
  readonly invocationId: string;
  readonly connectionId: string;
}

export interface AgentMcpAppHostRequest extends AgentMcpAppLoadRequest {
  readonly method: "resources/read" | "tools/call" | "ui/open-link" | "ui/update-model-context";
  readonly params?: unknown;
  /** Host UI confirmation bound to this exact request. */
  readonly confirmed?: boolean;
}

export interface AgentResponse {
  readonly text?: string;
  readonly metadata?: AgentResponseMetadata;
  readonly parts?: readonly AgentReplyPart[];
}
