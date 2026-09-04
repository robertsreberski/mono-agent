// @ts-check
// Compatibility boundary between mono-agent's Pi-native bridge and the
// lane-based AgentHarness API introduced in pi-agent-core 0.85.

import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  getOrThrow,
} from "@earendil-works/pi-agent-core";

export const PI_CONTEXT = BACKGROUND_CONTEXT;

function operationError(record, fallback) {
  const error = new Error(record?.error?.message || fallback);
  if (record?.error?.code) /** @type {any} */ (error).code = record.error.code;
  return error;
}

function isContextMessage(message) {
  return message?.role !== "assistant"
    || !["error", "aborted", "deferred"].includes(message.stopReason);
}

/**
 * Pi 0.85 no longer exports its session-context projector. Reproduce the
 * public entry contract here so transcript accounting uses the same latest-
 * compaction and failed-assistant filtering rules as the harness.
 * @param {any[]} pathEntries
 * @param {{includeFailed?: boolean}} [options]
 */
export function buildPiSessionContext(pathEntries, { includeFailed = false } = {}) {
  let start = 0;
  for (let index = pathEntries.length - 1; index >= 0; index -= 1) {
    if (pathEntries[index]?.type === "compaction") {
      start = index;
      break;
    }
  }
  const entries = start > 0 ? pathEntries.slice(start) : pathEntries;
  const messages = [];
  for (const entry of entries) {
    if (entry?.type === "message") {
      if (includeFailed || isContextMessage(entry.message)) messages.push(entry.message);
    } else if (entry?.type === "compaction") {
      messages.push(createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp));
      messages.push(...(includeFailed
        ? (entry.retainedTail || [])
        : (entry.retainedTail || []).filter(isContextMessage)));
    } else if (entry?.type === "branch_summary" && entry.summary) {
      messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
    }
  }
  return messages;
}

/**
 * Give the surrounding bridge the small session surface it used before Pi
 * moved branch operations onto AgentLane. The raw session remains available to
 * AgentHarness.create(), while all transcript reads and writes use the attached
 * main lane once the harness exists.
 * @param {any} rawSession
 */
export function createPiSessionAdapter(rawSession) {
  let lane = null;
  let harness = null;
  let closePromise = null;

  const requireLane = () => {
    if (!lane) throw new Error("Pi session lane is not attached");
    return lane;
  };

  return {
    rawSession,
    get metadata() { return rawSession.metadata; },
    attach(nextHarness, nextLane) {
      harness = nextHarness;
      lane = nextLane;
    },
    async buildContext() {
      const entries = await requireLane().findEntries({ order: "oldestFirst" }, PI_CONTEXT);
      // This bridge-facing transcript includes terminal error/abort messages so
      // result classification can observe them. Pi filters those only when it
      // constructs the next provider request.
      return { messages: buildPiSessionContext(entries, { includeFailed: true }) };
    },
    getEntries() {
      return requireLane().findEntries({ order: "oldestFirst" }, PI_CONTEXT);
    },
    getLeafId() {
      return requireLane().getTipId(PI_CONTEXT);
    },
    appendMessage(message) {
      return requireLane().appendMessage(message, PI_CONTEXT);
    },
    async moveTo(targetId) {
      const result = getOrThrow(await requireLane().navigateTree(
        targetId,
        { summarize: false },
        PI_CONTEXT,
      ));
      const record = result.navigation;
      if (record.status === "failed") throw operationError(record, "Pi session navigation failed");
      if (record.status !== "completed") throw operationError(record, "Pi session navigation was not completed");
      return record.tipId;
    },
    getMetadata() {
      return Promise.resolve(rawSession.metadata);
    },
    close() {
      if (!closePromise) {
        closePromise = (harness
          ? harness.close(PI_CONTEXT)
          : rawSession.close(PI_CONTEXT));
      }
      return closePromise;
    },
  };
}

