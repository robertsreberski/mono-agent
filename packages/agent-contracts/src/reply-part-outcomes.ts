import type {
  AgentReplyPart,
  AgentReplyPartFailure,
} from "./index.js";
import { MAX_AGENT_REPLY_PARTS } from "./stream-wire.js";

export type AgentReplyPartDeliveryType = AgentReplyPart["type"] | "unknown";

/**
 * Sanitized terminal disposition for a rich reply part on a destination that
 * cannot deliver it. Source ids, names, URLs, integrity values, payloads, and
 * producer error text are deliberately not representable in this shape.
 */
export interface AgentReplyPartDeliveryOutcome {
  /** Zero-based position in the responder's ordered rich-part list. */
  readonly partIndex: number;
  readonly partType: AgentReplyPartDeliveryType;
  readonly status: "failed";
  readonly code: AgentReplyPartFailure["code"];
  readonly message: string;
  /** Number of source parts represented by an aggregate overflow outcome. */
  readonly affectedPartCount?: number;
}

const FAILURE_CODES = new Set<AgentReplyPartFailure["code"]>([
  "app_capability_mismatch",
  "app_connection_closed",
  "app_resource_invalid",
  "artifact_expired",
  "artifact_integrity_failed",
  "artifact_missing",
  "artifact_publish_failed",
  "artifact_too_large",
  "reply_part_too_large",
  "unsupported_destination",
]);

/**
 * Convert rich reply parts into bounded, destination-safe terminal failures.
 *
 * The first 19 outcomes remain one-to-one when an off-contract responder
 * exceeds the shared 20-part ceiling; the final outcome accounts for every
 * remaining source part as one explicit aggregate instead of dropping them.
 */
export function unsupportedReplyPartDeliveryOutcomes(
  parts: readonly AgentReplyPart[] | undefined,
): readonly AgentReplyPartDeliveryOutcome[] | undefined {
  const source = arrayValue(parts);
  const sourceLength = source === undefined ? undefined : arrayDataLength(source);
  if (source === undefined || sourceLength === undefined || sourceLength === 0) {
    return undefined;
  }

  if (sourceLength <= MAX_AGENT_REPLY_PARTS) {
    return sanitizeReplyPartDeliveryOutcomes(
      Array.from(
        { length: sourceLength },
        (_, partIndex) => unsupportedOutcome(arrayDataValue(source, partIndex), partIndex),
      ),
    );
  }

  const individualCount = MAX_AGENT_REPLY_PARTS - 1;
  return sanitizeReplyPartDeliveryOutcomes([
      ...Array.from(
        { length: individualCount },
        (_, partIndex) => unsupportedOutcome(arrayDataValue(source, partIndex), partIndex),
      ),
      aggregateOutcome(sourceLength - individualCount),
    ]);
}

/**
 * Revalidate an outcome list at a persistence or adapter boundary without
 * trusting its readonly TypeScript shape. The result is dense, capped at the
 * shared 20-record ceiling, and reconstructed only from fixed enums and fixed
 * messages; supplied messages, indices, and unknown fields are never copied.
 */
export function sanitizeReplyPartDeliveryOutcomes(
  value: unknown,
): readonly AgentReplyPartDeliveryOutcome[] | undefined {
  const source = arrayValue(value);
  const sourceLength = source === undefined ? undefined : arrayDataLength(source);
  if (source === undefined || sourceLength === undefined || sourceLength === 0) {
    return undefined;
  }
  const individualCount = sourceLength <= MAX_AGENT_REPLY_PARTS
    ? sourceLength
    : MAX_AGENT_REPLY_PARTS - 1;
  const outcomes = Array.from(
    { length: individualCount },
    (_, partIndex) => sanitizeOutcome(arrayDataValue(source, partIndex), partIndex),
  );
  if (sourceLength > MAX_AGENT_REPLY_PARTS) {
    outcomes.push(aggregateOutcome(sourceLength - individualCount));
  }
  return outcomes;
}

/** Strict validator for the additive machine wire and versioned durable copy. */
export function isAgentReplyPartDeliveryOutcomes(
  value: unknown,
): value is readonly AgentReplyPartDeliveryOutcome[] {
  try {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_AGENT_REPLY_PARTS) {
      return false;
    }
    return Array.from({ length: value.length }, (_, position) => {
      const outcome = arrayDataValue(value, position);
      if (!isRecord(outcome)
        || objectDataValue(outcome, "partIndex") !== position
        || objectDataValue(outcome, "status") !== "failed") {
        return false;
      }
      const affectedPartCount = objectDataValue(outcome, "affectedPartCount");
      const aggregate = affectedPartCount !== undefined;
      const allowedKeys = aggregate
        ? ["partIndex", "partType", "status", "code", "message", "affectedPartCount"]
        : ["partIndex", "partType", "status", "code", "message"];
      if (!hasOnlyKeys(outcome, allowedKeys)) {
        return false;
      }
      if (aggregate) {
        return position === MAX_AGENT_REPLY_PARTS - 1
          && value.length === MAX_AGENT_REPLY_PARTS
          && objectDataValue(outcome, "partType") === "unknown"
          && objectDataValue(outcome, "code") === "reply_part_too_large"
          && objectDataValue(outcome, "message") === aggregateOutcome(affectedPartCount as number).message
          && Number.isSafeInteger(affectedPartCount)
          && Number(affectedPartCount) >= 2;
      }
      const partType = objectDataValue(outcome, "partType");
      const code = objectDataValue(outcome, "code");
      const message = objectDataValue(outcome, "message");
      if (partType === "attachment") {
        return code === "unsupported_destination"
          && message === attachmentUnsupportedOutcome(position).message;
      }
      if (partType === "mcp_app") {
        return code === "unsupported_destination"
          && message === mcpAppUnsupportedOutcome(position).message;
      }
      if (partType === "failure") {
        return FAILURE_CODES.has(code as AgentReplyPartFailure["code"])
          && message === failedBeforeDeliveryOutcome(position, code as AgentReplyPartFailure["code"]).message;
      }
      return partType === "unknown"
        && code === "unsupported_destination"
        && message === unknownUnsupportedOutcome(position).message;
    }).every(Boolean);
  } catch {
    return false;
  }
}

