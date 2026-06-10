import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AgentMessageStream,
  AgentRequestBase,
  AgentResponder,
  AgentResponse,
} from "@mono-agent/agent-contracts";
import type { AgentHarness, AgentHarnessResponse } from "@mono-agent/agent-harness";
import { createJsonlRunRecorder } from "@mono-agent/observability";
import type { RuntimeEventLike, RuntimeResultLike, RunSummary } from "@mono-agent/observability";
import { createTrajectoryMatchEvaluator } from "agentevals";
import type {
  EvaluatorResult,
  FlexibleChatCompletionMessage,
  ToolArgsMatchMode,
  ToolArgsMatchOverrides,
} from "agentevals";

export type AgentEvalStatus = "passed" | "failed" | "skipped";
export type AgentEvalTrajectoryMode = "strict" | "unordered" | "subset" | "superset";

export interface AgentEvalScenario {
  readonly id: string;
  readonly name?: string;
  readonly input: string;
  readonly target: AgentEvalTarget;
  readonly assertions?: AgentEvalAssertions;
  readonly events?: readonly RuntimeEventLike[];
  readonly requiresLive?: boolean;
  readonly conversationId?: string;
  readonly tags?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

export type AgentEvalTarget =
  | { readonly responder: AgentResponder<AgentRequestBase, AgentMessageStream, AgentResponse>; readonly harness?: never }
  | { readonly harness: AgentHarness; readonly responder?: never };

export interface AgentEvalAssertions {
  readonly finalText?: AgentEvalFinalTextAssertion;
  readonly trajectory?: AgentEvalTrajectoryAssertion;
  readonly requiredTools?: readonly string[];
  readonly forbiddenTools?: readonly string[];
  readonly maxCostUsd?: number;
  readonly maxTurns?: number;
  readonly maxDurationMs?: number;
  readonly judge?: AgentEvalJudge;
}

export interface AgentEvalFinalTextAssertion {
  readonly includes?: readonly string[];
  readonly matches?: readonly RegExp[];
}

export interface AgentEvalTrajectoryAssertion {
  readonly expectedToolCalls: readonly AgentEvalExpectedToolCall[];
  readonly mode?: AgentEvalTrajectoryMode;
  readonly toolArgsMatchMode?: ToolArgsMatchMode;
  readonly toolArgsMatchOverrides?: ToolArgsMatchOverrides;
}

export interface AgentEvalExpectedToolCall {
  readonly id?: string;
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
}

export interface AgentEvalJudgeInput {
  readonly scenario: AgentEvalScenario;
  readonly finalText?: string;
  readonly events: readonly RuntimeEventLike[];
  readonly trajectory: readonly FlexibleChatCompletionMessage[];
  readonly toolCalls: readonly AgentEvalToolCall[];
  readonly metadata?: Record<string, unknown>;
}

export type AgentEvalJudge = (input: AgentEvalJudgeInput) => Promise<AgentEvalCheck> | AgentEvalCheck;

export interface AgentEvalRunOptions {
  readonly artifactRoot?: string;
  readonly suiteId?: string;
  readonly live?: boolean;
  readonly createRunId?: () => string;
  readonly clock?: () => number;
  readonly abortSignal?: AbortSignal;
}

export interface AgentEvalSuite {
  readonly id: string;
  readonly name?: string;
  readonly scenarios: readonly AgentEvalScenario[];
}

export interface AgentEvalSuiteResult {
  readonly suiteId: string;
  readonly status: AgentEvalStatus;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly results: readonly AgentEvalResult[];
}

export interface AgentEvalResult {
  readonly scenarioId: string;
  readonly name: string;
  readonly status: AgentEvalStatus;
  readonly checks: readonly AgentEvalCheck[];
  readonly finalText?: string;
  readonly events: readonly RuntimeEventLike[];
  readonly trajectory: readonly FlexibleChatCompletionMessage[];
  readonly toolCalls: readonly AgentEvalToolCall[];
  readonly metadata?: Record<string, unknown>;
  readonly failure?: AgentEvalFailure;
  readonly artifacts: AgentEvalArtifacts;
}

export interface AgentEvalCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly message?: string;
  readonly details?: unknown;
}

