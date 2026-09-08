import {
  AGENT_CONTEXT_IMPORT_MAX_CONVERSATION_ID_BYTES,
  AGENT_CONTEXT_IMPORT_MAX_IDEMPOTENCY_KEY_BYTES,
  AGENT_CONTEXT_IMPORT_MAX_TEXT_BYTES,
  type AgentContextImportRequest,
  type AgentContextImportResult,
} from "@mono-agent/agent-contracts";

import type { AgentHarnessOptions, ConversationHistoryContextImport } from "../types.js";

export function eligibleContextImport(options: AgentHarnessOptions): ConversationHistoryContextImport | undefined {
  const support = options.historyStore?.contextImport;
  if (
    support?.version !== 1
    || support.maxTextBytes !== AGENT_CONTEXT_IMPORT_MAX_TEXT_BYTES
    || typeof support.beginExclusiveTurn !== "function"
    || typeof support.prepareImport !== "function"
  ) return undefined;
  if (support.providerState === "absent") {
    return options.piSessionsRoot === undefined ? support : undefined;
  }
  return support.providerState === "retire-fail-closed"
    && options.historyStore?.providerSessionRetirement === "fail-closed"
    ? support
    : undefined;
}

export async function importHarnessContext(
  options: AgentHarnessOptions,
  conversationId: string,
  request: AgentContextImportRequest,
  timestamp: string,
): Promise<AgentContextImportResult> {
  const support = eligibleContextImport(options);
  if (support === undefined) throw new Error("The configured agent harness does not support canonical context import.");
  validateUtf8String(conversationId, "conversationId", AGENT_CONTEXT_IMPORT_MAX_CONVERSATION_ID_BYTES, false);
  validateUtf8String(request?.text, "text", AGENT_CONTEXT_IMPORT_MAX_TEXT_BYTES, false);
  validateUtf8String(request?.idempotencyKey, "idempotencyKey", AGENT_CONTEXT_IMPORT_MAX_IDEMPOTENCY_KEY_BYTES, false);
  const prepared = await support.prepareImport(conversationId, {
    text: request.text,
    idempotencyKey: request.idempotencyKey,
    timestamp,
  });
  if (prepared.result.status !== "appended") {
    if (prepared.append !== undefined) {
      await prepared.append.abort().catch(() => undefined);
      throw new Error("A context import store returned staging state for a non-appended result.");
    }
    return prepared.result;
  }
  if (prepared.append === undefined) throw new Error("A context import store did not prepare the appended result.");
  try {
    await prepared.append.commit();
    return prepared.result;
  } catch (error) {
    await prepared.append.abort().catch(() => undefined);
    throw error;
  }
}

function validateUtf8String(value: unknown, name: string, maxBytes: number, allowEmpty: boolean): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${name} must be ${allowEmpty ? "a string" : "a non-empty string"}.`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new TypeError(`${name} must not exceed ${maxBytes} UTF-8 bytes.`);
  }
  if (name !== "text" && value.includes("\0")) throw new TypeError(`${name} must not contain NUL bytes.`);
}