function unsupportedOutcome(
  part: unknown,
  partIndex: number,
): AgentReplyPartDeliveryOutcome {
  const partType = replyPartType(part);
  if (partType === "failure") {
    return failedBeforeDeliveryOutcome(partIndex, replyPartFailureCode(part));
  }
  if (partType === "attachment") {
    return attachmentUnsupportedOutcome(partIndex);
  }
  if (partType === "mcp_app") {
    return mcpAppUnsupportedOutcome(partIndex);
  }
  return unknownUnsupportedOutcome(partIndex);
}

function sanitizeOutcome(value: unknown, partIndex: number): AgentReplyPartDeliveryOutcome {
  if (!isRecord(value) || objectDataValue(value, "status") !== "failed") {
    return unknownUnsupportedOutcome(partIndex);
  }
  const partType = objectDataValue(value, "partType");
  const code = objectDataValue(value, "code");
  const affectedPartCount = objectDataValue(value, "affectedPartCount");
  if (partIndex === MAX_AGENT_REPLY_PARTS - 1
    && partType === "unknown"
    && code === "reply_part_too_large"
    && Number.isSafeInteger(affectedPartCount)
    && Number(affectedPartCount) >= 2) {
    return aggregateOutcome(Number(affectedPartCount));
  }
  if (partType === "attachment") {
    return attachmentUnsupportedOutcome(partIndex);
  }
  if (partType === "mcp_app") {
    return mcpAppUnsupportedOutcome(partIndex);
  }
  if (partType === "failure" && FAILURE_CODES.has(code as AgentReplyPartFailure["code"])) {
    return failedBeforeDeliveryOutcome(partIndex, code as AgentReplyPartFailure["code"]);
  }
  return unknownUnsupportedOutcome(partIndex);
}

function aggregateOutcome(affectedPartCount: number): AgentReplyPartDeliveryOutcome {
  return {
    partIndex: MAX_AGENT_REPLY_PARTS - 1,
    partType: "unknown",
    status: "failed",
    code: "reply_part_too_large",
    message: "Additional reply parts exceeded the bounded delivery outcome limit.",
    affectedPartCount,
  };
}

function failedBeforeDeliveryOutcome(
  partIndex: number,
  code: AgentReplyPartFailure["code"],
): AgentReplyPartDeliveryOutcome {
  return {
    partIndex,
    partType: "failure",
    status: "failed",
    code,
    message: "Reply part failed before destination delivery.",
  };
}

function attachmentUnsupportedOutcome(partIndex: number): AgentReplyPartDeliveryOutcome {
  return {
    partIndex,
    partType: "attachment",
    status: "failed",
    code: "unsupported_destination",
    message: "Attachment reply parts are unsupported on this destination.",
  };
}

function mcpAppUnsupportedOutcome(partIndex: number): AgentReplyPartDeliveryOutcome {
  return {
    partIndex,
    partType: "mcp_app",
    status: "failed",
    code: "unsupported_destination",
    message: "MCP App reply parts are unsupported on this destination.",
  };
}

function unknownUnsupportedOutcome(partIndex: number): AgentReplyPartDeliveryOutcome {
  return {
    partIndex,
    partType: "unknown",
    status: "failed",
    code: "unsupported_destination",
    message: "Unknown reply parts are unsupported on this destination.",
  };
}

function arrayValue(value: unknown): readonly unknown[] | undefined {
  try {
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function arrayDataLength(value: readonly unknown[]): number | undefined {
  const length = objectDataValue(value, "length");
  return Number.isSafeInteger(length) && Number(length) >= 0 ? Number(length) : undefined;
}

function arrayDataValue(value: readonly unknown[], index: number): unknown {
  return objectDataValue(value, String(index));
}

function objectDataValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function replyPartType(part: unknown): AgentReplyPartDeliveryType {
  if (isRecord(part)) {
    const type = objectDataValue(part, "type");
    if (type === "attachment" || type === "mcp_app" || type === "failure") {
      return type;
    }
  }
  return "unknown";
}

function replyPartFailureCode(part: unknown): AgentReplyPartFailure["code"] {
  if (isRecord(part) && objectDataValue(part, "type") === "failure") {
    const code = objectDataValue(part, "code");
    if (FAILURE_CODES.has(code as AgentReplyPartFailure["code"])) {
      return code as AgentReplyPartFailure["code"];
    }
  }
  return "unsupported_destination";
}
