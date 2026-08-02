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

import { homedir } from "node:os";

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
const DEFAULT_MAX_TURNS = 100;
const DEFAULT_TIMEOUT_MS = 300_000;
/** Shape an authored subagent's name must take, mirroring a configured one. */
const INLINE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/u;
/** Effort levels a caller may pin on an authored subagent. Mirrors EFFORT_LEVELS in @mono-agent/config. */
const EFFORT_LEVELS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
/** Grace after the abort signal before the deadline stops waiting on a runner. */
const DEADLINE_GRACE_MS = 5_000;
/** Sentinel distinguishing "deadline won the race" from a real child result. */
const DEADLINE = Symbol("subagent-deadline");

// Kept an order of magnitude under the bloat guard's 256 KiB default: when that
// guard fires it replaces the whole payload with an artifact pointer, which
// would discard the subagent's answer entirely.
const ANSWER_MAX_CHARS = 12_000;
const LOG_MAX_LINES = 60;
const LOG_HEAD_LINES = 25;
const LOG_TAIL_LINES = 30;
const LOG_LINE_MAX_CHARS = 160;
const RESULT_MAX_BYTES = 24_000;
/** Aggregate ceiling for every Agent result in one logical turn. */
const TURN_RESULT_MAX_BYTES = 120_000;
/** Bound on retained per-run budget entries for a long-lived host. */
const MAX_TRACKED_RUNS = 32;

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
 * @param {ReadonlyArray<string>|null} ceiling Tools an authored subagent may request, or null when authoring is off.
 * @returns {string}
 */
