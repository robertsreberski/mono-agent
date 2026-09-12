import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { MonoAgentConfig } from "@mono-agent/config";
import { parseMonoRuntimeModelReference, type RuntimeModelReference } from "@mono-agent/runtime-adapter";

import { acquireContinuationStoreLock, ensureOwnerOnlyDirectory, readBoundedOwnerOnlyFile, writeJsonAtomic } from "./continuation-store-fs.js";

export interface InstanceDefinition {
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly model?: RuntimeModelReference;
  readonly effort?: string;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpServerNames?: readonly string[];
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
}
export interface SubagentQuestion { question: string; options?: string[] }
export interface InstanceUsage { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }
export interface SubagentInstance {
  id: string;
  conversationId: string;
  name: string;
  systemPrompt: string;
  definition: InstanceDefinition;
  sessionId: string;
  sessionsRoot: string;
  status: "idle" | "running" | "awaiting_reply" | "closed" | "expired";
  pendingQuestion?: SubagentQuestion;
  turns: number;
  usage: InstanceUsage;
  createdAt: number;
  updatedAt: number;
  lastStatus?: string;
  lastAnswerHead?: string;
}
export interface InstanceSpec { id?: string; name: string; systemPrompt: string; definition: InstanceDefinition }
export interface InstanceOutcome { status: string; usage?: Partial<InstanceUsage>; answerHead?: string; question?: SubagentQuestion }
export interface InstanceRegistryHandle {
  list(): Promise<SubagentInstance[]>;
  get(id: string): Promise<SubagentInstance | undefined>;
  create(spec: InstanceSpec): Promise<SubagentInstance>;
  begin(id: string): Promise<SubagentInstance>;
  markAwaiting(id: string, question: SubagentQuestion): Promise<SubagentInstance>;
  finish(id: string, outcome: InstanceOutcome): Promise<SubagentInstance>;
  close(id: string): Promise<SubagentInstance>;
}

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const DAY = 86_400_000;
export const SUBAGENT_REGISTRY_MAX_BYTES = 16 * 1024 * 1024;
export const SUBAGENT_TERMINAL_MAX_COUNT = 64;
const OUTCOMES = ["ok", "failed", "empty", "timeout", "cancelled", "busy", "interrupted", "awaiting_reply"];
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const strings = (value: unknown): boolean => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function validQuestion(value: unknown): value is SubagentQuestion {
  return object(value) && keys(value, ["question", "options"])
    && text(value.question) && value.question === value.question.trim() && value.question.length <= 2000
    && (value.options === undefined || (Array.isArray(value.options) && value.options.length >= 2 && value.options.length <= 5
      && value.options.every((option) => text(option) && option === option.trim() && option.length <= 200)
      && new Set(value.options).size === value.options.length));
}
function validRecord(value: unknown, conversationId: string, sessionsRoot: string): value is SubagentInstance {
  if (!object(value) || !keys(value, ["id", "conversationId", "name", "systemPrompt", "definition", "sessionId", "sessionsRoot", "status", "turns", "usage", "createdAt", "updatedAt", "lastStatus", "lastAnswerHead", "pendingQuestion"])) return false;
  const d = value.definition;
  const usage = value.usage;
  if (!text(value.id) || !ID.test(value.id) || value.conversationId !== conversationId
    || value.sessionId !== subagentInstanceSessionId(conversationId, value.id) || value.sessionsRoot !== sessionsRoot
    || typeof value.status !== "string" || !text(value.name) || !text(value.systemPrompt) || !["idle", "running", "awaiting_reply", "closed", "expired"].includes(String(value.status))
    || (value.pendingQuestion !== undefined && !validQuestion(value.pendingQuestion))
    || (value.status === "awaiting_reply" && value.pendingQuestion === undefined)
    || !integer(value.turns) || !integer(value.createdAt) || !integer(value.updatedAt) || value.updatedAt < value.createdAt
    || (value.lastStatus !== undefined && (typeof value.lastStatus !== "string" || !OUTCOMES.includes(value.lastStatus)))
    || (value.lastAnswerHead !== undefined && (typeof value.lastAnswerHead !== "string" || value.lastAnswerHead.length > 300))
    || !object(usage) || !keys(usage, ["input", "output", "cacheRead", "cacheWrite", "costUsd"])
    || !["input", "output", "cacheRead", "cacheWrite"].every((key) => integer(usage[key]))
    || typeof usage.costUsd !== "number" || !Number.isFinite(usage.costUsd) || usage.costUsd < 0
    || !object(d) || !keys(d, ["name", "description", "systemPrompt", "model", "effort", "allowedTools", "disallowedTools", "mcpServerNames", "maxTurns", "timeoutMs"])
    || d.name !== value.name || d.systemPrompt !== value.systemPrompt || !text(d.description)) return false;
  if (d.model !== undefined && (!object(d.model) || !keys(d.model, ["provider", "model", "reference"])
    || !text(d.model.provider) || !text(d.model.model) || !text(d.model.reference)
    )) return false;
  if (object(d.model)) {
    try {
      const parsed = parseMonoRuntimeModelReference(String(d.model.reference));
      if (parsed.provider !== d.model.provider || parsed.model !== d.model.model) return false;
    } catch { return false; }
  }
  if (d.effort !== undefined && (typeof d.effort !== "string" || !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(d.effort))) return false;
  for (const key of ["allowedTools", "disallowedTools", "mcpServerNames"]) if (d[key] !== undefined && !strings(d[key])) return false;
  for (const key of ["allowedTools", "disallowedTools", "mcpServerNames"]) {
    if (Array.isArray(d[key]) && d[key].some((item: string) => !/^[A-Za-z0-9_.*-]+$/u.test(item))) return false;
  }
  if (Array.isArray(d.allowedTools) && d.allowedTools.some((tool) => ["*", "Agent", "AgentSend", "AskUser", "SlackSendMessage", "TelegramSendMessage", "TelegramSendFile"].includes(tool))) return false;
  for (const key of ["maxTurns", "timeoutMs"]) if (d[key] !== undefined && (!integer(d[key]) || d[key] === 0)) return false;
  return true;
}

