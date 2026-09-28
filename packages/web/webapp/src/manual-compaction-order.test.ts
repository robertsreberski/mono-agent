import { describe, expect, it } from "vitest";
import { thread } from "./test/fixtures";
import { createManualCompactionOrder } from "./manual-compaction-order";

const running = thread("garden", "alpha", { compaction: {
  status: "running", trigger: "manual", startedAt: "2026-09-28T10:00:00Z",
} });

describe("console compaction ordering", () => {
  it("fences equal-revision late detail and listing rows after a clear without a result", () => {
    const order = createManualCompactionOrder();
    expect(order.accept(running).compaction?.status).toBe("running");
    expect(order.accept({ ...running, compaction: undefined }).compaction).toBeUndefined();
    expect(order.accept(running).compaction).toBeUndefined();
    expect(order.accept({ ...running, revision: running.revision + 1 }).compaction).toBeUndefined();
    const next = { ...running, compaction: { ...running.compaction!, startedAt: "2026-09-28T10:10:00Z" } };
    expect(order.accept(next).compaction?.startedAt).toBe(next.compaction.startedAt);
  });
  it("clears on the persisted result but does not confuse an older result with this run", () => {
    const order = createManualCompactionOrder();
    order.accept(running);
    expect(order.clear(running.id, Date.parse("2026-09-28T09:59:00Z"))).toBe(false);
    expect(order.accept(running).compaction).toBeDefined();
    expect(order.clear(running.id, Date.parse("2026-09-28T10:00:01Z"))).toBe(true);
    expect(order.accept(running).compaction).toBeUndefined();
  });
});
