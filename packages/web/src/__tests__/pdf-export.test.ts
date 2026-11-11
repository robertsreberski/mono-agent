import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PDF_LIMITS, pdfConversation, pdfExportDate, pdfFilename, pdfImagePixels } from "../pdf-model.js";
import { boundedPng, renderPdf } from "../pdf-renderer.js";
import { renderPdfWorker } from "../pdf-worker-client.js";
import type { WebMessage, WebMessagePart } from "../contracts.js";
import { fakeProcessJob } from "./helpers.js";
import { isPdfImageOperator, pdfRgbColor } from "./pdf-test-helpers.js";

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
  it("normalizes actual PDF.js colour operands and rejects empty assertions", () => {
    expect(pdfRgbColor(["#687078"])).toEqual([104, 112, 120]);
    expect(pdfRgbColor([104, 112, 120])).toEqual([104, 112, 120]);
    expect(pdfRgbColor([new Uint8Array([104, 112, 120])])).toEqual([104, 112, 120]);
    expect(() => pdfRgbColor([])).toThrow("Unexpected");
  });
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

  it("formats export dates in fixed English and UTC without locale dependence", () => {
    expect(pdfExportDate(at)).toBe("12 April 2025, 10:00 UTC");
    expect(pdfExportDate("2025-04-12T00:05:59.999+02:00")).toBe("11 April 2025, 22:05 UTC");
    expect(pdfExportDate("2024-02-29T00:00:00Z")).toBe("29 February 2024, 00:00 UTC");
    expect(pdfExportDate("invalid")).toBe("date unavailable");
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    for (let month = 1; month <= 12; month++) expect(pdfExportDate(`2025-${String(month).padStart(2, "0")}-01T09:03:00Z`))
      .toBe(`1 ${months[month - 1]} 2025, 09:03 UTC`);
  });

  it("rejects oversized/invalid image dimensions before decoding", () => {
    expect(pdfImagePixels(png, "image/png")).toBe(1);
    const bomb = Buffer.from(png); bomb.writeUInt32BE(100_000, 16);
    expect(pdfImagePixels(bomb, "image/png")).toBe(100_000);
    bomb.writeUInt32BE(100_000, 20); expect(pdfImagePixels(bomb, "image/png")).toBeUndefined();
    expect(pdfImagePixels(png, "image/jpeg")).toBeUndefined();
  });

  it("renders parseable Markdown, embedded Unicode and PNG/JPEG images in the actual worker", async () => {
    // A visible fictional illustration, not an invisible 1-pixel artifact.
    const gardenCanvas = canvasModule.createCanvas(320, 130);
    const context = gardenCanvas.getContext("2d") as { fillStyle: string; fillRect(x: number, y: number, w: number, h: number): void };
    context.fillStyle = "#eef4ed"; context.fillRect(0, 0, 320, 130);
    context.fillStyle = "#b49778"; context.fillRect(0, 95, 320, 35);
    context.fillStyle = "#557458";
    for (const x of [65, 155, 245]) { context.fillRect(x, 30, 6, 70); context.fillRect(x - 25, 45, 25, 12); context.fillRect(x + 6, 60, 25, 12); }
    const gardenPng = gardenCanvas.toBuffer("image/png");
    const jpeg = gardenCanvas.toBuffer("image/jpeg");
    expect(pdfImagePixels(jpeg, "image/jpeg")).toBe(320 * 130);
    const model = pdfConversation("A fictional garden plan", at, [
      message([text("Morgan asks for a **small garden** plan.")], { role: "user", quote: { text: "Keep a sunny corner", messageId: "prior" } }),
      message([text("# A welcoming garden\n\nPolish: ąęłńóśźż ĄĘŁŃÓŚŹŻ. German: Grüße, schön, Straße.\n\n![Garden illustration](/api/v1/threads/thread/messages/message/reply-attachments/png/content)\n\n**Bold** and *emphasis*, ~~removed~~, `inline code`.\n\n- Herbs\n- Flowers\n\n1. Prepare soil\n2. Plant seeds\n\n> A useful quote\n\n```js\nconst garden = 'green';\nconsole.log(garden);\n```\n\n| Plant | Season |\n| --- | --- |\n| Basil | Summer |\n| Mint | Spring |\n\n[Plant guide](https://example.com/guide)\n\n![Remote image](https://example.invalid/private.png)"),
        { type: "attachment", id: "png", artifactId: "png", name: "garden.png", mediaType: "image/png", sizeBytes: gardenPng.length, integrityId: "test" },
        { type: "attachment", id: "jpeg", artifactId: "jpeg", name: "flowers.jpg", mediaType: "image/jpeg", sizeBytes: jpeg.length, integrityId: "test" },
        { type: "attachment", id: "doc", artifactId: "doc", name: "notes.txt", mediaType: "text/plain", sizeBytes: 5, integrityId: "test" }]),
    ]);
    const images = [{ key: "message:reply:png", bytes: gardenPng }, { key: "message:reply:jpeg", bytes: jpeg }];
    const bytes = await renderPdfWorker(model, images, new AbortController().signal);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const extracted = await pdfText(bytes);
    for (const expected of ["Morgan", "ąęłńóśźż", "ĄĘŁŃÓŚŹŻ", "Grüße", "Straße", "Basil", "notes.txt", "Exported 12 April 2025, 10:00 UTC"]) expect(extracted).toContain(expected);
    const task = getDocument({ data: Uint8Array.from(bytes) });
    const parsed = await task.promise;
    expect(parsed.numPages).toBeGreaterThanOrEqual(2);
    const firstPage = await parsed.getPage(1);
    const firstContent = await firstPage.getTextContent();
    const fontSize = (text: string): number => {
      const item = firstContent.items.find((item) => "str" in item && item.str === text);
      return item && "height" in item ? item.height : 0;
    };
    expect(fontSize("A fictional garden plan")).toBe(22);
    expect(fontSize("ASSISTANT")).toBe(9);
    expect(fontSize("USER")).toBe(9);
    expect(fontSize("A welcoming garden")).toBe(12);
    const colors: number[][] = [];
    let imageCount = 0;
    for (let i = 1; i <= parsed.numPages; i++) {
      const list = await (await parsed.getPage(i)).getOperatorList();
      imageCount += list.fnArray.filter(isPdfImageOperator).length;
      list.fnArray.forEach((op: number, i: number) => { if (op === OPS.setFillRGBColor || op === OPS.setStrokeRGBColor) colors.push(pdfRgbColor(list.argsArray[i])); });
    }
    expect(imageCount).toBe(2);
    expect(colors).toEqual(expect.arrayContaining([[104, 112, 120], [89, 97, 106], [208, 213, 218], [243, 244, 245]]));
    expect(extracted).not.toContain(at);
    expect(extracted).toContain("[Attachment: notes.txt]");
    expect(extracted).toContain("[Image not included: Remote image]");
    expect(extracted.split("garden.png")).toHaveLength(2);
    expect(extracted.indexOf("garden.png")).toBeLessThan(extracted.indexOf("Basil"));
    const userLabel = firstContent.items.find((item) => "str" in item && item.str === "USER");
    const titleLabel = firstContent.items.find((item) => "str" in item && item.str === "A fictional garden plan");
    expect(userLabel && "fontName" in userLabel ? userLabel.fontName : undefined)
      .not.toBe(titleLabel && "fontName" in titleLabel ? titleLabel.fontName : undefined);
    const artifacts = process.env.PDF_EXPORT_ARTIFACTS;
    if (artifacts) {
      await mkdir(artifacts, { recursive: true }); await writeFile(join(artifacts, "sample.pdf"), bytes);
      for (const number of [1, 2]) {
        const page = await parsed.getPage(number); const viewport = page.getViewport({ scale: 1.7 });
        expect(Math.max(viewport.width, viewport.height)).toBeLessThanOrEqual(2000);
        const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvasContext: canvas.getContext("2d") as never, canvas: canvas as never, viewport }).promise;
        await writeFile(join(artifacts, `sample-page-${number}.png`), canvas.toBuffer("image/png"));
      }
    }
    await task.destroy();
  });

  it("sizes images without upscaling and keeps small muted captions next to their actual bottom edge", async () => {
    const sizes = [{ id: "small", width: 100, height: 40 }, { id: "tall", width: 1200, height: 900 }, { id: "wide", width: 1400, height: 100 }];
    const attachments = sizes.map(({ id, width, height }) => {
      const bytes = canvasModule.createCanvas(width, height).toBuffer("image/png");
      return { id, width, height, bytes };
    });
    const model = pdfConversation("Image sizing", at, [message([text("Filler line\n".repeat(36)),
      ...attachments.map(({ id, bytes }) => ({ type: "attachment" as const, id, artifactId: id, name: `${id}.png`, mediaType: "image/png", sizeBytes: bytes.length, integrityId: "test" }))])]);
    const bytes = await renderPdf(model, attachments.map(({ id, bytes }) => ({ key: `message:reply:${id}`, bytes })));
    const task = getDocument({ data: Uint8Array.from(bytes) });
    const document = await task.promise;
    let count = 0;
    try {
      expect(document.numPages).toBeGreaterThanOrEqual(2);
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number); const operators = await page.getOperatorList();
        const content = await page.getTextContent(); const viewport = page.getViewport({ scale: 1 });
        let pageImages = 0;
        for (let index = 0; index < operators.fnArray.length; index++) if (isPdfImageOperator(operators.fnArray[index]!)) {
          pageImages++;
          const size = sizes[count++]!;
          const matrix = operators.argsArray[operators.fnArray.slice(0, index).lastIndexOf(OPS.transform)] as number[];
          const w = Math.abs(matrix[0]!); const h = Math.abs(matrix[3]!);
          const scale = Math.min(1, (viewport.width - 96) / size.width, 280 / size.height);
          expect(w).toBeCloseTo(size.width * scale); expect(h).toBeCloseTo(size.height * scale);
          expect(matrix[4]).toBeGreaterThanOrEqual(48);
          expect(matrix[5]! - h).toBeGreaterThanOrEqual(48);
          expect(matrix[5]).toBeLessThanOrEqual(viewport.height - 48);
          const caption = content.items.find((item) => "str" in item && item.str === `${size.id}.png`);
          expect(caption).toBeDefined();
          if (caption && "transform" in caption) {
            expect(caption.height).toBe(9);
            const baselineGap = viewport.height - caption.transform[5] - matrix[5]!;
            expect(baselineGap).toBeGreaterThanOrEqual(5); expect(baselineGap).toBeLessThan(18);
          }
        }
        if (pageImages > 0) expect(operators.fnArray.flatMap((op: number, i: number) => op === OPS.setFillRGBColor ? [pdfRgbColor(operators.argsArray[i])] : [])).toContainEqual([89, 97, 106]);
      }
      expect(count).toBe(3);
    } finally { await task.destroy(); }
  });

  it("distinguishes ordinary attachments, unavailable PNG/JPEG, and unsupported image formats", async () => {
    const media = [["notes.txt", "text/plain"], ["recording.wav", "audio/wav"], ["missing.png", "image/png"],
      ["broken.jpg", "image/jpeg"], ["animation.gif", "image/gif"], ["drawing.webp", "image/webp"]];
    const model = pdfConversation("Attachments", at, [message(media.map(([name, mediaType]) => ({
      type: "attachment" as const, id: name!, artifactId: name!, name: name!, mediaType: mediaType!, sizeBytes: 1, integrityId: "test",
    })))]);
    const extracted = await pdfText(await renderPdf(model, [{ key: "message:reply:broken.jpg", bytes: Buffer.from("corrupt") }]));
    for (const name of ["notes.txt", "recording.wav"]) expect(extracted).toContain(`[Attachment: ${name}]`);
    for (const name of ["missing.png", "broken.jpg"]) expect(extracted).toContain(`[Image unavailable: ${name}]`);
    for (const name of ["animation.gif", "drawing.webp"]) expect(extracted).toContain(`[Attachment: ${name} — not embedded]`);
    expect(extracted).not.toContain("image unavailable or unsupported");
  });

  it("places owned inline images in authored order, once, including references, uploads and table cells", async () => {
    const path = "/api/v1/threads/thread/messages/message/reply-attachments/png/content";
    for (const markdown of [`Before ![plant](${path}) After`, `Before ![plant][photo] After\n\n[photo]: ${path}`,
      "Before ![plant](/api/v1/uploads/png/content?download=1) After", `> Before ![plant](${path}) After`,
      `- Before ![plant](${path}) After`, `| Plot |\n| --- |\n| Before ![plant](${path}) After |`]) {
      const base = pdfConversation("Inline images", at, [message([text(markdown),
        { type: "attachment", id: "png", artifactId: "png", name: "inline.png", mediaType: "image/png", sizeBytes: png.length, integrityId: "test" },
        { type: "attachment", id: "tail", artifactId: "tail", name: "tail.txt", mediaType: "text/plain", sizeBytes: 1, integrityId: "test" }])]);
      const upload = markdown.includes("/uploads/");
      const model = upload ? { ...base, messages: base.messages.map((m) => ({ ...m, attachments: m.attachments.map((a) => a.id === "png" ? { ...a, origin: "upload" as const, key: "message:upload:png" } : a) })) } : base;
      const bytes = await renderPdf(model, [{ key: upload ? "message:upload:png" : "message:reply:png", bytes: png }]);
      const extracted = await pdfText(bytes);
      expect(extracted.split("inline.png")).toHaveLength(2);
      expect(extracted.indexOf("Before")).toBeLessThan(extracted.indexOf("inline.png"));
      expect(extracted.indexOf("inline.png")).toBeLessThan(extracted.indexOf("After"));
      expect(extracted.indexOf("After")).toBeLessThan(extracted.indexOf("tail.txt"));
      const task = getDocument({ data: Uint8Array.from(bytes) }); const document = await task.promise;
      try {
        let images = 0;
        for (let page = 1; page <= document.numPages; page++) images += (await (await document.getPage(page)).getOperatorList()).fnArray.filter(isPdfImageOperator).length;
        expect(images).toBe(1);
      } finally { await task.destroy(); }
    }
  });

  it("never fetches remote, data or foreign inline images", async () => {
    const model = pdfConversation("Unowned images", at, [message([text("![Remote](https://example.invalid/plant.png)\n\n![Foreign](/api/v1/threads/foreign/messages/message/reply-attachments/png/content)\n\n![Upload](/api/v1/uploads/foreign/content)\n\n![Data](data:image/png;base64,AAAA)")])]);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Must not fetch"));
    let bytes: Buffer;
    try { bytes = await renderPdf(model); expect(fetch).not.toHaveBeenCalled(); } finally { fetch.mockRestore(); }
    const extracted = await pdfText(bytes);
    for (const alt of ["Remote", "Foreign", "Upload", "Data"]) expect(extracted).toContain(`[Image not included: ${alt}]`);
  });

  it("wraps unbroken code and paginates its background without dropping lines", async () => {
    const token = `BEGIN_${"x".repeat(7000)}_END`;
    const lines = Array.from({ length: 120 }, (_, i) => `line_${String(i).padStart(3, "0")} Grüße`);
    const bytes = await renderPdf(pdfConversation("Code pagination", at, [message([text(`\`\`\`text\n${token}\n${lines.join("\n")}\n\`\`\``)])]));
    const extracted = await pdfText(bytes);
    expect(extracted.replace(/\s/gu, "")).toContain(`${token}${lines.join("")}`.replace(/\s/gu, ""));
    const task = getDocument({ data: Uint8Array.from(bytes) });
    const document = await task.promise;
    try {
      expect(document.numPages).toBeGreaterThan(2);
      for (let page = 1; page <= document.numPages; page++) {
        const content = await document.getPage(page);
        const operators = await content.getOperatorList();
        expect(operators.fnArray.flatMap((op: number, i: number) => op === OPS.setFillRGBColor ? [pdfRgbColor(operators.argsArray[i])] : [])).toContainEqual([243, 244, 245]);
        for (const item of (await content.getTextContent()).items) if ("str" in item && (item.str.startsWith("line_") || item.str.startsWith("BEGIN_"))) {
          expect(item.transform[4]).toBeGreaterThanOrEqual(56);
          expect(item.transform[4] + item.width).toBeLessThanOrEqual(content.getViewport({ scale: 1 }).width - 48);
          expect(item.transform[5]).toBeGreaterThanOrEqual(48);
        }
      }
    } finally { await task.destroy(); }
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
