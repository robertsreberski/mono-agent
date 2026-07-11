import { createHash } from "node:crypto";

import type { MemoryRecord } from "../store/index.js";
import { parseJsonLoose } from "./json.js";
import { MemoryModelError } from "./model-error.js";
import {
  appendCanonicalFile,
  listCanonicalFileNames,
  readCanonicalFileSnapshot,
  writeCanonicalFileAtomic,
} from "./path-safety.js";
import type { ReflectDeps } from "./reflect.js";
import { readBullet, rewriteBullet } from "./daily.js";

export interface MigrateDeps extends ReflectDeps {
  /** Fault-injection seams used to prove the durable decision boundary. */
  readonly hooks?: {
    readonly afterDecisionDurable?: (decisionId: string) => void;
    readonly afterActionCommitted?: (decisionId: string) => void;
  };
}

export interface MigrateResult {
  readonly promoted: number;
  readonly rescheduled: number;
  readonly clustered: number;
  readonly forgotten: number;
  readonly reviewed: number;
}

type MigrateAction = "promote" | "reschedule" | "cluster" | "forget";

interface LlmDecision {
  readonly action: MigrateAction;
  readonly dueAt?: string;
  readonly collection?: string;
}

interface DurableMigrateDecision {
  readonly schemaVersion: 1;
  readonly decisionId: string;
  readonly action: MigrateAction;
  readonly id: string;
  readonly text: string;
  readonly at: string;
  readonly before: MemoryRecord;
  readonly updated: MemoryRecord;
  readonly vector?: readonly number[];
  readonly collection?: string;
}

const MIGRATE_MARKER = "mono-agent-migrate:";
const MAX_MONTHLY_AUDIT_BYTES = 8 * 1024 * 1024;

const VALID_ACTIONS = new Set<string>(["promote", "reschedule", "cluster", "forget"]);

function buildMigratePrompt(id: string, text: string): string {
  return `You are a BuJo (Bullet Journal) migration assistant. This memory has been open for over 30 days with low salience.

MEMORY:
id=${id}
text="${text}"

Decide what to do with it. Return ONLY a JSON object (no prose, no code fences):
{"action":"promote|reschedule|cluster|forget","dueAt":"<ISO 8601, only for reschedule>","collection":"<slug, only for cluster>"}

- promote: worth keeping + elevating salience
- reschedule: has a future due date, schedule it
- cluster: belongs to a named collection/theme (provide slug)
- forget: no longer relevant, drop it`;
}

/** Monthly BuJo migration ritual: review aging open memories and apply LLM decisions. */
export async function migrate(deps: MigrateDeps): Promise<MigrateResult> {
  deps.abortSignal?.throwIfAborted();
  const now = deps.now();
  let promoted = 0;
  let rescheduled = 0;
  let clustered = 0;
  let forgotten = 0;

  // At most one hidden pending decision may exist. Recover it before asking the
  // model for more work, then remove only the hidden marker while retaining its
  // human-readable monthly audit line.
  const pending = readPendingDecision(deps.root);
  let recovered = 0;
  if (pending !== undefined) {
    deps.abortSignal?.throwIfAborted();
    applyDurableDecision(deps, pending.file, pending.decision);
    increment(pending.decision.action);
    recovered = 1;
  }

  const aging = deps.db.agingOpen(now, { olderThanDays: 30, maxSalience: 0.4, limit: 50 });

  for (const item of aging) {
    let decision: DurableMigrateDecision | undefined;
    try {
      const prompt = buildMigratePrompt(item.id, item.text);
      let raw: string;
      try {
        raw = await deps.llm.complete(prompt, {
          label: "migrate",
          ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
        });
      } catch (cause) {
        deps.abortSignal?.throwIfAborted();
        // A model outage fails every item, so tag it and let the catch below surface it rather than
        // swallowing it as a per-item skip (which would make a dead model look like an empty migration).
        throw new MemoryModelError("llm", "migrate", cause);
      }
      deps.abortSignal?.throwIfAborted();
      const parsed = parseJsonLoose<LlmDecision>(raw);

      // Validate: must be a non-null object with a recognized action
      if (
        parsed === undefined ||
        parsed === null ||
        typeof parsed !== "object" ||
        !VALID_ACTIONS.has(parsed.action)
      ) {
        continue;
      }

      const action = parsed.action;
      const collection = action === "cluster" && typeof parsed.collection === "string"
        ? parsed.collection.trim()
        : undefined;
      if (action === "cluster" && (collection === undefined || collection.length === 0)) continue;
      const updated = updatedRecord(item, action, now, parsed.dueAt, collection);
      const [vector] = await deps.db.prepareUpsertVectors([updated]);
      deps.abortSignal?.throwIfAborted();
      assertCanonicalDecisionState(deps.root, item);
      decision = durableDecision(item, updated, action, now, vector, collection);
    } catch (err) {
      deps.abortSignal?.throwIfAborted();
      // A model outage is systemic — surface it (the ritual scheduler logs it).
      if (err instanceof MemoryModelError) throw err;
      // Per-item isolation: a genuine per-item data error (e.g. a missing daily file) is skipped so
      // it doesn't abort the rest of the batch.
      continue;
    }

    // Publication is the commitment boundary. Any later failure must stop the
    // ritual with this one marker intact so retry reuses the exact paid
    // decision instead of accumulating more hidden vectors or model calls.
    const monthlyFile = monthlyFileFor(now);
    appendPendingDecision(deps.root, monthlyFile, decision);
    deps.hooks?.afterDecisionDurable?.(decision.decisionId);
    applyDurableDecision(deps, monthlyFile, decision);
    increment(decision.action);
  }

  return {
    promoted,
    rescheduled,
    clustered,
    forgotten,
    reviewed: aging.length + recovered,
  };

  function increment(action: MigrateAction): void {
    if (action === "promote") promoted += 1;
    else if (action === "reschedule") rescheduled += 1;
    else if (action === "cluster") clustered += 1;
    else forgotten += 1;
  }
}

