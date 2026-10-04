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
  if (header.import !== undefined) {
    const info = header.import, source = info?.source, identity = source?.identity;
    requireValue(object(info) && info.version === 1 && /^[a-f0-9]{64}$/.test(info.importId)
      && ["import", "clean_break"].includes(info.mode) && time(info.messageCount)
      && /^[a-f0-9]{64}$/.test(info.contextHash) && source?.id === header.id
      && typeof source.path === "string" && source.path.split(/[\\/]/).length === 2
      && source.path.split(/[\\/]/).every((part) => part && part !== "." && part !== "..")
      && source.path.split(/[\\/]/)[0] !== "mono-v2"
      && source.path.endsWith(".jsonl") && object(identity)
      && ["dev", "ino", "size"].every((key) => time(identity[key]))
      && Number.isFinite(identity.mtimeMs) && /^[a-f0-9]{64}$/.test(identity.sha256));
  }
}

/** Validate the protected descriptor independently of recovery opt-in. */
export function validateSessionTurn(descriptor, handleId) {
  if (!object(descriptor) || !["host", "instance"].includes(descriptor.kind)
    || !id(descriptor.ownerKey) || !id(descriptor.turnId) || !id(descriptor.handleId)
    || descriptor.handleId !== handleId || !(descriptor.baseRevision === null || time(descriptor.baseRevision))
    || (descriptor.kind === "host" ? !id(descriptor.historyBucket) : descriptor.historyBucket !== null)) {
    throw new TypeError("Invalid host-owned sessionTurn descriptor");
  }
}

