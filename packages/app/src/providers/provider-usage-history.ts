import { createHmac, randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  PROVIDER_USAGE_HISTORY_SCHEMA, PROVIDER_USAGE_LABELS, PROVIDER_USAGE_SCHEMA,
  parseProviderUsageSnapshot, parseProviderUsageHistory, parseProviderUsageHistoryQuery, usageHistoryBucket,
  type ProviderUsage, type ProviderUsageHistory, type ProviderUsageHistoryQuery,
  type ProviderUsageHistorySample, type ProviderUsageId,
} from "@mono-agent/contracts";
import { createProviderUsageHistoryQueue } from "./provider-usage-history-queue.js";
import { openOwnedState, type OwnedStateHandle } from "../durable-state/owned-state-sqlite.js";

const DAY = 86_400_000;
const RETENTION_MS = 90 * DAY;
const MAX_SAMPLES = 50_000;
const MAX_PARTITIONS = 64;
const MAX_RESPONSE_SAMPLES = 2048;
interface Row {
  id: number; first_at: number; last_at: number; observations: number; max_gap: number;
  payload: string; account_changed: number;
}
/** Private host seam. Account material is immediately HMACed, never stored verbatim. */
export interface ProviderUsageHistorySink {
  append(usage: ProviderUsage, accountMaterial: string | undefined, retain: () => boolean): Promise<void>;
  read(query: ProviderUsageHistoryQuery, providers: readonly ProviderUsageId[]): Promise<ProviderUsageHistory>;
  clear(providers: readonly ProviderUsageId[]): Promise<void>;
}

