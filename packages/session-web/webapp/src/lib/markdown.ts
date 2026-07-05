// Tiny markdown -> inline-styled HTML — ported verbatim from the mock's
// `esc` / `mdInline` / `md` (Session Recorder.dc.html lines ~497-520).
// Rendered through React.createElement + dangerouslySetInnerHTML, exactly like
// the prototype's `mdEl`, so the output styling is pixel-identical.

import { createElement, type CSSProperties, type ReactElement } from "react";
import { FONT_MONO } from "./tokens";

export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function mdInline(input: string): string {
  let s = esc(input);
  s = s.replace(
    /`([^`]+)`/g,
    `<code style="font-family:${FONT_MONO};background:rgba(255,255,255,.08);padding:1px 5px;border-radius:4px;font-size:.88em;color:#D9C9A8;overflow-wrap:anywhere;word-break:break-word">$1</code>`,
  );
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    `<a href="$2" target="_blank" rel="noopener" style="color:#7FB0E4;text-decoration:underline;overflow-wrap:anywhere;word-break:break-word">$1</a>`,
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, `<strong style="font-weight:600;color:#F2F0EA">$1</strong>`);
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, `$1<em style="color:#DAD7D0">$2</em>`);
  return s;
}

export function md(src: string): string {
  if (!src) return "";
  const lines = String(src).split("\n");
  let html = "";
  let lt: "ul" | "ol" | null = null;
  const close = () => {
    if (lt) {
      html += "</" + lt + ">";
      lt = null;
    }
  };
  for (const raw of lines) {
    if (/^\s*$/.test(raw)) {
      close();
      html += '<div style="height:7px"></div>';
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = raw.match(/^(#{1,4})\s+(.*)$/))) {
      close();
      const lvl = m[1].length;
      const sz = lvl <= 1 ? 17 : lvl === 2 ? 15 : 13;
      html +=
        '<div style="font-weight:600;font-size:' +
        sz +
        'px;color:#F2F0EA;margin:9px 0 3px">' +
        mdInline(m[2]) +
        "</div>";
      continue;
    }
    if ((m = raw.match(/^\s*[-*]\s+(.*)$/))) {
      if (lt !== "ul") {
        close();
        html += '<ul style="margin:4px 0;padding-left:19px">';
        lt = "ul";
      }
      html += '<li style="margin:3px 0">' + mdInline(m[1]) + "</li>";
      continue;
    }
    if ((m = raw.match(/^\s*\d+\.\s+(.*)$/))) {
      if (lt !== "ol") {
        close();
        html += '<ol style="margin:4px 0;padding-left:19px">';
        lt = "ol";
      }
      html += '<li style="margin:3px 0">' + mdInline(m[1]) + "</li>";
      continue;
    }
    close();
    html += "<div>" + mdInline(raw) + "</div>";
  }
  close();
  return html;
}

/** Rendered markdown block — the React equivalent of the mock's `mdEl`. */
export function Markdown({ src, style }: { src: string; style?: CSSProperties }): ReactElement {
  return createElement("div", {
    style: { overflowWrap: "anywhere", wordBreak: "break-word", ...(style || {}) },
    dangerouslySetInnerHTML: { __html: md(src) },
  });
}
