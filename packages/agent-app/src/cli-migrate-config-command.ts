import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { RETIRED_CONFIG_FIELDS } from "@mono-agent/config";

import type { ParsedCliArgs } from "./cli-args.js";
import * as ui from "./ui.js";

type JsonObject = Record<string, unknown>;

const DEFAULT_CONFIG_FILE = "mono-agent.config.json";

const RETIRED_MESSAGE_BY_PATH: Map<string, string> = new Map(
  RETIRED_CONFIG_FIELDS.map((field) => [field.path, field.message]),
);

const FALLBACK_MODELS_PATH = "runtime.fallbackModels";

/**
 * Removed runtime backends whose model references must never be guessed: a
 * mechanical rewrite would point the agent at a different auth store than the
 * operator meant, so each is reported for a human to resolve.
 */
const NON_PI_REF_PREFIXES = [
  "codex:",
  "claude:",
  "claude-code:",
  "codex-cli:",
  "acp:",
  "vercel:",
] as const;

export type MigrateChange =
  | { readonly kind: "delete"; readonly pointer: string; readonly before: string; readonly message: string }
  | { readonly kind: "rewrite"; readonly pointer: string; readonly before: string; readonly after: string }
  | { readonly kind: "rename"; readonly pointer: string; readonly before: string; readonly after: string; readonly message: string };

export interface ManualMigration {
  readonly pointer: string;
  readonly value: string;
}

export interface MigrateConfigResult {
  readonly skipped: boolean;
  readonly skippedReason: string | undefined;
  readonly conflict: string | undefined;
  readonly changed: boolean;
  readonly output: string;
  readonly changes: readonly MigrateChange[];
  readonly manualMigrations: readonly ManualMigration[];
}

type CanonicalizeDecision =
  | { readonly kind: "manual" }
  | { readonly kind: "rewrite"; readonly after: string }
  | { readonly kind: "unchanged" };

interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

interface JsonNode {
  readonly kind: "object" | "array" | "string" | "number" | "boolean" | "null";
  readonly start: number;
  readonly end: number;
  readonly members?: readonly JsonMember[];
  readonly items?: readonly JsonNode[];
}