function toolDescription(subagents, definitions, ceiling) {
  const maxConcurrent = positiveInt(subagents.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  const parallel = `\n\nIssue several Agent calls in ONE message to run them in parallel (up to ${maxConcurrent} at a time). Subagents run concurrently and independently.`;
  const named = definitions.length === 0
    ? ""
    : `\n\nAvailable subagents:\n${definitions.map((d) => `- ${d.name}: ${d.description}`).join("\n")}\n- ${GENERAL_PURPOSE_SUBAGENT}: read-only researcher inheriting the main model. Used when \`name\` is omitted.`;
  // With authoring on, `name` is a free string rather than an enum, so it is
  // the model's only signal for which of the two shapes it is writing. Left
  // implicit, a caller that wants a configured profile AND a descriptive label
  // splits those across two fields — label into `name`, profile into an
  // invented one — and the closed schema rejects the whole call before any of
  // the handler's precise errors can run.
  const shapes = ceiling === null
    ? ""
    : `\n\nExactly two ways to call this, and \`name\` carries the agent's identity in both:\n- Use a configured one: set \`name\` to a name from the list above. Nothing else.\n- Build one for this task: set \`name\` to a NEW kebab-case name AND \`systemPrompt\` to its full instructions (optionally \`tools\`, \`effort\`). Do that when no configured one fits — a dedicated prompt beats stuffing constraints into \`prompt\`.\n\n\`description\` is the short label shown in the activity log, never the agent's name. There is no separate field for choosing a configured agent.`;
  // The ceiling is listed because the model has no other way to discover it: a
  // tool it cannot see is indistinguishable from one it forgot to ask for.
  const inline = ceiling === null
    ? ""
    : `\n\nTools you may grant a subagent you build: ${ceiling.join(", ")}. Anything else is dropped. Omit \`tools\` for a read-only helper.`;
  return `${DESCRIPTION_BASE}${parallel}${named}${shapes}${inline}`;
}

/** @param {*} value @returns {number} */
function numberOrZero(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

/** @returns {{costUsd: number, input: number, output: number, cacheRead: number, cacheWrite: number}} */
function emptyUsage() {
  return { costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/**
 * Per-logical-run call, byte and subagent-usage budget, shared across router
 * attempts. `usage` rides the same entry so delegated spend inherits the
 * existing per-run keying and eviction instead of needing a second store.
 * @param {*} subagents The run-scoped options object, stable across attempts.
 * @param {string|undefined} parentRunId
 */
function budgetForRun(subagents, parentRunId) {
  const store = subagents.__budgets instanceof Map ? subagents.__budgets : new Map();
  if (!(subagents.__budgets instanceof Map)) {
    Object.defineProperty(subagents, "__budgets", { value: store, enumerable: false, configurable: true });
  }
  const key = parentRunId ?? "unkeyed";
  const existing = store.get(key);
  if (existing !== undefined) return existing;
  // Oldest-first eviction: Map preserves insertion order.
  while (store.size >= MAX_TRACKED_RUNS) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
  const fresh = { total: 0, bytes: 0, warnedQueued: false, usage: emptyUsage() };
  store.set(key, fresh);
  return fresh;
}

/**
 * How many subagents this logical run actually spawned.
 *
 * A read-only accessor so a provider can report `subagent_invoked` truthfully
 * without reaching into `__budgets`, which is a deliberately private,
 * non-enumerable implementation detail. Returns 0 when nothing was ever
 * registered — a run with no `Agent` tool never creates a budget entry, and that
 * is indistinguishable from one that had the tool and never used it, which is
 * exactly what "no subagent was invoked" means for this signal.
 *
 * @param {*} subagents The run-scoped options object, or undefined.
 * @param {string|undefined} parentRunId
 * @returns {number}
 */
export function subagentInvocationCount(subagents, parentRunId) {
  const store = subagents?.__budgets;
  if (!(store instanceof Map)) return 0;
  const entry = store.get(parentRunId ?? "unkeyed");
  return Number.isInteger(entry?.total) ? entry.total : 0;
}

/**
 * What this logical run's subagents spent, summed across every delegation.
 *
 * A delegation is work the run asked for, so its cost belongs to the run's
 * total — a provider folds this into its own usage before reporting, which is
 * what makes the console's cost, the TUI status bar and the exported metrics
 * agree with the bill. Same read-only-accessor contract as
 * `subagentInvocationCount`: `__budgets` stays private. All zeroes when nothing
 * delegated, which is the truthful answer for a run that never used the tool.
 *
 * @param {*} subagents The run-scoped options object, or undefined.
 * @param {string|undefined} parentRunId
 * @returns {{costUsd: number, input: number, output: number, cacheRead: number, cacheWrite: number}}
 */
export function subagentUsageForRun(subagents, parentRunId) {
  const store = subagents?.__budgets;
  const usage = store instanceof Map ? store.get(parentRunId ?? "unkeyed")?.usage : undefined;
  return {
    costUsd: numberOrZero(usage?.costUsd),
    input: numberOrZero(usage?.input),
    output: numberOrZero(usage?.output),
    cacheRead: numberOrZero(usage?.cacheRead),
    cacheWrite: numberOrZero(usage?.cacheWrite),
  };
}

/** @param {*} value @param {number} fallback @returns {number} */
function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Build the `Agent` tool, or null when subagents are unavailable for this run.
 *
 * @param {RuntimeSubagentsOptions|null|undefined} subagents
 * @param {{model?: *, executionMode?: string, cwd?: string, parentRunId?: string, sandboxPolicy?: *, sandboxEngine?: *, skills?: {name: string, description?: string}[], skillsRoot?: string, toolEnvironment?: *, onEvent?: (event: *) => void}} [context]
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

  const slots = createCountingSemaphore(maxConcurrent);
  // Budget state hangs off the shared `subagents` options object, NOT this
  // closure: getPiBuiltinTools runs once per ROUTER ATTEMPT, so a closure-local
  // counter would reset on every same-model retry and failover, multiplying the
  // effective ceiling by the number of attempts. Keyed by parent run so a later
  // logical turn starts fresh, and bounded so a long-lived host cannot grow it.
  const budget = budgetForRun(subagents, context.parentRunId);

  // The ceiling doubles as the authoring switch: null means the closed schema
  // this tool has always had, with `name` restricted to configured profiles.
  const ceiling = inlineCeiling(subagents.inline);

  const parameters = {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        minLength: 1,
        description: "The complete, self-contained task. The subagent sees NONE of this conversation — restate all needed context, file paths, and the exact shape of the answer you want back.",
      },
      // A free-string `name` and a closed enum are mutually exclusive, and no
      // JSON Schema conditional expresses "enum unless systemPrompt is present"
      // portably across providers. Keeping the enum whenever authoring is off
      // means turning the feature off is a true return to the old contract.
      ...(ceiling !== null
        ? {
            name: {
              type: "string",
              pattern: INLINE_NAME_RE.source,
              description: `A configured profile's name, or the name to give a subagent you author here with \`systemPrompt\`. Omit for ${GENERAL_PURPOSE_SUBAGENT}.`,
            },
            systemPrompt: {
              type: "string",
              minLength: 1,
              maxLength: 8_000,
              description: "Build a specialist for this one task: its complete instructions. Requires `name`. Omit to use a configured profile instead.",
            },
            tools: {
              type: "array",
              items: { type: "string", minLength: 1 },
              maxItems: 20,
              description: `Tools the subagent you author needs, e.g. ["Read","Edit","Bash"]. Only usable with \`systemPrompt\`. Available: ${ceiling.join(", ")}. Omit for a read-only helper.`,
            },
            effort: {
              type: "string",
              enum: [...EFFORT_LEVELS],
              description: "Reasoning effort for the subagent you author. Only usable with `systemPrompt`. Omit to inherit yours.",
            },
          }
        : {}),
      ...(ceiling === null && names.length > 0
        ? {
            name: {
              type: "string",
              enum: [...names, GENERAL_PURPOSE_SUBAGENT],
              description: `Which subagent profile to use. Omit for ${GENERAL_PURPOSE_SUBAGENT}.`,
            },
          }
        : {}),
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
    description: toolDescription(subagents, definitions, ceiling),
    parameters,
    // MUST stay undefined. pi-agent-core's agent loop makes the ENTIRE batch
    // sequential when any tool in it declares executionMode "sequential"
    // (dist/agent-loop.js:289), which would serialize every parallel Agent call.
    executionMode: undefined,
    /**
     * @param {string} toolCallId
     * @param {{prompt: string, name?: string, description?: string, systemPrompt?: string, tools?: ReadonlyArray<string>, effort?: string}} params
     * @param {AbortSignal} [signal]
     */
    async execute(toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("tool execution aborted");

      const authored = ceiling !== null && typeof params?.systemPrompt === "string" && params.systemPrompt.trim().length > 0;
      if (!authored && (params?.tools !== undefined || params?.effort !== undefined)) {
        throw new Error("Error: `tools` and `effort` only apply when you supply `systemPrompt` to build a subagent. A configured profile brings its own.");
      }
      const { profile, droppedTools } = authored
        ? buildInlineProfile(params, ceiling, names)
        : { profile: resolveProfile(definitions, params?.name, ceiling), droppedTools: [] };
      if (profile === null) {
        const available = [...names, GENERAL_PURPOSE_SUBAGENT].join(", ");
        throw new Error(`Error: unknown subagent "${params?.name}". Available: ${available}.`);
      }

      // The concurrency cap bounds resources, not cost: a delegation loop can
      // fire calls serially across turns without ever contending the semaphore.
      // This counter is the actual runaway guard.
      if (budget.total >= maxPerTurn) {
        throw new Error(
          `Error: subagent budget for this turn is exhausted (${maxPerTurn} of ${maxPerTurn} used). Do the remaining work yourself.`,
        );
      }
      budget.total += 1;
      const callIndex = budget.total;

      if (slots.inFlight() >= maxConcurrent && !budget.warnedQueued) {
        budget.warnedQueued = true;
        context.onEvent?.({
          type: "runtime_warning",
          warning_kind: "subagent_queued",
          message: `Subagent concurrency limit (${maxConcurrent}) reached; further Agent calls queue.`,
        });
      }

      const releaseSlot = await slots.acquire(signal);
      // The parent can abort while this call was queued; without rechecking, an
      // already-cancelled turn would still spawn a child.
      if (signal?.aborted) {
        releaseSlot();
        throw new Error("tool execution aborted");
      }
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
        timedOut = true;
        // Ask first — a cooperative runner settles and we keep its partial text.
        if (!controller.signal.aborted) controller.abort();
        // Then stop waiting regardless, after a short grace period.
        setTimeout(() => fireDeadline?.(), DEADLINE_GRACE_MS).unref?.();
      }, timeoutMs);

      /** @type {(() => void)|undefined} */
      let fireDeadline;
      // A signal only ASKS a runner to stop. A runner that ignores both its
      // abort signal and its deadline would otherwise keep `execute()` pending
      // forever, holding its permit and wedging every queued sibling. Racing an
      // enforceable deadline lets the slot go; the abandoned work is left to
      // settle on its own and its late result is ignored.
      const deadline = new Promise((resolve) => { fireDeadline = () => resolve(DEADLINE); });

      const collector = createActivityCollector({
        callId: toolCallId,
        profileName: profile.name,
        callIndex,
        ...(params.description === undefined ? {} : { label: params.description }),
        ...(context.onEvent === undefined ? {} : { emit: context.onEvent }),
        // Summed, not replaced: a turn can delegate a dozen times and the run
        // owns all of it. Lives on the run budget so router attempts share it.
        recordUsage: (spent) => {
          budget.usage.costUsd += spent.costUsd;
          budget.usage.input += spent.input;
          budget.usage.output += spent.output;
          budget.usage.cacheRead += spent.cacheRead;
          budget.usage.cacheWrite += spent.cacheWrite;
        },
      });
      collector.started();
      const startedAt = Date.now();
      /** @type {*} */
      let result;
      /** @type {unknown} */
      let thrown;
      let abandoned = false;
      try {
        const running = subagents.run({
          systemPrompt: profile.systemPrompt,
          prompt: params.prompt,
          definition: profile,
          ...(context.model === undefined ? {} : { model: context.model }),
          ...(context.executionMode === undefined ? {} : { executionMode: context.executionMode }),
          ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
          ...(context.parentRunId === undefined ? {} : { parentRunId: context.parentRunId }),
          // Inherited, never widened: a profile cannot loosen confinement.
          ...(context.sandboxPolicy === undefined ? {} : { sandboxPolicy: context.sandboxPolicy }),
          ...(context.sandboxEngine === undefined ? {} : { sandboxEngine: context.sandboxEngine }),
          // The parent's disclosed skills. Offered, not imposed — the host's
          // `run` decides whether this child may have them, since only it knows
          // the child's resolved route and deny lists.
          ...(context.skills === undefined ? {} : { skills: context.skills }),
          ...(context.skillsRoot === undefined ? {} : { skillsRoot: context.skillsRoot }),
          ...(context.toolEnvironment === undefined ? {} : { toolEnvironment: context.toolEnvironment }),
          abortSignal: controller.signal,
          maxTurns,
          callId: toolCallId,
          callIndex,
          depth: positiveInt(subagents.depth, 0) + 1,
          onEvent: collector.observe,
        });
        // Never let an abandoned runner surface as an unhandled rejection.
        void Promise.resolve(running).catch(() => undefined);
        const settled = await Promise.race([running, deadline]);
        if (settled === DEADLINE) {
          timedOut = true;
          abandoned = true;
        } else {
          result = settled;
        }
      } catch (error) {
        thrown = error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onParentAbort);
        releaseSlot();
      }

      // The parent turn being cancelled is not a subagent outcome — surface it
      // as an aborted tool call the way every other built-in does. Close any
      // still-open child activity first so the operator surfaces do not keep a
      // spinner running for a tool that will never report.
      if (signal?.aborted && !timedOut) {
        collector.drain("parent turn cancelled");
        collector.finished({ status: "cancelled", durationMs: Date.now() - startedAt });
        throw new Error("tool execution aborted");
      }
      collector.drain("subagent ended before this tool reported");

      const durationMs = Date.now() - startedAt;
      const outcome = classifyOutcome({ result, thrown, timedOut, abandoned });
      collector.finished({ status: outcome.status, durationMs });
      // Each result is individually capped, but the parent's context sees the
      // SUM. The description encourages parallel calls, so twenty valid results
      // would otherwise land ~480KB in one batch. Later calls get whatever
      // budget remains.
      const remaining = Math.max(0, TURN_RESULT_MAX_BYTES - budget.bytes);
      const text = formatSubagentResult({
        profileName: profile.name,
        label: params.description,
        outcome,
        durationMs,
        activity: collector.entries(),
        maxBytes: Math.min(RESULT_MAX_BYTES, remaining),
        ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
        ...(droppedTools.length === 0 ? {} : {
          notice: `${droppedTools.join(", ")} ${droppedTools.length === 1 ? "is" : "are"} not available to a subagent you build; it ran with ${profile.allowedTools.join(", ")}.`,
        }),
      });
      budget.bytes += Buffer.byteLength(text, "utf8");
      // `details.subagent.status` is the load-bearing signal: pi hardcodes
      // isError:false for every resolved execute(), so the pi-native
      // `tool_result` hook reads this to restore the error flag. A top-level
      // `error` field here would be silently ignored.
      return {
        content: [{ type: "text", text }],
        details: {
          tool: "Agent",
          subagent: { name: profile.name, callIndex, status: outcome.status, toolCalls: collector.entries().length },
        },
      };
    },
  };
}

