import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { MonoAgentConfig } from "@mono-agent/config";
import { MemorySearchError } from "@mono-agent/memory/search";
import type { MemorySearchErrorCode } from "@mono-agent/memory/search";
import type { MemoryDb, MemoryRecord, MemoryStoreStats } from "@mono-agent/memory/store";

import { formatMemoryProfile, resolveMemoryEntities, safeLine } from "../../../memory/memory-guidance.js";
import type {
  MemoryRecallBujoSettings,
  MemoryRecallSettings,
} from "../../../memory/memory-recall-settings.js";
import * as ui from "../../ui.js";
import { previewRecallSettings } from "./context.js";
import { isUnderDirectory } from "./private-plan.js";
import {
  reasonOf,
  renderDaily,
  renderLocalStats,
  renderSearch,
  renderTop,
  write,
  writeNoMemory,
} from "./render.js";
import { exists, loadBujoModule, loadMemoryRecallModule, loadMemoryStoreModule } from "./store-access.js";
import type { MemoryCommandContext, PreviewRecallHit, RunMemoryCommandInput } from "./types.js";

const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_TOP_LIMIT = 10;
const DEFAULT_ENTITY_LIMIT = 8;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_DUPLICATE_IDS_SHOWN = 12;
const FTS_FALLBACK_MEMORY_SEARCH_CODES = new Set<MemorySearchErrorCode>([
  "embedding_circuit_open",
  "embedding_request_failed",
  "embedding_response_invalid",
  "invalid_embedding_options",
]);
const FTS_FALLBACK_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const MAX_FTS_FALLBACK_CAUSE_CANDIDATES = 16;
const INTRINSIC_ERROR = Error;
const INTRINSIC_TYPE_ERROR = TypeError;
const INTRINSIC_AGGREGATE_ERROR = AggregateError;
const INTRINSIC_DOM_EXCEPTION = typeof DOMException === "undefined" ? undefined : DOMException;
const DOM_EXCEPTION_NAME_GETTER = INTRINSIC_DOM_EXCEPTION === undefined
  ? undefined
  : Object.getOwnPropertyDescriptor(INTRINSIC_DOM_EXCEPTION.prototype, "name")?.get;

export async function runLabelInventory(context: MemoryCommandContext, input: RunMemoryCommandInput): Promise<number> {
  return await readLabelIndex(context, input, "labels");
}

/**
 * Read-only duplicate-identity report: folded names held by several entity
 * ids, with types and association counts, so an operator can write a
 * `curate --merge` list. Reads the canonical graph file; takes no lease.
 */
export async function runEntityDuplicates(context: MemoryCommandContext, input: RunMemoryCommandInput): Promise<number> {
  const memory = context.config.memory;
  if (memory?.mode !== "bujo") {
    write(input.json, { operation: "entities", status: "failed", code: "entities_requires_bujo" },
      () => "Memory entities requires a configured BuJo store.\n");
    return 1;
  }
  const { findDuplicateEntityNames, readGraph } = await loadBujoModule();
  const all = findDuplicateEntityNames(readGraph(resolve(context.cwd, memory.path)));
  const limit = input.limit ?? 20;
  const groups = all.slice(0, limit).map((group) => ({ ...group, ids: group.ids.slice(0, MAX_DUPLICATE_IDS_SHOWN),
    ...(group.ids.length > MAX_DUPLICATE_IDS_SHOWN ? { moreIds: group.ids.length - MAX_DUPLICATE_IDS_SHOWN } : {}) }));
  const summary = { names: all.length, crossType: all.filter(({ types }) => types.length > 1).length,
    ids: all.reduce((sum, { ids }) => sum + ids.length, 0) };
  write(input.json, { operation: "entities", duplicates: groups, summary, truncated: all.length > groups.length }, () => all.length === 0
    ? "No entity name is shared by more than one id.\n"
    : `${summary.names} names map to more than one id (${summary.crossType} across types, ${summary.ids} ids).\n${groups.map((group) =>
      `${safeLine(group.name)} — ${group.ids.length + (group.moreIds ?? 0)} ids, ${group.associations} associations\n${group.ids.map(({ id, type, associations }) =>
        `  ${id} (${type ?? "untyped"}, ${associations})`).join("\n")}${group.moreIds === undefined ? "" : `\n  … ${group.moreIds} more`}`).join("\n")}\n${all.length > groups.length
      ? `Showing ${groups.length} of ${all.length}; use --limit N or --json.\n` : ""}Merge with: mono-agent memory curate prepare --plan <file> --limit 0 --merge <fromId>=<toId> [--allow-cross-type].\n`);
  return 0;
}

