/**
 * Unsent prompt text is deliberately tab-memory-only. A reload destroys the
 * assistant-ui runtime and this registry together; persisting authored prompts
 * would create a new browser-storage and privacy contract.
 *
 * Text is keyed by agent and conversation because only one composer is visible
 * at a time, while every conversation the operator visits may have an unfinished
 * thought. Attachments stay owned by the visible assistant-ui runtime: switching
 * context disposes their upload reservations instead of retaining them here.
 */
const textDrafts = new Map<string, string>();
let visibleAttachments = false;

export const composerDraftKey = (
  sourceId: string | null,
  threadId: string | null,
): string | null => sourceId === null ? null : JSON.stringify([sourceId, threadId]);

/** The exact text last observed for this agent/conversation context. */
export const readComposerDraft = (
  sourceId: string | null,
  threadId: string | null,
): string => {
  const key = composerDraftKey(sourceId, threadId);
  return key === null ? "" : textDrafts.get(key) ?? "";
};

/** Mirror exact text, pruning whitespace-only entries from the registry. */
export const writeComposerDraft = (
  sourceId: string | null,
  threadId: string | null,
  text: string,
): void => {
  const key = composerDraftKey(sourceId, threadId);
  if (key === null) return;
  if (text.trim().length === 0) textDrafts.delete(key);
  else textDrafts.set(key, text);
};

/** Move the new-conversation bucket onto the exact thread the server created. */
export const transferComposerDraft = (
  sourceId: string,
  fromThreadId: string | null,
  toThreadId: string,
): void => {
  const from = composerDraftKey(sourceId, fromThreadId);
  const to = composerDraftKey(sourceId, toThreadId);
  if (from === null || to === null || from === to) return;
  const text = textDrafts.get(from);
  textDrafts.delete(from);
  if (text !== undefined) textDrafts.set(to, text);
};

/** Forget prompt text only once deletion is authoritative. */
export const forgetComposerDraft = (
  sourceId: string,
  threadId: string,
): void => {
  const key = composerDraftKey(sourceId, threadId);
  if (key !== null) textDrafts.delete(key);
};

/** Attachments are not restorable, but still make a service-worker reload unsafe. */
export const noteComposerAttachments = (hasAttachments: boolean): void => {
  visibleAttachments = hasAttachments;
};

/** Read synchronously at the moment a staged service-worker reload is considered. */
export const hasUnsentComposerDraft = (): boolean =>
  textDrafts.size > 0 || visibleAttachments;

/** Test/app teardown hook. */
export const resetComposerDraft = (): void => {
  textDrafts.clear();
  visibleAttachments = false;
};