/** Incremental reference/lifecycle validator. Never transforms native payloads. */
export class JournalValidator {
  constructor() {
    this.seq = 0;
    /** @type {string|null} */ this.parentId = null;
    this.ids = new Set();
    this.contextIds = new Set();
    this.contextInfo = new Map();
    /** @type {string|null} */ this.tip = null;
    this.turns = new Map();
    this.openTurns = new Set();
    this.openOperations = new Set();
    this.operations = new Map();
    this.calls = new Map();
    this.inputs = new Map();
    this.handles = new Set();
    this.handleBindings = new Map();
    /** @type {any} */ this.owner = { kind: "unbound" };
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
      requireValue(!turn && this.openTurns.size === 0
        && ["host", "instance", "synthetic"].includes(p.identitySource) && object(p.config)
        && p.baselineTipId === this.tip && record.operationId === undefined);
      return;
    }
    // Even administrative writes have an explicitly synthetic execution scope.
    requireValue(turn && !turn.end);
    const op = this.operations.get(record.operationId);
    const callKey = `${record.operationId ?? record.turnId}\0${p.callId}`;
    if (record.kind === "operation_start") {
      requireValue(id(record.operationId) && !op
        && (this.openOperations.size === 0
          || (p.type === "compaction" && this.operations.get(p.parentOperationId)?.start.payload.type === "prompt"
            && this.operations.get(p.parentOperationId)?.turnId === record.turnId
            && this.openOperations.size === 1
            && !this.operations.get(p.parentOperationId)?.end))
        && ["prompt", "compaction"].includes(p.type) && typeof p.cause === "string"
        && p.baselineTipId === this.tip && object(p.config));
    } else if (record.kind === "operation_end") {
      requireValue(op && !op.end && op.turnId === record.turnId && status(p.status) && p.tipId === this.tip
        && ![...this.openOperations].some((id) => this.operations.get(id).start.payload.parentOperationId === record.operationId));
    } else if (record.kind === "turn_end") {
      requireValue(record.operationId === undefined && status(p.status) && ids(p.consumedInputIds)
        && ![...this.openOperations].some((id) => this.operations.get(id).turnId === record.turnId)
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
            && ids(p.preservedMessageIds) && p.preservedMessageIds.every((i, index) => this.contextInfo.get(i)?.kind === "message"
              && (index === 0 || this.contextInfo.get(p.preservedMessageIds[index - 1]).seq < this.contextInfo.get(i).seq))
            && Array.isArray(p.derivedMessages) && Number.isSafeInteger(p.coverageVersion) && p.coverageVersion > 0);
        }
      } else if (record.kind === "rewind") {
        requireValue(p.tipId === null || this.contextIds.has(p.tipId));
      } else if (record.kind === "tool_call") {
        const message = this.contextInfo.get(p.messageId);
        requireValue(id(p.callId) && !this.calls.has(callKey) && id(p.name)
          && message?.role === "assistant" && message.calls?.get(p.callId) === p.name
          && ["observed", "admitted", "blocked"].includes(p.admission));
      } else if (record.kind === "tool_result") {
        const call = this.calls.get(callKey), message = this.contextInfo.get(p.messageId);
        requireValue(call && !call.result && call.name === p.name && message?.role === "toolResult"
          && message.callId === p.callId && message.name === p.name
          && (p.outcome === "success" ? message.isError === false
            : ["error", "cancelled", "skipped"].includes(p.outcome) ? message.isError === true : p.outcome === "unknown"));
      } else if (record.kind === "interruption") {
        requireValue(typeof p.cause === "string" && ids(p.operationIds)
          && p.operationIds.every((i) => this.operations.get(i)?.turnId === record.turnId));
      } else if (record.kind === "model_change") {
        requireValue(object(p.from) && object(p.to) && typeof p.source === "string"
          && (p.checkpointId === null || this.contextIds.has(p.checkpointId)));
      } else if (record.kind === "input_queued") {
        const input = this.inputs.get(p.inputId);
        requireValue(id(p.inputId) && typeof p.placement === "string"
          && (p.state === "queued" ? !input : p.state === "cancelled" && input?.state === "queued"));
      } else if (record.kind === "input_consumed") {
        const message = this.contextInfo.get(p.messageId);
        requireValue(id(p.inputId) && !turn.inputs.has(p.inputId) && message?.role === "user"
          && message.inputId === p.inputId && this.inputs.get(p.inputId)?.state !== "cancelled");
      } else if (record.kind === "owner_binding") {
        requireValue((p.kind === "unbound" && this.owner.kind === "unbound") || (["host", "instance"].includes(p.kind)
          && id(p.ownerKey) && (p.kind === "host" ? id(p.historyBucket) : p.historyBucket === null)
          && (this.owner.kind === "unbound" || this.owner.kind === p.kind && this.owner.ownerKey === p.ownerKey && this.owner.historyBucket === p.historyBucket)));
      } else if (record.kind === "handle_binding") {
        requireValue(id(p.handleId) && (!this.handles.has(p.handleId) || (p.authoritative === true && this.owner.kind !== "unbound"))
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
    if (record.kind === "turn_start") this.openTurns.add(record.turnId);
    if (record.kind === "turn_start") this.turns.set(record.turnId, { start: record, operations: [], inputs: new Set(), end: null });
    if (record.kind === "operation_start") {
      this.openOperations.add(record.operationId);
      this.operations.set(record.operationId, { start: record, turnId: record.turnId, end: null });
      this.turns.get(record.turnId).operations.push(record.operationId);
    }
    if (record.kind === "operation_end") {
      this.openOperations.delete(record.operationId);
      this.operations.get(record.operationId).end = record;
      this.turns.get(record.turnId).finalOperationId = record.operationId;
    }
    if (record.kind === "turn_end") { this.openTurns.delete(record.turnId); this.turns.get(record.turnId).end = record; }
    if (["message", "compaction"].includes(record.kind)) {
      this.contextIds.add(record.id); this.tip = record.id;
      const message = p.message;
      this.contextInfo.set(record.id, { kind: record.kind, seq: record.seq, parentId: p.contextParentId,
        role: message?.role, inputId: p.input?.id, callId: message?.toolCallId, name: message?.toolName, isError: message?.isError,
        calls: new Map((Array.isArray(message?.content) ? message.content : []).filter((part) => part?.type === "toolCall").map((call) => [call.id, call.name])) });
    }
    if (record.kind === "rewind") this.tip = p.tipId;
    const callKey = `${record.operationId ?? record.turnId}\0${p.callId}`;
    if (record.kind === "tool_call") this.calls.set(callKey, { name: p.name, result: false });
    if (record.kind === "tool_result") this.calls.get(callKey).result = true;
    if (record.kind === "input_queued") this.inputs.set(p.inputId, { state: p.state, placement: p.placement });
    if (record.kind === "input_consumed") {
      this.turns.get(record.turnId).inputs.add(p.inputId);
      if (this.inputs.has(p.inputId)) this.inputs.get(p.inputId).state = "consumed";
    }
    if (record.kind === "owner_binding") this.owner = p;
    if (record.kind === "handle_binding") { this.handles.add(p.handleId); this.handleBindings.set(p.handleId, p); }
    if (record.kind === "handle_retired") this.handles.delete(p.handleId);
    this.ids.add(record.id); this.seq = record.seq; this.parentId = record.id;
  }
}