export interface AgentEvalToolCall {
  readonly id?: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface AgentEvalArtifacts {
  readonly artifactDir?: string;
  readonly eventsPath?: string;
  readonly summaryPath?: string;
  readonly resultPath?: string;
  readonly reportPath?: string;
}

export interface AgentEvalFailure {
  readonly kind: string;
  readonly message: string;
  readonly details?: unknown;
}

interface AgentEvalExecution {
  readonly finalText?: string;
  readonly events: readonly RuntimeEventLike[];
  readonly metadata?: Record<string, unknown>;
  readonly failure?: AgentEvalFailure;
}

export function defineAgentEvalScenario(scenario: AgentEvalScenario): AgentEvalScenario {
  assertScenario(scenario);
  return scenario;
}

export async function runAgentEvalSuite(
  suite: AgentEvalSuite,
  options: AgentEvalRunOptions = {},
): Promise<AgentEvalSuiteResult> {
  if (typeof suite.id !== "string" || suite.id.trim().length === 0) {
    throw new TypeError("suite.id must be a non-empty string.");
  }
  const results: AgentEvalResult[] = [];
  for (const scenario of suite.scenarios) {
    results.push(await runAgentEvalScenario(scenario, { ...options, suiteId: options.suiteId ?? suite.id }));
  }
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  return {
    suiteId: suite.id,
    status: failed > 0 ? "failed" : skipped === results.length && results.length > 0 ? "skipped" : "passed",
    passed,
    failed,
    skipped,
    results,
  };
}

export async function runAgentEvalScenario(
  scenario: AgentEvalScenario,
  options: AgentEvalRunOptions = {},
): Promise<AgentEvalResult> {
  assertScenario(scenario);
  const live = options.live ?? process.env.MONO_AGENT_EVAL_LIVE === "1";
  const scenarioName = scenario.name ?? scenario.id;
  const suiteId = options.suiteId ?? "default";
  const runId = options.createRunId?.() ?? createRunId();
  const artifactDir = options.artifactRoot === undefined
    ? undefined
    : join(options.artifactRoot, safePathSegment(suiteId), safePathSegment(scenario.id));

  if (scenario.requiresLive === true && !live) {
    return {
      scenarioId: scenario.id,
      name: scenarioName,
      status: "skipped",
      checks: [{
        name: "live execution",
        passed: false,
        message: "Scenario requires live execution. Set MONO_AGENT_EVAL_LIVE=1 or pass live: true.",
      }],
      events: [],
      trajectory: [],
      toolCalls: [],
      artifacts: artifactDir === undefined ? {} : { artifactDir },
    };
  }

  const execution = await executeScenario(scenario, {
    suiteId,
    runId,
    abortSignal: options.abortSignal ?? new AbortController().signal,
  });
  const trajectory = runtimeEventsToTrajectoryMessages(execution.events);
  const toolCalls = extractTrajectoryToolCalls(trajectory);
  const checks = await evaluateChecks(scenario, {
    events: execution.events,
    trajectory,
    toolCalls,
    ...(execution.finalText === undefined ? {} : { finalText: execution.finalText }),
    ...(execution.metadata === undefined ? {} : { metadata: execution.metadata }),
    ...(execution.failure === undefined ? {} : { failure: execution.failure }),
  });
  const status: AgentEvalStatus = checks.every((check) => check.passed) ? "passed" : "failed";
  const artifacts = await writeArtifacts({
    scenario,
    scenarioName,
    suiteId,
    runId,
    ...(artifactDir === undefined ? {} : { artifactDir }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    result: {
      scenarioId: scenario.id,
      name: scenarioName,
      status,
      checks,
      ...(execution.finalText === undefined ? {} : { finalText: execution.finalText }),
      events: execution.events,
      trajectory,
      toolCalls,
      ...(execution.metadata === undefined ? {} : { metadata: execution.metadata }),
      ...(execution.failure === undefined ? {} : { failure: execution.failure }),
      artifacts: artifactDir === undefined ? {} : { artifactDir },
    },
  });

  return {
    scenarioId: scenario.id,
    name: scenarioName,
    status,
    checks,
    ...(execution.finalText === undefined ? {} : { finalText: execution.finalText }),
    events: execution.events,
    trajectory,
    toolCalls,
    ...(execution.metadata === undefined ? {} : { metadata: execution.metadata }),
    ...(execution.failure === undefined ? {} : { failure: execution.failure }),
    artifacts,
  };
}

export function runtimeEventsToTrajectoryMessages(
  events: readonly RuntimeEventLike[],
): readonly FlexibleChatCompletionMessage[] {
  const messages: FlexibleChatCompletionMessage[] = [];
  for (const event of events) {
    const rawMessage = recordField(event, "message");
    if (rawMessage === undefined) {
      continue;
    }
    const role = stringField(rawMessage, "role") ?? stringField(event, "type");
    const content = arrayField(rawMessage, "content");
    if (content === undefined || typeof role !== "string") {
      continue;
    }

    const toolCalls = content
      .map((part) => toolCallFromContentPart(part))
      .filter((part): part is NonNullable<ReturnType<typeof toolCallFromContentPart>> => part !== undefined);
    if (toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: toolCalls,
      });
    }

    for (const part of content) {
      const toolResult = toolResultFromContentPart(part);
      if (toolResult !== undefined) {
        messages.push(toolResult);
      }
      const text = textFromContentPart(part);
      if (text !== undefined) {
        messages.push({
          role: role === "user" ? "user" : "assistant",
          content: text,
        });
      }
    }
  }
  return messages;
}

