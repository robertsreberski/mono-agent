import { AGENT_ATTACHMENT_MIME_ALIASES } from "./attachment-mime-aliases.js";

/**
 * A multimodal attachment that accompanies a request — an image to be fed to a
 * vision model, or a document whose bytes (and/or extracted text) can be inlined
 * into the prompt. Transport-agnostic: channels populate it; runtimes consume it.
 */
export interface AgentAttachment {
  readonly kind: "image" | "document";
  /** MIME type, e.g. "image/png" or "application/pdf". */
  readonly mimeType: string;
  /** Raw attachment bytes, base64-encoded. */
  readonly data: string;
  /** Original file name, when known. */
  readonly name?: string;
  /** Size of the decoded bytes, when known. */
  readonly sizeBytes?: number;
  /** Extracted text for documents, when available. */
  readonly text?: string;
  /** Media duration in seconds (audio/video), when the transport reports it. */
  readonly durationSeconds?: number;
}

/** Default decoded-byte ceiling shared by transports that ingest attachments. */
export const DEFAULT_AGENT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Transport-neutral MIME types accepted by the built-in attachment flows.
 * Keeping this list beside {@link AgentAttachment} prevents browser and chat
 * adapters from drifting into subtly different upload behavior.
 */
export const DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/json",
  "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/webm",
  "audio/flac",
  "video/mp4",
  "video/mpeg",
  "video/quicktime",
  "video/webm",
];

/** Classify an allowed MIME type into the runtime's two attachment kinds. */
export function agentAttachmentKindFromMimeType(mimeType: string): AgentAttachment["kind"] {
  return mimeType.trim().toLowerCase().startsWith("image/") ? "image" : "document";
}

/**
 * Canonicalize a caller-reported attachment MIME type to the allowlisted form.
 * Browsers and OS pickers report non-canonical types for the same container,
 * so a known vendor or legacy alias maps to its canonical allowlisted type.
 * Unknown types return unchanged (trimmed and lowercased), leaving admission
 * to {@link DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST}.
 */
export function canonicalizeAgentAttachmentMimeType(value: string): string {
  const normalized = value.trim().toLowerCase();
  // Own-property check only: a caller-reported type such as `constructor`
  // would otherwise resolve against Object.prototype and return a function.
  return Object.hasOwn(AGENT_ATTACHMENT_MIME_ALIASES, normalized)
    ? AGENT_ATTACHMENT_MIME_ALIASES[normalized] ?? normalized
    : normalized;
}

/**
 * Decode the text payloads transports inline for the model. Binary and
 * application/* documents deliberately return undefined, matching the
 * established Telegram behavior.
 */
export function decodeAgentAttachmentText(
  mimeType: string,
  bytes: Uint8Array,
): string | undefined {
  if (!mimeType.trim().toLowerCase().startsWith("text/")) {
    return undefined;
  }
  // `ignoreBOM: true` means treat a leading BOM as ordinary decoded text,
  // matching Node Buffer's established Telegram UTF-8 behavior exactly.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}
