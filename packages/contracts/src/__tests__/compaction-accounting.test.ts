import { expect, it } from "vitest";
import { isAgentCompactionAccounting } from "../compaction-accounting.js";
const receipt = { version: 2, usageIncluded: false, requests: [{ requestId: "fictional:1", model: "faux:model", status: "rejected", input: 10, output: 20, cacheRead: 0, cacheWrite: 0, costUsd: null }] };
it("validates bounded metadata-only manual billing receipts", () => {
  expect(isAgentCompactionAccounting(receipt)).toBe(true);
  expect(isAgentCompactionAccounting({ ...receipt, requests: Array(3).fill(receipt.requests[0]) })).toBe(false);
  expect(isAgentCompactionAccounting({ ...receipt, requests: [{ ...receipt.requests[0], input: -1 }] })).toBe(false);
  expect(isAgentCompactionAccounting({ ...receipt, requests: [{ ...receipt.requests[0], summary: "untrusted prose" }] })).toBe(false);
});
