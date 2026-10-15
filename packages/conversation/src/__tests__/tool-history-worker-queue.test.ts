import { describe, expect, it } from "vitest";

import { continueToolHistoryOperationTail } from "../tool-history-worker-queue.js";

describe("tool-history worker operation queue", () => {
  it("fulfills the tail after a response failure so later operations still run", async () => {
    const order: string[] = [];
    let tail = Promise.resolve();
    tail = continueToolHistoryOperationTail(tail, () => {
      order.push("failed-response");
      throw new Error("postMessage failed after the database operation");
    });
    await expect(tail).resolves.toBeUndefined();

    tail = continueToolHistoryOperationTail(tail, () => {
      order.push("later-close");
    });
    await expect(tail).resolves.toBeUndefined();
    expect(order).toEqual(["failed-response", "later-close"]);
  });
});
