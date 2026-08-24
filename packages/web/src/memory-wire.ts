import type {
  WebMemoryActionHistoryItem,
  WebMemoryCapability,
  WebMemoryGraph,
  WebMemoryGraphEdge,
  WebMemoryGraphNode,
  WebMemoryMutationAdmission,
  WebMemoryOperation,
  WebMemoryOverview,
  WebMemoryRecord,
  WebMemoryRecordDetail,
  WebMemoryRecordPage,
} from "./contracts.js";

const MAX_RECORDS = 100;
const MAX_HISTORY_ITEMS = 1_024;
const MAX_GRAPH_ITEMS = 200;
const MAX_ID_CODE_POINTS = 512;
const MAX_TEXT_CODE_POINTS = 4_000;
const MAX_TAGS = 32;
const MAX_TAG_CODE_POINTS = 64;
const MAX_COLLECTION_CODE_POINTS = 128;
const MAX_LABEL_CODE_POINTS = 160;
const MAX_METADATA_CODE_POINTS = 512;
const MAX_SOURCE_ID_BYTES = 4_096;
const INVALID_SEMANTIC_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const COLLECTION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CURSOR = /^[A-Za-z0-9_-]+$/u;
const OUTPUT_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const CONFIRMATION_TOKEN = /^[A-Za-z0-9_-]{1,1024}$/u;
const REVISION = /^[a-f0-9]{64}$/u;
const SAFE_CAPABILITY_REASONS = new Set([
  "Memory action state requires recovery.",
  "Memory actions are disabled by configuration.",
  "Memory actions require the active BuJo tier.",
  "Memory operator is temporarily unavailable.",
]);

export class MemoryWireError extends Error {
  constructor() {
    super("The agent returned invalid memory operator data.");
    this.name = "MemoryWireError";
  }
}

export function parseMemoryCapability(value: unknown): WebMemoryCapability {
  const capability = strictObject(value, [
    "schema", "backend", "tier", "status", "read", "actions", "graph", "reason",
  ]);
  if (capability.schema !== 1
    || (capability.backend !== "builtin" && capability.backend !== "supermemory")
    || (capability.status !== "ready" && capability.status !== "degraded" && capability.status !== "unsupported")
    || typeof capability.read !== "boolean"
    || typeof capability.actions !== "boolean"
    || (capability.graph !== "captured" && capability.graph !== "derived" && capability.graph !== "unavailable")
    || (capability.tier !== undefined
      && capability.tier !== "lite" && capability.tier !== "journal" && capability.tier !== "bujo")) {
    return invalid();
  }
  const rawReason = capability.reason === undefined
    ? undefined
    : safeString(capability.reason, MAX_METADATA_CODE_POINTS);
  const reason = rawReason === undefined
    ? undefined
    : SAFE_CAPABILITY_REASONS.has(rawReason) ? rawReason : "Memory operator capability is limited.";
  return {
    schema: 1,
    backend: capability.backend,
    ...(capability.tier === undefined ? {} : { tier: capability.tier }),
    status: capability.status,
    read: capability.read,
    actions: capability.actions,
    graph: capability.graph,
    ...(reason === undefined ? {} : { reason }),
  };
}

