import type { CompleteAttachment } from "@assistant-ui/react";
import type { AttachmentSubmissionSnapshot } from "./console-store";
import type { WebQuote } from "./types";

export interface RecordedDraft {
  readonly owner: AttachmentSubmissionSnapshot;
  readonly text: string;
  readonly quote?: WebQuote;
  readonly attachments: readonly CompleteAttachment[];
  readonly files: readonly { id: string; file: Blob; name: string; recorded: boolean; duration?: number }[];
  readonly composed?: string;
  // Conservatively set before calling submit, including while waiting on writes.
  readonly dispatched: boolean;
}
const DATABASE = "mono-recorded-drafts-v1";
const LIMIT_BYTES = 80 * 1024 * 1024;
const LIMIT_ATTEMPTS = 8;
async function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("Device storage unavailable. Your recording is kept here; enable storage to retry.")); return; }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts", { keyPath: "owner.submissionId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Could not save the recording on this device. Free device storage and Retry."));
    request.onblocked = () => reject(new Error("Device recording storage is blocked. Close other console tabs and Retry."));
  });
}
async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, result: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", mode);
    let value: T;
    let failure: Error | undefined;
    tx.oncomplete = () => { db.close(); resolve(value); };
    tx.onabort = tx.onerror = () => { db.close(); reject(failure ?? tx.error ?? new Error("Could not save the recording on this device. Free device storage and Retry.")); };
    try { run(tx.objectStore("drafts"), next => { value = next; }, error => { failure = error; tx.abort(); }); }
    catch (error) { tx.abort(); reject(error); }
  });
}
export const loadRecordedDrafts = (): Promise<RecordedDraft[]> => transaction("readonly", (store, done) => {
  const request = store.getAll(); request.onsuccess = () => done(request.result as RecordedDraft[]);
});
export const removeRecordedDraft = (id: string): Promise<void> => transaction("readwrite", (store, done) => { store.delete(id); done(undefined); });
export async function saveRecordedDraft(draft: RecordedDraft, replacedId?: string): Promise<void> {
  await transaction<void>("readwrite", (store, done, fail) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const others = (request.result as RecordedDraft[]).filter(item => item.owner.submissionId !== draft.owner.submissionId && item.owner.submissionId !== replacedId);
      const bytes = [...others, draft].reduce((sum, item) => sum + item.files.reduce((size, entry) => size + entry.file.size, 0), 0);
      if (others.length >= LIMIT_ATTEMPTS || bytes > LIMIT_BYTES) { fail(new Error("Saved recordings are full (8 messages / 80 MiB). Remove another pending message, then Retry.")); return; }
      if (replacedId) store.delete(replacedId);
      store.put(draft); done(undefined);
    };
  });
}
