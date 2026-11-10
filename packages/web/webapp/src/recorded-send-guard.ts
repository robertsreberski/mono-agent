import { api, ApiError } from "./api";

/** Only an authoritative receipt (or its explicit absence) can retire an identity. */
export async function recordedSubmissionOutcome(threadId: string | null, submissionId: string, failure?: unknown): Promise<"accepted" | "not-accepted" | "unknown"> {
  if (failure instanceof ApiError && failure.code === "submission_rejected") return "not-accepted";
  if (!threadId) return "unknown";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const receipt = await Promise.race([api.submission(threadId, submissionId), new Promise<undefined>(resolve => {
      timeout = setTimeout(() => resolve(undefined), 10_000);
    })]);
    if (receipt?.threadId !== threadId || receipt.submissionId !== submissionId) return "unknown";
    if (receipt.outcome === "turn" || receipt.outcome === "live-input") return "accepted";
    return receipt.outcome === "rejected" ? "not-accepted" : "unknown";
  } catch (error) {
    return error instanceof ApiError && error.status === 404 && error.code === "submission_not_found" ? "not-accepted" : "unknown";
  } finally { clearTimeout(timeout); }
}

/** Do not wait behind another tab or mutate its uploads. Legacy browsers stay session-local. */
export async function withRecordedSendLock(submissionId: string, work: () => Promise<void>): Promise<boolean> {
  if (!navigator.locks?.request) { await work(); return true; }
  return navigator.locks.request(`mono-recorded:${submissionId}`, { ifAvailable: true }, async lock => {
    if (!lock) return false;
    await work(); return true;
  });
}
