import { createHash } from "node:crypto";
/** Exact native JSON commitment; key/order semantics are part of the wire. */
export const evidenceDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
