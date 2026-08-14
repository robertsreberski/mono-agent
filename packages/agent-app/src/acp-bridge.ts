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
  type CreateElicitationResponse,
  type ElicitationPropertySchema,
  type PromptRequest,
  type PromptResponse,
  type SessionUpdate,
  type ToolKind,
} from "@agentclientprotocol/sdk";
import type {
  AgentStreamEvent,
  AgentToolEnvironment,
  ChannelAskAnswer,
  ChannelAskQuestion,
  ChannelAskSnapshot,
} from "@mono-agent/agent-contracts";
import {
  OperatorClient,
  discoverAcpBridgeAgents,
  discoverOperatorAgents,
  type AcpBridgeSourceDescriptor,
  type DiscoveredOperatorAgent,
  type OperatorInfo,
} from "@mono-agent/web";

import { agentAppPackageVersion } from "./package-version.js";
import {
  createAcpSessionAuthorization,
  loadAcpSessionAuthorization,
  type AcpSessionAuthorization,
} from "./acp-session-store.js";

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
const ASK_DISCOVERY_TIMEOUT_MS = 2_000;
const ASK_DISCOVERY_INTERVAL_MS = 25;
const CUSTOM_OPTION_ID = "__mono_agent_custom__";
const SENSITIVE_ASK_PATTERN = /\b(?:api[ _-]?key|credential|password|passphrase|private[ _-]?key|secret|token)\b/iu;

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
  readonly descriptor: AcpBridgeSourceDescriptor;
  readonly client: OperatorClient;
  readonly info: OperatorInfo;
  readonly artifactDir: string;
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
    const { discovered, descriptor } = await resolveExactSource(options.sourceId, env);
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
    return { descriptor, client, info, artifactDir: discovered.source.artifactDir };
  };

  try {
    await resolveTarget(AbortSignal.timeout(5_000));
  } catch (error) {
    stderr.write(`mono-agent ACP bridge: ${errorMessage(error)}\n`);
    return 1;
  }

  const activeTurns = new Map<string, ActiveTurn>();
  const sessions = new Set<string>();
  let clientSupportsFormElicitation = false;
  const app = agent({ name: `mono-agent ACP bridge (${options.sourceId})` });

  app.onRequest(methods.agent.initialize, async ({ params, signal }) => {
    clientSupportsFormElicitation = params.clientCapabilities?.elicitation?.form != null;
    const target = await requestTarget(resolveTarget, signal);
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { resume: {} },
      },
      authMethods: [],
      agentInfo: {
        name: "mono-agent-acp-bridge",
        title: target.info.label ?? options.sourceId,
        version: agentAppPackageVersion() ?? "unknown",
      },
      _meta: { "mono-agent": target.descriptor },
    };
  });

  app.onRequest(methods.agent.session.new, async ({ params, signal }) => {
    rejectUnsupportedSessionInputs(params.mcpServers, params.additionalDirectories);
    const target = await requestTarget(resolveTarget, signal);
    const sessionId = newSessionId(options.sourceId);
    await persistSessionAuthorization(target, {
      sessionId,
      sourceId: options.sourceId,
      workspace: target.descriptor.workspace.path,
    });
    sessions.add(sessionId);
    return { sessionId, _meta: sessionResponseMeta(target, sessionId) };
  });

  app.onRequest(methods.agent.session.resume, async ({ params, signal }) => {
    rejectUnsupportedSessionInputs(params.mcpServers, params.additionalDirectories);
    validateSessionId(params.sessionId, options.sourceId);
    const target = await requestTarget(resolveTarget, signal);
    await requireSessionAuthorization(target, params.sessionId, options.sourceId);
    sessions.add(params.sessionId);
    return { _meta: sessionResponseMeta(target, params.sessionId) };
  });

  app.onRequest(methods.agent.session.prompt, async (context) => {
    return await runPrompt(context, {
      sourceId: options.sourceId,
      env,
      resolveTarget,
      activeTurns,
      sessions,
      clientSupportsFormElicitation: () => clientSupportsFormElicitation,
    });
  });

  app.onNotification(methods.agent.session.cancel, async ({ params }) => {
    validateSessionId(params.sessionId, options.sourceId);
    if (!sessions.has(params.sessionId)) return;
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
    readonly sessions: ReadonlySet<string>;
    readonly clientSupportsFormElicitation: () => boolean;
  },
): Promise<PromptResponse> {
  const { params } = context;
  validateSessionId(params.sessionId, options.sourceId);
  if (!options.sessions.has(params.sessionId)) {
    throw RequestError.invalidParams(
      { code: "unknown_session_id" },
      "The ACP session was not created by this bridge connection.",
    );
  }
  const text = promptText(params.prompt);
  if (options.activeTurns.has(params.sessionId)) {
    throw bridgeError("session_busy", `ACP session '${params.sessionId}' already has an active turn.`);
  }
  const target = await requestTarget(options.resolveTarget, context.signal);
  await requireSessionAuthorization(target, params.sessionId, options.sourceId);
  const controller = new AbortController();
  const signal = AbortSignal.any([context.signal, controller.signal]);
  const active = { controller, client: target.client };
  options.activeTurns.set(params.sessionId, active);
  let publishedText = "";
  let interactionStopReason: "refusal" | "cancelled" | undefined;
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
          await publishEvent(context, params.sessionId, frame.event, target.info, toolNames);
          if (
            frame.event.type === "tool_call_started"
            && frame.event.name.toLowerCase() === "askuser"
          ) {
            let action: CreateElicitationResponse["action"];
            try {
              action = await handleAskUser(context, {
                target,
                sessionId: params.sessionId,
                toolCallId: frame.event.id,
                signal,
                clientSupportsFormElicitation: options.clientSupportsFormElicitation(),
              });
            } catch (error) {
              await target.client.cancel(params.sessionId).catch(() => undefined);
              controller.abort(new Error("AskUser ACP interaction failed."));
              throw error;
            }
            if (action !== "accept") {
              interactionStopReason = action === "decline" ? "refusal" : "cancelled";
              await target.client.cancel(params.sessionId).catch(() => undefined);
              controller.abort(new Error(`ACP client ${action}d AskUser.`));
            }
          }
        }
      },
    });
    if (result.finalText !== undefined) await publishText(result.finalText);
    return {
      stopReason: interactionStopReason ?? (signal.aborted ? "cancelled" : "end_turn"),
    };
  } catch (error) {
    if (error instanceof RequestError) throw error;
    if (signal.aborted) {
      return {
        stopReason: interactionStopReason ?? "cancelled",
      };
    }
    const code = codedErrorCode(error) ?? "operator_turn_failed";
    throw bridgeError(code, `mono-agent operator turn failed: ${errorMessage(error)}`);
  } finally {
    context.signal.removeEventListener("abort", cancelOperator);
    if (options.activeTurns.get(params.sessionId) === active) options.activeTurns.delete(params.sessionId);
  }
}

