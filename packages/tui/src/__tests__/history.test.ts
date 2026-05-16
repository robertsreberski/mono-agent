import { describe, expect, it, vi } from "vitest";

import { createInMemoryTuiHistory } from "../agent/history.js";
import type { TuiHistoryMessage } from "../agent/history.js";

function message(
  overrides: Partial<TuiHistoryMessage> & Pick<TuiHistoryMessage, "id">,
): TuiHistoryMessage {
  return {
    role: "user",
    text: "hello",
    timestamp: 0,
    ...overrides,
  };
}

describe("createInMemoryTuiHistory", () => {
  it("appends and lists messages in insertion order", () => {
    const store = createInMemoryTuiHistory();
    store.append(message({ id: "1" }));
    store.append(message({ id: "2", role: "assistant", text: "hi" }));
    expect(store.list().map((m) => m.id)).toEqual(["1", "2"]);
  });

  it("trims to maxMessages, dropping oldest first", () => {
    const store = createInMemoryTuiHistory({ maxMessages: 2 });
    store.append(message({ id: "1" }));
    store.append(message({ id: "2" }));
    store.append(message({ id: "3" }));
    expect(store.list().map((m) => m.id)).toEqual(["2", "3"]);
  });

  it("removes a message by id and is a no-op when absent", () => {
    const store = createInMemoryTuiHistory();
    store.append(message({ id: "1" }));
    store.append(message({ id: "2" }));
    store.remove("missing");
    expect(store.list()).toHaveLength(2);
    store.remove("1");
    expect(store.list().map((m) => m.id)).toEqual(["2"]);
  });

  it("clears all messages", () => {
    const store = createInMemoryTuiHistory();
    store.append(message({ id: "1" }));
    store.clear();
    expect(store.list()).toHaveLength(0);
  });

  it("notifies subscribers on append/remove/clear and supports unsubscribe", () => {
    const store = createInMemoryTuiHistory();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.append(message({ id: "1" }));
    store.remove("1");
    store.append(message({ id: "2" }));
    store.clear();
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
    store.append(message({ id: "3" }));
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("does not notify when remove targets an unknown id or clear runs on an empty store", () => {
    const store = createInMemoryTuiHistory();
    const listener = vi.fn();
    store.subscribe(listener);
    store.remove("missing");
    store.clear();
    expect(listener).not.toHaveBeenCalled();
  });

  it("isolates listener errors so one bad subscriber does not break others", () => {
    const store = createInMemoryTuiHistory();
    const noisy = vi.fn(() => {
      throw new Error("nope");
    });
    const quiet = vi.fn();
    store.subscribe(noisy);
    store.subscribe(quiet);
    store.append(message({ id: "1" }));
    expect(noisy).toHaveBeenCalledOnce();
    expect(quiet).toHaveBeenCalledOnce();
  });

  it("rejects an invalid maxMessages", () => {
    expect(() => createInMemoryTuiHistory({ maxMessages: 0 })).toThrow(RangeError);
    expect(() => createInMemoryTuiHistory({ maxMessages: 1.5 })).toThrow(RangeError);
  });
});
