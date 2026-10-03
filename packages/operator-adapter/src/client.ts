import {
  parseAgentStreamFrame,
  type AgentResponse,
  type AgentStreamWireFrame,
} from "@mono-agent/agent-contracts";

export { fetchLongLivedTurn, fetchLongLivedHostWake } from "./long-lived-fetch.js";

/** The receiving UI owns its compatibility ceiling and error presentation. */
export class OperatorStreamFrameTooLargeError extends Error {
  constructor(readonly maxFrameBytes: number) {
    super(`Agent stream frame exceeds the ${String(maxFrameBytes)}-byte client limit.`);
    this.name = "OperatorStreamFrameTooLargeError";
  }
}

/** Decode bounded NDJSON, including a final frame without a newline. */
export async function* readOperatorStreamFrames(
  body: ReadableStream<Uint8Array>,
  maxFrameBytes: number,
): AsyncGenerator<AgentStreamWireFrame> {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
    throw new RangeError("maxFrameBytes must be a positive safe integer.");
  }
  for await (const line of readBoundedNdjsonLines(body, maxFrameBytes)) {
    if (line.trim().length > 0) yield parseAgentStreamFrame(line);
  }
}

/** Preserve every response field carried by the shared terminal wire contract. */
export function operatorResponseFromFinishFrame(
  frame: Extract<AgentStreamWireFrame, { readonly kind: "finish" }>,
): AgentResponse {
  return {
    ...(frame.finalText === undefined ? {} : { text: frame.finalText }),
    ...(frame.metadata === undefined ? {} : { metadata: frame.metadata }),
    ...(frame.parts === undefined ? {} : { parts: frame.parts }),
  };
}

async function* readBoundedNdjsonLines(
  body: ReadableStream<Uint8Array>,
  maxFrameBytes: number,
): AsyncGenerator<string> {
  const reader = body.getReader();
  let segments: Uint8Array[] = [];
  let pendingBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let start = 0;
      for (let index = 0; index < value.byteLength; index += 1) {
        if (value[index] !== 0x0a) continue;
        const segment = value.subarray(start, index);
        if (pendingBytes + segment.byteLength > maxFrameBytes) {
          throw new OperatorStreamFrameTooLargeError(maxFrameBytes);
        }
        yield decodeSegments(segments, segment, pendingBytes + segment.byteLength);
        segments = [];
        pendingBytes = 0;
        start = index + 1;
      }
      const remainder = value.subarray(start);
      if (pendingBytes + remainder.byteLength > maxFrameBytes) {
        throw new OperatorStreamFrameTooLargeError(maxFrameBytes);
      }
      if (remainder.byteLength > 0) {
        segments.push(remainder);
        pendingBytes += remainder.byteLength;
      }
    }
    if (pendingBytes > 0) yield decodeSegments(segments, undefined, pendingBytes);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function decodeSegments(segments: readonly Uint8Array[], tail: Uint8Array | undefined, total: number): string {
  const buffers = segments.map((segment) => Buffer.from(segment));
  if (tail !== undefined && tail.byteLength > 0) buffers.push(Buffer.from(tail));
  return Buffer.concat(buffers, total).toString("utf8");
}
