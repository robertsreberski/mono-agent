import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, api } from "../api";
import type { MemoryOperation } from "../types";
import {
  memoryActionKey,
  memoryWorkspaceError,
  pollMemoryOperation,
} from "./MemoryWorkspace";

const operation = (
  status: MemoryOperation["status"],
  overrides: Partial<MemoryOperation> = {},
): MemoryOperation => ({
  id: "operation/exact",
  action: "edit",
  recordId: "record-one",
  status,
  createdAt: "2026-08-24T10:00:00.000Z",
  updatedAt: "2026-08-24T10:00:01.000Z",
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("memory operation polling", () => {
  it("polls the exact operation id with capped exponential intervals until terminal", async () => {
    vi.useFakeTimers();
    const states = [
      operation("draining", { id: "unexpected-receipt-id" }),
      operation("applying"),
      operation("applying"),
      operation("applying"),
      operation("applying"),
      operation("succeeded", { resultRecordId: "record-two" }),
    ];
    const poll = vi.spyOn(api, "memoryOperation").mockImplementation(async () => states.shift()!);
    const onUpdate = vi.fn();
    const controller = new AbortController();
    const result = pollMemoryOperation("agent/source", operation("queued"), controller.signal, onUpdate);

    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 10_000, 10_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(poll).toHaveBeenCalledTimes(index);
      await vi.advanceTimersByTimeAsync(1);
      expect(poll).toHaveBeenCalledTimes(index + 1);
      expect(poll).toHaveBeenLastCalledWith("agent/source", "operation/exact", controller.signal);
    }

    await expect(result).resolves.toMatchObject({
      id: "operation/exact",
      status: "succeeded",
      resultRecordId: "record-two",
    });
    expect(onUpdate.mock.calls.map(([receipt]) => receipt.status)).toEqual([
      "draining",
      "applying",
      "applying",
      "applying",
      "applying",
      "succeeded",
    ]);
  });

  it("retries transient network and unavailable responses but publishes later receipts", async () => {
    vi.useFakeTimers();
    const poll = vi.spyOn(api, "memoryOperation")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new ApiError("bad gateway", 502, "unavailable"))
      .mockResolvedValueOnce(operation("applying"))
      .mockResolvedValueOnce(operation("succeeded", { resultRecordId: "record-two" }));
    const onUpdate = vi.fn();
    const controller = new AbortController();
    const result = pollMemoryOperation("alpha", operation("queued"), controller.signal, onUpdate);

    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    await expect(result).resolves.toMatchObject({ status: "succeeded" });
    expect(poll).toHaveBeenCalledTimes(4);
    expect(onUpdate.mock.calls.map(([receipt]) => receipt.status)).toEqual(["applying", "succeeded"]);
  });

  it("stops polling on a stable operation error", async () => {
    vi.useFakeTimers();
    const poll = vi.spyOn(api, "memoryOperation")
      .mockRejectedValue(new ApiError("gone", 404, "not_found"));
    const controller = new AbortController();
    const result = pollMemoryOperation("alpha", operation("queued"), controller.signal)
      .then(() => undefined, (error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toMatchObject({ status: 404, code: "not_found" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight polling lifetime without issuing another request", async () => {
    vi.useFakeTimers();
    const poll = vi.spyOn(api, "memoryOperation").mockResolvedValue(operation("applying"));
    const controller = new AbortController();
    const result = pollMemoryOperation("alpha", operation("queued"), controller.signal)
      .then(() => undefined, (error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(poll).toHaveBeenCalledTimes(1);
    controller.abort();
    const rejection = await result;
    expect(rejection).toMatchObject({ name: "AbortError" });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});

describe("memory action keys and safe errors", () => {
  it("uses getRandomValues when randomUUID is unavailable and stays inside the operator allowlist", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.forEach((_value, index) => { bytes[index] = index; });
        return bytes;
      },
    });

    const key = memoryActionKey();

    expect(key).toBe("memory-000102030405060708090a0b0c0d0e0f1011121314151617");
    expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/u);
  });

  it.each([
    ["memory_offline", 409, "This agent is offline"],
    ["memory_unsupported", 404, "does not expose a live memory operator"],
    ["agent_not_found", 404, "does not match a discovered agent"],
  ])("maps %s to a distinct fixed owner-facing state", (code, status, expected) => {
    expect(memoryWorkspaceError(new ApiError("raw provider path /private/data", status, code), "fallback"))
      .toContain(expected);
  });
});