interface JsonMember {
  readonly key: string;
  readonly keyStart: number;
  readonly keyEnd: number;
  readonly value: JsonNode;
  /** Index of the trailing comma, or -1 when this is the object's last member. */
  readonly commaIndex: number;
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function jsonEncode(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Canonicalize one model reference: strip a leading `pi:`, refuse to guess a
 * removed non-Pi backend, and leave everything else alone.
 */
function canonicalizeModelRef(raw: string): CanonicalizeDecision {
  const stripped = raw.startsWith("pi:") ? raw.slice("pi:".length) : raw;
  const nonPi = NON_PI_REF_PREFIXES.find((prefix) => stripped.startsWith(prefix));
  if (nonPi !== undefined) {
    return { kind: "manual" };
  }
  if (raw.startsWith("pi:")) {
    return { kind: "rewrite", after: stripped };
  }
  return { kind: "unchanged" };
}

/**
 * Parse a JSON document's syntax just far enough to record the source span of
 * every key and value. `JSON.parse` already validated the text, so this only
 * needs to skip tokens; string *decoding* is delegated back to `JSON.parse`
 * on demand for keys, keeping escape handling out of this scanner.
 */
function scanJson(source: string): JsonNode {
  let index = 0;

  const char = (offset: number): string => source[offset] ?? "";

  function skipWhitespace(): void {
    while (index < source.length && /[\t\n\r ]/u.test(char(index))) {
      index += 1;
    }
  }

  function parseString(): JsonNode {
    const start = index;
    index += 1; // opening quote
    while (index < source.length) {
      const c = char(index);
      if (c === '"') {
        index += 1;
        break;
      }
      if (c === "\\") {
        if (char(index + 1) === "u") {
          index += 6;
        } else {
          index += 2;
        }
        continue;
      }
      index += 1;
    }
    return { kind: "string", start, end: index };
  }

  function parseValue(): JsonNode {
    skipWhitespace();
    const start = index;
    const c = char(index);
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "t" || c === "f") {
      index += c === "t" ? 4 : 5;
      return { kind: "boolean", start, end: index };
    }
    if (c === "n") {
      index += 4;
      return { kind: "null", start, end: index };
    }
    while (index < source.length && /[-+0-9.eE]/u.test(char(index))) {
      index += 1;
    }
    return { kind: "number", start, end: index };
  }

  function parseObject(): JsonNode {
    const start = index;
    index += 1; // {
    const members: JsonMember[] = [];
    skipWhitespace();
    if (char(index) !== "}") {
      while (index < source.length) {
        skipWhitespace();
        const keyNode = parseString();
        const key = JSON.parse(source.slice(keyNode.start, keyNode.end)) as string;
        const keyStart = keyNode.start;
        const keyEnd = keyNode.end;
        skipWhitespace();
        index += 1; // colon
        const value = parseValue();
        skipWhitespace();
        let commaIndex = -1;
        if (char(index) === ",") {
          commaIndex = index;
          index += 1;
          skipWhitespace();
        }
        members.push({ key, keyStart, keyEnd, value, commaIndex });
        if (char(index) === "}") {
          index += 1;
          break;
        }
      }
    } else {
      index += 1;
    }
    return { kind: "object", start, end: index, members };
  }

  function parseArray(): JsonNode {
    const start = index;
    index += 1; // [
    const items: JsonNode[] = [];
    skipWhitespace();
    if (char(index) !== "]") {
      while (index < source.length) {
        skipWhitespace();
        items.push(parseValue());
        skipWhitespace();
        if (char(index) === ",") {
          index += 1;
          skipWhitespace();
          continue;
        }
        if (char(index) === "]") {
          index += 1;
          break;
        }
      }
    } else {
      index += 1;
    }
    return { kind: "array", start, end: index, items };
  }

  return parseValue();
}

/** The member (with its sibling list and position) at a dot-separated path, if any. */
function locateMember(node: JsonNode, path: readonly string[]): { readonly member: JsonMember; readonly index: number; readonly siblings: readonly JsonMember[] } | undefined {
  let current = node;
  for (let i = 0; i < path.length; i += 1) {
    if (current.kind !== "object") return undefined;
    const members = current.members ?? [];
    const index = members.findIndex((member) => member.key === path[i]);
    if (index === -1) return undefined;
    const member = members[index]!;
    if (i === path.length - 1) {
      return { member, index, siblings: members };
    }
    current = member.value;
  }
  return undefined;
}

/** The value node at a dot-separated path, if any. */
function locateValue(node: JsonNode, path: readonly string[]): JsonNode | undefined {
  let current = node;
  for (const key of path) {
    if (current.kind !== "object") return undefined;
    const member = (current.members ?? []).find((entry) => entry.key === key);
    if (member === undefined) return undefined;
    current = member.value;
  }
  return current;
}

/** Back up over the whitespace that precedes a key on its own line, including the newline. */
function lineStartOf(source: string, index: number): number {
  let i = index;
  while (i > 0 && (source[i - 1] === " " || source[i - 1] === "\t")) {
    i -= 1;
  }
  if (i > 0 && source[i - 1] === "\n") {
    i -= 1;
    if (i > 0 && source[i - 1] === "\r") i -= 1;
  }
  return i;
}

function mergeRanges(ranges: readonly { readonly start: number; readonly end: number }[]): { readonly start: number; readonly end: number }[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

/**
 * Byte ranges to remove for a set of deleted members. Deleted middle members
 * drop their line plus trailing comma; a deleted last member drops the comma of
 * the nearest preceding *kept* member, so a run ending at the object's tail
 * never leaves a dangling comma on the member that becomes last. Overlapping
 * ranges are merged before application.
 */
function computeDeletionRanges(
  source: string,
  members: readonly JsonMember[],
  deletedKeys: ReadonlySet<string>,
): readonly { readonly start: number; readonly end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  members.forEach((member, index) => {
    if (!deletedKeys.has(member.key)) return;
    if (member.commaIndex >= 0) {
      ranges.push({ start: lineStartOf(source, member.keyStart), end: member.commaIndex + 1 });
      return;
    }
    let previous = index - 1;
    while (previous >= 0 && deletedKeys.has(members[previous]!.key)) {
      previous -= 1;
    }
    if (previous >= 0) {
      ranges.push({ start: members[previous]!.commaIndex, end: member.value.end });
    } else {
      ranges.push({ start: lineStartOf(source, member.keyStart), end: member.value.end });
    }
  });
  return mergeRanges(ranges);
}

/** Compute and record the deletion edits and `delete` changes for one object's retired keys. */
function applyMemberDeletions(
  source: string,
  members: readonly JsonMember[],
  pointerPrefix: string,
  parsedObject: JsonObject,
  deletedKeys: ReadonlySet<string>,
  edits: TextEdit[],
  changes: MigrateChange[],
): void {
  if (deletedKeys.size === 0) return;
  for (const range of computeDeletionRanges(source, members, deletedKeys)) {
    edits.push({ start: range.start, end: range.end, replacement: "" });
  }
  for (const member of members) {
    if (!deletedKeys.has(member.key)) continue;
    changes.push({
      kind: "delete",
      pointer: `${pointerPrefix}${member.key}`,
      before: jsonEncode(parsedObject[member.key]),
      message: RETIRED_MESSAGE_BY_PATH.get(`${pointerPrefix}${member.key}`) ?? "",
    });
  }
}

/** The indentation (spaces/tabs) immediately preceding a position on the same line. */
function lineIndentBefore(source: string, index: number): string {
  let i = index;
  while (i > 0 && (source[i - 1] === " " || source[i - 1] === "\t")) {
    i -= 1;
  }
  return source.slice(i, index);
}

/**
 * Detect the object indentation used by the source so generated blocks (the
 * converted `fallbacks` array) keep the operator's indent width.
 */
function detectIndent(source: string): string {
  for (const line of source.split("\n")) {
    const match = /^([ \t]+)"/u.exec(line);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return "  ";
}

/** Render the `runtime.fallbacks` array, written at `keyIndent`, following the source's inline/multi-line style. */
function renderFallbacksArray(
  models: readonly unknown[],
  keyIndent: string,
  indentUnit: string,
  inline: boolean,
): string {
  if (inline) {
    return `[${models.map((model) => `{ "model": ${JSON.stringify(model)} }`).join(", ")}]`;
  }
  if (models.length === 0) {
    return "[]";
  }
  const itemIndent = keyIndent + indentUnit;
  const modelIndent = itemIndent + indentUnit;
  const lines = models.map((model, index) => {
    const comma = index < models.length - 1 ? "," : "";
    return `${itemIndent}{\n${modelIndent}"model": ${JSON.stringify(model)}\n${itemIndent}}${comma}`;
  });
  return `[\n${lines.join("\n")}\n${keyIndent}]`;
}

function applyEdits(source: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let output = source;
  for (const edit of sorted) {
    output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
  }
  return output;
}

/** Rewrite one model-reference string value in place, recording the change (or refusing). */
function editModelString(
  member: JsonMember,
  pointer: string,
  value: unknown,
  edits: TextEdit[],
  changes: MigrateChange[],
  manual: ManualMigration[],
): void {
  if (typeof value !== "string") return;
  const decision = canonicalizeModelRef(value);
  if (decision.kind === "manual") {
    manual.push({ pointer, value });
    return;
  }
  if (decision.kind === "rewrite") {
    const valueNode = member.value;
    edits.push({ start: valueNode.start, end: valueNode.end, replacement: JSON.stringify(decision.after) });
    changes.push({ kind: "rewrite", pointer, before: jsonEncode(value), after: jsonEncode(decision.after) });
  }
}

function editExistingFallbacks(
  member: JsonMember,
  parsedFallbacks: unknown,
  edits: TextEdit[],
  changes: MigrateChange[],
  manual: ManualMigration[],
): void {
  const arrayNode = member.value;
  if (arrayNode.kind !== "array") return;
  const parsedItems = Array.isArray(parsedFallbacks) ? parsedFallbacks : [];
  (arrayNode.items ?? []).forEach((itemNode, index) => {
    if (itemNode.kind !== "object") return;
    const modelMember = (itemNode.members ?? []).find((entry) => entry.key === "model");
    if (modelMember === undefined) return;
    const parsedItem = asObject(parsedItems[index]);
    if (parsedItem === undefined) return;
    editModelString(
      modelMember,
      `runtime.fallbacks[${index}].model`,
      parsedItem.model,
      edits,
      changes,
      manual,
    );
  });
}

function editFallbackModelsRename(
  source: string,
  member: JsonMember,
  parsedFallbackModels: unknown,
  edits: TextEdit[],
  changes: MigrateChange[],
  manual: ManualMigration[],
): void {
  const arrayNode = member.value;
  const rawItems = Array.isArray(parsedFallbackModels) ? parsedFallbackModels : [];
  const models: unknown[] = rawItems.map((raw, index) => {
    if (typeof raw !== "string") return raw;
    const decision = canonicalizeModelRef(raw);
    if (decision.kind === "manual") {
      manual.push({ pointer: `runtime.fallbacks[${index}].model`, value: raw });
      return raw;
    }
    return decision.kind === "rewrite" ? decision.after : raw;
  });

  const keyIndent = lineIndentBefore(source, member.keyStart);
  const indentUnit = detectIndent(source);
  const inline = !source.slice(arrayNode.start, arrayNode.end).includes("\n");
  const arrayText = renderFallbacksArray(models, keyIndent, indentUnit, inline);

  edits.push({ start: member.keyStart, end: member.keyEnd, replacement: '"fallbacks"' });
  edits.push({ start: arrayNode.start, end: arrayNode.end, replacement: arrayText });

  changes.push({
    kind: "rename",
    pointer: "runtime.fallbacks",
    before: jsonEncode(rawItems),
    after: jsonEncode(models.map((model) => ({ model }))),
    message: RETIRED_MESSAGE_BY_PATH.get(FALLBACK_MODELS_PATH) ?? "",
  });
}

function emptyResult(source: string): MigrateConfigResult {
  return {
    skipped: false,
    skippedReason: undefined,
    conflict: undefined,
    changed: false,
    output: source,
    changes: [],
    manualMigrations: [],
  };
}

/**
 * Pure, testable migration of a config's text. Transforms are applied as
 * surgical text edits against the original source, so every byte the migration
 * did not deliberately change stays byte-identical (non-ASCII escapes, inline
 * arrays/objects, and deep nesting are preserved verbatim). `JSON.parse` is
 * used only to read and validate, never to re-emit.
 */
export function migrateConfigSource(source: string): MigrateConfigResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`The config file is not valid JSON (${reason}).`);
  }