function updatedRecord(
  item: MemoryRecord,
  action: MigrateAction,
  now: Date,
  rawDueAt: unknown,
  collection: string | undefined,
): MemoryRecord {
  if (action === "promote") return { ...item, salience: Math.max(0.5, Math.min(1, item.salience + 0.3)) };
  if (action === "reschedule") {
    const dueAt = typeof rawDueAt === "string" ? rawDueAt : undefined;
    return {
      ...item,
      status: "scheduled",
      ...(dueAt === undefined ? {} : { dueAt }),
    };
  }
  if (action === "cluster") return { ...item, status: "migrated", collection: collection! };
  return { ...item, status: "dropped", validTo: now.toISOString() };
}

function durableDecision(
  before: MemoryRecord,
  updated: MemoryRecord,
  action: MigrateAction,
  now: Date,
  vector: readonly number[] | undefined,
  collection: string | undefined,
): DurableMigrateDecision {
  if (vector === undefined) throw new Error("memory-migrate: migration requires a prepared embedding vector.");
  const at = now.toISOString();
  const payload: Omit<DurableMigrateDecision, "decisionId"> = {
    schemaVersion: 1,
    action,
    id: before.id,
    text: before.text,
    at,
    before,
    updated,
    ...(vector === undefined ? {} : { vector }),
    ...(collection === undefined ? {} : { collection }),
  };
  return { ...payload, decisionId: decisionHash(payload) };
}

function monthlyFileFor(now: Date): string {
  return `monthly/${now.toISOString().slice(0, 7)}.md`;
}

function appendPendingDecision(root: string, file: string, decision: DurableMigrateDecision): void {
  const date = decision.at.slice(0, 10);
  const addition = `\n## ${date}\n- ${decision.action} ${decision.id}: ${JSON.stringify(decision.text)}\n`
    + `${pendingMarker(decision)}\n`;
  const current = readCanonicalFileSnapshot(root, file, {
    allowMissing: true,
    maxBytes: MAX_MONTHLY_AUDIT_BYTES,
  });
  if ((current?.identity.size ?? 0) + Buffer.byteLength(addition, "utf8") > MAX_MONTHLY_AUDIT_BYTES) {
    throw new Error(`memory-migrate: monthly audit "${file}" exceeds its ${MAX_MONTHLY_AUDIT_BYTES}-byte bound.`);
  }
  appendCanonicalFile(
    root,
    file,
    addition,
  );
}

function pendingMarker(decision: DurableMigrateDecision): string {
  const encoded = Buffer.from(JSON.stringify(decision), "utf8").toString("base64url");
  return `<!-- ${MIGRATE_MARKER}${encoded} -->`;
}