export function toolCallsToTrajectoryMessages(
  toolCalls: readonly AgentEvalExpectedToolCall[],
): readonly FlexibleChatCompletionMessage[] {
  return toolCalls.map((toolCall, index) => ({
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: toolCall.id ?? `expected-${index + 1}`,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments ?? {}),
        },
      },
    ],
  }));
}

export function extractTrajectoryToolCalls(
  trajectory: readonly FlexibleChatCompletionMessage[],
): readonly AgentEvalToolCall[] {
  const calls: AgentEvalToolCall[] = [];
  for (const message of trajectory) {
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const rawCall of toolCalls) {
      if (!isRecord(rawCall)) {
        continue;
      }
      const fn = recordField(rawCall, "function");
      const name = stringField(fn, "name") ?? stringField(rawCall, "name");
      if (name === undefined) {
        continue;
      }
      const id = stringField(rawCall, "id");
      const rawArgs = stringField(fn, "arguments");
      calls.push({
        ...(id === undefined ? {} : { id }),
        name,
        arguments: parseToolArguments(rawArgs),
      });
    }
  }
  return calls;
}

async function executeScenario(
  scenario: AgentEvalScenario,
  input: { readonly suiteId: string; readonly runId: string; readonly abortSignal: AbortSignal },
): Promise<AgentEvalExecution> {
  const events: RuntimeEventLike[] = [...(scenario.events ?? [])];
  try {
    if ("harness" in scenario.target) {
      const response = await scenario.target.harness.run({
        conversationId: scenario.conversationId ?? scenario.id,
        userMessage: scenario.input,
        abortSignal: input.abortSignal,
        ...(scenario.metadata === undefined ? {} : { metadata: scenario.metadata }),
        onEvent: (event) => {
          events.push(event);
        },
      });
      return executionFromHarnessResponse(response, events);
    }

    const chunks: string[] = [];
    const response = await scenario.target.responder.respond(
      {
        conversationId: scenario.conversationId ?? scenario.id,
        text: scenario.input,
        abortSignal: input.abortSignal,
        metadata: {
          ...(scenario.metadata ?? {}),
          eval: {
            scenarioId: scenario.id,
            suiteId: input.suiteId,
            runId: input.runId,
          },
        },
      },
      {
        append: async (delta) => {
          chunks.push(delta);
        },
      },
    );
    const finalText = normalizeText(response.text) ?? normalizeText(chunks.join(""));
    return {
      ...(finalText === undefined ? {} : { finalText }),
      events,
      ...(response.metadata === undefined ? {} : { metadata: response.metadata }),
    };
  } catch (error) {
    return {
      events,
      failure: {
        kind: error instanceof Error && error.name.length > 0 ? error.name : "exception",
        message: error instanceof Error ? error.message : String(error),
        details: errorToDetails(error),
      },
    };
  }
}

function executionFromHarnessResponse(
  response: AgentHarnessResponse,
  events: readonly RuntimeEventLike[],
): AgentEvalExecution {
  const finalText = normalizeText(response.text);
  return {
    ...(finalText === undefined ? {} : { finalText }),
    events,
    metadata: response.metadata as unknown as Record<string, unknown>,
    ...(response.failure === undefined
      ? {}
      : {
          failure: {
            kind: response.failure.kind,
            message: response.failure.message,
            ...(response.failure.details === undefined ? {} : { details: response.failure.details }),
          },
        }),
  };
}

