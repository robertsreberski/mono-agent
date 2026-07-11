import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { resolveSupermemoryContainer } from "@mono-agent/config";
import type { MonoAgentConfig } from "@mono-agent/config";
import { openMemoryDb } from "@mono-agent/memory/store";
import type { EntityRecord, MemoryDb, MemoryRecord, MemoryStoreAudit, MemoryStoreStats } from "@mono-agent/memory/store";
import { listTraceSources } from "@mono-agent/observability";
import {
  parseDailyFile,
  resolveActiveMemoryDbPath,
  rollbackMemoryIndex,
  safeRebuildMemoryIndex,
} from "@mono-agent/memory/bujo";

import {
  isAppCoreConfigError,
  loadAppCoreConfig,
  resolveAppTraceRegistryDir,
} from "./app-config.js";
import {
  createMemoryEmbeddingProvider,
  createRecallStore,
  resolveMemoryRecallSettings,
} from "./memory-recall.js";
import type {
  MemoryRecallBujoSettings,
  MemoryRecallSettings,
} from "./memory-recall.js";
import * as ui from "./ui.js";

const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_TOP_LIMIT = 10;
const DEFAULT_ENTITY_LIMIT = 8;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

export interface RunMemoryCommandInput {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly configPath?: string;
  readonly positionals: readonly string[];
  readonly json: boolean;
  readonly limit?: number;
}

interface MemoryCommandContext {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly configPath: string;
  readonly config: MonoAgentConfig;
}

interface PreviewRecallHit {
  readonly score: number;
  readonly record: {
    readonly id: string;
    readonly text: string;
    readonly source?: { readonly file?: string; readonly line?: number; readonly session?: string };
    readonly salience?: number;
    readonly createdAt?: string;
  };
}

export async function runMemoryCommand(input: RunMemoryCommandInput): Promise<number> {
  const context = await loadMemoryCommandContext(input);
  if ("code" in context) {
    return context.code;
  }

  const [rawSubcommand, ...rest] = input.positionals;
  const subcommand = rawSubcommand ?? "stats";
  if (context.config.memory === undefined) {
    writeNoMemory(context.configPath, input.json);
    return 0;
  }

  switch (subcommand) {
    case "stats":
      return await runStats(context, input);
    case "today":
      return await runShow(context, todayKey(), input.json);
    case "show": {
      const date = rest[0];
      if (date === undefined || !DATE_RE.test(date)) {
        process.stderr.write(ui.errorLine("Usage: mono-agent memory show <YYYY-MM-DD>."));
        return 2;
      }
      return await runShow(context, date, input.json);
    }
    case "search": {
      const query = rest.join(" ").trim();
      if (query.length === 0) {
        process.stderr.write(ui.errorLine("Usage: mono-agent memory search <query>."));
        return 2;
      }
      return await runSearch(context, query, input);
    }
    case "top":
      return await runTop(context, input);
    case "audit":
      return await runAudit(context, input.json);
    case "rebuild":
      return await runIndexTransition(context, "rebuild", input.json);
    case "rollback":
      return await runIndexTransition(context, "rollback", input.json);
    default:
      process.stderr.write(ui.errorLine(`Unknown memory subcommand \`${subcommand}\`.`));
      process.stderr.write(ui.hint("Expected stats, today, show <date>, search <query>, top, audit, rebuild, or rollback."));
      return 2;
  }
}