  if (
    parsed !== null
    && typeof parsed === "object"
    && !Array.isArray(parsed)
    && hasOwn(parsed, "configVersion")
  ) {
    return {
      skipped: true,
      skippedReason: "skipped (configVersion 1 prototype)",
      conflict: undefined,
      changed: false,
      output: source,
      changes: [],
      manualMigrations: [],
    };
  }

  const root = asObject(parsed);
  if (root === undefined) {
    return emptyResult(source);
  }

  const runtime = asObject(root.runtime);
  if (runtime !== undefined && hasOwn(runtime, "fallbackModels")) {
    const existing = runtime.fallbacks;
    const populated = existing !== undefined && (!Array.isArray(existing) || existing.length > 0);
    if (populated) {
      return {
        skipped: false,
        skippedReason: undefined,
        conflict:
          "`runtime.fallbacks` is already populated; remove either `runtime.fallbackModels` or `runtime.fallbacks` before migrating.",
        changed: false,
        output: source,
        changes: [],
        manualMigrations: [],
      };
    }
  }

  const scan = scanJson(source);
  if (scan.kind !== "object") {
    return emptyResult(source);
  }

  const edits: TextEdit[] = [];
  const changes: MigrateChange[] = [];
  const manual: ManualMigration[] = [];

  const runtimeLocated = locateMember(scan, ["runtime"]);
  if (runtimeLocated !== undefined && runtimeLocated.member.value.kind === "object" && runtime !== undefined) {
    const runtimeMembers = runtimeLocated.member.value.members ?? [];
    const hasFallbackModels = runtimeMembers.some((member) => member.key === "fallbackModels");

    for (const member of runtimeMembers) {
      if (member.key === "model") {
        editModelString(member, "runtime.model", runtime.model, edits, changes, manual);
      } else if (member.key === "fallbackModels") {
        editFallbackModelsRename(source, member, runtime.fallbackModels, edits, changes, manual);
      } else if (member.key === "fallbacks" && !hasFallbackModels) {
        editExistingFallbacks(member, runtime.fallbacks, edits, changes, manual);
      }
    }

    const runtimeDeletedKeys = new Set(
      runtimeMembers
        .filter((member) => member.key !== "fallbackModels" && RETIRED_MESSAGE_BY_PATH.has(`runtime.${member.key}`))
        .map((member) => member.key),
    );
    applyMemberDeletions(source, runtimeMembers, "runtime.", runtime, runtimeDeletedKeys, edits, changes);
  }