export async function runLessonProposal(context: MemoryCommandContext, input: RunMemoryCommandInput): Promise<number> {
  return await readLabelIndex(context, input, "lessons");
}

/** Reads the active SQLite projection only; never acquires the writer lease. */
export async function runProfileShow(context: MemoryCommandContext, input: RunMemoryCommandInput): Promise<number> {
  const memory = context.config.memory;
  if (memory?.mode !== "bujo") {
    write(input.json, { code: "memory_profile_requires_bujo" }, () => "memory_profile_requires_bujo\n");
    return 1;
  }
  try {
    const { resolveActiveMemoryDbPath } = await loadBujoModule();
    const { openMemoryDb } = await loadMemoryStoreModule();
    const path = await resolveActiveMemoryDbPath(memory.path);
    const db = await exists(path) ? openMemoryDb({ path, readOnly: true }) : undefined;
    try {
      const now = new Date();
      const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const profile = formatMemoryProfile(db === undefined ? {} : {
        guidanceForScope: (scope) => db.guidanceForScope(scope), labelsForEntity: (id, asOf) => db.labelsForEntity(id, asOf),
      }, date, memory.maxBytes, now.toISOString());
      write(input.json, { content: profile.content, sources: profile.entries.map((entry) => entry.id), truncated: profile.truncated },
        () => `${profile.content || "No active supported profile entries."}\n`);
      return 0;
    } finally { db?.close(); }
  } catch {
    write(input.json, { code: "memory_profile_unavailable" }, () => "memory_profile_unavailable\n");
    return 1;
  }
}

async function readLabelIndex(context: MemoryCommandContext, input: RunMemoryCommandInput, operation: "labels" | "lessons"): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) { writeNoMemory(context.configPath, input.json); return 0; }
  const { resolveActiveMemoryDbPath } = await loadBujoModule();
  const { openMemoryDb } = await loadMemoryStoreModule();
  try {
    const path = await resolveActiveMemoryDbPath(memory.path);
    if (!await exists(path)) {
      write(input.json, operation === "labels" ? { labels: [], truncated: false }
        : { proposals: [], truncated: false }, () => "No indexed labels.\n");
      return 0;
    }
    const db = openMemoryDb({ path, readOnly: true });
    try {
      const about = input.labelAbout;
      const matched = about === undefined ? [] : resolveMemoryEntities({
        findMemoryEntitiesByNames: (names) => db.findEntitiesByNames(names),
      }, about, true);
      const entity = matched.length === 1 ? matched[0] : undefined;
      const filters = operation === "lessons" ? { kind: "lesson" as const }
        : { ...(input.labelKind === undefined ? {} : { kind: input.labelKind }),
          ...(input.labelScope === undefined ? {} : { scope: input.labelScope }),
          ...(entity === undefined ? {} : { entityId: entity.id }) };
      const inventory = about !== undefined && entity === undefined
        ? { hits: [], truncated: false } as const : db.listLabels(filters, operation === "labels" ? input.limit ?? 200 : 200);
      if (operation === "labels") {
        const rows = inventory.hits.map((hit) => ({ id: hit.memoryId, ordinal: hit.ordinal, label: hit.label,
          text: hit.text, status: hit.status, recordedAt: hit.createdAt.slice(0, 10),
          source: hit.sourceFile === undefined ? undefined : `${hit.sourceFile}${hit.sourceLine === undefined ? "" : `:${hit.sourceLine}`}` }));
        write(input.json, { labels: rows, truncated: inventory.truncated }, () =>
          rows.length === 0 ? "No matching labels.\n" : `${rows.map((row) =>
            `${row.recordedAt} [${row.status}] ${row.source ?? row.id} ${JSON.stringify(row.label)} — ${safeLine(row.text)}`).join("\n")}\n${inventory.truncated ? "More labels exist; use --limit N (up to 1000).\n" : ""}`);
      } else {
        const groups = new Map<string, typeof inventory.hits[number][]>();
        for (const hit of inventory.hits) {
          if (!hit.active || hit.label.kind !== "lesson" || !hit.label.verified) continue;
          const normalized = safeLine(hit.text).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
          const key = `${hit.label.scope}\0${normalized}`;
          const group = groups.get(key) ?? [];
          if (!group.some((prior) => prior.memoryId === hit.memoryId)) groups.set(key, [...group, hit]);
        }
        const proposals = [...groups.values()].filter((group) => group.length >= 2).map((group) => ({
          scope: group[0]!.label.kind === "lesson" ? group[0]!.label.scope : "agent",
          snippet: `When applicable: ${safeLine(group[0]!.text)}`,
          sources: group.map((hit) => `${hit.sourceFile ?? hit.memoryId}${hit.sourceLine === undefined ? "" : `:${hit.sourceLine}`}`),
        }));
        write(input.json, { proposals, truncated: inventory.truncated }, () => {
          const body = proposals.length === 0 ? "No repeated verified lessons to propose.\n"
            : `${proposals.map((proposal) => `[${proposal.scope}] ${proposal.snippet}\nSources: ${proposal.sources.join(", ")}`).join("\n\n")}\n`;
          return `${body}${inventory.truncated ? "Inventory truncated at 200; proposals may be incomplete.\n" : ""}`;
        });
      }
      return 0;
    } finally { db.close(); }
  } catch (error) {
    process.stderr.write(ui.errorLine(`memory ${operation} read failed: ${reasonOf(error)}`));
    return 1;
  }
}

