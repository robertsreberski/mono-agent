import { afterEach, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";
import { canRenewRecordedSubmission, recordedSubmissionOutcome, withRecordedSendLock } from "./recorded-send-guard";
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), api: { submission: vi.fn() } }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it.each([401, 403, 409])("does not retire an identity on HTTP %s when the receipt is unavailable", async status => {
  vi.mocked(api.submission).mockRejectedValue(new ApiError("Synthetic receipt unavailable", status, "web_service_stopping"));
  expect(await recordedSubmissionOutcome("synthetic-thread", "synthetic-attempt")).toBe("unknown");
});
it("treats GET 404 and rejected GET receipts as unknown, not permission to mint an identity", async () => {
  vi.mocked(api.submission).mockRejectedValueOnce(new ApiError("Missing thread", 404, "thread_not_found"));
  expect(await recordedSubmissionOutcome("synthetic-thread", "synthetic-attempt")).toBe("unknown");
  vi.mocked(api.submission).mockRejectedValueOnce(new ApiError("Missing submission", 404, "submission_not_found"));
  expect(await recordedSubmissionOutcome("synthetic-thread", "synthetic-attempt")).toBe("unknown");
  vi.mocked(api.submission).mockResolvedValueOnce({ threadId: "synthetic-thread", submissionId: "synthetic-attempt", outcome: "rejected" });
  expect(await recordedSubmissionOutcome("synthetic-thread", "synthetic-attempt")).toBe("unknown");
});
it("renews only after a definitive re-POST answer from the post-lookup boundary", () => {
  for (const [status, code] of [[401, "unauthorized"], [409, "compaction_busy"], [409, "web_service_stopping"], [404, "submission_not_found"], [404, "thread_not_found"], [409, "attachment_unavailable"]] as const) {
    expect(canRenewRecordedSubmission(new ApiError("Synthetic response", status, code), true)).toBe(false);
  }
  for (const [status, code] of [[409, "submission_rejected"], [404, "attachment_not_found"]] as const) {
    const answer = new ApiError("Synthetic post-lookup response", status, code);
    expect(canRenewRecordedSubmission(answer, false)).toBe(false);
    expect(canRenewRecordedSubmission(answer, true)).toBe(true);
  }
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