/** Per-agent owner; auth-file scopes share capacity, but never raw paths or identities. */
export function createProviderUsageHistoryStore(options: {
  readonly cwd: string;
  readonly now?: () => number;
  /** Test seams; may only tighten the production caps. */
  readonly maxSamples?: number;
  readonly maxDatabaseBytes?: number;
  readonly timeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly open?: typeof openOwnedState;
}) {
  const now = options.now ?? Date.now;
  const maxSamples = Math.max(1, Math.min(MAX_SAMPLES, options.maxSamples ?? MAX_SAMPLES));
  const queue = createProviderUsageHistoryQueue({
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
  });
  let handle: OwnedStateHandle | undefined;
  let opening: Promise<OwnedStateHandle | undefined> | undefined;
  let stopped = false;
  let degraded = false;
  async function get(create: boolean, signal: AbortSignal): Promise<OwnedStateHandle | undefined> {
    if (stopped || signal.aborted) return undefined;
    if (handle) return handle;
    if (opening) {
      const opened = await opening;
      // A no-create history read may have won the initialization flight.
      // A retained real fetch must still initialize its own durable writer.
      return opened ?? (create && !stopped ? get(true, signal) : undefined);
    }
    opening = (async () => {
      if (!create) {
        try { await lstat(join(options.cwd, ".mono-agent", "provider-usage-v1", "state.sqlite")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
      }
      const opened = await (options.open ?? openOwnedState)({
        signal,
        cwd: options.cwd,
        name: "provider-usage-v1",
        label: "Provider quota history",
        schemaVersion: 1,
        createSchema(db) {
          db.exec(`
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE partitions (
              scope TEXT NOT NULL, provider TEXT NOT NULL, fingerprint TEXT, last_at INTEGER NOT NULL,
              truncated_before INTEGER, PRIMARY KEY(scope, provider)
            );
            CREATE TABLE samples (
              id INTEGER PRIMARY KEY, scope TEXT NOT NULL, provider TEXT NOT NULL,
              first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
              observations INTEGER NOT NULL CHECK(observations > 0), max_gap INTEGER NOT NULL CHECK(max_gap >= 0),
              payload TEXT NOT NULL CHECK(length(payload) <= 2048),
              account_changed INTEGER NOT NULL CHECK(account_changed IN (0,1)),
              FOREIGN KEY(scope, provider) REFERENCES partitions(scope, provider) ON DELETE CASCADE
            );
            CREATE INDEX samples_by_partition ON samples(scope, provider, last_at, id);
            CREATE INDEX samples_by_age ON samples(last_at, id);
          `);
          db.prepare("INSERT INTO meta VALUES ('hmac-key', ?)").run(randomBytes(32).toString("hex"));
        },
      });
      try {
        // DELETE journaling (owned-state default) prevents an unbounded WAL. Reuse freed pages.
        const pageSize = (opened.database.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
        const maxPages = Math.floor(
          Math.min(128 * 1024 * 1024, options.maxDatabaseBytes ?? 128 * 1024 * 1024) / pageSize,
        );
        opened.database.exec(`PRAGMA max_page_count=${maxPages}; PRAGMA synchronous=FULL;`);
        if ((opened.database.prepare("PRAGMA page_count").get() as { page_count: number }).page_count > maxPages)
          throw new Error("History database exceeds its safety bound.");
        const key = opened.database.prepare("SELECT value FROM meta WHERE key='hmac-key'")
          .get() as { value?: unknown } | undefined;
        if (typeof key?.value !== "string" || !/^[a-f0-9]{64}$/u.test(key.value))
          throw new Error("Invalid history metadata.");
        if (stopped || signal.aborted) { opened.close(); return undefined; }
        opened.transaction(() => prune(opened));
        handle = opened;
        return opened;
      } catch (error) {
        // A schema-valid but malformed domain table must not strand the writer lease.
        opened.close();
        throw error;
      }
    })().finally(() => { opening = undefined; });
    return opening;
  }
  function digest(h: OwnedStateHandle, domain: string, values: readonly string[]): string {
    const key = h.database.prepare("SELECT value FROM meta WHERE key='hmac-key'").get() as { value: string };
    return createHmac("sha256", Buffer.from(key.value, "hex"))
      .update(JSON.stringify([domain, ...values])).digest("hex");
  }
  function prune(h: OwnedStateHandle, reserve = 0) {
    const db = h.database;
    db.prepare("DELETE FROM samples WHERE last_at < ?").run(now() - RETENTION_MS);
    const extra = (db.prepare("SELECT COUNT(*) AS n FROM samples").get() as { n: number }).n + reserve - maxSamples;
    if (extra > 0) {
      const discarded = db.prepare(`
        SELECT scope, provider, MAX(last_at) AS at
        FROM (SELECT * FROM samples ORDER BY last_at,id LIMIT ?)
        GROUP BY scope,provider
      `).all(extra) as Array<{ scope: string; provider: string; at: number }>;
      for (const row of discarded)
        db.prepare(`
          UPDATE partitions SET truncated_before=MAX(COALESCE(truncated_before,0),?)
          WHERE scope=? AND provider=?
        `).run(row.at, row.scope, row.provider);
      db.prepare("DELETE FROM samples WHERE id IN (SELECT id FROM samples ORDER BY last_at,id LIMIT ?)").run(extra);
    }
    db.prepare("DELETE FROM partitions WHERE last_at < ?").run(now() - RETENTION_MS);
  }
  function empty(
    query: ProviderUsageHistoryQuery,
    providers: readonly ProviderUsageId[],
    storage: "ready" | "unavailable",
  ): ProviderUsageHistory {
    const { provider: _provider, ...range } = query;
    return {
      schema: PROVIDER_USAGE_HISTORY_SCHEMA,
      ...range,
      retentionDays: 90,
      storage,
      providers: providers.map(providerId => ({
        providerId,
        label: PROVIDER_USAGE_LABELS[providerId],
        samples: [],
        accountChanges: [],
        downsampled: false,
      })),
    };
  }
  return {
    forScope(authScope: string): ProviderUsageHistorySink {
      const operations = {
        async append(input: ProviderUsage, accountMaterial: string | undefined, retain: () => boolean, signal: AbortSignal) {
          try {
            const usage = parseProviderUsageSnapshot({
              schema: PROVIDER_USAGE_SCHEMA, providers: [input],
            }).providers[0]!;
            if (usage.error || usage.stale || !retain()) return;
            const payload = JSON.stringify({
              windows: usage.windows,
              ...(usage.plan === undefined ? {} : { plan: usage.plan }),
            });
            if (Buffer.byteLength(payload) > 2048) throw new Error("History sample exceeds its bound.");
            const h = await get(true, signal);
            if (!h || !retain() || signal.aborted || stopped) return;
            const at = Date.parse(usage.fetchedAt), scope = digest(h, "quota-scope-v1", [authScope]);
            const fingerprint = accountMaterial === undefined
              ? null : digest(h, "quota-account-v1", [usage.providerId, accountMaterial]);
            h.transaction(() => {
              prune(h);
              const db = h.database;
              const previous = db.prepare("SELECT fingerprint FROM partitions WHERE scope=? AND provider=?")
                .get(scope, usage.providerId) as { fingerprint: string | null } | undefined;
              const changed = previous?.fingerprint != null && fingerprint !== null
                && previous.fingerprint !== fingerprint;
              db.prepare(`INSERT INTO partitions(scope,provider,fingerprint,last_at) VALUES(?,?,?,?)
                ON CONFLICT(scope,provider) DO UPDATE SET
                  fingerprint=COALESCE(excluded.fingerprint,partitions.fingerprint),last_at=excluded.last_at
              `).run(scope, usage.providerId, fingerprint, at);
              const excess = (db.prepare("SELECT COUNT(*) AS n FROM partitions").get() as { n: number }).n
                - MAX_PARTITIONS;
              if (excess > 0)
                db.prepare(`
                  DELETE FROM partitions WHERE (scope,provider) IN (
                    SELECT scope,provider FROM partitions WHERE NOT (scope=? AND provider=?)
                    ORDER BY last_at,scope,provider LIMIT ?
                  )
                `).run(scope, usage.providerId, excess);
              const last = db.prepare(`
                SELECT * FROM samples WHERE scope=? AND provider=?
                ORDER BY last_at DESC,id DESC LIMIT 1
              `).get(scope, usage.providerId) as unknown as (Row & { payload: string }) | undefined;
              // Close spans daily: compression never grows an unbounded timestamp array.
              if (!changed && last?.payload === payload && at >= last.last_at
                && Math.floor(at / DAY) === Math.floor(last.first_at / DAY)) {
                db.prepare(`
                  UPDATE samples SET last_at=?,observations=MIN(observations+1,9007199254740991),
                  max_gap=MAX(max_gap,?) WHERE id=?
                `).run(at, at - last.last_at, last.id);
              } else {
                prune(h, 1);
                db.prepare(`
                  INSERT INTO samples(scope,provider,first_at,last_at,observations,max_gap,payload,account_changed)
                  VALUES(?,?,?,?,1,0,?,?)
                `).run(scope, usage.providerId, at, at, payload, Number(changed));
              }
            });
            degraded = false;
          } catch { degraded = true; } // Disk failure must not rewrite vendor success/backoff or leak diagnostics.
        },
        async read(input: ProviderUsageHistoryQuery, providers: readonly ProviderUsageId[], signal: AbortSignal) {
          const query = parseProviderUsageHistoryQuery(input);
          try {
            const h = await get(false, signal);
            if (!h) return empty(query, providers, degraded ? "unavailable" : "ready");
            if (degraded) return empty(query, providers, "unavailable");
            const scope = digest(h, "quota-scope-v1", [authScope]);
            const from = Math.max(Date.parse(query.from), now() - RETENTION_MS), to = Date.parse(query.to);
            const result = empty(query, providers, "ready");
            return parseProviderUsageHistory({ ...result, providers: providers.map(providerId => {
              const rows = h.database.prepare(`
                SELECT * FROM samples WHERE scope=? AND provider=? AND last_at>=? AND first_at<?
                ORDER BY first_at,id
              `).all(scope, providerId, from, to) as unknown as Row[];
              const partition = h.database.prepare(`
                SELECT truncated_before FROM partitions WHERE scope=? AND provider=?
              `).get(scope, providerId) as { truncated_before: number | null } | undefined;
              const points: ProviderUsageHistorySample[] = [];
              const boundaries = rows.filter(r => r.account_changed && r.first_at >= from)
                .map(r => new Date(r.first_at).toISOString());
              const boundarySet = new Set(boundaries);
              for (const row of rows) {
                const payload = JSON.parse(row.payload) as Pick<ProviderUsage, "windows" | "plan">;
                // Only actual observed endpoints, never interpolated measurements at range edges.
                const times = [...new Set([row.first_at, row.last_at])].filter(at => at >= from && at < to);
                for (const at of times) points.push({
                  fetchedAt: new Date(at).toISOString(),
                  observedThrough: new Date(at).toISOString(),
                  observations: row.observations,
                  maxGapMs: row.max_gap,
                  ...payload,
                });
              }
              points.sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
              const keep = new Set<ProviderUsageHistorySample>();
              const buckets = new Map<number, ProviderUsageHistorySample[]>();
              for (const point of points) {
                const bucket = usageHistoryBucket(Date.parse(point.fetchedAt), query).start;
                const group = buckets.get(bucket) ?? []; group.push(point); buckets.set(bucket, group);
                if (boundarySet.has(point.fetchedAt)) keep.add(point);
              }
              for (const group of buckets.values()) {
                keep.add(group[0]!); keep.add(group.at(-1)!);
                for (const kind of new Set(group.flatMap(p => p.windows.map(w => w.kind)))) {
                  const withWindow = group.filter(p => p.windows.some(w => w.kind === kind));
                  const percent = (p: ProviderUsageHistorySample) => p.windows.find(w => w.kind === kind)!.usedPercent;
                  keep.add(withWindow.reduce((a, b) => percent(a) <= percent(b) ? a : b));
                  keep.add(withWindow.reduce((a, b) => percent(a) >= percent(b) ? a : b));
                }
                // Preserve detected reset/plan/window transitions, not just percentage extrema.
                for (let i = 1; i < group.length; i++) {
                  const shape = (p: ProviderUsageHistorySample) => JSON.stringify([
                    p.plan, p.windows.map(w => [w.kind, w.resetsAt, w.periodMs]),
                  ]);
                  if (shape(group[i - 1]!) !== shape(group[i]!)) { keep.add(group[i - 1]!); keep.add(group[i]!); }
                }
              }
              const reduced = points.filter(p => keep.has(p));
              const samples = reduced.slice(-MAX_RESPONSE_SAMPLES);
              const clippedAt = reduced.length > samples.length ? samples[0]?.fetchedAt : undefined;
              const storedCutoff = partition?.truncated_before == null
                ? undefined : new Date(partition.truncated_before).toISOString();
              const truncatedBefore = [clippedAt, storedCutoff]
                .filter((v): v is string => v !== undefined).sort().at(-1);
              return {
                providerId,
                label: PROVIDER_USAGE_LABELS[providerId],
                samples,
                accountChanges: boundaries.filter(at => clippedAt === undefined || at >= clippedAt)
                  .slice(-MAX_RESPONSE_SAMPLES),
                downsampled: samples.length < points.length,
                ...(truncatedBefore === undefined ? {} : { truncatedBefore }),
              };
            }) });
          } catch { return empty(query, providers, "unavailable"); }
        },
        async clear(providers: readonly ProviderUsageId[], signal: AbortSignal) {
          try {
            const h = await get(false, signal);
            if (!h) { if (degraded) throw new Error("unavailable"); return; }
            signal.throwIfAborted();
            const scope = digest(h, "quota-scope-v1", [authScope]);
            h.transaction(() => {
              for (const provider of providers)
                h.database.prepare("DELETE FROM partitions WHERE scope=? AND provider=?").run(scope, provider);
            });
            degraded = false;
          } catch { throw new Error("Quota history storage is unavailable."); }
        },
      };
      return {
        append: (usage, account, retain) => queue.enqueue(signal =>
          operations.append(usage, account, () => !signal.aborted && retain(), signal)
        ).catch(() => { degraded = true; }),
        read: (query, providers) => queue.enqueue(signal => operations.read(query, providers, signal))
          .catch(() => empty(parseProviderUsageHistoryQuery(query), providers, "unavailable")),
        clear: providers => queue.enqueue(signal => operations.clear(providers, signal))
          .catch(() => { throw new Error("Quota history storage is unavailable."); }),
      };
    },
    async close() {
      await queue.close();
      stopped = true;
      handle?.close(); handle = undefined;
    },
  };
}
