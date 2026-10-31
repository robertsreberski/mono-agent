import type { IncomingMessage } from "node:http";
import { WebConsoleError } from "./errors.js";
import { WEB_VOICE_LIMITS, WEB_VOICE_UPLOAD_TIMEOUT_MS } from "./transcription.js";

/** Count actual streamed bytes; never route through JSON/raw middleware or staged uploads. */
export function readVoiceUpload(req: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      req.off("data", data);
      req.off("end", end);
      req.off("error", failed);
      req.off("aborted", aborted);
      signal.removeEventListener("abort", aborted);
      if (error) { chunks.length = 0; req.pause(); reject(error); }
      else resolve(Buffer.concat(chunks, size));
    };
    const data = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > WEB_VOICE_LIMITS.maxBytes) finish(new WebConsoleError("voice_too_large", "The recording exceeds 10 MiB. Record a shorter message.", 413));
      else chunks.push(chunk);
    };
    const end = (): void => finish();
    const failed = (): void => finish(new WebConsoleError("voice_upload_failed", "Audio upload failed. Retry Send.", 400));
    const aborted = (): void => finish(new WebConsoleError("voice_aborted", "Voice message cancelled.", 408));
    const timer = setTimeout(() => finish(new WebConsoleError("voice_upload_timeout", "Audio upload timed out. Retry Send.", 408)), WEB_VOICE_UPLOAD_TIMEOUT_MS);
    if (signal.aborted) { aborted(); return; }
    req.on("data", data);
    req.once("end", end);
    req.once("error", failed);
    req.once("aborted", aborted);
    signal.addEventListener("abort", aborted, { once: true });
  });
}
