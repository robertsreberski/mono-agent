// @ts-check
import { JOURNAL_FORMAT, JOURNAL_KINDS, JOURNAL_VERSION } from "./journal-types.js";
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v) => typeof v === "string" && v.length > 0 && v.length <= 512;
const time = (v) => Number.isSafeInteger(v) && v >= 0;
const ids = (v) => Array.isArray(v) && v.every(id) && new Set(v).size === v.length;
const status = (v) => ["completed", "failed", "aborted", "interrupted"].includes(v);
const fail = () => { throw new Error("Invalid mono-agent harness journal v2"); };
const requireValue = (v) => { if (!v) fail(); };

/** @param {any} header */
export function validateJournalHeader(header) {
  requireValue(object(header) && header.format === JOURNAL_FORMAT && header.version === JOURNAL_VERSION
    && id(header.journalId) && /^[A-Za-z0-9_-]+$/.test(header.journalId)
    && header.ownershipSchemaVersion === 1 && header.ownership?.kind === "unbound"
    && id(header.initialHandle?.id) && header.id === header.initialHandle.id
    && typeof header.cwd === "string" && time(header.createdAt));
}

/** Incremental reference/lifecycle validator. Never transforms native payloads. */
export class JournalValidator {
  constructor() {
    this.seq = 0;
    /** @type {string|null} */ this.parentId = null;
    this.ids = new Set();
    this.contextIds = new Set();
    /** @type {string|null} */ this.tip = null;
    this.turns = new Map();
    this.operations = new Map();
    this.calls = new Map();
    this.inputs = new Set();
    this.handles = new Set();
  }
  /** @param {import('./journal-types.js').JournalEntry} record */
  validate(record) {
    requireValue(object(record) && record.schemaVersion === JOURNAL_VERSION
      && id(record.id) && !this.ids.has(record.id) && record.parentId === this.parentId
      && record.seq === this.seq + 1 && time(record.timestamp) && id(record.turnId)
      && JOURNAL_KINDS.includes(record.kind) && object(record.payload));
    const p = record.payload;
    const turn = this.turns.get(record.turnId);
    if (record.kind === "turn_start") {
      requireValue(!turn && ![...this.turns.values()].some((t) => !t.end)
        && ["host", "synthetic"].includes(p.identitySource) && object(p.config)
        && p.baselineTipId === this.tip && record.operationId === undefined);
      return;
    }
    // Even administrative writes have an explicitly synthetic execution scope.
    requireValue(turn && !turn.end);
    const op = this.operations.get(record.operationId);
    if (record.kind === "operation_start") {
      requireValue(id(record.operationId) && !op
        && (![...this.operations.values()].some((o) => !o.end)
          || (p.type === "compaction" && this.operations.get(p.parentOperationId)?.start.payload.type === "prompt"
            && !this.operations.get(p.parentOperationId)?.end))
        && ["prompt", "compaction"].includes(p.type) && typeof p.cause === "string"
        && p.baselineTipId === this.tip && object(p.config));
    } else if (record.kind === "operation_end") {
      requireValue(op && !op.end && op.turnId === record.turnId && status(p.status) && p.tipId === this.tip
        && ![...this.operations.values()].some((o) => !o.end && o.start.payload.parentOperationId === record.operationId));
    } else if (record.kind === "turn_end") {
      requireValue(record.operationId === undefined && status(p.status) && ids(p.consumedInputIds)
        && ![...this.operations.values()].some((o) => o.turnId === record.turnId && !o.end)
        && (p.finalOperationId === null || (this.operations.get(p.finalOperationId)?.end
          && this.operations.get(p.finalOperationId)?.turnId === record.turnId))
        && p.finalOperationId === (turn.finalOperationId ?? null) && p.tipId === this.tip
        && JSON.stringify([...p.consumedInputIds].sort()) === JSON.stringify([...turn.inputs].sort()));
    } else {
      if (record.operationId !== undefined) requireValue(op && !op.end && op.turnId === record.turnId);
      if (["message", "compaction"].includes(record.kind)) {
        requireValue(p.contextParentId === this.tip);
        if (record.kind === "message") {
          requireValue(object(p.message) && id(p.message.role) && object(p.provenance)
            && id(p.provenance.provider) && id(p.provenance.api) && id(p.provenance.model)
            && object(p.input) && typeof p.input.complete === "boolean"
            && (p.input.id === null || id(p.input.id)));
        } else {
          // Keep the adapter-shaped compaction unchanged until exact checkpoints
          // in P1b; ordered IDs and explicit derived messages are already versioned.
          requireValue(object(p.compaction) && typeof p.compaction.summary === "string"
            && ids(p.preservedMessageIds) && p.preservedMessageIds.every((i) => this.contextIds.has(i))
            && Array.isArray(p.derivedMessages) && Number.isSafeInteger(p.coverageVersion) && p.coverageVersion > 0);
        }
      } else if (record.kind === "rewind") {
        requireValue(p.tipId === null || this.contextIds.has(p.tipId));
      } else if (record.kind === "tool_call") {
        requireValue(id(p.callId) && !this.calls.has(p.callId) && id(p.name)
          && this.contextIds.has(p.messageId) && ["observed", "admitted", "blocked"].includes(p.admission));
      } else if (record.kind === "tool_result") {
        const call = this.calls.get(p.callId);
        requireValue(call && call.name === p.name && this.contextIds.has(p.messageId)
          && ["success", "error", "unknown", "cancelled", "skipped"].includes(p.outcome));
      } else if (record.kind === "interruption") {
        requireValue(typeof p.cause === "string" && ids(p.operationIds)
          && p.operationIds.every((i) => this.operations.get(i)?.turnId === record.turnId));
      } else if (record.kind === "model_change") {
        requireValue(object(p.from) && object(p.to) && typeof p.source === "string"
          && (p.checkpointId === null || this.contextIds.has(p.checkpointId)));
      } else if (record.kind === "input_queued") {
        requireValue(id(p.inputId) && !this.inputs.has(p.inputId) && ["queued", "cancelled"].includes(p.state)
          && typeof p.placement === "string");
      } else if (record.kind === "input_consumed") {
        requireValue(id(p.inputId) && !turn.inputs.has(p.inputId) && this.contextIds.has(p.messageId));
      } else if (record.kind === "owner_binding") {
        requireValue(p.kind === "unbound" || (["host", "instance"].includes(p.kind)
          && id(p.ownerKey) && (p.historyBucket === null || id(p.historyBucket))));
      } else if (record.kind === "handle_binding") {
        requireValue(id(p.handleId) && !this.handles.has(p.handleId)
          && (p.baseRevision === null || time(p.baseRevision)) && (p.model === null || object(p.model)));
      } else if (record.kind === "handle_retired") {
        requireValue(this.handles.has(p.handleId) && typeof p.cause === "string");
      }
    }
  }
  /** @param {import('./journal-types.js').JournalEntry} record */
  apply(record) {
    this.validate(record);
    const p = record.payload;
    if (record.kind === "turn_start") this.turns.set(record.turnId, { start: record, operations: [], inputs: new Set(), end: null });
    if (record.kind === "operation_start") {
      this.operations.set(record.operationId, { start: record, turnId: record.turnId, end: null });
      this.turns.get(record.turnId).operations.push(record.operationId);
    }
    if (record.kind === "operation_end") {
      this.operations.get(record.operationId).end = record;
      this.turns.get(record.turnId).finalOperationId = record.operationId;
    }
    if (record.kind === "turn_end") this.turns.get(record.turnId).end = record;
    if (["message", "compaction"].includes(record.kind)) { this.contextIds.add(record.id); this.tip = record.id; }
    if (record.kind === "rewind") this.tip = p.tipId;
    if (record.kind === "tool_call") this.calls.set(p.callId, { name: p.name });
    if (record.kind === "input_queued") this.inputs.add(p.inputId);
    if (record.kind === "input_consumed") this.turns.get(record.turnId).inputs.add(p.inputId);
    if (record.kind === "handle_binding") this.handles.add(p.handleId);
    if (record.kind === "handle_retired") this.handles.delete(p.handleId);
    this.ids.add(record.id); this.seq = record.seq; this.parentId = record.id;
  }
}