export async function runStats(context: MemoryCommandContext, input: RunMemoryCommandInput): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    writeNoMemory(context.configPath, input.json);
    return 0;
  }

  const root = memory.path;
  const { resolveActiveMemoryDbPath } = await loadBujoModule();
  const { openMemoryDb } = await loadMemoryStoreModule();
  const dbPath = await resolveActiveMemoryDbPath(root);
  const rootExists = await exists(root);
  const dbExists = await exists(dbPath);
  const size = rootExists ? await collectStoreSize(root) : emptySize();
  const lastConsolidation = await mtimeIso(join(root, "index.md"));
  const lastDailyWrite = rootExists ? await latestDailyMtime(root) : undefined;
  let stats: MemoryStoreStats | undefined;
  let entityCount = 0;
  let topMemories: readonly MemoryRecord[] = [];
  if (dbExists) {
    const db = openMemoryDb({ path: dbPath, readOnly: true });
    try {
      stats = readLocalStats(db, input.limit ?? DEFAULT_ENTITY_LIMIT);
      entityCount = db.countEntities();
      topMemories = db.topSalient(input.limit ?? DEFAULT_TOP_LIMIT);
    } finally {
      db.close();
    }
  }

  const lastCapture = stats?.latestCreatedMemory?.createdAt ?? lastDailyWrite;
  const lastAccess = stats?.latestAccessedMemory?.lastAccessedAt;
  const result = {
    configured: true,
    backend: "bujo",
    mode: memory.mode,
    effectiveTier: effectiveLocalTier(memory),
    writeMode: memory.writeMode,
    recallToolEnabled: memory.recallTool?.enabled === true,
    root,
    ...(dbExists ? { database: dbPath } : {}),
    counts: stats === undefined
      ? { total: 0, live: 0, byStatus: {}, byType: {}, entities: 0 }
      : {
          total: stats.totalMemories,
          live: stats.liveMemories,
          byStatus: stats.countsByStatus,
          byType: stats.countsByType,
          entities: entityCount,
        },
    size,
    ...(lastCapture === undefined ? {} : { lastCapture }),
    ...(lastAccess === undefined ? {} : { lastAccess }),
    ...(lastConsolidation === undefined ? {} : { lastConsolidation }),
    topEntities: stats?.topEntities ?? [],
    topMemories,
    notes: [
      ...(rootExists ? [] : [`Memory root does not exist yet: ${root}`]),
      ...(dbExists ? [] : [`No SQLite index found at ${dbPath}; search/top need an indexed store.`]),
    ],
  };

  write(input.json, result, () => renderLocalStats(result));
  return 0;
}

