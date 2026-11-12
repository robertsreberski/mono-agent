import { Worker } from "node:worker_threads";
import { statSync } from "node:fs";
import { PDF_LIMITS, pdfTooLarge, type PdfConversation, type PdfImage } from "./pdf-model.js";
import { WebConsoleError } from "./errors.js";

export async function renderPdfWorker(
  conversation: PdfConversation,
  images: readonly PdfImage[],
  signal: AbortSignal,
  logger?: { error?(message: string, metadata?: Readonly<Record<string, unknown>>): void },
): Promise<Buffer> {
  signal.throwIfAborted();
  const url = import.meta.url.endsWith(".ts") ? new URL("../dist/pdf-render-worker.js", import.meta.url)
    : new URL("./pdf-render-worker.js", import.meta.url);
  if (import.meta.url.endsWith(".ts")) {
    for (const name of ["pdf-render-worker", "pdf-renderer", "pdf-model"]) {
      if (statSync(new URL(`./${name}.ts`, import.meta.url)).mtimeMs > statSync(new URL(`../dist/${name}.js`, import.meta.url)).mtimeMs) {
        throw new Error("Build @mono-agent/web before testing its PDF worker.");
      }
    }
  }
  const worker = new Worker(url, { workerData: { conversation, images },
    resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 }, execArgv: [] });
  // Diagnostics must never prevent settlement or worker termination.
  const log = (message: string, metadata: Readonly<Record<string, unknown>>): void => {
    try { logger?.error?.(message, metadata); } catch { /* ignore logger failures */ }
  };
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      const cleanup = (): boolean => {
        if (settled) return false;
        settled = true;
        signal.removeEventListener("abort", abort);
        return true;
      };
      const abort = (): void => { if (cleanup()) reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      worker.once("message", (message: { bytes?: Uint8Array; error?: string }) => {
        if (!cleanup()) return;
        if (message.error === "pdf_too_large") reject(pdfTooLarge());
        else if (!(message.bytes instanceof Uint8Array) || message.bytes.length > PDF_LIMITS.outputBytes) {
          log("PDF worker failed.", { code: message.error ?? "invalid_worker_response" });
          reject(new WebConsoleError("pdf_render_failed", "PDF export failed. Try again.", 500));
        } else resolve(Buffer.from(message.bytes));
      });
      worker.once("error", (error: NodeJS.ErrnoException) => {
        if (!cleanup()) return;
        // Server-only diagnostics: never log workerData, images or transcript.
        log("PDF worker failed.", { error: error.message, code: error.code });
        reject(new WebConsoleError("pdf_render_failed", "PDF export failed. Try again.", 500));
      });
      worker.once("exit", (code) => {
        if (!cleanup()) return;
        log("PDF worker exited before producing a result.", { code });
        reject(new WebConsoleError("pdf_render_failed", "PDF export failed. Try again.", 500));
      });
    });
  } finally { await worker.terminate(); }
}