function adaptTool(tool) {
  return {
    ...tool,
    async execute(toolCallId, params, onUpdate, _toolContext, _invocation, context) {
      return tool.execute(toolCallId, params, context.abortSignal, onUpdate);
    },
  };
}

const FORWARDED_EVENT_TYPES = [
  "run_start",
  "run_resume",
  "run_suspend",
  "operation_abort",
  "run_end",
  "fault",
  "handler_error",
  "turn_start",
  "turn_end",
  "retry_scheduled",
  "retry_start",
  "retry_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_start",
  "tool_update",
  "tool_end",
  "entry_added",
  "queue_update",
  "value_update",
  "config_update",
  "compaction_start",
  "compaction_end",
  "navigation_start",
  "navigation_end",
  "lane_created",
  "usage",
];

function legacyEvent(event) {
  // appendMessage() emits runless lifecycle events for transcript seeding.
  // They are persistence notifications, not output from the active provider
  // run, and forwarding them would manufacture assistant boundaries/usage for
  // prior history. Real run-owned message events always carry runId in Pi 0.85.
  if ((event.type === "message_start" || event.type === "message_end") && !event.runId) {
    return null;
  }
  if (event.type === "message_update") {
    return { ...event, assistantMessageEvent: event.event };
  }
  if (event.type === "tool_start") return { ...event, type: "tool_execution_start" };
  if (event.type === "tool_update") return { ...event, type: "tool_execution_update" };
  if (event.type === "tool_end") return { ...event, type: "tool_execution_end" };
  return event;
}

/**
 * Attach Pi 0.85's harness to one session and expose the intentionally small
 * surface consumed by mono-agent's turn runner.
 * @param {any} session
 * @param {any} options
 */