async function runIndexTransition(
  context: MemoryCommandContext,
  operation: "rebuild" | "rollback",
  json: boolean,
): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    writeNoMemory(context.configPath, json);
    return 0;
  }
  if ((memory.backend ?? "bujo") === "supermemory") {
    process.stderr.write(ui.errorLine(
      `mono-agent memory ${operation} is available only for the built-in Lite, Journal, and BuJo stores; Supermemory manages its remote index.`,
    ));
    return 1;
  }

  const settings = previewRecallSettings(context.config);
  if (settings === undefined || "supermemory" in settings) {
    process.stderr.write(ui.errorLine(`Unable to resolve the configured built-in memory store for ${operation}.`));
    return 1;
  }

  try {
    const registryDir = await resolveAppTraceRegistryDir({
      env: context.env,
      cwd: context.cwd,
      configPath: context.configPath,
    });
    await assertNoLiveConfiguredAgent(context.configPath, registryDir);
    const embeddings = settings.embeddings === undefined
      ? undefined
      : await createMemoryEmbeddingProvider(settings.embeddings);
    const options = {
      root: memory.path,
      tier: memory.mode,
      ...(embeddings === undefined ? {} : { embeddings, dim: settings.embeddings?.dim ?? 768 }),
    };
    // Re-check after provider construction so a legacy writer that started
    // during setup cannot be raced by the destructive transition.
    await assertNoLiveConfiguredAgent(context.configPath, registryDir);
    const details = operation === "rebuild"
      ? await safeRebuildMemoryIndex(options)
      : await rollbackMemoryIndex(options);
    const activeDatabase = await resolveActiveMemoryDbPath(memory.path);
    const result = {
      configured: true,
      backend: "bujo",
      operation,
      activeDatabase,
      details,
    };
    write(json, result, () => renderIndexTransition(result));
    return 0;
  } catch (error) {
    process.stderr.write(ui.errorLine(`memory ${operation} failed: ${reasonOf(error)}`));
    return 1;
  }
}

async function runAudit(context: MemoryCommandContext, json: boolean): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    writeNoMemory(context.configPath, json);
    return 0;
  }
  if ((memory.backend ?? "bujo") === "supermemory") {
    const result = {
      configured: true,
      backend: "supermemory",
      metadataOnly: true,
      counts: null,
      bytes: null,
      duplicates: null,
      vectorCoverage: null,
      accessConcentration: null,
      backlog: { known: false, captureQueue: null, vectorIndex: null },
      latency: { known: false, searchP50Ms: null, searchP95Ms: null, indexingMs: null },
      cost: { known: false, totalUsd: null, embeddingCalls: null, llmCalls: null, tokens: null },
      notes: ["Remote backend health metadata is not exposed by the configured client."],
    };
    write(json, result, () => renderAudit(result));
    return 0;
  }

  const root = memory.path;
  const dbPath = await resolveActiveMemoryDbPath(root);
  const rootExists = await exists(root);
  const size = rootExists ? await collectStoreSize(root) : emptySize();
  let audit: MemoryStoreAudit | undefined;
  let metadataQueryMs: number | null = null;
  if (await exists(dbPath)) {
    const db = openMemoryDb({ path: dbPath });
    try {
      const started = performance.now();
      audit = db.audit();
      metadataQueryMs = performance.now() - started;
    } finally {
      db.close();
    }
  }
  const live = audit?.counts.live ?? 0;
  const liveIndexed = audit?.vectors.liveIndexed ?? 0;
  const semanticExpected = memory.embeddings !== undefined;
  const result = {
    configured: true,
    backend: "bujo",
    mode: memory.mode,
    metadataOnly: true,
    counts: audit?.counts ?? { total: 0, live: 0, entities: 0, entityRelations: 0 },
    bytes: size,
    duplicates: audit?.duplicates ?? { groups: 0, redundantRecords: 0, ratio: 0 },
    vectorCoverage: audit?.vectors ?? { indexed: 0, liveIndexed: 0, liveCoverage: live === 0 ? 1 : 0 },
    accessConcentration: audit?.access ?? { totalCount: 0, accessedMemories: 0, topOnePercentShare: 0 },
    backlog: {
      known: true,
      captureQueue: null,
      vectorIndex: semanticExpected ? Math.max(0, live - liveIndexed) : 0,
    },
    latency: {
      known: metadataQueryMs !== null,
      metadataQueryMs,
      searchP50Ms: null,
      searchP95Ms: null,
      indexingMs: null,
    },
    cost: {
      known: false,
      totalUsd: null,
      embeddingCalls: null,
      llmCalls: null,
      tokens: null,
    },
    notes: [
      ...(audit === undefined ? [`No SQLite index found at ${dbPath}.`] : []),
      "Search latency and model cost require benchmark/run telemetry and are not inferred from memory content.",
      "captureQueue is process-local and unavailable to an offline audit.",
    ],
  };
  write(json, result, () => renderAudit(result));
  return 0;
}