export function parseMemoryOverviewEnvelope(value: unknown): WebMemoryOverview {
  const envelope = strictObject(value, ["overview"]);
  requireKeys(envelope, ["overview"]);
  const overview = strictObject(envelope.overview, ["generatedAt", "capability", "counts", "access", "embedding"]);
  requireKeys(overview, ["generatedAt", "capability", "counts", "access"]);
  const counts = strictObject(overview.counts, ["total", "active", "superseded", "forgotten", "byType"]);
  requireKeys(counts, ["total", "active", "superseded", "forgotten", "byType"]);
  const byType = strictObject(counts.byType, ["task", "event", "note"]);
  requireKeys(byType, ["task", "event", "note"]);
  const access = strictObject(overview.access, ["totalCount", "accessedRecords"]);
  requireKeys(access, ["totalCount", "accessedRecords"]);
  const total = integer(counts.total);
  const active = integer(counts.active);
  const superseded = integer(counts.superseded);
  const forgotten = integer(counts.forgotten);
  const task = integer(byType.task);
  const event = integer(byType.event);
  const note = integer(byType.note);
  const totalCount = integer(access.totalCount);
  const accessedRecords = integer(access.accessedRecords);
  if (active + superseded + forgotten !== total
    || task + event + note !== total
    || accessedRecords > total
    || accessedRecords > totalCount) return invalid();

  let embedding: WebMemoryOverview["embedding"];
  if (overview.embedding !== undefined) {
    const candidate = strictObject(overview.embedding, ["model", "dimension"]);
    const model = candidate.model === undefined
      ? undefined
      : safeString(candidate.model, MAX_METADATA_CODE_POINTS);
    const dimension = candidate.dimension === undefined
      ? undefined
      : integer(candidate.dimension, 1, 1_000_000);
    embedding = {
      ...(model === undefined ? {} : { model }),
      ...(dimension === undefined ? {} : { dimension }),
    };
  }
  return {
    generatedAt: timestamp(overview.generatedAt),
    capability: parseMemoryCapability(overview.capability),
    counts: { total, active, superseded, forgotten, byType: { task, event, note } },
    access: { totalCount, accessedRecords },
    ...(embedding === undefined ? {} : { embedding }),
  };
}