/** The persistent capability requires both halves of its effective built-in policy. */
export function persistentSubagentsEnabled(config: Pick<MonoAgentConfig, "subagents" | "tools">): boolean {
  return config.subagents?.enabled === true && config.subagents.instances?.enabled !== false
    && ["Agent", "AgentSend"].every((name) => (config.tools.allowedTools.includes("*") || config.tools.allowedTools.includes(name))
      && !config.tools.disallowedTools.includes(name));
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const subagentConversationRoot = (root: string, conversationId: string): string => resolve(root, hash(conversationId));
export const subagentInstanceSessionId = (conversationId: string, id: string): string => `sub-${hash(`${conversationId}\0${id}`).slice(0, 40)}`;
export const isLiveSubagentInstance = (record: SubagentInstance): boolean => record.status === "idle" || record.status === "running" || record.status === "awaiting_reply";
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
  writeRegistry?: typeof writeJsonAtomic;
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
      const publish = async (records: SubagentInstance[]): Promise<void> => {
        for (const record of records) if (!validRecord(record, conversationId, sessionsRoot)) throw new Error("Invalid subagent instance registry record.");
        const terminal = records.filter((record) => !isLiveSubagentInstance(record)).sort((a, b) => a.updatedAt - b.updatedAt);
        const bytes = (): number => Buffer.byteLength(`${JSON.stringify(records, null, 2)}\n`, "utf8");
        while (terminal.length > SUBAGENT_TERMINAL_MAX_COUNT || (terminal.length > 0 && bytes() > SUBAGENT_REGISTRY_MAX_BYTES)) {
          records.splice(records.indexOf(terminal.shift()!), 1);
        }
        if (bytes() > SUBAGENT_REGISTRY_MAX_BYTES) throw new Error("Subagent instance registry exceeds its 16 MiB safety limit.");
        await (options.writeRegistry ?? writeJsonAtomic)(file, records, true, SUBAGENT_REGISTRY_MAX_BYTES);
      };
      const transaction = async <T>(operation: (records: SubagentInstance[]) => Promise<T>): Promise<T> => serialize(directory, async () => {
        await ensureOwnerOnlyDirectory(directory);
        const lock = await acquireContinuationStoreLock(resolve(directory, "registry-lock"));
        try {
          let records: SubagentInstance[];
          try {
            const raw: unknown = JSON.parse(await readBoundedOwnerOnlyFile(file, SUBAGENT_REGISTRY_MAX_BYTES, "Subagent instance registry"));
            if (!Array.isArray(raw)) throw new Error("Invalid subagent instance registry.");
            records = raw as SubagentInstance[];
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            records = [];
          }
          const ids = new Set<string>();
          for (const record of records) {
            if (!validRecord(record, conversationId, sessionsRoot) || ids.has(record.id)) {
              throw new Error("Invalid subagent instance registry record.");
            }
            ids.add(record.id);
          }
          // Validate the complete snapshot before recovery can retire any session.
          for (const record of records) {
            if (record.status === "running" && !turns.has(turnPath(record.id))) {
              try {
                const abandoned = await acquireContinuationStoreLock(turnPath(record.id));
                await abandoned.release();
                record.status = record.pendingQuestion ? "awaiting_reply" : "idle";
                record.lastStatus = "interrupted";
              } catch (error) {
                if (!String(error).includes("already owned by another live process")) throw error;
              }
            }
            if (["idle", "awaiting_reply"].includes(record.status) && record.updatedAt + (options.idleTtlMs ?? DAY) < now()) {
              record.status = "expired";
              delete record.pendingQuestion;
              record.updatedAt = now();
              await retire(record);
            }
          }
          records = records.filter((record) => isLiveSubagentInstance(record) || record.updatedAt + DAY >= now());
          // Persist recovery even when the requested operation is refused.
          await publish(records);
          const result = await operation(records);
          await publish(records);
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
          // Retention may have removed an earlier record with this deterministic session id.
          if (!previous) await options.retireSession(subagentInstanceSessionId(conversationId, id), sessionsRoot);
          const record: SubagentInstance = { ...structuredClone(spec), id, conversationId, sessionId: subagentInstanceSessionId(conversationId, id), sessionsRoot,
            status: "idle", turns: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, createdAt: now(), updatedAt: now() };
          records.push(record);
          return record;
        }),
        begin: async (id) => {
          let acquired: { release(): Promise<void> } | undefined;
          try { return await transaction(async (records) => {
          const record = required(records, id);
          if (record.status === "running") throw new Error(`Subagent instance "${id}" is busy.`);
          if (record.turns >= (options.maxTurns ?? 60)) throw new Error(`Subagent instance "${id}" reached maxTurns; close it and create another.`);
          const lock = await acquireContinuationStoreLock(turnPath(id));
          acquired = lock;
          turns.set(turnPath(id), lock);
          record.status = "running";
          record.updatedAt = now();
          return record;
          }); } catch (error) {
            if (acquired) { await acquired.release(); turns.delete(turnPath(id)); }
            throw error;
          }
        },
        markAwaiting: (id, question) => transaction(async (records) => {
          const record = required(records, id);
          if (record.status !== "running" || !turns.has(turnPath(id))) throw new Error(`Subagent instance "${id}" has no turn owned by this process.`);
          if (!validQuestion(question)) throw new Error("Invalid subagent question.");
          record.pendingQuestion = structuredClone(question);
          record.updatedAt = now();
          return record;
        }),
        finish: async (id, outcome) => {
          const owned = turns.get(turnPath(id));
          try { return await transaction(async (records) => {
          const record = required(records, id);
          const lock = turns.get(turnPath(id));
          if (record.status !== "running" || !lock) throw new Error(`Subagent instance "${id}" has no turn owned by this process.`);
          if (outcome.status === "awaiting_reply") {
            if (!validQuestion(outcome.question)) throw new Error("Invalid subagent question.");
            record.pendingQuestion = structuredClone(outcome.question);
          } else if (outcome.status === "ok") delete record.pendingQuestion;
          record.status = record.pendingQuestion ? "awaiting_reply" : "idle";
          record.turns += outcome.status === "busy" ? 0 : 1;
          record.updatedAt = now();
          record.lastStatus = outcome.status;
          record.lastAnswerHead = (outcome.answerHead ?? "").slice(0, 300);
          for (const key of Object.keys(record.usage) as (keyof InstanceUsage)[]) {
            const amount = outcome.usage?.[key] ?? 0;
            if (Number.isFinite(amount) && amount >= 0) record.usage[key] += amount;
          }
          return record;
          }); } finally {
            // A failed read, recovery write, or final publication must not strand
            // our process lock. A durable running record is then recoverable.
            if (owned && turns.get(turnPath(id)) === owned) {
              try { await owned.release(); } finally { turns.delete(turnPath(id)); }
            }
          }
        },
        close: (id) => transaction(async (records) => {
          const record = required(records, id);
          if (record.status === "running") throw new Error(`Subagent instance "${id}" is busy.`);
          record.status = "closed";
          delete record.pendingQuestion;
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