/**
 * The tools an authored subagent may be granted, or null when authoring is off.
 *
 * A host that enables authoring without stating a ceiling gets the read-only
 * default rather than every built-in: the same reasoning as `normalizeProfile`,
 * one layer up. Only `enabled: false` turns authoring off, so a bare-kernel
 * caller keeps the capability at its safest setting instead of losing it.
 *
 * @param {{enabled?: boolean, allowedTools?: ReadonlyArray<string>}|undefined} inline
 * @returns {ReadonlyArray<string>|null}
 */
function inlineCeiling(inline) {
  if (inline?.enabled === false) return null;
  if (inline === undefined || inline === null) return null;
  const configured = Array.isArray(inline.allowedTools) && inline.allowedTools.length > 0
    ? inline.allowedTools
    : DEFAULT_SUBAGENT_TOOLS;
  return configured.filter((tool) => !SUBAGENT_HARD_DENY.includes(tool));
}

/**
 * Build a one-off profile from what the model authored at call time.
 *
 * The ceiling is the escalation guard: a child's `allowedTools` become its
 * actual tool set, so without an intersection the model could grant a helper a
 * tool its own policy denies it.
 *
 * @param {{name?: string, systemPrompt?: string, description?: string, tools?: ReadonlyArray<string>, effort?: string}} params
 * @param {ReadonlyArray<string>} ceiling
 * @param {ReadonlyArray<string>} configuredNames
 * @returns {{profile: RuntimeSubagentDefinition, droppedTools: string[]}}
 */
