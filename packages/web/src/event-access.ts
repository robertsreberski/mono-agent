import { webThreadVisible, type WebThreadAccess } from "./access.js";
import type { WebEvent } from "./contracts.js";
import { toWebAttachment, type WebStore } from "./store.js";

/** Internal routing evidence. Never spread this descriptor into a wire event. */
export interface WebEventAccess {
  readonly sourceId?: string;
  readonly previousThread?: WebThreadAccess;
  readonly uploadOwnerUserId?: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Called in a freshly authenticated recipient scope, BEFORE dispatch/serialization. */
export function projectWebEvent(store: WebStore, event: WebEvent, access?: WebEventAccess): WebEvent | undefined {
  const principal = store.access.requirePrincipal();
  const payload = record(event.payload);
  const base = { id: event.id, version: event.version, type: event.type, at: event.at };
  const sourceId = access?.sourceId ?? (typeof payload?.sourceId === "string" ? payload.sourceId : undefined);
  if (sourceId !== undefined && !store.access.agentAllowed(sourceId)) return undefined;
  switch (event.type) {
    case "ready": return { ...base, payload: { version: event.version } };
    case "push.pending": return undefined;
    case "agents.changed":
    case "cron.changed": return sourceId === undefined ? base : { ...base, payload: { sourceId,
      ...(event.type === "agents.changed" && typeof payload?.pinned === "boolean" ? { pinned: payload.pinned } : {}),
      ...(event.type === "cron.changed" && typeof payload?.jobId === "string" ? { jobId: payload.jobId } : {}) } };
    case "tags.changed": {
      const tagId = record(payload?.tag)?.id ?? payload?.tagId;
      if (typeof tagId !== "string") return base;
      const tag = store.getTag(tagId);
      if (tag !== undefined) return { ...base, payload: { tag } };
      return payload?.removed === true && sourceId !== undefined ? { ...base, payload: { tagId, removed: true } } : undefined;
    }
    case "projects.changed": {
      const projectId = record(payload?.project)?.id ?? payload?.projectId;
      if (typeof projectId !== "string") return base;
      const project = store.getProject(projectId);
      if (project !== undefined) return { ...base, payload: { project } };
      return payload?.removed === true && sourceId !== undefined ? { ...base, payload: { projectId, removed: true } } : undefined;
    }
    case "attachment.changed": {
      const attachmentId = record(payload?.attachment)?.id ?? payload?.attachmentId;
      if (typeof attachmentId !== "string") return undefined;
      const attachment = store.getStoredAttachment(attachmentId);
      if (attachment !== undefined) return { ...base, payload: { attachment: toWebAttachment(attachment) } };
      return payload?.removed === true && access?.uploadOwnerUserId === principal.id
        ? { ...base, payload: { attachmentId, removed: true } } : undefined;
    }
    case "thread.changed":
    case "threads.changed": {
      const threadId = event.threadId ?? record(payload?.thread)?.id;
      if (typeof threadId !== "string") return base;
      const thread = store.getThread(threadId);
      if (thread !== undefined) return { ...base, threadId: thread.id, payload: { thread } };
      return access?.previousThread !== undefined && webThreadVisible(principal, access.previousThread)
        ? { ...base, threadId, payload: { threadId, removed: true } } : undefined;
    }
    case "turn.changed":
    case "message.changed":
    case "message.delta": {
      if (event.threadId === undefined) return undefined;
      const thread = store.getThread(event.threadId);
      if (thread === undefined) return undefined;
      if (event.type === "turn.changed") return { ...base, threadId: thread.id, payload: { turn: thread.runState } };
      if (typeof payload?.messageId !== "string") return undefined;
      const message = store.getMessage(payload.messageId);
      if (message === undefined || message.threadId !== thread.id) return undefined;
      // Producer deltas may carry producer-session resource URLs. A scoped
      // invalidation makes the recipient fetch/mint its own authorized parts.
      return { ...base, type: "message.changed", threadId: thread.id, payload: {
        messageId: message.id, updatedAt: message.updatedAt, ...(event.type === "message.delta" ? { deltaDeclined: true } : {}) } };
    }
    default: return undefined;
  }
}
