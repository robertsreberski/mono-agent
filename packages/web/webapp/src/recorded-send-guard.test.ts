import { afterEach, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";
import { recordedSubmissionOutcome, withRecordedSendLock } from "./recorded-send-guard";
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), api: { submission: vi.fn() } }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it.each([401, 403, 409])("does not retire an identity on HTTP %s when the receipt is unavailable", async status => {
  vi.mocked(api.submission).mockRejectedValue(new ApiError("Synthetic receipt unavailable", status, "web_service_stopping"));
  expect(await recordedSubmissionOutcome("synthetic-thread", "synthetic-attempt", new ApiError("Synthetic admission error", status, "compaction_busy"))).toBe("unknown");
});
it("requires an explicit missing or rejected receipt before changing identity", async () => {
  vi.mocked(api.submission).mockRejectedValueOnce(new ApiError("Missing thread", 404, "thread_not_found"));
  expect(await recordedSubmissionOutcome("synthetic-thread", "synthetic-attempt")).toBe("unknown");
  vi.mocked(api.submission).mockRejectedValueOnce(new ApiError("Missing submission", 404, "submission_not_found"));
  expect(await recordedSubmissionOutcome("synthetic-thread", "synthetic-attempt")).toBe("not-accepted");
  expect(await recordedSubmissionOutcome("synthetic-thread", "synthetic-attempt", new ApiError("Rejected receipt", 409, "submission_rejected"))).toBe("not-accepted");
});
it.each(["turn", "live-input"] as const)("recognizes an accepted %s receipt", async outcome => {
  vi.mocked(api.submission).mockResolvedValue({ threadId: "synthetic-thread", submissionId: "synthetic-attempt", outcome });
  expect(await recordedSubmissionOutcome("synthetic-thread", "synthetic-attempt")).toBe("accepted");
});
it("does not run Retry/restage when another window owns the lock", async () => {
  const request = vi.fn(async (_name, _options, callback) => callback(null));
  vi.stubGlobal("navigator", { locks: { request } });
  const work = vi.fn();
  expect(await withRecordedSendLock("synthetic-attempt", work)).toBe(false);
  expect(work).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledWith("mono-recorded:synthetic-attempt", { ifAvailable: true }, expect.any(Function));
});
it("holds the acquired lock through asynchronous send and falls back without the API", async () => {
  let held = false;
  vi.stubGlobal("navigator", { locks: { request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<boolean>) => {
    held = true; try { return await callback({}); } finally { held = false; }
  } } });
  expect(await withRecordedSendLock("synthetic-attempt", async () => { await Promise.resolve(); expect(held).toBe(true); })).toBe(true);
  expect(held).toBe(false);
  vi.stubGlobal("navigator", {});
  const work = vi.fn(async () => {});
  expect(await withRecordedSendLock("synthetic-attempt", work)).toBe(true); expect(work).toHaveBeenCalledOnce();
});

it("keeps a hung receipt lookup uncertain instead of blocking recovered drafts forever", async () => {
  vi.useFakeTimers();
  vi.mocked(api.submission).mockImplementation(() => new Promise(() => {}));
  const lookup = recordedSubmissionOutcome("synthetic-thread", "synthetic-attempt");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await lookup).toBe("unknown");
});
