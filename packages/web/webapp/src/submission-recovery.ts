export interface SubmissionRecoveryReference {
  readonly threadId: string;
  readonly submissionId: string;
}

const STORAGE_KEY = "mono-agent.web.pending-submissions";

const isReference = (value: unknown): value is SubmissionRecoveryReference => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.threadId === "string"
    && candidate.threadId.length > 0
    && candidate.threadId.length <= 4_096
    && typeof candidate.submissionId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate.submissionId);
};

export function readSubmissionRecoveryReferences(storage: Storage): SubmissionRecoveryReference[] {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new TypeError("Invalid recovery references.");
    const unique = new Map<string, SubmissionRecoveryReference>();
    for (const value of parsed) {
      if (!isReference(value)) throw new TypeError("Invalid recovery reference.");
      unique.set(`${value.threadId}\0${value.submissionId}`, value);
    }
    return [...unique.values()];
  } catch {
    storage.removeItem(STORAGE_KEY);
    return [];
  }
}

export function rememberSubmissionRecoveryReference(
  storage: Storage,
  reference: SubmissionRecoveryReference,
): void {
  const references = readSubmissionRecoveryReferences(storage).filter((candidate) =>
    candidate.threadId !== reference.threadId || candidate.submissionId !== reference.submissionId);
  references.push(reference);
  storage.setItem(STORAGE_KEY, JSON.stringify(references));
}

export function forgetSubmissionRecoveryReference(
  storage: Storage,
  reference: SubmissionRecoveryReference,
): void {
  const references = readSubmissionRecoveryReferences(storage).filter((candidate) =>
    candidate.threadId !== reference.threadId || candidate.submissionId !== reference.submissionId);
  if (references.length === 0) storage.removeItem(STORAGE_KEY);
  else storage.setItem(STORAGE_KEY, JSON.stringify(references));
}
