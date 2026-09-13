import { isSubagentVerificationTarget, type SubagentVerificationTarget, type SubagentVerificationDeclaration, type SubagentVerificationObservation } from "./subagent-verification-observer.js";
import type { SubagentCommandReceipts } from "./subagent-command-receipts.js";
import { newSubagentRecoveryBinding, isSubagentRecoveryBinding, issueRecoveryAcknowledgement, checkRecoveryAcknowledgement, consumeRecoveryAcknowledgement, recoveryToken, type SubagentRecoveryBinding, type SubagentRecoveryAcknowledgement } from "./subagent-recovery-binding.js";
import type { SubagentRegistryPublication } from "./subagent-managed-turn.js";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { MonoAgentConfig } from "@mono-agent/config";
import { parseMonoRuntimeModelReference, type RuntimeModelReference } from "@mono-agent/runtime-adapter";

import { acquireContinuationStoreLock, ensureOwnerOnlyDirectory, readBoundedOwnerOnlyFile, writeJsonAtomic } from "./continuation-store-fs.js";

import { isSubagentUuid, isSubagentTurnIntent, isSubagentRecoveryFence, isSubagentOwnerLink, sameSubagentOwner, SubagentRecoveryError, type SubagentTurnIntent, type SubagentRecoveryFence, type SubagentOwnerLink, type SubagentOwnerIdentity, type SubagentOwnerResolution, type SubagentKnownOwner } from "./subagent-registry-ownership.js";

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
  incarnation?: string;
  activeTurn?: SubagentTurnIntent;
  recovery?: SubagentRecoveryFence;
  /** Derived public guidance, never accepted as stored ownership authority. */
  recoveryBlocked?: boolean;
  recoveryJobId?: string;
  reservation?: { token: string };
  status: "queued" | "idle" | "running" | "awaiting_reply" | "closed" | "expired";
  pendingQuestion?: SubagentQuestion;
  turns: number;
  usage: InstanceUsage;
  createdAt: number;
  updatedAt: number;
  lastStatus?: string;
  lastAnswerHead?: string;
}
interface StoredSubagentInstance extends SubagentInstance { verificationTarget?: SubagentVerificationTarget; recoveryBinding?: SubagentRecoveryBinding; ownerLink?: SubagentOwnerLink; ownerReceipt?: { jobId: string; storeRoot: string; turnToken: string; sequence: number; finalized: boolean; acknowledged: boolean } }

