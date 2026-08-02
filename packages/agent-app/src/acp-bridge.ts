import { randomUUID } from "node:crypto";
import { delimiter, isAbsolute } from "node:path";
import process from "node:process";
import { Readable, Writable } from "node:stream";

import {
  PROTOCOL_VERSION,
  RequestError,
  agent,
  methods,
  ndJsonStream,
  type AgentRequestContext,
  type PromptRequest,
  type PromptResponse,
  type SessionUpdate,
  type ToolKind,
  type Usage,
} from "@agentclientprotocol/sdk";
import type { AgentStreamEvent, AgentToolEnvironment } from "@mono-agent/agent-contracts";
import {
  OperatorClient,
  discoverOperatorAgents,
  type DiscoveredOperatorAgent,
  type OperatorInfo,
} from "@mono-agent/web";

import { monoAgentVersion } from "./cli-help.js";

const FORWARDED_TOOL_ENVIRONMENT_KEYS = [
  "MULTICA_TOKEN",
  "MULTICA_SERVER_URL",
  "MULTICA_DAEMON_PORT",
  "MULTICA_WORKSPACE_ID",
  "MULTICA_AGENT_NAME",
  "MULTICA_AGENT_ID",
  "MULTICA_TASK_ID",
  "MULTICA_TASK_SLOT",
  "MULTICA_AUTOPILOT_RUN_ID",
  "MULTICA_AUTOPILOT_ID",
  "MULTICA_QUICK_CREATE_TASK_ID",
  "MULTICA_QUICK_CREATE_ATTACHMENT_IDS",
] as const;

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BRIDGE_ERROR_CODE = -32000;
const MAX_TOOL_CONTENT_CHARS = 64 * 1024;

export interface RunAcpBridgeOptions {
  readonly sourceId: string;
  readonly requireToolEnvironment?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seams; the CLI uses the process stdio streams. */
  readonly input?: Readable;
  readonly output?: Writable;
  readonly stderr?: Pick<Writable, "write">;
}

interface BridgeTarget {
  readonly discovered: DiscoveredOperatorAgent;
  readonly client: OperatorClient;
  readonly info: OperatorInfo;
}

interface ActiveTurn {
  readonly controller: AbortController;
  readonly client: OperatorClient;
}

export async function runAcpBridge(options: RunAcpBridgeOptions): Promise<number> {
  const env = options.env ?? process.env;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const resolveTarget = async (signal?: AbortSignal): Promise<BridgeTarget> => {
    const discovered = await resolveExactSource(options.sourceId, env);
    const client = new OperatorClient({
      baseUrl: discovered.baseUrl as string,
      ...(discovered.apiKey === undefined ? {} : { apiKey: discovered.apiKey }),
    });
    const info = await client.info(signal);
    if (options.requireToolEnvironment === true && info.supportsToolEnvironment !== true) {
      throw bridgeError(
        "tool_environment_unavailable",
        `mono-agent source '${options.sourceId}' does not advertise request tool environment support.`,
      );
    }
    return { discovered, client, info };
  };

  try {
    await resolveTarget(AbortSignal.timeout(5_000));
  } catch (error) {
    stderr.write(`mono-agent ACP bridge: ${errorMessage(error)}\n`);
    return 1;
  }

  const activeTurns = new Map<string, ActiveTurn>();
  const app = agent({ name: `mono-agent ACP bridge (${options.sourceId})` });

  app.onRequest(methods.agent.initialize, async ({ signal }) => {
    const target = await requestTarget(resolveTarget, signal);
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { resume: {} },
      },
      authMethods: [],
      agentInfo: {
        name: "mono-agent-acp-bridge",
        title: target.info.label ?? options.sourceId,
        version: monoAgentVersion(),
      },
    };
  });

  app.onRequest(methods.agent.session.new, async ({ params, signal }) => {
    rejectUnsupportedSessionInputs(params.mcpServers, params.additionalDirectories);
    await requestTarget(resolveTarget, signal);
    return { sessionId: newSessionId(options.sourceId) };
  });

  app.onRequest(methods.agent.session.load, async ({ params, signal }) => {
    validateSessionId(params.sessionId, options.sourceId);
    rejectUnsupportedSessionInputs(params.mcpServers, params.additionalDirectories);
    await requestTarget(resolveTarget, signal);
    return {};
  });

  app.onRequest(methods.agent.session.resume, async ({ params, signal }) => {
    validateSessionId(params.sessionId, options.sourceId);
    rejectUnsupportedSessionInputs(params.mcpServers ?? [], params.additionalDirectories);
    await requestTarget(resolveTarget, signal);
    return {};
  });

  app.onRequest(methods.agent.session.prompt, async (context) => {
    return await runPrompt(context, {
      sourceId: options.sourceId,
      env,
      resolveTarget,
      activeTurns,
    });
  });

  app.onNotification(methods.agent.session.cancel, async ({ params }) => {
    validateSessionId(params.sessionId, options.sourceId);
    const active = activeTurns.get(params.sessionId);
    if (active === undefined) return;
    active.controller.abort(new Error("ACP client cancelled the session."));
    await active.client.cancel(params.sessionId).catch(() => undefined);
  });

  const stream = ndJsonStream(
    Writable.toWeb(output) as WritableStream<Uint8Array>,
    Readable.toWeb(input) as ReadableStream<Uint8Array>,
  );
  const connection = app.connect(stream);
  await connection.closed;
  for (const [sessionId, active] of activeTurns) {
    active.controller.abort(new Error("ACP connection closed."));
    await active.client.cancel(sessionId).catch(() => undefined);
  }
  return 0;
}

