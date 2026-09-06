import type { ThreadSummary, WebMessage } from "./types";

/** Old servers marked delivered text silent too: only synthetic-only rows are safe to hide. */
export function isLegacySilentCronMessage(message: WebMessage): boolean {
  return message.role === "assistant" && message.status === "complete" && message.attachments.length === 0
    && message.parts.some((part) => part.type === "telemetry" && part.event === "cron_run"
      && isSilentCronData(part.data))
    && message.parts.every((part) => part.type === "telemetry" && part.event === "cron_run"
      || part.type === "text" && (part.text.trim() === "" || part.text === "Completed silently (no message was reported)."));
}

export function isSilentCronData(data: unknown): boolean {
  return typeof data === "object" && data !== null
    && "status" in data && data.status === "succeeded" && "silent" in data && data.silent === true;
}

export function sanitizeCronTranscript(thread: ThreadSummary, messages: readonly WebMessage[]) {
  const visible = messages.filter((message) => !isLegacySilentCronMessage(message));
  if (visible.length === messages.length) return { thread, messages, changed: false };
  const { lastMessagePreview: _oldPreview, ...summary } = thread;
  const preview = visible.at(-1)?.parts.flatMap((part) => part.type === "text" && part.text !== "Completed silently (no message was reported)." ? [part.text] : []).join(" ").slice(0, 280);
  return {
    thread: { ...summary, messageCount: Math.max(0, thread.messageCount - (messages.length - visible.length)),
      ...(preview ? { lastMessagePreview: preview } : {}) },
    messages: visible,
    changed: true,
  };
}