async function loadMemoryCommandContext(
  input: RunMemoryCommandInput,
): Promise<MemoryCommandContext | { readonly code: number }> {
  const cwd = input.cwd;
  const configPath = resolve(cwd, input.configPath ?? "mono-agent.config.json");
  try {
    return {
      cwd,
      env: input.env,
      configPath,
      config: await loadAppCoreConfig({ env: input.env, cwd, configPath }),
    };
  } catch (error) {
    if (isAppCoreConfigError(error)) {
      process.stderr.write(ui.errorLine(error.message));
      process.stderr.write(ui.hint(`Fix ${configPath}, then re-run \`mono-agent memory\`.`));
      return { code: 1 };
    }
    throw error;
  }
}

async function assertNoLiveConfiguredAgent(configPath: string, registryDir: string): Promise<void> {
  const canonicalConfig = await canonicalPath(configPath);
  const { sources } = await listTraceSources({ registryDir });
  let live: (typeof sources)[number] | undefined;
  for (const source of sources) {
    if (source.configPath === undefined || source.pid === undefined || !pidIsAlive(source.pid)) continue;
    if (await canonicalPath(source.configPath) === canonicalConfig) {
      live = source;
      break;
    }
  }
  if (live === undefined) return;
  throw new Error(
    `agent process ${live.pid} is still alive for this config (trace health: ${live.health}); ` +
    `stop it first with: mono-agent stop --config ${canonicalConfig}`,
  );
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function runStats(context: MemoryCommandContext, input: RunMemoryCommandInput): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    writeNoMemory(context.configPath, input.json);
    return 0;
  }
  if ((memory.backend ?? "bujo") === "supermemory") {
    const supermemory = supermemoryStats(context.config);
    write(input.json, supermemory, () => renderSupermemoryStats(supermemory));
    return 0;
  }

  const root = memory.path;
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
    const db = openMemoryDb({ path: dbPath });
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

