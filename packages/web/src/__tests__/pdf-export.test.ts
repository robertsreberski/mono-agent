import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PDF_LIMITS, pdfConversation, pdfFilename, pdfImagePixels } from "../pdf-model.js";
import { boundedPng, renderPdf } from "../pdf-renderer.js";
import { renderPdfWorker } from "../pdf-worker-client.js";
import type { WebMessage, WebMessagePart } from "../contracts.js";
import { fakeProcessJob } from "./helpers.js";

const at = "2025-04-12T10:00:00.000Z";
const message = (parts: readonly WebMessagePart[], extra: Partial<WebMessage> = {}): WebMessage => ({
  id: "message", threadId: "thread", role: "assistant", parts, attachments: [],
  createdAt: at, updatedAt: at, status: "complete", seq: 0, ...extra,
});
const text = (value: string): WebMessagePart => ({ type: "text", text: value });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=", "base64");
const canvasModule = createRequire(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"))("@napi-rs/canvas") as {
  createCanvas(width: number, height: number): { getContext(kind: "2d"): unknown; toBuffer(type: string): Buffer; width: number; height: number };
};

async function pdfText(bytes: Uint8Array): Promise<string> {
  const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false });
  const document = await task.promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= document.numPages; i++) {
      const content = await (await document.getPage(i)).getTextContent();
      pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
    }
    return pages.join("\n");
  } finally { await task.destroy(); }
}

