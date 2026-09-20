// @ts-check
import { markdownToText, collapseDocumentText } from "./web-markdown-text.js";
export { markdownToText } from "./web-markdown-text.js";

import { XMLValidator } from "fast-xml-parser";
import { DOMParser } from "linkedom";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";
import { extractHoundHtml } from "./hound-local/extract.js";
export { extractHtmlLinks, MAX_WEB_FETCH_LINKS, MAX_WEB_FETCH_LINK_URL_CHARS, MAX_WEB_FETCH_LINK_TEXT_CHARS } from "./hound-local/links.js";

export const MAX_STRUCTURED_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MARKDOWN_MIME_TYPES = new Set([
  "application/markdown",
  "application/x-markdown",
  "text/markdown",
  "text/md",
  "text/vnd.daringfireball.markdown",
  "text/x-markdown",
]);

export function contentKind(contentType, bytes) {
  const mime = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (mime === "application/pdf" || Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-") return "pdf";
  if (mime.includes("json") || mime.endsWith("+json")) return "json";
  if (mime.includes("xml") || mime.includes("rss") || mime.includes("atom") || mime.endsWith("+xml")) return "xml";
  if (mime.includes("html")) return "html";
  if (MARKDOWN_MIME_TYPES.has(mime)) return "markdown";
  if (mime.startsWith("text/") || [
    "application/ecmascript", "application/graphql", "application/javascript", "application/rtf",
    "application/sql", "application/x-httpd-php", "application/x-yaml", "application/yaml",
  ].includes(mime)) return "text";
  if (["", "application/octet-stream", "application/binary", "binary/octet-stream"].includes(mime)) {
    if (looksLikeHtml(bytes)) return "html";
    if (looksLikeXml(bytes)) return "xml";
    if (looksLikeJson(bytes)) return "json";
    if (!looksBinary(bytes)) return "text";
  }
  return "binary";
}

export function decodeWebBytes(bytes, contentType, kind = contentKind(contentType, bytes)) {
  const bom = detectBom(bytes);
  const header = charsetFromContentType(contentType);
  const declaration = header === undefined && (kind === "html" || kind === "xml")
    ? charsetFromDeclaration(bytes, kind)
    : undefined;
  const selected = bom ?? header ?? declaration ?? { charset: "utf-8", source: "default" };
  let text;
  try {
    text = new TextDecoder(selected.charset, { fatal: false }).decode(bytes.subarray(selected.offset ?? 0));
  } catch {
    throw extractionError("unsupported_charset", `Unsupported declared charset: ${selected.charset}.`);
  }
  return {
    text,
    charset: selected.charset,
    charsetSource: selected.source,
    hadDecodingReplacement: text.includes("\uFFFD"),
  };
}

export async function extractWebDocument(bytes, { contentType, format, url }) {
  const kind = contentKind(contentType, bytes);
  const decoded = decodeWebBytes(bytes, contentType, kind);
  if (format === "raw") return { body: decoded.text, readableText: decoded.text, title: "", extractionStage: "raw", parserFailureCount: 0, parserFailures: [], kind, ...decoded };
  if (["html", "json", "xml"].includes(kind) && bytes.byteLength > MAX_STRUCTURED_DOCUMENT_BYTES) {
    throw extractionError("parser_input_too_large", `Structured document exceeded ${MAX_STRUCTURED_DOCUMENT_BYTES} bytes.`);
  }
  if (kind === "pdf") return { ...(await extractPdf(bytes)), kind, ...decoded };
  if (kind === "markdown") {
    const readableText = markdownToText(decoded.text);
    return {
      body: format === "text" ? readableText : decoded.text,
      readableText,
      title: "",
      extractionStage: "markdown",
      parserFailureCount: 0,
      parserFailures: [],
      kind,
      ...decoded,
    };
  }
  if (kind === "json") {
    let parsed;
    try { parsed = JSON.parse(decoded.text); }
    catch { throw extractionError("invalid_json", "Response declared JSON but was malformed."); }
    const pretty = JSON.stringify(parsed, null, 2);
    return { body: format === "markdown" ? `\`\`\`json\n${pretty}\n\`\`\`` : pretty, readableText: pretty, title: "", extractionStage: "json", parserFailureCount: 0, parserFailures: [], kind, ...decoded };
  }
  if (kind === "xml") return { ...extractXml(decoded.text, format, url), kind, ...decoded };
  if (kind === "html") return { ...(await extractHtml(decoded.text, url, format)), kind, ...decoded };
  const body = collapseDocumentText(decoded.text);
  return { body, readableText: body, title: "", extractionStage: "text", parserFailureCount: 0, parserFailures: [], kind, ...decoded };
}

async function extractPdf(bytes) {
  const pdf = await getDocumentProxy(bytes);
  try {
    const extracted = await extractPdfText(pdf, { mergePages: true });
    const body = String(extracted.text || "").trim();
    if (!body) throw extractionError("extraction_failed", "PDF contained no readable text.");
    return { body, readableText: body, title: "", extractionStage: "pdf", parserFailureCount: 0, parserFailures: [] };
  } finally {
    try { await /** @type {any} */ (pdf).destroy?.(); } catch { /* best effort */ }
  }
}

async function extractHtml(html, url, format) {
  const extracted = await extractHoundHtml(html, url);
  return finishHtml(extracted.markdown, extracted.title, format, extracted.stage, extracted.failures);
}

function finishHtml(markdown, title, format, stage, failures) {
  const readableText = markdownToText(markdown);
  const body = format === "text"
    ? readableText
    : title && !markdown.trimStart().startsWith(`# ${title}`) ? `# ${title}\n\n${markdown}` : markdown;
  return { body, readableText, title, extractionStage: stage, parserFailureCount: failures.length, parserFailures: failures };
}

function extractXml(xml, format, url) {
  if (XMLValidator.validate(String(xml || "")) !== true) {
    throw extractionError("invalid_xml", "Response declared XML but was malformed.");
  }
  const document = new DOMParser().parseFromString(String(xml || ""), "text/xml");
  if (!document?.documentElement || document.querySelector("parsererror")) {
    throw extractionError("invalid_xml", "Response declared XML but was malformed.");
  }
  const entries = [...document.querySelectorAll("item, entry")].slice(0, 50);
  if (entries.length === 0) {
    const body = collapseDocumentText(document.documentElement.textContent || "");
    if (!body) throw extractionError("extraction_failed", "XML document contained no readable text.");
    return { body, readableText: body, title: "", extractionStage: "xml", parserFailureCount: 0, parserFailures: [] };
  }
  const blocks = entries.map((entry) => {
    const title = collapseWhitespace(entry.querySelector("title")?.textContent) || "Untitled";
    const linkElement = entry.querySelector("link");
    const link = safeUrl(linkElement?.getAttribute("href") || collapseWhitespace(linkElement?.textContent), url);
    const description = collapseWhitespace(entry.querySelector("description, summary, content")?.textContent);
    if (format === "text") return [title, link, description].filter(Boolean).join("\n");
    return [`## ${escapeMarkdownLabel(title)}`, link ? `[${escapeMarkdownLabel(link)}](${link})` : "", description].filter(Boolean).join("\n\n");
  });
  const body = blocks.join("\n\n");
  return { body, readableText: markdownToText(body), title: "", extractionStage: "xml", parserFailureCount: 0, parserFailures: [] };
}


function safeUrl(value, base) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const parsed = new URL(value, base);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
    return parsed.href;
  } catch { return ""; }
}

