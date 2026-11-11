import { Worker } from "node:worker_threads";
import { statSync } from "node:fs";
import { PDF_LIMITS, pdfTooLarge, type PdfConversation, type PdfImage } from "./pdf-model.js";
import { WebConsoleError } from "./errors.js";

export async function renderPdfWorker(conversation: PdfConversation, images: readonly PdfImage[], signal: AbortSignal): Promise<Buffer> {
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
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const abort = (): void => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      const cleanup = (): void => signal.removeEventListener("abort", abort);
      worker.once("message", (message: { bytes?: Uint8Array; error?: string }) => {
        cleanup();
        if (message.error === "pdf_too_large") reject(pdfTooLarge());
        else if (!(message.bytes instanceof Uint8Array) || message.bytes.length > PDF_LIMITS.outputBytes) {
          reject(new WebConsoleError("pdf_render_failed", "PDF export failed. Try again.", 500));
        } else resolve(Buffer.from(message.bytes));
      });
      worker.once("error", () => { cleanup(); reject(new WebConsoleError("pdf_render_failed", "PDF export failed. Try a shorter conversation.", 500)); });
      worker.once("exit", () => { cleanup(); reject(new WebConsoleError("pdf_render_failed", "PDF export stopped unexpectedly. Try again.", 500)); });
    });
  } finally { await worker.terminate(); }
}
