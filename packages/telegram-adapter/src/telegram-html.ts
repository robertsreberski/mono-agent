/**
 * Convert a common Markdown subset into the small HTML subset that Telegram's
 * Bot API accepts with `parse_mode: "HTML"`.
 *
 * The conversion is intentionally conservative. Callers MUST fall back to
 * sending the original plain text when Telegram rejects the rendered HTML
 * (`can't parse entities`), so this never has to be perfect — only good enough
 * for the common cases: bold, italic, strikethrough, inline code, fenced code,
 * links, headings, lists, and blockquotes.
 *
 * Telegram's supported tags are a flat allowlist (b/strong, i/em, u/ins,
 * s/strike/del, a, code, pre, blockquote, tg-spoiler); arbitrary or deeply
 * nested HTML is not allowed. Anything this converter cannot express it leaves
 * as escaped text rather than risking malformed markup.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

/** Escape the three characters Telegram HTML reserves: `&`, `<`, `>`. */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/[&<>]/g, (character) => HTML_ESCAPES[character] ?? character);
}

// A visible, collision-proof token that stands in for already-rendered code
// while the surrounding Markdown is processed. The `[[…]]` form cannot appear
// in real model output, survives HTML escaping (no reserved chars), is not
// matched by the link regex (no following parenthesis group), and the bracket
// delimiters bound the index so an adjacent digit can never extend it.
const CODE_TOKEN_PATTERN = /\[\[TGCODE(\d+)\]\]/g;

function codeToken(index: number): string {
  return `[[TGCODE${index}]]`;
}

/**
 * Render a Markdown string into Telegram-flavored HTML. When the input has no
 * formatting that needs escaping or tags, the returned string is identical to
 * the input — callers use that equality to decide whether `parse_mode` is even
 * required.
 */
export function renderTelegramHtml(markdown: string): string {
  const blocks: string[] = [];
  const protect = (html: string): string => {
    const token = codeToken(blocks.length);
    blocks.push(html);
    return token;
  };

  let text = markdown.replace(/\r\n/g, "\n");

  // Protect fenced code blocks first so their contents are never treated as
  // Markdown or split across lines.
  text = text.replace(
    /```([^\n`]*)\n?([\s\S]*?)```/g,
    (_match, rawLanguage: string, body: string) => {
      const language = rawLanguage.trim().replace(/[^A-Za-z0-9_+-]/g, "");
      const escaped = escapeTelegramHtml(body.replace(/\n$/, ""));
      const html =
        language.length > 0
          ? `<pre><code class="language-${language}">${escaped}</code></pre>`
          : `<pre>${escaped}</pre>`;
      return protect(html);
    },
  );

  // Protect inline code spans next.
  text = text.replace(/`([^`\n]+)`/g, (_match, body: string) =>
    protect(`<code>${escapeTelegramHtml(body)}</code>`),
  );

  const rendered = text
    .split("\n")
    .map((line) => renderLine(line))
    .join("\n");

  // Restore protected code, keyed by index.
  return rendered.replace(
    CODE_TOKEN_PATTERN,
    (_match, index: string) => blocks[Number(index)] ?? "",
  );
}

function renderLine(rawLine: string): string {
  const heading = /^#{1,6}\s+(.*)$/.exec(rawLine);
  if (heading?.[1] !== undefined) {
    return `<b>${renderInline(heading[1])}</b>`;
  }

  const quote = /^>\s?(.*)$/.exec(rawLine);
  if (quote?.[1] !== undefined) {
    return `<blockquote>${renderInline(quote[1])}</blockquote>`;
  }

  const unordered = /^(\s*)[-*+]\s+(.*)$/.exec(rawLine);
  if (unordered?.[2] !== undefined) {
    return `${unordered[1] ?? ""}• ${renderInline(unordered[2])}`;
  }

  const ordered = /^(\s*)(\d+)\.\s+(.*)$/.exec(rawLine);
  if (ordered?.[3] !== undefined) {
    return `${ordered[1] ?? ""}${ordered[2] ?? ""}. ${renderInline(ordered[3])}`;
  }

  if (/^\s*([-*_])\1{2,}\s*$/.test(rawLine)) {
    return "———";
  }

  return renderInline(rawLine);
}

function renderInline(text: string): string {
  let value = escapeTelegramHtml(text);

  // Links: [label](url). Escaping already ran, so a reserved char in the URL is
  // already an entity, which is correct for an HTML attribute value.
  value = value.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_match, label: string, url: string) => `<a href="${url}">${label}</a>`,
  );

  // Bold before italic so a double-asterisk run is consumed before single.
  value = value.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  value = value.replace(/__([^_]+)__/g, "<b>$1</b>");
  value = value.replace(/~~([^~]+)~~/g, "<s>$1</s>");

  // Italic: a single asterisk/underscore pair not adjacent to another marker.
  value = value.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
  value = value.replace(/(^|[^_A-Za-z0-9])_([^_\n]+)_(?![_A-Za-z0-9])/g, "$1<i>$2</i>");

  return value;
}