async function runShow(context: MemoryCommandContext, date: string, json: boolean): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    writeNoMemory(context.configPath, json);
    return 0;
  }
  if ((memory.backend ?? "bujo") === "supermemory") {
    const result = {
      configured: true,
      backend: "supermemory",
      available: false,
      message: "Supermemory stores memories remotely; local daily logs are not available.",
    };
    write(json, result, () => `${ui.banner("mono-agent memory", "daily log")}\n${result.message}\n`);
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

async function runSearch(
  context: MemoryCommandContext,
  query: string,
  input: RunMemoryCommandInput,
): Promise<number> {
  let settings = previewRecallSettings(context.config);
  if (settings === undefined) {
    writeNoMemory(context.configPath, input.json);
    return 0;
  }
  if (!("supermemory" in settings)) {
    const dbPath = await resolveActiveMemoryDbPath(settings.root);
    settings = { ...settings, dbPath };
  }
  if (!("supermemory" in settings) && !(await exists(settings.dbPath ?? join(settings.root, "memory.db")))) {
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
    backend: "supermemory" in settings ? "supermemory" : "bujo",
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

async function runTop(context: MemoryCommandContext, input: RunMemoryCommandInput): Promise<number> {
  const memory = context.config.memory;
  if (memory === undefined) {
    writeNoMemory(context.configPath, input.json);
    return 0;
  }
  if ((memory.backend ?? "bujo") === "supermemory") {
    const result = {
      configured: true,
      backend: "supermemory",
      available: false,
      message: "Supermemory does not expose a local salience ranking; use memory search instead.",
    };
    write(input.json, result, () => `${ui.banner("mono-agent memory", "top")}\n${result.message}\n`);
    return 0;
  }
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
  const db = openMemoryDb({ path: dbPath });
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

function previewRecallSettings(config: MonoAgentConfig): MemoryRecallSettings | undefined {
  const fromTool = resolveMemoryRecallSettings(config);
  if (fromTool !== undefined) {
    return fromTool;
  }
  const memory = config.memory;
  if (memory === undefined) {
    return undefined;
  }
  if ((memory.backend ?? "bujo") === "supermemory") {
    const sm = memory.supermemory;
    if (sm === undefined) {
      return undefined;
    }
    return {
      supermemory: {
        baseUrl: sm.baseUrl,
        container: resolveSupermemoryContainer(config),
        ...(sm.apiKey === undefined ? {} : { apiKey: sm.apiKey }),
        ...(sm.timeoutMs === undefined ? {} : { timeoutMs: sm.timeoutMs }),
      },
    };
  }
  const embeddings = memory.embeddings;
  if (embeddings === undefined) {
    return { root: memory.path };
  }
  return {
    root: memory.path,
    embeddings: {
      provider: embeddings.provider,
      model: embeddings.model,
      ...(embeddings.endpoint === undefined ? {} : { endpoint: embeddings.endpoint }),
      ...(embeddings.apiKey === undefined ? {} : { apiKey: embeddings.apiKey }),
      ...(embeddings.apiKeyEnv === undefined ? {} : { apiKeyEnv: embeddings.apiKeyEnv }),
      ...(embeddings.dim === undefined ? {} : { dim: embeddings.dim }),
      ...(embeddings.timeoutMs === undefined ? {} : { timeoutMs: embeddings.timeoutMs }),
      ...(embeddings.circuitBreaker === undefined ? {} : { circuitBreaker: embeddings.circuitBreaker }),
    },
  };
}

async function recallWithFtsFallback(
  settings: MemoryRecallSettings,
  query: string,
  limit: number,
): Promise<{ readonly hits: readonly PreviewRecallHit[]; readonly degraded?: string }> {
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
      ...(settings.dbPath === undefined ? {} : { dbPath: settings.dbPath }),
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

function isFtsFallbackEligible(settings: MemoryRecallSettings, error: unknown): settings is MemoryRecallBujoSettings {
  if ("supermemory" in settings || settings.embeddings === undefined) {
    return false;
  }
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
  const code = typeof record.code === "string" ? record.code : "";
  if (code.startsWith("embedding_") || code === "invalid_embedding_options") {
    return true;
  }
  const name = error instanceof Error ? error.name : "";
  const message = reasonOf(error).toLocaleLowerCase("en-US");
  return name === "AbortError" ||
    name === "TypeError" ||
    message.includes("fetch failed") ||
    message.includes("embedding") ||
    message.includes("econnrefused") ||
    message.includes("enotfound");
}

function readLocalStats(db: MemoryDb, topEntitiesLimit: number): MemoryStoreStats {
  return db.stats({ topEntitiesLimit });
}

function effectiveLocalTier(memory: NonNullable<MonoAgentConfig["memory"]>): string {
  return memory.mode;
}

function supermemoryStats(config: MonoAgentConfig): {
  readonly configured: true;
  readonly backend: "supermemory";
  readonly baseUrl: string | undefined;
  readonly container: string | undefined;
  readonly known: readonly string[];
  readonly unavailable: readonly string[];
} {
  return {
    configured: true,
    backend: "supermemory",
    baseUrl: config.memory?.supermemory?.baseUrl,
    container: config.memory === undefined ? undefined : resolveSupermemoryContainer(config),
    known: ["backend", "baseUrl", "container"],
    unavailable: [
      "local counts",
      "local size",
      "last capture",
      "last consolidation",
      "top entities",
      "highest-salience memories",
      "daily markdown logs",
    ],
  };
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

async function collectStoreSize(root: string): Promise<{
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

function isUnderDirectory(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function emptySize(): { readonly rootBytes: 0; readonly dailyBytes: 0; readonly databaseBytes: 0; readonly fileCount: 0 } {
  return { rootBytes: 0, dailyBytes: 0, databaseBytes: 0, fileCount: 0 };
}

async function mtimeIso(path: string): Promise<string | undefined> {
  const s = await stat(path).catch(() => undefined);
  return s === undefined ? undefined : s.mtime.toISOString();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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

function todayKey(): string {
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

function writeNoMemory(configPath: string, json: boolean): void {
  const result = {
    configured: false,
    message: `No memory configured in ${configPath}.`,
  };
  write(json, result, () => `${ui.banner("mono-agent memory", "not configured")}\n${result.message}\n`);
}

function write<T>(json: boolean, value: T, human: () => string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : human());
}

function renderSupermemoryStats(stats: ReturnType<typeof supermemoryStats>): string {
  return [
    ui.banner("mono-agent memory", "stats"),
    ui.keyValue([
      ["backend", "supermemory"],
      ["base URL", stats.baseUrl ?? "unknown"],
      ["container", stats.container ?? "unknown"],
    ], 2),
    "Remote-only fields not known locally:\n",
    ...stats.unavailable.map((item) => `  - ${item}\n`),
  ].join("");
}

function renderAudit(result: {
  readonly backend: string;
  readonly counts: { readonly total: number; readonly live: number; readonly entities: number; readonly entityRelations: number } | null;
  readonly bytes: { readonly rootBytes: number; readonly dailyBytes: number; readonly databaseBytes: number; readonly fileCount: number } | null;
  readonly duplicates: { readonly groups: number; readonly redundantRecords: number; readonly ratio: number } | null;
  readonly vectorCoverage: { readonly indexed: number; readonly liveIndexed: number; readonly liveCoverage: number } | null;
  readonly accessConcentration: { readonly totalCount: number; readonly accessedMemories: number; readonly topOnePercentShare: number } | null;
  readonly backlog: { readonly captureQueue: number | null; readonly vectorIndex: number | null };
  readonly latency: { readonly metadataQueryMs?: number | null; readonly searchP50Ms: number | null; readonly searchP95Ms: number | null; readonly indexingMs: number | null };
  readonly cost: { readonly totalUsd: number | null; readonly embeddingCalls: number | null; readonly llmCalls: number | null; readonly tokens: number | null };
  readonly notes: readonly string[];
}): string {
  let out = ui.banner("mono-agent memory", "metadata audit") + "\n";
  out += ui.keyValue([
    ["backend", result.backend],
    ["memories", result.counts === null ? "unknown" : `${result.counts.total} total, ${result.counts.live} live`],
    ["bytes", result.bytes === null ? "unknown" : formatBytes(result.bytes.rootBytes)],
    ["duplicate ratio", result.duplicates === null ? "unknown" : formatRatio(result.duplicates.ratio)],
    ["vector coverage", result.vectorCoverage === null ? "unknown" : formatRatio(result.vectorCoverage.liveCoverage)],
    ["top 1% access share", result.accessConcentration === null ? "unknown" : formatRatio(result.accessConcentration.topOnePercentShare)],
    ["vector backlog", result.backlog.vectorIndex === null ? "unknown" : String(result.backlog.vectorIndex)],
    ["capture queue", result.backlog.captureQueue === null ? "unavailable offline" : String(result.backlog.captureQueue)],
    ["metadata query", result.latency.metadataQueryMs == null ? "unknown" : `${result.latency.metadataQueryMs.toFixed(3)} ms`],
    ["recorded cost", result.cost.totalUsd === null ? "unknown" : `$${result.cost.totalUsd.toFixed(6)}`],
  ], 2);
  for (const note of result.notes) out += ui.style.yellow(`[WARN] ${note}`) + "\n";
  return out;
}

function renderLocalStats(stats: {
  readonly mode: string;
  readonly effectiveTier: string;
  readonly writeMode: string;
  readonly recallToolEnabled: boolean;
  readonly root: string;
  readonly database?: string;
  readonly counts: {
    readonly total: number;
    readonly live: number;
    readonly byStatus: Readonly<Record<string, number>>;
    readonly byType: Readonly<Record<string, number>>;
    readonly entities: number;
  };
  readonly size: { readonly rootBytes: number; readonly dailyBytes: number; readonly databaseBytes: number; readonly fileCount: number };
  readonly lastCapture?: string;
  readonly lastAccess?: string;
  readonly lastConsolidation?: string;
  readonly topEntities: readonly EntityRecord[];
  readonly notes: readonly string[];
}): string {
  let out = ui.banner("mono-agent memory", "stats") + "\n";
  out += ui.keyValue([
    ["backend", "bujo"],
    ["configured tier", stats.mode],
    ["effective tier", stats.effectiveTier],
    ["write mode", stats.writeMode],
    ["recall tool", stats.recallToolEnabled ? "enabled" : "disabled"],
    ["root", stats.root],
    ["database", stats.database ?? "missing"],
    ["memories", `${stats.counts.total} total, ${stats.counts.live} live`],
    ["entities", String(stats.counts.entities)],
    ["size", `${formatBytes(stats.size.rootBytes)} (${stats.size.fileCount} files)`],
    ["daily logs", formatBytes(stats.size.dailyBytes)],
    ["database files", formatBytes(stats.size.databaseBytes)],
    ["last capture", stats.lastCapture ?? "unknown"],
    ["last access", stats.lastAccess ?? "unknown"],
    ["last consolidation", stats.lastConsolidation ?? "unknown"],
  ], 2);
  out += renderCounts("Status counts", stats.counts.byStatus);
  out += renderCounts("Type counts", stats.counts.byType);
  if (stats.topEntities.length > 0) {
    out += "\n" + ui.heading("Top Entities");
    for (const entity of stats.topEntities) {
      out += `  - ${entity.name}${entity.type === undefined ? "" : ` (${entity.type})`}`;
      if (entity.summary !== undefined) {
        out += `: ${entity.summary}`;
      }
      out += "\n";
    }
  }
  for (const note of stats.notes) {
    out += ui.style.yellow(`[WARN] ${note}`) + "\n";
  }
  return out;
}

function renderDaily(result: { readonly date: string; readonly path: string; readonly content: string }): string {
  return [
    ui.banner("mono-agent memory", result.date),
    ui.keyValue([["source", result.path]], 2),
    "\n",
    result.content.endsWith("\n") ? result.content : `${result.content}\n`,
  ].join("");
}

function renderIndexTransition(result: {
  readonly operation: "rebuild" | "rollback";
  readonly activeDatabase: string;
  readonly details: unknown;
}): string {
  return [
    ui.banner("mono-agent memory", result.operation),
    "\n",
    ui.keyValue([
      ["status", "complete"],
      ["active database", result.activeDatabase],
    ], 2),
  ].join("");
}

function renderSearch(result: {
  readonly query: string;
  readonly degraded?: string;
  readonly hits: readonly { readonly score: number; readonly text: string; readonly source?: string }[];
  readonly notes?: readonly string[];
}): string {
  let out = ui.banner("mono-agent memory", `search: ${result.query}`) + "\n";
  if (result.degraded !== undefined) {
    out += ui.style.yellow(`[WARN] ${result.degraded}`) + "\n";
  }
  for (const note of result.notes ?? []) {
    out += ui.style.yellow(`[WARN] ${note}`) + "\n";
  }
  if (result.hits.length === 0) {
    return out + "No memories matched.\n";
  }
  for (const hit of result.hits) {
    out += `${hit.score.toFixed(3)}  ${hit.text}\n`;
    if (hit.source !== undefined) {
      out += `       source: ${hit.source}\n`;
    }
  }
  return out;
}

function renderTop(result: {
  readonly hits: readonly {
    readonly salience: number;
    readonly text: string;
    readonly source?: string;
    readonly status?: string;
    readonly type?: string;
  }[];
  readonly notes?: readonly string[];
}): string {
  let out = ui.banner("mono-agent memory", "top") + "\n";
  for (const note of result.notes ?? []) {
    out += ui.style.yellow(`[WARN] ${note}`) + "\n";
  }
  if (result.hits.length === 0) {
    return out + "No memories indexed.\n";
  }
  for (const hit of result.hits) {
    const meta = [
      `salience ${hit.salience.toFixed(3)}`,
      ...(hit.type === undefined ? [] : [hit.type]),
      ...(hit.status === undefined ? [] : [hit.status]),
      ...(hit.source === undefined ? [] : [`source ${hit.source}`]),
    ].join("; ");
    out += `${hit.text}\n`;
    out += `       ${meta}\n`;
  }
  return out;
}

function renderCounts(label: string, counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return "";
  }
  return "\n" + ui.heading(label) + entries.map(([key, value]) => `  ${key}: ${value}\n`).join("");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0] ?? "KB";
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i] ?? unit;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function formatRatio(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
