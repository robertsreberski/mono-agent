import { randomUUID } from "node:crypto";
import { relative } from "node:path";

import type {
  EntityRecord,
  EntityRelationRecord,
  MemoryDb,
  MemoryEntityAssociation,
  MemoryRecord,
} from "../store/index.js";
import { appendBullet, dailyFilePath, rewriteBullet } from "./daily.js";
import { parseDailyFile } from "./grammar.js";
import { appendGraphBatch, type GraphBatchInput, type GraphBatchResult } from "./graph.js";
import {
  assertCanonicalDailySourcePath,
  listCanonicalFileNames,
  readCanonicalFileSnapshot,
  removeCanonicalFile,
  writeCanonicalFileAtomic,
} from "./path-safety.js";
import type { Bullet } from "./types.js";

const OUTBOX_DIR = ".capture-outbox";
const INTENT_FILE_RE = /^intent-[a-f0-9-]{36}\.json$/u;
const MAX_INTENTS = 32;
const MAX_INTENT_BYTES = 2 * 1024 * 1024;
const MAX_ACTIONS = 8;
const MAX_ENTITIES = 16;
const MAX_RELATIONS = 16;
const MAX_ASSOCIATIONS = 128;
const MAX_VECTOR_DIM = 16_384;

export interface CanonicalBulletState {
  readonly file: string;
  readonly bullet: Bullet;
}

export interface CaptureThreadEdge {
  readonly src: string;
  readonly dst: string;
  readonly weight: number;
}

interface CaptureActionBase {
  readonly candidateIndex: number;
}

export type CaptureIntentAction =
  | (CaptureActionBase & {
    readonly kind: "add";
    readonly id: string;
    readonly after: CanonicalBulletState;
    readonly record: MemoryRecord;
    readonly vector?: readonly number[];
    readonly threads: readonly CaptureThreadEdge[];
  })
  | (CaptureActionBase & {
    readonly kind: "update";
    readonly id: string;
    readonly before: CanonicalBulletState;
    readonly after: CanonicalBulletState;
    readonly record: MemoryRecord;
    readonly vector?: readonly number[];
  })
  | (CaptureActionBase & {
    readonly kind: "supersede";
    readonly oldId: string;
    readonly newId: string;
    readonly beforeOld: CanonicalBulletState;
    readonly afterOld: CanonicalBulletState;
    readonly afterNew: CanonicalBulletState;
    readonly record: MemoryRecord;
    readonly vector?: readonly number[];
    readonly at: string;
  })
  | (CaptureActionBase & {
    readonly kind: "noop";
    readonly id: string;
    readonly expected: CanonicalBulletState;
  });

interface CaptureIntent {
  readonly schemaVersion: 1;
  readonly state: "pending" | "complete";
  readonly id: string;
  readonly createdAt: string;
  readonly actions: readonly CaptureIntentAction[];
  readonly graph: {
    readonly entities: readonly EntityRecord[];
    readonly relations: readonly EntityRelationRecord[];
    readonly associations: readonly MemoryEntityAssociation[];
  };
}

export interface CaptureIntentHandle {
  readonly file: string;
}

export interface CaptureIntentReplayResult extends GraphBatchResult {
  readonly appliedMemoryIds: readonly string[];
}

export interface CaptureIntentReplayOptions {
  /** Apply/verify canonical and DB outcomes but leave the durable intent pending. */
  readonly retainIntent?: boolean;
}