function buildInlineProfile(params, ceiling, configuredNames) {
  const name = typeof params.name === "string" ? params.name.trim() : "";
  if (!INLINE_NAME_RE.test(name)) {
    throw new Error("Error: a subagent you build needs a `name` — lowercase kebab-case, e.g. \"css-refactorer\". It labels the run in the activity log.");
  }
  if (configuredNames.includes(name) || name === GENERAL_PURPOSE_SUBAGENT) {
    throw new Error(`Error: "${name}" is already a configured subagent. Drop \`systemPrompt\` to use it, or pick a different name.`);
  }
  const requested = Array.isArray(params.tools) ? params.tools.map((tool) => String(tool).trim()) : undefined;
  const readOnly = DEFAULT_SUBAGENT_TOOLS.filter((tool) => ceiling.includes(tool));
  const droppedTools = requested === undefined ? [] : requested.filter((tool) => !ceiling.includes(tool));
  // An empty list would reach `normalizeProfile`, whose "no tools named" branch
  // substitutes the full read-only default — WIDER than a narrow ceiling. A
  // request that survives nothing therefore has to land on the read-only set
  // already clamped to the ceiling, or fail outright.
  const granted = requested === undefined ? readOnly : requested.filter((tool) => ceiling.includes(tool));
  const effective = granted.length > 0 ? granted : readOnly;
  if (effective.length === 0) {
    throw new Error(`Error: no tools available to a subagent you build (this agent allows ${ceiling.join(", ") || "none"}). Use a configured profile, or do this yourself.`);
  }
  return {
    profile: normalizeProfile({
      name,
      description: params.description ?? name,
      systemPrompt: String(params.systemPrompt),
      allowedTools: effective,
      ...(params.effort === undefined ? {} : { effort: String(params.effort) }),
    }),
    droppedTools,
  };
}

