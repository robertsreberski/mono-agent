// @ts-check
// Adapted from hound-mcp 13.2.0 trafilatura_extractor.py:48-105,130-156,
// 199-250 and extractor.py:96-114. Copyright (c) 2026 Bishesh Bhandari (MIT).
// Full attribution/license: package-root THIRD_PARTY_NOTICES.md.
// Native parser equivalents, not a Python wrapper or trafilatura port.
import { Readability } from "@mozilla/readability";
import { Defuddle as parseDefuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { markdownToText } from "../web-markdown-text.js";
import { sanitizeDocumentLinks } from "./links.js";

const NOISE = "script,style,noscript,template,svg";
const CHROME = 'nav,header,footer,aside,[role="navigation"],[role="menu"],[role="menubar"]';

function htmlDocument(html: any) {
  let { document } = parseHTML(html);
  if ((!document.documentElement || !document.body?.innerHTML?.trim()) && html.trim()) {
    ({ document } = parseHTML(`<html><body>${html}</body></html>`));
  }
  return document;
}

function cleanedDocument(html: any, url: any) {
  const document = htmlDocument(html);
  for (const node of document.querySelectorAll(NOISE)) node.remove();
  sanitizeDocumentLinks(document, url);
  return document;
}

/** Local title/staged extraction with native JS parser equivalents
 * (algorithms adapted from the upstream sources above).
 * Parser overrides are a source-level fixture seam, never tool/config input.
 */
export async function extractLocalHtml(html: any, url: any, {
  primary = async (document: any, sourceUrl: any) => parseDefuddle(document, sourceUrl, { markdown: true, separateMarkdown: true, useAsync: false }),
  article = (document: any) => new Readability(document).parse(),
}: { primary?: (document: any, sourceUrl: any) => Promise<import("defuddle/node").DefuddleResponse>; article?: (document: any) => { title: string | null | undefined; content: string | null | undefined; textContent: string | null | undefined; length: number | null | undefined; excerpt: string | null | undefined; byline: string | null | undefined; dir: string | null | undefined; siteName: string | null | undefined; lang: string | null | undefined; publishedTime: string | null | undefined } | null } = {}): Promise<{ markdown: any; title: string; stage: any; failures: any[] }> {
  const source = String(html || "");
  const initial = cleanedDocument(source, url);
  let title = String(initial.querySelector("title")?.textContent || "").trim();
  const region = initial.querySelector('article,main,[role="main"]');
  const regionChars = meaningful(region?.textContent || "");
  const failures: any[] = [];
  const finish = (markdown: any, stage: any) => ({ markdown, title, stage, failures: [...failures] });
  const useful = (markdown: any) => {
    const chars = meaningful(markdown);
    // Don't reject genuinely short pages. Only reject a tiny candidate when
    // the source actually has a substantially larger main-content region.
    return chars > 0 && !(regionChars >= 200 && chars < Math.min(80, regionChars / 4));
  };
  try {
    const parsed = await primary(((cleanedDocument(source, url)) as any), url);
    const markdown = String(parsed.contentMarkdown || parsed.content || "").trim();
    if (useful(markdown)) {
      title = String(parsed.title || title).trim();
      return finish(markdown, "defuddle");
    }
  } catch { /* Try the next native parser; never hide total extraction failure. */ }
  failures.push("defuddle");
  try {
    const parsed = await article(((cleanedDocument(source, url)) as any));
    if (parsed) {
      title ||= String(parsed.title || "").trim();
      const markdown = htmlToMarkdown(parsed.content || "", url);
      if (useful(markdown)) return finish(markdown, "readability");
    }
  } catch { /* Continue to bounded DOM fallback. */ }
  failures.push("readability");
  try {
    const document = cleanedDocument(source, url);
    for (const node of document.querySelectorAll(CHROME)) node.remove();
    const main = document.querySelector('article,main,[role="main"]');
    const markdown = htmlToMarkdown(main?.innerHTML || document.body?.innerHTML || "", url);
    if (meaningful(markdown)) return finish(markdown, main ? "main" : "body");
  } catch { /* Total failure is reported below, not raw HTML as Markdown. */ }
  failures.push("body");
  throw Object.assign(new Error(`HTML extraction failed after ${failures.join(", ")}.`), {
    code: "extraction_failed", parserFailures: failures,
  });
}

function meaningful(value: any) {
  return markdownToText(value).replace(/\s/gu, "").length;
}

export function htmlToMarkdown(html: any, url: any): string {
  const document = cleanedDocument(String(html || ""), url);
  return markdownConverter().turndown(document.body?.innerHTML || "").trim();
}

function markdownConverter(tables: boolean = true) {
  const service = new TurndownService({ bulletListMarker: "-", codeBlockStyle: "fenced", emDelimiter: "_", strongDelimiter: "**" });
  if (tables) service.addRule("semanticTables", {
    filter: ["table" as never],
    replacement(_content: string, node: Parameters<TurndownService.ReplacementFunction>[1]) {
      const rows = Array.from(node.querySelectorAll("tr")).map((row: any) => Array.from(row.children)
        .filter((cell: any) => ["TH", "TD"].includes(cell.tagName))
        .map((cell: any) => markdownConverter(false).turndown(cell.innerHTML).trim()
          .replace(/\|/gu, "\\|").replace(/\n+/gu, "<br>")))
        .filter((row: string[]) => row.length);
      if (!rows.length) return "";
      const width = Math.max(...rows.map((row: string[]) => row.length));
      const formatRow = (row: any) => `| ${Array.from({ length: width }, (_: any, i: number) => row[i] || "").join(" | ")} |`;
      return `\n\n${[formatRow(rows[0]), formatRow(Array(width).fill("---")), ...rows.slice(1).map(formatRow)].join("\n")}\n\n`;
    },
  });
  return service;
}
