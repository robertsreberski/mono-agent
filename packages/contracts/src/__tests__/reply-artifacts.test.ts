import { describe, expect, it, vi } from "vitest";

import type { AgentReplyAttachmentPart } from "../index.js";
import { assertMatchingReplyAttachment, collectExactReplyArtifactBytes } from "../reply-artifacts.js";

const part: AgentReplyAttachmentPart = {
  type: "attachment",
  id: "file-1",
  reference: { scheme: "mono-agent-artifact", id: "11111111-1111-4111-8111-111111111111" },
  name: "report.txt",
  mediaType: "text/plain",
  sizeBytes: 5,
  integrityId: `sha256:${"a".repeat(64)}`,
};

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield new TextEncoder().encode(value);
}

describe("authorized reply artifact verification", () => {
  it("accepts matching artifact metadata and reassembles split bytes exactly", async () => {
    expect(() => assertMatchingReplyAttachment(part, { ...part })).not.toThrow();
    await expect(collectExactReplyArtifactBytes(chunks("he", "l", "lo"), 5, undefined))
      .resolves.toEqual(new TextEncoder().encode("hello"));
  });

  it.each([
    { reference: { ...part.reference, id: "22222222-2222-4222-8222-222222222222" } },
    { integrityId: `sha256:${"b".repeat(64)}` },
    { sizeBytes: 4 },
    { name: "other.txt" },
    { mediaType: "application/json" },
  ])("rejects changed authorization metadata %j", (change) => {
    expect(() => assertMatchingReplyAttachment(part, { ...part, ...change }))
      .toThrow("Authorized reply artifact metadata did not match the reply part.");
  });

  it("rejects short streams and closes oversized streams before reading further", async () => {
    await expect(collectExactReplyArtifactBytes(chunks("hell"), 5, undefined))
      .rejects.toThrow("did not match its declared size");
    const closed = vi.fn();
    const reachedTail = vi.fn();
    const oversized = (async function* () {
      try {
        yield new Uint8Array(6);
        reachedTail();
        yield new Uint8Array(1);
      } finally {
        closed();
      }
    })();
    await expect(collectExactReplyArtifactBytes(oversized, 5, undefined))
      .rejects.toThrow("exceeded its declared size");
    expect(closed).toHaveBeenCalledOnce();
    expect(reachedTail).not.toHaveBeenCalled();
  });

  it("stops reading with the caller's abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    const aborted = (async function* () {
      yield new Uint8Array(2);
      controller.abort(reason);
      yield new Uint8Array(3);
    })();
    await expect(collectExactReplyArtifactBytes(aborted, 5, controller.signal)).rejects.toBe(reason);
  });
});