  const llmLocated = locateMember(scan, ["memory", "llm"]);
  if (llmLocated !== undefined && llmLocated.member.value.kind === "object") {
    const memory = asObject(root.memory);
    const llm = memory === undefined ? undefined : asObject(memory.llm);
    if (llm !== undefined) {
      const llmMembers = llmLocated.member.value.members ?? [];
      for (const member of llmMembers) {
        if (member.key === "model") {
          editModelString(member, "memory.llm.model", llm.model, edits, changes, manual);
        }
      }
      const llmDeletedKeys = new Set(
        llmMembers
          .filter((member) => RETIRED_MESSAGE_BY_PATH.has(`memory.llm.${member.key}`))
          .map((member) => member.key),
      );
      applyMemberDeletions(source, llmMembers, "memory.llm.", llm, llmDeletedKeys, edits, changes);
    }
  }

  if (edits.length === 0) {
    return {
      skipped: false,
      skippedReason: undefined,
      conflict: undefined,
      changed: false,
      output: source,
      changes,
      manualMigrations: manual,
    };
  }

  return {
    skipped: false,
    skippedReason: undefined,
    conflict: undefined,
    changed: true,
    output: applyEdits(source, edits),
    changes,
    manualMigrations: manual,
  };
}

function renderHumanReport(configPath: string, result: MigrateConfigResult, applied: boolean): string {
  const lines: string[] = [];
  if (result.skipped) {
    lines.push(`${configPath}: ${result.skippedReason ?? "skipped (configVersion 1 prototype)"}`);
  } else if (result.conflict !== undefined) {
    lines.push(`${configPath}: ${result.conflict}`);
  } else {
    lines.push(`${configPath}:`);
    for (const change of result.changes) {
      if (change.kind === "delete") {
        lines.push(`  ${change.pointer}: removed`);
      } else {
        lines.push(`  ${change.pointer}: ${change.before} -> ${change.after}`);
      }
    }
    for (const manual of result.manualMigrations) {
      lines.push(`  ${manual.pointer}: ${manual.value} needs a human to choose the replacement`);
    }
    if (result.changes.length === 0 && result.manualMigrations.length === 0) {
      lines.push("  already migrated");
    }
  }
  if (applied) {
    lines.push(`  backup written to ${configPath}.bak`);
  }
  return `${lines.join("\n")}\n`;
}

