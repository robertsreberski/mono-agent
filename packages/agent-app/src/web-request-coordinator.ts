import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeRunOptions } from "@mono-agent/runtime-adapter";
import { acquireOwnerPrivateLock } from "./owner-private-lock.js";
import { currentProcessIncarnation, isSameProcessIncarnation, processIncarnationFromJson, type ProcessIncarnation } from "./process-incarnation.js";
import { readVerifiedFile, secureFileReplace } from "./secure-file-replace.js";

type Coordinator = NonNullable<RuntimeRunOptions["webRequestCoordinator"]>;
type Lease = { id: string; pid: number; incarnation: ProcessIncarnation; expiresAt: number };
type Bucket = { nextAt: number; cooldownUntil: number; strikes: number; failures: number; leases: Lease[] };
type State = { schema: "mono-agent.web-control.v1"; buckets: Record<string, Bucket>; quota?: { checkedAt: number; value: unknown } };
const MAX_STATE_BYTES = 256 * 1024;
const MAX_BUCKETS = 512;
const defaults = { searxng: [1, 2000], ollama: [1, 2000], duckduckgo: [1, 3000], startpage: [1, 3000], codex: [1, 0], fetch: [2, 500] } as const;

export function webControlDirectory(): string { return join(homedir(), ".mono-agent", "web-control"); }

/** Host-owned operational state only: no queries, documents, or credentials. */
export function createHostWebRequestCoordinator(options: {
  directory?: string;
  now?: () => number;
  spacingScale?: number;
} = {}): Coordinator & { inspect(): Promise<unknown>; reset(): Promise<void> } {
  const directory = options.directory ?? webControlDirectory();
  const now = options.now ?? Date.now;
  const statePath = join(directory, "state.json");
  let incarnation: Promise<ProcessIncarnation> | undefined;

  async function prepare(): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw unavailable();
  }

  async function unsafeTransaction<T>(change: (state: State) => Promise<T> | T): Promise<T> {
    await prepare();
    const lock = await acquireOwnerPrivateLock({
      path: join(directory, ".lock"), label: "Web request coordination",
      schemaTag: "mono-agent.web-control-lock.v1", ownerlessGraceMs: 5000,
      waitTimeoutMs: 2000, pollIntervalMs: 25, invalidOwner: "error",
    });
    if (!lock) throw unavailable();
    try {
      const snapshot = await readVerifiedFile(statePath, {
        validate: (s) => {
          if (!s.isFile() || s.nlink !== 1n || (s.mode & 0o077n) !== 0n || s.size > BigInt(MAX_STATE_BYTES)
            || (process.getuid && s.uid !== BigInt(process.getuid()))) throw unavailable();
        }, changedError: unavailable,
      });
      const state = snapshot ? parseState(snapshot.contents.toString("utf8")) : emptyState();
      const before = JSON.stringify(state);
      const result = await change(state);
      const contents = JSON.stringify(state);
      if (Buffer.byteLength(contents) > MAX_STATE_BYTES) throw unavailable();
      if (contents === before) return result;
      await secureFileReplace({
        path: statePath, contents, mode: 0o600,
        target: { recovery: "preserve-current", expected: snapshot ? {
          kind: "present", invalidError: unavailable,
          validate: async (path) => {
            const s = await lstat(path, { bigint: true });
            return s.dev === snapshot.details.dev && s.ino === snapshot.details.ino;
          },
        } : { kind: "missing" } },
      });
      return result;
    } finally { await lock.release(); }
  }

  async function transaction<T>(change: (state: State) => Promise<T> | T): Promise<T> {
    try { return await unsafeTransaction(change); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["rate_limited", "deadline_exceeded", "coordination_unavailable", "ABORT_ERR"].includes(code ?? "")
        || (error as Error).name === "AbortError"
        || (error as Error).message === "Cannot reset web control while requests are active.") throw error;
      throw unavailable();
    }
  }

  async function prune(state: State): Promise<void> {
    const owners = new Map<string, Promise<boolean>>();
    for (const [key, bucket] of Object.entries(state.buckets)) {
      const retained: Lease[] = [];
      for (const lease of bucket.leases) {
        if (lease.expiresAt <= now()) continue;
        const ownerKey = JSON.stringify([lease.pid, lease.incarnation]);
        let alive = owners.get(ownerKey);
        if (!alive) { alive = isSameProcessIncarnation(lease.pid, lease.incarnation); owners.set(ownerKey, alive); }
        if (await alive) retained.push(lease);
      }
      bucket.leases = retained;
      if (!retained.length && bucket.cooldownUntil <= now() && bucket.nextAt + 3_600_000 < now()) delete state.buckets[key];
    }
  }

  return {
    scope: `host:${createHash("sha256").update(directory).digest("hex")}`,
    async acquire(request) {
      const started = now();
      const kind = request.kind;
      const [max, spacing] = defaults[kind];
      const key = `${kind}:${createHash("sha256").update(request.key).digest("hex")}`;
      const owner = await (incarnation ??= currentProcessIncarnation());
      while (true) {
        request.signal?.throwIfAborted();
        if (now() >= request.deadlineMs) throw Object.assign(new Error("Web request deadline exceeded."), { code: "deadline_exceeded" });
        const admitted = await transaction(async (state) => {
          await prune(state);
          let bucket = state.buckets[key];
          if (!bucket) {
            if (Object.keys(state.buckets).length >= MAX_BUCKETS) throw unavailable();
            bucket = state.buckets[key] = { nextAt: 0, cooldownUntil: 0, strikes: 0, failures: 0, leases: [] };
          }
          if (bucket.cooldownUntil > now()) throw Object.assign(new Error("Web backend is cooling down."), {
            code: "rate_limited", retryAfterMs: bucket.cooldownUntil - now(),
          });
          // One half-open probe, even for normally concurrent fetches.
          const capacity = bucket.strikes > 0 || bucket.failures >= 2 ? 1 : max;
          if (bucket.leases.length >= capacity || bucket.nextAt > now()) return undefined;
          request.signal?.throwIfAborted();
          const id = randomUUID();
          bucket.leases.push({ id, pid: process.pid, incarnation: owner, expiresAt: request.deadlineMs + 5000 });
          bucket.nextAt = now() + spacing * (options.spacingScale ?? 1);
          return id;
        });
        if (!admitted) {
          await delay(Math.min(100, Math.max(1, request.deadlineMs - now())), undefined, { signal: request.signal });
          continue;
        }
        let completed = false;
        return {
          waitMs: now() - started,
          async complete(outcome) {
            if (completed) return;
            await transaction((state) => {
              const bucket = state.buckets[key];
              if (!bucket) throw unavailable();
              bucket.leases = bucket.leases.filter((lease) => lease.id !== admitted);
              if (outcome.status === "rate_limited") {
                bucket.strikes += 1;
                const base = kind === "fetch" ? 60_000 : 300_000;
                const wait = outcome.retryAfterMs ?? Math.min(3_600_000, base * 2 ** Math.min(10, bucket.strikes - 1));
                bucket.cooldownUntil = Math.max(bucket.cooldownUntil, now() + Math.max(0, wait));
              } else if (outcome.status === "unavailable") {
                bucket.failures += 1;
                if (bucket.failures >= 2) bucket.cooldownUntil = Math.max(bucket.cooldownUntil, now() + 60_000);
              } else if (outcome.status === "ok" && bucket.cooldownUntil <= now()) {
                bucket.strikes = 0; bucket.failures = 0;
              }
            });
            completed = true;
          },
        };
      }
    },
    async inspect() {
      return await transaction((state) => ({
        scope: "host", buckets: Object.entries(state.buckets).map(([key, b]) => ({
          backend: key.split(":")[0], active: b.leases.length,
          cooldownUntil: b.cooldownUntil, failures: b.failures, strikes: b.strikes,
        })), quotaCheckedAt: state.quota?.checkedAt ?? null,
      }));
    },
    async reset() {
      await transaction(async (state) => {
        await prune(state);
        if (Object.values(state.buckets).some((b) => b.leases.length > 0)) throw new Error("Cannot reset web control while requests are active.");
        state.buckets = {}; delete state.quota;
      });
    },
    async readQuota() { return await transaction((state) => state.quota); },
    async writeQuota(value) { await transaction((state) => { state.quota = { checkedAt: now(), value }; }); },
  };
}