export function parseMemoryRecordPage(value: unknown): WebMemoryRecordPage {
  const page = strictObject(value, ["records", "nextCursor"]);
  requireKeys(page, ["records"]);
  const rawRecords = strictArray(page.records, MAX_RECORDS);
  const records = rawRecords.map(parseMemoryRecord);
  if (new Set(records.map((record) => record.id)).size !== records.length) return invalid();
  let nextCursor: string | undefined;
  if (page.nextCursor !== undefined) {
    nextCursor = safeString(page.nextCursor, 4_096);
    if (!CURSOR.test(nextCursor) || Buffer.byteLength(nextCursor, "utf8") > 4_096) return invalid();
  }
  return { records, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

export function parseMemoryRecordDetail(value: unknown): WebMemoryRecordDetail {
  const detail = strictObject(value, ["record", "history"]);
  requireKeys(detail, ["record", "history"]);
  const record = parseMemoryRecord(detail.record);
  const history = strictArray(detail.history, MAX_HISTORY_ITEMS).map(parseHistoryItem);
  if (history.some((item) => item.recordId !== record.id && item.resultRecordId !== record.id)) return invalid();
  return { record, history };
}

export function parseMemoryGraphEnvelope(value: unknown): WebMemoryGraph {
  const envelope = strictObject(value, ["graph"]);
  requireKeys(envelope, ["graph"]);
  const graph = strictObject(envelope.graph, ["fidelity", "nodes", "edges", "truncated"]);
  requireKeys(graph, ["fidelity", "nodes", "edges"]);
  if ((graph.fidelity !== "captured" && graph.fidelity !== "derived" && graph.fidelity !== "unavailable")
    || (graph.truncated !== undefined && graph.truncated !== true)) return invalid();
  const nodes = strictArray(graph.nodes, MAX_GRAPH_ITEMS).map(parseGraphNode);
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size !== nodes.length) return invalid();
  const edges = strictArray(graph.edges, MAX_GRAPH_ITEMS).map(parseGraphEdge);
  if (edges.some((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))) return invalid();
  if (graph.fidelity === "unavailable" && (nodes.length > 0 || edges.length > 0)) return invalid();
  return {
    fidelity: graph.fidelity,
    nodes,
    edges,
    ...(graph.truncated === true ? { truncated: true } : {}),
  };
}

export function parseMemoryOperationEnvelope(value: unknown): WebMemoryOperation {
  const envelope = strictObject(value, ["operation"]);
  requireKeys(envelope, ["operation"]);
  return parseMemoryOperation(envelope.operation);
}

export function parseMemoryMutationAdmission(value: unknown): WebMemoryMutationAdmission {
  const admission = strictObject(value, ["kind", "operation", "confirmation"]);
  requireKeys(admission, ["kind"]);
  if (admission.kind === "queued") {
    requireExactKeys(admission, ["kind", "operation"]);
    return { kind: "queued", operation: parseMemoryOperation(admission.operation) };
  }
  if (admission.kind !== "confirmation_required") return invalid();
  requireExactKeys(admission, ["kind", "confirmation"]);
  const confirmation = strictObject(admission.confirmation, ["token", "expiresAt", "message"]);
  requireKeys(confirmation, ["token", "expiresAt", "message"]);
  if (typeof confirmation.token !== "string" || !CONFIRMATION_TOKEN.test(confirmation.token)) return invalid();
  safeString(confirmation.message, 1_024);
  return {
    kind: "confirmation_required",
    confirmation: {
      token: confirmation.token,
      expiresAt: timestamp(confirmation.expiresAt),
      message: "Confirm this memory action?",
    },
  };
}

function parseMemoryRecord(value: unknown): WebMemoryRecord {
  const record = strictObject(value, [
    "id", "revision", "lifecycle", "type", "status", "text", "salience", "isInsight",
    "createdAt", "lastAccessedAt", "accessCount", "validFrom", "validTo", "dueAt", "tags",
    "collection", "supersededBy", "supersededAt", "source",
  ]);
  requireKeys(record, [
    "id", "revision", "lifecycle", "type", "status", "text", "salience", "isInsight",
    "createdAt", "accessCount", "tags",
  ]);
  const id = memoryId(record.id);
  if (typeof record.revision !== "string" || !REVISION.test(record.revision)
    || (record.lifecycle !== "active" && record.lifecycle !== "superseded" && record.lifecycle !== "forgotten")
    || (record.type !== "task" && record.type !== "event" && record.type !== "note")
    || (record.status !== "open" && record.status !== "done" && record.status !== "scheduled"
      && record.status !== "migrated" && record.status !== "dropped" && record.status !== "invalidated")
    || typeof record.isInsight !== "boolean") return invalid();
  const supersededBy = record.supersededBy === undefined ? undefined : memoryId(record.supersededBy);
  const expectedLifecycle = record.status === "dropped"
    ? "forgotten"
    : record.status === "invalidated" || supersededBy !== undefined ? "superseded" : "active";
  if (record.lifecycle !== expectedLifecycle) return invalid();
  const tags = strictArray(record.tags, MAX_TAGS).map((tag) => canonicalString(tag, MAX_TAG_CODE_POINTS));
  if (new Set(tags).size !== tags.length) return invalid();
  const collection = record.collection === undefined ? undefined : memoryCollection(record.collection);
  const lastAccessedAt = optionalTimestamp(record.lastAccessedAt);
  const validFrom = optionalTimestamp(record.validFrom);
  const validTo = optionalTimestamp(record.validTo);
  const dueAt = optionalTimestamp(record.dueAt);
  const supersededAt = optionalTimestamp(record.supersededAt);
  if (supersededAt !== undefined && record.lifecycle !== "superseded") return invalid();
  let source: WebMemoryRecord["source"];
  if (record.source !== undefined) {
    const candidate = strictObject(record.source, ["conversationId"]);
    const conversationId = candidate.conversationId === undefined
      ? undefined
      : safeString(candidate.conversationId, MAX_SOURCE_ID_BYTES);
    if (conversationId !== undefined && Buffer.byteLength(conversationId, "utf8") > MAX_SOURCE_ID_BYTES) {
      return invalid();
    }
    source = { ...(conversationId === undefined ? {} : { conversationId }) };
  }
  return {
    id,
    revision: record.revision,
    lifecycle: record.lifecycle,
    type: record.type,
    status: record.status,
    text: canonicalString(record.text, MAX_TEXT_CODE_POINTS, true),
    salience: finiteNumber(record.salience, 0, 1),
    isInsight: record.isInsight,
    createdAt: timestamp(record.createdAt),
    ...(lastAccessedAt === undefined ? {} : { lastAccessedAt }),
    accessCount: integer(record.accessCount),
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(validTo === undefined ? {} : { validTo }),
    ...(dueAt === undefined ? {} : { dueAt }),
    tags,
    ...(collection === undefined ? {} : { collection }),
    ...(supersededBy === undefined ? {} : { supersededBy }),
    ...(supersededAt === undefined ? {} : { supersededAt }),
    ...(source === undefined ? {} : { source }),
  };
}

function parseHistoryItem(value: unknown): WebMemoryActionHistoryItem {
  const item = strictObject(value, [
    "id", "action", "status", "recordId", "resultRecordId", "createdAt", "completedAt", "errorCode",
  ]);
  requireKeys(item, ["id", "action", "status", "recordId", "createdAt", "completedAt"]);
  if ((item.action !== "edit" && item.action !== "forget" && item.action !== "restore")
    || (item.status !== "succeeded" && item.status !== "failed")) return invalid();
  const createdAt = timestamp(item.createdAt);
  const completedAt = timestamp(item.completedAt);
  if (Date.parse(completedAt) < Date.parse(createdAt)) return invalid();
  const resultRecordId = item.resultRecordId === undefined ? undefined : memoryId(item.resultRecordId);
  const errorCode = item.errorCode === undefined ? undefined : outputCode(item.errorCode);
  if ((item.status === "failed") !== (errorCode !== undefined)) return invalid();
  return {
    id: memoryId(item.id),
    action: item.action,
    status: item.status,
    recordId: memoryId(item.recordId),
    ...(resultRecordId === undefined ? {} : { resultRecordId }),
    createdAt,
    completedAt,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function parseGraphNode(value: unknown): WebMemoryGraphNode {
  const node = strictObject(value, ["kind", "id", "label", "entityType", "summary", "lifecycle", "recordType"]);
  requireKeys(node, ["kind", "id", "label"]);
  const id = memoryId(node.id);
  const label = safeString(node.label, MAX_LABEL_CODE_POINTS);
  if (node.kind === "memory") {
    requireExactKeys(node, ["kind", "id", "label", "lifecycle", "recordType"]);
    if ((node.lifecycle !== "active" && node.lifecycle !== "superseded" && node.lifecycle !== "forgotten")
      || (node.recordType !== "task" && node.recordType !== "event" && node.recordType !== "note")) return invalid();
    return { kind: "memory", id, label, lifecycle: node.lifecycle, recordType: node.recordType };
  }
  if (node.kind !== "entity") return invalid();
  requireExactOptionalKeys(node, ["kind", "id", "label"], ["entityType", "summary"]);
  const entityType = node.entityType === undefined ? undefined : safeString(node.entityType, 128);
  const summary = node.summary === undefined ? undefined : safeString(node.summary, MAX_TEXT_CODE_POINTS);
  return {
    kind: "entity",
    id,
    label,
    ...(entityType === undefined ? {} : { entityType }),
    ...(summary === undefined ? {} : { summary }),
  };
}

function parseGraphEdge(value: unknown): WebMemoryGraphEdge {
  const edge = strictObject(value, ["source", "target", "kind", "label", "weight"]);
  requireKeys(edge, ["source", "target", "kind"]);
  if (edge.kind !== "relation" && edge.kind !== "association"
    && edge.kind !== "supports" && edge.kind !== "supersedes") return invalid();
  const label = edge.label === undefined ? undefined : safeString(edge.label, MAX_METADATA_CODE_POINTS);
  const weight = edge.weight === undefined ? undefined : finiteNumber(edge.weight, Number.MIN_VALUE, 1);
  return {
    source: memoryId(edge.source),
    target: memoryId(edge.target),
    kind: edge.kind,
    ...(label === undefined ? {} : { label }),
    ...(weight === undefined ? {} : { weight }),
  };
}

function parseMemoryOperation(value: unknown): WebMemoryOperation {
  const operation = strictObject(value, [
    "id", "action", "recordId", "status", "createdAt", "updatedAt", "resultRecordId", "errorCode", "errorMessage",
  ]);
  requireKeys(operation, ["id", "action", "recordId", "status", "createdAt", "updatedAt"]);
  if ((operation.action !== "edit" && operation.action !== "forget" && operation.action !== "restore")
    || (operation.status !== "queued" && operation.status !== "draining" && operation.status !== "applying"
      && operation.status !== "succeeded" && operation.status !== "failed")) return invalid();
  const createdAt = timestamp(operation.createdAt);
  const updatedAt = timestamp(operation.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) return invalid();
  const resultRecordId = operation.resultRecordId === undefined ? undefined : memoryId(operation.resultRecordId);
  if ((operation.action === "edit" || operation.action === "restore") !== (resultRecordId !== undefined)) {
    return invalid();
  }
  const errorCode = operation.errorCode === undefined ? undefined : outputCode(operation.errorCode);
  const errorMessage = operation.errorMessage === undefined
    ? undefined
    : sanitizedOperationMessage(outputMessage(operation.errorMessage), errorCode);
  if (operation.status === "failed"
    ? errorCode === undefined || errorMessage === undefined
    : errorCode !== undefined || errorMessage !== undefined) return invalid();
  return {
    id: memoryId(operation.id),
    action: operation.action,
    recordId: memoryId(operation.recordId),
    status: operation.status,
    createdAt,
    updatedAt,
    ...(resultRecordId === undefined ? {} : { resultRecordId }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

function strictObject(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  void allowedKeys;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) return invalid();
  return value as Record<string, unknown>;
}

function strictArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.entries(descriptors).some(([key, descriptor]) => key !== "length" && !("value" in descriptor))) {
    return invalid();
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return invalid();
  }
  return value;
}

function requireKeys(value: Record<string, unknown>, requiredKeys: readonly string[]): void {
  if (requiredKeys.some((key) => !Object.hasOwn(value, key))) invalid();
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  requireKeys(value, keys);
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid();
}

function requireExactOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  requireKeys(value, required);
  if (Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) invalid();
}

function memoryId(value: unknown): string {
  return safeString(value, MAX_ID_CODE_POINTS);
}

function safeString(value: unknown, maxCodePoints: number): string {
  if (typeof value !== "string" || value.length === 0
    || [...value].length > maxCodePoints || INVALID_SEMANTIC_TEXT.test(value)) return invalid();
  return value;
}

function canonicalString(value: unknown, maxCodePoints: number, rejectDelimiter = false): string {
  const candidate = safeString(value, maxCodePoints);
  if (candidate.normalize("NFKC").trim() !== candidate || (rejectDelimiter && candidate.includes("<!--mem"))) {
    return invalid();
  }
  return candidate;
}

function memoryCollection(value: unknown): string {
  const candidate = safeString(value, MAX_COLLECTION_CODE_POINTS);
  return COLLECTION.test(candidate) ? candidate : invalid();
}

function outputCode(value: unknown): string {
  return typeof value === "string" && OUTPUT_CODE.test(value) ? value : invalid();
}

function outputMessage(value: unknown): string {
  return safeString(value, MAX_METADATA_CODE_POINTS);
}

function sanitizedOperationMessage(message: string, code: string | undefined): string {
  void message;
  if (code === "revision_conflict") return "Memory record changed before the action completed.";
  if (code === "not_found") return "Memory record was not found.";
  if (code === "invalid_request") return "Memory action was not valid for this record.";
  return "Memory action failed safely.";
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : invalid();
}

function finiteNumber(value: unknown, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : invalid();
}

function timestamp(value: unknown): string {
  if (typeof value !== "string") return invalid();
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? value : invalid();
}

function optionalTimestamp(value: unknown): string | undefined {
  return value === undefined ? undefined : timestamp(value);
}

function invalid(): never {
  throw new MemoryWireError();
}