export async function createPiHarnessAdapter(session, options) {
  const originalTools = Array.isArray(options.tools) ? options.tools : [];
  const adaptedTools = originalTools.map(adaptTool);
  const activeToolNames = originalTools.map((tool) => tool.name);
  // Pi 0.85 removed mixed per-tool scheduling from AgentHarness: its runner
  // consults only this global setting. Preserve the safety contract by
  // serializing the batch whenever any offered tool is stateful, mutating, or
  // MCP-backed. Read-only-only tool sets can still overlap in safe-parallel.
  const toolExecution = originalTools.some((tool) => tool?.executionMode === "sequential")
    ? "sequential"
    : "parallel";

  /** @type {any} */
  let created;
  /** @type {any} */
  let rawHarness;
  /** @type {any} */
  let lane;
  try {
    created = await AgentHarness.create({
      ...options,
      session: session.rawSession,
      tools: adaptedTools,
      activeToolNames,
      toolExecution,
      // mono-agent owns proactive/reactive compaction policy. The permanent hook
      // below also declines Pi's overflow recovery so one bridge never runs two
      // competing policies.
      compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    }, PI_CONTEXT);
    rawHarness = created.harness;
    // Attach the harness before lane/configuration awaits so any later failure
    // can close the partially constructed handle instead of wedging the repo.
    session.attach(rawHarness, null);
    lane = await rawHarness.lane("main", PI_CONTEXT);
    session.attach(rawHarness, lane);

    // A restored lane carries its prior configuration, so explicitly bind it to
    // this run's model, effort, and available tools. Legacy v3 transcripts import
    // with an empty active-tool list and are upgraded atomically by Pi on write.
    await rawHarness.setTools(adaptedTools, PI_CONTEXT);
    await lane.setModel({ provider: options.model.provider, modelId: options.model.id }, PI_CONTEXT);
    await lane.setThinkingLevel(options.thinkingLevel ?? "off", PI_CONTEXT);
    await lane.setActiveTools(activeToolNames, PI_CONTEXT);

    rawHarness.hooks.on("before_compaction", (event) => (
      event.reason === "manual" ? undefined : { decline: true }
    ), { id: "mono-agent-compaction-owner" });
  } catch (error) {
    try { await session.close(); } catch { /* preserve the construction error */ }
    throw error;
  }

  let closed = false;
  let currentModel = options.model;
  let currentThinkingLevel = options.thinkingLevel ?? "off";
  let currentActiveToolNames = [...activeToolNames];
  const manuallyAppendedEntryIds = new Set();

  const adapter = {
    models: options.models,
    getModel: () => currentModel,
    getThinkingLevel: () => currentThinkingLevel,
    getActiveTools: () => originalTools.filter((tool) => currentActiveToolNames.includes(tool.name)),
    async setActiveTools(names) {
      await lane.setActiveTools(names, PI_CONTEXT);
      currentActiveToolNames = [...names];
    },
    async setCompactionSettings(settings) {
      await rawHarness.setCompactionSettings(settings, PI_CONTEXT);
    },
    async appendMessage(message) {
      const entryId = await lane.appendMessage(message, PI_CONTEXT);
      manuallyAppendedEntryIds.add(entryId);
      return entryId;
    },
    async prompt(text, promptOptions) {
      return getOrThrow(await lane.prompt(text, promptOptions?.images, PI_CONTEXT));
    },
    async steer(message) {
      return getOrThrow(await lane.steer(message, undefined, PI_CONTEXT));
    },
    async abort() {
      const result = await lane.abort(PI_CONTEXT);
      // Aborting an already-idle lane is a benign race with prompt settlement.
      if (!result.ok) {
        const error = /** @type {{error: any}} */ (result).error;
        if (error?._tag !== "NoActiveOperation") throw error;
      }
    },
    waitForIdle() {
      return lane.waitForIdle(PI_CONTEXT);
    },
    async compact() {
      const value = getOrThrow(await lane.compact(undefined, PI_CONTEXT));
      const record = value.compaction;
      if (record.status === "failed") throw operationError(record, "Pi compaction failed");
      if (record.status !== "completed") throw operationError(record, "Pi compaction cancelled");
      const entry = record.tipId
        ? await session.rawSession.getEntry(record.tipId, PI_CONTEXT)
        : undefined;
      if (!entry || entry.type !== "compaction") {
        throw new Error("Pi compaction completed without a compaction entry");
      }
      return entry;
    },
    on(type, handler) {
      if (type === "tool_result") {
        return rawHarness.hooks.on("after_tool", (event) => handler(event));
      }
      if (type === "session_before_compact") {
        return rawHarness.hooks.on("before_compaction", async (event, context) => {
          const branchEntries = await lane.findEntries({ order: "oldestFirst" }, context);
          const result = await handler({
            ...event,
            branchEntries,
            signal: context.abortSignal,
            context,
          });
          if (result?.cancel) return { decline: true };
          return result?.compaction === undefined ? undefined : { compaction: result.compaction };
        });
      }
      throw new Error(`Unsupported Pi harness hook: ${String(type)}`);
    },
    subscribe(listener) {
      const removes = FORWARDED_EVENT_TYPES.map((type) => rawHarness.events.on(
        /** @type {any} */ (type),
        (event) => {
          if (event.type === "message_end" && manuallyAppendedEntryIds.has(event.entryId)) return;
          const converted = legacyEvent(event);
          if (converted) listener(converted);
        },
      ));
      return () => removes.forEach((remove) => remove());
    },
    async abortOpenOperations() {
      if (!created.open.some((operation) => operation.lane === "main")) return;
      // mono-agent tools predate Pi's invocation memo/checkpoint API, so replaying
      // an interrupted durable operation could repeat an external side effect.
      // Fail closed by settling it as aborted before admitting a new prompt.
      getOrThrow(await lane.abort(PI_CONTEXT));
      await lane.waitForIdle(PI_CONTEXT);
    },
    async close() {
      if (closed) return;
      closed = true;
      await session.close();
    },
  };

  return adapter;
}