interface AskFormField {
  readonly question: ChannelAskQuestion;
  readonly answerKey: string;
  readonly customKey: string;
  readonly customOptionId: string;
}

async function handleAskUser(
  context: AgentRequestContext<PromptRequest>,
  options: {
    readonly target: BridgeTarget;
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly signal: AbortSignal;
    readonly clientSupportsFormElicitation: boolean;
  },
): Promise<CreateElicitationResponse["action"]> {
  if (!options.clientSupportsFormElicitation || !options.target.info.supportsAskUser) {
    await options.target.client.cancel(options.sessionId).catch(() => undefined);
    throw bridgeError(
      "interaction_required",
      "mono-agent requested AskUser, but this ACP client/source pair does not support form elicitation.",
    );
  }

  const ask = await waitForPendingAsk(options.target.client, options.sessionId, options.signal);
  if (ask === undefined) {
    await options.target.client.cancel(options.sessionId).catch(() => undefined);
    throw bridgeError(
      "interaction_unavailable",
      "mono-agent requested AskUser, but its pending interaction was not available.",
    );
  }
  if (containsSensitiveAsk(ask)) {
    await options.target.client.cancel(options.sessionId).catch(() => undefined);
    throw bridgeError(
      "sensitive_elicitation_unsupported",
      "mono-agent AskUser requested potentially sensitive input; the ACP form bridge refuses secret collection.",
    );
  }

  const form = buildAskForm(ask);
  const response = await context.client.request(methods.client.elicitation.create, {
    mode: "form",
    sessionId: options.sessionId,
    toolCallId: options.toolCallId,
    message: ask.message?.trim() || "mono-agent needs your input to continue.",
    requestedSchema: {
      type: "object",
      properties: form.properties,
      required: form.fields.map((field) => field.answerKey),
    },
  }, { cancellationSignal: options.signal });

  if (response.action === "decline" || response.action === "cancel") return response.action;
  if (response.action !== "accept") {
    throw bridgeError("invalid_elicitation_response", `Unsupported ACP elicitation action '${response.action}'.`);
  }
  const answers = answersFromElicitation(
    response as Extract<CreateElicitationResponse, { action: "accept" }>,
    form.fields,
  );
  const submitted = await options.target.client.submitAsk(
    options.sessionId,
    ask.interactionId,
    answers,
    options.signal,
  );
  if (!submitted.accepted) {
    throw bridgeError(
      "ask_submission_rejected",
      `mono-agent rejected the ACP AskUser response (${submitted.code ?? "unknown"}).`,
    );
  }
  return "accept";
}

