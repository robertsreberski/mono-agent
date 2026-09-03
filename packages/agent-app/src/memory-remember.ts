import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolPolicyInput } from "@mono-agent/agent-harness";
import { containsVisibleSensitiveText } from "@mono-agent/observability";
import * as z from "zod/v4";

import { createRequestScopedMcpRuntimeExtension } from "./request-scoped-mcp.js";
import type { RuntimeOptionsExtension } from "./runtime-option-extensions.js";
import {
  containsKnownSecretValue,
  containsSecretLikeValue,
  containsUnsafeReviewControl,
  knownEnvironmentSecretValues,
} from "./untrusted-text.js";

export const MEMORY_REMEMBER_MCP_SERVER_NAME = "mono-agent-memory-write";
export const REMEMBER_TOOL_NAME = "Remember";
export const REMEMBER_MAX_CHARACTERS = 500;

/**
 * The write half of the memory surface, kept separate from `MemoryRecall`.
 *
 * `remember` alone is not enough to gate on: a read-only store still has the
 * method and would only ever throw, so the capability must be answered
 * affirmatively. Backends without a deterministic write path (Supermemory)
 * simply never implement `supportsRemember` and are excluded.
 */
export interface RememberCapableStore {
  remember(
    conversationId: string,
    text: string,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<{
    readonly id: string;
    readonly source: string;
    readonly text: string;
    readonly duplicate: boolean;
  }>;
  supportsRemember(): boolean;
}

/** Fail-closed: only a store that affirms the capability may expose the tool. */
export function isRememberCapableStore(store: unknown): store is RememberCapableStore {
  const value = store as Partial<RememberCapableStore> | undefined;
  return value !== undefined
    && typeof value.remember === "function"
    && value.supportsRemember?.() === true;
}

type RememberPolicy = Pick<ToolPolicyInput, "allowedTools" | "disallowedTools">;

const REMEMBER_POLICY_NAMES = [
  REMEMBER_TOOL_NAME,
  `mcp__${MEMORY_REMEMBER_MCP_SERVER_NAME}__${REMEMBER_TOOL_NAME}`,
  `mcp__${MEMORY_REMEMBER_MCP_SERVER_NAME}__*`,
] as const;

/**
 * Durable memory writes follow the normal app-owned allow/deny boundary.
 *
 * This is deliberately unlike read-only `MemoryRecall`, which is provisioned
 * from `memory.recallTool.enabled` and is not allowlist-gated: an operator must
 * be able to withhold a durable write surface without disabling recall.
 */
export function isRememberToolAllowed(policy: RememberPolicy | undefined): boolean {
  const allowed = policy?.allowedTools ?? [];
  const denied = policy?.disallowedTools ?? [];
  if (denied.includes("*") || REMEMBER_POLICY_NAMES.some((name) => denied.includes(name))) {
    return false;
  }
  return allowed.includes("*") || REMEMBER_POLICY_NAMES.some((name) => allowed.includes(name));
}

const REMEMBER_INPUT = {
  text: z.string().min(1).describe(
    "One self-contained fact to store. Stored as a single line: surrounding and "
    + "internal whitespace is normalized, so write it as one sentence.",
  ),
};

/** Run-artifact filenames the shared visible-text guard treats as private evidence. */
const RUN_ARTIFACT_EVIDENCE = /(?:\.events\.jsonl|\.summary\.json)\b/giu;

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { schema: 1, stored: false, reason: message },
    isError: true as const,
  };
}

/**
 * Reject rather than redact.
 *
 * A redaction would persist a mangled fact and still report success; refusing
 * tells the model the write did not happen and lets it restate the fact without
 * the credential. Every check runs against the EXACT text that would be stored,
 * never the raw argument: normalization can fold compatibility characters into
 * a materially different string, so checking the input first would let a
 * fullwidth token normalize into a real one after the check had passed.
 *
 * This is defense in depth, not a guarantee — see `SECURITY.md`.
 */
function rejectionReason(storedText: string, env: Record<string, string | undefined>): string | undefined {
  if (containsUnsafeReviewControl(storedText)) {
    return "That text contains terminal or bidi control characters and was not stored.";
  }
  if (containsKnownSecretValue(storedText, knownEnvironmentSecretValues(env))) {
    return "That text contains a configured credential value and was not stored. "
      + "Restate the fact without the secret.";
  }
  // `containsVisibleSensitiveText` also treats run-artifact filenames as private
  // evidence. That is right for a run projection and wrong for a memory fact, so
  // neutralize those tokens before asking: "The release writes build.summary.json"
  // is an ordinary sentence, not a credential.
  const credentialProbe = storedText.replace(RUN_ARTIFACT_EVIDENCE, ".artifact");
  if (containsSecretLikeValue(storedText) || containsVisibleSensitiveText(credentialProbe)) {
    return "That text looks like it carries a credential and was not stored. "
      + "Restate the fact without the secret.";
  }
  return undefined;
}