async function runPrompt(
  context: AgentRequestContext<PromptRequest>,
  options: {
    readonly sourceId: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly resolveTarget: (signal?: AbortSignal) => Promise<BridgeTarget>;
    readonly activeTurns: Map<string, ActiveTurn>;
  },
): Promise<PromptResponse> {
  const { params } = context;
  validateSessionId(params.sessionId, options.sourceId);
  const text = textPrompt(params.prompt);
  if (options.activeTurns.has(params.sessionId)) {
    throw bridgeError("session_busy", `ACP session '${params.sessionId}' already has an active turn.`);
  }
  const target = await requestTarget(options.resolveTarget, context.signal);
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const active = { controller, client: target.client };
  options.activeTurns.set(params.sessionId, active);
  let publishedText = "";
  let usage: Usage | undefined;
  const toolNames = new Map<string, string>();
  const messageId = `mono-agent:${String(context.requestId)}`;
  const cancelOperator = (): void => {
    controller.abort(new Error("ACP prompt request was cancelled."));
    void target.client.cancel(params.sessionId).catch(() => undefined);
  };
  context.signal.addEventListener("abort", cancelOperator, { once: true });

  const publishText = async (next: string): Promise<void> => {
    if (next === publishedText) return;
    if (!next.startsWith(publishedText)) {
      await target.client.cancel(params.sessionId).catch(() => undefined);
      controller.abort(new Error("Operator rewrote already-published assistant output."));
      throw bridgeError(
        "non_prefix_rewrite",
        "mono-agent replaced assistant output with a non-prefix rewrite that ACP cannot reconcile safely.",
      );
    }
    const suffix = next.slice(publishedText.length);
    publishedText = next;
    if (suffix.length > 0) {
      await context.client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text: suffix },
        },
      });
    }
  };

  try {
    const result = await target.client.turn({
      conversationId: params.sessionId,
      text,
      attachments: [],
      metadata: {},
      client: "acp",
      ...(target.info.supportsToolEnvironment === true
        ? { toolEnvironment: requestToolEnvironment(options.env) }
        : {}),
      signal,
      onFrame: async (frame) => {
        if (frame.kind === "append") {
          await publishText(`${publishedText}${frame.delta}`);
          return;
        }
        if (frame.kind === "replace") {
          await publishText(frame.text);
          return;
        }
        if (frame.kind === "status" && frame.text.trim().length > 0) {
          await notifyUpdate(context, params.sessionId, {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: frame.text },
          });
          return;
        }
        if (frame.kind === "event") {
          usage = await publishEvent(context, params.sessionId, frame.event, target.info, toolNames, usage);
          const toolName = toolNameFromEvent(frame.event, toolNames);
          if (toolName?.toLowerCase() === "askuser") {
            await target.client.cancel(params.sessionId).catch(() => undefined);
            controller.abort(new Error("AskUser requires an interactive client."));
            throw bridgeError(
              "interaction_required",
              "mono-agent requested AskUser, but the Multica ACP bridge is non-interactive.",
            );
          }
        }
      },
    });
    if (result.finalText !== undefined) await publishText(result.finalText);
    return {
      stopReason: signal.aborted ? "cancelled" : "end_turn",
      ...(usage === undefined ? {} : { usage }),
    };
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (signal.aborted) return { stopReason: "cancelled", ...(usage === undefined ? {} : { usage }) };
    const code = codedErrorCode(error) ?? "operator_turn_failed";
    throw bridgeError(code, `mono-agent operator turn failed: ${errorMessage(error)}`);
  } finally {
    context.signal.removeEventListener("abort", cancelOperator);
    if (options.activeTurns.get(params.sessionId) === active) options.activeTurns.delete(params.sessionId);
  }
}

