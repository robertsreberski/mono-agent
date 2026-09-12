import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { MonoAgentConfig } from "@mono-agent/config";
import type { RuntimeModelReference } from "@mono-agent/runtime-adapter";

import { acquireContinuationStoreLock, ensureOwnerOnlyDirectory, writeJsonAtomic } from "./continuation-store-fs.js";

export interface InstanceDefinition {
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly model?: RuntimeModelReference;
  readonly effort?: string;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpServers?: Record<string, object>;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
}
export interface InstanceUsage { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }
export interface SubagentInstance {
  id: string;
  conversationId: string;
  name: string;
  systemPrompt: string;
  definition: InstanceDefinition;
  sessionId: string;
  sessionsRoot: string;
  status: "idle" | "running" | "closed" | "expired";
  turns: number;
  usage: InstanceUsage;
  createdAt: number;
  updatedAt: number;
  lastStatus?: string;
  lastAnswerHead?: string;
}
export interface InstanceSpec { id?: string; name: string; systemPrompt: string; definition: InstanceDefinition }
export interface InstanceOutcome { status: string; usage?: Partial<InstanceUsage>; answerHead?: string }
export interface InstanceRegistryHandle {
  list(): Promise<SubagentInstance[]>;
  get(id: string): Promise<SubagentInstance | undefined>;
  create(spec: InstanceSpec): Promise<SubagentInstance>;
  begin(id: string): Promise<SubagentInstance>;
  finish(id: string, outcome: InstanceOutcome): Promise<SubagentInstance>;
  close(id: string): Promise<SubagentInstance>;
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const DAY = 86_400_000;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const subagentConversationRoot = (root: string, conversationId: string): string => resolve(root, hash(conversationId));
export const subagentInstanceSessionId = (conversationId: string, id: string): string => `sub-${hash(`${conversationId}\0${id}`).slice(0, 40)}`;
export const isLiveSubagentInstance = (record: SubagentInstance): boolean => record.status === "idle" || record.status === "running";
export function subagentInstancesRoot(config: Pick<MonoAgentConfig, "subagents" | "artifacts">): string {
  return config.subagents?.instances?.root ?? resolve(config.artifacts.dir, "..", "subagents");
}

// Serialize callers in this process before taking the cross-process file lock.
const tails = new Map<string, Promise<void>>();
const turns = new Map<string, { release(): Promise<void> }>();
async function serialize<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(path) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((done) => { release = done; });
  tails.set(path, next);
  await previous;
  try { return await fn(); } finally {
    release();
    if (tails.get(path) === next) tails.delete(path);
  }
}