/** Atomically publish one bounded, fsynced capture intent before source mutation. */
export function writeCaptureIntent(
  root: string,
  actions: readonly CaptureIntentAction[],
  graph: GraphBatchInput,
  createdAt: string,
): CaptureIntentHandle {
  if (actions.length > MAX_ACTIONS) throw new Error("memory-capture: prepared action batch exceeds the outbox bound.");
  const files = listCanonicalFileNames(root, OUTBOX_DIR, {
    allowMissing: true,
    include: (name) => INTENT_FILE_RE.test(name),
  });
  if (files.length >= MAX_INTENTS) throw new Error("memory-capture: pending capture outbox is full; restart recovery before capturing more.");
  const id = randomUUID();
  const intent: CaptureIntent = {
    schemaVersion: 1,
    state: "pending",
    id,
    createdAt,
    actions,
    graph: {
      entities: [...(graph.entities ?? [])],
      relations: [...(graph.relations ?? [])],
      associations: [...(graph.associations ?? [])],
    },
  };
  const data = serializeIntent(intent);
  if (Buffer.byteLength(data, "utf8") > MAX_INTENT_BYTES) {
    throw new Error("memory-capture: prepared capture intent exceeds the durable outbox byte bound.");
  }
  parseIntent(data);
  const file = `${OUTBOX_DIR}/intent-${id}.json`;
  writeCanonicalFileAtomic(root, file, data);
  return { file };
}

/** Replay one just-written intent through the same exact-match path used at startup. */
export function replayCaptureIntent(
  root: string,
  handle: CaptureIntentHandle,
  db?: MemoryDb,
  options: CaptureIntentReplayOptions = {},
): CaptureIntentReplayResult {
  const replay = loadReplay(root, handle.file);
  const plan = preflightReplay(root, replay, db);
  return applyReplay(root, plan, db, options);
}

/** Replay every pending capture before accepting new writes or taking a rebuild snapshot. */
export function replayCaptureOutbox(
  root: string,
  db?: MemoryDb,
  options: CaptureIntentReplayOptions = {},
): CaptureIntentReplayResult[] {
  const files = captureIntentFiles(root);
  if (files.length > MAX_INTENTS) throw new Error("memory-capture: capture outbox exceeds its bounded intent count.");
  const replays = files.map((name) => loadReplay(root, `${OUTBOX_DIR}/${name}`));
  // Validate every queued action and every vector against the current DB before
  // the first Markdown or graph append. A bad later intent cannot leave an
  // earlier intent half-applied merely because filenames sort first.
  const plans = replays.map((replay) => preflightReplay(root, replay, db));
  return plans.map((plan) => applyReplay(root, plan, db, options));
}

/** Explicit rollback cannot carry provider-bound pending vectors across identities. */
export function assertNoPendingCaptureIntent(root: string): void {
  const files = captureIntentFiles(root);
  if (files.length === 0) return;
  for (const name of files) loadReplay(root, `${OUTBOX_DIR}/${name}`);
  throw new Error(
    "memory-capture: a durable capture intent is pending; start the current writable store "
    + "or recover it before rollback.",
  );
}

interface LoadedReplay {
  readonly file: string;
  readonly snapshot: NonNullable<ReturnType<typeof readCanonicalFileSnapshot>>;
  readonly intent: CaptureIntent;
}

interface ReplayPlan extends LoadedReplay {
  readonly writes: readonly Exclude<CaptureIntentAction, { readonly kind: "noop" }>[];
  readonly appliedMemoryIds: ReadonlySet<string>;
}

function captureIntentFiles(root: string): string[] {
  return listCanonicalFileNames(root, OUTBOX_DIR, {
    allowMissing: true,
    include: (name) => INTENT_FILE_RE.test(name),
  });
}

function loadReplay(root: string, file: string): LoadedReplay {
  const snapshot = readCanonicalFileSnapshot(root, file, { maxBytes: MAX_INTENT_BYTES });
  if (snapshot === undefined) throw new Error(`memory-capture: pending intent "${file}" disappeared.`);
  const intent = parseIntent(snapshot.content);
  return { file, snapshot, intent };
}