async function publishEvent(
  context: AgentRequestContext<PromptRequest>,
  sessionId: string,
  event: AgentStreamEvent,
  info: OperatorInfo,
  toolNames: Map<string, string>,
  currentUsage: Usage | undefined,
): Promise<Usage | undefined> {
  if (event.type === "assistant_thought") {
    await notifyUpdate(context, sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: event.text },
    });
    return currentUsage;
  }
  if (event.type === "tool_call_started") {
    toolNames.set(event.id, event.name);
    await notifyUpdate(context, sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: event.id,
      title: event.name,
      name: event.name,
      kind: toolKind(event.name),
      status: "in_progress",
      ...(event.arguments === undefined ? {} : { rawInput: event.arguments }),
    });
    return currentUsage;
  }
  if (event.type === "tool_call_progress") {
    await notifyUpdate(context, sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: event.id,
      ...(event.name === undefined ? {} : { title: event.name, name: event.name }),
      status: "in_progress",
      ...(event.partialResult === undefined ? {} : { rawOutput: event.partialResult }),
    });
    return currentUsage;
  }
  if (event.type === "tool_call_completed") {
    const name = event.name ?? toolNames.get(event.id);
    await notifyUpdate(context, sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: event.id,
      ...(name === undefined ? {} : { title: name, name }),
      status: event.isError === true ? "failed" : "completed",
      ...(event.content === undefined
        ? {}
        : {
            rawOutput: event.content,
            content: [{
              type: "content",
              content: { type: "text", text: boundedToolContent(event.content) },
            }],
          }),
    });
    return currentUsage;
  }
  if (event.type !== "usage_update" || event.tokens === undefined) return currentUsage;
  const tokens = event.tokens;
  const inputTokens = tokens.input + tokens.cacheRead + tokens.cacheCreation;
  const totalTokens = inputTokens + tokens.output;
  const contextWindow = info.model === undefined
    ? undefined
    : info.modelOptions?.[info.model]?.contextWindow;
  await notifyUpdate(context, sessionId, {
    sessionUpdate: "usage_update",
    used: totalTokens,
    size: Math.max(totalTokens, contextWindow ?? 1),
    ...(event.cumulativeUsd === undefined
      ? {}
      : { cost: { amount: event.cumulativeUsd, currency: "USD" } }),
  });
  return {
    totalTokens,
    inputTokens,
    outputTokens: tokens.output,
    cachedReadTokens: tokens.cacheRead,
    cachedWriteTokens: tokens.cacheCreation,
  };
}

async function notifyUpdate(
  context: AgentRequestContext<PromptRequest>,
  sessionId: string,
  update: SessionUpdate,
): Promise<void> {
  await context.client.notify(methods.client.session.update, { sessionId, update });
}