async function waitForPendingAsk(
  client: OperatorClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<ChannelAskSnapshot | undefined> {
  const deadline = Date.now() + ASK_DISCOVERY_TIMEOUT_MS;
  for (;;) {
    signal.throwIfAborted();
    const ask = await client.pendingAsk(sessionId, signal);
    if (ask !== undefined) return ask;
    if (Date.now() >= deadline) return undefined;
    await abortableDelay(ASK_DISCOVERY_INTERVAL_MS, signal);
  }
}

function buildAskForm(ask: ChannelAskSnapshot): {
  readonly fields: readonly AskFormField[];
  readonly properties: Readonly<Record<string, ElicitationPropertySchema>>;
} {
  const questions = ask.questions.slice(ask.activeQuestionIndex);
  if (questions.length === 0) {
    throw bridgeError("invalid_ask_snapshot", "mono-agent returned an AskUser interaction with no pending questions.");
  }
  const properties: Record<string, ElicitationPropertySchema> = {};
  const fields = questions.map((question, index): AskFormField => {
    const answerKey = `question_${String(index + 1)}`;
    const customKey = `${answerKey}_other`;
    let customOptionId = CUSTOM_OPTION_ID;
    while (question.options.some((option) => option.id === customOptionId)) customOptionId += "_";
    const options = [
      ...question.options.map((option) => ({
        const: option.id,
        title: option.label,
        ...(option.description.trim().length === 0 ? {} : { description: option.description }),
      })),
      {
        const: customOptionId,
        title: "Other",
        description: `Provide a custom response in “${customKey}”.`,
      },
    ];
    properties[answerKey] = question.multiSelect
      ? {
          type: "array",
          title: question.header,
          description: question.question,
          minItems: 1,
          items: { anyOf: options },
        }
      : {
          type: "string",
          title: question.header,
          description: question.question,
          oneOf: options,
        };
    properties[customKey] = {
      type: "string",
      title: `${question.header} — Other response`,
      description: `Complete only when “Other” is selected for “${answerKey}”.`,
    };
    return { question, answerKey, customKey, customOptionId };
  });
  return { fields, properties };
}

function answersFromElicitation(
  response: Extract<CreateElicitationResponse, { action: "accept" }>,
  fields: readonly AskFormField[],
): readonly ChannelAskAnswer[] {
  const content = response.content;
  if (content === undefined || content === null) {
    throw bridgeError("invalid_elicitation_response", "ACP accepted AskUser without form content.");
  }
  return fields.map((field): ChannelAskAnswer => {
    const raw = content[field.answerKey];
    const selected = field.question.multiSelect
      ? (Array.isArray(raw) && raw.every((value): value is string => typeof value === "string") ? raw : undefined)
      : (typeof raw === "string" ? [raw] : undefined);
    if (selected === undefined || selected.length === 0 || new Set(selected).size !== selected.length) {
      throw bridgeError("invalid_elicitation_response", `ACP form field '${field.answerKey}' is invalid.`);
    }
    const allowed = new Set([
      ...field.question.options.map((option) => option.id),
      field.customOptionId,
    ]);
    if (selected.some((value) => !allowed.has(value))) {
      throw bridgeError("invalid_elicitation_response", `ACP form field '${field.answerKey}' selected an unknown option.`);
    }
    const rawCustom = content[field.customKey];
    if (rawCustom !== undefined && typeof rawCustom !== "string") {
      throw bridgeError("invalid_elicitation_response", `ACP form field '${field.customKey}' must be text.`);
    }
    const customReply = typeof rawCustom === "string" ? rawCustom.trim() : "";
    const usesCustom = selected.includes(field.customOptionId);
    if (usesCustom !== (customReply.length > 0)) {
      throw bridgeError(
        "invalid_elicitation_response",
        `ACP form fields '${field.answerKey}' and '${field.customKey}' disagree about the custom response.`,
      );
    }
    return {
      questionId: field.question.id,
      selectedOptionIds: selected.filter((value) => value !== field.customOptionId),
      ...(customReply.length === 0 ? {} : { customReply }),
    };
  });
}

function containsSensitiveAsk(ask: ChannelAskSnapshot): boolean {
  return [
    ask.message ?? "",
    ...ask.questions.flatMap((question) => [
      question.header,
      question.question,
      ...question.options.flatMap((option) => [option.label, option.description]),
    ]),
  ].some((value) => SENSITIVE_ASK_PATTERN.test(value));
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolveDelay, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function publishEvent(
  context: AgentRequestContext<PromptRequest>,
  sessionId: string,
  event: AgentStreamEvent,
  info: OperatorInfo,
  toolNames: Map<string, string>,
): Promise<void> {
  if (event.type === "assistant_thought") {
    await notifyUpdate(context, sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: event.text },
    });
    return;
  }
  if (event.type === "tool_call_started") {
    toolNames.set(event.id, event.name);
    await notifyUpdate(context, sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: event.id,
      title: event.name,
      kind: toolKind(event.name),
      status: "in_progress",
      ...(event.arguments === undefined ? {} : { rawInput: event.arguments }),
    });
    return;
  }
  if (event.type === "tool_call_progress") {
    await notifyUpdate(context, sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: event.id,
      ...(event.name === undefined ? {} : { title: event.name }),
      status: "in_progress",
      ...(event.partialResult === undefined ? {} : { rawOutput: event.partialResult }),
    });
    return;
  }
  if (event.type === "tool_call_completed") {
    const name = event.name ?? toolNames.get(event.id);
    await notifyUpdate(context, sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: event.id,
      ...(name === undefined ? {} : { title: name }),
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
    return;
  }
  if (event.type !== "usage_update" || event.tokens === undefined) return;
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
): Promise<{
  readonly discovered: DiscoveredOperatorAgent;
  readonly descriptor: AcpBridgeSourceDescriptor;
}> {
  const [sources, discovery] = await Promise.all([
    discoverOperatorAgents({ env }),
    discoverAcpBridgeAgents({ env }),
  ]);
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
  const descriptor = discovery.sources.find((entry) => entry.sourceId === sourceId);
  if (descriptor === undefined) {
    throw bridgeError("bridge_metadata_unavailable", `mono-agent source '${sourceId}' has no ACP compatibility metadata.`);
  }
  if (!descriptor.compatible) {
    throw bridgeError(
      "bridge_version_unsupported",
      `mono-agent source '${sourceId}' does not provide a compatible ACP bridge (reported bridge ${String(descriptor.bridgeVersion)}, protocol ${String(descriptor.protocolVersion)}).`,
    );
  }
  return { discovered, descriptor };
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

function promptText(blocks: PromptRequest["prompt"]): string {
  if (blocks.length === 0) {
    throw RequestError.invalidParams(
      { code: "unsupported_prompt_content" },
      "mono-agent ACP v1 accepts one or more text or resource-link blocks.",
    );
  }
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      texts.push(block.text);
      continue;
    }
    if (block.type === "resource_link") {
      texts.push([
        "[ACP resource link]",
        JSON.stringify({
          name: block.name,
          uri: block.uri,
          ...(block.title === undefined || block.title === null ? {} : { title: block.title }),
          ...(block.description === undefined || block.description === null
            ? {}
            : { description: block.description }),
          ...(block.mimeType === undefined || block.mimeType === null ? {} : { mimeType: block.mimeType }),
          ...(block.size === undefined || block.size === null ? {} : { size: block.size }),
        }),
      ].join("\n"));
      continue;
    }
    {
      throw RequestError.invalidParams(
        { code: "unsupported_prompt_content" },
        "mono-agent ACP v1 accepts text and resource-link blocks; embedded resources and media are unsupported.",
      );
    }
  }
  return texts.join("\n");
}