export interface SubagentRecoverySubject {
  readonly conversationId: string;
  readonly instanceId: string;
  readonly incarnation?: string;
  readonly owner?: SubagentOwnerIdentity;
  readonly verification?: SubagentVerificationTarget;
}
export interface SubagentRecoveryFacts {
  readonly status: SubagentVerificationObservation["status"];
  readonly commands?: SubagentCommandReceipts;
  readonly observation?: Omit<SubagentVerificationObservation, "schemaVersion" | "policyRevision">;
}
export interface SubagentRecoveryInspection {
  readonly schema: "mono-agent.subagent-recovery.v1";
  readonly instanceId: string;
  readonly incarnation?: string;
  readonly jobId?: string;
  readonly recovery?: SubagentRecoveryFence;
  readonly status: "not_required" | "held" | "ready" | "structured_job_recovery_unavailable" | "observation_policy_unavailable" | "observation_policy_denied" | "observation_unavailable" | "observation_inconsistent" | "observation_truncated";
  readonly facts?: SubagentRecoveryFacts;
  readonly parentVerificationRequired: true;
  readonly ack?: string;
}
export interface InstanceSpec { verification?: SubagentVerificationDeclaration; id?: string; name: string; systemPrompt: string; definition: InstanceDefinition }
export interface InstanceOutcome { status: string; closeAfterSuccess?: boolean; failureKind?: "session_continuity_lost"; usage?: Partial<InstanceUsage>; answerHead?: string; question?: SubagentQuestion }
export interface InstanceRegistryHandle {
  verifyOwner(identity: SubagentOwnerIdentity): Promise<{ retained: boolean; verification?: SubagentVerificationTarget }>;
  inspect(id: string, access?: unknown): Promise<SubagentRecoveryInspection>;
  checkAcknowledgement(id: string, acknowledgement: SubagentRecoveryAcknowledgement, access?: unknown): Promise<void>;
  publishOwned(phase: "intent" | "confirm" | "finalize" | "acknowledge", publication: SubagentRegistryPublication): Promise<void>;
  list(): Promise<SubagentInstance[]>;
  get(id: string): Promise<SubagentInstance | undefined>;
  create(spec: InstanceSpec, access?: unknown): Promise<SubagentInstance>;
  reserve(id: string, token: string, acknowledgement?: SubagentRecoveryAcknowledgement, access?: unknown): Promise<SubagentInstance>;
  releaseReservation(id: string, token: string): Promise<void>;
  begin(id: string, token?: string, acknowledgement?: SubagentRecoveryAcknowledgement, access?: unknown): Promise<SubagentInstance>;
  fence(id: string, outcome: { status: "timeout" | "cancelled" }, turnToken?: string): Promise<void>;
  markAwaiting(id: string, question: SubagentQuestion): Promise<SubagentInstance>;
  finish(id: string, outcome: InstanceOutcome, token?: string): Promise<SubagentInstance>;
  close(id: string, access?: unknown): Promise<SubagentInstance>;
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
function validRecord(value: unknown, conversationId: string, sessionsRoot: string): value is StoredSubagentInstance {
  if (!object(value) || !keys(value, ["id", "conversationId", "name", "systemPrompt", "definition", "sessionId", "sessionsRoot", "status", "turns", "usage", "createdAt", "updatedAt", "lastStatus", "lastAnswerHead", "pendingQuestion", "reservation", "incarnation", "activeTurn", "recovery", "ownerLink", "ownerReceipt", "recoveryBinding", "verificationTarget"])) return false;
  if (value.verificationTarget !== undefined && !isSubagentVerificationTarget(value.verificationTarget)) return false;
  if (value.recoveryBinding !== undefined && !isSubagentRecoveryBinding(value.recoveryBinding)) return false;
  if (value.ownerReceipt !== undefined && (!object(value.ownerReceipt) || !keys(value.ownerReceipt, ["jobId", "storeRoot", "turnToken", "sequence", "finalized", "acknowledged"])
    || !isSubagentOwnerLink({ jobId: value.ownerReceipt.jobId, storeRoot: value.ownerReceipt.storeRoot }) || typeof value.ownerReceipt.finalized !== "boolean" || typeof value.ownerReceipt.acknowledged !== "boolean"
    || (value.ownerReceipt.acknowledged && !value.ownerReceipt.finalized)
    || !isSubagentUuid(value.ownerReceipt.jobId) || !isSubagentUuid(value.ownerReceipt.turnToken)
    || !integer(value.ownerReceipt.sequence) || value.ownerReceipt.sequence < 1)) return false;
  if (value.incarnation !== undefined && !isSubagentUuid(value.incarnation)) return false;
  if (value.activeTurn !== undefined && (!isSubagentTurnIntent(value.activeTurn) || value.incarnation === undefined || !["running", "queued"].includes(String(value.status)))) return false;
  if (value.recovery !== undefined && (!isSubagentRecoveryFence(value.recovery) || value.incarnation === undefined)) return false;
  if (value.ownerLink !== undefined && (!isSubagentOwnerLink(value.ownerLink) || !isSubagentTurnIntent(value.activeTurn) || value.activeTurn.kind !== "detached")) return false;
  if (value.reservation !== undefined && (!object(value.reservation) || !keys(value.reservation, ["token"])
    || typeof value.reservation.token !== "string" || !/^[a-f0-9-]{36}$/u.test(value.reservation.token))) return false;
  if (value.status === "queued" && value.reservation === undefined) return false;
  if (isSubagentTurnIntent(value.activeTurn) && value.activeTurn.kind === "detached"
    && (!object(value.reservation) || value.reservation.token !== value.activeTurn.token)) return false;
  if (isSubagentOwnerLink(value.ownerLink) && isSubagentTurnIntent(value.activeTurn) && value.ownerLink.jobId !== value.activeTurn.token) return false;
  if (value.status === "queued" && isSubagentTurnIntent(value.activeTurn) && value.activeTurn.kind !== "detached") return false;
  const d = value.definition;
  const usage = value.usage;
  if (!text(value.id) || !ID.test(value.id) || value.conversationId !== conversationId
    || value.sessionId !== subagentInstanceSessionId(conversationId, value.id) || value.sessionsRoot !== sessionsRoot
    || typeof value.status !== "string" || !text(value.name) || !text(value.systemPrompt) || !["queued", "idle", "running", "awaiting_reply", "closed", "expired"].includes(String(value.status))
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
export const isLiveSubagentInstance = (record: SubagentInstance): boolean => record.status === "queued" || record.status === "idle" || record.status === "running" || record.status === "awaiting_reply";
export function subagentInstancesRoot(config: Pick<MonoAgentConfig, "subagents" | "artifacts">): string {
  return config.subagents?.instances?.root ?? resolve(config.artifacts.dir, "..", "subagents");
}

// Serialize callers in this process before taking the cross-process file lock.
const tails = new Map<string, Promise<void>>();
const turns = new Map<string, { release(): Promise<void>; token?: string }>();
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
  /** This capability only resolves already registered/owned roots; never open a root from a record. */
  resolveOwner?: (identity: SubagentOwnerIdentity) => Promise<SubagentOwnerResolution>;
  /** Conservative conversation-wide retained-root index, including after registry reset. */
  checkOwnerIndex?: (conversationId: string, known: readonly SubagentKnownOwner[]) => Promise<"clear" | "held" | "unavailable">;
  ownerForReservation?: (jobId: string) => SubagentOwnerLink;
  /** Current request capability only; never persisted or reconstructed from an old policy. */
  authorizeRecovery?: (subject: SubagentRecoverySubject, access: unknown) => Promise<boolean | "unavailable">;
  registerVerification?: (declaration: SubagentVerificationDeclaration, access: unknown) => Promise<SubagentVerificationTarget>;
  observeRecovery?: (subject: SubagentRecoverySubject, access: unknown) => Promise<SubagentRecoveryFacts>;
  refreshOwner?: (identity: SubagentOwnerIdentity) => Promise<void>;
  authorizeClosure?: (subject: SubagentRecoverySubject) => Promise<boolean>;
  retireSession: (sessionId: string, sessionsRoot: string) => Promise<unknown>;
}): { open(conversationId: string, access?: { existingOnly?: boolean }): Promise<InstanceRegistryHandle> } {
  const now = options.now ?? Date.now;
  return {
    async open(conversationId, access) {
      const directory = subagentConversationRoot(options.root, conversationId);
      const sessionsRoot = resolve(directory, "sessions");
      // Per-loaded-record observation only; never erase a durable certificate
      // because its service is unavailable or its safely retained job is gone.
      const awaitingReceiptAcknowledgement = new WeakSet<StoredSubagentInstance>();
      const receiptHeld = (record: StoredSubagentInstance): boolean => record.ownerReceipt !== undefined
        && (!record.ownerReceipt.acknowledged || awaitingReceiptAcknowledgement.has(record));
      const file = resolve(directory, "instances.json");
      const turnPath = (id: string): string => resolve(directory, "turn-locks", id);
      const acquirePrivateLock = async (path: string) => {
        try { return await acquireContinuationStoreLock(path); }
        catch {
          // Admission errors reach native tool results. Filesystem/lock errors
          // include the private registry path; never disclose it to the model.
          // Failure grants neither a reservation nor acknowledgement consumption.
          throw new SubagentRecoveryError("subagent_owner_unavailable");
        }
      };
      const privateRegistryIo = async <T>(operation: () => Promise<T>): Promise<T> => {
        try { return await operation(); }
        catch {
          // Owner-only directory, read and write failures can contain the
          // private registry pathname. Preserve the durable bytes and expose
          // only the typed unavailable result to native tool/model input.
          throw new SubagentRecoveryError("subagent_owner_unavailable");
        }
      };
      const readPrivateRegistry = async (): Promise<string | undefined> => {
        try { return await readBoundedOwnerOnlyFile(file, SUBAGENT_REGISTRY_MAX_BYTES, "Subagent instance registry"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw new SubagentRecoveryError("subagent_owner_unavailable");
        }
      };
      const retire = async (record: SubagentInstance): Promise<void> => {
        try { await options.retireSession(record.sessionId, sessionsRoot); } catch { /* Terminal record stays retired even if provider cleanup fails. */ }
      };
      const publish = async (records: StoredSubagentInstance[]): Promise<void> => {
        for (const record of records) if (!validRecord(record, conversationId, sessionsRoot)) throw new Error("Invalid subagent instance registry record.");
        const terminal = records.filter((record) => !isLiveSubagentInstance(record) && !record.activeTurn && !record.recovery && (!receiptHeld(record))).sort((a, b) => a.updatedAt - b.updatedAt);
        const bytes = (): number => Buffer.byteLength(`${JSON.stringify(records, null, 2)}\n`, "utf8");
        while (terminal.length > SUBAGENT_TERMINAL_MAX_COUNT || (terminal.length > 0 && bytes() > SUBAGENT_REGISTRY_MAX_BYTES)) {
          records.splice(records.indexOf(terminal.shift()!), 1);
        }
        if (bytes() > SUBAGENT_REGISTRY_MAX_BYTES) throw new Error("Subagent instance registry exceeds its 16 MiB safety limit.");
        await privateRegistryIo(async () => await (options.writeRegistry ?? writeJsonAtomic)(file, records, true, SUBAGENT_REGISTRY_MAX_BYTES));
      };
      const assertCanDrive = (record: StoredSubagentInstance): void => {
        if (record.activeTurn?.kind === "detached" && !turns.has(turnPath(record.id))) throw new SubagentRecoveryError("subagent_owner_unavailable");
        if (receiptHeld(record)) throw new SubagentRecoveryError("subagent_owner_unavailable");
        if (record.recovery) throw new SubagentRecoveryError("subagent_recovery_required");
      };
      const profileOf = (record: StoredSubagentInstance): unknown => [record.systemPrompt, record.definition];
      const subjectOf = (record: StoredSubagentInstance): SubagentRecoverySubject => {
        const receipt = record.ownerReceipt;
        const link = record.ownerLink ?? (!record.activeTurn && receipt && (!record.recovery || receipt.turnToken === record.recovery.turnToken) ? receipt : undefined);
        const turnToken = record.activeTurn?.token ?? receipt?.turnToken;
        return { conversationId, instanceId: record.id, ...(record.verificationTarget ? { verification: record.verificationTarget } : {}), ...(record.incarnation ? { incarnation: record.incarnation } : {}),
          ...(link && turnToken && record.incarnation ? { owner: { jobId: link.jobId, storeRoot: link.storeRoot,
            conversationId, instanceId: record.id, instanceIncarnation: record.incarnation, turnToken } } : {}) };
      };
      const authorizeRecovery = async (record: StoredSubagentInstance, access: unknown, includeOwner = true): Promise<void> => {
        if (!options.authorizeRecovery) throw new SubagentRecoveryError("subagent_recovery_policy_unavailable");
        const subject = subjectOf(record);
        const { owner: _owner, ...withoutOwner } = subject;
        const verdict = await options.authorizeRecovery(includeOwner ? subject : withoutOwner, access).catch(() => "unavailable" as const);
        if (verdict === "unavailable") throw new SubagentRecoveryError("subagent_recovery_policy_unavailable");
        if (!verdict) throw new SubagentRecoveryError("subagent_recovery_policy_denied");
      };
      const assertAcknowledgement = async (record: StoredSubagentInstance, acknowledgement: SubagentRecoveryAcknowledgement, access: unknown): Promise<void> => {
        await authorizeRecovery(record, access, false);
        checkRecoveryAcknowledgement(record.recoveryBinding, acknowledgement, profileOf(record));
        await authorizeRecovery(record, access);
        if (!record.incarnation || !record.recovery || recoveryToken(record.incarnation, record.recovery) !== acknowledgement.ack) throw new SubagentRecoveryError("subagent_recovery_ack_stale");
        if (record.activeTurn || (receiptHeld(record))) throw new SubagentRecoveryError("subagent_ownership_held");
        if (record.recovery.continuity !== "retained") throw new SubagentRecoveryError("subagent_recovery_not_retained");
        if (subjectOf(record).owner && acknowledgement.background !== true) throw new SubagentRecoveryError("subagent_recovery_background_required");
      };
      const reconcileOwner = async (record: StoredSubagentInstance): Promise<void> => {
        if (!record.ownerLink || !record.activeTurn || !record.incarnation || !options.resolveOwner) return;
        const identity: SubagentOwnerIdentity = { ...record.ownerLink, conversationId, instanceId: record.id,
          instanceIncarnation: record.incarnation, turnToken: record.activeTurn.token };
        const proof = await options.resolveOwner(identity).catch(() => ({ state: "unavailable" as const }));
        if ((proof.state !== "released" && proof.state !== "not_admitted") || !sameSubagentOwner(identity, proof.identity)
          || !Number.isSafeInteger(proof.sequence) || proof.sequence < 1) return;
        const fence: SubagentRecoveryFence = { turnToken: identity.turnToken, sequence: proof.sequence,
          reason: proof.reason ?? "settlement_unknown", continuity: proof.continuity };
        if (!isSubagentRecoveryFence(fence)) return;
        if (record.recovery && (record.recovery.turnToken !== fence.turnToken || record.recovery.sequence > fence.sequence
          || (record.recovery.sequence === fence.sequence && (record.recovery.reason !== fence.reason || record.recovery.continuity !== fence.continuity)))) return;
        record.recovery = fence;
        record.status = record.pendingQuestion ? "awaiting_reply" : "idle";
        record.lastStatus = "interrupted";
        delete record.activeTurn;
        delete record.ownerLink;
        delete record.reservation;
      };
      const transaction = async <T>(operation: (records: StoredSubagentInstance[]) => Promise<T>): Promise<T> => serialize(directory, async () => {
        await privateRegistryIo(async () => await ensureOwnerOnlyDirectory(directory));
        const lock = await acquirePrivateLock(resolve(directory, "registry-lock"));
        try {
          let records: StoredSubagentInstance[];
          const contents = await readPrivateRegistry();
          if (contents === undefined) {
            if (access?.existingOnly) throw new SubagentRecoveryError("subagent_owner_unavailable");
            records = [];
          } else {
            const raw: unknown = JSON.parse(contents);
            if (!Array.isArray(raw)) throw new Error("Invalid subagent instance registry.");
            records = raw as StoredSubagentInstance[];
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
            if (record.ownerReceipt && record.incarnation && options.resolveOwner) {
              const receipt = record.ownerReceipt;
              const identity: SubagentOwnerIdentity = { storeRoot: receipt.storeRoot, jobId: receipt.jobId, conversationId,
                instanceId: record.id, instanceIncarnation: record.incarnation, turnToken: receipt.turnToken };
              const proof = await options.resolveOwner(identity).catch(() => ({ state: "unavailable" as const }));
              if (proof.state === "held" || (proof.state === "released" && (proof.receiptPending || proof.sequence !== receipt.sequence || !sameSubagentOwner(identity, proof.identity)))) awaitingReceiptAcknowledgement.add(record);
              if (proof.state === "released" && !proof.receiptPending && proof.sequence === receipt.sequence && sameSubagentOwner(identity, proof.identity)) { receipt.finalized = true; receipt.acknowledged = true; }
            }
            if (["queued", "running"].includes(record.status) && !turns.has(turnPath(record.id))) {
              try {
                const abandoned = await acquireContinuationStoreLock(turnPath(record.id));
                await abandoned.release();
                if (record.activeTurn?.kind === "detached") {
                  // No OS turn lock is not proof of command cleanup or job publication.
                  await reconcileOwner(record);
                } else {
                  record.incarnation ??= randomUUID();
                  record.recovery = { turnToken: record.activeTurn?.token ?? randomUUID(), sequence: 1,
                    reason: "settlement_unknown", continuity: "unknown" };
                  record.status = record.pendingQuestion ? "awaiting_reply" : "idle";
                  record.lastStatus = "interrupted";
                  delete record.reservation;
                  delete record.activeTurn;
                }
              } catch (error) {
                if (!String(error).includes("already owned by another live process")) throw error;
              }
            }
            if ((!receiptHeld(record)) && !record.activeTurn && !record.recovery && ["idle", "awaiting_reply"].includes(record.status) && record.updatedAt + (options.idleTtlMs ?? DAY) < now()) {
              record.status = "expired";
              delete record.pendingQuestion;
              record.updatedAt = now();
              await retire(record);
            }
          }
          records = records.filter((record) => isLiveSubagentInstance(record) || record.activeTurn || record.recovery || (receiptHeld(record)) || record.updatedAt + DAY >= now());
          // Persist recovery even when the requested operation is refused.
          await publish(records);
          const result = await operation(records);
          await publish(records);
          // Explicit projection: private owner roots never enter runtime handles.
          const project = (value: unknown): unknown => {
            if (Array.isArray(value)) return value.map(project);
            if (value && typeof value === "object" && "sessionId" in value) {
              const { ownerLink: _owner, ownerReceipt: _receipt, recoveryBinding: _binding, verificationTarget: _verification, ...publicRecord } = value as StoredSubagentInstance;
              return structuredClone({ ...publicRecord,
                ...(publicRecord.recovery || (_receipt && !_receipt.acknowledged) ? { recoveryBlocked: true } : {}),
                ...(_receipt && publicRecord.recovery?.turnToken === _receipt.turnToken ? { recoveryJobId: _receipt.jobId } : {}) });
            }
            return structuredClone(value);
          };
          return project(result) as T;
        } finally { await lock.release(); }
      });
      const required = (records: StoredSubagentInstance[], id: string): StoredSubagentInstance => {
        const record = records.find((entry) => entry.id === id);
        if (!record || !isLiveSubagentInstance(record)) throw new Error(`Unknown, closed or expired subagent instance "${id}". Live ids: ${records.filter(isLiveSubagentInstance).map((entry) => entry.id).join(", ") || "none"}.`);
        return record;
      };
      const handle: InstanceRegistryHandle = {
        checkAcknowledgement: (id, acknowledgement, access) => transaction(async (records) => {
          const record = records.find((entry) => entry.id === id);
          if (!record) throw new SubagentRecoveryError("subagent_recovery_ack_stale");
          await authorizeRecovery(record, access, false);
          checkRecoveryAcknowledgement(record.recoveryBinding, acknowledgement, profileOf(record));
        }),
        inspect: (id, access) => transaction(async (records): Promise<SubagentRecoveryInspection> => {
          const record = required(records, id);
          const subject = subjectOf(record);
          const base = { schema: "mono-agent.subagent-recovery.v1" as const, instanceId: record.id,
            ...(record.incarnation ? { incarnation: record.incarnation } : {}), ...(subject.owner ? { jobId: subject.owner.jobId } : {}),
            ...(record.recovery ? { recovery: structuredClone(record.recovery) } : {}), parentVerificationRequired: true as const };
          if (record.activeTurn || (receiptHeld(record))) {
            if (subject.owner) await options.refreshOwner?.(subject.owner).catch(() => undefined);
            return { ...base, status: "held" };
          }
          try { await authorizeRecovery(record, access); } catch (error) {
            return { ...base, status: error instanceof SubagentRecoveryError && error.code === "subagent_recovery_policy_unavailable" ? "observation_policy_unavailable" : "observation_policy_denied" };
          }
          const facts = subject.owner && options.observeRecovery ? await options.observeRecovery(subject, access) : undefined;
          if (facts && facts.status !== "observed") return { ...base, facts, status: facts.status };
          if (facts && record.recovery) {
            if (record.recovery.sequence === Number.MAX_SAFE_INTEGER) throw new SubagentRecoveryError("subagent_recovery_ack_stale");
            record.recovery = { ...record.recovery, sequence: record.recovery.sequence + 1 }; base.recovery = structuredClone(record.recovery);
          }
          const ack = record.recovery?.continuity === "retained" && record.incarnation
            ? issueRecoveryAcknowledgement(record.recoveryBinding ??= newSubagentRecoveryBinding(), record.incarnation, record.recovery, profileOf(record)) : undefined;
          return { ...base, ...(facts ? { facts } : {}), status: !subject.owner ? "structured_job_recovery_unavailable" : record.recovery ? "ready" : "not_required", ...(ack ? { ack } : {}) };
        }),
        verifyOwner: (identity) => transaction(async (records) => {
          const record = records.find((entry) => entry.id === identity.instanceId);
          if (!record?.ownerLink || !record.activeTurn || !record.incarnation || !sameSubagentOwner(identity, {
            ...record.ownerLink, conversationId, instanceId: record.id, instanceIncarnation: record.incarnation, turnToken: record.activeTurn.token,
          })) throw new SubagentRecoveryError("subagent_stale_turn");
          return { retained: record.recoveryBinding?.consumed?.turnToken === record.activeTurn.token,
            ...(record.verificationTarget ? { verification: structuredClone(record.verificationTarget) } : {}) };
        }),
        publishOwned: async (phase, publication) => {
          let released: { release(): Promise<void> } | undefined;
          try { await transaction(async (records) => {
            const identity = publication.identity;
            const record = records.find((entry) => entry.id === identity.instanceId);
            if (phase === "acknowledge") {
              // The job durably copied this exact settled certificate before the
              // registry may discard it. A missing/replaced row needs no mutation:
              // this is positive job-held proof, never authority from absence.
              const proof = await options.resolveOwner?.(identity);
              if (proof?.state !== "released" || !proof.receiptRecorded || proof.sequence !== publication.sequence
                || !publication.released || !sameSubagentOwner(identity, proof.identity)) throw new SubagentRecoveryError("subagent_owner_unavailable");
              if (!record || record.incarnation !== identity.instanceIncarnation) return;
              const receipt = record.ownerReceipt;
              if (record.activeTurn || !receipt || receipt.jobId !== identity.jobId || receipt.storeRoot !== identity.storeRoot
                || receipt.turnToken !== identity.turnToken || receipt.sequence !== publication.sequence) return; // Never mutate a newer turn/receipt.
              if (!receipt.finalized) throw new SubagentRecoveryError("subagent_stale_turn");
              receipt.acknowledged = true;
              return;
            }
            if (!record || record.incarnation !== identity.instanceIncarnation || record.conversationId !== identity.conversationId) throw new SubagentRecoveryError("subagent_stale_turn");
            if (phase === "finalize") {
              const receipt = record.ownerReceipt;
              if (!publication.released || record.activeTurn || !receipt || receipt.jobId !== identity.jobId || receipt.storeRoot !== identity.storeRoot
                || receipt.turnToken !== identity.turnToken || receipt.sequence !== publication.sequence) throw new SubagentRecoveryError("subagent_stale_turn");
              const proof = await options.resolveOwner?.(identity);
              if (proof?.state !== "released" || proof.sequence !== receipt.sequence || !sameSubagentOwner(identity, proof.identity)) throw new SubagentRecoveryError("subagent_owner_unavailable");
              receipt.finalized = true;
              return;
            }
            if (record.ownerReceipt?.jobId === identity.jobId && record.ownerReceipt.storeRoot === identity.storeRoot && record.ownerReceipt.turnToken === identity.turnToken
              && record.ownerReceipt.sequence >= publication.sequence) return;
            if (!record.activeTurn || !record.ownerLink || !sameSubagentOwner(identity, { ...record.ownerLink,
              conversationId, instanceId: record.id, instanceIncarnation: record.incarnation, turnToken: record.activeTurn.token })) throw new SubagentRecoveryError("subagent_stale_turn");
            const disposition = publication.disposition;
            if (disposition.reason) record.recovery = { turnToken: identity.turnToken, sequence: publication.sequence,
              reason: disposition.reason, continuity: disposition.continuity };
            if (phase === "intent") return;
            record.ownerReceipt = { jobId: identity.jobId, storeRoot: identity.storeRoot, turnToken: identity.turnToken, sequence: publication.sequence, finalized: false, acknowledged: false };
            if (!publication.released) return;
            if (disposition.status === "ok" && disposition.closeAfterSuccess && record.verificationTarget
              && !await options.authorizeClosure?.(subjectOf(record)).catch(() => false)) throw new SubagentRecoveryError("subagent_recovery_policy_unavailable");
            const wasRunning = record.status === "running";
            const question = publication.outcome?.question;
            if (disposition.status === "awaiting_reply" && question) {
              if (!validQuestion(question)) throw new Error("Invalid subagent question.");
              record.pendingQuestion = structuredClone(question);
            } else if (disposition.status === "ok") delete record.pendingQuestion;
            record.status = record.pendingQuestion ? "awaiting_reply" : "idle";
            record.turns += wasRunning && disposition.status !== "busy" ? 1 : 0;
            record.updatedAt = now();
            record.lastStatus = disposition.status;
            for (const key of Object.keys(record.usage) as (keyof InstanceUsage)[]) {
              const amount = publication.outcome?.usage?.[key] ?? 0;
              if (Number.isFinite(amount) && amount >= 0) record.usage[key] += amount;
            }
            released = turns.get(turnPath(record.id));
            delete record.activeTurn; delete record.ownerLink; delete record.reservation;
            if (disposition.status === "ok" && disposition.closeAfterSuccess && !record.recovery) {
              record.status = "closed"; delete record.pendingQuestion; await retire(record);
            }
          }); } finally {
            if (released && turns.get(turnPath(publication.identity.instanceId)) === released) {
              await released.release(); turns.delete(turnPath(publication.identity.instanceId));
            }
          }
        },
        list: () => transaction(async (records) => records.sort((a, b) => Number(isLiveSubagentInstance(b)) - Number(isLiveSubagentInstance(a)))),
        get: (id) => transaction(async (records) => records.find((record) => record.id === id)),
        create: (spec, access) => transaction(async (records) => {
          const { verification, ...retainedSpec } = spec;
          if (verification && !options.registerVerification) throw new SubagentRecoveryError("subagent_recovery_policy_unavailable");
          const verificationTarget = verification ? await options.registerVerification!(verification, access) : undefined;
          const index = await options.checkOwnerIndex?.(conversationId, records.map((record) => ({ instanceId: record.id, ...(record.incarnation === undefined ? {} : { incarnation: record.incarnation }), ...(record.reservation === undefined ? {} : { jobId: record.reservation.token }) }))).catch(() => "unavailable" as const);
          if (index && index !== "clear") throw new SubagentRecoveryError(index === "held" ? "subagent_ownership_held" : "subagent_owner_unavailable");
          if (records.some((record) => (receiptHeld(record)) || (record.activeTurn?.kind === "detached" && !turns.has(turnPath(record.id))))) throw new SubagentRecoveryError("subagent_owner_unavailable");
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
            if (receiptHeld(previous)) throw new SubagentRecoveryError("subagent_owner_unavailable");
            // A reused id has the same durable session key: require successful cleanup before creating it.
            await options.retireSession(previous.sessionId, sessionsRoot);
            records.splice(records.indexOf(previous), 1);
          }
          // Retention may have removed an earlier record with this deterministic session id.
          if (!previous) await options.retireSession(subagentInstanceSessionId(conversationId, id), sessionsRoot);
          const record: StoredSubagentInstance = { ...structuredClone(retainedSpec), ...(verificationTarget ? { verificationTarget } : {}), id, incarnation: randomUUID(), recoveryBinding: newSubagentRecoveryBinding(), conversationId, sessionId: subagentInstanceSessionId(conversationId, id), sessionsRoot,
            status: "idle", turns: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }, createdAt: now(), updatedAt: now() };
          records.push(record);
          return record;
        }),
        reserve: async (id, token, acknowledgement, access) => {
          let acquired: { release(): Promise<void> } | undefined;
          try { return await transaction(async (records) => {
            const record = required(records, id);
            if (acknowledgement) await assertAcknowledgement(record, acknowledgement, access);
            else assertCanDrive(record);
            if (["queued", "running"].includes(record.status)) throw new Error(`Subagent instance "${id}" is busy.`);
            if (record.turns >= (options.maxTurns ?? 60)) throw new Error(`Subagent instance "${id}" reached maxTurns.`);
            acquired = await acquirePrivateLock(turnPath(id));
            turns.set(turnPath(id), { release: () => acquired!.release(), token });
            if (acknowledgement) {
              consumeRecoveryAcknowledgement(record.recoveryBinding!, acknowledgement, profileOf(record), token);
              delete record.recovery;
            }
            record.status = "queued";
            record.reservation = { token };
            record.incarnation ??= randomUUID();
            record.activeTurn = { token, kind: "detached", settlementPending: true };
            if (options.ownerForReservation) record.ownerLink = options.ownerForReservation(token);
            record.updatedAt = now();
            return record;
          }); } catch (error) {
            if (acquired) { await acquired.release(); turns.delete(turnPath(id)); }
            throw error;
          }
        },
        releaseReservation: async (id, token) => {
          let released: { release(): Promise<void> } | undefined;
          try { await transaction(async (records) => {
            const record = records.find((entry) => entry.id === id);
            if (record?.status !== "queued" || record.reservation?.token !== token) return;
            // A linked admission can only be released by exact owner proof, not a failed caller.
            if (record.ownerLink) {
              await reconcileOwner(record);
              if (record.activeTurn) throw new SubagentRecoveryError("subagent_owner_unavailable");
            }
            released = turns.get(turnPath(id));
            delete record.activeTurn;
            record.status = record.pendingQuestion ? "awaiting_reply" : "idle";
            delete record.reservation;
          }); } finally {
            if (released && turns.get(turnPath(id)) === released) {
              try { await released.release(); } finally { turns.delete(turnPath(id)); }
            }
          }
        },
        begin: async (id, token, acknowledgement, access) => {
          let acquired: { release(): Promise<void> } | undefined;
          try { return await transaction(async (records) => {
          const record = required(records, id);
          if (token !== undefined && (record.status !== "queued" || record.reservation?.token !== token)) throw new SubagentRecoveryError("subagent_stale_turn");
          if (acknowledgement) await assertAcknowledgement(record, acknowledgement, access);
          else if (record.status !== "queued" || record.reservation?.token !== token) assertCanDrive(record);
          if (record.status === "running" || (record.status === "queued" && record.reservation?.token !== token)) throw new Error(`Subagent instance "${id}" is busy.`);
          if (record.turns >= (options.maxTurns ?? 60)) throw new Error(`Subagent instance "${id}" reached maxTurns; close it and create another.`);
          const lock = record.status === "queued" ? turns.get(turnPath(id)) : await acquirePrivateLock(turnPath(id));
          if (!lock) throw new Error("Subagent reservation ownership was lost.");
          acquired = lock;
          turns.set(turnPath(id), lock);
          record.incarnation ??= randomUUID();
          record.activeTurn ??= { token: randomUUID(), kind: "foreground", settlementPending: true };
          if (acknowledgement) {
            consumeRecoveryAcknowledgement(record.recoveryBinding!, acknowledgement, profileOf(record), record.activeTurn.token);
            delete record.recovery;
          }
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
        finish: async (id, outcome, token) => {
          const candidate = turns.get(turnPath(id));
          const owned = candidate?.token === token ? candidate : undefined;
          try { return await transaction(async (records) => {
          const record = required(records, id);
          const lock = turns.get(turnPath(id));
          if (record.reservation?.token !== token) throw new Error("Subagent turn ownership changed.");
          if (record.status !== "running" || !lock) throw new Error(`Subagent instance "${id}" has no turn owned by this process.`);
          if (record.ownerLink) throw new SubagentRecoveryError("subagent_ownership_held");
          if (!["ok", "awaiting_reply", "busy"].includes(outcome.status)) {
            record.recovery = { turnToken: record.activeTurn!.token, sequence: 1,
              reason: outcome.failureKind ?? (["timeout", "cancelled", "empty", "interrupted"].includes(outcome.status) ? outcome.status as "timeout" | "cancelled" | "empty" | "interrupted" : "failed"),
              continuity: outcome.failureKind === "session_continuity_lost" ? "lost" : "unknown" };
          }
          delete record.activeTurn;
          if (outcome.status === "awaiting_reply") {
            if (!validQuestion(outcome.question)) throw new Error("Invalid subagent question.");
            record.pendingQuestion = structuredClone(outcome.question);
          } else if (outcome.status === "ok") delete record.pendingQuestion;
          record.status = record.pendingQuestion ? "awaiting_reply" : "idle";
          delete record.reservation;
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
        fence: (id, outcome, turnToken) => transaction(async (records) => {
          const record = required(records, id);
          if (!record.activeTurn && record.recovery?.turnToken === turnToken) return;
          if (!record.activeTurn || !turns.has(turnPath(id)) || record.ownerLink || (turnToken && record.activeTurn.token !== turnToken)) throw new SubagentRecoveryError("subagent_stale_turn");
          record.recovery = { turnToken: record.activeTurn.token, sequence: record.recovery?.sequence ?? 1, reason: outcome.status, continuity: "unknown" };
          // Keep the active intent/lock: reporting a timeout is not provider settlement.
        }),
        close: (id, access) => transaction(async (records) => {
          const record = required(records, id);
          if (record.verificationTarget) await authorizeRecovery(record, access);
          if (record.activeTurn?.kind === "detached" && !turns.has(turnPath(id))) throw new SubagentRecoveryError("subagent_owner_unavailable");
          if (["queued", "running"].includes(record.status)) throw new Error(`Subagent instance "${id}" is busy.`);
          if (receiptHeld(record)) throw new SubagentRecoveryError("subagent_owner_unavailable");
          record.status = "closed";
          delete record.pendingQuestion;
          delete record.recovery;
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