export async function runShow(context: MemoryCommandContext, date: string, json: boolean): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    writeNoMemory(context.configPath, json);
    return 0;
  }

  const found = await findDailyFile(memory.path, date);
  if (found === undefined) {
    const result = {
      configured: true,
      backend: "bujo",
      date,
      found: false,
      checked: [join(memory.path, "daily", `${date}.md`), join(memory.path, `${date}.md`)],
    };
    write(json, result, () => `${ui.banner("mono-agent memory", date)}\nNo daily log found for ${date}.\n`);
    return 0;
  }
  const content = await readFile(found, "utf8");
  const { parseDailyFile } = await loadBujoModule();
  const parsed = parseDailyFile(content);
  const result = {
    configured: true,
    backend: "bujo",
    date,
    found: true,
    path: found,
    bullets: parsed.bullets.map((bullet) => ({
      id: bullet.id,
      type: bullet.type,
      status: bullet.status,
      text: bullet.text,
      salience: bullet.salience,
      createdAt: bullet.createdAt,
    })),
    content,
  };
  write(json, result, () => renderDaily(result));
  return 0;
}

export async function runSearch(
  context: MemoryCommandContext,
  query: string,
  input: RunMemoryCommandInput,
): Promise<number> {
  let settings = previewRecallSettings(context.config);
  if (settings === undefined) {
    writeNoMemory(context.configPath, input.json);
    return 0;
  }
  const { resolveActiveMemoryDbPath } = await loadBujoModule();
  const dbPath = await resolveActiveMemoryDbPath(settings.root);
  settings = { ...settings, dbPath };
  if (!(await exists(settings.dbPath ?? join(settings.root, "memory.db")))) {
    const dbPath = settings.dbPath ?? join(settings.root, "memory.db");
    const result = {
      configured: true,
      backend: "bujo",
      query,
      hits: [],
      notes: [`No SQLite index found at ${dbPath}; run mono-agent memory rebuild or wait for capture.`],
    };
    write(input.json, result, () => renderSearch(result));
    return 0;
  }

  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  let degraded: string | undefined;
  const hits = await recallWithFtsFallback(settings, query, limit)
    .then((result) => {
      degraded = result.degraded;
      return result.hits;
    })
    .catch((error) => {
      process.stderr.write(ui.errorLine(`memory search failed: ${reasonOf(error)}`));
      return undefined;
    });
  if (hits === undefined) {
    return 1;
  }
  const result = {
    configured: true,
    backend: "bujo",
    query,
    ...(degraded === undefined ? {} : { degraded }),
    hits: hits.map((hit) => ({
      id: hit.record.id,
      score: hit.score,
      text: hit.record.text,
      source: sourceOf(hit),
      ...(hit.record.salience === undefined ? {} : { salience: hit.record.salience }),
      ...(hit.record.createdAt === undefined ? {} : { createdAt: hit.record.createdAt }),
    })),
  };
  write(input.json, result, () => renderSearch(result));
  return 0;
}

export async function runTop(context: MemoryCommandContext, input: RunMemoryCommandInput): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    writeNoMemory(context.configPath, input.json);
    return 0;
  }
  const { resolveActiveMemoryDbPath } = await loadBujoModule();
  const { openMemoryDb } = await loadMemoryStoreModule();
  const dbPath = await resolveActiveMemoryDbPath(memory.path);
  if (!(await exists(dbPath))) {
    const result = {
      configured: true,
      backend: "bujo",
      hits: [],
      notes: [`No SQLite index found at ${dbPath}; run mono-agent memory rebuild or wait for capture.`],
    };
    write(input.json, result, () => renderTop(result));
    return 0;
  }
  const db = openMemoryDb({ path: dbPath, readOnly: true });
  try {
    const hits = db.topSalient(input.limit ?? DEFAULT_TOP_LIMIT).map((record) => ({
      id: record.id,
      text: record.text,
      salience: record.salience,
      status: record.status,
      type: record.type,
      source: sourceOfRecord(record),
      createdAt: record.createdAt,
    }));
    const result = { configured: true, backend: "bujo", hits, notes: [] };
    write(input.json, result, () => renderTop(result));
  } finally {
    db.close();
  }
  return 0;
}

