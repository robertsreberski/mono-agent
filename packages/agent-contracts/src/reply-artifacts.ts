import type { AgentReplyAttachmentPart } from "./index.js";

/** Verify the authorized artifact against the part selected for delivery. */
export function assertMatchingReplyAttachment(
  expected: AgentReplyAttachmentPart,
  actual: AgentReplyAttachmentPart,
): void {
  if (
    actual.reference.id !== expected.reference.id
    || actual.integrityId !== expected.integrityId
    || actual.sizeBytes !== expected.sizeBytes
    || actual.name !== expected.name
    || actual.mediaType !== expected.mediaType
  ) {
    throw new Error("Authorized reply artifact metadata did not match the reply part.");
  }
}

/** Read exactly the declared byte count before any native upload. */
export async function collectExactReplyArtifactBytes(
  body: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    if (signal?.aborted === true) throw signal.reason ?? new Error("Reply-file upload aborted.");
    total += chunk.byteLength;
    if (total > expectedBytes) throw new Error("Reply artifact exceeded its declared size.");
    chunks.push(chunk);
  }
  if (total !== expectedBytes) throw new Error("Reply artifact did not match its declared size.");
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
