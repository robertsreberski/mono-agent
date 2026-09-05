import { describe, expect, it } from "vitest";
import {
  applyMessageDelta,
  createThreadCache,
  MessageDeltaError,
  mergeMessages,
} from "./thread-cache";
import { thread } from "./test/fixtures";
import { MESSAGE_DELTA_VECTORS } from "./test/message-delta-vectors";
import type {
  MessageDelta,
  MessageDeltaOp,
  MessagePart,
  ThreadDetail,
  WebMessage,
} from "./types";

/**
 * The shared table, read in THIS side's vocabulary.
 *
 * The annotation is the point: `message-delta-vectors.ts` names no type from
 * either package, and this assignment is what proves every literal in it is a
 * part and an op the console can actually hold.
 */
const vectors: readonly {
  readonly name: string;
  readonly prev: readonly MessagePart[];
  readonly next: readonly MessagePart[];
  readonly ops: readonly MessageDeltaOp[];
}[] = MESSAGE_DELTA_VECTORS;

const message = (id: string, overrides: Partial<WebMessage> = {}): WebMessage => ({
  id,
  threadId: "alpha-thread",
  role: "assistant",
  parts: [{ type: "text", text: id }],
  attachments: [],
  createdAt: "2026-08-14T08:00:00.000Z",
  updatedAt: "2026-08-14T08:00:00.000Z",
  status: "complete",
  seq: 1,
  ...overrides,
});

const delta = (overrides: Partial<MessageDelta> = {}): MessageDelta => ({
  messageId: "m1",
  baseSeq: 1,
  seq: 2,
  status: "running",
  updatedAt: "2026-08-14T08:00:01.000Z",
  ops: [],
  ...overrides,
});

const detail = (messages: readonly WebMessage[], cursor?: string): ThreadDetail => ({
  thread: thread("alpha-thread", "alpha"),
  messages,
  ...(cursor === undefined ? {} : { messagesNextCursor: cursor }),
});

describe("applyMessageDelta", () => {
  for (const vector of vectors) {
    it(`replays the shared vector: ${vector.name}`, () => {
      const held = message("m1", { parts: vector.prev });

      const next = applyMessageDelta(held, delta({ ops: vector.ops }));

      expect(next.parts).toEqual(vector.next);
    });
  }

  it("returns a new message carrying the delta's own status, stamp and version", () => {
    const held = message("m1", { status: "running", seq: 4 });

    const next = applyMessageDelta(held, delta({
      baseSeq: 4,
      seq: 5,
      status: "complete",
      updatedAt: "2026-08-14T09:30:00.000Z",
      ops: [{ op: "append", index: 0, delta: "!" }],
    }));

    expect(next).not.toBe(held);
    expect(next.status).toBe("complete");
    expect(next.updatedAt).toBe("2026-08-14T09:30:00.000Z");
    expect(next.seq).toBe(5);
    expect(next.parts).toEqual([{ type: "text", text: "m1!" }]);
    // The held message is never edited in place: assistant-ui reads the array
    // it already converted through the object it converted it from.
    expect(held.parts).toEqual([{ type: "text", text: "m1" }]);
  });

  it("consumes an empty delta so the version it produces is the next base", () => {
    const held = message("m1", { status: "running", seq: 7 });

    const next = applyMessageDelta(held, delta({ baseSeq: 7, seq: 8, status: "complete", ops: [] }));

    expect(next.seq).toBe(8);
    expect(next.status).toBe("complete");
    // Nothing touched the parts, so the array they live in is the same one.
    expect(next.parts).toBe(held.parts);
  });

  it("refuses a delta whose base is not the version this copy holds", () => {
    const held = message("m1", { seq: 3 });

    expect(() => applyMessageDelta(held, delta({ baseSeq: 2, seq: 3 })))
      .toThrow(MessageDeltaError);
  });

  it("refuses a delta against a message this console minted itself", () => {
    const held = message("m1", { seq: undefined });

    expect(() => applyMessageDelta(held, delta({ baseSeq: 0, seq: 1 })))
      .toThrow(MessageDeltaError);
  });

  it("refuses an op that names a slot the message does not have", () => {
    const held = message("m1");

    expect(() => applyMessageDelta(held, delta({
      ops: [{ op: "set", index: 4, part: { type: "text", text: "x" } }],
    }))).toThrow(MessageDeltaError);
    expect(() => applyMessageDelta(held, delta({ ops: [{ op: "truncate", length: 9 }] })))
      .toThrow(MessageDeltaError);
  });

  it("refuses to append to a part that cannot carry streamed text", () => {
    const held = message("m1", {
      parts: [{ type: "tool-call", toolCallId: "t1", toolName: "Read", status: "running" }],
    });

    expect(() => applyMessageDelta(held, delta({ ops: [{ op: "append", index: 0, delta: "x" }] })))
      .toThrow(MessageDeltaError);
  });
});

