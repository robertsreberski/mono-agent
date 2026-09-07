import { describe, expect, it, vi } from "vitest";
import {
  operatorResponseFromFinishFrame,
  OperatorStreamFrameTooLargeError,
  readOperatorStreamFrames,
} from "../client.js";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function body(chunks: readonly Uint8Array[], cancel = () => {}): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      // Intentionally left open so early terminal consumption must cancel it.
    },
    cancel,
  });
}

async function collect(stream: ReadableStream<Uint8Array>, maxBytes: number) {
  const frames = [];
  for await (const frame of readOperatorStreamFrames(stream, maxBytes)) frames.push(frame);
  return frames;
}

describe("operator client stream", () => {
  it("decodes split UTF-8 and final lines, preserving multipart terminal responses", async () => {
    const frames = [
      { kind: "append", delta: "Hi 🙂" },
      { kind: "finish", finalText: "Hi 🙂", metadata: { runId: "r1" }, parts: [
        { type: "failure", id: "f0", code: "artifact_missing", message: "Another file expired." },
        { type: "failure", id: "f1", code: "artifact_missing", message: "File expired." },
      ] },
    ];
    const bytes = encode(` \r\n${frames.map((frame) => JSON.stringify(frame)).join("\r\n")}`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const result = await collect(stream, 1024);
    expect(result).toEqual(frames);
    const finish = result[1]!;
    if (finish.kind !== "finish") throw new Error("Missing finish frame");
    expect(operatorResponseFromFinishFrame(finish)).toEqual({
      text: "Hi 🙂", metadata: { runId: "r1" }, parts: frames[1]!.parts,
    });
  });

  it.each([true, false])("enforces the raw byte limit across chunks (newline: %s)", async (newline) => {
    const line = JSON.stringify({ kind: "append", delta: "🙂".repeat(32) });
    const bytes = encode(line);
    const cancel = vi.fn();
    await expect(collect(body([bytes.subarray(0, 17), encode(line).subarray(17), ...(newline ? [encode("\n")] : [])], cancel), bytes.length - 1))
      .rejects.toBeInstanceOf(OperatorStreamFrameTooLargeError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("accepts the exact byte ceiling and cancels unread frames on early return", async () => {
    const frame = { kind: "finish", finalText: "done 🙂" };
    const line = JSON.stringify(frame);
    const cancel = vi.fn();
    for await (const received of readOperatorStreamFrames(body([encode(`${line}\nignored`)], cancel), encode(line).length)) {
      expect(received).toEqual(frame);
      break;
    }
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels the source on malformed frames", async () => {
    const cancel = vi.fn();
    await expect(collect(body([encode('{"kind":"append","delta":1}\n')], cancel), 1024)).rejects.toMatchObject({ code: "invalid_frame" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