function preflightReplay(root: string, replay: LoadedReplay, db: MemoryDb | undefined): ReplayPlan {
  const { intent } = replay;
  if (intent.state === "complete") {
    return { ...replay, writes: [], appliedMemoryIds: new Set<string>() };
  }

  const appliedMemoryIds = new Set<string>();
  for (const action of intent.actions) {
    if (!canonicalActionCanApply(root, action)) {
      throw new Error(`memory-capture: pending intent ${intent.id} conflicts with canonical action ${action.kind}.`);
    }
    appliedMemoryIds.add(memoryIdFor(action));
  }

  const writes = intent.actions.flatMap((action) => {
    if (action.kind === "noop" || (db !== undefined && dbHasCanonicalOutcome(db, action))) return [];
    return [action];
  });
  if (db !== undefined) {
    db.assertPreparedUpserts(
      writes.map((action) => action.record),
      writes.map((action) => action.vector),
    );
    for (const action of intent.actions) {
      if (action.kind === "noop" && !dbHasCanonicalOutcome(db, action)) {
        throw new Error(`memory-capture: pending NOOP target ${action.id} is missing from the active index.`);
      }
      if (action.kind === "supersede" && db.get(action.oldId) === undefined) {
        throw new Error(`memory-capture: pending supersede target ${action.oldId} is missing from the active index.`);
      }
    }
  }

  return { ...replay, writes, appliedMemoryIds };
}

function applyReplay(
  root: string,
  plan: ReplayPlan,
  db: MemoryDb | undefined,
  options: CaptureIntentReplayOptions,
): CaptureIntentReplayResult {
  const { file, snapshot, intent, writes, appliedMemoryIds } = plan;
  if (intent.state === "complete") {
    removeCanonicalFile(root, file, snapshot.identity);
    return emptyReplay();
  }

  for (const action of intent.actions) {
    if (applyCanonicalAction(root, action) === "conflict") {
      throw new Error(`memory-capture: pending intent ${intent.id} conflicts with canonical action ${action.kind}.`);
    }
  }

  if (db !== undefined) {
    if (writes.length > 0) {
      db.commitPreparedUpserts(
        writes.map((action) => action.record),
        writes.map((action) => action.vector),
      );
    }
    for (const action of intent.actions) {
      if (action.kind === "supersede") db.markSuperseded(action.oldId, action.newId, action.at);
      if (action.kind === "add") {
        for (const edge of action.threads) db.addEdge(edge.src, edge.dst, "thread", edge.weight);
      }
    }
  }

  // Canonical memory and its rebuildable SQLite row now exist. Only then may
  // graph evidence become canonical; a graph failure leaves this intent
  // pending and replayable without an orphan association.
  const canonical = appendGraphBatch(root, {
    entities: intent.graph.entities,
    relations: intent.graph.relations,
    associations: intent.graph.associations.filter((association) => appliedMemoryIds.has(association.memoryId)),
  });

  if (db !== undefined) {
    // The DB mirror is part of intent completion. Any failure leaves the
    // pending file in place so restart retries the idempotent canonical graph.
    for (const entity of canonical.entities) db.upsertEntity(entity);
    for (const relation of canonical.relations) {
      db.addEntityRelation(relation.src, relation.dst, relation.relation, relation.createdAt);
    }
    for (const association of canonical.associations) db.associateMemory(association);
    assertDbReplayOutcome(db, intent.actions, canonical);
  }

  if (options.retainIntent === true) {
    return { ...canonical, appliedMemoryIds: [...appliedMemoryIds] };
  }

  const completed: CaptureIntent = { ...intent, state: "complete" };
  writeCanonicalFileAtomic(root, file, serializeIntent(completed), snapshot.identity);
  const completeSnapshot = readCanonicalFileSnapshot(root, file, { maxBytes: MAX_INTENT_BYTES });
  if (completeSnapshot === undefined) throw new Error(`memory-capture: completed intent "${file}" disappeared.`);
  removeCanonicalFile(root, file, completeSnapshot.identity);
  return { ...canonical, appliedMemoryIds: [...appliedMemoryIds] };
}

