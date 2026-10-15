const INLINE_CODE_PATTERN = /`[^`\n]+`/gu;
const FENCED_CODE_PATTERN = /```[\s\S]*?```/gu;
const SLACK_LINK_PATTERN = /<((?:https?:\/\/|mailto:)[^>|]+)(?:\|([^>\n]+))?>/gu;
/**
 * Slack's non-link angle tokens: `<@U…>` users, `<#C…>` channels, and `<!…>`
 * specials (`here`, `channel`, `subteam^S…`, `date^…`). Cannot collide with
 * {@link SLACK_LINK_PATTERN}, which matches only `http(s):`/`mailto:` targets.
 */
const SLACK_MENTION_TOKEN = /<([@#!])([^>|\s]*)(?:\|([^>\n]*))?>/gu;
const SLACK_SELF_MENTION_TOKEN = /<@([^>|\s]+)(?:\|[^>\n]*)?>/gu;
const HORIZONTAL_WHITESPACE = /[ \t\u00a0]/u;
const TOKEN_PREFIX = "\uE000";
const TOKEN_SUFFIX = "\uE001";

/** Slack caps user/profile names at 80 characters. */
export const SLACK_BOT_USER_NAME_MAX_LENGTH = 80;

let nextTokenNamespace = 0;

export function formatMarkdownForSlack(text: string): string {
  return replaceProtectedSegments(text, FENCED_CODE_PATTERN, formatMarkdownChunk);
}

export function normalizeSlackMarkdownToMarkdown(text: string): string {
  return replaceProtectedSegments(
    text,
    FENCED_CODE_PATTERN,
    normalizeSlackMarkdownChunk,
  ).trim();
}

/**
 * Rewrites Slack's angle-bracket mention tokens into the text a human reads, so
 * a third party mentioned in a message reaches the model as `@Alice` rather than
 * the opaque `<@U08ABC>`.
 *
 * Resolution is purely local: it uses the label Slack already inlines after `|`
 * and never calls the Web API, so it costs no request and needs no extra scope.
 * A bare `<@U08ABC>` with no inline label degrades to `@U08ABC` -- still an
 * improvement over the raw token, and the opt-in user directory upgrades it to a
 * real display name.
 */
export function renderSlackMentionTokens(text: string): string {
  return replaceProtectedSegments(text, FENCED_CODE_PATTERN, (chunk) =>
    replaceProtectedSegments(chunk, INLINE_CODE_PATTERN, renderMentionTokenChunk));
}

/**
 * Accept only a bounded, token-safe authenticated Slack username before it can
 * become model-visible mention text.
 */
export function normalizeSlackBotUserName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > SLACK_BOT_USER_NAME_MAX_LENGTH
    || /[\s<>`]/u.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

interface SlackSelfMentionSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: "id" | "alias";
  readonly matchedId?: string;
  readonly aliasOrder: number;
}

/**
 * Preserve one readable self-address marker while removing duplicate forms.
 * Protected Markdown code is opaque to identity matching.
 */
export function preserveSlackSelfMentionText(
  text: string,
  options: {
    readonly botUserIds: readonly string[];
    readonly mentionTextAliases: readonly string[];
    readonly botUserName?: string;
  },
): string {
  const knownBotUserIds = new Set(
    options.botUserIds
      .map((userId) => userId.trim().toLowerCase())
      .filter((userId) => userId.length > 0),
  );
  const aliases = options.mentionTextAliases
    .filter((alias) => alias.length > 0);
  const botUserName = normalizeSlackBotUserName(options.botUserName);

  return replaceProtectedSegments(text, FENCED_CODE_PATTERN, (withoutFencedCode) =>
    replaceProtectedSegments(withoutFencedCode, INLINE_CODE_PATTERN, (unprotected) => {
      const spans = collectSlackSelfMentionSpans(unprotected, knownBotUserIds, aliases);
      if (spans.length === 0) {
        return unprotected;
      }

      const projection = replaceSlackSelfMentionSpans(unprotected, spans);
      if (projection.trim().length === 0) {
        return projection;
      }

      const first = spans[0]!;
      const marker = first.kind === "alias"
        ? unprotected.slice(first.start, first.end)
        : `@${botUserName ?? first.matchedId!}`;
      return replaceSlackSelfMentionSpans(unprotected, spans, marker);
    }));
}

function collectSlackSelfMentionSpans(
  text: string,
  knownBotUserIds: ReadonlySet<string>,
  aliases: readonly string[],
): readonly SlackSelfMentionSpan[] {
  const candidates: SlackSelfMentionSpan[] = [];
  for (const match of text.matchAll(SLACK_SELF_MENTION_TOKEN)) {
    const matchedId = match[1];
    if (matchedId === undefined || !knownBotUserIds.has(matchedId.toLowerCase())) {
      continue;
    }
    candidates.push({
      start: match.index,
      end: match.index + match[0].length,
      kind: "id",
      matchedId,
      aliasOrder: -1,
    });
  }
  aliases.forEach((alias, aliasOrder) => {
    let start = text.indexOf(alias);
    while (start !== -1) {
      candidates.push({ start, end: start + alias.length, kind: "alias", aliasOrder });
      start = text.indexOf(alias, start + alias.length);
    }
  });
  candidates.sort((left, right) =>
    left.start - right.start
    || (left.kind === right.kind ? left.aliasOrder - right.aliasOrder : left.kind === "id" ? -1 : 1));

  const spans: SlackSelfMentionSpan[] = [];
  for (const candidate of candidates) {
    const previous = spans.at(-1);
    if (previous === undefined || candidate.start >= previous.end) {
      spans.push(candidate);
    }
  }
  return spans;
}

function replaceSlackSelfMentionSpans(
  text: string,
  spans: readonly SlackSelfMentionSpan[],
  firstMarker?: string,
): string {
  let output = "";
  let cursor = 0;
  spans.forEach((span, index) => {
    output += text.slice(cursor, span.start);
    if (index === 0 && firstMarker !== undefined) {
      output += firstMarker;
      cursor = span.end;
      return;
    }

    const rightRunEnd = horizontalWhitespaceRunEnd(text, span.end);
    const existingHardBreak = rightRunEnd - span.end >= 2 && isNewline(text[rightRunEnd]);
    cursor = HORIZONTAL_WHITESPACE.test(text[span.start - 1] ?? "")
      && HORIZONTAL_WHITESPACE.test(text[span.end] ?? "")
      ? span.end + 1
      : span.end;
    if (!existingHardBreak && isNewline(text[cursor])) {
      output = collapseTrailingHorizontalWhitespace(output);
    }
  });
  return output + text.slice(cursor);
}

function horizontalWhitespaceRunEnd(text: string, start: number): number {
  let end = start;
  while (HORIZONTAL_WHITESPACE.test(text[end] ?? "")) {
    end += 1;
  }
  return end;
}

function isNewline(value: string | undefined): boolean {
  return value === "\n" || value === "\r";
}

function collapseTrailingHorizontalWhitespace(text: string): string {
  const match = /[ \t\u00a0]+$/u.exec(text);
  if (match === null || match[0].length < 2) {
    return text;
  }
  return `${text.slice(0, match.index)} `;
}

function renderMentionTokenChunk(text: string): string {
  return text.replace(SLACK_MENTION_TOKEN, (match, sigil: string, body: string, label?: string) => {
    const inline = label?.trim();
    if (sigil === "#") {
      // Channel labels already read as names; a bare id has no local rendering.
      return inline === undefined || inline.length === 0 ? `#${body}` : `#${inline}`;
    }
    if (sigil === "@") {
      return inline === undefined || inline.length === 0 ? `@${body}` : `@${inline}`;
    }
    // `<!…>` specials. `here`/`channel`/`everyone` are broadcast keywords;
    // `subteam^S…` and `date^…` carry their human form in the inline label.
    if (inline !== undefined && inline.length > 0) {
      return inline.startsWith("@") ? inline : `@${inline}`;
    }
    const special = body.split("^")[0] ?? body;
    return special === "" ? match : `@${special}`;
  });
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
  const withLinkTokens = replaceMarkdownLinks(
    text,
    (rawUrl, rawLabel) => tokenStore.tokenFor(slackLink(rawUrl, rawLabel)),
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
  const withLinkTokens = text.replace(/\u00a0/gu, " ").replace(
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

function replaceMarkdownLinks(
  text: string,
  replaceLink: (rawUrl: string, rawLabel: string) => string,
): string {
  let formatted = "";
  let cursor = 0;

  while (cursor < text.length) {
    const linkStart = text.indexOf("[", cursor);
    if (linkStart === -1) {
      return `${formatted}${text.slice(cursor)}`;
    }

    const link = parseMarkdownLink(text, linkStart);
    if (link === undefined) {
      formatted += text.slice(cursor, linkStart + 1);
      cursor = linkStart + 1;
      continue;
    }

    formatted += `${text.slice(cursor, linkStart)}${replaceLink(link.url, link.label)}`;
    cursor = link.end;
  }

  return formatted;
}

function parseMarkdownLink(
  text: string,
  linkStart: number,
): { readonly label: string; readonly url: string; readonly end: number } | undefined {
  if (text[linkStart - 1] === "!") {
    return undefined;
  }

  const labelEnd = text.indexOf("]", linkStart + 1);
  if (labelEnd === -1 || labelEnd === linkStart + 1 || text[labelEnd + 1] !== "(") {
    return undefined;
  }

  const label = text.slice(linkStart + 1, labelEnd);
  if (label.includes("\n")) {
    return undefined;
  }

  const urlStart = labelEnd + 2;
  let parenthesisDepth = 0;
  let url = "";
  for (let index = urlStart; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (/\s/u.test(character)) {
      return undefined;
    }
    if (character === "\\") {
      const escapedCharacter = text[index + 1];
      if (escapedCharacter === "(" || escapedCharacter === ")" || escapedCharacter === "\\") {
        url += escapedCharacter;
        index += 1;
        continue;
      }
      url += character;
      continue;
    }
    if (character === "(") {
      parenthesisDepth += 1;
      url += character;
      continue;
    }
    if (character !== ")") {
      url += character;
      continue;
    }
    if (parenthesisDepth > 0) {
      parenthesisDepth -= 1;
      url += character;
      continue;
    }
    if (index === urlStart) {
      return undefined;
    }
    return { label, url, end: index + 1 };
  }

  return undefined;
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
  const url = rawUrl.replace(/\(/gu, "%28").replace(/\)/gu, "%29");
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
      // Reverse creation order: a nested construct (a link inside bold) stores
      // the inner token inside the outer token's payload, so the outer (later)
      // token must be expanded first or the inner one survives as a leaked
      // U+E000/U+E001 sentinel in delivered text.
      for (let index = tokens.length - 1; index >= 0; index -= 1) {
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
  const bullet = /^([ \t\u00a0]*)([\u2022\u25e6])\s*(.*)$/u.exec(line);
  if (bullet === null) {
    return line;
  }
  return `${(bullet[1] ?? "").replace(/\u00a0/gu, " ")}- ${bullet[3] ?? ""}`;
}
