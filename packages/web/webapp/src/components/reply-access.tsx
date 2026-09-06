import { createContext, useContext, type ReactNode } from "react";
import type { MessagePart } from "../types";

type ReplyAttachmentPart = Extract<MessagePart, { readonly type: "attachment" }>;

/**
 * Mints a fresh capability for one rich reply part of the open conversation.
 *
 * A transcript restored from this device carries no capability URLs — they are
 * short-lived credentials and PR 5 strips them on the way into storage — so a
 * picture or a file read back off the device arrives with an identity and no way
 * to fetch its bytes. It is not gone: the console can ask for a new capability
 * for exactly that part, which is what this does.
 *
 * The part id is all the caller has; the conversation and the message that holds
 * it are the store's business, because only the store knows which conversation
 * is on screen.
 */
export type ReplyAttachmentAccess = (partId: string) => Promise<ReplyAttachmentPart>;

const ReplyAccessContext = createContext<ReplyAttachmentAccess | null>(null);

export function ReplyAccessProvider({
  refreshAttachment,
  children,
}: {
  readonly refreshAttachment: ReplyAttachmentAccess;
  readonly children: ReactNode;
}) {
  return <ReplyAccessContext value={refreshAttachment}>{children}</ReplyAccessContext>;
}

/**
 * The refresh capability, or `undefined` where there is none.
 *
 * A transcript rendered outside the console genuinely cannot mint anything, and
 * a part with no capability there is honestly unavailable — exactly as before
 * this existed. Nothing pretends otherwise in either case.
 */
export function useReplyAttachmentAccess(): ReplyAttachmentAccess | undefined {
  return useContext(ReplyAccessContext) ?? undefined;
}
