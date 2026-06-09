import { type AgentMessageStream, type AgentRequestBase, type AgentResponder, type AgentResponse } from "@worklab-ai/agent-contracts";
export interface OpenAIApiRequestMetadata {
    readonly requestId: string;
    readonly model: string;
    readonly stream: boolean;
    readonly method: string;
    readonly path: string;
    readonly receivedAt: string;
    readonly remoteAddress?: string;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly parameters: Record<string, unknown>;
}
export interface OpenAIApiChatRequest extends AgentRequestBase {
    readonly conversationId: string;
    readonly text: string;
    readonly abortSignal: AbortSignal;
    readonly metadata: {
        readonly openaiApi: OpenAIApiRequestMetadata;
        readonly [key: string]: unknown;
    };
}
export interface OpenAIApiAdapterLogger {
    debug?(message: string, metadata?: Record<string, unknown>): void;
    info?(message: string, metadata?: Record<string, unknown>): void;
    warn?(message: string, metadata?: Record<string, unknown>): void;
    error?(message: string, metadata?: Record<string, unknown>): void;
}
export interface OpenAIApiAdapterOptions {
    readonly host?: string;
    readonly port?: number;
    readonly basePath?: string;
    readonly allowNonLoopback?: boolean;
    readonly apiKey?: string;
    readonly modelId?: string;
    readonly responder: AgentResponder<OpenAIApiChatRequest, AgentMessageStream, AgentResponse>;
    readonly logger?: OpenAIApiAdapterLogger;
}
export interface OpenAIApiAdapterStartResult {
    readonly url: string;
    readonly baseUrl: string;
    readonly modelsUrl: string;
    readonly chatCompletionsUrl: string;
    readonly host: string;
    readonly port: number;
    stop(): Promise<void>;
}
export type OpenAIApiAdapterErrorCode = "invalid_config" | "missing_required_config" | "unsafe_host" | "start_failed";
export interface OpenAIApiAdapterErrorDetails {
    readonly code?: OpenAIApiAdapterErrorCode;
    readonly reason?: string;
    readonly [key: string]: unknown;
}
export declare class OpenAIApiAdapterError extends Error {
    readonly code: OpenAIApiAdapterErrorCode;
    readonly details: OpenAIApiAdapterErrorDetails;
    constructor(code: OpenAIApiAdapterErrorCode, message: string, details?: OpenAIApiAdapterErrorDetails);
}
export declare function startOpenAIApiAdapter(options: OpenAIApiAdapterOptions): Promise<OpenAIApiAdapterStartResult>;
//# sourceMappingURL=server.d.ts.map