async function recallWithFtsFallback(
  settings: MemoryRecallSettings,
  query: string,
  limit: number,
): Promise<{ readonly hits: readonly PreviewRecallHit[]; readonly degraded?: string }> {
  const { createRecallStore } = await loadMemoryRecallModule();
  const store = await createRecallStore(settings);
  try {
    return { hits: await store.recall(query, { topK: limit, trackAccess: false }) as readonly PreviewRecallHit[] };
  } catch (error) {
    if (!isFtsFallbackEligible(settings, error)) {
      throw error;
    }
    await store.close().catch(() => undefined);
    const fallback: MemoryRecallBujoSettings = {
      root: settings.root,
      ...(settings.tier === undefined ? {} : { tier: settings.tier }),
      ...(settings.dbPath === undefined ? {} : { dbPath: settings.dbPath }),
      ftsOnlyFallback: true,
    };
    const ftsStore = await createRecallStore(fallback);
    try {
      return {
        hits: await ftsStore.recall(query, { topK: limit, trackAccess: false }) as readonly PreviewRecallHit[],
        degraded: `Semantic embeddings unavailable (${reasonOf(error)}); showing FTS-only results.`,
      };
    } finally {
      await ftsStore.close();
    }
  } finally {
    await store.close().catch(() => undefined);
  }
}

export function isFtsFallbackEligible(
  settings: MemoryRecallSettings,
  error: unknown,
): settings is MemoryRecallBujoSettings {
  if (settings.embeddings === undefined) {
    return false;
  }
  if (isIntrinsicMemorySearchError(error)) {
    const code = readErrorProperty(error, "code");
    return code.ok
      && typeof code.value === "string"
      && FTS_FALLBACK_MEMORY_SEARCH_CODES.has(code.value as MemorySearchErrorCode);
  }
  if (isNativeAbortError(error)) {
    return true;
  }
  if (!isIntrinsicTypeError(error) && !isIntrinsicAggregateError(error)) {
    return false;
  }
  return hasNetworkFailureCause(error);
}

function hasNetworkFailureCause(error: Error): boolean {
  const pending: Error[] = [];
  const seen = new Set<Error>();
  let candidateCount = 0;

  const enqueue = (candidate: unknown): void => {
    if (candidateCount >= MAX_FTS_FALLBACK_CAUSE_CANDIDATES) {
      return;
    }
    candidateCount += 1;
    if (!isIntrinsicError(candidate) || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    pending.push(candidate);
  };

  const enqueueAggregateErrors = (aggregate: AggregateError): void => {
    const errorsRead = readErrorProperty(aggregate, "errors");
    if (!errorsRead.ok || !isArrayWithoutThrowing(errorsRead.value)) {
      return;
    }
    const errors = errorsRead.value;
    const lengthRead = readErrorProperty(errors, "length");
    if (
      !lengthRead.ok
      || typeof lengthRead.value !== "number"
      || !Number.isSafeInteger(lengthRead.value)
      || lengthRead.value < 0
    ) {
      return;
    }
    const readable = Math.min(
      lengthRead.value,
      MAX_FTS_FALLBACK_CAUSE_CANDIDATES - candidateCount,
    );
    for (let index = 0; index < readable; index += 1) {
      const entry = readErrorProperty(errors, String(index));
      // A hostile array slot still consumes its bounded candidate position.
      enqueue(entry.ok ? entry.value : undefined);
    }
  };

  const enqueueChildren = (current: Error): void => {
    const cause = readErrorProperty(current, "cause");
    if (cause.ok && cause.value !== undefined) {
      enqueue(cause.value);
    }
    if (isIntrinsicAggregateError(current)) {
      enqueueAggregateErrors(current);
    }
  };

  enqueueChildren(error);
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) {
      continue;
    }
    const code = readErrorProperty(current, "code");
    if (
      code.ok
      && typeof code.value === "string"
      && FTS_FALLBACK_NETWORK_CODES.has(code.value.toUpperCase())
    ) {
      return true;
    }
    enqueueChildren(current);
  }
  return false;
}

export type ErrorPropertyRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

export function readErrorProperty(value: object, key: PropertyKey): ErrorPropertyRead {
  try {
    return { ok: true, value: Reflect.get(value, key) };
  } catch {
    return { ok: false };
  }
}