async function evaluateChecks(
  scenario: AgentEvalScenario,
  execution: {
    readonly finalText?: string;
    readonly events: readonly RuntimeEventLike[];
    readonly trajectory: readonly FlexibleChatCompletionMessage[];
    readonly toolCalls: readonly AgentEvalToolCall[];
    readonly metadata?: Record<string, unknown>;
    readonly failure?: AgentEvalFailure;
  },
): Promise<readonly AgentEvalCheck[]> {
  const checks: AgentEvalCheck[] = [
    execution.failure === undefined
      ? { name: "agent status", passed: true }
      : {
          name: "agent status",
          passed: false,
          message: execution.failure.message,
          details: execution.failure,
        },
  ];
  const assertions = scenario.assertions;
  if (assertions === undefined) {
    return checks;
  }
  if (assertions.finalText?.includes !== undefined) {
    checks.push(checkFinalTextIncludes(execution.finalText, assertions.finalText.includes));
  }
  if (assertions.finalText?.matches !== undefined) {
    checks.push(checkFinalTextMatches(execution.finalText, assertions.finalText.matches));
  }
  if (assertions.requiredTools !== undefined) {
    checks.push(checkRequiredTools(execution.toolCalls, assertions.requiredTools));
  }
  if (assertions.forbiddenTools !== undefined) {
    checks.push(checkForbiddenTools(execution.toolCalls, assertions.forbiddenTools));
  }
  if (assertions.maxCostUsd !== undefined) {
    checks.push(checkMaxCost(execution.metadata, assertions.maxCostUsd));
  }
  if (assertions.maxTurns !== undefined) {
    checks.push(checkMaxTurns(execution.metadata, assertions.maxTurns));
  }
  if (assertions.maxDurationMs !== undefined) {
    checks.push(checkMaxDuration(execution.metadata, assertions.maxDurationMs));
  }
  if (assertions.trajectory !== undefined) {
    checks.push(await checkTrajectory(execution.trajectory, assertions.trajectory));
  }
  if (assertions.judge !== undefined) {
    checks.push(await assertions.judge({
      scenario,
      events: execution.events,
      trajectory: execution.trajectory,
      toolCalls: execution.toolCalls,
      ...(execution.finalText === undefined ? {} : { finalText: execution.finalText }),
      ...(execution.metadata === undefined ? {} : { metadata: execution.metadata }),
    }));
  }
  return checks;
}

function checkFinalTextIncludes(finalText: string | undefined, expected: readonly string[]): AgentEvalCheck {
  const missing = expected.filter((value) => !(finalText ?? "").includes(value));
  return {
    name: "final text includes",
    passed: missing.length === 0,
    ...(missing.length === 0 ? {} : { message: `Missing expected text: ${missing.join(", ")}.` }),
  };
}

function checkFinalTextMatches(finalText: string | undefined, expected: readonly RegExp[]): AgentEvalCheck {
  const missing = expected.filter((pattern) => !pattern.test(finalText ?? ""));
  return {
    name: "final text matches",
    passed: missing.length === 0,
    ...(missing.length === 0 ? {} : { message: `Missing expected pattern: ${missing.map((pattern) => pattern.toString()).join(", ")}.` }),
  };
}

function checkRequiredTools(
  actual: readonly AgentEvalToolCall[],
  required: readonly string[],
): AgentEvalCheck {
  const actualNames = new Set(actual.map((call) => call.name));
  const missing = required.filter((tool) => !actualNames.has(tool));
  return {
    name: "required tools",
    passed: missing.length === 0,
    ...(missing.length === 0 ? {} : { message: `Missing required tools: ${missing.join(", ")}.` }),
  };
}

function checkForbiddenTools(
  actual: readonly AgentEvalToolCall[],
  forbidden: readonly string[],
): AgentEvalCheck {
  const forbiddenSet = new Set(forbidden);
  const used = actual.map((call) => call.name).filter((tool) => forbiddenSet.has(tool));
  return {
    name: "forbidden tools",
    passed: used.length === 0,
    ...(used.length === 0 ? {} : { message: `Used forbidden tools: ${[...new Set(used)].join(", ")}.` }),
  };
}

function checkMaxCost(metadata: Record<string, unknown> | undefined, maxCostUsd: number): AgentEvalCheck {
  const cost = numericPath(metadata, ["runtime", "cost", "totalUsd"])
    ?? numericPath(metadata, ["summary", "cost", "totalUsd"])
    ?? numericPath(metadata, ["cost", "totalUsd"]);
  return {
    name: "max cost",
    passed: cost === undefined || cost <= maxCostUsd,
    ...(cost === undefined || cost <= maxCostUsd ? {} : { message: `Cost ${cost} exceeded max ${maxCostUsd}.` }),
    ...(cost === undefined ? {} : { details: { cost, maxCostUsd } }),
  };
}