function detectBom(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { charset: "utf-8", source: "bom", offset: 3 };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { charset: "utf-16le", source: "bom", offset: 2 };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { charset: "utf-16be", source: "bom", offset: 2 };
  return undefined;
}

function charsetFromContentType(value) {
  const match = String(value || "").match(/charset\s*=\s*["']?([^;"'\s]+)/iu);
  return match ? { charset: match[1].toLowerCase(), source: "header" } : undefined;
}

function charsetFromDeclaration(bytes, kind) {
  const sample = Buffer.from(bytes.subarray(0, 4096)).toString("latin1");
  const match = kind === "html"
    ? sample.match(/<meta[^>]+charset\s*=\s*["']?([^\s"'/>]+)/iu)
      ?? sample.match(/<meta[^>]+content=["'][^"']*charset=([^\s"';]+)/iu)
    : sample.match(/^\s*<\?xml[^>]+encoding=["']([^"']+)["']/iu);
  return match ? { charset: match[1].toLowerCase(), source: kind === "html" ? "html_meta" : "xml_declaration" } : undefined;
}

function looksLikeHtml(bytes) {
  return /^\s*(?:<!doctype html|<html|<head|<body)/iu.test(Buffer.from(bytes.subarray(0, 512)).toString("utf8"));
}

function looksLikeXml(bytes) {
  return /^\s*(?:<\?xml\b|<(?:rss|feed|rdf:RDF)\b)/iu.test(Buffer.from(bytes.subarray(0, 512)).toString("utf8"));
}

function looksLikeJson(bytes) {
  return /^[\s\uFEFF]*[\[{]/u.test(Buffer.from(bytes.subarray(0, 512)).toString("utf8"));
}

function looksBinary(bytes) {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 1024));
  if (sample.byteLength === 0) return false;
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 0x20 && ![0x09, 0x0a, 0x0c, 0x0d].includes(byte)) controls += 1;
  }
  return controls / sample.byteLength > 0.1;
}

export function shouldAutoRender(readableText, html) {
  if (meaningfulCharacters(readableText) >= 200) return false;
  const scriptCount = (html.match(/<script\b/giu) || []).length;
  const hasAppRoot = /<(?:div|main)[^>]+(?:id|class)=["'][^"']*(?:app|root|__next|nuxt|svelte)[^"']*["']/iu.test(html);
  const hasSpaAssets = /\b(?:webpack|__NEXT_DATA__|vite|hydration|data-reactroot)\b/iu.test(html);
  return scriptCount >= 2 && (hasAppRoot || hasSpaAssets);
}

function meaningfulCharacters(value) { return markdownToText(value).replace(/\s/gu, "").length; }

function collapseWhitespace(value) { return String(value || "").replace(/\s+/gu, " ").trim(); }
function escapeMarkdownLabel(value) { return collapseWhitespace(value).replace(/[[\]\\]/gu, "\\$&"); }
function extractionError(code, message, details = {}) { return Object.assign(new Error(message), { code, ...details }); }
