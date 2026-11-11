import type { WebMessage } from "./contracts.js";
import { WebConsoleError } from "./errors.js";

export const PDF_LIMITS = Object.freeze({ rows: 2_000, sourceBytes: 32 * 1024 * 1024,
  textBytes: 2 * 1024 * 1024, messageCharacters: 200_000, images: 20,
  imageBytes: 5 * 1024 * 1024, totalImageBytes: 20 * 1024 * 1024,
  imagePixels: 4_000_000, totalImagePixels: 16_000_000,
  outputBytes: 32 * 1024 * 1024, pages: 500, timeoutMs: 30_000,
  nodes: 100_000, depth: 32, columns: 20, tableRows: 1_000 });

export function pdfTooLarge(): WebConsoleError {
  return new WebConsoleError("pdf_too_large", "This conversation exceeds the PDF export limits. Export a shorter conversation.", 413);
}
export interface PdfAttachment {
  readonly key: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly id: string;
  readonly origin: "upload" | "reply";
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
}
export interface PdfMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly quote?: string;
  readonly status?: string;
  readonly attachments: readonly PdfAttachment[];
}
export interface PdfConversation {
  readonly title: string;
  readonly exportedAt: string;
  readonly messages: readonly PdfMessage[];
  readonly replyInProgress: boolean;
}
export interface PdfImage { readonly key: string; readonly bytes: Uint8Array }

/** No raw parts, activity metadata, URLs or tool payloads can cross this boundary. */
export function pdfConversation(title: string, exportedAt: string, messages: readonly WebMessage[]): PdfConversation {
  let textBytes = Buffer.byteLength(title);
  let replyInProgress = false;
  const result: PdfMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant" && message.status === "running") { replyInProgress = true; continue; }
    if (message.role === "user" && (message.liveInputStatus === "cancelled"
      || message.parts.some((part) => part.type === "scheduled-wake" || part.type === "process-job-wake"))) continue;
    // Legacy synthetic silent cron rows have no shared reply, even before the
    // store gained cron_suppressed. Never hide real delivered prose or files.
    if (message.role === "assistant" && message.attachments.length === 0
      && message.parts.some((p) => p.type === "telemetry" && p.event === "cron_run"
        && p.data !== null && typeof p.data === "object" && "silent" in p.data && p.data.silent === true && "status" in p.data && p.data.status === "succeeded")
      && message.parts.every((p) => p.type === "telemetry" || p.type === "text"
        && (p.text.trim() === "" || p.text === "Completed silently (no message was reported)."))) continue;
    const prose = message.parts.filter((p): p is Extract<WebMessage["parts"][number], { type: "text" }> => p.type === "text" && !p.interruptedQuestion);
    const text = message.role === "assistant" ? prose.at(-1)?.text ?? "" : prose.map((p) => p.text).join("\n\n");
    // Imported cron context is a host-owned snapshot wrapper, not an answer.
    if (message.role === "assistant" && text.startsWith("Imported cron result snapshot (mono-agent.web.cron-reply-context.v1)")) continue;
    const quote = message.role === "user" ? message.quote?.text : undefined;
    const attachments: PdfAttachment[] = [
      ...message.attachments.filter((a) => a.status === "committed" && a.uploaded).map((a) => ({
        key: `${message.id}:upload:${a.id}`, messageId: message.id, threadId: message.threadId, id: a.id, origin: "upload" as const,
        name: a.name, mediaType: a.contentType, sizeBytes: a.sizeBytes,
      })),
      ...message.parts.flatMap((p) => p.type === "attachment" ? [{
        key: `${message.id}:reply:${p.id}`, messageId: message.id, threadId: message.threadId, id: p.id, origin: "reply" as const,
        name: p.name, mediaType: p.mediaType, sizeBytes: p.sizeBytes,
      }] : []),
    ];
    if (!text.trim() && attachments.length === 0) continue;
    textBytes += Buffer.byteLength(text) + Buffer.byteLength(quote ?? "")
      + attachments.reduce((sum, a) => sum + Buffer.byteLength(a.name), 0);
    if (text.length > PDF_LIMITS.messageCharacters || (quote?.length ?? 0) > PDF_LIMITS.messageCharacters
      || textBytes > PDF_LIMITS.textBytes) throw pdfTooLarge();
    const status = message.role === "assistant" && message.status !== "complete" ? "Incomplete reply"
      : message.liveInputStatus && message.liveInputStatus !== "applied" ? `Input ${message.liveInputStatus}` : undefined;
    result.push({ role: message.role, text, ...(quote ? { quote } : {}), ...(status ? { status } : {}), attachments });
  }
  return { title, exportedAt, messages: result, replyInProgress };
}

export function pdfFilename(title: string): string {
  const safe = Array.from(title, (c) => c.length === 1 && /[\ud800-\udfff]/u.test(c) ? "_" : c).join("").replace(/[\x00-\x1f\x7f/\\<>:"|?*]/gu, "_").replace(/^\.+|[. ]+$/gu, "");
  return `${Array.from(safe).slice(0, 100).join("") || "conversation"}.pdf`;
}

/** Inspect dimensions before any decompression (including PNG decompression bombs). */
export function pdfImagePixels(bytes: Uint8Array, mediaType: string): number | undefined {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0; let height = 0;
  if (mediaType === "image/png" && b.length >= 33 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    && b.toString("ascii", 12, 16) === "IHDR") {
    width = b.readUInt32BE(16); height = b.readUInt32BE(20);
  } else if (mediaType === "image/jpeg" && b[0] === 255 && b[1] === 216) {
    let offset = 2;
    while (offset + 4 <= b.length) {
      if (b[offset] !== 255) return undefined;
      const marker = b[offset + 1]!;
      if (marker === 255) { offset++; continue; }
      const size = b.readUInt16BE(offset + 2);
      if (size < 2 || offset + 2 + size > b.length) return undefined;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 7) {
        height = b.readUInt16BE(offset + 5); width = b.readUInt16BE(offset + 7); break;
      }
      offset += size + 2;
    }
  }
  const pixels = width * height;
  return width > 0 && height > 0 && pixels <= PDF_LIMITS.imagePixels ? pixels : undefined;
}