/**
 * @param {ReadonlyArray<RuntimeSubagentDefinition>} definitions
 * @param {string|undefined} name
 * @param {ReadonlyArray<string>|null} ceiling Tool ceiling for the runtime-owned general-purpose profile.
 * @returns {RuntimeSubagentDefinition|null}
 */
function resolveProfile(definitions, name, ceiling) {
  if (name === undefined || name === null || name === GENERAL_PURPOSE_SUBAGENT) {
    const allowedTools = ceiling === null
      ? DEFAULT_SUBAGENT_TOOLS
      : DEFAULT_SUBAGENT_TOOLS.filter((tool) => ceiling.includes(tool));
    // `normalizeProfile` treats an empty allow-list as "use the read-only
    // default", which would silently widen this runtime-owned helper past a
    // parent-policy ceiling that contains only write-capable tools.
    if (allowedTools.length === 0) {
      throw new Error(`Error: no read-only tools available to ${GENERAL_PURPOSE_SUBAGENT} within this agent's subagent ceiling (${ceiling?.join(", ") || "none"}). Use a configured profile, or do this yourself.`);
    }
    return normalizeProfile({
      name: GENERAL_PURPOSE_SUBAGENT,
      description: "Read-only researcher inheriting the main model.",
      systemPrompt: "You are a focused research subagent. Work only from the task you were given — you cannot see the parent conversation and cannot ask anyone anything. Investigate with the tools you have, then finish with a written answer in exactly the shape the task requested. Cite file:line where relevant. Never modify files.",
      allowedTools,
    });
  }
  const found = definitions.find((definition) => definition.name === name);
  return found === undefined ? null : normalizeProfile(found);
}

