const INLINE_CODE_PATTERN = /`[^`\n]+`/gu;
const FENCED_CODE_PATTERN = /```[\s\S]*?```/gu;
const MARKDOWN_LINK_PATTERN = /(?<!!)\[([^\]\n]+)\]\(([^)\s]+)\)/gu;
const TOKEN_PREFIX = "\uE000";
const TOKEN_SUFFIX = "\uE001";

let nextTokenNamespace = 0;

export function formatMarkdownForSlack(text: string): string {
  return replaceProtectedSegments(text, FENCED_CODE_PATTERN, formatMarkdownChunk);
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

function formatMarkdownInline(text: string): string {
  return replaceProtectedSegments(text, INLINE_CODE_PATTERN, formatMarkdownPlainInline);
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

function escapeSlackText(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
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