function canonicalActionCanApply(root: string, action: CaptureIntentAction): boolean {
  if (action.kind === "add") {
    const current = bulletState(root, action.after);
    return current === "exact" || current === "missing";
  }
  if (action.kind === "update") {
    return bulletState(root, action.after) === "exact" || bulletState(root, action.before) === "exact";
  }
  if (action.kind === "noop") return bulletState(root, action.expected) === "exact";

  const oldAfter = bulletState(root, action.afterOld);
  const oldBefore = bulletState(root, action.beforeOld);
  const next = bulletState(root, action.afterNew);
  return (oldAfter === "exact" && next === "exact")
    || (oldBefore === "exact" && next === "missing")
    || (oldAfter === "exact" && next === "missing")
    || (oldBefore === "exact" && next === "exact");
}

function dbHasCanonicalOutcome(db: MemoryDb, action: CaptureIntentAction): boolean {
  const state = action.kind === "noop"
    ? action.expected
    : action.kind === "supersede" ? action.afterNew : action.after;
  const record = db.get(state.bullet.id);
  if (record === undefined || !recordMatchesCanonicalState(record, state)) return false;
  if (action.kind === "noop" || action.vector === undefined) return true;
  // A safe rebuild re-embeds the canonical record under the target identity.
  // Its already-present vector is authoritative; replaying the outbox's old
  // provider-bound bytes would either downgrade it or fail on a new dimension.
  if (db.hasVector(record.id)) return true;
  return db.indexMetadata()?.tier === "lite";
}

function recordMatchesCanonicalState(record: MemoryRecord, state: CanonicalBulletState): boolean {
  const bullet = state.bullet;
  return record.id === bullet.id
    && record.type === bullet.type
    && record.status === bullet.status
    && record.text === bullet.text
    && record.salience === bullet.salience
    && record.isInsight === bullet.isInsight
    && record.createdAt === bullet.createdAt
    && record.dueAt === bullet.dueAt
    && record.source.file === state.file;
}

function assertDbReplayOutcome(
  db: MemoryDb,
  actions: readonly CaptureIntentAction[],
  graph: GraphBatchResult,
): void {
  for (const action of actions) {
    if (!dbHasCanonicalOutcome(db, action)) {
      throw new Error(`memory-capture: active index did not reach canonical ${action.kind} outcome.`);
    }
    if (action.kind === "add") {
      const edges = db.edges(action.id);
      for (const expected of action.threads) {
        if (!edges.some((edge) => edge.kind === "thread" && edge.dst === expected.dst && edge.weight === expected.weight)) {
          throw new Error(`memory-capture: active index did not retain thread edge for ${action.id}.`);
        }
      }
    } else if (action.kind === "supersede") {
      const old = db.get(action.oldId);
      if (old === undefined || !recordMatchesCanonicalState(old, action.afterOld)
        || old.supersededBy !== action.newId || old.supersededAt !== action.at
        || !db.edges(action.oldId).some((edge) => edge.kind === "supersedes" && edge.dst === action.newId)) {
        throw new Error(`memory-capture: active index did not reach supersede outcome for ${action.oldId}.`);
      }
    }
  }
  for (const entity of graph.entities) {
    if (!entityRecordsEqual(db.getEntity(entity.id), entity)) {
      throw new Error(`memory-capture: active index did not mirror entity ${entity.id}.`);
    }
  }
  for (const relation of graph.relations) {
    if (!db.relationsFor(relation.src).some((actual) => relationRecordsEqual(actual, relation))) {
      throw new Error(`memory-capture: active index did not mirror relation ${relation.src} -> ${relation.dst}.`);
    }
  }
  for (const association of graph.associations) {
    if (!db.associationsForMemory(association.memoryId)
      .some((actual) => associationRecordsEqual(actual, association))) {
      throw new Error(`memory-capture: active index did not mirror association for ${association.memoryId}.`);
    }
  }
}