function checkMaxTurns(metadata: Record<string, unknown> | undefined, maxTurns: number): AgentEvalCheck {
  const turns = numericPath(metadata, ["runtime", "numTurns"]) ?? numericPath(metadata, ["numTurns"]);
  return {
    name: "max turns",
    passed: turns === undefined || turns <= maxTurns,
    ...(turns === undefined || turns <= maxTurns ? {} : { message: `Turns ${turns} exceeded max ${maxTurns}.` }),
    ...(turns === undefined ? {} : { details: { turns, maxTurns } }),
  };
}

function checkMaxDuration(metadata: Record<string, unknown> | undefined, maxDurationMs: number): AgentEvalCheck {
  const durationMs = numericPath(metadata, ["runtime", "durationMs"])
    ?? numericPath(metadata, ["summary", "durationMs"])
    ?? numericPath(metadata, ["durationMs"]);
  return {
    name: "max duration",
    passed: durationMs === undefined || durationMs <= maxDurationMs,
    ...(durationMs === undefined || durationMs <= maxDurationMs ? {} : { message: `Duration ${durationMs}ms exceeded max ${maxDurationMs}ms.` }),
    ...(durationMs === undefined ? {} : { details: { durationMs, maxDurationMs } }),
  };
}

async function checkTrajectory(
  actual: readonly FlexibleChatCompletionMessage[],
  assertion: AgentEvalTrajectoryAssertion,
): Promise<AgentEvalCheck> {
  const reference = toolCallsToTrajectoryMessages(assertion.expectedToolCalls);
  const evaluator = createTrajectoryMatchEvaluator({
    trajectoryMatchMode: assertion.mode ?? "strict",
    toolArgsMatchMode: assertion.toolArgsMatchMode ?? "exact",
    ...(assertion.toolArgsMatchOverrides === undefined ? {} : { toolArgsMatchOverrides: assertion.toolArgsMatchOverrides }),
  });
  const result = await evaluator({
    outputs: [...actual],
    referenceOutputs: [...reference],
  });
  const passed = evaluatorPassed(result);
  return {
    name: "trajectory match",
    passed,
    ...(passed ? {} : { message: evaluatorMessage(result), details: result }),
  };
}