/**
 * Materialize a profile's effective tool boundary in the KERNEL, not just in
 * whichever host happened to build the definitions.
 *
 * An omitted `allowedTools` is documented as "the safe read-only default set",
 * but forwarding `undefined` to `getPiBuiltinTools` means the allow-all sentinel
 * — every built-in, including Bash, Write, and Exec. A bare-kernel caller
 * supplying a profile without tools would therefore silently get the widest
 * possible child. The hard-deny list is unioned here for the same reason: it
 * must hold on every path, not only the configured-app one.
 *
 * @param {RuntimeSubagentDefinition} definition
 * @returns {RuntimeSubagentDefinition}
 */
function normalizeProfile(definition) {
  const allowed = Array.isArray(definition.allowedTools) && definition.allowedTools.length > 0
    ? definition.allowedTools.filter((tool) => !SUBAGENT_HARD_DENY.includes(tool))
    : DEFAULT_SUBAGENT_TOOLS;
  const denied = [...new Set([...(definition.disallowedTools ?? []), ...SUBAGENT_HARD_DENY])];
  return { ...definition, allowedTools: allowed, disallowedTools: denied };
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
 * @param {{callId: string, profileName: string, callIndex: number, label?: string, emit?: (event: *) => void, recordUsage?: (usage: {costUsd: number, input: number, output: number, cacheRead: number, cacheWrite: number}) => void}} options
 */
function createActivityCollector({ callId, profileName, callIndex, label, emit, recordUsage }) {
  /** @type {Map<string, {name: string, args: unknown, startedAt: number, ms?: number}>} */
  const open = new Map();
  /** @type {Array<{name: string, args: unknown, ms?: number, isError: boolean}>} */
  const done = [];
  /** What the child reported spending, so the parent run can own it. */
  const usage = emptyUsage();
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
      // Before the bookend, so the run's own usage report can already include
      // it, and so an abandoned child still hands over whatever it spent.
      recordUsage?.(usage);
      publish({
        phase: "agent_completed",
        id: `agent:${callId}`,
        name: `Agent(${profileName})`,
        // The one place the child's price is knowable per delegation: operator
        // surfaces show it on the row so an expensive one is identifiable, not
        // just visible in the run total it disappears into.
        ...(usage.costUsd > 0 ? { subagent: { ...subagent, costUsd: usage.costUsd } } : {}),
        isError: status !== "ok",
        executionMs: durationMs,
        content: `${status} · ${done.length} tool call${done.length === 1 ? "" : "s"}`,
      });
    },
    /** Close any tool left open when a run ends abnormally, exactly once. */
    drain(reason) {
      for (const [id, entry] of open) {
        done.push({ name: entry.name, args: entry.args, ms: Date.now() - entry.startedAt, isError: true });
        publish({
          phase: "completed",
          id: `agent:${callId}:${id}`,
          name: `${profileName}▸${entry.name}`,
          isError: true,
          content: reason,
        });
      }
      open.clear();
    },
    /** @param {*} event */
    observe(event) {
      const type = event?.type;
      // Providers legitimately forward multiple blocks in one message; the
      // Claude bridges do routinely. Inspecting only content[0] dropped every
      // tool call after the first.
      const blocks = Array.isArray(event?.message?.content) ? event.message.content : [];
      if (type === "assistant") {
        for (const block of blocks) {
          if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
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
        for (const block of blocks) {
          if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
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
      if (type === "cost_accumulated") {
        // Read as a running total, not a delta — the same rule
        // `ai/observer.js` applies to the parent's own events, because a bridge
        // emits one of these per completed provider run carrying that run's
        // totals. Keeping one rule means a child that failed over undercounts
        // exactly as its parent does today rather than inventing a second.
        // Not republished on the parent stream: consumers treat `usage_update`
        // as the run's cumulative figure, and a child's smaller total arriving
        // last would read as the run getting cheaper.
        const tokens = event.tokens && typeof event.tokens === "object" ? event.tokens : {};
        usage.costUsd = numberOrZero(event.cumulativeUsd);
        usage.input = numberOrZero(tokens.input);
        usage.output = numberOrZero(tokens.output);
        usage.cacheRead = numberOrZero(tokens.cacheReadTokens);
        usage.cacheWrite = numberOrZero(tokens.cacheCreationTokens);
        return;
      }
      // Child warnings are worth surfacing; everything else (context usage,
      // partial tool output) stays inside the subagent for now.
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
 * @param {{result: *, thrown: unknown, timedOut: boolean, abandoned?: boolean}} input
 * @returns {{status: string, answer: string, reason?: string}}
 */
function classifyOutcome({ result, thrown, timedOut, abandoned = false }) {
  if (abandoned) {
    return {
      status: "timeout",
      answer: "",
      reason: "the subagent ignored its deadline and was abandoned; its slot was released",
    };
  }
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
 * @param {{profileName: string, label?: string, outcome: {status: string, answer: string, reason?: string}, durationMs: number, activity: ReadonlyArray<{name: string, args: unknown, ms?: number, isError: boolean}>, maxBytes?: number, cwd?: string, notice?: string}} input
 * @returns {string}
 */
export function formatSubagentResult({ profileName, label, outcome, durationMs, activity, maxBytes = RESULT_MAX_BYTES, cwd, notice }) {
  const seconds = (durationMs / 1000).toFixed(1);
  const calls = `${activity.length} tool call${activity.length === 1 ? "" : "s"}`;
  const header = `<subagent: ${profileName}${label ? ` · ${label}` : ""} · ${outcome.status} · ${calls} · ${seconds}s>`;
  const parts = [header];
  // Surfaced before the answer: a request the runtime silently declined would
  // otherwise have the caller re-request it on every future call.
  if (notice !== undefined) parts.push(`note: ${truncate(notice, 300)}`);
  if (outcome.reason !== undefined) parts.push(`reason: ${truncate(outcome.reason, 500)}`);
  if (outcome.answer.length > 0) parts.push("", truncate(outcome.answer, ANSWER_MAX_CHARS));
  if (activity.length > 0) parts.push("", "<activity>", ...renderActivity(activity, cwd), "</activity>");
  // A fully spent turn budget still returns the header + reason, so the model
  // learns the delegation happened and why it was truncated.
  const floor = 512;
  return capBytes(parts.join("\n"), Math.max(floor, maxBytes));
}

/**
 * Head-and-tail elision: the informative parts of a delegation trace are what
 * it opened with and what it concluded with; the middle is usually a read loop.
 * @param {ReadonlyArray<{name: string, args: unknown, ms?: number, isError: boolean}>} activity
 * @param {string} [cwd]
 * @returns {string[]}
 */
function renderActivity(activity, cwd) {
  const line = (entry, index) => {
    const args = summarizeArgs(entry.name, entry.args, cwd);
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

/** Bound on the argv elements read for an `Exec` summary, before truncation. */
const ARGV_PREVIEW_MAX_CHARS = 200;

/**
 * Show local paths relative to the agent root (and collapse the operator's home
 * directory to `~`), mirroring what the chat ledger does for the same tool
 * arguments. Absolute machine layout has no meaning to the parent model and
 * leaks the operator's account name into its context and every operator surface.
 *
 * Duplicated rather than imported: `@mono-agent/agent-runtime` deliberately has
 * no internal dependencies, so it cannot reach `agent-contracts`.
 *
 * @param {string} value
 * @param {string|undefined} cwd
 * @returns {string}
 */
function relativizePaths(value, cwd) {
  let result = value;
  for (const [root, replacement] of [[cwd, ""], [safeHomedir(), "~/"]]) {
    if (root === undefined || root === "" || root === "/") continue;
    const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
    result = result.replaceAll(`${normalized}/`, replacement);
  }
  return result;
}

/** @returns {string|undefined} */
function safeHomedir() {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

/**
 * Tool-aware one-liners keep the log readable where a generic JSON dump would
 * blow the per-line budget on a single Write payload.
 * @param {string} name
 * @param {unknown} args
 * @param {string} [cwd] Agent root; paths are shown relative to it.
 * @returns {string}
 */
function summarizeArgs(name, args, cwd) {
  if (args === null || typeof args !== "object") return "";
  const record = /** @type {Record<string, unknown>} */ (args);
  const pick = (key) => (typeof record[key] === "string" ? relativizePaths(String(record[key]), cwd) : undefined);
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return pick("file_path") ?? "";
    case "Bash":
      return quote(pick("command") ?? "");
    case "Exec":
      // Exec carries no `command`. Rendering only `executable` collapsed every
      // line to `Exec "rg"`, saying nothing about what the subagent actually ran.
      return quote(execArgv(record, cwd));
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
        .map(([key, value]) => `${key}=${typeof value === "string" ? quote(relativizePaths(value, cwd)) : String(value)}`);
      return scalars.join(" ");
    }
  }
}

/**
 * Space-joined executable and arguments, so the summary reads like the command
 * line it stands in for. A non-string element ends the run: a hole makes the
 * rest of an argv positionally meaningless, and a truthful prefix beats a
 * spliced line.
 *
 * @param {Record<string, unknown>} record
 * @param {string|undefined} cwd
 * @returns {string}
 */
function execArgv(record, cwd) {
  const executable = typeof record.executable === "string" ? record.executable : "";
  if (executable === "") return "";
  const parts = [executable];
  let budget = ARGV_PREVIEW_MAX_CHARS;
  for (const arg of Array.isArray(record.args) ? record.args : []) {
    if (typeof arg !== "string" || budget <= 0) break;
    parts.push(arg);
    budget -= arg.length + 1;
  }
  return relativizePaths(parts.join(" "), cwd);
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
