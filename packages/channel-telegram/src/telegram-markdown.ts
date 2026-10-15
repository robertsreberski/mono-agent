import gfm from "remark-gfm";
import parse from "remark-parse";
import stringify from "remark-stringify";
import stringWidth from "string-width";
import telegramify from "telegramify-markdown";
import unified from "unified";

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  identifier?: string;
  children?: MarkdownNode[];
}

/**
 * Render a Markdown string into the MarkdownV2 dialect Telegram accepts with
 * `parse_mode: "MarkdownV2"`.
 *
 * Telegram MarkdownV2 has no table entity. GFM tables are therefore converted to compact,
 * monospaced tables before the general MarkdownV2 conversion. Cell formatting
 * is flattened to its visible text, while link and image destinations are kept
 * in parentheses so the conversion does not discard useful content.
 *
 * Everything else delegates to `telegramify-markdown`, which parses Markdown
 * with remark and re-serializes it as MarkdownV2 with every reserved character
 * escaped. Unlike a regex converter it cannot emit overlapping or unbalanced
 * entities that Telegram's parser rejects, so the stream's plain-text fallback
 * is reserved for genuinely exceptional input rather than ordinary formatting.
 *
 * The `"escape"` strategy keeps other constructs Telegram cannot render as
 * escaped literal text instead of dropping them. telegramify appends a trailing
 * newline; it is stripped so callers receive the trimmed shape the rest of the
 * delivery pipeline expects.
 */
export function renderTelegramMarkdown(markdown: string): string {
  const withRenderableTables = replaceTablesWithCodeBlocks(markdown);
  return telegramify(withRenderableTables, "escape").replace(/\n+$/u, "");
}

/** Replace parsed GFM table nodes without mistaking pipe-like prose or code for tables. */
function replaceTablesWithCodeBlocks(markdown: string): string {
  if (!markdown.includes("|")) {
    return markdown;
  }

  const processor = unified().use(parse).use(gfm).use(stringify);
  const tree = processor.parse(markdown);
  if (!replaceTableNodes(tree as MarkdownNode)) {
    return markdown;
  }

  return processor.stringify(tree).replace(/\n+$/u, "");
}

function replaceTableNodes(node: MarkdownNode): boolean {
  if (node.children === undefined) {
    return false;
  }

  let replaced = false;
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (child === undefined) {
      continue;
    }
    if (child.type === "table") {
      node.children[index] = {
        type: "code",
        value: renderCodeTable(child),
      };
      replaced = true;
      continue;
    }
    replaced = replaceTableNodes(child) || replaced;
  }
  return replaced;
}

function renderCodeTable(table: MarkdownNode): string {
  const rows = (table.children ?? [])
    .filter((child) => child.type === "tableRow")
    .map((row) => (row.children ?? []).map(renderTableCell));
  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  if (columnCount === 0) {
    return "";
  }

  for (const row of rows) {
    while (row.length < columnCount) {
      row.push("");
    }
  }

  const widths = Array.from({ length: columnCount }, (_, columnIndex) =>
    Math.max(3, ...rows.map((row) => displayWidth(row[columnIndex] ?? ""))),
  );
  const formatRow = (row: string[]): string =>
    row
      .map((cell, columnIndex) => padDisplayWidth(cell, widths[columnIndex] ?? 3))
      .join(" │ ")
      .trimEnd();
  const separator = widths.map((width) => "─".repeat(width)).join("─┼─");
  const [header, ...body] = rows;

  return [formatRow(header ?? []), separator, ...body.map(formatRow)].join("\n");
}

function renderTableCell(cell: MarkdownNode): string {
  return visibleText(cell)
    .replace(/\s+/gu, " ")
    .trim();
}

function visibleText(node: MarkdownNode): string {
  if (node.type === "image") {
    return destinationText(node.alt ?? "", node.url);
  }
  if (node.type === "link") {
    return destinationText(childrenText(node), node.url);
  }
  if (node.type === "break") {
    return " ";
  }
  if (node.value !== undefined) {
    return node.value;
  }
  if (node.children !== undefined) {
    return childrenText(node);
  }
  return node.identifier ?? "";
}

function childrenText(node: MarkdownNode): string {
  return (node.children ?? []).map(visibleText).join("");
}

function destinationText(label: string, destination: string | undefined): string {
  if (destination === undefined || destination.length === 0 || destination === label) {
    return label || destination || "";
  }
  return label.length === 0 ? destination : `${label} (${destination})`;
}

function displayWidth(value: string): number {
  return stringWidth(value);
}

function padDisplayWidth(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - stringWidth(value)));
}