/** Readiness/reset use the same validation and lock as requests, never remove active leases. */
export async function inspectWebControl(directory = webControlDirectory()): Promise<{ exists: boolean; bytes: number }> {
  try {
    const details = await lstat(join(directory, "state.json"));
    if (!details.isFile() || details.isSymbolicLink() || details.size > MAX_STATE_BYTES) throw unavailable();
    await createHostWebRequestCoordinator({ directory }).readQuota();
    return { exists: true, bytes: details.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, bytes: 0 };
    throw error;
  }
}

function emptyState(): State { return { schema: "mono-agent.web-control.v1", buckets: {} }; }
function unavailable(): Error { return Object.assign(new Error("Web request coordination state is unavailable or unsafe."), { code: "coordination_unavailable" }); }
function parseState(text: string): State {
  let value: State;
  try { value = JSON.parse(text) as State; } catch { throw unavailable(); }
  if (value?.schema !== "mono-agent.web-control.v1" || !value.buckets || Array.isArray(value.buckets)
    || typeof value.buckets !== "object" || Object.keys(value.buckets).length > MAX_BUCKETS) throw unavailable();
  for (const [key, bucket] of Object.entries(value.buckets)) {
    if (!/^(searxng|ollama|duckduckgo|startpage|codex|fetch):[a-f0-9]{64}$/u.test(key)
      || !bucket || ![bucket.nextAt, bucket.cooldownUntil, bucket.strikes, bucket.failures].every((v) => Number.isSafeInteger(v) && v >= 0)
      || !Array.isArray(bucket.leases) || bucket.leases.length > 2) throw unavailable();
    for (const lease of bucket.leases) {
      if (!lease || typeof lease.id !== "string" || !Number.isSafeInteger(lease.pid) || lease.pid <= 0
        || !Number.isSafeInteger(lease.expiresAt) || !processIncarnationFromJson(lease.incarnation)) throw unavailable();
    }
  }
  if (value.quota && (!Number.isSafeInteger(value.quota.checkedAt) || value.quota.checkedAt < 0)) throw unavailable();
  return value;
}
