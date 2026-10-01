import type { RichBlock, RichText } from "grammy/types";

import type { TelegramMessage } from "./types.js";

const TELEGRAM_RICH_MAX_CODE_POINTS = 32_768;
const TELEGRAM_RICH_MAX_BLOCKS = 500;
const TELEGRAM_RICH_MAX_DEPTH = 16;
const TELEGRAM_RICH_MAX_NODES = 8_192;
const TELEGRAM_RICH_MAX_TABLE_COLUMNS = 20;
const TELEGRAM_RICH_MAX_VISIBLE_URL_CODE_POINTS = 2_048;
const TELEGRAM_RICH_TRUNCATION_MARKER = "… [Telegram rich message truncated]";

interface ProjectionState {
  blockCount: number;
  nodeCount: number;
  truncated: boolean;
  readonly active: WeakSet<object>;
}

class BoundedTextWriter {
  readonly #chunks: string[] = [];
  #codePoints = 0;

  constructor(
    private readonly state: ProjectionState,
    private readonly maximum = TELEGRAM_RICH_MAX_CODE_POINTS,
  ) {}

  get empty(): boolean {
    return this.#codePoints === 0;
  }

  get exhausted(): boolean {
    return this.#codePoints >= this.maximum;
  }

  append(value: string): void {
    if (value.length === 0 || this.exhausted) {
      if (value.length > 0) this.state.truncated = true;
      return;
    }
    let previousWasCarriageReturn = false;
    for (const character of value) {
      if (this.#codePoints >= this.maximum) {
        this.state.truncated = true;
        break;
      }
      if (character === "\r") {
        this.#chunks.push("\n");
        this.#codePoints += 1;
        previousWasCarriageReturn = true;
        continue;
      }
      if (character === "\n" && previousWasCarriageReturn) {
        previousWasCarriageReturn = false;
        continue;
      }
      previousWasCarriageReturn = false;
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint === 0x2028 || codePoint === 0x2029) {
        this.#chunks.push("\n");
        this.#codePoints += 1;
      } else if (character === "\n" || character === "\t" || (codePoint >= 32 && codePoint !== 127)) {
        this.#chunks.push(character);
        this.#codePoints += 1;
      }
    }
  }

  finish(): string {
    return this.#chunks.join("").trim();
  }
}

/**
 * Project Telegram's inbound native rich-message tree to bounded visible text.
 * Only schema-defined visible fields are visited: media payloads, file ids and
 * unknown metadata are deliberately ignored.
 */
export function telegramMessageText(message: TelegramMessage): string {
  const plainText = (message.text ?? message.caption)?.trim();
  if (plainText !== undefined && plainText.length > 0) return plainText;

  const richMessage = message.rich_message;
  if (!isRecord(richMessage) || !Array.isArray(richMessage.blocks)) return "";

  const state: ProjectionState = {
    blockCount: 0,
    nodeCount: 0,
    truncated: false,
    active: new WeakSet<object>(),
  };
  const writer = new BoundedTextWriter(state);
  try {
    renderBlocks(richMessage.blocks, writer, state, 0);
  } catch {
    state.truncated = true;
  }
  return finishProjection(writer.finish(), state.truncated);
}

function renderBlocks(
  blocks: readonly RichBlock[] | readonly unknown[],
  writer: BoundedTextWriter,
  state: ProjectionState,
  depth: number,
): void {
  if (!enterValue(blocks, state, depth)) return;
  try {
    let renderedAny = false;
    for (const block of blocks) {
      if (writer.exhausted || !consumeBlock(state)) break;
      const fragmentWriter = new BoundedTextWriter(state);
      renderBlock(block, fragmentWriter, state, depth);
      const fragment = fragmentWriter.finish();
      if (fragment.length === 0) continue;
      if (renderedAny) writer.append("\n\n");
      writer.append(fragment);
      renderedAny = true;
    }
  } finally {
    leaveValue(blocks, state);
  }
}