function isArrayWithoutThrowing(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

export function isIntrinsicError(value: unknown): value is Error {
  try {
    return value instanceof INTRINSIC_ERROR;
  } catch {
    return false;
  }
}

function isIntrinsicTypeError(value: unknown): value is TypeError {
  try {
    return value instanceof INTRINSIC_TYPE_ERROR;
  } catch {
    return false;
  }
}

function isIntrinsicAggregateError(value: unknown): value is AggregateError {
  try {
    return value instanceof INTRINSIC_AGGREGATE_ERROR;
  } catch {
    return false;
  }
}

function isIntrinsicMemorySearchError(value: unknown): value is MemorySearchError {
  try {
    return value instanceof MemorySearchError;
  } catch {
    return false;
  }
}

function isNativeAbortError(value: unknown): boolean {
  if (INTRINSIC_DOM_EXCEPTION === undefined || DOM_EXCEPTION_NAME_GETTER === undefined) {
    return false;
  }
  try {
    return value instanceof INTRINSIC_DOM_EXCEPTION
      && Reflect.apply(DOM_EXCEPTION_NAME_GETTER, value, []) === "AbortError";
  } catch {
    return false;
  }
}

function readLocalStats(db: MemoryDb, topEntitiesLimit: number): MemoryStoreStats {
  return db.stats({ topEntitiesLimit });
}

function effectiveLocalTier(memory: NonNullable<MonoAgentConfig["memory"]>): string {
  return memory.mode;
}

async function findDailyFile(root: string, date: string): Promise<string | undefined> {
  const candidates = [join(root, "daily", `${date}.md`), join(root, `${date}.md`)];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function latestDailyMtime(root: string): Promise<string | undefined> {
  const files = await dailyMarkdownFiles(root);
  const mtimes = await Promise.all(files.map((file) => mtimeIso(file)));
  return newest(mtimes.flatMap((mtime) => mtime === undefined ? [] : [mtime]));
}

async function dailyMarkdownFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const dir of [root, join(root, "daily")]) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && DATE_RE.test(basename(entry.name, ".md")) && entry.name.endsWith(".md")) {
        files.push(join(dir, entry.name));
      }
    }
  }
  return files;
}

export async function collectStoreSize(root: string): Promise<{
  readonly rootBytes: number;
  readonly dailyBytes: number;
  readonly databaseBytes: number;
  readonly fileCount: number;
}> {
  let rootBytes = 0;
  let dailyBytes = 0;
  let databaseBytes = 0;
  let fileCount = 0;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const s = await stat(filePath).catch(() => undefined);
      if (s === undefined) {
        continue;
      }
      fileCount += 1;
      rootBytes += s.size;
      if ((entry.name.endsWith(".md") && DATE_RE.test(basename(entry.name, ".md"))) || isUnderDirectory(join(root, "daily"), filePath)) {
        dailyBytes += s.size;
      }
      if (entry.name === "memory.db" || entry.name.startsWith("memory.db-")) {
        databaseBytes += s.size;
      }
    }
  }
  await walk(root);
  return { rootBytes, dailyBytes, databaseBytes, fileCount };
}

export function emptySize(): { readonly rootBytes: 0; readonly dailyBytes: 0; readonly databaseBytes: 0; readonly fileCount: 0 } {
  return { rootBytes: 0, dailyBytes: 0, databaseBytes: 0, fileCount: 0 };
}

async function mtimeIso(path: string): Promise<string | undefined> {
  const s = await stat(path).catch(() => undefined);
  return s === undefined ? undefined : s.mtime.toISOString();
}

function newest(values: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > bestMs) {
      best = value;
      bestMs = ms;
    }
  }
  return best;
}

export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function sourceOf(hit: PreviewRecallHit): string {
  const source = hit.record.source;
  if (source?.file !== undefined) {
    return source.line === undefined ? source.file : `${source.file}:${source.line}`;
  }
  if (source?.session !== undefined) {
    return `session:${source.session}`;
  }
  return hit.record.id;
}

function sourceOfRecord(record: MemoryRecord): string {
  if (record.source.file !== undefined) {
    return record.source.line === undefined ? record.source.file : `${record.source.file}:${record.source.line}`;
  }
  if (record.source.session !== undefined) {
    return `session:${record.source.session}`;
  }
  return record.id;
}
