import { createHash } from "node:crypto";
import { redactJsonValue } from "@mono-agent/observability";
import { CONTINUITY_RECORD_MAX_BYTES } from "./continuity-contracts.js";
import { utf8Prefix } from "./payload.js";

export interface RetainedContinuityText {
  readonly text: string;
  readonly sha256: string;
  readonly originalBytes: number;
  readonly retainedBytes: number;
  readonly redacted: boolean;
  readonly truncated: boolean;
}

/** Independent of the lifecycle JSON projection's much smaller string budget. */
export function retainContinuityText(value: string): RetainedContinuityText {
  if (typeof value !== "string") throw new TypeError("Continuity text must be a string.");
  const originalBytes = Buffer.byteLength(value, "utf8");
  // Do not inspect a clipped credential/path and accidentally retain its prefix.
  // Oversized input is explicitly omitted before security inspection.
  const oversized = originalBytes > CONTINUITY_RECORD_MAX_BYTES;
  const inspected = oversized ? "[continuity text omitted because it exceeded the record bound]" : value;
  const sanitized = redactJsonValue(inspected, CONTINUITY_RECORD_MAX_BYTES, {
    contentPatternRedaction: true,
    visibleTextSanitization: {
      omitFilesystemPaths: true,
      omission: "[continuity text omitted because it contained private host data]",
    },
  });
  if (typeof sanitized !== "string") throw new TypeError("Continuity text sanitization failed.");
  const text = utf8Prefix(sanitized, CONTINUITY_RECORD_MAX_BYTES);
  return {
    text,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    originalBytes,
    retainedBytes: Buffer.byteLength(text, "utf8"),
    redacted: sanitized !== inspected,
    truncated: oversized || text !== sanitized,
  };
}
