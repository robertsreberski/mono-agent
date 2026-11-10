import { api, ApiError } from "./api";

/** GET can confirm acceptance, never prove that an in-flight POST will not land. */
export async function recordedSubmissionOutcome(threadId: string | null, submissionId: string): Promise<"accepted" | "unknown"> {
  if (!threadId) return "unknown";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const receipt = await Promise.race([api.submission(threadId, submissionId), new Promise<undefined>(resolve => {
      timeout = setTimeout(() => resolve(undefined), 10_000);
    })]);
    if (receipt?.threadId !== threadId || receipt.submissionId !== submissionId) return "unknown";
    if (receipt.outcome === "turn" || receipt.outcome === "live-input") return "accepted";
    return "unknown";
  } catch {
    return "unknown";
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

/** Only a settled re-POST can replace an uncertain identity. Server submit does
 * the existing-UUID lookup before beginTurn's permanent attachment_not_found.
 * Transient pre-lookup/admission errors and missing GET receipts prove nothing. */
export function canRenewRecordedSubmission(failure: unknown, reposted: boolean): boolean {
  return reposted && failure instanceof ApiError && (
    failure.status === 409 && failure.code === "submission_rejected"
    || failure.status === 404 && failure.code === "attachment_not_found"
  );
}
