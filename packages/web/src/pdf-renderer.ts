import { WebConsoleError } from "./errors.js";
import { inflateSync } from "node:zlib";
import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { PDF_LIMITS, pdfTooLarge, type PdfConversation, type PdfImage, type PdfAttachment } from "./pdf-model.js";

interface MdNode {
  readonly type: string;
  readonly value?: string | undefined;
  readonly url?: string | undefined;
  readonly identifier?: string | undefined;
  readonly alt?: string | null | undefined;
  readonly depth?: number | undefined;
  readonly ordered?: boolean | null | undefined;
  readonly start?: number | null | undefined;
  readonly checked?: boolean | null | undefined;
  readonly children?: readonly MdNode[] | undefined;
}
interface Run { text: string; bold?: boolean; italic?: boolean; mono?: boolean; strike?: boolean; link?: string | undefined }
const parser = unified().use(remarkParse).use(remarkGfm);
const font = (name: string): string => fileURLToPath(new URL(`../assets/pdf-fonts/${name}.ttf`, import.meta.url));
const safeLink = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try { const u = new URL(url); return ["https:", "http:", "mailto:"].includes(u.protocol) ? u.href : undefined; } catch { return undefined; }
};
// PNG decoders may inflate surplus IDAT bytes despite a small IHDR. Validate
// the actual expansion under a ceiling inside the resource-limited worker.
export function boundedPng(data: Buffer): void {
  if (data[0] !== 137) return;
  if (data.length < 33) throw new Error("Invalid PNG");
  const width = data.readUInt32BE(16); const height = data.readUInt32BE(20);
  if (width * height > PDF_LIMITS.imagePixels || width === 0 || height === 0) throw new Error("PNG too large");
  const compressed: Buffer[] = [];
  for (let offset = 8; offset + 12 <= data.length;) {
    const size = data.readUInt32BE(offset);
    if (offset + 12 + size > data.length) throw new Error("Invalid PNG");
    if (data.toString("ascii", offset + 4, offset + 8) === "IDAT") compressed.push(data.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  inflateSync(Buffer.concat(compressed), { maxOutputLength: width * height * 8 + height * 8 + 1024 });
}
const plain = (node: MdNode): string => node.value ?? node.children?.map(plain).join("") ?? node.alt ?? "";

/** Pure document input, with no filesystem paths or network access from Markdown. */
export async function renderPdf(input: PdfConversation, images: readonly PdfImage[] = []): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: false,
    font: font("NotoSans-Regular"), info: { Title: input.title, Creator: "mono-agent conversation export" } });
  doc.registerFont("body", font("NotoSans-Regular"));
  doc.registerFont("bold", font("NotoSans-Bold"));
  doc.registerFont("mono", font("NotoSansMono-Regular"));
  let pageCount = 1; let bytes = 0; let nodes = 0;
  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > PDF_LIMITS.outputBytes) { doc.destroy(pdfTooLarge()); return; }
      chunks.push(chunk);
    });
    doc.once("error", reject);
    doc.once("end", () => resolve(Buffer.concat(chunks)));
  });
  // The consumer may reject asynchronously while layout is still running.
  void finished.catch(() => undefined);
  doc.on("pageAdded", () => { if (++pageCount > PDF_LIMITS.pages) throw pdfTooLarge(); });
  const width = doc.page.width - 96;
  const imageMap = new Map(images.map((i) => [i.key, Buffer.from(i.bytes)]));
  const body = (): void => { doc.font("body").fontSize(10).fillColor("#20252b"); };
  const gap = (): void => { doc.moveDown(0.6); doc.x = 48; };
  const rich = (runs: readonly Run[], indent = 0): void => {
    if (runs.length === 0) return;
    doc.x = 48 + indent;
    runs.forEach((run, i) => {
      doc.font(run.mono ? "mono" : run.bold ? "bold" : "body").fillColor(run.link ? "#24527a" : "#20252b")
        .text(run.text, { width: width - indent, continued: i < runs.length - 1,
          oblique: run.italic ?? false, strike: run.strike ?? false, underline: Boolean(run.link), link: run.link ?? null });
    });
    doc.x = 48;
  };
  const image = (a: PdfAttachment, indent = 0): void => {
    const data = imageMap.get(a.key);
    if (data) {
      try {
        boundedPng(data);
        const height = 260;
        if (doc.y + height > doc.page.height - 48) doc.addPage();
        doc.image(data, 48 + indent, doc.y, { fit: [width - indent, height] });
        doc.y += height + 5;
        body(); doc.text(a.name, 48 + indent, doc.y, { width: width - indent }); gap(); return;
      } catch (error) {
        if (error instanceof WebConsoleError) throw error;
        // Corrupt/unsupported image remains a named attachment.
      }
    }
    body(); doc.text(`[Attachment: ${a.name} — image unavailable or unsupported]`, 48 + indent, doc.y, { width: width - indent }); gap();
  };
  try {
    doc.font("bold").fontSize(22).text(input.title || "Conversation");
    doc.font("body").fontSize(9).fillColor("#59616a").text(`Exported ${input.exportedAt} (UTC)`); gap();
    if (input.replyInProgress) { body(); doc.text("An in-progress reply is not included."); gap(); }
    if (input.messages.length === 0) { body(); doc.text("No messages to export."); }
    for (const message of input.messages) {
      body();
      if (doc.y > doc.page.height - 110) doc.addPage();
      doc.font("bold").fontSize(12).text(message.role === "user" ? "User" : "Assistant");
      if (message.status) doc.font("body").fontSize(9).text(message.status);
      gap(); body();
      if (message.quote) { rich([{ text: message.quote, italic: true }], 16); gap(); }
      const tree: MdNode = parser.parse(message.text);
      const definitions = new Map<string, string>();
      const validate = (node: MdNode, depth: number): void => {
        if (++nodes > PDF_LIMITS.nodes || depth > PDF_LIMITS.depth) throw pdfTooLarge();
        if (node.type === "definition" && node.identifier && node.url) definitions.set(node.identifier.toLowerCase(), node.url);
        if (node.type === "table" && ((node.children?.length ?? 0) > PDF_LIMITS.tableRows
          || node.children?.some((r) => (r.children?.length ?? 0) > PDF_LIMITS.columns))) throw pdfTooLarge();
        node.children?.forEach((n) => validate(n, depth + 1));
      };
      validate(tree, 0);
      const ownedImage = (url: string | undefined): PdfAttachment | undefined => {
        // Match only known message-bound routes. Never interpret URL authority,
        // local paths, data URLs or arbitrary upload IDs as a file to load.
        if (!url?.startsWith("/api/v1/")) return undefined;
        return message.attachments.find((a) => {
          const path = a.origin === "upload" ? `/api/v1/uploads/${encodeURIComponent(a.id)}/content`
            : `/api/v1/threads/`;
          if (a.origin === "upload") return url.split("?", 1)[0] === path;
          const match = /^\/api\/v1\/threads\/([^/]+)\/messages\/([^/]+)\/reply-attachments\/([^/?]+)\/content(?:\?|$)/u.exec(url);
          try { return match !== null && decodeURIComponent(match[1]!) === a.threadId
            && decodeURIComponent(match[2]!) === a.messageId && decodeURIComponent(match[3]!) === a.id; } catch { return false; }
        });
      };
      const inline = (node: MdNode, style: Omit<Run, "text"> = {}): Run[] => {
        switch (node.type) {
          case "text": return [{ text: node.value ?? "", ...style }];
          case "inlineCode": return [{ text: node.value ?? "", ...style, mono: true }];
          case "break": return [{ text: "\n", ...style }];
          case "strong": return (node.children ?? []).flatMap((n) => inline(n, { ...style, bold: true }));
          case "emphasis": return (node.children ?? []).flatMap((n) => inline(n, { ...style, italic: true }));
          case "delete": return (node.children ?? []).flatMap((n) => inline(n, { ...style, strike: true }));
          case "link": case "linkReference": return (node.children ?? []).flatMap((n) => inline(n,
            { ...style, link: safeLink(node.url ?? definitions.get(node.identifier?.toLowerCase() ?? "")) }));
          case "image": case "imageReference": {
            const a = ownedImage(node.url ?? definitions.get(node.identifier?.toLowerCase() ?? ""));
            // Images render below the paragraph in a clean document flow.
            return [{ text: `[Image: ${node.alt || a?.name || "unavailable"}]`, ...style }];
          }
          case "html": return []; // Never export active HTML or hidden markup.
          default: return (node.children ?? []).flatMap((n) => inline(n, style));
        }
      };
      const block = (node: MdNode, indent = 0): void => {
        body();
        switch (node.type) {
          case "root": node.children?.forEach((n) => block(n, indent)); break;
          case "paragraph": rich((node.children ?? []).flatMap((n) => inline(n)), indent); gap(); break;
          case "heading": doc.fontSize(19 - Math.min(node.depth ?? 1, 6));
            rich((node.children ?? []).flatMap((n) => inline(n, { bold: true })), indent); gap(); break;
          case "code": doc.font("mono").fontSize(9).text(node.value ?? "", 48 + indent, doc.y,
            { width: width - indent, lineGap: 2 }); gap(); break;
          case "blockquote": node.children?.forEach((n) => block(n, indent + 16)); break;
          case "list": node.children?.forEach((n, i) => {
            const mark = n.checked !== undefined && n.checked !== null ? n.checked ? "[x]" : "[ ]"
              : node.ordered ? `${(node.start ?? 1) + i}.` : "•";
            rich([{ text: mark }], indent);
            doc.moveUp(); n.children?.forEach((child) => block(child, indent + 20));
          }); break;
          case "table": {
            const rows = node.children ?? [];
            doc.font("body").fontSize(9);
            doc.table({ position: { x: 48 + indent, y: doc.y }, maxWidth: width - indent,
              defaultStyle: { border: 0.5, borderColor: "#d0d5da", padding: 5 },
              data: rows.map((row, i) => (row.children ?? []).map((cell) => ({ text: plain(cell),
                font: { family: i === 0 ? "bold" : "body", size: 9 }, backgroundColor: i === 0 ? "#eef1f4" : "#ffffff" }))) });
            gap(); break;
          }
          case "thematicBreak": doc.moveTo(48 + indent, doc.y).lineTo(48 + width, doc.y).strokeColor("#d0d5da").stroke(); gap(); break;
          case "definition": case "html": break;
          default: if (node.children) node.children.forEach((n) => block(n, indent)); else if (node.value) { rich([{ text: node.value }], indent); gap(); }
        }
      };
      block(tree);
      // Attachment names are always retained, including attachments-only replies.
      for (const a of message.attachments) image(a);
      gap();
    }
    doc.end();
  } catch (error) { doc.destroy(error instanceof Error ? error : new Error("PDF rendering failed.")); }
  return finished;
}
