import type { HistoryMessage } from "@worklab-ai/context";

import type { ConversationHistoryStore, InMemoryHistoryStoreOptions } from "./types.js";

export class InMemoryConversationHistoryStore implements ConversationHistoryStore {
  private readonly maxMessages: number;
  private readonly conversations = new Map<string, HistoryMessage[]>();

  constructor(options: InMemoryHistoryStoreOptions = {}) {
    const maxMessages = options.maxMessages ?? 12;
    if (!Number.isInteger(maxMessages) || maxMessages < 0) {
      throw new TypeError("maxMessages must be a non-negative integer.");
    }
    this.maxMessages = maxMessages;
  }

  async load(conversationId: string): Promise<readonly HistoryMessage[]> {
    return [...(this.conversations.get(normalizeConversationId(conversationId)) ?? [])];
  }

  async append(conversationId: string, messages: readonly HistoryMessage[]): Promise<void> {
    const key = normalizeConversationId(conversationId);
    const existing = this.conversations.get(key) ?? [];
    const next = [...existing, ...messages].slice(this.maxMessages === 0 ? existing.length + messages.length : -this.maxMessages);
    this.conversations.set(key, next);
  }
}

export function createInMemoryHistoryStore(options: InMemoryHistoryStoreOptions = {}): InMemoryConversationHistoryStore {
  return new InMemoryConversationHistoryStore(options);
}

function normalizeConversationId(conversationId: string): string {
  if (typeof conversationId !== "string" || conversationId.trim().length === 0) {
    throw new TypeError("conversationId must be a non-empty string.");
  }
  return conversationId.trim();
}