function applyDurableDecision(
  deps: MigrateDeps,
  file: string,
  decision: DurableMigrateDecision,
): void {
  const current = deps.db.get(decision.id);
  const dbBefore = current !== undefined && sameDecisionState(current, decision.before);
  const dbAfter = current !== undefined && sameDecisionState(current, decision.updated);
  const canonicalBefore = canonicalDecisionStateMatches(deps.root, decision.before);
  const canonicalAfter = canonicalDecisionStateMatches(deps.root, decision.updated);
  if ((!dbBefore && !dbAfter) || (!canonicalBefore && !canonicalAfter)) {
    throw new Error(`memory-migrate: durable decision ${decision.decisionId} no longer matches memory ${decision.id}.`);
  }
  const sourceFile = decision.updated.source.file;
  if (!canonicalAfter && sourceFile !== undefined) {
    const patch = canonicalPatch(decision);
    if (patch !== undefined && !rewriteBullet(deps.root, sourceFile, decision.id, patch)) {
      throw new Error(`memory-migrate: canonical source "${sourceFile}" does not contain "${decision.id}".`);
    }
  }
  if (!canonicalDecisionStateMatches(deps.root, decision.updated)) {
    throw new Error(`memory-migrate: canonical outcome for ${decision.id} did not match its durable decision.`);
  }
  if (!dbAfter) deps.db.commitPreparedUpserts([decision.updated], [decision.vector]);
  if (decision.action === "cluster") {
    const collection = decision.collection!;
    deps.db.upsertEntity({
      id: `collection:${collection}`,
      name: collection,
      type: "collection",
      createdAt: decision.at,
    });
    deps.db.addEdge(decision.id, `collection:${collection}`, "supports");
  }
  const after = deps.db.get(decision.id);
  if (after === undefined || !sameDecisionState(after, decision.updated)) {
    throw new Error(`memory-migrate: SQLite outcome for ${decision.id} did not match its durable decision.`);
  }
  deps.hooks?.afterActionCommitted?.(decision.decisionId);
  removePendingDecision(deps.root, file, decision);
}

function removePendingDecision(root: string, file: string, decision: DurableMigrateDecision): void {
  const snapshot = readCanonicalFileSnapshot(root, file, { maxBytes: MAX_MONTHLY_AUDIT_BYTES });
  if (snapshot === undefined) throw new Error(`memory-migrate: monthly audit "${file}" disappeared.`);
  const marker = pendingMarker(decision);
  const lines = snapshot.content.split("\n");
  const matches = lines.filter((line) => line.trim() === marker);
  if (matches.length !== 1) {
    throw new Error(`memory-migrate: pending marker ${decision.decisionId} is missing or duplicated.`);
  }
  writeCanonicalFileAtomic(
    root,
    file,
    lines.filter((line) => line.trim() !== marker).join("\n"),
    snapshot.identity,
  );
}

function canonicalPatch(decision: DurableMigrateDecision): Parameters<typeof rewriteBullet>[3] | undefined {
  if (decision.action === "promote") return { salience: decision.updated.salience };
  if (decision.action === "reschedule") {
    return {
      status: "scheduled",
      ...(decision.updated.dueAt === undefined ? {} : { dueAt: decision.updated.dueAt }),
    };
  }
  if (decision.action === "cluster") return { status: "migrated" };
  if (decision.action === "forget") return { status: "dropped" };
  return undefined;
}

function sameDecisionState(left: MemoryRecord, right: MemoryRecord): boolean {
  return left.id === right.id
    && left.type === right.type
    && left.status === right.status
    && left.text === right.text
    && left.salience === right.salience
    && left.isInsight === right.isInsight
    && left.createdAt === right.createdAt
    && left.validTo === right.validTo
    && left.dueAt === right.dueAt
    && left.collection === right.collection
    && left.source.file === right.source.file;
}

function assertCanonicalDecisionState(root: string, record: MemoryRecord): void {
  if (!canonicalDecisionStateMatches(root, record)) {
    throw new Error(`memory-migrate: canonical source does not exactly match memory ${record.id}.`);
  }
}

function canonicalDecisionStateMatches(root: string, record: MemoryRecord): boolean {
  const file = record.source.file;
  if (file === undefined) return true;
  const bullet = readBullet(root, file, record.id);
  return bullet !== undefined
    && bullet.id === record.id
    && bullet.type === record.type
    && bullet.status === record.status
    && bullet.text === record.text
    && bullet.salience === record.salience
    && bullet.isInsight === record.isInsight
    && bullet.createdAt === record.createdAt
    && bullet.dueAt === record.dueAt;
}

