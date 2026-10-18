// Shared structural contract; no host implementation or process runner imports.

/** Exact live MCP connection leased to the app-owned host after a UI tool call. */

/** App-owned registry consumed only by Pi's exact MCP client path. */

export type AgentReplyMcpAppPart = import("@mono-agent/contracts").AgentReplyMcpAppPart;

export type AgentReplyPartFailure = import("@mono-agent/contracts").AgentReplyPartFailure;

export type RuntimeMcpAppConnection = {
  readonly connectionId: string;
  readResource(uri: string): Promise<unknown>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
};

export type RuntimeMcpAppRegistration = {
  readonly runId?: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly title?: string;
  readonly description?: string;
  readonly toolCallId: string;
  readonly resourceUri: string;
  readonly protocolVersion: string;
  readonly toolInput: unknown;
  readonly toolResult: unknown;
  readonly resource: unknown;
  readonly appVisibleTools: readonly string[];
  readonly connection: RuntimeMcpAppConnection;
};

export type RuntimeMcpAppHost = {
  readonly protocolVersions: readonly string[];
  readonly mimeTypes: readonly string[];
  register(input: RuntimeMcpAppRegistration): Promise<{
    readonly part: AgentReplyMcpAppPart | AgentReplyPartFailure;
    readonly retainConnection: boolean;
  }>;
  recordFailure(input: {
    readonly runId?: string;
    readonly serverName: string;
    readonly toolName: string;
    readonly toolCallId: string;
    readonly code: AgentReplyPartFailure["code"];
    readonly message: string;
  }): Promise<AgentReplyPartFailure>;
};