function resolveExitCode(result: MigrateConfigResult, ok: boolean, write: boolean, check: boolean): number {
  if (check) {
    return result.changed || !ok ? 1 : 0;
  }
  if (write) {
    if (result.skipped) return 0;
    if (result.conflict !== undefined || result.manualMigrations.length > 0) return 1;
    return 0;
  }
  return 0;
}

export async function runMigrateConfig(args: ParsedCliArgs): Promise<number> {
  const configPath = resolve(process.cwd(), args.configPath ?? DEFAULT_CONFIG_FILE);
  const write = args.write === true;
  const check = args.check === true;
  const json = args.json === true;

  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    const message = `Cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`;
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "config-unreadable", message } })}\n`);
      return 1;
    }
    process.stderr.write(ui.errorLine(message));
    return 1;
  }

  let result: MigrateConfigResult;
  try {
    result = migrateConfigSource(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "config-invalid", message } })}\n`);
      return 1;
    }
    process.stderr.write(ui.errorLine(message));
    return 1;
  }

  const applied = write && !result.skipped && result.conflict === undefined && result.changed;
  if (applied) {
    await writeFile(`${configPath}.bak`, source, "utf8");
    await writeFile(configPath, result.output, "utf8");
  }

  const ok = result.conflict === undefined && result.manualMigrations.length === 0;

  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok,
      skipped: result.skipped,
      skippedReason: result.skippedReason,
      conflict: result.conflict,
      changed: result.changed,
      changes: result.changes,
      manualMigrations: result.manualMigrations,
    })}\n`);
    return resolveExitCode(result, ok, write, check);
  }

  process.stdout.write(renderHumanReport(configPath, result, applied));
  return resolveExitCode(result, ok, write, check);
}
