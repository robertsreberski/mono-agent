// The `Agent` built-in: delegate a self-contained task to a subagent that runs
// independently and reports back.
//
// Deliberately NOT built with `createBuiltinTool`. That wrapper normalizes
// filesystem params (meaningless here), tracks file writes (N/A), and — the
// real hazard — rethrows any result text matching /^Error:/ as a tool failure,
// which would reclassify a subagent whose *final answer* happens to start with
// "Error:" and throw away its activity log. This mirrors
// `createStructuredOutputTool` instead, building the pi tool object directly;
// the shared approval gate and bloat guard still wrap it, because those are
// applied to the whole tool array in `getPiBuiltinTools`.

// @ts-check

import { createCountingSemaphore } from "./shared/semaphore.js";

/** @typedef {import('../../ai/types.js').RuntimeSubagentDefinition} RuntimeSubagentDefinition */
/** @typedef {import('../../ai/types.js').RuntimeSubagentsOptions} RuntimeSubagentsOptions */

export const GENERAL_PURPOSE_SUBAGENT = "general-purpose";

/**
 * Read-only by default. A profile that needs a shell or writes must say so in
 * config: widening a subagent's reach is an operator decision, not one the
 * model makes at call time.
 */
export const DEFAULT_SUBAGENT_TOOLS = Object.freeze(["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);

/**
 * Never available to a subagent, whatever a profile asks for. `Agent` is the
 * third independent recursion lock; the rest would let a helper hijack the
 * user's conversation or post to a channel on the main agent's behalf.
 */
export const SUBAGENT_HARD_DENY = Object.freeze([
  "Agent",
  "AskUser",
  "SlackSendMessage",
  "TelegramSendMessage",
  "TelegramSendFile",
]);

const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_MAX_PER_TURN = 20;
const DEFAULT_MAX_TURNS = 20;
const DEFAULT_TIMEOUT_MS = 300_000;

// Kept an order of magnitude under the bloat guard's 256 KiB default: when that
// guard fires it replaces the whole payload with an artifact pointer, which
// would discard the subagent's answer entirely.
const ANSWER_MAX_CHARS = 12_000;
const LOG_MAX_LINES = 60;
const LOG_HEAD_LINES = 25;
const LOG_TAIL_LINES = 30;
const LOG_LINE_MAX_CHARS = 160;
const RESULT_MAX_BYTES = 24_000;

const DESCRIPTION_BASE = `Delegate a self-contained task to a subagent that works independently and reports back.

Use this when a task is (a) well-scoped, (b) likely to need many tool calls or a lot of reading you do not want in your own context, and (c) answerable with a written summary. Good: "find every call site of X and summarize the patterns", "read these 12 files and report which handle Y". Bad: anything needing back-and-forth, anything where you need raw output rather than a summary, or a task you could finish in one or two tool calls yourself.

Hard constraints, plan around them:
- The subagent starts with an EMPTY context. It cannot see this conversation, the user's message, or your earlier tool results. Put everything it needs in \`prompt\`.
- It cannot ask you or the user anything. One shot.
- It cannot spawn subagents of its own.
- You get its final written answer plus a compact log of what it did. You do NOT get its raw tool output.
- It is read-only by default and cannot send messages to any channel.

State exactly what you want back ("return a bullet list of file:line and a one-line description each"), or you will get an unusable ramble.`;

/**
 * @param {RuntimeSubagentsOptions} subagents
 * @param {ReadonlyArray<RuntimeSubagentDefinition>} definitions
 * @returns {string}
 */
function toolDescription(subagents, definitions) {
  const maxConcurrent = positiveInt(subagents.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  const parallel = `\n\nIssue several Agent calls in ONE message to run them in parallel (up to ${maxConcurrent} at a time). Subagents run concurrently and independently.`;
  const named = definitions.length === 0
    ? ""
    : `\n\nAvailable subagents:\n${definitions.map((d) => `- ${d.name}: ${d.description}`).join("\n")}\n- ${GENERAL_PURPOSE_SUBAGENT}: read-only researcher inheriting the main model. Used when \`name\` is omitted.`;
  return `${DESCRIPTION_BASE}${parallel}${named}`;
}

/** @param {*} value @param {number} fallback @returns {number} */
function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Build the `Agent` tool, or null when subagents are unavailable for this run.
 *
 * @param {RuntimeSubagentsOptions|null|undefined} subagents
 * @param {{model?: *, executionMode?: string, cwd?: string, parentRunId?: string, onEvent?: (event: *) => void}} [context]
 * @returns {*|null}
 */
export function createAgentTool(subagents, context = {}) {
  if (!subagents || typeof subagents.run !== "function") return null;
  // Structural recursion lock #1: a subagent's own tool set never contains
  // `Agent`, regardless of what any host-supplied `run` forwards.
  if (positiveInt(subagents.depth, 0) > 0 || Number(subagents.depth || 0) > 0) return null;

  const definitions = Array.isArray(subagents.definitions) ? subagents.definitions.filter(Boolean) : [];
  const maxConcurrent = positiveInt(subagents.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  const maxPerTurn = positiveInt(subagents.maxPerTurn, DEFAULT_MAX_PER_TURN);
  const names = definitions.map((definition) => definition.name);

  // Turn-scoped: getPiBuiltinTools runs once per turn, so these counters reset
  // naturally and cannot leak budget across turns.
  const slots = createCountingSemaphore(maxConcurrent);
  const turnState = { total: 0, warnedQueued: false };

  const parameters = {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        minLength: 1,
        description: "The complete, self-contained task. The subagent sees NONE of this conversation — restate all needed context, file paths, and the exact shape of the answer you want back.",
      },
      ...(names.length === 0 ? {} : {
        name: {
          type: "string",
          enum: [...names, GENERAL_PURPOSE_SUBAGENT],
          description: `Which subagent profile to use. Omit for ${GENERAL_PURPOSE_SUBAGENT}.`,
        },
      }),
      description: {
        type: "string",
        maxLength: 80,
        description: "3-6 word label for this task, shown in the activity log.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  };

  return {
    name: "Agent",
    label: "Agent",
    description: toolDescription(subagents, definitions),
    parameters,
    // MUST stay undefined. pi-agent-core's agent loop makes the ENTIRE batch
    // sequential when any tool in it declares executionMode "sequential"
    // (dist/agent-loop.js:289), which would serialize every parallel Agent call.
    executionMode: undefined,
    /**
     * @param {string} toolCallId
     * @param {{prompt: string, name?: string, description?: string}} params
     * @param {AbortSignal} [signal]
     */
    async execute(toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("tool execution aborted");

      const profile = resolveProfile(definitions, params?.name);
      if (profile === null) {
        const available = [...names, GENERAL_PURPOSE_SUBAGENT].join(", ");
        throw new Error(`Error: unknown subagent "${params?.name}". Available: ${available}.`);
      }

      // The concurrency cap bounds resources, not cost: a delegation loop can
      // fire calls serially across turns without ever contending the semaphore.
      // This counter is the actual runaway guard.
      if (turnState.total >= maxPerTurn) {
        throw new Error(
          `Error: subagent budget for this turn is exhausted (${maxPerTurn} of ${maxPerTurn} used). Do the remaining work yourself.`,
        );
      }
      turnState.total += 1;
      const callIndex = turnState.total;

      if (slots.inFlight() >= maxConcurrent && !turnState.warnedQueued) {
        turnState.warnedQueued = true;
        context.onEvent?.({
          type: "runtime_warning",
          warning_kind: "subagent_queued",
          message: `Subagent concurrency limit (${maxConcurrent}) reached; further Agent calls queue.`,
        });
      }

      const releaseSlot = await slots.acquire(signal);
      // The timeout starts only AFTER a slot is held. Started earlier, a call
      // queued behind five long-running siblings would time out having never run.
      const timeoutMs = positiveInt(profile.timeoutMs, positiveInt(subagents.timeoutMs, DEFAULT_TIMEOUT_MS));
      const maxTurns = positiveInt(profile.maxTurns, positiveInt(subagents.maxTurns, DEFAULT_MAX_TURNS));

      const controller = new AbortController();
      let timedOut = false;
      const onParentAbort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", onParentAbort, { once: true });
      const timer = setTimeout(() => {
        if (controller.signal.aborted) return;
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      const collector = createActivityCollector({
        callId: toolCallId,
        profileName: profile.name,
        callIndex,
        ...(params.description === undefined ? {} : { label: params.description }),
        ...(context.onEvent === undefined ? {} : { emit: context.onEvent }),
      });
      collector.started();
      const startedAt = Date.now();
      /** @type {*} */
      let result;
      /** @type {unknown} */
      let thrown;
      try {
        result = await subagents.run({
          systemPrompt: profile.systemPrompt,
          prompt: params.prompt,
          definition: profile,
          ...(context.model === undefined ? {} : { model: context.model }),
          ...(context.executionMode === undefined ? {} : { executionMode: context.executionMode }),
          ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
          ...(context.parentRunId === undefined ? {} : { parentRunId: context.parentRunId }),
          abortSignal: controller.signal,
          maxTurns,
          callId: toolCallId,
          callIndex,
          depth: positiveInt(subagents.depth, 0) + 1,
          onEvent: collector.observe,
        });
      } catch (error) {
        thrown = error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onParentAbort);
        releaseSlot();
      }

      // The parent turn being cancelled is not a subagent outcome — surface it
      // as an aborted tool call the way every other built-in does.
      if (signal?.aborted && !timedOut) throw new Error("tool execution aborted");

      const durationMs = Date.now() - startedAt;
      const outcome = classifyOutcome({ result, thrown, timedOut });
      collector.finished({ status: outcome.status, durationMs });
      const text = formatSubagentResult({
        profileName: profile.name,
        label: params.description,
        outcome,
        durationMs,
        activity: collector.entries(),
      });
      return {
        content: [{ type: "text", text }],
        details: {
          tool: "Agent",
          subagent: { name: profile.name, callIndex, status: outcome.status, toolCalls: collector.entries().length },
        },
        ...(outcome.status === "ok" ? {} : { error: true }),
      };
    },
  };
}

/**
 * @param {ReadonlyArray<RuntimeSubagentDefinition>} definitions
 * @param {string|undefined} name
 * @returns {RuntimeSubagentDefinition|null}
 */
function resolveProfile(definitions, name) {
  if (name === undefined || name === null || name === GENERAL_PURPOSE_SUBAGENT) {
    return {
      name: GENERAL_PURPOSE_SUBAGENT,
      description: "Read-only researcher inheriting the main model.",
      systemPrompt: "You are a focused research subagent. Work only from the task you were given — you cannot see the parent conversation and cannot ask anyone anything. Investigate with the tools you have, then finish with a written answer in exactly the shape the task requested. Cite file:line where relevant. Never modify files.",
      allowedTools: DEFAULT_SUBAGENT_TOOLS,
    };
  }
  return definitions.find((definition) => definition.name === name) ?? null;
}

/** Hard cap on any single forwarded payload, so the operator wire's binary-search reducer never has to run. */
const WIRE_CONTENT_MAX_CHARS = 2_000;

/**
 * Translates the child's raw provider events into (a) a bounded per-tool-call
 * log for the parent's context and (b) `subagent_activity` events on the
 * parent's operator stream.
 *
 * Tool ids are namespaced `agent:<callId>:<toolUseId>` because both the TUI
 * (`toolPanels`) and the web store (`upsertToolCall`) key tool state FLATLY on
 * the id — two subagents running Read concurrently would otherwise collapse
 * into a single panel.
 *
 * The child's assistant text and thinking are deliberately dropped: the
 * responder pipes `assistantTextFromRuntimeEvent` straight into the parent's
 * answer body, so forwarding them would splice a subagent's prose into the
 * main agent's reply. Its text reaches the parent through the tool result.
 *
 * @param {{callId: string, profileName: string, callIndex: number, label?: string, emit?: (event: *) => void}} options
 */
function createActivityCollector({ callId, profileName, callIndex, label, emit }) {
  /** @type {Map<string, {name: string, args: unknown, startedAt: number, ms?: number}>} */
  const open = new Map();
  /** @type {Array<{name: string, args: unknown, ms?: number, isError: boolean}>} */
  const done = [];
  const subagent = { id: callId, name: profileName, callIndex, ...(label === undefined ? {} : { label }) };

  /** @param {*} event */
  const publish = (event) => {
    if (emit === undefined) return;
    try {
      emit({ type: "subagent_activity", subagent, ...event });
    } catch {
      // Operator telemetry is additive; never fail a subagent over it.
    }
  };

  return {
    entries: () => done,
    /** Lifecycle bookends so the subagent is visible before its first tool call. */
    started() {
      publish({
        phase: "agent_started",
        id: `agent:${callId}`,
        name: `Agent(${profileName})`,
        arguments: { name: profileName, ...(label === undefined ? {} : { description: label }) },
      });
    },
    /** @param {{status: string, durationMs: number}} outcome */
    finished({ status, durationMs }) {
      publish({
        phase: "agent_completed",
        id: `agent:${callId}`,
        name: `Agent(${profileName})`,
        isError: status !== "ok",
        executionMs: durationMs,
        content: `${status} · ${done.length} tool call${done.length === 1 ? "" : "s"}`,
      });
    },
    /** @param {*} event */
    observe(event) {
      const type = event?.type;
      if (type === "assistant") {
        const block = event.message?.content?.[0];
        if (block?.type === "tool_use" && typeof block.id === "string") {
          const name = String(block.name ?? "?");
          open.set(block.id, { name, args: block.input, startedAt: Date.now() });
          publish({
            phase: "started",
            id: `agent:${callId}:${block.id}`,
            name: `${profileName}▸${name}`,
            arguments: block.input,
          });
        }
        return;
      }
      if (type === "tool_timing" && typeof event.tool_use_id === "string") {
        const entry = open.get(event.tool_use_id);
        if (entry && typeof event.execution_ms === "number") entry.ms = event.execution_ms;
        return;
      }
      if (type === "user") {
        const block = event.message?.content?.[0];
        if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
          const entry = open.get(block.tool_use_id);
          open.delete(block.tool_use_id);
          const ms = entry?.ms ?? (entry ? Date.now() - entry.startedAt : undefined);
          const isError = block.is_error === true;
          done.push({ name: entry?.name ?? "?", args: entry?.args, ms, isError });
          publish({
            phase: "completed",
            id: `agent:${callId}:${block.tool_use_id}`,
            name: `${profileName}▸${entry?.name ?? "?"}`,
            isError,
            ...(ms === undefined ? {} : { executionMs: ms }),
            ...(summarizeForWire(block.content) === undefined ? {} : { content: summarizeForWire(block.content) }),
          });
        }
        return;
      }
      // Child warnings are worth surfacing; everything else (context usage,
      // partial tool output, cost) stays inside the subagent for now.
      if (type === "runtime_warning" && emit !== undefined) {
        try {
          emit({ ...event, subagentId: callId });
        } catch {
          // additive
        }
      }
    },
  };
}

/** @param {unknown} value */
function summarizeForWire(value) {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : safeJson(value);
  return text.length <= WIRE_CONTENT_MAX_CHARS ? text : `${text.slice(0, WIRE_CONTENT_MAX_CHARS)}…`;
}

/** @param {unknown} value */
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * @param {{result: *, thrown: unknown, timedOut: boolean}} input
 * @returns {{status: string, answer: string, reason?: string}}
 */
function classifyOutcome({ result, thrown, timedOut }) {
  if (timedOut) {
    return { status: "timeout", answer: typeof result?.text === "string" ? result.text : "", reason: "the subagent exceeded its time budget" };
  }
  if (thrown !== undefined) {
    return { status: "failed", answer: "", reason: thrown instanceof Error ? thrown.message : String(thrown) };
  }
  if (result?.cancelled === true) {
    return { status: "cancelled", answer: typeof result.text === "string" ? result.text : "", reason: "the subagent run was cancelled" };
  }
  if (result?.error || result?.failureKind) {
    const kind = result.failureKind ? `${result.failureKind}: ` : "";
    return { status: "failed", answer: typeof result.text === "string" ? result.text : "", reason: `${kind}${String(result.error ?? "")}`.trim() };
  }
  const answer = typeof result?.text === "string" ? result.text.trim() : "";
  if (answer.length === 0) {
    return { status: "empty", answer: "", reason: "the subagent produced no final answer" };
  }
  return { status: "ok", answer };
}

/**
 * A subagent that fails, times out, or says nothing still returns its activity
 * log: that log is the most useful artifact of a failed delegation, and a
 * thrown tool error would discard it.
 *
 * @param {{profileName: string, label?: string, outcome: {status: string, answer: string, reason?: string}, durationMs: number, activity: ReadonlyArray<{name: string, args: unknown, ms?: number, isError: boolean}>}} input
 * @returns {string}
 */
export function formatSubagentResult({ profileName, label, outcome, durationMs, activity }) {
  const seconds = (durationMs / 1000).toFixed(1);
  const calls = `${activity.length} tool call${activity.length === 1 ? "" : "s"}`;
  const header = `<subagent: ${profileName}${label ? ` · ${label}` : ""} · ${outcome.status} · ${calls} · ${seconds}s>`;
  const parts = [header];
  if (outcome.reason !== undefined) parts.push(`reason: ${truncate(outcome.reason, 500)}`);
  if (outcome.answer.length > 0) parts.push("", truncate(outcome.answer, ANSWER_MAX_CHARS));
  if (activity.length > 0) parts.push("", "<activity>", ...renderActivity(activity), "</activity>");
  return capBytes(parts.join("\n"), RESULT_MAX_BYTES);
}

/**
 * Head-and-tail elision: the informative parts of a delegation trace are what
 * it opened with and what it concluded with; the middle is usually a read loop.
 * @param {ReadonlyArray<{name: string, args: unknown, ms?: number, isError: boolean}>} activity
 * @returns {string[]}
 */
function renderActivity(activity) {
  const line = (entry, index) => {
    const args = summarizeArgs(entry.name, entry.args);
    const status = entry.isError ? "error" : "ok";
    const ms = entry.ms === undefined ? "" : ` ${formatMs(entry.ms)}`;
    return truncate(`${index + 1}. ${entry.name}${args ? ` ${args}` : ""} → ${status}${ms}`, LOG_LINE_MAX_CHARS);
  };
  if (activity.length <= LOG_MAX_LINES) return activity.map(line);
  const head = activity.slice(0, LOG_HEAD_LINES).map(line);
  const tail = activity.slice(activity.length - LOG_TAIL_LINES).map((entry, offset) =>
    line(entry, activity.length - LOG_TAIL_LINES + offset));
  const elided = activity.length - LOG_HEAD_LINES - LOG_TAIL_LINES;
  return [...head, `… ${elided} call${elided === 1 ? "" : "s"} elided …`, ...tail];
}

/** @param {number} ms */
function formatMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/**
 * Tool-aware one-liners keep the log readable where a generic JSON dump would
 * blow the per-line budget on a single Write payload.
 * @param {string} name
 * @param {unknown} args
 * @returns {string}
 */
function summarizeArgs(name, args) {
  if (args === null || typeof args !== "object") return "";
  const record = /** @type {Record<string, unknown>} */ (args);
  const pick = (key) => (typeof record[key] === "string" ? String(record[key]) : undefined);
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return pick("file_path") ?? "";
    case "Bash":
    case "Exec":
      return quote(pick("command") ?? pick("executable") ?? "");
    case "Grep":
      return [pick("pattern") && `pattern=${quote(String(pick("pattern")))}`, pick("path") && `path=${pick("path")}`]
        .filter(Boolean).join(" ");
    case "Glob":
      return pick("pattern") ?? "";
    case "WebFetch":
      return pick("url") ?? "";
    case "WebSearch":
      return quote(pick("query") ?? "");
    default: {
      const scalars = Object.entries(record)
        .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        .slice(0, 2)
        .map(([key, value]) => `${key}=${typeof value === "string" ? quote(value) : String(value)}`);
      return scalars.join(" ");
    }
  }
}

/** @param {string} value */
function quote(value) {
  const trimmed = truncate(value.replace(/\s+/gu, " ").trim(), 60);
  return trimmed.length === 0 ? "" : `"${trimmed}"`;
}

/** @param {string} value @param {number} max */
function truncate(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}

/**
 * Final backstop so a pathological subagent cannot push the tool result into
 * bloat-guard territory, where the whole payload would be replaced.
 * @param {string} value @param {number} maxBytes
 */
function capBytes(value, maxBytes) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8").subarray(0, maxBytes - 32);
  // Decode lossily, then drop a trailing replacement char so a multi-byte code
  // point split at the boundary never lands in the output.
  const decoded = buffer.toString("utf8").replace(/�$/u, "");
  return `${decoded}\n… [result truncated]`;
}
