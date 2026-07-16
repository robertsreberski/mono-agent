// Tiny markdown -> inline-styled HTML, based on the mock's `esc` / `mdInline` /
// `md` (Session Recorder.dc.html lines ~497-520). Generated code/link fragments
// stay opaque to later formatting passes so input can never rewrite tag attrs.
// React.createElement + dangerouslySetInnerHTML retains the prototype styling.

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

function inlineFragmentStore(source: string): {
  readonly restore: (value: string) => string;
  readonly stash: (fragment: string) => string;
} {
  const tokenPattern = /\0 mono-agent-inline:(\d+) \0/gu;
  const occupiedIds = new Set([...source.matchAll(tokenPattern)].map((match) => match[1]));
  const fragments = new Map<string, string>();
  let nextId = 0;
  const restore = (value: string): string => value.replace(
    tokenPattern,
    (token) => fragments.get(token) ?? token,
  );
  return {
    stash(fragment) {
      let id = String(nextId);
      nextId += 1;
      while (occupiedIds.has(id)) {
        id = String(nextId);
        nextId += 1;
      }
      const token = `\0 mono-agent-inline:${id} \0`;
      occupiedIds.add(id);
      fragments.set(token, restore(fragment));
      return token;
    },
    restore,
  };
}

function formatEmphasis(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/g, `<strong style="font-weight:600;color:#F2F0EA">$1</strong>`)
    .replace(/(^|[^*])\*([^*\n]+)\*/g, `$1<em style="color:#DAD7D0">$2</em>`);
}

export function mdInline(input: string): string {
  let s = esc(input);
  const fragments = inlineFragmentStore(s);
  s = s.replace(
    /`([^`]+)`/g,
    (_match, code: string) => fragments.stash(
      `<code style="font-family:${FONT_MONO};background:rgba(255,255,255,.08);padding:1px 5px;border-radius:4px;font-size:.88em;color:#D9C9A8;overflow-wrap:anywhere;word-break:break-word">${code}</code>`,
    ),
  );
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_match, label: string, href: string) => fragments.stash(
      `<a href="${href}" target="_blank" rel="noopener" style="color:#7FB0E4;text-decoration:underline;overflow-wrap:anywhere;word-break:break-word">${formatEmphasis(label)}</a>`,
    ),
  );
  return fragments.restore(formatEmphasis(s));
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
