import type { RuntimeSubagentInstance } from "../../contracts/runtime.js";
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

import { randomUUID } from "node:crypto";

import { homedir } from "node:os";

import { createCountingSemaphore } from "../shared/semaphore.js";
import { publicBackgroundStartFailure } from "../commands/process-jobs.js";

const GENERAL_PURPOSE_SUBAGENT = "general-purpose";

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
  "AgentManage",
  "AskUser",
  "SlackSendMessage",
  "TelegramSendMessage",
  "TelegramSendFile",
]);

const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_MAX_PER_TURN = 20;
const DEFAULT_MAX_TURNS = 100;
const DEFAULT_TIMEOUT_MS = 300_000;
/**
 * Fixed turn budget for the single post-max-turns wrap-up continuation (issue
 * #994). Deliberately not configurable in this change: the behaviour ships
 * first, a `subagents.wrapUp` knob can follow once it has proven itself. Three
 * turns cover inspect → commit + report → spare without giving the child room
 * to resume real work.
 */
const WRAP_UP_MAX_TURNS = 3;
/** Shape an authored subagent's name must take, mirroring a configured one. */
const INLINE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/u;
/** Effort levels a caller may pin on an authored subagent. Mirrors EFFORT_LEVELS in @mono-agent/config. */
export const EFFORT_LEVELS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
/** Grace after the abort signal before the deadline stops waiting on a runner. */
const DEADLINE_GRACE_MS = 5_000;
/** Sentinel distinguishing "deadline won the race" from a real child result. */
const DEADLINE = Symbol("subagent-deadline");
// Reserve time inside the owning job for cooperative abort, command cleanup and registry publication.
const JOB_SETTLEMENT_MARGIN_MS = 15_000;

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
 * @param ceiling Tools available to the runtime-owned general-purpose or authored profiles, or null when authoring is off.
 */