describe("mergeMessages", () => {
  it("reuses every untouched message by reference and keeps the array identity", () => {
    const held = [message("m1"), message("m2")];
    const incoming = [message("m1"), message("m2")];

    const merged = mergeMessages(held, incoming);

    expect(merged).toBe(held);
    expect(merged[0]).toBe(held[0]);
    expect(merged[1]).toBe(held[1]);
  });

  it("replaces only the message the server moved on", () => {
    const held = [message("m1"), message("m2", { seq: 1 })];
    const moved = message("m2", { seq: 2, parts: [{ type: "text", text: "grown" }] });

    const merged = mergeMessages(held, [message("m1"), moved]);

    expect(merged).not.toBe(held);
    expect(merged[0]).toBe(held[0]);
    expect(merged[1]).toBe(moved);
  });

  it("prefers a sequenced projection over a copy this console minted", () => {
    const local = message("m1", { seq: undefined });
    const sequenced = message("m1", { seq: 1 });

    expect(mergeMessages([local], [sequenced])[0]).toBe(sequenced);
  });

  it("keeps a held message a stale answer describes at an older version", () => {
    const held = [message("m1", { seq: 5 })];

    expect(mergeMessages(held, [message("m1", { seq: 3 })])).toBe(held);
  });

  it("keeps the server's order for the window it answered with", () => {
    // A question and the answer to it are written in the same millisecond, and
    // the server orders them by keys the wire does not carry -- the turn's
    // start, then a role rank. Re-sorting on what IS carried put the answer
    // ahead of the question every single turn.
    const question = message("question", { role: "user", seq: 0 });
    const answer = message("answer", { role: "assistant", seq: 41 });

    expect(mergeMessages([], [question, answer]).map((item) => item.id))
      .toEqual(["question", "answer"]);
    expect(mergeMessages([question, answer], [question, answer]).map((item) => item.id))
      .toEqual(["question", "answer"]);
  });

  it("puts a row no answer positioned after the last one that is not newer", () => {
    const cache = createThreadCache();
    const question = message("question", { role: "user", createdAt: "2026-08-14T08:00:00.000Z" });
    cache.upsertFull(detail([question]));

    cache.upsertMessage("alpha-thread", message("answer", {
      role: "assistant",
      createdAt: "2026-08-14T08:00:00.000Z",
    }));

    expect(cache.get("alpha-thread")?.messages.map((item) => item.id))
      .toEqual(["question", "answer"]);
  });

  it("replaces a message where the server already put it", () => {
    const cache = createThreadCache();
    const question = message("question", { role: "user", seq: 0 });
    const answer = message("answer", { role: "assistant", seq: 1 });
    cache.upsertFull(detail([question, answer]));

    cache.upsertMessage("alpha-thread", message("answer", { role: "assistant", seq: 9 }));

    expect(cache.get("alpha-thread")?.messages.map((item) => item.id))
      .toEqual(["question", "answer"]);
    expect(cache.get("alpha-thread")?.messages[1]?.seq).toBe(9);
  });

  it("keeps paged-in history older than a window read and drops in-window deletions", () => {
    const older = message("older", { createdAt: "2026-08-14T07:00:00.000Z" });
    const kept = message("kept", { createdAt: "2026-08-14T08:00:00.000Z" });
    const deleted = message("deleted", { createdAt: "2026-08-14T08:30:00.000Z" });

    const merged = mergeMessages([older, kept, deleted], [kept], { resetWindow: true });

    expect(merged.map((item) => item.id)).toEqual(["older", "kept"]);
    expect(merged[0]).toBe(older);
    expect(merged[1]).toBe(kept);
  });

  it("keeps nothing when a window read says the conversation is empty", () => {
    expect(mergeMessages([message("m1")], [], { resetWindow: true })).toEqual([]);
  });
});

