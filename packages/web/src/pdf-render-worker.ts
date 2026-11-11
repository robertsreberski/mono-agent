import { parentPort, workerData } from "node:worker_threads";
import { renderPdf } from "./pdf-renderer.js";
import type { PdfConversation, PdfImage } from "./pdf-model.js";
import { WebConsoleError } from "./errors.js";

const input = workerData as { conversation: PdfConversation; images: PdfImage[] };
try {
  const bytes = await renderPdf(input.conversation, input.images);
  const data = Uint8Array.from(bytes);
  parentPort!.postMessage({ bytes: data }, [data.buffer]);
} catch (error) {
  parentPort!.postMessage({ error: error instanceof WebConsoleError ? error.code : "pdf_render_failed" });
}
