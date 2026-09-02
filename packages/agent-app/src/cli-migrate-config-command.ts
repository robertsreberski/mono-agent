import { randomBytes } from "node:crypto";
import { open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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
 * Every mono-agent runtime model reference the config DOCUMENT itself owns,
 * beyond `runtime.model` / `runtime.fallbacks[].model` / `memory.llm.model`
 * (which carry extra retired-key handling and stay inline below).
 *
 * `--check` is a pre-restart gate, so an unvisited site defeats its purpose: a
 * `codex:` ref left in `subagents.definitions[].model` makes the LOADER throw
 * at restart (`parseSubagentModel`), and one left in a cron/webhook override is
 * warn-and-ignored at turn time — both while `--check` exited 0 "already
 * migrated".
 *
 * Deliberately EXCLUDED, because they are not mono runtime references and a
 * rewrite would corrupt them: `tools.web.search.codex.model` (a Codex
 * app-server model id for the surviving Codex web-search backend),
 * `telegram.transcription.model`, `openaiApi.modelId`, and
 * `memory.embeddingModel`.
 */
const SCALAR_MODEL_REF_PATHS: readonly (readonly string[])[] = [
  // Single-trigger legacy forms, still layered onto MONO_AGENT_CRON_MODEL /
  // MONO_AGENT_WEBHOOK_MODEL by the adapters.
  ["cron", "model"],
  ["webhook", "model"],
];

/** Arrays of objects whose `model` member is a runtime model reference. */
const ARRAY_MODEL_REF_PATHS: readonly (readonly string[])[] = [
  ["subagents", "definitions"],
  ["cron", "jobs"],
  ["webhook", "endpoints"],
];

/**
 * Trigger folders whose `*.md` frontmatter can carry a `model:` override that
 * never appears in the JSON document. `<section>.dir` renames the folder, the
 * same precedence tail the adapters use (`cron/config.ts`,
 * `webhook-adapter/config.ts`) minus the env layer, which `migrate-config`
 * cannot see because it never loads the agent's dotenv file.
 */
const TRIGGER_MARKDOWN_DIRECTORIES: readonly { readonly section: string; readonly defaultDir: string }[] = [
  { section: "cron", defaultDir: "cron" },
  { section: "webhook", defaultDir: "webhook" },
];

/**
 * The adapters' own frontmatter fence: a literal leading `---`, then flat
 * `key: value` lines, closed by `---` (trailing blanks allowed). CRLF is
 * accepted because the loaders normalize line endings before matching, but the
 * bytes are never rewritten here.
 */
const FRONTMATTER_BLOCK = /^---(\r?\n)([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u;

/**
 * `memory.llm.model` is a mono runtime reference ONLY under the `agent-host`
 * provider; `readMemoryLlmConfig` (config.ts) validates it with
 * `parseMonoRuntimeModelReference` in that branch alone. The default `ollama`
 * provider passes the string straight to the Ollama service, where a colon is
 * an ordinary tag separator (`qwen3:8b`) — stripping a `pi:` prefix there would
 * silently repoint a working memory LLM at a model that does not exist.
 */
const AGENT_HOST_MEMORY_LLM_PROVIDER = "agent-host";

/**
 * Removed runtime backends whose model references must never be guessed: a
 * mechanical rewrite would point the agent at a different auth store than the
 * operator meant, so each is reported for a human to resolve.
 */
const NON_PI_REF_PREFIXES = [
  // `opencode:<provider>:<model>` was the direct-OpenCode backend form. Plain
  // `opencode:<model>` is a real Pi provider ref and must stay accepted, so
  // this prefix is matched on the nested shape only (see needsManualMigration).
  "opencode:",
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

/** The migration of one file's text: the new bytes plus what they mean. */
export interface MigrateTextResult {
  readonly changed: boolean;
  readonly output: string;
  readonly changes: readonly MigrateChange[];
  readonly manualMigrations: readonly ManualMigration[];
}

export interface MigrateConfigResult extends MigrateTextResult {
  readonly skipped: boolean;
  readonly skippedReason: string | undefined;
  readonly conflict: string | undefined;
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
  /** Set when this object declares the same key twice, making edits ambiguous. */
  readonly duplicateKey?: string;
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
    // `opencode` is BOTH a removed backend prefix and a live Pi provider id.
    // The backend form carried a nested provider (`opencode:<provider>:<model>`);
    // the Pi form does not. Only the nested shape needs a human.
    if (nonPi === "opencode:") {
      const rest = stripped.slice(nonPi.length);
      if (!rest.includes(":")) return raw.startsWith("pi:") ? { kind: "rewrite", after: stripped } : { kind: "unchanged" };
    }
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
    // Duplicate keys make the document ambiguous: `JSON.parse` keeps the LAST
    // occurrence while this scanner addresses the FIRST, so an edit would
    // rewrite text that carries no meaning and leave the effective value
    // untouched -- `--write` would report success and `--check` would never
    // converge. Record it so the caller can refuse the file instead.
    const seen = new Set<string>();
    for (const member of members) {
      if (seen.has(member.key)) return { kind: "object", start, end: index, members, duplicateKey: member.key };
      seen.add(member.key);
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

/** The first duplicated key anywhere in the document, depth-first. */
function firstDuplicateKey(node: JsonNode): string | undefined {
  if (node.duplicateKey !== undefined) return node.duplicateKey;
  for (const member of node.members ?? []) {
    const nested = firstDuplicateKey(member.value);
    if (nested !== undefined) return nested;
  }
  return undefined;
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

/** Rewrite the `model` member of every object in an array of entries. */
function editModelArrayMembers(
  arrayNode: JsonNode,
  parsedArray: unknown,
  pointerBase: string,
  edits: TextEdit[],
  changes: MigrateChange[],
  manual: ManualMigration[],
): void {
  if (arrayNode.kind !== "array") return;
  const parsedItems = Array.isArray(parsedArray) ? parsedArray : [];
  (arrayNode.items ?? []).forEach((itemNode, index) => {
    if (itemNode.kind !== "object") return;
    const modelMember = (itemNode.members ?? []).find((entry) => entry.key === "model");
    if (modelMember === undefined) return;
    const parsedItem = asObject(parsedItems[index]);
    if (parsedItem === undefined) return;
    editModelString(
      modelMember,
      `${pointerBase}[${index}].model`,
      parsedItem.model,
      edits,
      changes,
      manual,
    );
  });
}

function editExistingFallbacks(
  member: JsonMember,
  parsedFallbacks: unknown,
  edits: TextEdit[],
  changes: MigrateChange[],
  manual: ManualMigration[],
): void {
  editModelArrayMembers(
    member.value,
    parsedFallbacks,
    "runtime.fallbacks",
    edits,
    changes,
    manual,
  );
}

/** The parsed value at a dot-separated path, if the whole path is objects. */
function parsedValueAt(root: JsonObject, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    const object = asObject(current);
    if (object === undefined) return undefined;
    current = object[key];
  }
  return current;
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
    // Only the literal v1 prototype is exempt. Treating ANY configVersion as
    // the prototype would silently pass a v2 file carrying retired keys, and
    // `--check` would report it clean while the agent refuses to start.
    && (parsed as Record<string, unknown>).configVersion === 1
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
  const duplicate = firstDuplicateKey(scan);
  if (duplicate !== undefined) {
    return {
      skipped: false,
      skippedReason: undefined,
      conflict:
        `The config declares "${duplicate}" more than once in the same object. JSON keeps the last `
        + "occurrence, so an automatic edit would rewrite the wrong one and leave the effective value "
        + "in place. Remove the duplicate, then re-run.",
      changed: false,
      output: source,
      changes: [],
      manualMigrations: [],
    };
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
      // Only the `agent-host` provider makes this field a runtime reference;
      // see AGENT_HOST_MEMORY_LLM_PROVIDER. Under the default `ollama` provider
      // it is a raw service model string and must be left exactly as authored.
      const isRuntimeRef = llm.provider === AGENT_HOST_MEMORY_LLM_PROVIDER;
      for (const member of llmMembers) {
        if (member.key === "model" && isRuntimeRef) {
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

  for (const path of SCALAR_MODEL_REF_PATHS) {
    const located = locateMember(scan, path);
    if (located === undefined) continue;
    editModelString(located.member, path.join("."), parsedValueAt(root, path), edits, changes, manual);
  }

  for (const path of ARRAY_MODEL_REF_PATHS) {
    const located = locateMember(scan, path);
    if (located === undefined) continue;
    editModelArrayMembers(
      located.member.value,
      parsedValueAt(root, path),
      path.join("."),
      edits,
      changes,
      manual,
    );
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

function unchangedText(source: string): MigrateTextResult {
  return { changed: false, output: source, changes: [], manualMigrations: [] };
}

/**
 * Migrate the `model:` override in one cron-job / webhook-endpoint markdown
 * file's frontmatter.
 *
 * These references live entirely outside the JSON document — `jobs-dir.ts` and
 * `endpoints-dir.ts` read them straight off the file — so a config-only codemod
 * reported "already migrated" while the loader still saw a legacy `pi:` wrapper
 * (warn-and-ignored at turn time) or a removed backend prefix.
 *
 * Only the value's own bytes are replaced, matching the JSON path's surgical
 * discipline: fence, key spelling, comments, quoting style and the markdown
 * body all survive untouched. The loader's grammar is mirrored exactly — `#`
 * comments and colon-less lines ignored, one layer of matching quotes stripped,
 * and LAST occurrence wins for a repeated key, because that is the entry the
 * loader's flat map keeps.
 */
export function migrateTriggerMarkdown(source: string, filePointer: string): MigrateTextResult {
  const match = FRONTMATTER_BLOCK.exec(source);
  const frontmatter = match?.[2];
  if (match === null || match[1] === undefined || frontmatter === undefined) {
    return unchangedText(source);
  }

  let target: { readonly start: number; readonly end: number; readonly raw: string } | undefined;
  let offset = "---".length + match[1].length;
  for (const rawLine of frontmatter.split("\n")) {
    const lineStart = offset;
    offset += rawLine.length + 1;
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const colon = rawLine.indexOf(":");
    if (colon === -1 || rawLine.slice(0, colon).trim() !== "model") continue;
    const after = rawLine.slice(colon + 1);
    const leading = after.length - after.trimStart().length;
    const start = lineStart + colon + 1 + leading;
    const raw = after.trim();
    target = { start, end: start + raw.length, raw };
  }
  if (target === undefined) return unchangedText(source);

  const quote = target.raw.length >= 2
    && (target.raw[0] === '"' || target.raw[0] === "'")
    && target.raw[target.raw.length - 1] === target.raw[0]
    ? target.raw[0]!
    : "";
  const value = (quote === "" ? target.raw : target.raw.slice(1, -1)).trim();
  if (value.length === 0) return unchangedText(source);

  const pointer = `${filePointer}#model`;
  const decision = canonicalizeModelRef(value);
  if (decision.kind === "manual") {
    return { changed: false, output: source, changes: [], manualMigrations: [{ pointer, value }] };
  }
  if (decision.kind === "unchanged") return unchangedText(source);
  return {
    changed: true,
    output: source.slice(0, target.start) + quote + decision.after + quote + source.slice(target.end),
    changes: [{ kind: "rewrite", pointer, before: jsonEncode(value), after: jsonEncode(decision.after) }],
    manualMigrations: [],
  };
}

/** One trigger markdown file that was read and migrated in memory. */
interface MigratedTriggerFile {
  readonly path: string;
  readonly source: string;
  readonly result: MigrateTextResult;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Read and migrate every `*.md` under the config's cron and webhook folders.
 * The folders are resolved next to the CONFIG rather than against the process
 * cwd, so `--config path/to/other/mono-agent.config.json` visits that agent's
 * triggers and not the caller's. A missing folder is not an error; any other
 * read failure is, because silently skipping it would restore exactly the false
 * "already migrated" this traversal exists to remove.
 */
async function migrateTriggerDirectories(configPath: string, parsed: unknown): Promise<MigratedTriggerFile[]> {
  const root = dirname(configPath);
  const config = asObject(parsed);
  const migrated: MigratedTriggerFile[] = [];
  for (const { section, defaultDir } of TRIGGER_MARKDOWN_DIRECTORIES) {
    const sectionObject = config === undefined ? undefined : asObject(config[section]);
    const dirName = optionalString(sectionObject?.dir) ?? defaultDir;
    const dir = resolve(root, dirName);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Cannot read ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const names = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      const path = join(dir, name);
      const source = await readFile(path, "utf8");
      migrated.push({ path, source, result: migrateTriggerMarkdown(source, `${dirName}/${name}`) });
    }
  }
  return migrated;
}

/** The file moved between the read the migration was computed from and the replacement. */
class ConcurrentEditError extends Error {
  constructor(path: string) {
    super(
      `${path} changed on disk while migrate-config was running, so nothing was replaced. `
      + "Re-run migrate-config once the other writer has finished.",
    );
    this.name = "ConcurrentEditError";
  }
}

interface AtomicWriteOptions {
  /**
   * Permission bits for the replacement. Passed explicitly because a NEW file
   * (a first `.bak`) has no mode of its own to inherit, and taking the umask
   * default there published a byte-exact copy of a `0600` config as `0644`.
   */
  readonly mode?: number | undefined;
  /**
   * Refuse the rename unless the target still holds exactly these bytes. This
   * is the last-instant re-read that keeps a concurrent editor's work from
   * being silently overwritten by a migration computed from a stale read.
   */
  readonly expect?: string | undefined;
}

/**
 * Replace a file's contents atomically: write a SIBLING temp file, fsync it,
 * then rename over the target. `writeFile` truncates first, so a process death
 * (or a full disk) between truncate and the final write left the LIVE config
 * empty — the `.bak` made that recoverable, not harmless: the agent refuses to
 * start until a human notices and restores it. The temp file is a sibling so
 * the rename stays inside one filesystem, which is what makes it atomic.
 *
 * A symlinked config is resolved first and the rename lands on its TARGET: the
 * plain `writeFile` this replaced wrote through the link, and renaming over the
 * link's own dirent would convert a shared config into a private regular file
 * while the shared original stayed unmigrated.
 *
 * The temp name carries random bytes, not just pid and millisecond, and the
 * `wx` open is outside the cleanup block: two callers racing on one path used
 * to pick the SAME temp name, and the loser's cleanup deleted the winner's
 * staged file out from under its rename, failing both.
 */
async function writeFileAtomic(path: string, contents: string, options: AtomicWriteOptions = {}): Promise<void> {
  const target = await realpath(path).catch(() => path);
  const temporaryPath = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  // `wx` proves this process created the temp file, so the cleanup below can
  // only ever remove its own. Create it 0600 and widen afterwards, so a config
  // that is private on disk is never briefly readable through the temp name.
  const handle: FileHandle = await open(temporaryPath, "wx", 0o600);
  let closed = false;
  try {
    await handle.writeFile(contents, "utf8");
    if (options.mode !== undefined) {
      await handle.chmod(options.mode);
    }
    await handle.sync();
    await handle.close();
    closed = true;
    if (options.expect !== undefined) {
      const current = await readFile(target, "utf8").catch(() => undefined);
      if (current !== options.expect) {
        throw new ConcurrentEditError(path);
      }
    }
    await rename(temporaryPath, target);
  } catch (error) {
    if (!closed) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** The mode of an existing file, or undefined when it cannot be read. */
async function fileMode(path: string): Promise<number | undefined> {
  return await stat(path)
    .then((stats) => stats.mode & 0o777)
    .catch(() => undefined);
}

/** One file the run intends to replace, together with the bytes it was migrated from. */
interface PendingWrite {
  readonly path: string;
  readonly source: string;
  readonly output: string;
}

/**
 * Back up and replace every migrated file, refusing any whose bytes moved since
 * they were read. The pre-check aborts before a stale `.bak` is written; the
 * `expect` guard closes the remaining window at the rename itself.
 */
async function applyPendingWrites(pending: readonly PendingWrite[]): Promise<string[]> {
  const backups: string[] = [];
  for (const item of pending) {
    const mode = await fileMode(item.path);
    const current = await readFile(item.path, "utf8").catch(() => undefined);
    if (current !== item.source) {
      throw new ConcurrentEditError(item.path);
    }
    await writeFileAtomic(`${item.path}.bak`, item.source, { mode });
    await writeFileAtomic(item.path, item.output, { mode, expect: item.source });
    backups.push(`${item.path}.bak`);
  }
  return backups;
}

/**
 * One report over every file the run touched. Trigger-markdown pointers are
 * already file-qualified (`cron/digest.md#model`), so they read unambiguously
 * next to the config's own dotted pointers.
 */
function renderHumanReport(
  configPath: string,
  result: MigrateConfigResult,
  changes: readonly MigrateChange[],
  manualMigrations: readonly ManualMigration[],
  backups: readonly string[],
): string {
  const lines: string[] = [];
  if (result.skipped) {
    lines.push(`${configPath}: ${result.skippedReason ?? "skipped (configVersion 1 prototype)"}`);
  } else if (result.conflict !== undefined) {
    lines.push(`${configPath}: ${result.conflict}`);
  } else {
    lines.push(`${configPath}:`);
    for (const change of changes) {
      if (change.kind === "delete") {
        lines.push(`  ${change.pointer}: removed`);
      } else {
        lines.push(`  ${change.pointer}: ${change.before} -> ${change.after}`);
      }
    }
    for (const manual of manualMigrations) {
      lines.push(`  ${manual.pointer}: ${manual.value} needs a human to choose the replacement`);
    }
    if (changes.length === 0 && manualMigrations.length === 0) {
      lines.push("  already migrated");
    }
  }
  for (const backup of backups) {
    lines.push(`  backup written to ${backup}`);
  }
  return `${lines.join("\n")}\n`;
}

function resolveExitCode(
  result: MigrateConfigResult,
  changed: boolean,
  ok: boolean,
  write: boolean,
  check: boolean,
): number {
  if (check) {
    return changed || !ok ? 1 : 0;
  }
  if (write) {
    if (result.skipped) return 0;
    return ok ? 0 : 1;
  }
  return 0;
}

export async function runMigrateConfig(args: ParsedCliArgs): Promise<number> {
  const configPath = resolve(process.cwd(), args.configPath ?? DEFAULT_CONFIG_FILE);
  const write = args.write === true;
  const check = args.check === true;
  const json = args.json === true;

  const fail = (code: string, message: string): number => {
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
      return 1;
    }
    process.stderr.write(ui.errorLine(message));
    return 1;
  };
  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    return fail("config-unreadable", `Cannot read ${configPath}: ${describe(error)}`);
  }

  let result: MigrateConfigResult;
  try {
    result = migrateConfigSource(source);
  } catch (error) {
    return fail("config-invalid", describe(error));
  }

  // A `configVersion: 1` prototype and a conflicted document are both reported
  // as-is; neither is a document whose trigger folders this codemod owns.
  let triggers: readonly MigratedTriggerFile[] = [];
  if (!result.skipped && result.conflict === undefined) {
    try {
      triggers = await migrateTriggerDirectories(configPath, JSON.parse(source));
    } catch (error) {
      return fail("trigger-dir-unreadable", describe(error));
    }
  }

  const changes: readonly MigrateChange[] = [
    ...result.changes,
    ...triggers.flatMap((file) => file.result.changes),
  ];
  const manualMigrations: readonly ManualMigration[] = [
    ...result.manualMigrations,
    ...triggers.flatMap((file) => file.result.manualMigrations),
  ];
  const changed = result.changed || triggers.some((file) => file.result.changed);
  const ok = result.conflict === undefined && manualMigrations.length === 0;

  let backups: readonly string[] = [];
  if (write && !result.skipped && result.conflict === undefined && changed) {
    const pending: PendingWrite[] = [
      ...(result.changed ? [{ path: configPath, source, output: result.output }] : []),
      ...triggers
        .filter((file) => file.result.changed)
        .map((file) => ({ path: file.path, source: file.source, output: file.result.output })),
    ];
    try {
      backups = await applyPendingWrites(pending);
    } catch (error) {
      if (error instanceof ConcurrentEditError) {
        return fail("config-changed-on-disk", error.message);
      }
      return fail("write-failed", describe(error));
    }
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok,
      skipped: result.skipped,
      skippedReason: result.skippedReason,
      conflict: result.conflict,
      changed,
      changes,
      manualMigrations,
    })}\n`);
    return resolveExitCode(result, changed, ok, write, check);
  }

  process.stdout.write(renderHumanReport(configPath, result, changes, manualMigrations, backups));
  return resolveExitCode(result, changed, ok, write, check);
}