function rejectUnsupportedSessionInputs(
  mcpServers: readonly unknown[] | undefined,
  additionalDirectories: readonly string[] | undefined,
): void {
  if ((mcpServers?.length ?? 0) > 0) {
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

async function persistSessionAuthorization(
  target: BridgeTarget,
  input: Omit<AcpSessionAuthorization, "schema" | "createdAt">,
): Promise<void> {
  try {
    await createAcpSessionAuthorization(target.artifactDir, input);
  } catch {
    throw bridgeError(
      "session_persistence_failed",
      "mono-agent could not persist the durable ACP session authorization.",
    );
  }
}

async function requireSessionAuthorization(
  target: BridgeTarget,
  sessionId: string,
  sourceId: string,
): Promise<AcpSessionAuthorization> {
  let record: AcpSessionAuthorization | undefined;
  try {
    record = await loadAcpSessionAuthorization(target.artifactDir, sessionId);
  } catch {
    throw bridgeError(
      "session_authorization_corrupt",
      "The durable ACP session authorization is corrupt or unsafe.",
    );
  }
  if (record === undefined) {
    throw RequestError.invalidParams(
      { code: "unknown_session_id" },
      "The ACP session is not authorized for this mono-agent source.",
    );
  }
  if (
    record.sourceId !== sourceId
    || record.workspace !== target.descriptor.workspace.path
  ) {
    throw RequestError.invalidParams(
      { code: "session_authorization_mismatch" },
      "The ACP session authorization does not match this mono-agent source and workspace.",
    );
  }
  return record;
}

function sessionResponseMeta(target: BridgeTarget, sessionId: string): Record<string, unknown> {
  return {
    agentSessionId: sessionId,
    "mono-agent": target.descriptor,
  };
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