/** JSON owns the records; OS-released SQLite file locks protect mutations and active turns across crashes. */
export function createSubagentInstanceRegistry(options: {
  root: string;
  maxPerConversation?: number;
  idleTtlMs?: number;
  maxTurns?: number;
  now?: () => number;
  retireSession: (sessionId: string, sessionsRoot: string) => Promise<unknown>;
}): { open(conversationId: string): Promise<InstanceRegistryHandle> } {
  const now = options.now ?? Date.now;
  return {
    async open(conversationId) {
      const directory = subagentConversationRoot(options.root, conversationId);
      const sessionsRoot = resolve(directory, "sessions");
      const file = resolve(directory, "instances.json");
      const turnPath = (id: string): string => resolve(directory, "turn-locks", id);
      const retire = async (record: SubagentInstance): Promise<void> => {
        try { await options.retireSession(record.sessionId, sessionsRoot); } catch { /* Terminal record stays retired even if provider cleanup fails. */ }
      };
      const transaction = async <T>(operation: (records: SubagentInstance[]) => Promise<T>): Promise<T> => serialize(directory, async () => {
        await ensureOwnerOnlyDirectory(directory);
        const lock = await acquireContinuationStoreLock(resolve(directory, "registry-lock"));
        try {
          let records: SubagentInstance[];
          try {
            const raw: unknown = JSON.parse(await readFile(file, "utf8"));
            if (!Array.isArray(raw)) throw new Error("Invalid subagent instance registry.");
            records = raw as SubagentInstance[];
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            records = [];
          }
          const ids = new Set<string>();
          for (const record of records) {
            if (!record || !ID.test(record.id) || ids.has(record.id) || record.conversationId !== conversationId
              || record.sessionId !== subagentInstanceSessionId(conversationId, record.id)
              || !["idle", "running", "closed", "expired"].includes(record.status)
              || !Number.isInteger(record.turns) || record.turns < 0 || !Number.isFinite(record.updatedAt)
              || !Number.isFinite(record.createdAt) || typeof record.systemPrompt !== "string"
              || !record.definition || typeof record.definition.name !== "string" || !record.usage) {
              throw new Error("Invalid subagent instance registry record.");
            }
            ids.add(record.id);
            record.sessionsRoot = sessionsRoot; // Paths are derived, never trusted from disk.
            if (record.status === "running" && !turns.has(turnPath(record.id))) {
              try {
                const abandoned = await acquireContinuationStoreLock(turnPath(record.id));
                await abandoned.release();
                record.status = "idle";
                record.lastStatus = "interrupted";
              } catch (error) {
                if (!String(error).includes("already owned by another live process")) throw error;
              }
            }
            if (record.status === "idle" && record.updatedAt + (options.idleTtlMs ?? DAY) < now()) {
              record.status = "expired";
              record.updatedAt = now();
              await retire(record);
            }
          }
          records = records.filter((record) => isLiveSubagentInstance(record) || record.updatedAt + DAY >= now());
          // Persist recovery even when the requested operation is refused.
          await writeJsonAtomic(file, records);
          const result = await operation(records);
          await writeJsonAtomic(file, records);
          return structuredClone(result);
        } finally { await lock.release(); }
      });
      const required = (records: SubagentInstance[], id: string): SubagentInstance => {
        const record = records.find((entry) => entry.id === id);
        if (!record || !isLiveSubagentInstance(record)) throw new Error(`Unknown, closed or expired subagent instance "${id}". Live ids: ${records.filter(isLiveSubagentInstance).map((entry) => entry.id).join(", ") || "none"}.`);
        return record;
      };
      const handle: InstanceRegistryHandle = {
        list: () => transaction(async (records) => records.sort((a, b) => Number(isLiveSubagentInstance(b)) - Number(isLiveSubagentInstance(a)))),
        get: (id) => transaction(async (records) => records.find((record) => record.id === id)),
        create: (spec) => transaction(async (records) => {
          const live = records.filter(isLiveSubagentInstance);
          const suffix = ` Live ids: ${live.map((record) => record.id).join(", ") || "none"}.`;
          if (live.length >= (options.maxPerConversation ?? 8)) throw new Error(`Subagent maxPerConversation limit reached.${suffix}`);
          let id = spec.id;
          if (id === undefined) {
            const prefix = spec.name.toLowerCase().replace(/[^a-z0-9-]/gu, "-").replace(/^-+/u, "").slice(0, 30) || "agent";
            let index = 1;
            while (records.some((record) => record.id === `${prefix}-${index}`)) index++;
            id = `${prefix}-${index}`;
          }
          if (!ID.test(id)) throw new Error("Instance id must be lowercase kebab-case, 1–40 characters.");
          const previous = records.find((record) => record.id === id);
          if (previous && previous.status !== "closed") throw new Error(`Duplicate subagent instance "${id}".${suffix}`);
          if (previous) {
            // A reused id has the same durable session key: require successful cleanup before creating it.
            await options.retireSession(previous.sessionId, sessionsRoot);
            records.splice(records.indexOf(previous), 1);
          }
          const record: SubagentInstance = { ...structuredClone(spec), id, conversationId, sessionId: subagentInstanceSessionId(conversationId, id), sessionsRoot,
            status: "idle", turns: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, createdAt: now(), updatedAt: now() };
          records.push(record);
          return record;
        }),
        begin: (id) => transaction(async (records) => {
          const record = required(records, id);
          if (record.status === "running") throw new Error(`Subagent instance "${id}" is busy.`);
          if (record.turns >= (options.maxTurns ?? 60)) throw new Error(`Subagent instance "${id}" reached maxTurns; close it and create another.`);
          const lock = await acquireContinuationStoreLock(turnPath(id));
          turns.set(turnPath(id), lock);
          record.status = "running";
          record.updatedAt = now();
          return record;
        }),
        finish: (id, outcome) => transaction(async (records) => {
          const record = required(records, id);
          const lock = turns.get(turnPath(id));
          if (record.status !== "running" || !lock) throw new Error(`Subagent instance "${id}" has no turn owned by this process.`);
          record.status = "idle";
          record.turns += outcome.status === "busy" ? 0 : 1;
          record.updatedAt = now();
          record.lastStatus = outcome.status;
          record.lastAnswerHead = (outcome.answerHead ?? "").slice(0, 300);
          for (const key of Object.keys(record.usage) as (keyof InstanceUsage)[]) {
            const amount = outcome.usage?.[key] ?? 0;
            if (Number.isFinite(amount) && amount >= 0) record.usage[key] += amount;
          }
          // Publish idle before dropping the live-turn lock.
          await writeJsonAtomic(file, records);
          await lock.release();
          turns.delete(turnPath(id));
          return record;
        }),
        close: (id) => transaction(async (records) => {
          const record = required(records, id);
          if (record.status === "running") throw new Error(`Subagent instance "${id}" is busy.`);
          record.status = "closed";
          record.updatedAt = now();
          await retire(record);
          return record;
        }),
      };
      await handle.list();
      return handle;
    },
  };
}
