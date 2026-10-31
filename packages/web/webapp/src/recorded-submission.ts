import { formatQuotedTurn } from "../../src/project-context";
import type { CompleteAttachment } from "@assistant-ui/react";
import type { AttachmentSubmissionSession } from "./console-store";
import type { WebQuote } from "./types";
import type { WebUploadAttachmentAdapter } from "./attachment-adapter";

// One preparation budget, not one full provider deadline per recording.
export const AUDIO_PREPARATION_TIMEOUT_MS = 150_000;
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Audio preparation cancelled.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
export class RecordedSubmissionAttempt {
  readonly controller = new AbortController();
  readonly attachments: readonly CompleteAttachment[];
  readonly quote?: WebQuote;
  readonly text: string;
  dispatched = false;
  threadId: string | null;
  private composed?: string;
  readonly owner: AttachmentSubmissionSession;
  private readonly adapter: WebUploadAttachmentAdapter;
  constructor(owner: AttachmentSubmissionSession, adapter: WebUploadAttachmentAdapter,
    input: { text: string; attachments: readonly CompleteAttachment[]; quote?: WebQuote; threadId: string | null }) {
    this.owner = owner; this.adapter = adapter;
    this.text = input.text;
    this.attachments = input.attachments.map((value) => ({ ...value }));
    this.quote = input.quote && { ...input.quote };
    this.threadId = input.threadId;
  }
  cancelPreparation(): void { if (!this.dispatched) this.controller.abort(); }
  async send(): Promise<void> {
    const timeout = setTimeout(() => this.controller.abort(new Error("Audio preparation timed out. Retry Send.")), AUDIO_PREPARATION_TIMEOUT_MS);
    try {
      if (this.composed === undefined) {
        const withQuote = (text: string) => this.quote ? formatQuotedTurn(this.quote.text, text) : text;
        if (withQuote(this.text).length > 200_000) throw new Error("The message and quote exceed the message text limit.");
        this.threadId = await abortable(this.owner.prepare(this.controller.signal), this.controller.signal);
        this.controller.signal.throwIfAborted();
        this.owner.assertCanSendAttachments();
        const composed = await abortable(this.adapter.prepareRecordedText(this.text, this.attachments, this.threadId, this.controller.signal,
          () => { this.owner.assertCanSendAttachments(); return this.owner.isCurrent(); }), this.controller.signal);
        if (withQuote(composed).length > 200_000) throw new Error("The message, quote and audio transcripts exceed the message text limit.");
        this.composed = composed;
      }
      this.controller.signal.throwIfAborted();
      if (!this.owner.isCurrent()) throw new DOMException("The conversation changed.", "AbortError");
      this.owner.assertCanSendAttachments();
      await abortable(this.owner.submit(this.composed, this.attachments.map(({ id }) => id), this.quote, () => {
        this.dispatched = true; clearTimeout(timeout);
      }), this.controller.signal);
    } finally { clearTimeout(timeout); }
  }
}