function toolDescription(subagents: RuntimeSubagentsOptions, definitions: readonly RuntimeSubagentDefinition[], ceiling: readonly string[] | null, instancesEnabled: boolean) {
  const maxConcurrent = positiveInt(subagents!.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  const parallel = `\n\nSeveral Agent calls in ONE message can overlap (up to ${maxConcurrent} at a time). An invoked stateful, mutating, MCP, or unknown tool in that message is an exclusive barrier: later calls wait until its result settles. For long commands, use background process jobs when available rather than holding the batch behind a foreground command.`;
  const named = definitions.length === 0
    ? ""
    : `\n\nAvailable subagents:\n${definitions.map((d) => `- ${d.name}: ${d.description}`).join("\n")}\n- ${GENERAL_PURPOSE_SUBAGENT}: read-only researcher inheriting the main model. Used when \`name\` is omitted.`;
  // With authoring on, `name` is a free string rather than an enum, so it is
  // the model's only signal for which of the two shapes it is writing. Left
  // implicit, a caller that wants a configured profile AND a descriptive label
  // splits those across two fields — label into `name`, profile into an
  // invented one — and the closed schema rejects the whole call before any of
  // the handler's precise errors can run.
  const routeOptions = (subagents!.models?.length ?? 0) > 0 ? "`model` or `effort`" : "`effort`";
  const shapes = ceiling === null
    ? ""
    : `\n\nExactly two ways to call this, and \`name\` carries the agent's identity in both:\n- Use a configured one: set \`name\` to a name from the list above. Optionally set ${routeOptions}.\n- Build one for this task: set \`name\` to a NEW kebab-case name AND \`systemPrompt\` to its full instructions (optionally \`tools\` and ${routeOptions}). Do that when no configured one fits — a dedicated prompt beats stuffing constraints into \`prompt\`.\n\n\`description\` is the short label shown in the activity log, never the agent's name. There is no separate field for choosing a configured agent.`;
  // The ceiling is listed because the model has no other way to discover it: a
  // tool it cannot see is indistinguishable from one it forgot to ask for.
  const inline = ceiling === null
    ? ""
    : `\n\nTools you may grant a subagent you build: ${ceiling.join(", ")}. Anything else is dropped. Omit \`tools\` for a read-only helper.`;
  const base = instancesEnabled
    ? DESCRIPTION_BASE.replace("Bad: anything needing back-and-forth, anything where", "Bad: anything where")
      .replace("- It cannot ask you or the user anything. One shot.", "- A persistent child can ask you through AskParent and return awaiting_reply. Reply with AgentManage({id, message}). It cannot contact the user.")
    : DESCRIPTION_BASE;
  return `${base}${parallel}${named}${shapes}${inline}`;
}

function slotsForOptions(subagents: any, maximum: number, parentRunId: string | undefined) {
  const budget = ((budgetForRun(subagents, parentRunId)) as any);
  if (!budget.slots) budget.slots = createCountingSemaphore(maximum);
  return budget.slots;
}

function numberOrZero(value: any) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function emptyUsage() {
  return { costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function reportedTokens(usage: { costUsd: number; input: number; output: number; cacheRead: number; cacheWrite: number; }) {
  const { input, output, cacheRead, cacheWrite } = usage;
  const values = [input, output, cacheRead, cacheWrite];
  return values.every((value) => Number.isSafeInteger(value) && value >= 0)
    && values.some((value) => value > 0) ? { input, output, cacheRead, cacheWrite } : undefined;
}

/**
 * Per-logical-run call, byte and subagent-usage budget, shared across router
 * attempts. `usage` rides the same entry so delegated spend inherits the
 * existing per-run keying and eviction instead of needing a second store.
 * @param subagents The run-scoped options object, stable across attempts.
 */
function budgetForRun(subagents: any, parentRunId: string | undefined) {
  const store = subagents!.__budgets instanceof Map ? subagents!.__budgets : new Map();
  if (!(subagents!.__budgets instanceof Map)) {
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
 * @param subagents The run-scoped options object, or undefined.
 */
export function subagentInvocationCount(subagents: any, parentRunId: string | undefined): number {
  const store = subagents?.__budgets;
  if (!(store instanceof Map)) return 0;
  const entry = store.get(parentRunId ?? "unkeyed");
  return Number.isInteger(entry?.total) ? entry.total : 0;
}

/**
 * What this logical run's synchronous subagents spent, summed across delegations.
 *
 * Providers fold synchronous child usage into parent totals. Detached jobs own
 * independent durable accounting and never mutate this budget after handoff.
 * Like `subagentInvocationCount`, this accessor keeps `__budgets` private and
 * returns zeroes when the run has no synchronous child spend.
 * @param subagents The run-scoped options object, or undefined.
 */
export function subagentUsageForRun(subagents: any, parentRunId: string | undefined): { costUsd: number; input: number; output: number; cacheRead: number; cacheWrite: number } {
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

function positiveInt(value: any, fallback: number) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Build the `Agent` tool, or null when subagents are unavailable for this run.
 * @param [continuation] Internal AgentManage dispatch; never model supplied.
 */
export function createAgentTool(subagents: RuntimeSubagentsOptions | null | undefined, context: { recoveryAccess?: unknown; instancesEnabled?: boolean; persistentExposure?: boolean; model?: any; effort?: string; cwd?: string; parentRunId?: string; sandboxPolicy?: any; sandboxEngine?: any; skills?: { name: string; description?: string }[]; skillsRoot?: string; toolEnvironment?: any; webSearchConfig?: any; webRequestCoordinator?: any; webFetchConfig?: any; onEvent?: (event: any) => void; persistArtifact?: (artifact: { filename: string; buffer: Buffer; toolName: string; toolUseId: string | null }) => string | null } = {}, continuation?: { record: import("../../contracts/runtime.js").RuntimeSubagentInstance; close?: boolean; acknowledgement?: import("../../contracts/runtime.js").RuntimeSubagentRecoveryRequest; route?: import("../../contracts/runtime.js").RuntimeSubagentRoute }): any | null {
  if (!subagents || typeof subagents!.run !== "function") return null;
  // Structural recursion lock #1: a subagent's own tool set never contains
  // `Agent`, regardless of what any host-supplied `run` forwards.
  if (positiveInt(subagents!.depth, 0) > 0 || Number(subagents!.depth || 0) > 0) return null;

  const instances = context.instancesEnabled === false ? undefined : subagents!.instances;
  const persistentExposure = context.instancesEnabled !== false && (context.persistentExposure ?? Boolean(instances));
  const background = instances?.reserve && instances?.releaseReservation ? subagents!.backgroundSubagentController : undefined;
  const definitions = Array.isArray(subagents!.definitions) ? subagents!.definitions.filter(Boolean).slice().sort((a: any, b: any) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : [];
  const maxConcurrent = positiveInt(subagents!.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  const maxPerTurn = positiveInt(subagents!.maxPerTurn, DEFAULT_MAX_PER_TURN);
  const names = definitions.map((definition: any) => definition.name);
  const models = [...(subagents!.models ?? [])].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  const slots = slotsForOptions(subagents, maxConcurrent, context.parentRunId);
  // Budget state hangs off the shared `subagents` options object, NOT this
  // closure: getPiBuiltinTools runs once per ROUTER ATTEMPT, so a closure-local
  // counter would reset on every same-model retry and failover, multiplying the
  // effective ceiling by the number of attempts. Keyed by parent run so a later
  // logical turn starts fresh, and bounded so a long-lived host cannot grow it.
  const budget = budgetForRun(subagents, context.parentRunId);

  // The ceiling doubles as the authoring switch: null means the closed schema
  // this tool has always had, with `name` restricted to configured profiles.
  const ceiling = inlineCeiling(subagents!.inline)?.slice().sort() ?? null;

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
      effort: {
        type: "string",
        enum: [...EFFORT_LEVELS],
        description: "Reasoning effort for the subagent. Omit to inherit your own effective effort.",
      },
      ...(models.length === 0 ? {} : { model: {
        type: "string",
        enum: models.map((choice) => choice.name),
        description: `Run the subagent on this model instead of inheriting yours. Choices: ${models.map((choice) => `${choice.name} → ${choice.key}`).join(", ")}.`,
      } }),
      ...(persistentExposure ? {
        verification: { type: "object", additionalProperties: false, required: ["workdir"], properties: {
          workdir: { type: "string", maxLength: 2048 }, reportPath: { type: "string", maxLength: 512 },
        }, description: "Optional observation-only worktree and relative report presence target. Does not change command cwd, widen permissions, authorize work, or establish verification success." },
        persist: { type: "boolean", description: "Keep this subagent alive so you can continue it with AgentManage. Off by default; set it only when a follow-up turn is actually expected, and close the instance when that follow-up is done." },
        id: { type: "string", pattern: INLINE_NAME_RE.source, description: "Instance id; only with persist." },
      } : {}),
      ...(persistentExposure ? { background: { type: "boolean", description: "Run the child detached (requires persist: true); this conversation wakes on completion or AskParent. Only for sustained work that outlives a reply — a short answer you need now stays foreground. Do not poll or replay." } } : {}),
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
    description: toolDescription(subagents, definitions, ceiling, persistentExposure) + (persistentExposure ? "\n\nA child is stateless by default: it answers once and holds nothing afterwards, which is right for most delegations. Set persist: true only when you will actually continue this child with AgentManage — corrections, follow-up questions, a multi-step assignment — because a persistent instance keeps its transcript and one of this conversation’s live instance slots until you close it; close it as soon as the follow-up is done." : "") + (persistentExposure ? " background: true detaches the child (it currently requires persist: true) and returns a durable started receipt; this exact conversation wakes when the child settles or asks you a question. Reserve it for sustained work that outlives a reply, not for a short question whose answer you need now. Do not poll or replay." : ""),
    parameters,
    // Agent is shareable in safe-parallel mode even when exclusive tools are
    // offered; the harness gate serializes those tools only when invoked.
    executionMode: undefined,
    async execute(toolCallId: string, params: { prompt: string; name?: string; description?: string; systemPrompt?: string; tools?: ReadonlyArray<string>; effort?: string; model?: string; persist?: boolean; id?: string; background?: boolean; verification?: { workdir: string; reportPath?: string; }; }, signal?: AbortSignal) {
      if (signal?.aborted) throw new Error("tool execution aborted");

      if (params.background !== undefined && typeof params.background !== "boolean") throw new Error("Error: background must be a boolean.");
      if (params.background === true && !background) throw new Error("Error: background subagents are unavailable in this conversation.");
      if (params.background === true && !continuation && params.persist !== true) throw new Error("Error: background requires persist: true.");
      const detached = params.background === true;
      const reservation = detached ? randomUUID() : undefined;
      if (!instances && (params.persist !== undefined || params.id !== undefined)) {
        throw new Error("Error: persistent subagent instances are unavailable in this conversation.");
      }
      if (params.verification !== undefined && params.persist !== true) throw new Error("Error: verification metadata requires persist: true and does not change cwd.");
      if (params.id !== undefined && params.persist !== true) throw new Error("Error: id requires persist: true.");
      if (params.persist !== undefined && typeof params.persist !== "boolean") throw new Error("Error: persist must be a boolean.");
      const authored = ceiling !== null && typeof params?.systemPrompt === "string" && params.systemPrompt.trim().length > 0;
      if (!authored && params?.tools !== undefined) {
        throw new Error("Error: `tools` only applies when you supply `systemPrompt` to build a subagent. A configured profile brings its own.");
      }
      const override = params.model === undefined ? undefined : models.find((choice) => choice.name === params.model);
      if (params.model !== undefined && override === undefined) {
        throw new Error(`Error: unknown model "${params.model}". Choices: ${models.map((choice) => choice.name).join(", ") || "none configured"}.`);
      }
      if (params.effort !== undefined && !EFFORT_LEVELS.includes(params.effort)) {
        throw new Error(`Error: unknown effort "${params.effort}". Choices: ${EFFORT_LEVELS.join(", ")}.`);
      }
      const { profile: selectedProfile, droppedTools } = continuation
        ? { profile: continuation.record.definition, droppedTools: [] }
        : authored
        ? buildInlineProfile(params, ceiling!, names)
        : { profile: resolveProfile(definitions, params?.name, ceiling), droppedTools: [] };
      if (selectedProfile === null) {
        const available = [...names, GENERAL_PURPOSE_SUBAGENT].join(", ");
        throw new Error(`Error: unknown subagent "${params?.name}". Available: ${available}.`);
      }

      // A retarget applies to this turn and is persisted on the instance inside
      // the same admission transaction, so the route has to be merged here:
      // `requested`, `launch` and `routeLabel` below are computed before
      // `reserve`/`begin` ever runs and would otherwise report the old route.
      const route = continuation?.route;
      const profile = continuation ? (route === undefined ? continuation.record.definition : {
        ...continuation.record.definition,
        ...(route.model === undefined ? {} : { model: route.model }),
        ...(route.effort === undefined ? {} : { effort: route.effort }),
      }) : {
        ...selectedProfile,
        ...(override === undefined ? {} : { model: override.model }),
        ...(params.effort === undefined ? {} : { effort: params.effort }),
      };
      let instance: RuntimeSubagentInstance | undefined;
      const requested = {
        ...(profile.model === undefined ? {} : { model: `${profile.model.provider}:${profile.model.model}` }),
        ...(profile.effort === undefined ? {} : { effort: profile.effort }),
      };
      // The route the child will really run on: explicit pins win, the parent's
      // own route fills the gaps. Published on the started bookend so the row
      // badges while running. Never recorded as an explicit request: the
      // collector keeps it beside `requested` so completion cannot misread an
      // inherited route as a fallback.
      const inheritedModel = requested.model === undefined ? modelRouteString(context.model) : undefined;
      const inheritedEffort = requested.effort === undefined ? boundedRouteString(context.effort, 64) : undefined;
      const launch = {
        ...requested,
        ...(inheritedModel === undefined ? {} : { model: inheritedModel }),
        ...(inheritedEffort === undefined ? {} : { effort: inheritedEffort }),
      };
      const routeLabel = [requested.model, requested.effort].filter(Boolean).join("/");

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

      const finishInstance = (id: any, outcome: any) => reservation === undefined
        ? instances!.finish(id, outcome) : instances!.finish(id, outcome, reservation!);
      const createInstance = async () => {
        const { mcpServers, ...retainedProfile } = profile;
        const spec = { ...(params.id === undefined ? {} : { id: params.id }),
          name: profile.name, systemPrompt: profile.systemPrompt,
          definition: { ...retainedProfile, mcpServerNames: profile.mcpServerNames ?? Object.keys(mcpServers ?? {}), model: profile.model ?? context.model, effort: profile.effort ?? context.effort } };
        return params.verification ? await instances!.create({ ...spec, verification: params.verification } as Parameters<NonNullable<typeof instances>["create"]>[0], context.recoveryAccess) : await instances!.create(spec as Parameters<NonNullable<typeof instances>["create"]>[0]);
      };
      if (detached) {
        let retained;
        try { retained = continuation?.record ?? await createInstance(); }
        catch (error: any) {
          if (error?.code === "subagent_instance_capacity" && Number.isSafeInteger(error.occupancy) && Number.isSafeInteger(error.limit)) {
            throw new Error(`Subagent live instances full: ${error.occupancy}/${error.limit} (subagents.instances.maxPerConversation); close idle instances or raise the configured limit.`);
          }
          if (["subagent_ownership_held", "subagent_owner_unavailable", "subagent_recovery_required", "subagent_stale_turn"].includes(error?.code)) {
            throw Object.assign(new Error(error.code), { code: error.code });
          }
          throw new Error("Subagent instance could not be created; check the instance id, recovery state, and configured limits.");
        }
        instance = continuation?.acknowledgement
          ? await instances!.reserve!(retained.id, reservation!, continuation.acknowledgement, context.recoveryAccess, route)
          : await instances!.reserve!(retained.id, reservation!, undefined, context.recoveryAccess, route, !continuation);
        try {
          const started = await background!.startInternal({ kind: "internal", tool: continuation ? "AgentManage" : "Agent",
            jobId: reservation!, instanceId: retained.id,
            ...(background!.managed ? { managed: { instanceIncarnation: instance.incarnation ?? "", turnToken: instance.activeTurn?.token ?? "" } } : {}),
            // `description` is the model-authored activity label (never the prompt); it names the job card.
            ...(typeof params.description === "string" && params.description.trim() ? { description: params.description } : {}),
            // Request headroom for the child timer and settlement. The host still
            // clamps this job to processJobs.maxRuntimeMs at admission.
            timeoutMs: positiveInt(profile.timeoutMs, positiveInt(subagents!.timeoutMs, DEFAULT_TIMEOUT_MS)) + JOB_SETTLEMENT_MARGIN_MS,
            // The identity is host-validated; raw prompts and tool parameters never enter job metadata.
            cleanup: () => instances!.releaseReservation!(retained.id, reservation!),
            run: async (childSignal, _writeOutput, reportProgress, execution) => {
              try {
                let result;
                try { result = await runTurn(childSignal, reportProgress, execution); }
                catch (error: any) { throw markChildRunFailure(error); }
                return { answer: result.answer, status: result.details.subagent.status, ...(result.details.subagent.question ? { question: result.details.subagent.question } : {}), childStillBusy: result.details.subagent.childStillBusy === true,
                  output: JSON.stringify({ instanceId: retained.id, ...result.details.subagent,
                    answer: result.content[0]!.text, artifacts: result.details.tool_payload_saved_paths ?? [] }) };
              } finally { await instances!.releaseReservation!(retained.id, reservation!); }
            },
          });
          return { content: [{ type: "text", text: `Background subagent ${started.state === "queued" ? "queued; no child or provider has started" : "running"}. This conversation will wake on completion or AskParent. Do not poll, replay, or report completion yet.\n${JSON.stringify({ jobId: started.jobId, instanceId: retained.id, state: started.state, ...(started.queuePosition === undefined ? {} : { queuePosition: started.queuePosition }), ...(started.queueDeadlineAt === undefined ? {} : { queueDeadlineAt: started.queueDeadlineAt }) })}` }],
            details: { tool: continuation ? "AgentManage" : "Agent", jobId: started.jobId, instanceId: retained.id, state: started.state,
              outcome: { status: "ok", code: "background_started", retryable: false, attempts: 1, durationMs: 0,
                bytes: 0, truncated: false, exitCode: null, signal: null, timedOut: false, background: true,
                job_id: started.jobId, state: started.state, started_at: started.startedAt } } };
        } catch (error: any) {
          try { await instances!.releaseReservation!(retained.id, reservation!); }
          catch { throw Object.assign(new Error("Subagent ownership is unavailable; the turn remains fenced."), { code: "subagent_owner_unavailable" }); }
          // The child's own run failures (e.g. provider admission refused) are
          // framework-authored and keep their text; only controller/service
          // refusals are replaced by their allowlisted public message.
          if (isChildRunFailure(error)) throw error;
          const failure = publicBackgroundStartFailure(error);
          throw Object.assign(new Error(failure.message), { code: failure.code });
        }
      }
      return await runTurn(signal);

      async function runTurn(signal?: AbortSignal, reportProgress?: (event: any) => void, execution?: { deadlineAt: number; managed?: any; }) {
        if (!detached && slots.inFlight() >= maxConcurrent && !budget.warnedQueued) {
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
        const configuredTimeoutMs = positiveInt(profile.timeoutMs, positiveInt(subagents!.timeoutMs, DEFAULT_TIMEOUT_MS));
        let begun = false;
        let timeoutMs;
        try {
          if (detached) { instance = await instances!.begin(instance!.id, reservation, continuation?.acknowledgement, context.recoveryAccess, route); begun = true; }
          else if (continuation) {
            instance = continuation.acknowledgement
              ? await instances!.begin(continuation.record.id, undefined, continuation.acknowledgement, context.recoveryAccess, route)
              : await instances!.begin(continuation.record.id, undefined, undefined, context.recoveryAccess, route);
            begun = true;
          } else if (params.persist) {
            const created = await createInstance();
            instance = await instances!.begin(created.id);
            begun = true;
          }
          // Registry admission may wait for locks, owner proof or expiry I/O. Take
          // the remaining job budget only AFTER it returns, directly before the
          // timer; an estimate taken before begin can outlive the job deadline.
          const jobRemainingMs = execution?.deadlineAt === undefined ? undefined
            : Number.isFinite(execution.deadlineAt) ? Math.floor(execution.deadlineAt - Date.now()) : 0;
          // Short jobs reserve 10%; long jobs reserve up to 15s. Never move the hard deadline.
          const settlementMarginMs = jobRemainingMs === undefined ? 0 : Math.min(JOB_SETTLEMENT_MARGIN_MS, Math.max(1, Math.floor(jobRemainingMs / 10)));
          const remainingChildBudget = jobRemainingMs === undefined ? configuredTimeoutMs : jobRemainingMs - settlementMarginMs;
          if (execution && remainingChildBudget < 1) {
            // No provider was admitted. Release the begun intent without a charged
            // turn or invented failure certificate; linked turns publish through
            // their owner, never through an untracked registry finish.
            if (begun && instance) {
              if (execution.managed) await execution.managed.report({ status: "busy" });
              else instance = await finishInstance(instance.id, { status: "busy" });
            }
            throw new Error("Subagent provider admission refused: insufficient job runtime remains for child settlement.");
          }
          timeoutMs = Math.min(configuredTimeoutMs, remainingChildBudget);
        } catch (error: any) { releaseSlot(); throw error; }
        // The timer starts only AFTER a slot and registry intent are held.
        const maxTurns = positiveInt(profile.maxTurns, positiveInt(subagents!.maxTurns, DEFAULT_MAX_TURNS));

        const controller = new AbortController();
        let timedOut = false;
        let childTimeoutFired = false;
        let graceTimer;
        const requestDeadline = () => { graceTimer ??= setTimeout(() => fireDeadline?.(), DEADLINE_GRACE_MS); };
        const onParentAbort = () => { timedOut ||= detached && signal?.reason?.name === "TimeoutError"; controller.abort(signal?.reason); if (detached) { clearTimeout(timer); requestDeadline(); } };
        if (signal?.aborted) { timedOut ||= detached && signal.reason?.name === "TimeoutError"; controller.abort(signal.reason); if (detached) requestDeadline(); }
        else signal?.addEventListener("abort", onParentAbort, { once: true });
        const childDeadlineAt = Date.now() + timeoutMs;
        const timer = setTimeout(() => {
          childTimeoutFired = !signal?.aborted;
          timedOut = true;
          // Ask first — a cooperative runner settles and we keep its partial text.
          if (!controller.signal.aborted) controller.abort();
          // Then stop waiting regardless, after a short grace period.
          requestDeadline();
        }, timeoutMs);

        let fireDeadline: () => void;
        // A signal only ASKS a runner to stop. A runner that ignores both its
        // abort signal and its deadline would otherwise keep `execute()` pending
        // forever, holding its permit and wedging every queued sibling. Racing an
        // enforceable deadline lets the slot go; the abandoned work is left to
        // settle on its own and its late result is ignored.
        const deadline = new Promise((resolve) => { fireDeadline = () => resolve(DEADLINE); });

        const collector = createActivityCollector({
          requested,
          launch,
          callId: toolCallId,
          profileName: profile.name,
          callIndex,
          ...(params.description === undefined ? {} : { label: params.description }),
          ...(detached
            ? { emit: (event: any) => reportDetachedProgress(event, reportProgress, launch) }
            : context.onEvent === undefined ? {} : { emit: context.onEvent }),
          // Synchronous spend is summed across router attempts. Detached spend
          // belongs only to its instance and job, even if it completes immediately.
          recordUsage: (spent) => {
            if (detached) return;
            budget.usage.costUsd += spent.costUsd;
            budget.usage.input += spent.input;
            budget.usage.output += spent.output;
            budget.usage.cacheRead += spent.cacheRead;
            budget.usage.cacheWrite += spent.cacheWrite;
          },
        });
        collector.started();
        const startedAt = Date.now();
        let result: any;
        let thrown: unknown;
        let abandoned = false;
        let recoveryUnavailable = false;
        // One max-turns wrap-up continuation per Agent call, never recursive:
        // set before the wrap-up run starts so even a re-entrant path cannot
        // issue a second one.
        let wrapUpAttempted = false;
        /**
         * Issue one child turn against the same instance (or lack of one) with
         * the same route, tools and activity sink. The wrap-up reuses this so
         * its spend, tool calls and detached-job accounting behave exactly
         * like the main turn's.
         */
        const invokeChildRun = (childPrompt: any, childMaxTurns: any, steerable = true) => subagents!.run!({
          ...(detached ? (execution ? { detached: true, deadlineAt: execution.deadlineAt } : {}) : { deadlineAt: childDeadlineAt }),
          ...(instance?.activeTurn?.token ? { turnToken: instance.activeTurn.token } : {}),
          ...(execution?.managed ? { ownedForegroundProcesses: execution.managed.ownedForegroundProcesses,
            // Opaque host mailbox for parent steering; the host decides whether
            // this route can consume it at all. The wrap-up continuation is not
            // steerable, so it is never handed the mailbox at all.
            ...(steerable && execution.managed.liveInput ? { liveInput: execution.managed.liveInput } : {}) } : {}),
          ...(instance ? { instance: { id: instance.id, sessionId: instance.sessionId, sessionsRoot: instance.sessionsRoot } } : {}),
          systemPrompt: instance?.systemPrompt ?? profile.systemPrompt,
          prompt: childPrompt,
          definition: instance?.definition ?? profile,
          ...(context.model === undefined ? {} : { model: context.model }),
          ...(context.effort === undefined ? {} : { effort: context.effort }),
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
          ...(context.webSearchConfig === undefined ? {} : { webSearchConfig: context.webSearchConfig }),
          ...(context.webRequestCoordinator === undefined ? {} : { webRequestCoordinator: context.webRequestCoordinator }),
          ...(context.webFetchConfig === undefined ? {} : { webFetchConfig: context.webFetchConfig }),
          abortSignal: controller.signal,
          maxTurns: childMaxTurns,
          callId: toolCallId,
          callIndex,
          depth: positiveInt(subagents!.depth, 0) + 1,
          onEvent: collector.observe,
        });
        /**
         * The issue-#994 wrap-up: when the main turn exhausted its per-run
         * maxTurns budget, give it one bounded continuation carrying a
         * commit-and-report instruction instead of cutting it off with nothing.
         * Runs inside the same wall-clock timeout (the guard timer keeps
         * running; the wrap-up never extends it), on the same instance turn,
         * and never recurses. Returns null when no wrap-up applies.
         * @param first The main turn's result.
         * @returns The wrap-up record, merged onto the result.
         */
        const maybeRunWrapUp = async (first: any) => {
          if (wrapUpAttempted || !isMaxTurnsExhaustion(first)) return null;
          // Wall-clock exhaustion and cancellation own this result, not the
          // turn budget: a wrap-up would either have no time left or defy an
          // explicit stop.
          if (timedOut || controller.signal.aborted || first?.cancelled === true) return null;
          wrapUpAttempted = true;
          const turnsUsed = turnCountOf(first);
          try {
            const prompt = buildWrapUpPrompt({
              prompt: params.prompt,
              turnsUsed,
              turnsAllowed: maxTurns,
              activity: collector.entries(),
              ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
              ...(params.verification?.reportPath === undefined ? {} : { reportPath: params.verification.reportPath }),
              persistent: instance !== undefined,
            });
            const wrapResult = await invokeChildRun(prompt, WRAP_UP_MAX_TURNS, false);
            return attachWrapUpSignals(toWrapUpRecord(wrapResult, { turnsUsed, turnsAllowed: maxTurns }), first, wrapResult);
          } catch (error: any) {
            return attachWrapUpSignals({
              budget: "maxTurns",
              turnsUsed,
              turnsAllowed: maxTurns,
              status: "unavailable",
              reason: `the wrap-up continuation could not start: ${error instanceof Error ? error.message : String(error)}`,
              answer: "",
              wrapUpTurnsUsed: null,
              wrapUpTurnsAllowed: WRAP_UP_MAX_TURNS,
            }, first, undefined);
          }
        };
        try {
          await execution?.managed?.started();
          const underlying = Promise.resolve().then(async () => {
            const first = await invokeChildRun(params.prompt, maxTurns);
            // The steering mailbox belongs to the main run only. The max-turns
            // wrap-up is a commit-and-report continuation, so a late steer must
            // read as not applied instead of being injected into it.
            execution?.managed?.liveInput?.close();
            const wrapUp = await maybeRunWrapUp(first);
            if (!wrapUp || first === null || typeof first !== "object") return first;
            // The host sets session-continuity signals per run
            // (configured-agent.ts): without propagating the wrap-up's, a
            // wrap-up that answered outside the instance session would leave
            // the instance recorded retained on the first run's fields and the
            // next AgentManage would resume a lost session. An ordinary failed
            // or unavailable wrap-up carries no such signal, so the merged
            // result still reads as a max-turns exhaustion.
            return {
              ...first,
              ...(wrapUp.continuity !== undefined ? { subagentContinuity: wrapUp.continuity } : {}),
              ...(wrapUp.continuityLost ? { failureKind: "session_continuity_lost" } : {}),
              wrapUp,
            };
          });
          // Observe the actual provider promise before racing reporting/deadline.
          const running = execution?.managed ? Promise.resolve(underlying).then(async (value) => {
            const actual = classifyOutcome({ result: value, thrown: undefined, timedOut });
            await execution.managed.settled({ status: timedOut ? "timeout" : signal?.aborted ? "cancelled" : actual.status,
              ...(childTimeoutFired && (!signal?.aborted || signal?.reason?.name === "TimeoutError") && value?.failureKind !== "session_continuity_lost" && value?.subagentContinuity?.state === "retained" && value.subagentContinuity.turnToken === instance?.activeTurn?.token ? { certifiedTimeout: true } : {}),
              ...(value?.subagentContinuity ? { continuity: value.subagentContinuity } : {}),
              ...(value?.failureKind === "session_continuity_lost" ? { failureKind: value.failureKind } : {}),
              ...(actual.question ? { question: actual.question } : {}), usage: detachedUsage(value, collector.usage()) });
            return value;
          }, async (error: any) => {
            await execution.managed.settled({ status: "failed", usage: detachedUsage(undefined, collector.usage()) });
            throw error;
          }) : underlying;
          // Never let an abandoned runner surface as an unhandled rejection.
          void Promise.resolve(running).catch(() => undefined);
          const settled = await Promise.race([running, deadline]);
          if (settled === DEADLINE && instance && !execution?.managed) {
            const pendingId = instance.id;
            // Keep the instance busy until the actual runner settles, even after the tool deadline.
            void Promise.resolve(running).then(
              (late) => finishInstance(pendingId, { status: timedOut ? "timeout" : "cancelled", ...(childTimeoutFired && (!signal?.aborted || signal?.reason?.name === "TimeoutError") && late?.failureKind !== "session_continuity_lost" && late?.subagentContinuity?.state === "retained" && late.subagentContinuity.turnToken === instance?.activeTurn?.token ? { certifiedTimeout: true, continuity: late.subagentContinuity } : {}), ...(late?.failureKind === "session_continuity_lost" ? { failureKind: "session_continuity_lost" } : {}), answerHead: late?.text ?? "", ...(detached ? { usage: detachedUsage(late, collector.usage()) } : {}) }),
              () => finishInstance(pendingId, { status: timedOut ? "timeout" : "cancelled", ...(detached ? { usage: detachedUsage(undefined, collector.usage()) } : {}) }),
            ).catch(() => undefined);
          }
          if (settled === DEADLINE) {
            timedOut ||= !detached || !signal?.aborted;
            abandoned = true;
          } else {
            result = settled;
          }
        } catch (error: any) {
          thrown = error;
        } finally {
          clearTimeout(timer);
          if (graceTimer) clearTimeout(graceTimer);
          signal?.removeEventListener("abort", onParentAbort);
          releaseSlot();
        }

        if (instance && abandoned && !execution?.managed && instances!.fence) {
          try { await instances!.fence(instance.id, { status: timedOut ? "timeout" : "cancelled" }, instance.activeTurn?.token ?? reservation!); }
          catch { recoveryUnavailable = true; } // The pre-existing active intent/lock stays held.
        }
        if (instance && abandoned && execution?.managed) {
          await execution.managed.report({ status: timedOut ? "timeout" : "cancelled" });
        }
        if (instance && !abandoned) {
          const state = classifyOutcome({ result, thrown, timedOut });
          // The non-detached instance outcome sums both provider runs: the
          // parent budget already accumulates across them via recordUsage and
          // the detached path via collector.usage(), but `result.usage` alone
          // is the first run's. (The detached usage there already includes the
          // wrap-up, so this stays scoped to this path.)
          const usage = sumRunUsage(result?.usage, result?.wrapUp?.wrapUsage ?? null);
          const instanceOutcome = { ...(result?.subagentContinuity ? { continuity: result.subagentContinuity } : {}),
            ...(childTimeoutFired && (!signal?.aborted || signal?.reason?.name === "TimeoutError") && result?.failureKind !== "session_continuity_lost" && result?.subagentContinuity?.state === "retained" && result.subagentContinuity.turnToken === instance.activeTurn?.token ? { certifiedTimeout: true } : {}), ...(execution?.managed && continuation?.close && state.status === "ok" && !signal?.aborted ? { closeAfterSuccess: true } : {}), status: timedOut ? "timeout" : signal?.aborted ? "cancelled" : state.status,
            ...(result?.failureKind === "session_continuity_lost" ? { failureKind: "session_continuity_lost" } : {}),
            answerHead: state.answer, ...(state.question ? { question: state.question } : {}), usage: detached ? detachedUsage(result, collector.usage()) : { input: numberOrZero(usage.input_tokens ?? usage.input ?? usage.inputTokens), output: numberOrZero(usage.output_tokens ?? usage.output ?? usage.outputTokens),
              cacheRead: numberOrZero(usage.cache_read_tokens ?? usage.cacheRead ?? usage.cacheReadTokens), cacheWrite: numberOrZero(usage.cache_write_tokens ?? usage.cache_creation_tokens ?? usage.cacheWrite ?? usage.cacheWriteTokens),
              costUsd: numberOrZero(usage.cost_usd ?? result?.cost?.total ?? result?.cost?.totalUsd ?? usage.cost?.total) } };
          if (execution?.managed) {
            await execution.managed.report(instanceOutcome);
            instance = await instances!.get(instance.id);
          } else instance = await finishInstance(instance.id, instanceOutcome);
          if (!execution?.managed && continuation?.close && state.status === "ok" && !signal?.aborted) instance = context.recoveryAccess === undefined ? await instances!.close(instance!.id) : await instances!.close(instance!.id, context.recoveryAccess);
        }
        // The parent turn being cancelled is not a subagent outcome — surface it
        // as an aborted tool call the way every other built-in does. Close any
        // still-open child activity first so the operator surfaces do not keep a
        // spinner running for a tool that will never report.
        if (signal?.aborted && !timedOut && !detached) {
          collector.drain("parent turn cancelled");
          collector.finished({ status: "cancelled", durationMs: Date.now() - startedAt });
          throw new Error("tool execution aborted");
        }
        collector.drain("subagent ended before this tool reported");

        const durationMs = Date.now() - startedAt;
        const outcome = detached && signal?.aborted && !timedOut
          ? { status: "cancelled", answer: "", reason: "subagent cancelled" }
          : classifyOutcome({ result, thrown, timedOut, abandoned });
        collector.finished({ status: outcome.status, durationMs, result });
        const wrapUp = result !== null && typeof result === "object" && result.wrapUp !== null && typeof result.wrapUp === "object"
          ? result.wrapUp
          : null;
        // The wrap-up's salvaged text is what the parent can act on; the
        // `failed` status and the `usage_limit` reason still say the budget —
        // not the work — is what ended the run.
        const outcomeWithWrapUp = wrapUp !== null && typeof wrapUp.answer === "string" && wrapUp.answer.length > 0
          ? { ...outcome, answer: wrapUp.answer }
          : outcome;
        const wrapUpNote = wrapUp === null
          ? undefined
          : `max-turns budget exhausted (${wrapUp.turnsUsed ?? "?"} of ${wrapUp.turnsAllowed ?? "?"} turns); wrap-up ${wrapUp.status}: ${wrapUp.reason}`;
        // Each result is individually capped, but the parent's context sees the
        // SUM. The description encourages parallel calls, so twenty valid results
        // would otherwise land ~480KB in one batch. Later calls get whatever
        // budget remains.
        const remaining = detached ? RESULT_MAX_BYTES : Math.max(0, TURN_RESULT_MAX_BYTES - budget.bytes);
        const { text, savedPath, truncated } = formatSubagentResult({
          profileName: profile.name,
          ...(instance ? { instance: { id: instance.id, turns: instance.turns, status: instance.status } } : {}),
          label: params.description,
          ...(routeLabel ? { routeLabel } : {}),
          outcome: outcomeWithWrapUp,
          ...(wrapUpNote === undefined ? {} : { wrapUpNote }),
          durationMs,
          activity: collector.entries(),
          maxBytes: Math.min(RESULT_MAX_BYTES, remaining),
          ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
          ...(droppedTools.length === 0 ? {} : {
            notice: `${droppedTools.join(", ")} ${droppedTools.length === 1 ? "is" : "are"} not available to a subagent you build; it ran with ${profile.allowedTools!.join(", ")}.`,
          }),
          persist: (full) => persistSubagentResult(context.persistArtifact, toolCallId, full, continuation ? "AgentManage" : "Agent"),
        });
        if (!detached) budget.bytes += Buffer.byteLength(text, "utf8");
        // `details.subagent.status` is the load-bearing signal: pi hardcodes
        // isError:false for every resolved execute(), so the pi-native
        // `tool_result` hook reads this to restore the error flag. A top-level
        // `error` field here would be silently ignored.
        //
        // `tool_payload_saved_paths` is the key the tool-lifecycle reader collects
        // artifact references from (the bloat guard sets the same one), so a
        // spilled subagent result is recorded in tool history like any other.
        return {
          ...(detached ? { answer: outcomeWithWrapUp.answer } : {}),
          content: [{ type: "text", text }],
          details: {
            tool: continuation ? "AgentManage" : "Agent",
            subagent: { ...(recoveryUnavailable ? { recoveryUnavailable: true } : {}), ...(detached ? { childStillBusy: abandoned, usage: detachedUsage(result, collector.usage()) } : {}), ...(instance ? { instance: { id: instance.id, turns: instance.turns, status: instance.status } } : {}), name: profile.name, callIndex, status: outcome.status, ...(outcome.question ? { question: outcome.question } : {}), toolCalls: collector.entries().length,
              ...(wrapUp === null ? {} : { wrapUp: {
                budget: "maxTurns",
                turnsUsed: wrapUp.turnsUsed ?? null,
                turnsAllowed: wrapUp.turnsAllowed ?? null,
                status: wrapUp.status,
                reason: wrapUp.reason,
                wrapUpTurnsUsed: wrapUp.wrapUpTurnsUsed ?? null,
                wrapUpTurnsAllowed: WRAP_UP_MAX_TURNS,
              } }),
              ...(routeLabel ? { requested, ...(collector.attribution()?.executed === undefined ? {} : { executed: collector.attribution()!.executed }) } : {}),
            },
            ...(truncated ? { tool_payload_truncated: true } : {}),
            ...(savedPath === null ? {} : { tool_payload_saved_paths: [savedPath] }),
          },
        };
      }
    },
  };
}

/**
 * The ceiling for the runtime-owned general-purpose helper and authored
 * subagents, or null when authoring is off.
 *
 * A host that enables authoring without stating a ceiling gets the read-only
 * default rather than every built-in: the same reasoning as `normalizeProfile`,
 * one layer up. Only `enabled: false` turns authoring off, so a bare-kernel
 * caller keeps the capability at its safest setting instead of losing it.
 */
function inlineCeiling(inline: { enabled?: boolean; allowedTools?: ReadonlyArray<string>; } | undefined) {
  if (inline?.enabled === false) return null;
  if (inline === undefined || inline === null) return null;
  const configured = Array.isArray(inline.allowedTools) && inline.allowedTools.length > 0
    ? inline.allowedTools
    : DEFAULT_SUBAGENT_TOOLS;
  return configured.filter((tool: any) => !SUBAGENT_HARD_DENY.includes(tool));
}

/**
 * Build a one-off profile from what the model authored at call time.
 *
 * The ceiling is the escalation guard: a child's `allowedTools` become its
 * actual tool set, so without an intersection the model could grant a helper a
 * tool its own policy denies it.
 */
function buildInlineProfile(params: { name?: string; systemPrompt?: string; description?: string; tools?: ReadonlyArray<string>; effort?: string; model?: string; }, ceiling: readonly string[], configuredNames: readonly string[]) {
  const name = typeof params.name === "string" ? params.name.trim() : "";
  if (!INLINE_NAME_RE.test(name)) {
    throw new Error("Error: a subagent you build needs a `name` — lowercase kebab-case, e.g. \"css-refactorer\". It labels the run in the activity log.");
  }
  if (configuredNames.includes(name) || name === GENERAL_PURPOSE_SUBAGENT) {
    throw new Error(`Error: "${name}" is already a configured subagent. Drop \`systemPrompt\` to use it, or pick a different name.`);
  }
  const requested = Array.isArray(params.tools) ? params.tools.map((tool: any) => String(tool).trim()) : undefined;
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
 * @param ceiling Tool ceiling for the runtime-owned general-purpose profile.
 */
function resolveProfile(definitions: readonly RuntimeSubagentDefinition[], name: string | undefined, ceiling: readonly string[] | null) {
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
      systemPrompt: "You are a focused research subagent. Work only from the task you were given — you cannot see the parent conversation. If AskParent is available, use it when you need direction from your parent. Investigate with the tools you have, then finish with a written answer in exactly the shape the task requested. Cite file:line where relevant. Never modify files.",
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
 */
function normalizeProfile(definition: RuntimeSubagentDefinition) {
  const allowed = Array.isArray(definition.allowedTools) && definition.allowedTools.length > 0
    ? definition.allowedTools.filter((tool: any) => !SUBAGENT_HARD_DENY.includes(tool))
    : DEFAULT_SUBAGENT_TOOLS;
  const denied = [...new Set([...(definition.disallowedTools ?? []), ...SUBAGENT_HARD_DENY])];
  return { ...definition, allowedTools: allowed, disallowedTools: denied };
}

/** Hard cap on any single forwarded payload, so the operator wire's binary-search reducer never has to run. */
const WIRE_CONTENT_MAX_CHARS = 2_000;
const ROUTE_HISTORY_MAX_ENTRIES = 32;

function boundedRouteString(value: any, max: number = 256) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function boundedRouteIndex(value: any) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/** Format a host-supplied model reference the way `requested` does, or undefined when it names nothing. */
function modelRouteString(ref: any) {
  if (typeof ref === "string") return boundedRouteString(ref);
  if (ref === null || typeof ref !== "object" || Array.isArray(ref)) return undefined;
  const provider = typeof ref.provider === "string" ? ref.provider.trim() : "";
  const model = typeof ref.model === "string" ? ref.model.trim() : "";
  if (provider.length > 0 && model.length > 0) return boundedRouteString(`${provider}:${model}`);
  return boundedRouteString(typeof ref.reference === "string" ? ref.reference : undefined);
}

function appendRouteEntry(entries: any, entry: any, routeState: any) {
  entries.push(entry);
  if (entries.length <= ROUTE_HISTORY_MAX_ENTRIES) return;
  entries.splice(1, entries.length - ROUTE_HISTORY_MAX_ENTRIES);
  routeState.truncated = true;
}

/**
 * Drop all provider payloads before the private job callback, especially prompts/results.
 * @param [launch] The route the child will
 *   really run on: explicit pins completed with the inherited parent route.
 *   Reported as the progress `requested` route so the job card badges while
 *   running; the completed bookend's own attribution still wins.
 */
function reportDetachedProgress(event: any, report?: (event: any) => void, launch: { model?: string; effort?: string; } = {}) {
  if (!report) return;
  if (event.phase === "agent_started") {
    report({ type: "started", profile: event.subagent.name,
      ...(event.subagent.label ? { label: event.subagent.label } : {}) });
    if (launch.model !== undefined || launch.effort !== undefined) {
      report({ type: "route", requested: launch });
    }
  } else if (event.phase === "agent_completed") {
    const attribution = event.subagent?.attribution;
    const routeKnown = attribution?.requested?.model !== undefined
      || attribution?.requested?.effort !== undefined
      || attribution?.executed?.model !== undefined
      || attribution?.executed?.effort !== undefined
      || attribution?.executed?.effectiveEffort !== undefined;
    if (attribution !== undefined && routeKnown) {
      const executedKnown = attribution.executed?.model !== undefined
        || attribution.executed?.effort !== undefined
        || attribution.executed?.effectiveEffort !== undefined;
      report({ type: "route", requested: attribution.requested,
        ...(executedKnown ? { executed: attribution.executed } : {}),
        disposition: attribution.disposition });
    }
  } else if (event.phase === "started") {
    const args = event.arguments;
    // No prompt/message or unknown-object fallback. Redaction precedes retention in the host.
    const toolName = event.name.slice(event.name.indexOf("▸") + 1);
    const summary = args && typeof args === "object" && !Array.isArray(args)
      ? toolName === "Exec" && typeof args.executable === "string"
        ? [args.executable, ...(Array.isArray(args.args) ? args.args.filter((value: any) => typeof value === "string") : [])]
          .map((value: any) => /[^\w@%+=:,./-]/u.test(value) ? `'${value.replaceAll("'", "'\\''")}'` : value).join(" ")
        : ["file_path", "path", "filePath", "pattern", "command", "query", "url", "description", "name", "executable"]
          .map((key) => args[key]).find((value: any) => typeof value === "string" && value.trim()) : undefined;
    report({ type: "tool_started", id: event.id, toolName,
      ...(summary === undefined ? {} : { argsSummary: summary }),
      ...((toolName === "Bash" || toolName === "Exec") && typeof args?.workdir === "string" && args.workdir.trim()
        ? { workdir: args.workdir } : {}) });
  } else if (event.phase === "completed" && !event.name.endsWith("▸?")) {
    report({ type: "tool_completed", id: event.id, failed: event.isError === true,
      ...(event.executionMs === undefined ? {} : { executionMs: event.executionMs }) });
  }
}

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
 */
function createActivityCollector({ callId, profileName, callIndex, requested = {}, launch = {}, label, emit, recordUsage }: { callId: string; profileName: string; callIndex: number; requested?: { model?: string; effort?: string; }; launch?: { model?: string; effort?: string; }; label?: string | undefined; emit?: (event: any) => void; recordUsage?: (usage: { costUsd: number; input: number; output: number; cacheRead: number; cacheWrite: number; }) => void; }) {
  const open: Map<string, { name: string; args: unknown; startedAt: number; ms?: number | undefined; }> = new Map();
  const done: { name: string; args: unknown; ms?: number | undefined; isError: boolean; }[] = [];
  /** What the child reported spending, so the parent run can own it. */
  const usage = emptyUsage();
  const subagent = { id: callId, name: profileName, callIndex, ...(label === undefined ? {} : { label }) };
  let finalAttribution: { executed?: { model?: string | undefined; effort?: string | undefined; effectiveEffort?: string | undefined } } | undefined;
  // `requested` is the explicit route only: call-time overrides and profile
  // pins. `launch` completes it with the inherited parent route for display on
  // the started bookend. The two stay separate so the completion-time
  // disposition never verdicts an inherited route as a fallback.
  const routeState = { requested: { ...requested }, launch: { ...launch }, attempted: undefined as { model?: string; effort?: string; effectiveEffort?: string } | undefined, transitions: [], retries: [], truncated: false };

  const publish = (event: any) => {
    if (emit === undefined) return;
    try {
      emit({ type: "subagent_activity", subagent, ...event });
    } catch {
      // Operator telemetry is additive; never fail a subagent over it.
    }
  };

  return {
    entries: () => done,
    attribution: () => finalAttribution,
    usage: () => ({ ...usage }),
    /** Lifecycle bookends so the subagent is visible before its first tool call. */
    started() {
      // Badge the row from the moment the delegation starts. `requested` here
      // is the launch route, so consumers render it requested-only — never as
      // a confirmed run — and the completed bookend replaces it. Unknown stays
      // unknown: no launch route means no attribution, not a guessed one.
      const launchAttribution = routeState.launch.model === undefined && routeState.launch.effort === undefined
        ? undefined
        : {
            requested: { ...routeState.launch },
            disposition: "unknown",
            transitions: [],
            retries: [],
          };
      publish({
        phase: "agent_started",
        id: `agent:${callId}`,
        name: `Agent(${profileName})`,
        arguments: { name: profileName, ...(label === undefined ? {} : { description: label }) },
        ...(launchAttribution === undefined ? {} : { subagent: { ...subagent, attribution: launchAttribution } }),
      });
    },
    finished({ status, durationMs, result }: { status: string; durationMs: number; result?: any; }) {
      // Before the bookend, so the run's own usage report can already include
      // it, and so an abandoned child still hands over whatever it spent.
      recordUsage?.(usage);
      const reportedExecuted = ["ok", "awaiting_reply"].includes(status) && result && typeof result === "object"
        ? {
            ...(boundedRouteString(result.model) === undefined ? {} : { model: boundedRouteString(result.model) }),
            ...(boundedRouteString(result.effort, 64) === undefined ? {} : { effort: boundedRouteString(result.effort, 64) }),
            ...(boundedRouteString(result.effectiveEffort, 64) === undefined ? {} : { effectiveEffort: boundedRouteString(result.effectiveEffort, 64) }),
          }
        : undefined;
      // A successful result object is not itself route evidence. Keeping `{}`
      // here makes consumers prefer an unknown executed route over a pinned
      // requested route, so omit it unless at least one identifier was reported.
      const executed = reportedExecuted !== undefined && Object.keys(reportedExecuted).length > 0
        ? reportedExecuted
        : undefined;
      const requestedModel = routeState.requested.model;
      const fallback = routeState.transitions.length > 0
        || (executed?.model !== undefined && requestedModel !== undefined && executed.model !== requestedModel);
      const attribution = requestedModel === undefined && routeState.requested.effort === undefined && routeState.attempted === undefined && executed === undefined
        ? undefined
        : {
            requested: routeState.requested,
            ...(routeState.attempted === undefined ? {} : { attempted: routeState.attempted }),
            ...(executed === undefined ? {} : { executed }),
            disposition: requestedModel === undefined ? "unknown" : fallback ? "fallback" : "requested",
            transitions: routeState.transitions,
            retries: routeState.retries,
            ...(routeState.truncated ? { truncated: true } : {}),
          };
      finalAttribution = attribution;
      const tokenUsage = reportedTokens(usage);
      publish({
        phase: "agent_completed",
        id: `agent:${callId}`,
        name: `Agent(${profileName})`,
        // The one place the child's price is knowable per delegation: operator
        // surfaces show it on the row so an expensive one is identifiable, not
        // just visible in the run total it disappears into.
        ...((usage.costUsd > 0 || tokenUsage !== undefined || attribution !== undefined)
          ? { subagent: {
              ...subagent,
              ...(usage.costUsd > 0 ? { costUsd: usage.costUsd } : {}),
              ...(tokenUsage === undefined ? {} : { usage: tokenUsage }),
              ...(attribution === undefined ? {} : { attribution }),
            } }
          : {}),
        isError: !["ok", "awaiting_reply"].includes(status),
        executionMs: durationMs,
        content: `${status} · ${done.length} tool call${done.length === 1 ? "" : "s"}`,
      });
    },
    /** Close any tool left open when a run ends abnormally, exactly once. */
    drain(reason: any) {
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
    observe(event: any) {
      const type = event?.type;
      if (type === "provider_execution_config") {
        const model = boundedRouteString(event.model);
        const effort = boundedRouteString(event.effort, 64);
        const effectiveEffort = boundedRouteString(event.effectiveEffort, 64);
        routeState.attempted = {
          ...(model === undefined ? {} : { model }),
          ...(effort === undefined ? {} : { effort }),
          ...(effectiveEffort === undefined ? {} : { effectiveEffort }),
        };
        if (routeState.requested.model === undefined && routeState.transitions.length === 0) {
          routeState.requested = {
            ...(model === undefined ? {} : { model }),
            ...(effort === undefined ? {} : { effort }),
            ...routeState.requested,
          };
        }
        return;
      }
      if (type === "provider_failover_started") {
        const from = boundedRouteString(event.from);
        const to = boundedRouteString(event.to);
        if (from !== undefined && to !== undefined) {
          if (routeState.requested.model === undefined) routeState.requested = { ...routeState.requested, model: from };
          const attemptIndex = boundedRouteIndex(event.attemptIndex);
          const reason = boundedRouteString(event.reason, 128);
          appendRouteEntry(routeState.transitions, {
            from,
            to,
            ...(attemptIndex === undefined ? {} : { attemptIndex }),
            ...(reason === undefined ? {} : { reason }),
          }, routeState);
          routeState.attempted = { model: to };
        }
        return;
      }
      if (type === "provider_retry_started") {
        const model = boundedRouteString(event.model);
        const retryIndex = boundedRouteIndex(event.retryIndex);
        const attempts = boundedRouteIndex(event.attempts);
        const reason = boundedRouteString(event.reason, 128);
        appendRouteEntry(routeState.retries, {
          ...(model === undefined ? {} : { model }),
          ...(retryIndex === undefined ? {} : { retryIndex }),
          ...(attempts === undefined ? {} : { attempts }),
          ...(reason === undefined ? {} : { reason }),
        }, routeState);
        return;
      }
      if (type === "provider_failover_completed") {
        const model = boundedRouteString(event.model);
        if (model !== undefined) routeState.attempted = { ...(routeState.attempted || {}), model };
        return;
      }
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
        // `telemetry/observer.js` applies to the parent's own events, because a bridge
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

function summarizeForWire(value: unknown) {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : safeJson(value);
  return text.length <= WIRE_CONTENT_MAX_CHARS ? text : `${text.slice(0, WIRE_CONTENT_MAX_CHARS)}…`;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Whether a child result is a per-run maxTurns exhaustion (issue #994) rather
 * than any other failure. The precise signal is the pi-native bridge's
 * `max_turns_hit` diagnostic; the `usage_limit` kind plus the max-turns error
 * text covers host-supplied `run` implementations that do not forward
 * diagnostics. `usage_limit` alone is not enough — it must name the turn
 * budget, not some other quota.
 */
function isMaxTurnsExhaustion(result: any) {
  if (result === null || typeof result !== "object" || result.cancelled === true) return false;
  if (result.diagnostics !== null && typeof result.diagnostics === "object" && result.diagnostics.max_turns_hit === true) return true;
  return result.failureKind === "usage_limit" && /max turns?/i.test(String(result.error ?? ""));
}

/**
 * Turns the child reports having used, for the truncation marker. The bridge
 * reports it as `numTurns`; fall back to the diagnostic the result builder
 * records alongside `max_turns_hit`.
 */
function turnCountOf(result: any) {
  if (result !== null && typeof result === "object") {
    if (Number.isInteger(result.numTurns)) return result.numTurns;
    if (result.diagnostics !== null && typeof result.diagnostics === "object" && Number.isInteger(result.diagnostics.turn_count)) {
      return result.diagnostics.turn_count;
    }
  }
  return null;
}

/**
 * Classify one wrap-up continuation into the record the parent reads. Never
 * throws for a settled result; a rejected `run` is handled by the caller as
 * `unavailable`. A wrap-up that exhausts its own budget is `failed`, never
 * re-wrapped: the caller issues exactly one continuation per Agent call.
 */
function toWrapUpRecord(wrapResult: any, { turnsUsed, turnsAllowed }: { turnsUsed: number | null; turnsAllowed: number; }) {
  const base = {
    budget: "maxTurns",
    turnsUsed,
    turnsAllowed,
    wrapUpTurnsUsed: turnCountOf(wrapResult),
    wrapUpTurnsAllowed: WRAP_UP_MAX_TURNS,
  };
  const wrapOutcome = classifyOutcome({ result: wrapResult, thrown: undefined, timedOut: false });
  const answer = typeof wrapOutcome.answer === "string" ? wrapOutcome.answer : "";
  if (isMaxTurnsExhaustion(wrapResult)) {
    return {
      ...base,
      status: "failed",
      reason: `the wrap-up exhausted its own ${WRAP_UP_MAX_TURNS}-turn budget${answer ? "; its partial text is reported below" : " without producing final text"}`,
      answer,
    };
  }
  if (wrapOutcome.status === "cancelled") {
    return {
      ...base,
      status: "failed",
      reason: "the wrap-up was cancelled (parent abort or wall-clock budget exhausted)",
      answer,
    };
  }
  if (answer.length > 0) {
    return {
      ...base,
      status: "ok",
      reason: wrapOutcome.status === "awaiting_reply"
        ? "the wrap-up ended awaiting a parent reply; its question is reported below"
        : "the wrap-up produced a final statement of position",
      answer,
    };
  }
  return {
    ...base,
    status: "failed",
    reason: `the wrap-up ended as ${wrapOutcome.status}${wrapOutcome.reason ? `: ${wrapOutcome.reason}` : " without producing final text"}`,
    answer: "",
  };
}

/**
 * The instruction carried by the single post-limit continuation. Explicit
 * about what the budget situation is, what is forbidden (new work), and what
 * protects the run (commit in-progress work, write the assignment's report,
 * state the position). The original task and the previous turn's recent tool
 * calls ride along because a stateless continuation starts a fresh session
 * without the prior transcript — and a resumed persistent session was rolled
 * back to its pre-turn leaf, so neither wrap-up can rely on seeing the work
 * in the transcript.
 */
function buildWrapUpPrompt({ prompt, turnsUsed, turnsAllowed, activity, cwd, reportPath, persistent }: { prompt: string; turnsUsed: number | null; turnsAllowed: number; activity: ReadonlyArray<{ name: string; args: unknown; isError: boolean; }>; cwd?: string; reportPath?: string; persistent: boolean; }) {
  const used = turnsUsed ?? "all";
  const recent = Array.isArray(activity) ? activity.slice(-12) : [];
  const lines = recent.map((entry: any) => {
    const args = summarizeArgs(entry?.name, entry?.args, cwd);
    return `- ${entry?.name ?? "unknown"}${args ? ` ${args}` : ""} → ${entry?.isError ? "error" : "ok"}`;
  });
  return [
    `MAX-TURNS WRAP-UP — your per-run turn budget is exhausted (${used} of ${turnsAllowed} turns used). Do not start or continue new work.`,
    "",
    `This is one bounded continuation of at most ${WRAP_UP_MAX_TURNS} turns, ${persistent
      ? "on the same persistent instance (the stopped turn's transcript may not be visible, so work from the task and activity below)"
      : "in a fresh session without the prior transcript (stateless run), so work only from the task and activity below"}.`,
    "",
    "Original task:",
    prompt,
    "",
    "Previous turn's most recent tool calls:",
    ...(lines.length > 0 ? lines : ["(none recorded)"]),
    ...(cwd === undefined ? [] : ["", `Worktree: ${cwd}`]),
    ...(reportPath === undefined ? [] : [`The assignment names its report file: ${reportPath}`]),
    "",
    "Do exactly this, in order:",
    "1. Inspect the current state of the work (git status/diff where your tools allow; otherwise re-read the files touched above).",
    "2. Commit work already in progress with a clear message. Do not start new work or try to finish the task.",
    "3. Write the assignment's report file summing up what was completed, the current position (committed vs uncommitted), and precisely what remains undone.",
    "4. End with a concise final statement of position: where you got to, what is committed vs uncommitted, the report path, and what remains.",
    "",
    "If your tools do not permit committing or writing files, say so plainly and put the full statement of position in your final reply text.",
  ].join("\n");
}

/**
 * Carry the wrap-up run's session-continuity signal and raw usage onto its
 * record. `continuity` prefers the wrap-up's own `subagentContinuity` when it
 * reported one (otherwise the merged result keeps the first run's), and
 * `continuityLost` is true when EITHER run reported `session_continuity_lost`
 * — never for a merely failed or unavailable wrap-up. `wrapUsage` is the
 * wrap-up's raw usage bag for the instance-outcome sum; it is not surfaced in
 * `details.subagent.wrapUp`, which keeps its fixed seven fields.
 * @param record The record from `toWrapUpRecord` or the unavailable path.
 * @param first The main turn's result.
 * @param wrapResult The wrap-up run's raw result, or undefined when it never started.
 */
function attachWrapUpSignals(record: any, first: any, wrapResult: any) {
  const wrapObject = wrapResult !== null && typeof wrapResult === "object" ? wrapResult : null;
  const continuity = wrapObject?.subagentContinuity !== null && typeof wrapObject?.subagentContinuity === "object"
    ? wrapObject.subagentContinuity
    : undefined;
  return {
    ...record,
    ...(continuity === undefined ? {} : { continuity }),
    continuityLost: first?.failureKind === "session_continuity_lost" || wrapObject?.failureKind === "session_continuity_lost",
    wrapUsage: wrapObject?.usage ?? null,
  };
}

/**
 * Sum two provider-run usage bags field-wise. Only finite-number values
 * accumulate, so an unexpected shape never corrupts the total; keys present in
 * only one bag pass through. The bridge reports both runs in the same
 * spelling, which is the case that matters (instance token/cost accounting).
 */
function sumRunUsage(firstUsage: any, secondUsage: any) {
  const base = firstUsage !== null && typeof firstUsage === "object" ? { ...firstUsage } : {};
  if (secondUsage === null || typeof secondUsage !== "object") return base;
  for (const [key, value] of Object.entries(secondUsage)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const current = base[key];
    base[key] = (typeof current === "number" && Number.isFinite(current) ? current : 0) + value;
  }
  return base;
}

function classifyOutcome({ result, thrown, timedOut, abandoned = false }: { result: any; thrown: unknown; timedOut: boolean; abandoned?: boolean; }) {
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
  if (result?.failureKind === "session_busy") return { status: "busy", answer: "", reason: "the persistent subagent session is busy" };
  if (result?.error || result?.failureKind) {
    const kind = result.failureKind ? `${result.failureKind}: ` : "";
    return { status: "failed", answer: typeof result.text === "string" ? result.text : "", reason: `${kind}${String(result.error ?? "")}`.trim() };
  }
  if (result?.subagentQuestion) return { status: "awaiting_reply", question: result.subagentQuestion,
    answer: `Awaiting parent reply: ${result.subagentQuestion.question}${result.subagentQuestion.options ? `\nOptions: ${result.subagentQuestion.options.map((option: any) => JSON.stringify(option)).join(", ")}` : ""}` };
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
 * When the retained text cannot carry everything (answer over
 * `ANSWER_MAX_CHARS`, activity elided, or the byte cap reached), the complete
 * result is handed to `persist` and the retained text names the saved file, the
 * same way the bloat guard and the shell tools reference their spilled output.
 * The reference sits directly under the header so the final byte cap can never
 * cut it off. Without a sink (or when the write fails) the text says so instead,
 * so the caller does not go looking for a file that was never written.
 */
function formatSubagentResult({ profileName, instance, label, routeLabel, outcome, wrapUpNote, durationMs, activity, maxBytes = RESULT_MAX_BYTES, cwd, notice, persist }: { profileName: string; instance?: { id: string; turns: number; status: string; }; label?: string | undefined; routeLabel?: string; outcome: { status: string; answer: string; reason?: string; }; wrapUpNote?: string; durationMs: number; activity: ReadonlyArray<{ name: string; args: unknown; ms?: number | undefined; isError: boolean; }>; maxBytes?: number; cwd?: string; notice?: string; persist?: (fullText: string) => string | null; }) {
  const seconds = (durationMs / 1000).toFixed(1);
  const calls = `${activity.length} tool call${activity.length === 1 ? "" : "s"}`;
  const header = `<subagent: ${profileName}${instance ? ` · instance ${instance.id} · turn ${instance.turns}${instance.status === "closed" ? " · closed" : ""}` : ""}${label ? ` · ${label}` : ""}${routeLabel ? ` · ${routeLabel}` : ""} · ${outcome.status} · ${calls} · ${seconds}s>`;
  // Surfaced before the answer: a request the runtime silently declined would
  // otherwise have the caller re-request it on every future call.
  const preamble = [
    ...(notice === undefined ? [] : [`note: ${truncate(notice, 300)}`]),
    ...(outcome.reason === undefined ? [] : [`reason: ${truncate(outcome.reason, 500)}`]),
    // The max-turns truncation marker (issue #994): which budget was hit, how
    // much of it was used, and what the single wrap-up continuation achieved.
    ...(wrapUpNote === undefined ? [] : [`wrap-up: ${truncate(wrapUpNote, 500)}`]),
  ];
  const body = (answer: string, activityLines: string[]) => [
    ...(answer.length > 0 ? ["", answer] : []),
    ...(activityLines.length > 0 ? ["", "<activity>", ...activityLines, "</activity>"] : []),
  ];
  // A fully spent turn budget still returns the header + reason, so the model
  // learns the delegation happened and why it was truncated.
  const floor = 512;
  const cap = Math.max(floor, maxBytes);

  const retained = [header, ...preamble, ...body(truncate(outcome.answer, ANSWER_MAX_CHARS), renderActivity(activity, cwd))].join("\n");
  const lossy = outcome.answer.length > ANSWER_MAX_CHARS
    || activity.length > LOG_MAX_LINES
    || Buffer.byteLength(retained, "utf8") > cap;
  if (!lossy) return { text: retained, savedPath: null, truncated: false };

  const full = [header, ...preamble, ...body(outcome.answer, activity.map((entry, index) => activityLine(entry, index, cwd)))].join("\n");
  const savedPath = typeof persist === "function" ? persist(full) : null;
  const reference = savedPath === null
    ? "[result truncated; full result not saved: artifact persistence unavailable]"
    : `[result truncated; full result saved to: ${savedPath}]`;
  const [retainedHeader, ...retainedRest] = retained.split("\n");
  return {
    text: capBytes([retainedHeader, reference, ...retainedRest].join("\n"), cap),
    savedPath,
    truncated: true,
  };
}

/**
 * Head-and-tail elision: the informative parts of a delegation trace are what
 * it opened with and what it concluded with; the middle is usually a read loop.
 */
function renderActivity(activity: readonly { name: string; args: unknown; ms?: number | undefined; isError: boolean; }[], cwd?: string) {
  const line = (entry: { name: string; args: unknown; ms?: number | undefined; isError: boolean }, index: number) =>
    activityLine(entry, index, cwd);
  if (activity.length <= LOG_MAX_LINES) return activity.map(line);
  const head = activity.slice(0, LOG_HEAD_LINES).map(line);
  const tail = activity.slice(activity.length - LOG_TAIL_LINES).map((entry, offset) =>
    line(entry, activity.length - LOG_TAIL_LINES + offset));
  const elided = activity.length - LOG_HEAD_LINES - LOG_TAIL_LINES;
  return [...head, `… ${elided} call${elided === 1 ? "" : "s"} elided …`, ...tail];
}

/**
 * One activity line. Shared by the retained (elided) log and the persisted
 * full log so both render a call identically.
 */
function activityLine(entry: { name: string; args: unknown; ms?: number | undefined; isError: boolean; }, index: number, cwd?: string) {
  const args = summarizeArgs(entry.name, entry.args, cwd);
  const status = entry.isError ? "error" : "ok";
  const ms = entry.ms === undefined ? "" : ` ${formatMs(entry.ms)}`;
  return truncate(`${index + 1}. ${entry.name}${args ? ` ${args}` : ""} → ${status}${ms}`, LOG_LINE_MAX_CHARS);
}

/**
 * Hand the complete result to the host's artifact sink — the same
 * `persistArtifact({filename, buffer, toolName, toolUseId}) -> path | null`
 * contract the bloat guard uses, so the file lands beside every other spilled
 * tool output under the run's tool-output directory. Best-effort: a missing
 * sink, a rejected filename or a failed write all yield null.
 */
function persistSubagentResult(persistArtifact: unknown, toolCallId: string, fullText: string, toolName: string) {
  if (typeof persistArtifact !== "function") return null;
  const id = String(toolCallId || "").replace(/[^A-Za-z0-9_.-]+/gu, "_").slice(0, 80) || "call";
  try {
    const path = persistArtifact({
      filename: `${toolName}__${id}__full.txt`,
      buffer: Buffer.from(fullText, "utf8"),
      toolName,
      toolUseId: toolCallId,
    });
    return typeof path === "string" && path.length > 0 ? path : null;
  } catch {
    return null;
  }
}

function formatMs(ms: number) {
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
 * Duplicated rather than imported: `@mono-agent/turn` deliberately has
 * no internal dependencies, so it cannot reach `agent-contracts`.
 */
function relativizePaths(value: string, cwd: string | undefined) {
  let result = value;
  for (const [root, replacement] of [[cwd, ""], [safeHomedir(), "~/"]]) {
    if (root === undefined || root === "" || root === "/") continue;
    const normalized = root.endsWith("/") ? root.slice(0, -1) : root;
    result = result.replaceAll(`${normalized}/`, replacement!);
  }
  return result;
}

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
 * @param [cwd] Agent root; paths are shown relative to it.
 */
function summarizeArgs(name: string, args: unknown, cwd?: string) {
  if (args === null || typeof args !== "object") return "";
  const record = ((args) as Record<string, unknown>);
  const pick = (key: any) => (typeof record[key] === "string" ? relativizePaths(String(record[key]), cwd) : undefined);
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
 */
function execArgv(record: Record<string, unknown>, cwd: string | undefined) {
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

function quote(value: string) {
  const trimmed = truncate(value.replace(/\s+/gu, " ").trim(), 60);
  return trimmed.length === 0 ? "" : `"${trimmed}"`;
}

function truncate(value: string, max: number) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}

/**
 * Final backstop so a pathological subagent cannot push the tool result into
 * bloat-guard territory, where the whole payload would be replaced.
 */
function capBytes(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8").subarray(0, maxBytes - 32);
  // Decode lossily, then drop a trailing replacement char so a multi-byte code
  // point split at the boundary never lands in the output.
  const decoded = buffer.toString("utf8").replace(/�$/u, "");
  return `${decoded}\n… [result truncated]`;
}

/** Child accounting is independent of the parent run, including late settlement. */
function detachedUsage(result: any, observed: any = {}) {
  const usage = result?.usage ?? {};
  return { input: numberOrZero(usage.input_tokens ?? usage.input ?? usage.inputTokens ?? observed.input),
    output: numberOrZero(usage.output_tokens ?? usage.output ?? usage.outputTokens ?? observed.output),
    cacheRead: numberOrZero(usage.cache_read_tokens ?? usage.cacheRead ?? usage.cacheReadTokens ?? observed.cacheRead),
    cacheWrite: numberOrZero(usage.cache_write_tokens ?? usage.cache_creation_tokens ?? usage.cacheWrite ?? usage.cacheWriteTokens ?? observed.cacheWrite),
    costUsd: numberOrZero(usage.cost_usd ?? result?.cost?.total ?? result?.cost?.totalUsd ?? usage.cost?.total ?? observed.costUsd) };
}

const CHILD_RUN_FAILURE = Symbol("mono-agent.childRunFailure");

/** Tag an error raised by this tool's own child run so start-failure sanitizing leaves it intact. */
function markChildRunFailure(error: any) {
  try {
    if (typeof error === "object" && error !== null && Object.isExtensible(error)) {
      Object.defineProperty(error, CHILD_RUN_FAILURE, { value: true });
    }
  } catch { /* Untagged errors are sanitized, which is the safe default. */ }
  return error;
}

function isChildRunFailure(error: any) {
  try { return typeof error === "object" && error !== null && Object.getOwnPropertyDescriptor(error, CHILD_RUN_FAILURE)?.value === true; }
  catch { return false; }
}

export type RuntimeSubagentDefinition = import("../../contracts/runtime.js").RuntimeSubagentDefinition;

export type RuntimeSubagentsOptions = import("../../contracts/runtime.js").RuntimeSubagentsOptions;