function renderBlock(
  value: RichBlock | unknown,
  writer: BoundedTextWriter,
  state: ProjectionState,
  depth: number,
): void {
  if (!isRecord(value) || !enterValue(value, state, depth)) return;
  try {
    switch (value.type) {
      case "paragraph":
      case "pre":
      case "footer":
      case "thinking":
        renderRichText(value.text, writer, state, depth + 1);
        return;
      case "heading": {
        const size = typeof value.size === "number" && value.size >= 1 && value.size <= 6
          ? Math.trunc(value.size)
          : 1;
        writer.append(`${"#".repeat(size)} `);
        renderRichText(value.text, writer, state, depth + 1);
        return;
      }
      case "divider":
        writer.append("---");
        return;
      case "mathematical_expression":
        if (typeof value.expression === "string") writer.append(`$$${value.expression}$$`);
        return;
      case "anchor":
        return;
      case "list":
        renderList(value.items, writer, state, depth + 1);
        return;
      case "blockquote":
        renderBlockQuote(value.blocks, value.credit, writer, state, depth + 1);
        return;
      case "pullquote":
        renderRichText(value.text, writer, state, depth + 1);
        renderCredit(value.credit, writer, state, depth + 1);
        return;
      case "collage":
      case "slideshow":
        if (Array.isArray(value.blocks)) renderBlocks(value.blocks, writer, state, depth + 1);
        renderCaption(value.caption, writer, state, depth + 1);
        return;
      case "table":
        renderTable(value.caption, value.cells, writer, state, depth + 1);
        return;
      case "details":
        writer.append("Details: ");
        renderRichText(value.summary, writer, state, depth + 1);
        if (Array.isArray(value.blocks)) {
          const nested = new BoundedTextWriter(state);
          renderBlocks(value.blocks, nested, state, depth + 1);
          const body = nested.finish();
          if (body.length > 0) {
            writer.append("\n");
            writer.append(body);
          }
        }
        return;
      case "map":
      case "animation":
      case "audio":
      case "photo":
      case "video":
      case "voice_note":
        renderCaption(value.caption, writer, state, depth + 1);
        return;
      default:
        return;
    }
  } finally {
    leaveValue(value, state);
  }
}

function renderList(
  value: unknown,
  writer: BoundedTextWriter,
  state: ProjectionState,
  depth: number,
): void {
  if (!Array.isArray(value) || !enterValue(value, state, depth)) return;
  try {
    let renderedAny = false;
    for (const item of value) {
      if (writer.exhausted || !consumeBlock(state)) break;
      if (!isRecord(item) || !enterValue(item, state, depth)) continue;
      try {
        const nested = new BoundedTextWriter(state);
        if (Array.isArray(item.blocks)) renderBlocks(item.blocks, nested, state, depth + 1);
        const body = nested.finish();
        const labelWriter = new BoundedTextWriter(state);
        if (typeof item.label === "string") labelWriter.append(item.label);
        const label = labelWriter.finish() || "-";
        const checkbox = item.has_checkbox === true ? (item.is_checked === true ? "[x] " : "[ ] ") : "";
        if (body.length === 0 && label === "-") continue;
        if (renderedAny) writer.append("\n");
        writer.append(`${checkbox}${label}`);
        if (body.length > 0) {
          writer.append(" ");
          writer.append(indentContinuationLines(body, "  "));
        }
        renderedAny = true;
      } finally {
        leaveValue(item, state);
      }
    }
  } finally {
    leaveValue(value, state);
  }
}

function renderTable(
  caption: unknown,
  cells: unknown,
  writer: BoundedTextWriter,
  state: ProjectionState,
  depth: number,
): void {
  renderRichText(caption, writer, state, depth);
  if (!Array.isArray(cells) || !enterValue(cells, state, depth)) return;
  try {
    let renderedRows = false;
    for (const row of cells) {
      if (writer.exhausted || !consumeBlock(state)) break;
      if (!Array.isArray(row) || !enterValue(row, state, depth)) continue;
      try {
        if (row.length > TELEGRAM_RICH_MAX_TABLE_COLUMNS) state.truncated = true;
        const cellTexts: string[] = [];
        for (const cell of row.slice(0, TELEGRAM_RICH_MAX_TABLE_COLUMNS)) {
          if (!isRecord(cell)) {
            cellTexts.push("");
            continue;
          }
          const cellWriter = new BoundedTextWriter(state);
          renderRichText(cell.text, cellWriter, state, depth + 1);
          cellTexts.push(cellWriter.finish().replace(/\s*\n\s*/gu, " "));
        }
        if (cellTexts.length === 0) continue;
        if (!writer.empty || renderedRows) writer.append("\n");
        writer.append(cellTexts.join(" | "));
        renderedRows = true;
      } finally {
        leaveValue(row, state);
      }
    }
  } finally {
    leaveValue(cells, state);
  }
}

function renderBlockQuote(
  blocks: unknown,
  credit: unknown,
  writer: BoundedTextWriter,
  state: ProjectionState,
  depth: number,
): void {
  if (Array.isArray(blocks)) {
    const nested = new BoundedTextWriter(state);
    renderBlocks(blocks, nested, state, depth);
    const body = nested.finish();
    if (body.length > 0) writer.append(body.split("\n").map((line) => `> ${line}`).join("\n"));
  }
  renderCredit(credit, writer, state, depth);
}