function entityRecordsEqual(left: EntityRecord | undefined, right: EntityRecord): boolean {
  return left !== undefined
    && left.id === right.id
    && left.name === right.name
    && left.type === right.type
    && left.summary === right.summary
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

function relationRecordsEqual(left: EntityRelationRecord, right: EntityRelationRecord): boolean {
  return left.src === right.src
    && left.dst === right.dst
    && left.relation === right.relation
    && left.createdAt === right.createdAt;
}

function associationRecordsEqual(left: MemoryEntityAssociation, right: MemoryEntityAssociation): boolean {
  return left.memoryId === right.memoryId
    && left.entityId === right.entityId
    && left.provenance === right.provenance
    && left.createdAt === right.createdAt;
}

function applyCanonicalAction(root: string, action: CaptureIntentAction): "applied" | "conflict" {
  if (action.kind === "add") {
    const current = bulletState(root, action.after);
    if (current === "exact") return "applied";
    if (current !== "missing") return "conflict";
    appendExpectedBullet(root, action.after);
    return bulletState(root, action.after) === "exact" ? "applied" : "conflict";
  }
  if (action.kind === "update") {
    const after = bulletState(root, action.after);
    if (after === "exact") return "applied";
    const before = bulletState(root, action.before);
    if (before !== "exact") return "conflict";
    if (!rewriteBullet(root, action.after.file, action.id, { text: action.after.bullet.text })) return "conflict";
    return bulletState(root, action.after) === "exact" ? "applied" : "conflict";
  }
  if (action.kind === "noop") {
    return bulletState(root, action.expected) === "exact" ? "applied" : "conflict";
  }

  const oldAfter = bulletState(root, action.afterOld);
  const oldBefore = bulletState(root, action.beforeOld);
  const next = bulletState(root, action.afterNew);
  if (oldAfter === "exact" && next === "exact") return "applied";
  if (oldBefore === "exact" && next === "missing") {
    appendExpectedBullet(root, action.afterNew);
    if (!rewriteBullet(root, action.afterOld.file, action.oldId, { status: action.afterOld.bullet.status })) {
      return "conflict";
    }
    return bulletState(root, action.afterOld) === "exact"
      && bulletState(root, action.afterNew) === "exact" ? "applied" : "conflict";
  }
  if (oldAfter === "exact" && next === "missing") {
    appendExpectedBullet(root, action.afterNew);
    return bulletState(root, action.afterNew) === "exact" ? "applied" : "conflict";
  }
  if (oldBefore === "exact" && next === "exact") {
    if (!rewriteBullet(root, action.afterOld.file, action.oldId, { status: action.afterOld.bullet.status })) {
      return "conflict";
    }
    return bulletState(root, action.afterOld) === "exact" ? "applied" : "conflict";
  }
  return "conflict";
}

function appendExpectedBullet(root: string, expected: CanonicalBulletState): void {
  const when = new Date(expected.bullet.createdAt);
  if (!Number.isFinite(when.getTime()) || relative(root, dailyFilePath(root, when)) !== expected.file) {
    throw new Error("memory-capture: supersede replacement has an inconsistent canonical path.");
  }
  appendBullet(root, expected.bullet, when);
}

function bulletState(root: string, expected: CanonicalBulletState): "exact" | "missing" | "different" {
  assertCanonicalDailySourcePath(expected.file);
  const snapshot = readCanonicalFileSnapshot(root, expected.file, { allowMissing: true });
  if (snapshot === undefined) return "missing";
  const matches = parseDailyFile(snapshot.content).bullets.filter((bullet) => bullet.id === expected.bullet.id);
  if (matches.length === 0) return "missing";
  if (matches.length !== 1) return "different";
  return bulletsEqual(matches[0]!, expected.bullet) ? "exact" : "different";
}

function bulletsEqual(left: Bullet, right: Bullet): boolean {
  return left.id === right.id
    && left.type === right.type
    && left.status === right.status
    && left.text === right.text
    && left.salience === right.salience
    && left.isInsight === right.isInsight
    && left.createdAt === right.createdAt
    && left.dueAt === right.dueAt
    && left.refs.length === right.refs.length
    && left.refs.every((ref, index) => ref === right.refs[index]);
}

function memoryIdFor(action: CaptureIntentAction): string {
  return action.kind === "supersede" ? action.newId : action.id;
}

function serializeIntent(intent: CaptureIntent): string {
  const actions = intent.actions.map((action) => {
    if (action.kind === "noop" || action.vector === undefined) return action;
    return { ...action, vector: encodeVector(action.vector) };
  });
  return `${JSON.stringify({ ...intent, actions })}\n`;
}

function encodeVector(vector: readonly number[]): {
  readonly encoding: "float32-le-base64";
  readonly dimension: number;
  readonly data: string;
} {
  if (vector.length === 0 || vector.length > MAX_VECTOR_DIM
    || vector.some((part) => typeof part !== "number" || !Number.isFinite(part))) {
    throw new Error("memory-capture: invalid prepared vector in outbox intent.");
  }
  const bytes = Buffer.allocUnsafe(vector.length * 4);
  for (const [index, value] of vector.entries()) bytes.writeFloatLE(value, index * 4);
  return { encoding: "float32-le-base64", dimension: vector.length, data: bytes.toString("base64") };
}

function decodeActionVector(value: unknown): unknown {
  if (!isRecord(value) || value.kind === "noop" || value.vector === undefined) return value;
  const encoded = value.vector;
  if (!isRecord(encoded)
    || encoded.encoding !== "float32-le-base64"
    || !Number.isInteger(encoded.dimension)
    || Number(encoded.dimension) <= 0
    || Number(encoded.dimension) > MAX_VECTOR_DIM
    || typeof encoded.data !== "string") {
    throw new Error("memory-capture: invalid encoded vector in outbox intent.");
  }
  const bytes = Buffer.from(encoded.data, "base64");
  if (bytes.length !== Number(encoded.dimension) * 4 || bytes.toString("base64") !== encoded.data) {
    throw new Error("memory-capture: malformed encoded vector in outbox intent.");
  }
  const vector: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += 4) vector.push(bytes.readFloatLE(offset));
  if (vector.some((part) => !Number.isFinite(part))) {
    throw new Error("memory-capture: non-finite encoded vector in outbox intent.");
  }
  return { ...value, vector };
}

