import { describe, expect, it } from "vitest";
import {
  applyMessageDelta,
  createThreadCache,
  MessageDeltaError,
  mergeMessages,
  newerProjection,
  readMessageDelta,
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

    const merged = mergeMessages(
      [older, kept, deleted],
      [kept],
      { resetWindow: true, bounded: true, pagedIn: new Set(["older"]) },
    );

    expect(merged.map((item) => item.id)).toEqual(["older", "kept"]);
    expect(merged[0]).toBe(older);
    expect(merged[1]).toBe(kept);
  });

  it("keeps nothing when a window read says the conversation is empty", () => {
    expect(mergeMessages([message("m1")], [], { resetWindow: true })).toEqual([]);
  });

  it("drops history an UNBOUNDED answer does not carry, however old it is", () => {
    // No cursor means the answer IS the whole transcript, so an absence at any
    // age is a deletion -- which is what a compaction looks like.
    const older = message("older", { createdAt: "2026-08-14T07:00:00.000Z" });
    const kept = message("kept", { createdAt: "2026-08-14T08:00:00.000Z" });

    expect(mergeMessages([older, kept], [kept], { resetWindow: true }).map((item) => item.id))
      .toEqual(["kept"]);
  });

  it("interleaves what an answer did not carry at the position it already had", () => {
    // A conditional read answers with the messages that MOVED, not with a
    // window. Concatenating the rest in front of it reordered the transcript.
    const messages = ["m1", "m2", "m3", "m4"].map((id) => message(id));
    const [m1, m2, m3, m4] = messages as [WebMessage, WebMessage, WebMessage, WebMessage];
    const moved = [
      { ...m2, seq: 9 },
      { ...m4, seq: 9 },
    ];

    expect(mergeMessages(messages, moved).map((item) => item.id))
      .toEqual(["m1", "m2", "m3", "m4"]);
    expect(mergeMessages(messages, moved)[0]).toBe(m1);
    expect(mergeMessages(messages, moved)[2]).toBe(m3);
  });

  it("keeps every held row older than a window that has moved on", () => {
    // The window is the NEWEST rows, so it walks forward as a turn appends to
    // the conversation: a refresh a few messages later no longer carries the
    // row it used to start at. Reading that absence as a deletion punched a
    // hole in the MIDDLE of the transcript -- and the older cursor is kept, so
    // paging could never bring it back.
    const at = (minute: string) => `2026-08-14T0${minute}:00:00.000Z`;
    const p1 = message("p1", { createdAt: at("5") });
    const p2 = message("p2", { createdAt: at("6") });
    const m1 = message("m1", { createdAt: at("7") });
    const m2 = message("m2", { createdAt: at("8") });
    const m3 = message("m3", { createdAt: at("9") });
    const m4 = message("m4", { createdAt: "2026-08-14T10:00:00.000Z" });

    const merged = mergeMessages(
      [p1, p2, m1, m2, m3],
      [m2, m3, m4],
      { resetWindow: true, bounded: true, pagedIn: new Set(["p1", "p2"]) },
    );

    expect(merged.map((item) => item.id)).toEqual(["p1", "p2", "m1", "m2", "m3", "m4"]);
    // Untouched, so still the very objects assistant-ui converted.
    expect(merged[0]).toBe(p1);
    expect(merged[2]).toBe(m1);
  });

  it("keeps paged history when the window has moved past it entirely", () => {
    // The ordinary app-switch case: the tab was suspended long enough for the
    // window to advance by a whole page, so the answer shares NOTHING with what
    // is held. That branch never reached `outsideAnswer`, so everything the
    // operator had scrolled back to went with it.
    const pagedOld = message("paged-old", { createdAt: "2026-08-14T07:00:00.000Z" });
    const oldWindow = message("old-window", { createdAt: "2026-08-14T09:00:00.000Z" });
    const newWindow = message("new-window", { createdAt: "2026-08-14T09:00:00.000Z" });

    const merged = mergeMessages([pagedOld, oldWindow], [newWindow], {
      resetWindow: true,
      bounded: true,
      pagedIn: new Set(["paged-old"]),
    });

    // The paged row is older than anything the answer carries, so the answer
    // cannot speak for it; the un-paged row sits INSIDE the window the answer
    // does speak for, so its absence is a deletion.
    expect(merged.map((item) => item.id)).toEqual(["paged-old", "new-window"]);
    expect(merged[0]).toBe(pagedOld);
  });

  it("drops everything an UNBOUNDED answer does not carry, overlap or not", () => {
    const pagedOld = message("paged-old", { createdAt: "2026-08-14T07:00:00.000Z" });
    const newWindow = message("new-window", { createdAt: "2026-08-14T09:00:00.000Z" });

    const merged = mergeMessages([pagedOld], [newWindow], {
      resetWindow: true,
      pagedIn: new Set(["paged-old"]),
    });

    expect(merged.map((item) => item.id)).toEqual(["new-window"]);
  });

  it("still reads an absence INSIDE the window as a deletion", () => {
    // The other half of the same rule: a row the answer's own range covers and
    // does not carry is gone, and keeping it would show the operator content
    // the server no longer has.
    const kept = message("kept", { createdAt: "2026-08-14T08:00:00.000Z" });
    const deleted = message("deleted", { createdAt: "2026-08-14T08:30:00.000Z" });
    const newest = message("newest", { createdAt: "2026-08-14T09:00:00.000Z" });

    expect(mergeMessages(
      [kept, deleted, newest],
      [kept, newest],
      { resetWindow: true, bounded: true },
    ).map((item) => item.id)).toEqual(["kept", "newest"]);
  });

  it("keeps paged history a bounded answer cannot speak for, wherever it sits", () => {
    // `insertionIndexFor` places a recovered message by `createdAt` alone, so a
    // row the answer DOES carry can end up in front of history the answer's
    // window starts after. Taking the first overlap as the boundary would then
    // drop every page the operator had scrolled back to.
    const recovered = message("recovered", { createdAt: "2026-08-14T06:00:00.000Z" });
    const paged = message("paged", { createdAt: "2026-08-14T07:00:00.000Z" });
    const windowed = message("windowed", { createdAt: "2026-08-14T08:00:00.000Z" });

    const merged = mergeMessages(
      [recovered, paged, windowed],
      [recovered, windowed],
      { resetWindow: true, bounded: true, pagedIn: new Set(["paged"]) },
    );

    expect(merged.map((item) => item.id)).toEqual(["recovered", "paged", "windowed"]);
  });
});

