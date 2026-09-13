import { describe, expect, it, vi } from "vitest";

import { instrumentLiveInputAppliedEvents } from "../../ai/runtime/live-input-events.js";

function replayableLiveInput(messages, hooks = {}) {
  let generation = 0;
  return {
    [Symbol.asyncIterator]() {
      const values = typeof messages === "function" ? messages(generation) : messages;
      generation += 1;
      let cursor = 0;
      return {
        async next() {
          return cursor < values.length
            ? { done: false, value: values[cursor++] }
            : { done: true, value: undefined };
        },
        async return() {
          hooks.onReturn?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

describe("instrumentLiveInputAppliedEvents", () => {
  it("emits applied only after exact recorded host confirmation and keeps telemetry metadata-only", async () => {
    const acknowledge = vi.fn(() => "recorded");
    const events = [];
    const source = replayableLiveInput([{
      body: "full private guidance",
      id: "follow-up-1",
      receivedAt: "2026-07-22T08:30:00.000Z",
      acknowledge,
    }]);
    const item = await instrumentLiveInputAppliedEvents(source, (event) => events.push(event))
      [Symbol.asyncIterator]().next();

    expect(item.value.acknowledge({ providerEntryId: "entry-1", providerRunId: "run-1" })).toBe("recorded");
    expect(item.value.acknowledge({ providerEntryId: "entry-1", providerRunId: "run-1" })).toBe("ignored");

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual([
      "live_input_consumed",
      "live_input_applied",
      "live_input_consumed",
    ]);
    expect(events[2]).toMatchObject({ late: true });
    for (const event of events) {
      expect(event).not.toHaveProperty("body");
      expect(event).not.toHaveProperty("text");
    }
  });

  it.each([
    ["void", () => undefined, "unconfirmed"],
    ["ignored", () => "ignored", "ignored"],
    ["throw", () => { throw new Error("private callback failure"); }, "threw"],
    ["thenable", () => Promise.resolve("recorded"), "unconfirmed"],
  ])("does not manufacture applied when acknowledgement returns %s", async (_label, acknowledge, disposition) => {
    const events = [];
    const stream = instrumentLiveInputAppliedEvents(
      replayableLiveInput([{ body: "secret", id: "one", acknowledge }]),
      (event) => events.push(event),
    );
    const item = await stream[Symbol.asyncIterator]().next();
    item.value.acknowledge();
    expect(events).toEqual([
      { type: "live_input_consumed", inputId: "one" },
      {
        type: "live_input_settlement_unconfirmed",
        inputId: "one",
        phase: "consumed",
        settlementDisposition: disposition,
      },
    ]);
  });

  it("replays only the first stable-id owner after a safe rejection", async () => {
    const firstLogicalOwner = {};
    const duplicateLogicalOwner = {};
    const ownerReject = vi.fn(() => "recorded");
    const ownerAcknowledge = vi.fn(() => "recorded");
    const duplicateAcknowledge = vi.fn(() => "recorded");
    const events = [];
    const stream = instrumentLiveInputAppliedEvents(replayableLiveInput((generation) => [{
      body: generation === 0 ? "original" : "invalid duplicate body",
      id: "same",
      logicalOwner: generation === 0 ? firstLogicalOwner : duplicateLogicalOwner,
      reject: generation === 0 ? ownerReject : vi.fn(),
      acknowledge: generation === 0 ? ownerAcknowledge : duplicateAcknowledge,
    }]), (event) => events.push(event));

    const first = await stream[Symbol.asyncIterator]().next();
    expect(first.value.reject(new Error("safe"))).toBe("recorded");
    const replay = await stream[Symbol.asyncIterator]().next();
    expect(replay.value.body).toBe("original");
    expect(replay.value.acknowledge()).toBe("recorded");

    expect(ownerReject).toHaveBeenCalledTimes(1);
    expect(ownerAcknowledge).toHaveBeenCalledTimes(1);
    expect(duplicateAcknowledge).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "live_input_duplicate_suppressed")).toBe(true);
  });

  it("refreshes only same-owner callbacks while preserving immutable message fields", async () => {
    const logicalOwner = {};
    const originalReceivedAt = "2026-09-07T10:00:00.000Z";
    const replacementReceivedAt = "2026-09-07T11:00:00.000Z";
    const originalAccepted = vi.fn(() => "recorded");
    const originalReject = vi.fn(() => "recorded");
    const originalAcknowledge = vi.fn(() => "recorded");
    const freshAccepted = vi.fn(function () {
      expect(this.body).toBe("invalid replacement body");
      return "recorded";
    });
    const freshAcknowledge = vi.fn(function () {
      expect(this.receivedAt).toBe(replacementReceivedAt);
      return "recorded";
    });
    const events = [];
    const stream = instrumentLiveInputAppliedEvents(replayableLiveInput((generation) => [{
      body: generation === 0 ? "original body" : "invalid replacement body",
      id: "same-owner",
      receivedAt: generation === 0 ? originalReceivedAt : replacementReceivedAt,
      logicalOwner,
      accepted: generation === 0 ? originalAccepted : freshAccepted,
      reject: generation === 0 ? originalReject : vi.fn(),
      acknowledge: generation === 0 ? originalAcknowledge : freshAcknowledge,
    }]), (event) => events.push(event));

    const first = await stream[Symbol.asyncIterator]().next();
    expect(first.value.accepted({ providerEntryId: "entry-1" })).toBe("recorded");
    expect(first.value.reject({ code: "native_queue_removed" })).toBe("recorded");

    const replay = await stream[Symbol.asyncIterator]().next();
    expect(replay.value).toMatchObject({
      body: "original body",
      id: "same-owner",
      receivedAt: originalReceivedAt,
      logicalOwner,
    });
    expect(first.value.acknowledge({ providerEntryId: "stale" })).toBe("ignored");
    expect(replay.value.accepted({ providerEntryId: "entry-2" })).toBe("recorded");
    expect(replay.value.acknowledge({ providerEntryId: "entry-2", providerRunId: "run-2" }))
      .toBe("recorded");

    expect(originalAccepted).toHaveBeenCalledTimes(1);
    expect(originalReject).toHaveBeenCalledTimes(1);
    expect(originalAcknowledge).not.toHaveBeenCalled();
    expect(freshAccepted).toHaveBeenCalledTimes(1);
    expect(freshAcknowledge).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "live_input_duplicate_suppressed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "live_input_applied")).toHaveLength(1);
    const eventsWithReceivedAt = events.filter((event) => event.receivedAt !== undefined);
    expect(eventsWithReceivedAt).toHaveLength(5);
    expect(eventsWithReceivedAt.every((event) => event.receivedAt === originalReceivedAt)).toBe(true);
    for (const event of events) {
      expect(event).not.toHaveProperty("body");
      expect(event).not.toHaveProperty("text");
    }
  });

  it("keeps a legacy void safe rejection replayable", async () => {
    const acknowledge = vi.fn(() => "recorded");
    const stream = instrumentLiveInputAppliedEvents(
      replayableLiveInput([{ body: "guide", id: "one", reject: () => undefined, acknowledge }]),
      vi.fn(),
    );
    const first = await stream[Symbol.asyncIterator]().next();
    expect(first.value.reject({ code: "native_queue_removed" })).toBeUndefined();
    const replay = await stream[Symbol.asyncIterator]().next();
    expect(replay.value.body).toBe("guide");
    expect(replay.value.acknowledge()).toBe("recorded");
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it.each(["leased", "native_accepted", "consumed", "uncertain"])(
    "suppresses duplicate callback owners while the first owner is %s",
    async (phase) => {
      const duplicateCallback = vi.fn();
      const events = [];
      const stream = instrumentLiveInputAppliedEvents(replayableLiveInput([
        {
          body: "owner",
          id: "same",
          accepted: () => "recorded",
          acknowledge: () => "recorded",
          uncertain: () => "recorded",
        },
        { body: "duplicate", id: "same", acknowledge: duplicateCallback },
      ]), (event) => events.push(event));
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (phase === "native_accepted") first.value.accepted();
      if (phase === "consumed") first.value.acknowledge();
      if (phase === "uncertain") first.value.uncertain({ reason: "delivery_uncertain" });
      expect((await iterator.next()).done).toBe(true);
      expect(duplicateCallback).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type === "live_input_duplicate_suppressed")).toHaveLength(1);
    },
  );

  it("never replays anonymous values but still exposes identified values in later generations", async () => {
    const events = [];
    const source = replayableLiveInput([
      { body: "anonymous one" },
      { body: "anonymous two" },
      { body: "identified", id: "identified" },
    ]);
    const stream = instrumentLiveInputAppliedEvents(source, (event) => events.push(event));
    const first = stream[Symbol.asyncIterator]();
    expect((await first.next()).value.body).toBe("anonymous one");
    expect((await first.next()).value.body).toBe("anonymous two");
    const identified = await first.next();
    identified.value.reject(new Error("safe"));

    const replay = stream[Symbol.asyncIterator]();
    expect((await replay.next()).value.body).toBe("identified");
    expect((await replay.next()).done).toBe(true);
    expect(events.filter((event) => event.reason === "anonymous_identity")).toHaveLength(2);
  });

  it("converts post-acceptance rejection without proved removal into uncertainty", async () => {
    const reject = vi.fn();
    const uncertain = vi.fn(() => "recorded");
    const events = [];
    const stream = instrumentLiveInputAppliedEvents(
      replayableLiveInput([{ body: "guide", id: "one", reject, uncertain }]),
      (event) => events.push(event),
    );
    const item = await stream[Symbol.asyncIterator]().next();
    item.value.accepted({ providerEntryId: "entry" });
    expect(item.value.reject(new Error("unknown native state"))).toBe("recorded");
    expect(reject).not.toHaveBeenCalled();
    expect(uncertain).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({
      type: "live_input_uncertain",
      inputId: "one",
      reason: "delivery_uncertain",
      settlementDisposition: "recorded",
    });
  });

  it("prevents a stale attempt callback from settling a replayed owner", async () => {
    const acknowledge = vi.fn(() => "recorded");
    const stream = instrumentLiveInputAppliedEvents(
      replayableLiveInput([{ body: "guide", id: "one", reject: () => "recorded", acknowledge }]),
      vi.fn(),
    );
    const first = await stream[Symbol.asyncIterator]().next();
    first.value.reject(new Error("safe"));
    const replay = await stream[Symbol.asyncIterator]().next();
    expect(first.value.acknowledge()).toBe("ignored");
    expect(replay.value.acknowledge()).toBe("recorded");
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it("does not reopen replay when the host says a safe rejection was ignored", async () => {
    const reject = vi.fn(() => "ignored");
    const stream = instrumentLiveInputAppliedEvents(
      replayableLiveInput([{ body: "guide", id: "one", reject }]),
      vi.fn(),
    );
    const first = await stream[Symbol.asyncIterator]().next();
    expect(first.value.reject({ code: "native_queue_removed" })).toBe("ignored");

    await expect(stream[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(reject).toHaveBeenCalledTimes(1);
  });

  it("delegates iterator teardown and does not replace an already-instrumented stream", async () => {
    const onReturn = vi.fn();
    const source = replayableLiveInput([{ body: "guide" }], { onReturn });
    const first = instrumentLiveInputAppliedEvents(source, vi.fn());
    expect(instrumentLiveInputAppliedEvents(first, vi.fn())).toBe(first);
    const iterator = first[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return();
    expect(onReturn).toHaveBeenCalledTimes(1);
  });
});