function parseIntent(raw: string): CaptureIntent {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("memory-capture: malformed capture outbox intent.");
  }
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || (value.state !== "pending" && value.state !== "complete")
    || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/u.test(value.id)
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || !Array.isArray(value.actions) || value.actions.length > MAX_ACTIONS
    || !isRecord(value.graph)
    || !Array.isArray(value.graph.entities) || value.graph.entities.length > MAX_ENTITIES
    || !Array.isArray(value.graph.relations) || value.graph.relations.length > MAX_RELATIONS
    || !Array.isArray(value.graph.associations) || value.graph.associations.length > MAX_ASSOCIATIONS) {
    throw new Error("memory-capture: invalid capture outbox intent schema.");
  }
  const intent = {
    ...value,
    actions: value.actions.map(decodeActionVector),
  } as unknown as CaptureIntent;
  const indexes = new Set<number>();
  const touchedMemoryIds = new Set<string>();
  for (const action of intent.actions) {
    validateAction(action);
    if (indexes.has(action.candidateIndex)) throw new Error("memory-capture: duplicate candidate index in outbox intent.");
    indexes.add(action.candidateIndex);
    const ids = action.kind === "supersede" ? [action.oldId, action.newId] : [action.id];
    for (const id of ids) {
      if (touchedMemoryIds.has(id)) {
        throw new Error("memory-capture: overlapping memory actions in outbox intent.");
      }
      touchedMemoryIds.add(id);
    }
  }
  for (const entity of intent.graph.entities) validateEntity(entity);
  for (const relation of intent.graph.relations) validateRelation(relation);
  for (const association of intent.graph.associations) validateAssociation(association);
  const memoryIds = new Set(intent.actions.map(memoryIdFor));
  const entityIds = new Set(intent.graph.entities.map((entity) => entity.id));
  if (intent.graph.associations.some((association) => !memoryIds.has(association.memoryId)
    || !entityIds.has(association.entityId))) {
    throw new Error("memory-capture: outbox association does not match its planned action and entity.");
  }
  if (intent.graph.relations.some((relation) => !entityIds.has(relation.src) || !entityIds.has(relation.dst))) {
    throw new Error("memory-capture: outbox relation has an unknown entity endpoint.");
  }
  return intent;
}