async function resolveExactSource(
  sourceId: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<DiscoveredOperatorAgent> {
  const sources = await discoverOperatorAgents({ env });
  const discovered = sources.find((entry) => entry.source.sourceId === sourceId);
  if (discovered === undefined) {
    throw bridgeError("source_not_found", `No mono-agent operator source named '${sourceId}' is registered.`);
  }
  if (discovered.source.health !== "running") {
    throw bridgeError(
      "source_not_running",
      `mono-agent source '${sourceId}' is ${discovered.source.health}, not running.`,
    );
  }
  if (discovered.baseUrl === undefined) {
    throw bridgeError("operator_unavailable", `mono-agent source '${sourceId}' has no trusted loopback operator endpoint.`);
  }
  return discovered;
}

function requestToolEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): AgentToolEnvironment {
  const values: Record<string, string> = {};
  for (const key of FORWARDED_TOOL_ENVIRONMENT_KEYS) {
    const value = env[key];
    if (value !== undefined) values[key] = value;
  }
  const firstPath = env.PATH?.split(delimiter)[0];
  return {
    schema: 1,
    values,
    ...(firstPath !== undefined && isAbsolute(firstPath) ? { pathPrepend: [firstPath] } : {}),
  };
}

function textPrompt(blocks: PromptRequest["prompt"]): string {
  if (blocks.length === 0) {
    throw RequestError.invalidParams(
      { code: "unsupported_prompt_content" },
      "mono-agent ACP v1 accepts one or more text blocks only.",
    );
  }
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type !== "text") {
      throw RequestError.invalidParams(
        { code: "unsupported_prompt_content" },
        "mono-agent ACP v1 accepts one or more text blocks only.",
      );
    }
    texts.push(block.text);
  }
  return texts.join("\n");
}

function rejectUnsupportedSessionInputs(
  mcpServers: readonly unknown[],
  additionalDirectories: readonly string[] | undefined,
): void {
  if (mcpServers.length > 0) {
    throw RequestError.invalidParams(
      { code: "client_mcp_unsupported" },
      "mono-agent ACP sessions use the selected instance's configured MCP servers; client MCP servers are unsupported.",
    );
  }
  if ((additionalDirectories?.length ?? 0) > 0) {
    throw RequestError.invalidParams(
      { code: "additional_directories_unsupported" },
      "mono-agent ACP sessions use the selected instance's configured workspace and sandbox.",
    );
  }
}

function newSessionId(sourceId: string): string {
  return `acp:${sourceId}:${randomUUID()}`;
}

function validateSessionId(sessionId: string, sourceId: string): void {
  const prefix = `acp:${sourceId}:`;
  if (!sessionId.startsWith(prefix) || !SESSION_UUID.test(sessionId.slice(prefix.length))) {
    throw RequestError.invalidParams(
      { code: "invalid_session_id" },
      `Session does not belong to mono-agent source '${sourceId}'.`,
    );
  }
}

function toolKind(name: string): ToolKind {
  const normalized = name.toLowerCase();
  if (normalized === "read") return "read";
  if (normalized === "write" || normalized === "edit") return "edit";
  if (normalized === "glob" || normalized === "grep" || normalized.includes("search")) return "search";
  if (normalized === "bash" || normalized === "exec") return "execute";
  if (normalized.includes("fetch") || normalized.includes("browser")) return "fetch";
  if (normalized === "agent" || normalized === "askuser") return "think";
  return "other";
}

function toolNameFromEvent(event: AgentStreamEvent, toolNames: Map<string, string>): string | undefined {
  if (event.type !== "tool_call_started" && event.type !== "tool_call_progress" && event.type !== "tool_call_completed") {
    return undefined;
  }
  if (event.name !== undefined) toolNames.set(event.id, event.name);
  return event.name ?? toolNames.get(event.id);
}

function boundedToolContent(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return text.length <= MAX_TOOL_CONTENT_CHARS
    ? text
    : `${text.slice(0, MAX_TOOL_CONTENT_CHARS)}… [truncated]`;
}

async function requestTarget(
  resolveTarget: (signal?: AbortSignal) => Promise<BridgeTarget>,
  signal: AbortSignal,
): Promise<BridgeTarget> {
  try {
    return await resolveTarget(signal);
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw bridgeError(codedErrorCode(error) ?? "operator_unavailable", errorMessage(error));
  }
}

function bridgeError(code: string, message: string): RequestError {
  return new RequestError(BRIDGE_ERROR_CODE, message, { code });
}

function codedErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
