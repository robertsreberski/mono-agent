import type { WebExternalConversationChannel } from "./contracts.js";
import { WebConsoleError } from "./errors.js";

/**
 * Channel conversations mirrored one way into projects (Telegram forum topics).
 *
 * The owning agent process observes a conversation and reports it here over
 * the owner-private ingress; this store keeps the only project binding. The
 * `key` is the host-owned routing identity (`telegram:<bot>:<chat>:<topic|main>`):
 * it is stored and returned to the owning process for delivery, and never
 * appears in a console tool result, an event, or the browser payload.
 */

export const EXTERNAL_CONVERSATION_CHANNELS: readonly WebExternalConversationChannel[] = ["telegram"];
/** Per agent; new conversations beyond this are refused and reported as truncated. */
export const MAX_EXTERNAL_CONVERSATIONS_PER_SOURCE = 1_024;
export const MAX_EXTERNAL_OBSERVATIONS_PER_BATCH = 100;
const KEY_PATTERN = /^telegram:\d{1,20}:-?\d{1,20}:(?:main|[1-9]\d{0,15})$/u;
const CHAT_LABEL_MAX = 56;
const TOPIC_LABEL_MAX = 60;

export type ExternalConversationKind = "topic" | "main";

/** What the owning process last knew about one conversation. */
export interface ExternalConversationObservation {
  readonly key: string;
  readonly kind: ExternalConversationKind;
  readonly chatLabel?: string;
  readonly topicLabel?: string;
  /** Lifecycle state revealed by the channel's own service messages. */
  readonly state?: "open" | "closed";
  /** When `state` was observed; defaults to `seenAt`. */
  readonly stateAt?: string;
  readonly seenAt: string;
}

const invalid = (message: string): never => {
  throw new WebConsoleError("invalid_external_conversation", message, 400);
};

export function parseExternalChannel(value: unknown): WebExternalConversationChannel {
  if (!EXTERNAL_CONVERSATION_CHANNELS.includes(value as WebExternalConversationChannel)) return invalid("Unsupported channel.");
  return value as WebExternalConversationChannel;
}

export function parseExternalKey(value: unknown): string {
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) return invalid("Invalid conversation key.");
  return value;
}

/** `main` keys are a forum's General conversation; every other key is a topic. */
export function externalKeyKind(key: string): ExternalConversationKind {
  return key.endsWith(":main") ? "main" : "topic";
}

const timestamp = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) return invalid(`Invalid ${name}.`);
  return new Date(value).toISOString();
};

const optionalLabel = (value: unknown, max: number): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 1_024) return invalid("Invalid label.");
  const label = sanitizeExternalLabel(value, max);
  return label.length === 0 ? undefined : label;
};

/** Strict parse of one observation; unknown fields and inconsistent kinds are refused. */
export function parseExternalObservation(value: unknown): ExternalConversationObservation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid("Invalid observation.");
  const record = value as Record<string, unknown>;
  const allowed = ["key", "kind", "chatLabel", "topicLabel", "state", "stateAt", "seenAt"];
  if (Object.keys(record).some((key) => !allowed.includes(key))) return invalid("Observation contains unsupported fields.");
  const key = parseExternalKey(record.key);
  if (record.kind !== externalKeyKind(key)) return invalid("Observation kind does not match its key.");
  if (record.state !== undefined && record.state !== "open" && record.state !== "closed") return invalid("Invalid state.");
  const chatLabel = optionalLabel(record.chatLabel, CHAT_LABEL_MAX);
  const topicLabel = optionalLabel(record.topicLabel, TOPIC_LABEL_MAX);
  return {
    key,
    kind: record.kind as ExternalConversationKind,
    ...(chatLabel === undefined ? {} : { chatLabel }),
    ...(topicLabel === undefined ? {} : { topicLabel }),
    ...(record.state === undefined ? {} : { state: record.state }),
    ...(record.stateAt === undefined ? {} : { stateAt: timestamp(record.stateAt, "stateAt") }),
    seenAt: timestamp(record.seenAt, "seenAt"),
  };
}

export function parseExternalObservations(value: unknown): ExternalConversationObservation[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EXTERNAL_OBSERVATIONS_PER_BATCH) {
    return invalid(`observations must hold 1-${String(MAX_EXTERNAL_OBSERVATIONS_PER_BATCH)} entries.`);
  }
  return value.map(parseExternalObservation);
}

/**
 * Make a user-chosen channel label safe to show a model or a project name:
 * NFC, control/format/line-separator characters removed, whitespace collapsed,
 * bounded in code points.
 */
export function sanitizeExternalLabel(label: string, max = TOPIC_LABEL_MAX): string {
  const cleaned = label
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(cleaned).slice(0, max).join("").trim();
}

/** `Chat › Topic`, the project name an observed conversation starts with. */
export function externalConversationLabel(kind: ExternalConversationKind, chatLabel: string | null, topicLabel: string | null): string {
  const chat = chatLabel ?? "Telegram chat";
  const topic = kind === "main" ? "General" : topicLabel ?? "unnamed topic";
  return `${chat} › ${topic}`;
}