/**
 * Whether the canonical bullet is durable and only its index projection failed.
 *
 * Matched structurally rather than by importing the error class so this module
 * keeps its lazy boundary to the memory backend.
 */
function isPartialRememberWrite(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { readonly canonicalWritten?: unknown }).canonicalWritten === true;
}

/** Register the single `Remember` tool against one conversation's writable store. */
export function createMemoryRememberServer(
  store: RememberCapableStore,
  conversationId: string,
  env: Record<string, string | undefined> = process.env,
): McpServer {
  const server = new McpServer({ name: MEMORY_REMEMBER_MCP_SERVER_NAME, version: "1.0.0" });
  server.registerTool(
    REMEMBER_TOOL_NAME,
    {
      title: "Remember a fact",
      description: "Durably save one specific fact to long-term memory so it survives this conversation. "
        + "Use it when the user asks you to remember something, or states a lasting preference, decision, or "
        + "fact worth keeping; use MemoryRecall to read memory back. Write one self-contained sentence that "
        + "still makes sense months from now, with no pronouns or references that depend on the current "
        + "conversation; it is stored as a single normalized line. Do not use it for transient task state, for "
        + "anything the user asked you to forget, or for credentials, tokens, or other secrets — secret-shaped "
        + "text is rejected. Memory is append-only: you cannot edit or delete what you store.",
      inputSchema: REMEMBER_INPUT,
    },
    async (args, extra) => {
      // Loaded lazily: this module is imported by the composition root, and an
      // agent with no memory configured must not pay for the SQLite/BuJo stack.
      // Sharing the store's own transform is what keeps the credential checks
      // below running against exactly the text that will be persisted.
      const { normalizeMemoryText } = await import("@mono-agent/memory/bujo");
      const storedText = normalizeMemoryText(args.text);
      if (storedText.length === 0) {
        return toolError("That text is empty once normalized and was not stored.");
      }
      if (storedText.length > REMEMBER_MAX_CHARACTERS) {
        return toolError(
          `That fact is ${storedText.length} characters once normalized, over the `
          + `${REMEMBER_MAX_CHARACTERS}-character limit. Store a shorter, self-contained sentence.`,
        );
      }
      const rejected = rejectionReason(storedText, env);
      if (rejected !== undefined) return toolError(rejected);
      // Cancellation must reach the store: without it a cancelled call still
      // commits, so the client sees an abort while the fact lands anyway.
      const abortSignal = (extra as { readonly signal?: AbortSignal } | undefined)?.signal;
      if (abortSignal?.aborted === true) {
        return toolError("That request was cancelled before the fact was stored.");
      }
      try {
        const result = await store.remember(conversationId, storedText, {
          ...(abortSignal === undefined ? {} : { abortSignal }),
        });
        const text = result.duplicate
          ? `Already remembered: "${result.text}"`
          : `Remembered: "${result.text}"`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: {
            schema: 1,
            id: result.id,
            source: result.source,
            storedText: result.text,
            duplicate: result.duplicate,
          },
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // A canonical write that lost only its index is PARTIAL, not failed.
        // Saying "not stored" here would invite the model to rephrase and
        // create a second memory for one fact; retrying the identical text is
        // idempotent and completes the projection instead.
        if (isPartialRememberWrite(error)) {
          return {
            content: [{
              type: "text" as const,
              text: `That fact is already durable but its index did not finish: ${reason} `
                + "Retry the exact same wording to complete it; do not reword it.",
            }],
            structuredContent: { schema: 1, stored: true, indexed: false, storedText, reason },
            isError: true as const,
          };
        }
        // A failed durable write must never read as success.
        return toolError(`Memory could not store that fact: ${reason}`);
      }
    },
  );
  return server;
}

export interface MemoryRememberRuntimeExtensionOptions {
  /** Best-effort diagnostic when the loopback tool endpoint cannot start. */
  readonly onUnavailable?: (error: unknown) => void;
  readonly env?: Record<string, string | undefined>;
}

/** Expose `Remember` for each request, bound to that request's conversation. */
export function createMemoryRememberRuntimeExtension(
  store: RememberCapableStore,
  options: MemoryRememberRuntimeExtensionOptions = {},
): RuntimeOptionsExtension {
  const extension = createRequestScopedMcpRuntimeExtension({
    serverName: MEMORY_REMEMBER_MCP_SERVER_NAME,
    startingMessage: "Memory write tool is starting",
    createServer: (input) => createMemoryRememberServer(
      store,
      input.request.conversationId,
      options.env ?? process.env,
    ),
    ...(options.onUnavailable === undefined ? {} : { onUnavailable: options.onUnavailable }),
  });
  // Re-check the capability per request rather than trusting composition alone:
  // a store that cannot accept a write must never advertise the endpoint, and a
  // read-only store still structurally has `remember`.
  return async (input) => {
    if (!isRememberCapableStore(store)) {
      return { runtimeOptions: {}, cleanup: async () => {} };
    }
    return await extension(input);
  };
}
