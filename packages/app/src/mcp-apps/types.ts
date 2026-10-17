import { MCP_APP_RESOURCE_MIME_TYPE, MCP_APP_SUPPORTED_VERSIONS } from "@mono-agent/contracts";

export interface McpAppManifest {
  readonly schema: 1;
  readonly invocationId: string;
  readonly connectionId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly deliveryConversationId?: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly resourceUri: string;
  readonly protocolVersion: (typeof MCP_APP_SUPPORTED_VERSIONS)[number];
  readonly mediaType: typeof MCP_APP_RESOURCE_MIME_TYPE;
  readonly title?: string;
  readonly description?: string;
  readonly appVisibleTools: readonly string[];
  readonly appVisibleResources: readonly string[];
  readonly resourceMetadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface McpAppState {
  readonly toolInput: unknown;
  readonly toolResult: unknown;
}