function renderCaption(
  value: unknown,
  writer: BoundedTextWriter,
  state: ProjectionState,
  depth: number,
): void {
  if (!isRecord(value)) return;
  if (!writer.empty) writer.append("\n");
  renderRichText(value.text, writer, state, depth);
  renderCredit(value.credit, writer, state, depth);
}

function renderCredit(
  value: unknown,
  writer: BoundedTextWriter,
  state: ProjectionState,
  depth: number,
): void {
  if (value === undefined) return;
  const creditWriter = new BoundedTextWriter(state);
  renderRichText(value, creditWriter, state, depth);
  const credit = creditWriter.finish();
  if (credit.length === 0) return;
  if (!writer.empty) writer.append("\n");
  writer.append(`Credit: ${credit}`);
}

function renderRichText(
  value: RichText | unknown,
  writer: BoundedTextWriter,
  state: ProjectionState,
  depth: number,
): void {
  if (writer.exhausted || !consumeNode(state)) return;
  if (typeof value === "string") {
    writer.append(value);
    return;
  }
  if (Array.isArray(value)) {
    if (!enterValue(value, state, depth)) return;
    try {
      for (const part of value) {
        if (writer.exhausted) break;
        renderRichText(part, writer, state, depth + 1);
      }
    } finally {
      leaveValue(value, state);
    }
    return;
  }
  if (!isRecord(value) || !enterValue(value, state, depth)) return;
  try {
    switch (value.type) {
      case "bold":
      case "italic":
      case "underline":
      case "strikethrough":
      case "spoiler":
      case "date_time":
      case "text_mention":
      case "subscript":
      case "superscript":
      case "marked":
      case "code":
      case "email_address":
      case "phone_number":
      case "bank_card_number":
      case "mention":
      case "hashtag":
      case "cashtag":
      case "bot_command":
      case "anchor_link":
      case "reference":
      case "reference_link":
        renderRichText(value.text, writer, state, depth + 1);
        return;
      case "url": {
        renderRichText(value.text, writer, state, depth + 1);
        const target = visibleUrl(value.url);
        if (target !== undefined && value.text !== target) {
          writer.append(` (${target})`);
        }
        return;
      }
      case "custom_emoji":
        if (typeof value.alternative_text === "string") writer.append(value.alternative_text);
        return;
      case "mathematical_expression":
        if (typeof value.expression === "string") writer.append(`$${value.expression}$`);
        return;
      case "anchor":
      default:
        return;
    }
  } finally {
    leaveValue(value, state);
  }
}

function enterValue(value: object, state: ProjectionState, depth: number): boolean {
  if (depth > TELEGRAM_RICH_MAX_DEPTH || state.active.has(value)) {
    state.truncated = true;
    return false;
  }
  state.active.add(value);
  return true;
}

function leaveValue(value: object, state: ProjectionState): void {
  state.active.delete(value);
}

function consumeBlock(state: ProjectionState): boolean {
  if (state.blockCount >= TELEGRAM_RICH_MAX_BLOCKS) {
    state.truncated = true;
    return false;
  }
  state.blockCount += 1;
  return true;
}

function consumeNode(state: ProjectionState): boolean {
  if (state.nodeCount >= TELEGRAM_RICH_MAX_NODES) {
    state.truncated = true;
    return false;
  }
  state.nodeCount += 1;
  return true;
}

function visibleUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const points: string[] = [];
  for (const point of value) {
    if (points.length >= TELEGRAM_RICH_MAX_VISIBLE_URL_CODE_POINTS) return undefined;
    const codePoint = point.codePointAt(0) ?? 0;
    if (codePoint < 33 || codePoint === 127 || codePoint === 0x2028 || codePoint === 0x2029) {
      return undefined;
    }
    points.push(point);
  }
  if (points.length === 0) return undefined;
  const target = points.join("");
  return /^https?:\/\/[^\s]+$/iu.test(target) ? target : undefined;
}

function indentContinuationLines(value: string, indent: string): string {
  return value.replace(/\n/gu, `\n${indent}`);
}

function finishProjection(value: string, truncated: boolean): string {
  if (!truncated) return value;
  const marker = value.length === 0
    ? TELEGRAM_RICH_TRUNCATION_MARKER
    : `\n${TELEGRAM_RICH_TRUNCATION_MARKER}`;
  const markerPoints = Array.from(marker);
  const valuePoints = Array.from(value);
  return `${valuePoints.slice(0, TELEGRAM_RICH_MAX_CODE_POINTS - markerPoints.length).join("")}${marker}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