describe("createThreadCache", () => {
  it("never evicts the conversation on screen, however long ago it was read", () => {
    const cache = createThreadCache(2);
    cache.upsertFull({ ...detail([]), thread: thread("a", "alpha") });
    cache.setSelected("a");
    cache.upsertFull({ ...detail([]), thread: thread("b", "alpha") });
    cache.upsertFull({ ...detail([]), thread: thread("c", "alpha") });

    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("evicts the conversation nothing has touched for longest", () => {
    const cache = createThreadCache(2);
    cache.upsertFull({ ...detail([]), thread: thread("a", "alpha") });
    cache.upsertFull({ ...detail([]), thread: thread("b", "alpha") });
    cache.touch("a");
    cache.upsertFull({ ...detail([]), thread: thread("c", "alpha") });

    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeUndefined();
  });

  it("keeps a page of older messages and the cursor a window read cannot know", () => {
    const cache = createThreadCache();
    const recent = message("recent", { createdAt: "2026-08-14T08:00:00.000Z" });
    cache.upsertFull(detail([recent], "cursor-window"), { reset: true });
    cache.prependOlder("alpha-thread", {
      messages: [message("older", { createdAt: "2026-08-14T07:00:00.000Z" })],
      nextCursor: "cursor-older",
    });

    cache.upsertFull(detail([recent], "cursor-window"), { reset: true });

    const entry = cache.get("alpha-thread");
    expect(entry?.messages.map((item) => item.id)).toEqual(["older", "recent"]);
    // The window read's cursor points at the page ALREADY held, so adopting it
    // would walk history this conversation has in hand.
    expect(entry?.messagesNextCursor).toBe("cursor-older");
  });

  it("adopts a window read's cursor when it has no older history to protect", () => {
    const cache = createThreadCache();
    cache.upsertFull(detail([message("recent")], "cursor-window"), { reset: true });

    expect(cache.get("alpha-thread")?.messagesNextCursor).toBe("cursor-window");
  });

  it("applies a delta to the message it names and leaves the rest alone", () => {
    const cache = createThreadCache();
    const first = message("m0", { createdAt: "2026-08-14T07:00:00.000Z" });
    const target = message("m1", { seq: 1, parts: [{ type: "text", text: "hel" }] });
    cache.upsertFull(detail([first, target]));

    expect(cache.applyDelta("alpha-thread", delta({
      ops: [{ op: "append", index: 0, delta: "lo" }],
    }))).toBe("applied");

    const entry = cache.get("alpha-thread");
    expect(entry?.messages[0]).toBe(first);
    expect(entry?.messages[1]?.parts).toEqual([{ type: "text", text: "hello" }]);
    expect(entry?.messages[1]?.seq).toBe(2);
  });

  it("reports a gap rather than guessing when the base is not the version held", () => {
    const cache = createThreadCache();
    cache.upsertFull(detail([message("m1", { seq: 1 })]));

    expect(cache.applyDelta("alpha-thread", delta({ baseSeq: 4, seq: 5 }))).toBe("gap");
    // Nothing was applied: the caller re-reads the message instead.
    expect(cache.get("alpha-thread")?.messages[0]?.seq).toBe(1);
  });

  it("reports a gap for a message this console minted and cannot version", () => {
    const cache = createThreadCache();
    cache.upsertFull(detail([message("m1", { seq: undefined })]));

    expect(cache.applyDelta("alpha-thread", delta({ baseSeq: 0, seq: 1 }))).toBe("gap");
  });

  it("reports a gap for a replay this message's parts cannot mean", () => {
    const cache = createThreadCache();
    cache.upsertFull(detail([message("m1", { seq: 1 })]));

    expect(cache.applyDelta("alpha-thread", delta({
      ops: [{ op: "truncate", length: 9 }],
    }))).toBe("gap");
    expect(cache.get("alpha-thread")?.messages[0]?.seq).toBe(1);
  });

  it("reports a delta it is already past rather than re-reading for it", () => {
    const cache = createThreadCache();
    cache.upsertFull(detail([message("m1", { seq: 6 })]));

    expect(cache.applyDelta("alpha-thread", delta({ baseSeq: 3, seq: 4 }))).toBe("stale");
  });

  it("reports an unheld message and an unheld conversation as unknown", () => {
    const cache = createThreadCache();
    cache.upsertFull(detail([message("m1")]));

    expect(cache.applyDelta("alpha-thread", delta({ messageId: "never-loaded" }))).toBe("unknown");
    expect(cache.applyDelta("other-thread", delta())).toBe("unknown");
  });

  it("keeps a loaded full tool result through a later write of its slot", () => {
    const cache = createThreadCache();
    const truncated: MessagePart = {
      type: "tool-call",
      toolCallId: "t1",
      toolName: "Read",
      result: "HEAD",
      resultTruncated: true,
      resultBytes: 16,
      status: "complete",
    };
    cache.upsertFull(detail([message("m1", { seq: 1, parts: [truncated] })]));
    expect(cache.repairToolCall("alpha-thread", "m1", "t1", {
      type: "tool-call",
      toolCallId: "t1",
      toolName: "Read",
      result: "HEAD AND THE TAIL",
      status: "complete",
    })).toBe(true);

    // The server rewrites the same slot -- an execution timing, a status flip --
    // and sends the DEFAULT shape, which is the preview again.
    const outcome = cache.applyDelta("alpha-thread", delta({
      ops: [{
        op: "set",
        index: 0,
        part: { ...truncated, executionMs: 12, resultBytes: 17 },
      }],
    }));

    expect(outcome).toBe("applied");
    const part = cache.get("alpha-thread")?.messages[0]?.parts[0] as {
      readonly result?: unknown;
      readonly executionMs?: number;
      readonly resultTruncated?: boolean;
    };
    expect(part.result).toBe("HEAD AND THE TAIL");
    expect(part.executionMs).toBe(12);
    expect(part.resultTruncated).toBeUndefined();
  });

  it("hands a rewritten body back to the server rather than keeping a stale repair", () => {
    const cache = createThreadCache();
    const truncated: MessagePart = {
      type: "tool-call",
      toolCallId: "t1",
      toolName: "Read",
      result: "HEAD",
      resultTruncated: true,
      resultBytes: 16,
      status: "complete",
    };
    cache.upsertFull(detail([message("m1", { seq: 1, parts: [truncated] })]));
    cache.repairToolCall("alpha-thread", "m1", "t1", {
      type: "tool-call",
      toolCallId: "t1",
      toolName: "Read",
      result: "HEAD AND THE TAIL",
      status: "complete",
    });

    // A DIFFERENT body: the preview reports a length the held one does not have.
    cache.applyDelta("alpha-thread", delta({
      ops: [{ op: "set", index: 0, part: { ...truncated, result: "NEW ", resultBytes: 4_000 } }],
    }));

    const part = cache.get("alpha-thread")?.messages[0]?.parts[0] as {
      readonly result?: unknown;
      readonly resultTruncated?: boolean;
    };
    expect(part.result).toBe("NEW ");
    expect(part.resultTruncated).toBe(true);
  });

  it("patches the summary of a conversation it holds and inserts none it does not", () => {
    const cache = createThreadCache();
    cache.upsertFull(detail([]));

    cache.patchThread("alpha-thread", thread("alpha-thread", "alpha", { title: "Renamed" }));
    cache.patchThread("never-held", thread("never-held", "alpha"));

    expect(cache.get("alpha-thread")?.thread.title).toBe("Renamed");
    expect(cache.get("never-held")).toBeUndefined();
  });

  it("marks an entry stale and clears that only when a read lands", () => {
    const cache = createThreadCache();
    cache.upsertFull(detail([]));
    expect(cache.get("alpha-thread")?.stale).toBe(false);

    cache.markStale("alpha-thread");
    expect(cache.get("alpha-thread")?.stale).toBe(true);

    cache.upsertFull(detail([]), { reset: true });
    expect(cache.get("alpha-thread")?.stale).toBe(false);
  });

  it("forgets a conversation on request", () => {
    const cache = createThreadCache();
    cache.upsertFull(detail([]));

    cache.evict("alpha-thread");

    expect(cache.get("alpha-thread")).toBeUndefined();
  });
});
