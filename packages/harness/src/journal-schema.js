// @ts-check
import { createHash } from "node:crypto";
import { JOURNAL_FORMAT, JOURNAL_KINDS, JOURNAL_VERSION } from "./journal-types.js";
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v) => typeof v === "string" && v.length > 0 && v.length <= 512;
const time = (v) => Number.isSafeInteger(v) && v >= 0;
const ids = (v) => Array.isArray(v) && v.every(id) && new Set(v).size === v.length;
const status = (v) => ["completed", "failed", "aborted", "interrupted"].includes(v);
const fail = () => { throw Object.assign(new Error("Invalid mono-agent harness journal v2"), { code: "ERR_HARNESS_JOURNAL_CORRUPT" }); };
const requireValue = (v) => { if (!v) fail(); };

/** Digest only the actual native input content, never controllers or timestamps. */
export function digestTurnInput(content) {
  return createHash("sha256").update(JSON.stringify(typeof content === "string" ? [{ type: "text", text: content }] : content)).digest("hex");
}

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
  if (descriptor.reconciliation !== undefined) {
    const opt = descriptor.reconciliation;
    if (descriptor.kind !== "host" || descriptor.baseRevision === null
      || !keys(opt, ["version", "purpose", "fenceDigest", "initialInputId"]) || opt.version !== 1
      || !["execution", "compaction"].includes(opt.purpose) || !digest(opt.fenceDigest)
      || (opt.purpose === "execution" ? !id(opt.initialInputId) : opt.initialInputId !== null)) {
      throw new TypeError("Invalid protected sessionTurn reconciliation contract");
    }
  }
}

const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const model = (value) => keys(value, ["provider", "id", "api"]) && id(value.provider) && id(value.id) && id(value.api);