async function writeArtifacts(input: {
  readonly scenario: AgentEvalScenario;
  readonly scenarioName: string;
  readonly suiteId: string;
  readonly runId: string;
  readonly artifactDir?: string;
  readonly clock?: () => number;
  readonly result: Omit<AgentEvalResult, "artifacts"> & { readonly artifacts: AgentEvalArtifacts };
}): Promise<AgentEvalArtifacts> {
  if (input.artifactDir === undefined) {
    return {};
  }
  await mkdir(input.artifactDir, { recursive: true });
  const recorder = createJsonlRunRecorder({
    runId: input.runId,
    conversationId: input.scenario.conversationId ?? input.scenario.id,
    artifactDir: input.artifactDir,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  await recorder.start?.();
  for (const event of input.result.events) {
    recorder.onEvent(event);
  }
  const summary = await recorder.finish(runtimeResultFromEvalResult(input.result));
  const [eventsPath, summaryPath] = summary.artifactPaths;
  const resultPath = join(input.artifactDir, "eval-result.json");
  const reportPath = join(input.artifactDir, "report.md");
  const artifacts: AgentEvalArtifacts = {
    artifactDir: input.artifactDir,
    ...(eventsPath === undefined ? {} : { eventsPath }),
    ...(summaryPath === undefined ? {} : { summaryPath }),
    resultPath,
    reportPath,
  };
  await writeFile(resultPath, `${JSON.stringify({ ...input.result, artifacts }, null, 2)}\n`, "utf8");
  await writeFile(reportPath, reportMarkdown({ ...input.result, artifacts }, input.scenarioName, summary), "utf8");
  return artifacts;
}

function runtimeResultFromEvalResult(
  result: Omit<AgentEvalResult, "artifacts"> & { readonly artifacts: AgentEvalArtifacts },
): RuntimeResultLike {
  const runtime = recordPath(result.metadata, ["runtime"]);
  const summary = recordPath(result.metadata, ["summary"]);
  const durationMs = numberOrUndefined(runtime?.durationMs ?? summary?.durationMs);
  return {
    ...(result.status === "failed" ? { failureKind: result.failure?.kind ?? "eval_failed" } : {}),
    ...(runtime?.usage === undefined ? {} : { usage: runtime.usage }),
    ...(runtime?.cost === undefined && summary?.cost === undefined ? {} : { cost: runtime?.cost ?? summary?.cost }),
    ...(durationMs === undefined ? {} : { durationMs }),
    diagnostics: {
      evalStatus: result.status,
      failedChecks: result.checks.filter((check) => !check.passed).map((check) => check.name),
    },
  };
}

function reportMarkdown(result: AgentEvalResult, name: string, summary: RunSummary): string {
  const lines = [
    `# ${name}`,
    "",
    `Status: ${result.status}`,
    `Scenario: ${result.scenarioId}`,
    `Run: ${summary.runId}`,
    "",
    "## Checks",
    "",
    ...result.checks.map((check) => `- ${check.passed ? "PASS" : "FAIL"} ${check.name}${check.message === undefined ? "" : ` - ${check.message}`}`),
    "",
    "## Final Text",
    "",
    result.finalText ?? "",
    "",
    "## Tool Calls",
    "",
    ...(
      result.toolCalls.length === 0
        ? ["- None"]
        : result.toolCalls.map((call) => `- ${call.name} ${JSON.stringify(call.arguments)}`)
    ),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function toolCallFromContentPart(part: unknown):
  | {
      readonly id: string;
      readonly type: "function";
      readonly function: { readonly name: string; readonly arguments: string };
    }
  | undefined {
  if (!isRecord(part) || part.type !== "tool_use") {
    return undefined;
  }
  const name = stringField(part, "name");
  if (name === undefined) {
    return undefined;
  }
  return {
    id: stringField(part, "id") ?? name,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(recordField(part, "input") ?? {}),
    },
  };
}

function toolResultFromContentPart(part: unknown): FlexibleChatCompletionMessage | undefined {
  if (!isRecord(part) || part.type !== "tool_result") {
    return undefined;
  }
  return {
    role: "tool",
    tool_call_id: stringField(part, "tool_use_id") ?? stringField(part, "tool_call_id") ?? "",
    content: stringifyContent(part.content),
  };
}

function textFromContentPart(part: unknown): string | undefined {
  if (!isRecord(part) || part.type !== "text" && part.type !== "thinking") {
    return undefined;
  }
  return stringField(part, "text");
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value ?? "");
}

function parseToolArguments(value: string | undefined): Record<string, unknown> {
  if (value === undefined || value.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function evaluatorPassed(result: EvaluatorResult): boolean {
  if (typeof result.score === "boolean") {
    return result.score;
  }
  if (typeof result.score === "number") {
    return result.score >= 1;
  }
  return false;
}

function evaluatorMessage(result: EvaluatorResult): string {
  if (typeof result.comment === "string" && result.comment.length > 0) {
    return result.comment;
  }
  return "Trajectory did not match expected tool calls.";
}

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numericPath(value: unknown, path: readonly string[]): number | undefined {
  return numberOrUndefined(valueAtPath(value, path));
}

function recordPath(value: unknown, path: readonly string[]): Record<string, unknown> | undefined {
  const found = valueAtPath(value, path);
  return isRecord(found) ? found : undefined;
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const found = value[field];
  return typeof found === "string" ? found : undefined;
}

function recordField(value: unknown, field: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const found = value[field];
  return isRecord(found) ? found : undefined;
}

function arrayField(value: unknown, field: string): readonly unknown[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const found = value[field];
  return Array.isArray(found) ? found : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createRunId(): string {
  return `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safePathSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "eval";
}

function assertScenario(scenario: AgentEvalScenario): void {
  if (typeof scenario.id !== "string" || scenario.id.trim().length === 0) {
    throw new TypeError("scenario.id must be a non-empty string.");
  }
  if (typeof scenario.input !== "string" || scenario.input.trim().length === 0) {
    throw new TypeError("scenario.input must be a non-empty string.");
  }
  if (!isRecord(scenario.target)) {
    throw new TypeError("scenario.target is required.");
  }
  const hasResponder = "responder" in scenario.target && typeof scenario.target.responder?.respond === "function";
  const hasHarness = "harness" in scenario.target && typeof scenario.target.harness?.run === "function";
  if (hasResponder === hasHarness) {
    throw new TypeError("scenario.target must provide exactly one responder or harness.");
  }
}

function errorToDetails(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return error;
}