function validateAction(action: CaptureIntentAction): void {
  if (!isRecord(action) || !Number.isInteger(action.candidateIndex)
    || action.candidateIndex < 0 || action.candidateIndex >= MAX_ACTIONS) {
    throw new Error("memory-capture: invalid action index in outbox intent.");
  }
  if (action.kind === "add") {
    validateState(action.after);
    validateRecord(action.record, action.id);
    assertRecordMatchesBullet(action.record, action.after);
    validateVector(action.vector);
    if (action.id !== action.after.bullet.id || action.record.source.file !== action.after.file
      || !Array.isArray(action.threads) || action.threads.length > 5
      || action.threads.some((edge) => !isRecord(edge) || edge.src !== action.id
        || typeof edge.dst !== "string" || edge.dst.length === 0
        || typeof edge.weight !== "number" || !Number.isFinite(edge.weight))) {
      throw new Error("memory-capture: invalid add action in outbox intent.");
    }
    return;
  }
  if (action.kind === "update") {
    validateState(action.before);
    validateState(action.after);
    validateRecord(action.record, action.id);
    validateVector(action.vector);
    if (action.before.bullet.id !== action.id || action.after.bullet.id !== action.id
      || action.before.file !== action.after.file || action.record.source.file !== action.after.file) {
      throw new Error("memory-capture: invalid update action in outbox intent.");
    }
    assertRecordMatchesBullet(action.record, action.after);
    if (!bulletsEqual({ ...action.before.bullet, text: action.after.bullet.text }, action.after.bullet)) {
      throw new Error("memory-capture: update intent changes fields outside its text outcome.");
    }
    return;
  }
  if (action.kind === "supersede") {
    validateState(action.beforeOld);
    validateState(action.afterOld);
    validateState(action.afterNew);
    validateRecord(action.record, action.newId);
    validateVector(action.vector);
    if (typeof action.oldId !== "string" || action.beforeOld.bullet.id !== action.oldId
      || typeof action.newId !== "string" || action.afterNew.bullet.id !== action.newId
      || action.afterOld.bullet.id !== action.oldId
      || action.beforeOld.file !== action.afterOld.file
      || action.record.source.file !== action.afterNew.file
      || typeof action.at !== "string" || !Number.isFinite(Date.parse(action.at))) {
      throw new Error("memory-capture: invalid supersede action in outbox intent.");
    }
    assertRecordMatchesBullet(action.record, action.afterNew);
    if (!bulletsEqual({ ...action.beforeOld.bullet, status: "invalidated" }, action.afterOld.bullet)) {
      throw new Error("memory-capture: supersede intent has an invalid prior-memory outcome.");
    }
    return;
  }
  if (action.kind === "noop") {
    validateState(action.expected);
    if (typeof action.id !== "string" || action.expected.bullet.id !== action.id) {
      throw new Error("memory-capture: invalid noop action in outbox intent.");
    }
    return;
  }
  throw new Error("memory-capture: unknown action in outbox intent.");
}

function validateState(state: CanonicalBulletState): void {
  if (!isRecord(state) || typeof state.file !== "string" || !isBullet(state.bullet)) {
    throw new Error("memory-capture: invalid canonical bullet state in outbox intent.");
  }
  assertCanonicalDailySourcePath(state.file);
}

