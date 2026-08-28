import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentHarnessRuntimeOptionsInput } from "@mono-agent/agent-harness";
import { describe, expect, it } from "vitest";

import {
  createSetConversationTitleRuntimeExtension,
  isSetConversationTitleToolAllowed,
  SET_CONVERSATION_TITLE_MCP_SERVER_NAME,
  SET_CONVERSATION_TITLE_TOOL_NAME,
} from "../conversation-title.js";

function request(overrides: {
  readonly conversationId?: string;
  readonly metadata?: Record<string, unknown>;
} = {}): AgentHarnessRuntimeOptionsInput {
  return {
    request: {
      conversationId: overrides.conversationId ?? "web:thread-one",
      userMessage: "Discuss title behavior",
      abortSignal: new AbortController().signal,
      metadata: overrides.metadata ?? {
        source: "web",
        web: {
          threadId: "thread-one",
          turnId: "turn-one",
          conversationTitle: { schema: 1, writable: true },
        },
      },
    },
    runId: "run-one",
    context: {} as never,
  };
}

describe("isSetConversationTitleToolAllowed", () => {
  it.each([
    SET_CONVERSATION_TITLE_TOOL_NAME,
    `mcp__${SET_CONVERSATION_TITLE_MCP_SERVER_NAME}__${SET_CONVERSATION_TITLE_TOOL_NAME}`,
    `mcp__${SET_CONVERSATION_TITLE_MCP_SERVER_NAME}__*`,
    "*",
  ])("accepts the supported policy spelling %s", (name) => {
    expect(isSetConversationTitleToolAllowed({ allowedTools: [name], disallowedTools: [] })).toBe(true);
  });

  it("keeps deny and restrictive policies authoritative", () => {
    expect(isSetConversationTitleToolAllowed({
      allowedTools: ["*"],
      disallowedTools: [SET_CONVERSATION_TITLE_TOOL_NAME],
    })).toBe(false);
    expect(isSetConversationTitleToolAllowed({ allowedTools: ["Read"], disallowedTools: [] })).toBe(false);
    expect(isSetConversationTitleToolAllowed(undefined)).toBe(false);
  });
});

describe("SetConversationTitle request-scoped tool", () => {
  it("normalizes one bounded semantic title and returns its structured host signal", async () => {
    const extension = await createSetConversationTitleRuntimeExtension()(request());
    const servers = extension.runtimeOptions?.mcpServers as Record<string, unknown> | undefined;
    const spec = servers?.[SET_CONVERSATION_TITLE_MCP_SERVER_NAME] as { readonly url?: unknown } | undefined;
    if (typeof spec?.url !== "string") throw new Error("SetConversationTitle MCP server was not registered.");
    const client = new Client({ name: "conversation-title-test", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(spec.url)) as never);
      const listed = await client.listTools();
      expect(listed.tools).toEqual([
        expect.objectContaining({
          name: SET_CONVERSATION_TITLE_TOOL_NAME,
          description: expect.stringContaining("materially changes topic"),
        }),
      ]);
      const result = await client.callTool({
        name: SET_CONVERSATION_TITLE_TOOL_NAME,
        arguments: { title: "  Web console\n conversation titles  " },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ schema: 1, title: "Web console conversation titles" });

      const invalid = await client.callTool({
        name: SET_CONVERSATION_TITLE_TOOL_NAME,
        arguments: { title: "x".repeat(81) },
      });
      expect(invalid.isError).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await extension.cleanup?.();
    }
  });

  it.each([
    ["non-web source", { source: "tui", web: { threadId: "thread-one", turnId: "turn-one", conversationTitle: { schema: 1, writable: true } } }],
    ["missing capability", { source: "web", web: { threadId: "thread-one", turnId: "turn-one" } }],
    ["trigger-managed turn", { source: "web", web: { threadId: "thread-one", turnId: "turn-one", trigger: "job", conversationTitle: { schema: 1, writable: true } } }],
  ])("does not register for a %s", async (_label, metadata) => {
    const extension = await createSetConversationTitleRuntimeExtension()(request({ metadata }));
    expect(extension.runtimeOptions).toEqual({});
    await extension.cleanup?.();
  });

  it("rejects a capability whose thread does not own the conversation", async () => {
    const extension = await createSetConversationTitleRuntimeExtension()(request({ conversationId: "web:other-thread" }));
    expect(extension.runtimeOptions).toEqual({});
    await extension.cleanup?.();
  });
});
