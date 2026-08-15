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
  if (!Array.isArray(parts) || parts.length === 0) {
    return undefined;
  }

  if (parts.length <= MAX_AGENT_REPLY_PARTS) {
    return parts.map((part, partIndex) => unsupportedOutcome(part, partIndex));
  }

  const individualCount = MAX_AGENT_REPLY_PARTS - 1;
  return [
    ...parts.slice(0, individualCount)
      .map((part, partIndex) => unsupportedOutcome(part, partIndex)),
    {
      partIndex: individualCount,
      partType: "unknown",
      status: "failed",
      code: "reply_part_too_large",
      message: "Additional reply parts exceeded the bounded delivery outcome limit.",
      affectedPartCount: parts.length - individualCount,
    },
  ];
}

function unsupportedOutcome(
  part: AgentReplyPart | undefined,
  partIndex: number,
): AgentReplyPartDeliveryOutcome {
  const partType = replyPartType(part);
  if (partType === "failure") {
    return {
      partIndex,
      partType,
      status: "failed",
      code: replyPartFailureCode(part),
      message: "Reply part failed before destination delivery.",
    };
  }
  if (partType === "attachment") {
    return {
      partIndex,
      partType,
      status: "failed",
      code: "unsupported_destination",
      message: "Attachment reply parts are unsupported on this destination.",
    };
  }
  if (partType === "mcp_app") {
    return {
      partIndex,
      partType,
      status: "failed",
      code: "unsupported_destination",
      message: "MCP App reply parts are unsupported on this destination.",
    };
  }
  return {
    partIndex,
    partType: "unknown",
    status: "failed",
    code: "unsupported_destination",
    message: "Unknown reply parts are unsupported on this destination.",
  };
}

function replyPartType(part: AgentReplyPart | undefined): AgentReplyPartDeliveryType {
  try {
    if (part?.type === "attachment" || part?.type === "mcp_app" || part?.type === "failure") {
      return part.type;
    }
  } catch {
    // A structurally supplied responder is not a runtime trust boundary.
  }
  return "unknown";
}

function replyPartFailureCode(part: AgentReplyPart | undefined): AgentReplyPartFailure["code"] {
  try {
    if (part?.type === "failure" && FAILURE_CODES.has(part.code)) {
      return part.code;
    }
  } catch {
    // Do not let an accessor-backed record suppress the ordinary answer text.
  }
  return "unsupported_destination";
}
