// @ts-check
// Internal wire contract, not a runtime-adapter API. Native envelopes remain opaque.
/** @typedef {'turn_start'|'turn_end'|'operation_start'|'operation_end'|'message'|'tool_call'|'tool_result'|'compaction'|'interruption'|'rewind'|'model_change'|'input_queued'|'input_consumed'|'owner_binding'|'handle_binding'|'handle_retired'} JournalKind */
/** @typedef {{provider:string, api:string, model:string, account?:string}} Provenance */
/** @typedef {{schemaVersion:2, id:string, parentId:string|null, seq:number, timestamp:number, turnId:string, operationId?:string, kind:JournalKind, payload:Record<string, any>}} JournalEntry */
/** @typedef {{format:'mono-harness', version:2, journalId:string, ownershipSchemaVersion:1, ownership:{kind:'unbound'}, initialHandle:{id:string}, id:string, cwd:string, createdAt:number, path?:string}} JournalHeader */
export const JOURNAL_VERSION = 2;
export const JOURNAL_FORMAT = "mono-harness";
export const JOURNAL_KINDS = Object.freeze([
  "turn_start", "turn_end", "operation_start", "operation_end", "message",
  "tool_call", "tool_result", "compaction", "interruption", "rewind", "model_change",
  "input_queued", "input_consumed", "owner_binding", "handle_binding", "handle_retired",
]);
