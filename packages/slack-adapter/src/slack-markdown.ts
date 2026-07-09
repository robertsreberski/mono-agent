const INLINE_CODE_PATTERN = /`[^`\n]+`/gu;
const FENCED_CODE_PATTERN = /```[\s\S]*?```/gu;
const MARKDOWN_LINK_PATTERN = /(?<!!)\[([^\]\n]+)\]\(([^)\s]+)\)/gu;
const SLACK_LINK_PATTERN = /<((?:https?:\/\/|mailto:)[^>|]+)(?:\|([^>\n]+))?>/gu;
const TOKEN_PREFIX = "\uE000";
const TOKEN_SUFFIX = "\uE001";

let nextTokenNamespace = 0;

export function formatMarkdownForSlack(text: string): string {
  return replaceProtectedSegments(text, FENCED_CODE_PATTERN, formatMarkdownChunk);
}

export function normalizeSlackMarkdownToMarkdown(text: string): string {
  return replaceProtectedSegments(
    text.replace(/\u00a0/gu, " "),
    FENCED_CODE_PATTERN,
    normalizeSlackMarkdownChunk,
  ).trim();
}

function formatMarkdownChunk(text: string): string {
  return text
    .split("\n")
    .map((line) => formatMarkdownLine(line))
    .join("\n");
}

function formatMarkdownLine(line: string): string {
  const quote = /^(>+\s?)(.*)$/u.exec(line);
  if (quote !== null) {
    return `${quote[1] ?? ">"}${formatMarkdownInline(quote[2] ?? "")}`;
  }

  const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
  if (heading !== null) {
    const headingText = formatMarkdownInline(heading[2] ?? "");
    return `*${trimSlackBoldDelimiters(headingText)}*`;
  }

  return formatMarkdownInline(line);
}

function normalizeSlackMarkdownChunk(text: string): string {
  return text
    .split("\n")
    .map((line) => normalizeSlackMarkdownLine(line))
    .join("\n");
}

function normalizeSlackMarkdownLine(line: string): string {
  return normalizeSlackMarkdownInline(normalizeSlackBulletLine(line));
}

function formatMarkdownInline(text: string): string {
  return replaceProtectedSegments(text, INLINE_CODE_PATTERN, formatMarkdownPlainInline);
}

function normalizeSlackMarkdownInline(text: string): string {
  return replaceProtectedSegments(text, INLINE_CODE_PATTERN, normalizeSlackPlainInline);
}

function formatMarkdownPlainInline(text: string): string {
  const tokenStore = createTokenStore();
  const withLinkTokens = text.replace(
    MARKDOWN_LINK_PATTERN,
    (_match, rawLabel: string, rawUrl: string) => tokenStore.tokenFor(slackLink(rawUrl, rawLabel)),
  );

  const formatted = withLinkTokens
    .replace(/\*\*([^*\n]+?)\*\*/gu, (_match, content: string) => tokenStore.tokenFor(`*${content}*`))
    .replace(/__([^_\n]+?)__/gu, (_match, content: string) => tokenStore.tokenFor(`*${content}*`))
    .replace(/~~([^~\n]+?)~~/gu, "~$1~")
    .replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/gu, "_$1_");

  return tokenStore.restore(escapeSlackText(formatted));
}

function normalizeSlackPlainInline(text: string): string {
  const tokenStore = createTokenStore();
  const withLinkTokens = text.replace(
    SLACK_LINK_PATTERN,
    (_match, rawUrl: string, rawLabel: string | undefined) => {
      const url = decodeSlackText(rawUrl);
      if (rawLabel === undefined || rawLabel.length === 0) {
        return tokenStore.tokenFor(url);
      }
      return tokenStore.tokenFor(markdownLink(url, decodeSlackText(rawLabel)));
    },
  );

  const formatted = withLinkTokens
    .replace(/\*([^*\n]+?)\*/gu, (_match, content: string) => tokenStore.tokenFor(`**${content}**`))
    .replace(/(?<!\w)_([^_\n]+?)_(?!\w)/gu, (_match, content: string) => tokenStore.tokenFor(`*${content}*`))
    .replace(/~([^~\n]+?)~/gu, (_match, content: string) => tokenStore.tokenFor(`~~${content}~~`));

  return tokenStore.restore(decodeSlackText(formatted));
}

function replaceProtectedSegments(
  text: string,
  pattern: RegExp,
  formatUnprotected: (chunk: string) => string,
): string {
  const tokenStore = createTokenStore();
  const protectedText = text.replace(pattern, (match) => tokenStore.tokenFor(match));
  return tokenStore.restore(formatUnprotected(protectedText));
}

function slackLink(rawUrl: string, rawLabel: string): string {
  return `<${escapeSlackText(rawUrl)}|${escapeSlackLinkLabel(rawLabel)}>`;
}

function markdownLink(rawUrl: string, rawLabel: string): string {
  const label = rawLabel.replace(/\\/gu, "\\\\").replace(/\]/gu, "\\]");
  const url = rawUrl.replace(/\)/gu, "%29");
  return `[${label}](${url})`;
}

function escapeSlackText(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function decodeSlackText(text: string): string {
  return text
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

function escapeSlackLinkLabel(text: string): string {
  return escapeSlackText(text).replace(/\|/gu, "&#124;");
}

function createTokenStore(): {
  tokenFor(value: string): string;
  restore(text: string): string;
} {
  const namespace = nextTokenNamespace;
  nextTokenNamespace += 1;
  const tokens: string[] = [];

  return {
    tokenFor(value: string): string {
      const token = `${TOKEN_PREFIX}${namespace}:${tokens.length}${TOKEN_SUFFIX}`;
      tokens.push(value);
      return token;
    },
    restore(text: string): string {
      let restored = text;
      for (let index = 0; index < tokens.length; index += 1) {
        restored = restored.replaceAll(`${TOKEN_PREFIX}${namespace}:${index}${TOKEN_SUFFIX}`, tokens[index] ?? "");
      }
      return restored;
    },
  };
}

function trimSlackBoldDelimiters(text: string): string {
  return text.startsWith("*") && text.endsWith("*") && text.length >= 2
    ? text.slice(1, -1)
    : text;
}

function normalizeSlackBulletLine(line: string): string {
  const bullet = /^([ \t]*)([\u2022\u25e6])\s*(.*)$/u.exec(line);
  if (bullet === null) {
    return line;
  }
  return `${bullet[1] ?? ""}- ${bullet[3] ?? ""}`;
}