function validateRecord(record: MemoryRecord, id: string): void {
  if (!isRecord(record)
    || record.id !== id
    || (record.type !== "task" && record.type !== "event" && record.type !== "note")
    || !isMemoryStatus(record.status)
    || typeof record.text !== "string"
    || typeof record.salience !== "number" || !Number.isFinite(record.salience)
    || typeof record.isInsight !== "boolean"
    || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
    || typeof record.accessCount !== "number" || !Number.isInteger(record.accessCount) || record.accessCount < 0
    || !isRecord(record.source) || typeof record.source.file !== "string"
    || (record.source.line !== undefined && (!Number.isInteger(record.source.line) || Number(record.source.line) <= 0))
    || !Array.isArray(record.tags) || record.tags.some((tag) => typeof tag !== "string")
    || (record.dueAt !== undefined && typeof record.dueAt !== "string")
    || (record.collection !== undefined && typeof record.collection !== "string")) {
    throw new Error("memory-capture: invalid memory record in outbox intent.");
  }
  assertCanonicalDailySourcePath(record.source.file);
}

function assertRecordMatchesBullet(record: MemoryRecord, state: CanonicalBulletState): void {
  const bullet = state.bullet;
  if (record.source.file !== state.file
    || record.id !== bullet.id
    || record.type !== bullet.type
    || record.status !== bullet.status
    || record.text !== bullet.text
    || record.salience !== bullet.salience
    || record.isInsight !== bullet.isInsight
    || record.createdAt !== bullet.createdAt
    || record.dueAt !== bullet.dueAt) {
    throw new Error("memory-capture: memory record does not match its canonical bullet outcome.");
  }
}

function validateVector(vector: readonly number[] | undefined): void {
  if (vector === undefined) return;
  if (!Array.isArray(vector) || vector.length === 0 || vector.length > MAX_VECTOR_DIM
    || vector.some((part) => typeof part !== "number" || !Number.isFinite(part))) {
    throw new Error("memory-capture: invalid prepared vector in outbox intent.");
  }
}

function isBullet(value: unknown): value is Bullet {
  return isRecord(value)
    && typeof value.id === "string" && value.id.length > 0
    && (value.type === "task" || value.type === "event" || value.type === "note")
    && isMemoryStatus(value.status)
    && typeof value.text === "string"
    && typeof value.salience === "number" && Number.isFinite(value.salience)
    && typeof value.isInsight === "boolean"
    && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
    && Array.isArray(value.refs) && value.refs.length <= 64 && value.refs.every((ref) => typeof ref === "string")
    && (value.dueAt === undefined || typeof value.dueAt === "string");
}

function validateEntity(entity: EntityRecord): void {
  if (!isRecord(entity) || typeof entity.id !== "string" || entity.id.length === 0
    || typeof entity.name !== "string" || entity.name.length === 0
    || typeof entity.createdAt !== "string" || !Number.isFinite(Date.parse(entity.createdAt))) {
    throw new Error("memory-capture: invalid entity in outbox intent.");
  }
}

function validateRelation(relation: EntityRelationRecord): void {
  if (!isRecord(relation) || typeof relation.src !== "string" || typeof relation.dst !== "string"
    || typeof relation.relation !== "string" || typeof relation.createdAt !== "string"
    || !Number.isFinite(Date.parse(relation.createdAt))) {
    throw new Error("memory-capture: invalid relation in outbox intent.");
  }
}

function validateAssociation(association: MemoryEntityAssociation): void {
  if (!isRecord(association) || typeof association.memoryId !== "string" || typeof association.entityId !== "string"
    || association.provenance !== "capture" || typeof association.createdAt !== "string"
    || !Number.isFinite(Date.parse(association.createdAt))) {
    throw new Error("memory-capture: invalid association in outbox intent.");
  }
}

function isMemoryStatus(value: unknown): value is Bullet["status"] {
  return value === "open" || value === "done" || value === "scheduled"
    || value === "migrated" || value === "dropped" || value === "invalidated";
}

function emptyReplay(): CaptureIntentReplayResult {
  return { entities: [], relations: [], associations: [], appliedMemoryIds: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