describe("newerProjection", () => {
  it("keeps the projection the server made later, and takes an equal one", () => {
    const held = thread("t", "alpha", { revision: 3, title: "held" });
    expect(newerProjection(held, thread("t", "alpha", { revision: 2 }))).toBe(held);
    expect(newerProjection(held, undefined)).toBe(held);
    const equal = thread("t", "alpha", { revision: 3, title: "optimistic" });
    expect(newerProjection(held, equal)).toBe(equal);
  });
});

describe("readMessageDelta", () => {
  const wire = {
    messageId: "m1",
    baseSeq: 1,
    seq: 2,
    status: "running",
    updatedAt: "2026-08-14T08:00:01.000Z",
    ops: [] as unknown[],
  };

  it("reads a well-formed frame", () => {
    expect(readMessageDelta({ ...wire, ops: [{ op: "append", index: 0, delta: "x" }] }))
      .toEqual({ ...wire, ops: [{ op: "append", index: 0, delta: "x" }] });
  });

  it("refuses a frame missing anything the replay depends on", () => {
    for (const key of ["messageId", "baseSeq", "seq", "status", "updatedAt", "ops"]) {
      const broken: Record<string, unknown> = { ...wire };
      delete broken[key];
      expect(readMessageDelta(broken)).toBeUndefined();
    }
    expect(readMessageDelta(null)).toBeUndefined();
    expect(readMessageDelta("nope")).toBeUndefined();
  });

  it("refuses a set op whose part the transcript could not render", () => {
    const setOp = (part: unknown) => readMessageDelta({ ...wire, ops: [{ op: "set", index: 0, part }] });

    expect(setOp({ type: "text", text: "hello" })).toBeDefined();
    expect(setOp({
      type: "tool-call", toolCallId: "t1", toolName: "Read", status: "complete",
    })).toBeDefined();
    // A part with no type at all, a text part with no text, a tool call with no
    // id, and a type this console has never heard of: every one of them is a
    // frame to re-read the message for, not one to render.
    expect(setOp({ text: "hello" })).toBeUndefined();
    expect(setOp({ type: "text" })).toBeUndefined();
    expect(setOp({ type: "tool-call", toolName: "Read", status: "complete" })).toBeUndefined();
    expect(setOp({ type: "tool-call", toolCallId: "t1", toolName: "Read", status: "sideways" }))
      .toBeUndefined();
    expect(setOp({ type: "something-newer", payload: 1 })).toBeUndefined();
    expect(setOp(null)).toBeUndefined();
  });

  it("refuses an op whose own shape is wrong", () => {
    expect(readMessageDelta({ ...wire, ops: [{ op: "truncate" }] })).toBeUndefined();
    expect(readMessageDelta({ ...wire, ops: [{ op: "append", index: 0 }] })).toBeUndefined();
    expect(readMessageDelta({ ...wire, ops: [{ op: "append", delta: "x" }] })).toBeUndefined();
    expect(readMessageDelta({ ...wire, ops: [{ op: "nudge", index: 0 }] })).toBeUndefined();
    expect(readMessageDelta({ ...wire, ops: "none" })).toBeUndefined();
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

  it("keeps a loaded full tool result through a later write of its slot", () => {
    const cache = createThreadCache();
    const truncated: MessagePart = {
      type: "tool-call",
      toolCallId: "t1",
      toolName: "Read",
      result: "HEAD",
      resultTruncated: true,
      resultBytes: 16,
      resultDigest: "digest-of-head-and-the-tail",
      status: "complete",
    };
    cache.upsertFull(detail([message("m1", { seq: 1, parts: [truncated] })]));
    expect(cache.repairToolCall("alpha-thread", "m1", "t1", {
      type: "tool-call",
      toolCallId: "t1",
      toolName: "Read",
      result: "HEAD AND THE TAIL",
      resultDigest: "digest-of-head-and-the-tail",
      status: "complete",
    })).toBe(true);

    // The server rewrites the same slot -- an execution timing, a status flip --
    // and sends the DEFAULT shape, which is the preview again. Same digest: the
    // same body, so the one already loaded goes back under it.
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
      resultDigest: "digest-of-head-and-the-tail",
      status: "complete",
    };
    cache.upsertFull(detail([message("m1", { seq: 1, parts: [truncated] })]));
    cache.repairToolCall("alpha-thread", "m1", "t1", {
      type: "tool-call",
      toolCallId: "t1",
      toolName: "Read",
      result: "HEAD AND THE TAIL",
      resultDigest: "digest-of-head-and-the-tail",
      status: "complete",
    });

    // A DIFFERENT body: the preview names content the held one is not.
    cache.applyDelta("alpha-thread", delta({
      ops: [{
        op: "set",
        index: 0,
        part: { ...truncated, result: "NEW ", resultBytes: 4_000, resultDigest: "digest-of-something-else" },
      }],
    }));

    const part = cache.get("alpha-thread")?.messages[0]?.parts[0] as {
      readonly result?: unknown;
      readonly resultTruncated?: boolean;
    };
    expect(part.result).toBe("NEW ");
    expect(part.resultTruncated).toBe(true);
  });

  it("drops a repair the server no longer names, rather than guessing from a length", () => {
    // The length and the head agreed and the body was still a different one: a
    // rewritten result of exactly the same size starting with the same
    // characters used to restore the OLD body under the NEW preview. The digest
    // is the only evidence that answers the question being asked, and its
    // absence is not evidence at all -- so a preview that names nothing is
    // served as the preview it is.
    const cache = createThreadCache();
    const truncated: MessagePart = {
      type: "tool-call",
      toolCallId: "t1",
      toolName: "Read",
      result: "HEAD",
      resultTruncated: true,
      resultBytes: 17,
      resultDigest: "digest-of-the-first-body",
      status: "complete",
    };
    cache.upsertFull(detail([message("m1", { seq: 1, parts: [truncated] })]));
    cache.repairToolCall("alpha-thread", "m1", "t1", {
      type: "tool-call",
      toolCallId: "t1",
      toolName: "Read",
      result: "HEAD AND THE TAIL",
      resultDigest: "digest-of-the-first-body",
      status: "complete",
    });

    // Same length, same head, different content -- and the server says so.
    cache.applyDelta("alpha-thread", delta({
      ops: [{
        op: "set",
        index: 0,
        part: { ...truncated, resultDigest: "digest-of-the-second-body" },
      }],
    }));
    const rewritten = cache.get("alpha-thread")?.messages[0]?.parts[0] as {
      readonly result?: unknown;
      readonly resultTruncated?: boolean;
    };
    expect(rewritten.result).toBe("HEAD");
    expect(rewritten.resultTruncated).toBe(true);

    // And a preview carrying no digest at all is not evidence either.
    cache.repairToolCall("alpha-thread", "m1", "t1", {
      type: "tool-call",
      toolCallId: "t1",
      toolName: "Read",
      result: "HEAD AND THE TAIL",
      resultDigest: "digest-of-the-second-body",
      status: "complete",
    });
    const { resultDigest: _dropped, ...unnamed } = truncated as MessagePart & { resultDigest?: string };
    cache.applyDelta("alpha-thread", delta({
      baseSeq: 2,
      seq: 3,
      ops: [{ op: "set", index: 0, part: unnamed as MessagePart }],
    }));
    const unnamedPart = cache.get("alpha-thread")?.messages[0]?.parts[0] as {
      readonly result?: unknown;
      readonly resultTruncated?: boolean;
    };
    expect(unnamedPart.result).toBe("HEAD");
    expect(unnamedPart.resultTruncated).toBe(true);
  });

  it("hands back the very objects it was holding when a write changes nothing", () => {
    // The device store decides what to rewrite by comparing entries FIELD BY
    // FIELD and by identity -- `pagedInIds`, `thread`, `messages`. Two of those
    // were rebuilt unconditionally, so a conversation re-read once a second
    // during a turn, and a run state restated by every event, each re-stripped
    // and rewrote a byte-identical row on every flush.
    const cache = createThreadCache();
    cache.upsertFull(detail([message("m2")], "cursor-older"));
    cache.prependOlder("alpha-thread", { messages: [message("m1")] });
    const held = cache.get("alpha-thread")!;
    expect(held.pagedInIds.has("m1")).toBe(true);

    // A re-read that keeps every message it is holding keeps the SET too.
    cache.upsertFull(detail([message("m1"), message("m2")]));
    expect(cache.get("alpha-thread")?.pagedInIds).toBe(held.pagedInIds);

    // A run state that says exactly what the summary already says is not news.
    const before = cache.get("alpha-thread")!;
    expect(cache.patchRunState("alpha-thread", { status: "idle" })).toBe(false);
    expect(cache.get("alpha-thread")).toBe(before);
    expect(cache.get("alpha-thread")?.thread).toBe(before.thread);

    // A run state that says something else still lands.
    expect(cache.patchRunState("alpha-thread", { status: "running", id: "turn-1" })).toBe(true);
    expect(cache.get("alpha-thread")?.thread.runState).toEqual({ status: "running", id: "turn-1" });

    // And a message that really went away still leaves the set behind it.
    cache.upsertFull(detail([message("m2")]), { reset: true });
    expect(cache.get("alpha-thread")?.pagedInIds.has("m1")).toBe(false);
  });

  it("marks what the device restored as unconfirmed until the server touches it", () => {
    // `runState` is stored verbatim, so a tab killed mid-turn keeps `running`
    // for a turn that finished while the browser was shut -- and no event is
    // ever coming for it. Anything reading "is a turn running" off the held set
    // would have latched true for the rest of the session.
    const cache = createThreadCache();
    const running = thread("alpha-thread", "alpha", {
      runState: { status: "running", id: "turn-1" },
    });
    cache.restore({ thread: running, messages: [message("m1")] });

    const restored = cache.get("alpha-thread")!;
    expect(restored.fromDevice).toBe(true);
    expect(restored.thread.runState.status).toBe("running");

    // Suspicion is not the same question: a live entry the reconnect marked
    // stale is still an entry the server has confirmed.
    cache.markAllStale();
    expect(cache.get("alpha-thread")?.fromDevice).toBe(true);

    // A 304 is the server saying this body -- summary and run state -- is what
    // it has, which is exactly the confirmation that was missing.
    expect(cache.confirmFresh("alpha-thread", cache.clock())).toBe(true);
    expect(cache.get("alpha-thread")?.fromDevice).toBe(false);
    expect(cache.get("alpha-thread")?.thread.runState.status).toBe("running");
  });

  it("confirms a restored conversation through any answer carrying a summary, and nothing else", () => {
    // The summary is where `runState` lives, and `runState` is the one field a
    // restored entry cannot be trusted about. A message, a page of older
    // history or a delta says nothing whatever about whether the turn is still
    // running, so none of them may stand in for the server saying so.
    const cache = createThreadCache();
    const restore = () => {
      cache.evict("alpha-thread");
      cache.restore({
        thread: thread("alpha-thread", "alpha", { runState: { status: "running" } }),
        messages: [message("m1", { seq: 1 })],
      });
      expect(cache.get("alpha-thread")?.fromDevice).toBe(true);
    };

    restore();
    cache.upsertFull(detail([message("m1")]));
    expect(cache.get("alpha-thread")?.fromDevice).toBeFalsy();

    restore();
    // A `turn.changed` restating what is held still CONFIRMS it, even though it
    // moves nothing: the news is that the server spoke about this conversation.
    expect(cache.patchRunState("alpha-thread", { status: "running" })).toBe(true);
    expect(cache.get("alpha-thread")?.fromDevice).toBe(false);

    restore();
    expect(cache.patchThread("alpha-thread", thread("alpha-thread", "alpha", {
      revision: 2,
      runState: { status: "complete" },
    }))).toBe(true);
    expect(cache.get("alpha-thread")?.fromDevice).toBe(false);

    // A listing row confirms too -- and at an equal revision it confirms
    // WITHOUT replacing what is held. See `confirmListed`.
    restore();
    expect(cache.confirmListed("alpha-thread", thread("alpha-thread", "alpha", {
      runState: { status: "complete" },
    }))).toBe(true);
    expect(cache.get("alpha-thread")?.fromDevice).toBe(false);
    expect(cache.get("alpha-thread")?.thread.runState.status).toBe("running");

    // And the three that carry no summary leave it exactly as it was.
    restore();
    cache.applyDelta("alpha-thread", delta({ ops: [{ op: "append", index: 0, delta: "lo" }] }));
    expect(cache.get("alpha-thread")?.fromDevice).toBe(true);
    cache.upsertMessage("alpha-thread", message("m2", { seq: 1 }));
    expect(cache.get("alpha-thread")?.fromDevice).toBe(true);
    cache.prependOlder("alpha-thread", { messages: [message("m0", { seq: 1 })] });
    expect(cache.get("alpha-thread")?.fromDevice).toBe(true);
    cache.repairToolCall("alpha-thread", "m1", "t1", {
      type: "tool-call",
      toolCallId: "t1",
      toolName: "Read",
      result: "whole",
      status: "complete",
    });
    expect(cache.get("alpha-thread")?.fromDevice).toBe(true);

    // The conditional read the first open issues is what settles the selected
    // conversation, whichever way the server answers it.
    expect(cache.confirmFresh("alpha-thread", cache.clock())).toBe(true);
    expect(cache.get("alpha-thread")?.fromDevice).toBe(false);

    // A markAllStale on a confirmed entry leaves it confirmed.
    cache.markAllStale();
    expect(cache.get("alpha-thread")?.fromDevice).toBe(false);

    // And what `clear` empties is gone from the held set entirely, so anything
    // derived from it -- "is a turn running" -- goes with it.
    cache.clear();
    expect(cache.snapshot()).toEqual([]);
  });

  it("confirms a held conversation from a listing row without taking the row's word over its own", () => {
    // A listing row is a fresh object per response, and `patchRunState` moves
    // `runState` without moving `revision` -- so a row at an EQUAL revision is
    // neither news nor safe to adopt. Adopting it replaced the held summary's
    // identity with a copy of itself, which the device store reads as "this
    // transcript moved", and undid a `turn.changed` that raced the listing.
    let commits = 0;
    const cache = createThreadCache(8, () => 0, () => { commits += 1; });

    // Not held: nothing is inserted, nothing is announced.
    expect(cache.confirmListed("never-held", thread("never-held", "alpha"))).toBe(false);
    expect(cache.get("never-held")).toBeUndefined();
    expect(commits).toBe(0);

    const running = thread("alpha-thread", "alpha", {
      revision: 3,
      runState: { status: "running", id: "turn-1" },
    });
    cache.restore({ thread: running, messages: [message("m1")] });
    const restored = cache.get("alpha-thread")!;
    expect(restored.fromDevice).toBe(true);

    // Equal revision, saying the turn is over: confirmed, kept by reference --
    // summary AND transcript -- and announced exactly once.
    const equal = thread("alpha-thread", "alpha", { revision: 3, runState: { status: "complete" } });
    expect(cache.confirmListed("alpha-thread", equal)).toBe(true);
    const confirmedEntry = cache.get("alpha-thread")!;
    expect(confirmedEntry.fromDevice).toBe(false);
    expect(confirmedEntry.thread).toBe(restored.thread);
    expect(confirmedEntry.messages).toBe(restored.messages);
    expect(confirmedEntry.thread.runState.status).toBe("running");
    expect(commits).toBe(1);

    // Already confirmed, same revision again (a fresh object, as every
    // response is): nothing changed, nothing announced, the very same entry.
    expect(cache.confirmListed("alpha-thread", { ...equal })).toBe(false);
    expect(cache.get("alpha-thread")).toBe(confirmedEntry);
    expect(commits).toBe(1);

    // Older: the same answer.
    expect(cache.confirmListed("alpha-thread", thread("alpha-thread", "alpha", { revision: 2 })))
      .toBe(false);
    expect(cache.get("alpha-thread")).toBe(confirmedEntry);
    expect(commits).toBe(1);

    // Strictly newer: adopted, and announced.
    const newer = thread("alpha-thread", "alpha", { revision: 4, runState: { status: "complete" } });
    expect(cache.confirmListed("alpha-thread", newer)).toBe(true);
    expect(cache.get("alpha-thread")?.thread).toBe(newer);
    expect(cache.get("alpha-thread")?.messages).toBe(restored.messages);
    expect(commits).toBe(2);

    // An OLDER row still confirms a restored entry -- the server spoke about
    // this conversation -- and still replaces nothing.
    cache.evict("alpha-thread");
    cache.restore({ thread: running, messages: [message("m1")] });
    const before = commits;
    expect(cache.confirmListed("alpha-thread", thread("alpha-thread", "alpha", { revision: 1 })))
      .toBe(true);
    expect(cache.get("alpha-thread")?.fromDevice).toBe(false);
    expect(cache.get("alpha-thread")?.thread).toBe(running);
    expect(commits).toBe(before + 1);
  });

  it("patches the summary of a conversation it holds and inserts none it does not", () => {
    const cache = createThreadCache();
    cache.upsertFull(detail([]));

    cache.patchThread("alpha-thread", thread("alpha-thread", "alpha", {
      title: "Renamed",
      revision: 2,
    }));
    cache.patchThread("never-held", thread("never-held", "alpha"));

    expect(cache.get("alpha-thread")?.thread.title).toBe("Renamed");
    expect(cache.get("never-held")).toBeUndefined();
  });

  it("keeps the summary the server made later when a delayed answer arrives", () => {
    // A POST answer that lost its race to the event carrying the same row would
    // otherwise roll the cached summary back -- and `detail.thread` is what the
    // console falls back to for a conversation the sidebar does not list.
    const cache = createThreadCache();
    cache.upsertFull(detail([]));
    cache.patchThread("alpha-thread", thread("alpha-thread", "alpha", {
      revision: 3,
      title: "newest",
    }));

    cache.patchThread("alpha-thread", thread("alpha-thread", "alpha", {
      revision: 2,
      title: "delayed",
    }));

    expect(cache.get("alpha-thread")?.thread.revision).toBe(3);
    expect(cache.get("alpha-thread")?.thread.title).toBe("newest");

    // An OPTIMISTIC edit is made at the revision it is patching, so an equal
    // revision still lands.
    cache.patchThread("alpha-thread", thread("alpha-thread", "alpha", {
      revision: 3,
      title: "optimistic",
    }));
    expect(cache.get("alpha-thread")?.thread.title).toBe("optimistic");
  });

  it("tells an unheld conversation apart from an unheld message", () => {
    const cache = createThreadCache();
    cache.upsertFull(detail([message("m1")]));

    // Nothing to apply a delta TO and nothing a message read could land in:
    // the conversation read that is coming owns this.
    expect(cache.applyDelta("never-opened", delta())).toBe("unheld");
    // The conversation IS held, so one message read repairs it.
    expect(cache.applyDelta("alpha-thread", delta({ messageId: "never-loaded" }))).toBe("unknown");
  });

  it("lands a read stale when something changed after it was issued", () => {
    const cache = createThreadCache();
    cache.upsertFull(detail([]), { reset: true });
    const issuedAt = cache.clock();

    cache.markStale("alpha-thread");
    cache.upsertFull(detail([]), { reset: true, issuedAt });

    expect(cache.get("alpha-thread")?.stale).toBe(true);

    // A read issued AFTER the observation answers it.
    cache.upsertFull(detail([]), { reset: true, issuedAt: cache.clock() });
    expect(cache.get("alpha-thread")?.stale).toBe(false);
  });

  it("remembers a change to a conversation it is not holding yet", () => {
    // The cold read of the conversation the operator just opened is on the
    // wire, and a delta for it arrives while it is out. There is nothing to
    // apply it to and nothing a message read could land in, so the observation
    // is all there is -- and it has to outlive the entry not existing.
    const cache = createThreadCache();
    const issuedAt = cache.clock();

    cache.markStale("alpha-thread");
    cache.upsertFull(detail([message("m1")]), { reset: true, issuedAt });

    expect(cache.get("alpha-thread")?.stale).toBe(true);
  });

  it("takes the finish stamp a delta carries onto the message it finishes", () => {
    // The turn's wall-clock window is `createdAt` to `finishedAt`, and the
    // second half used to arrive only in a whole-conversation read.
    const finished = applyMessageDelta(
      message("m1", { status: "running" }),
      delta({ status: "complete", finishedAt: "2026-08-14T08:00:05.000Z" }),
    );

    expect(finished.finishedAt).toBe("2026-08-14T08:00:05.000Z");
    expect(finished.status).toBe("complete");
  });

  it("keeps a finish stamp a later delta says nothing about", () => {
    // Only the write that SETS it carries one, so a delta without one is silent
    // about the stamp rather than clearing it.
    const finished = applyMessageDelta(
      message("m1", { finishedAt: "2026-08-14T08:00:05.000Z", seq: 2 }),
      delta({ baseSeq: 2, seq: 3 }),
    );

    expect(finished.finishedAt).toBe("2026-08-14T08:00:05.000Z");
  });

  it("refuses a frame whose finish stamp is not a stamp", () => {
    expect(readMessageDelta({ ...delta(), finishedAt: 5 })).toBeUndefined();
    expect(readMessageDelta({ ...delta(), finishedAt: "2026-08-14T08:00:05.000Z" }))
      .toMatchObject({ finishedAt: "2026-08-14T08:00:05.000Z" });
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

  it("lets a conditional read confirm what it holds without replacing it", () => {
    // A 304 says the transcript on screen IS current: the entry stands, every
    // object in it keeps its identity, and the suspicion is answered.
    const cache = createThreadCache();
    cache.upsertFull(detail([message("m1")]), { reset: true });
    const held = cache.get("alpha-thread");
    cache.markStale("alpha-thread");
    const issuedAt = cache.clock();

    expect(cache.confirmFresh("alpha-thread", issuedAt)).toBe(true);
    expect(cache.get("alpha-thread")?.stale).toBe(false);
    expect(cache.get("alpha-thread")?.messages).toBe(held?.messages);
    expect(cache.get("alpha-thread")?.thread).toBe(held?.thread);
  });

  it("leaves a conditional read stale when something changed while it was out", () => {
    // The 304 answered the state at the moment it was ISSUED. A write observed
    // after that is one it cannot speak for, so the suspicion stands and the
    // caller reads again.
    const cache = createThreadCache();
    cache.upsertFull(detail([message("m1")]), { reset: true });
    const issuedAt = cache.clock();
    cache.markStale("alpha-thread");

    expect(cache.confirmFresh("alpha-thread", issuedAt)).toBe(false);
    expect(cache.get("alpha-thread")?.stale).toBe(true);
  });

  it("confirms nothing about a conversation it is not holding", () => {
    const cache = createThreadCache();
    expect(cache.confirmFresh("alpha-thread", 0)).toBe(false);
  });

  it("keeps a walked-back transcript whole as the window moves past it", () => {
    // The sequence the console actually performs: open the conversation, page
    // back once, then let a turn finish and re-read. Nothing may disappear from
    // the middle, and the cursor must still reach what is older.
    const at = (hour: string) => `2026-08-14T${hour}:00:00.000Z`;
    const cache = createThreadCache();
    const m1 = message("m1", { createdAt: at("07") });
    const m2 = message("m2", { createdAt: at("08") });
    cache.upsertFull(detail([m1, m2], "cursor-window"), { reset: true });
    cache.prependOlder("alpha-thread", {
      messages: [message("p1", { createdAt: at("05") }), message("p2", { createdAt: at("06") })],
      nextCursor: "cursor-older",
    });

    // The window has moved on: it no longer starts at `m1`.
    cache.upsertFull(
      detail([m2, message("m3", { createdAt: at("09") })], "cursor-window-2"),
      { reset: true },
    );

    const entry = cache.get("alpha-thread");
    expect(entry?.messages.map((item) => item.id)).toEqual(["p1", "p2", "m1", "m2", "m3"]);
    expect(entry?.messagesNextCursor).toBe("cursor-older");
  });

  it("keeps the version it holds when an ordinary answer is behind it", () => {
    // What a live-input receipt is: an ordinary projection of a row this tab
    // may already hold a newer version of, because a repair can land while the
    // receipt is on the wire. It used to be written with `replace`, which
    // forced it over that repair and walked the transcript backwards.
    const cache = createThreadCache();
    cache.upsertFull(detail([
      message("m1", { seq: 5, parts: [{ type: "text", text: "repaired" }] }),
    ]));

    const changed = cache.upsertMessage(
      "alpha-thread",
      message("m1", { seq: 4, parts: [{ type: "text", text: "receipt" }] }),
    );

    expect(changed).toBe(false);
    expect(cache.get("alpha-thread")?.messages[0]?.parts)
      .toEqual([{ type: "text", text: "repaired" }]);

    // `replace` is still what an answer that is authoritative WITHOUT being
    // newer needs -- the cron activity read.
    expect(cache.upsertMessage(
      "alpha-thread",
      message("m1", { seq: 4, parts: [{ type: "text", text: "activity" }] }),
      { replace: true },
    )).toBe(true);
    expect(cache.get("alpha-thread")?.messages[0]?.parts)
      .toEqual([{ type: "text", text: "activity" }]);
  });

  it("forgets a conversation on request", () => {
    const cache = createThreadCache();
    cache.upsertFull(detail([]));

    cache.evict("alpha-thread");

    expect(cache.get("alpha-thread")).toBeUndefined();
  });

  it("hands out everything it holds, least recently used first", () => {
    const cache = createThreadCache();
    cache.upsertFull(detail([message("m1")]));
    cache.upsertFull({ thread: thread("beta-thread", "alpha"), messages: [message("m2")] });
    cache.touch("alpha-thread");

    expect(cache.snapshot().map((entry) => entry.thread.id)).toEqual([
      "beta-thread",
      "alpha-thread",
    ]);
    expect(cache.snapshot()[1]).toBe(cache.get("alpha-thread"));
  });

  it("restores a stored conversation, and never as one that can be trusted", () => {
    const cache = createThreadCache();

    cache.restore({
      thread: thread("alpha-thread", "alpha"),
      messages: [message("m1")],
      messagesNextCursor: "cursor-older",
      etag: 'W/"alpha-1"',
      repairedToolCallIds: new Set(["call-1"]),
      pagedInIds: new Set(["m1"]),
    });

    const entry = cache.get("alpha-thread");
    expect(entry?.messages.map((item) => item.id)).toEqual(["m1"]);
    expect(entry?.messagesNextCursor).toBe("cursor-older");
    expect(entry?.etag).toBe('W/"alpha-1"');
    expect(entry?.repairedToolCallIds.has("call-1")).toBe(true);
    expect(entry?.pagedInIds.has("m1")).toBe(true);
    // The whole point: a transcript from a previous visit has missed an
    // unbounded window, so it is on screen but never current.
    expect(entry?.stale).toBe(true);
  });

  it("keeps the conversation on screen when the operator clears what is kept", () => {
    const cache = createThreadCache();
    cache.upsertFull(detail([message("m1")]));
    cache.upsertFull({ thread: thread("beta-thread", "alpha"), messages: [message("m2")] });

    cache.clear("alpha-thread");

    expect(cache.get("alpha-thread")?.messages.map((item) => item.id)).toEqual(["m1"]);
    expect(cache.get("beta-thread")).toBeUndefined();
    cache.clear();
    expect(cache.snapshot()).toEqual([]);
  });

  it("tells its owner about every change to a transcript, and about nothing else", () => {
    const commits: number[] = [];
    let commitCount = 0;
    const cache = createThreadCache(8, () => 0, () => { commits.push(++commitCount); });

    cache.upsertFull(detail([message("m1")]));
    const afterRead = commitCount;
    cache.applyDelta("alpha-thread", delta({ ops: [] }));
    const afterDelta = commitCount;
    cache.markStale("alpha-thread");
    cache.markAllStale();
    cache.confirmFresh("alpha-thread", cache.clock());
    const afterSuspicion = commitCount;
    cache.evict("alpha-thread");

    expect(afterRead).toBe(1);
    expect(afterDelta).toBe(2);
    // Staleness is not content and is never restored from the device, so a
    // reconnect that stales all eight must not rewrite all eight.
    expect(afterSuspicion).toBe(2);
    expect(commitCount).toBe(3);
  });
});