function readPendingDecision(
  root: string,
): { readonly file: string; readonly decision: DurableMigrateDecision } | undefined {
  const files = listCanonicalFileNames(root, "monthly", {
    allowMissing: true,
    include: (name) => /^\d{4}-\d{2}\.md$/u.test(name),
  });
  const pending: Array<{ readonly file: string; readonly decision: DurableMigrateDecision }> = [];
  for (const name of files) {
    const file = `monthly/${name}`;
    const snapshot = readCanonicalFileSnapshot(root, file, { maxBytes: MAX_MONTHLY_AUDIT_BYTES });
    if (snapshot === undefined) continue;
    for (const raw of snapshot.content.split("\n")) {
      const line = raw.trim();
      const prefix = `<!-- ${MIGRATE_MARKER}`;
      if (!line.startsWith("<!--") || !line.includes(MIGRATE_MARKER)) continue;
      if (!line.startsWith(prefix) || !line.endsWith(" -->")) {
        throw new Error(`memory-migrate: malformed pending marker in "${file}".`);
      }
      const payload = line.slice(prefix.length, -4);
      const decision = parseDurableDecision(payload);
      pending.push({ file, decision });
    }
  }
  if (pending.length > 1) throw new Error("memory-migrate: multiple pending monthly decisions require operator repair.");
  return pending[0];
}

function parseDurableDecision(encoded: string): DurableMigrateDecision {
  let value: unknown;
  try {
    if (encoded.length > MAX_MONTHLY_AUDIT_BYTES) throw new Error("pending marker exceeds bound");
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error("pending marker is not canonical base64url");
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("memory-migrate: malformed durable pending decision.");
  }
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.decisionId !== "string" || !/^[a-f0-9]{64}$/u.test(value.decisionId)
    || !VALID_ACTIONS.has(String(value.action))
    || typeof value.id !== "string" || value.id.length === 0
    || typeof value.text !== "string"
    || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at))
    || !isMemoryRecord(value.before)
    || !isMemoryRecord(value.updated)
    || value.before.id !== value.id || value.updated.id !== value.id
    || !Array.isArray(value.vector) || value.vector.length === 0 || value.vector.length > 16_384
    || value.vector.some((part) => typeof part !== "number" || !Number.isFinite(part))) {
    throw new Error("memory-migrate: invalid durable pending decision schema.");
  }
  const decision = value as unknown as DurableMigrateDecision;
  const { decisionId: _decisionId, ...payload } = decision;
  if (decision.decisionId !== decisionHash(payload) || !validDecisionTransition(decision)) {
    throw new Error("memory-migrate: durable pending decision binding is invalid.");
  }
  return decision;
}

function decisionHash(decision: Omit<DurableMigrateDecision, "decisionId">): string {
  return createHash("sha256").update(JSON.stringify(decision)).digest("hex");
}

function validDecisionTransition(decision: DurableMigrateDecision): boolean {
  if (decision.text !== decision.before.text
    || decision.updated.id !== decision.before.id
    || decision.updated.source.file !== decision.before.source.file
    || (decision.action === "cluster"
      ? decision.collection === undefined || decision.collection.length === 0
        || decision.updated.collection !== decision.collection
      : decision.collection !== undefined)) {
    return false;
  }
  const expected = updatedRecord(
    decision.before,
    decision.action,
    new Date(decision.at),
    decision.updated.dueAt,
    decision.collection,
  );
  return JSON.stringify(expected) === JSON.stringify(decision.updated);
}

function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (!isRecord(value) || !isRecord(value.source) || !Array.isArray(value.tags)) return false;
  return typeof value.id === "string"
    && (value.type === "task" || value.type === "event" || value.type === "note")
    && (value.status === "open" || value.status === "done" || value.status === "scheduled"
      || value.status === "migrated" || value.status === "dropped" || value.status === "invalidated")
    && typeof value.text === "string"
    && typeof value.salience === "number" && Number.isFinite(value.salience)
    && typeof value.isInsight === "boolean"
    && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.accessCount === "number" && Number.isInteger(value.accessCount) && value.accessCount >= 0
    && value.tags.every((tag) => typeof tag === "string")
    && (value.source.file === undefined || typeof value.source.file === "string")
    && (value.source.line === undefined || (Number.isInteger(value.source.line) && Number(value.source.line) > 0))
    && (value.dueAt === undefined || typeof value.dueAt === "string")
    && (value.collection === undefined || typeof value.collection === "string")
    && (value.validTo === undefined || typeof value.validTo === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