describe("messages-only PDF export", () => {
  it("strictly selects final replies, never tool/reasoning/job/subagent/system/imported content", async () => {
    const parts: WebMessagePart[] = [text("FORBIDDEN_EARLY_NARRATION"),
      { type: "reasoning", text: "FORBIDDEN_REASONING" },
      { type: "tool-call", toolCallId: "call", toolName: "Read", status: "complete", args: { secret: "FORBIDDEN_INPUT" }, result: "FORBIDDEN_OUTPUT" },
      { type: "subagent", toolCallId: "agent", name: "worker", status: "complete", result: "FORBIDDEN_SUBAGENT", calls: [] },
      { type: "process-job", job: fakeProcessJob({ preview: "FORBIDDEN_JOB" }), responseText: "FORBIDDEN_JOB_RESPONSE" },
      { type: "telemetry", event: "status", data: { text: "FORBIDDEN_TELEMETRY" } },
      { type: "error", message: "FORBIDDEN_ERROR" },
      { type: "text", interruptedQuestion: true, text: "FORBIDDEN_HOST_NOTE" }, text("Final shared answer")];
    const model = pdfConversation("Sample conversation", at, [message([text("FORBIDDEN_SYSTEM")], { role: "system" }),
      message([text("Imported cron result snapshot (mono-agent.web.cron-reply-context.v1) FORBIDDEN_IMPORT")]), message(parts)]);
    expect(JSON.stringify(model)).not.toContain("FORBIDDEN_");
    const extracted = await pdfText(await renderPdf(model));
    expect(extracted).toContain("Final shared answer"); expect(extracted).not.toContain("FORBIDDEN_");
  });

  it("includes user steers once, labels queued inputs, omits cancelled and running replies", () => {
    const model = pdfConversation("Sample", at, [
      message([text("Original")], { role: "user" }),
      message([text("Steered")], { role: "user", liveInputStatus: "applied" }),
      message([{ type: "steer", inputId: "input", messageId: "message", text: "DUPLICATE" }, text("Answer")]),
      message([text("Queue")], { role: "user", liveInputStatus: "queued" }),
      message([text("Cancelled")], { role: "user", liveInputStatus: "cancelled" }),
      message([text("Draft")], { status: "running" }),
      message([text("Completed silently (no message was reported)."), { type: "telemetry", event: "cron_run", data: { silent: true, status: "succeeded" } }]),
    ]);
    expect(model.messages.map((m) => m.text)).toEqual(["Original", "Steered", "Answer", "Queue"]);
    expect(model.messages.at(-1)?.status).toBe("Input queued"); expect(model.replyInProgress).toBe(true);
  });

  it("retains attachments-only messages and visible wake prose, but not host prompts", () => {
    const attachment = { type: "attachment", id: "file", artifactId: "artifact", name: "notes.txt", mediaType: "text/plain", sizeBytes: 4, integrityId: "sha256:test" } as const;
    const model = pdfConversation("Sample", at, [message([attachment]),
      message([{ type: "scheduled-wake", occurrenceId: "wake", scheduledAt: at, firedAt: at, timezone: "UTC", message: "FORBIDDEN_PROMPT" }, text("Visible wake answer")]),
      message([{ type: "scheduled-wake", occurrenceId: "wake", scheduledAt: at, firedAt: at, timezone: "UTC" }, text("FORBIDDEN_PROMPT")], { role: "user" })]);
    expect(model.messages).toHaveLength(2); expect(JSON.stringify(model)).not.toContain("FORBIDDEN");
    expect(model.messages[0]?.attachments[0]?.name).toBe("notes.txt");
  });

  it("bounds prose and sanitizes Unicode/hostile filenames", () => {
    expect(() => pdfConversation("Sample", at, [message([text("x".repeat(PDF_LIMITS.messageCharacters + 1))])])).toThrow(/limits/u);
    expect(pdfFilename("../Żółć\r\n/plan")).toBe("_Żółć___plan.pdf");
    expect(pdfFilename("\ud800")).toBe("_.pdf"); expect(pdfFilename("")).toBe("conversation.pdf");
  });

  it("rejects oversized/invalid image dimensions before decoding", () => {
    expect(pdfImagePixels(png, "image/png")).toBe(1);
    const bomb = Buffer.from(png); bomb.writeUInt32BE(100_000, 16);
    expect(pdfImagePixels(bomb, "image/png")).toBe(100_000);
    bomb.writeUInt32BE(100_000, 20); expect(pdfImagePixels(bomb, "image/png")).toBeUndefined();
    expect(pdfImagePixels(png, "image/jpeg")).toBeUndefined();
  });

  it("renders parseable Markdown, embedded Unicode and PNG/JPEG images in the actual worker", async () => {
    const jpegCanvas = canvasModule.createCanvas(3, 3);
    const jpeg = jpegCanvas.toBuffer("image/jpeg");
    expect(pdfImagePixels(jpeg, "image/jpeg")).toBe(9);
    const model = pdfConversation("A fictional garden plan", at, [
      message([text("Morgan asks for a **small garden** plan.")], { role: "user", quote: { text: "Keep a sunny corner", messageId: "prior" } }),
      message([text("# A welcoming garden\n\nPolish: ąęłńóśźż ĄĘŁŃÓŚŹŻ. German: Grüße, schön, Straße.\n\n**Bold** and *emphasis*, ~~removed~~, `inline code`.\n\n- Herbs\n- Flowers\n\n1. Prepare soil\n2. Plant seeds\n\n> A useful quote\n\n```js\nconst garden = 'green';\nconsole.log(garden);\n```\n\n| Plant | Season |\n| --- | --- |\n| Basil | Summer |\n| Mint | Spring |\n\n[Plant guide](https://example.com/guide)\n\n![Remote image](https://example.invalid/private.png)"),
        { type: "attachment", id: "png", artifactId: "png", name: "garden.png", mediaType: "image/png", sizeBytes: png.length, integrityId: "test" },
        { type: "attachment", id: "jpeg", artifactId: "jpeg", name: "flowers.jpg", mediaType: "image/jpeg", sizeBytes: jpeg.length, integrityId: "test" },
        { type: "attachment", id: "doc", artifactId: "doc", name: "notes.txt", mediaType: "text/plain", sizeBytes: 5, integrityId: "test" }]),
    ]);
    const images = [{ key: "message:reply:png", bytes: png }, { key: "message:reply:jpeg", bytes: jpeg }];
    const bytes = await renderPdfWorker(model, images, new AbortController().signal);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const extracted = await pdfText(bytes);
    for (const expected of ["Morgan", "ąęłńóśźż", "ĄĘŁŃÓŚŹŻ", "Grüße", "Straße", "Basil", "notes.txt", at]) expect(extracted).toContain(expected);
    const task = getDocument({ data: Uint8Array.from(bytes) });
    const parsed = await task.promise;
    let imageCount = 0;
    for (let i = 1; i <= parsed.numPages; i++) {
      const list = await (await parsed.getPage(i)).getOperatorList();
      imageCount += list.fnArray.filter((op: number) => op === OPS.paintImageXObject).length;
    }
    expect(imageCount).toBe(2);
    const artifacts = process.env.PDF_EXPORT_ARTIFACTS;
    if (artifacts) {
      await mkdir(artifacts, { recursive: true }); await writeFile(join(artifacts, "sample.pdf"), bytes);
      const page = await parsed.getPage(1); const viewport = page.getViewport({ scale: 1.7 });
      const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext("2d") as never, canvas: canvas as never, viewport }).promise;
      await writeFile(join(artifacts, "sample-page-1.png"), canvas.toBuffer("image/png"));
    }
    await task.destroy();
  });

  it("bounds actual PNG expansion, not just dimensions", () => {
    const compressed = deflateSync(Buffer.alloc(100_000));
    const data = Buffer.concat([png.subarray(0, 33), Buffer.alloc(4), Buffer.from("IDAT"), compressed, Buffer.alloc(4)]);
    data.writeUInt32BE(compressed.length, 33);
    expect(() => boundedPng(data)).toThrow();
  });

  it("fails excessive pages and tables instead of silently truncating", async () => {
    await expect(renderPdf(pdfConversation("Sample", at, [message([text("line\n".repeat(30_000))])]))).rejects.toThrow(/limits/u);
    const table = "| A |\n| --- |\n" + "| cell |\n".repeat(1_001);
    await expect(renderPdf(pdfConversation("Sample", at, [message([text(table)])]))).rejects.toThrow(/limits/u);
  });

  it("rejects excessive Markdown structure and supports cancellation", async () => {
    const model = pdfConversation("Sample", at, [message([text("> ".repeat(40) + "deep")])]);
    await expect(renderPdf(model)).rejects.toThrow(/limits/u);
    await expect(renderPdfWorker(pdfConversation("Sample", at, []), [], AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled");
  });
});