/** Versioned minimal final result. Unknown/private fields cannot enter seals. */
export function validateTurnSeal(seal, terminalStatus) {
  requireValue(keys(seal, ["version", "outcome", "result"]) && seal.version === 1
    && seal.outcome === ({ completed: "completed", failed: "failed", aborted: "cancelled", interrupted: "interrupted" })[terminalStatus]);
  const result = seal.result;
  if (result === null) { requireValue(terminalStatus !== "completed"); return; }
  requireValue(keys(result, ["text", "error", "failureKind", "cancelled", "stopReason", "turnDisposition"])
    && (typeof result.text === "string" || result.text === null) && (result.error === null || typeof result.error === "string")
    && (result.failureKind === null || id(result.failureKind)) && typeof result.cancelled === "boolean"
    && (result.stopReason === null || id(result.stopReason))
    && (result.turnDisposition === undefined || result.turnDisposition === "silent")
    && (terminalStatus !== "completed" || result.error === null && result.failureKind === null && !result.cancelled)
    && (terminalStatus !== "aborted" || result.cancelled));
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
    requireValue(object(record) && (record.schemaVersion === JOURNAL_VERSION || record.schemaVersion === 3 && ["compaction", "model_change"].includes(record.kind))
      && id(record.id) && !this.ids.has(record.id) && record.parentId === this.parentId
      && record.seq === this.seq + 1 && time(record.timestamp) && id(record.turnId)
      && JOURNAL_KINDS.includes(record.kind) && object(record.payload));
    const p = record.payload;
    const turn = this.turns.get(record.turnId);
    if (record.kind === "turn_start") {
      requireValue(!turn && this.openTurns.size === 0
        && ["host", "instance", "synthetic"].includes(p.identitySource) && object(p.config)
        && p.baselineTipId === this.tip && record.operationId === undefined);
      if (p.binding !== undefined) {
        const binding = p.binding;
        requireValue(keys(binding, ["version", "kind", "ownerKey", "historyBucket", "turnId", "handleId", "baseRevision", "reconciliation", "model"]) && binding.version === 1);
        try { validateSessionTurn(binding, binding.handleId); } catch { fail(); }
        requireValue(binding.reconciliation && binding.turnId === record.turnId && model(binding.model)
          && model(p.config.model) && ["provider", "id", "api"].every((key) => binding.model[key] === p.config.model[key])
          && (binding.reconciliation.purpose === "execution" ? p.identitySource === "host" : p.identitySource === "synthetic")
          && (this.owner.kind === "unbound" || ["kind", "ownerKey", "historyBucket"].every((key) => this.owner[key] === binding[key])));
      }
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
      if (turn.start.payload.binding?.reconciliation.purpose === "compaction") requireValue(p.type === "compaction");
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
      if (p.seal !== undefined) validateTurnSeal(p.seal, p.status);
      if (turn.start.payload.binding) {
        requireValue(p.seal !== undefined);
        const purpose = turn.start.payload.binding.reconciliation.purpose;
        if (p.status === "completed" && purpose === "execution") requireValue(turn.inputs.has(turn.start.payload.binding.reconciliation.initialInputId)
          && p.finalOperationId !== null && this.operations.get(p.finalOperationId).start.payload.type === "prompt"
          && this.operations.get(p.finalOperationId).end.payload.status === "completed");
        if (purpose === "compaction") requireValue(turn.inputs.size === 0 && turn.operations.every((id) => this.operations.get(id).start.payload.type === "compaction"));
      }
    } else {
      if (record.operationId !== undefined) requireValue(op && !op.end && op.turnId === record.turnId);
      if (["message", "compaction"].includes(record.kind)) {
        requireValue(p.contextParentId === this.tip);
        if (record.kind === "message") {
          requireValue(object(p.message) && id(p.message.role) && object(p.provenance)
            && id(p.provenance.provider) && id(p.provenance.api) && id(p.provenance.model)
            && object(p.input) && typeof p.input.complete === "boolean"
            && (p.input.id === null || id(p.input.id)));
          if (turn.start.payload.binding && p.input.id !== null) requireValue(p.input.complete && digest(p.input.requestDigest)
            && p.input.requestDigest === digestTurnInput(p.message.content)
            && ["initial", "live", "replay"].includes(p.input.placement));
        } else {
          // Legacy v2 cuts remain readable; new cuts additionally carry an exact
          // checkpoint envelope and positively validated ordered coverage.
          requireValue(object(p.compaction) && typeof p.compaction.summary === "string"
            && ids(p.preservedMessageIds) && p.preservedMessageIds.every((i, index) => this.contextInfo.get(i)?.kind === "message"
              && (index === 0 || this.contextInfo.get(p.preservedMessageIds[index - 1]).seq < this.contextInfo.get(i).seq))
            && Array.isArray(p.derivedMessages) && Number.isSafeInteger(p.coverageVersion) && p.coverageVersion > 0);
          const checkpoint = p.compaction.checkpoint;
          if (record.schemaVersion === 3) {
            const inherited = checkpoint?.inheritedCoverage;
            requireValue(inherited?.version === 1 && Array.isArray(inherited.sources)
              && inherited.sources.every((s) => id(s.journalId) && (s.sourceTipId === null || id(s.sourceTipId)) && time(s.sourceSeq) && digest(s.sourceDigest))
              && new Set(inherited.sources.map((s) => s.journalId)).size === inherited.sources.length);
          } else requireValue(checkpoint?.inheritedCoverage === undefined);
          if (checkpoint !== undefined) requireValue(object(checkpoint) && checkpoint.version === 1
            && checkpoint.projectionVersion === 1 && checkpoint.summaryMessage?.role === "compactionSummary"
            && checkpoint.summaryMessage.summary === p.compaction.summary && time(checkpoint.summaryMessage.timestamp)
            && checkpoint.summaryMessage.tokensBefore === p.compaction.tokensBefore
            && JSON.stringify(checkpoint.preservedMessageIds) === JSON.stringify(p.preservedMessageIds)
            && JSON.stringify(checkpoint.derivedMessages) === JSON.stringify(p.derivedMessages)
            && checkpoint.coverage?.version === p.coverageVersion && checkpoint.coverage.sourceTipId === this.tip
            && time(checkpoint.coverage.sourceEntryCount) && (checkpoint.tokensBefore === null || Number.isFinite(checkpoint.tokensBefore))
            && (checkpoint.tokensAfter === null || Number.isFinite(checkpoint.tokensAfter))
            && (checkpoint.model === null || object(checkpoint.model)));
        }
      } else if (record.kind === "rewind") {
        requireValue(p.tipId === null || this.contextIds.has(p.tipId));
      } else if (record.kind === "tool_call") {
        const message = this.contextInfo.get(p.messageId);
        const call = this.calls.get(callKey);
        requireValue(id(p.callId) && id(p.name) && message?.role === "assistant" && message.calls?.get(p.callId) === p.name
          && (!call ? ["observed", "admitted", "blocked"].includes(p.admission)
            : !call.result && call.name === p.name && call.messageId === p.messageId
              && (call.admission === "observed" ? ["admitted", "blocked"].includes(p.admission)
                : call.admission === "admitted" && p.admission === "started")));
      } else if (record.kind === "tool_result") {
        const call = this.calls.get(callKey), message = this.contextInfo.get(p.messageId);
        const returned = p.phase === "returned";
        const envelope = returned ? p.message : null;
        requireValue(call && call.name === p.name && (returned ? !call.result && call.admission === "started"
          && p.messageId === null && object(envelope) && envelope.role === "toolResult"
          && envelope.toolCallId === p.callId && envelope.toolName === p.name && Array.isArray(envelope.content)
          : !call.placed && message?.role === "toolResult" && message.callId === p.callId && message.name === p.name)
          && (p.outcome === "success" ? (returned ? envelope.isError : message?.isError) === false
            : ["error", "cancelled", "skipped"].includes(p.outcome) ? (returned ? envelope.isError : message?.isError) === true : p.outcome === "unknown"));
      } else if (record.kind === "interruption") {
        requireValue(typeof p.cause === "string" && ids(p.operationIds)
          && p.operationIds.every((i) => this.operations.get(i)?.turnId === record.turnId)
          && (p.tipId === undefined || p.tipId === this.tip)
          && (p.calls === undefined || Array.isArray(p.calls) && p.calls.every((call) => {
            const known = this.calls.get(`${call.operationId}\0${call.callId}`);
            return known?.turnId === record.turnId && known.name === call.name && known.messageId === call.messageId
              && known.admission === call.admission && ["crashed", "user_interrupted", "skipped", "superseded", "suspended_not_resumed", "observed_outcome"].includes(call.cause)
              && (call.cause !== "observed_outcome" || known.result);
          })));
      } else if (record.kind === "model_change") {
        if (record.schemaVersion === 3) requireValue(keys(p, ["version", "switchId", "from", "to", "source", "checkpointId", "artifactRef"])
          && p.version === 1 && id(p.switchId) && keys(p.artifactRef, ["id", "hash"]) && id(p.artifactRef.id) && digest(p.artifactRef.hash));
        requireValue(object(p.from) && object(p.to) && typeof p.source === "string"
          && (p.checkpointId === null || this.contextIds.has(p.checkpointId)));
      } else if (record.kind === "input_queued") {
        const input = this.inputs.get(p.inputId);
        requireValue(id(p.inputId) && typeof p.placement === "string"
          && (p.state === "queued" ? !input : p.state === "cancelled" && input?.state === "queued"));
        if (turn.start.payload.binding) requireValue(digest(p.requestDigest) && p.placement === "live");
      } else if (record.kind === "input_consumed") {
        const message = this.contextInfo.get(p.messageId);
        requireValue(id(p.inputId) && !turn.inputs.has(p.inputId) && message?.role === "user"
          && message.inputId === p.inputId && this.inputs.get(p.inputId)?.state !== "cancelled");
        if (turn.start.payload.binding && this.inputs.has(p.inputId)) requireValue(this.inputs.get(p.inputId).turnId === record.turnId
          && this.inputs.get(p.inputId).requestDigest === message.requestDigest && this.inputs.get(p.inputId).placement === message.placement);
      } else if (record.kind === "owner_binding") {
        requireValue((p.kind === "unbound" && this.owner.kind === "unbound") || (["host", "instance"].includes(p.kind)
          && id(p.ownerKey) && (p.kind === "host" ? id(p.historyBucket) : p.historyBucket === null)
          && (this.owner.kind === "unbound" || this.owner.kind === p.kind && this.owner.ownerKey === p.ownerKey && this.owner.historyBucket === p.historyBucket)));
        if (turn.start.payload.binding) requireValue(["kind", "ownerKey", "historyBucket"].every((key) => p[key] === turn.start.payload.binding[key]));
      } else if (record.kind === "handle_binding") {
        requireValue(id(p.handleId) && (!this.handles.has(p.handleId) || (p.authoritative === true && this.owner.kind !== "unbound"))
          && (p.baseRevision === null || time(p.baseRevision)) && (p.model === null || object(p.model)));
        if (turn.start.payload.binding) requireValue(p.authoritative === true && p.handleId === turn.start.payload.binding.handleId
          && p.baseRevision === turn.start.payload.binding.baseRevision && model(p.model)
          && ["provider", "id", "api"].every((key) => p.model[key] === turn.start.payload.binding.model[key]));
      } else if (record.kind === "handle_retired") {
        requireValue(this.handles.has(p.handleId) && typeof p.cause === "string");
      }
    }
  }
  /** @param {import('./journal-types.js').JournalEntry} record */
  apply(record) {
    this.validate(record);
    const p = record.payload;
    if (record.kind === "turn_start") {
      this.openTurns.add(record.turnId);
      if (p.binding) {
        this.owner = { kind: p.binding.kind, ownerKey: p.binding.ownerKey, historyBucket: p.binding.historyBucket };
        this.handles.add(p.binding.handleId);
        this.handleBindings.set(p.binding.handleId, { handleId: p.binding.handleId, baseRevision: p.binding.baseRevision,
          model: structuredClone(p.binding.model), authoritative: true });
      }
    }
    if (record.kind === "turn_start") this.turns.set(record.turnId, { start: record, operations: [], inputs: new Set(), inputEvidence: new Map(), admittedInputIds: new Set(), contextIds: [], interruptionIds: [], end: null });
    if (record.kind === "operation_start") {
      this.openOperations.add(record.operationId);
      this.operations.set(record.operationId, { start: record, turnId: record.turnId, end: null, suspended: false });
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
      this.turns.get(record.turnId).contextIds.push(record.id);
      if (message?.role === "assistant" && message.stopReason === "deferred" && record.operationId) this.operations.get(record.operationId).suspended = true;
      this.contextInfo.set(record.id, { kind: record.kind, seq: record.seq, parentId: p.contextParentId,
        operationId: record.operationId, role: message?.role, stopReason: message?.stopReason, inputId: p.input?.id,
        requestDigest: p.input?.requestDigest, placement: p.input?.placement, inputComplete: p.input?.complete, callId: message?.toolCallId, name: message?.toolName, isError: message?.isError,
        calls: new Map((Array.isArray(message?.content) ? message.content : []).filter((part) => part?.type === "toolCall").map((call) => [call.id, call.name])) });
    }
    if (record.kind === "rewind") this.tip = p.tipId;
    const callKey = `${record.operationId ?? record.turnId}\0${p.callId}`;
    if (record.kind === "tool_call") this.calls.set(callKey, { ...(this.calls.get(callKey) ?? {}), name: p.name,
      callId: p.callId, messageId: p.messageId, admission: p.admission, operationId: record.operationId, turnId: record.turnId,
      result: false });
    if (record.kind === "tool_result") {
      const call = this.calls.get(callKey); call.result = true; call.outcome = p.outcome;
      if (p.phase !== "returned") call.placed = true;
    }
    if (record.kind === "interruption") this.turns.get(record.turnId).interruptionIds.push(record.id);
    if (record.kind === "input_queued") {
      this.inputs.set(p.inputId, { state: p.state, placement: p.placement, requestDigest: p.requestDigest, turnId: record.turnId });
      this.turns.get(record.turnId).admittedInputIds.add(p.inputId);
    }
    if (record.kind === "input_consumed") {
      this.turns.get(record.turnId).inputs.add(p.inputId);
      const message = this.contextInfo.get(p.messageId);
      this.turns.get(record.turnId).inputEvidence.set(p.inputId, { id: p.inputId, messageId: p.messageId,
        requestDigest: message.requestDigest, placement: message.placement, complete: message.inputComplete });
      if (this.inputs.has(p.inputId)) this.inputs.get(p.inputId).state = "consumed";
    }
    if (record.kind === "owner_binding") this.owner = p;
    if (record.kind === "handle_binding") { this.handles.add(p.handleId); this.handleBindings.set(p.handleId, p); }
    if (record.kind === "handle_retired") this.handles.delete(p.handleId);
    this.ids.add(record.id); this.seq = record.seq; this.parentId = record.id;
  }
}
