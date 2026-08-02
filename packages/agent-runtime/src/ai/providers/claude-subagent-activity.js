// Claude Code 2.1.220+ forwards native-agent lifecycle plus child messages on
// the live stream. Both the CLI and Agent SDK expose the same durable shapes:
//
//   system/task_started       task_id, tool_use_id, task_type, subagent_type
//   assistant|user            parent_tool_use_id, message.content[]
//   system/task_notification  task_id, tool_use_id, status, summary, usage
//
// Normalizing that stream directly avoids filesystem transcript replay and,
// importantly, lets the provider bridge remove child prose from the parent's
// answer while still preserving the child's nested activity for operators.

/** Matches the in-process Agent collector's per-payload wire cap. */
const WIRE_CONTENT_MAX_CHARS = 2_000;
const AGENT_TASK_TYPE = /(^|[_-])(?:sub)?agent($|[_-])/i;

/** @param {unknown} value */
function boundedText(value) {
  if (typeof value !== "string") return undefined;
  return value.length > WIRE_CONTENT_MAX_CHARS
    ? `${value.slice(0, WIRE_CONTENT_MAX_CHARS)}…`
    : value;
}

/** @param {unknown} value */
function wireContent(value) {
  if (typeof value === "string") return boundedText(value);
  if (value === undefined) return undefined;
  try {
    return boundedText(JSON.stringify(value));
  } catch {
    return boundedText(String(value));
  }
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** @param {Record<string, any>} raw */
function isAgentTask(raw) {
  if (raw?.skip_transcript === true) return false;
  if (nonEmptyString(raw?.subagent_type)) return true;
  const taskType = nonEmptyString(raw?.task_type);
  return taskType !== undefined && AGENT_TASK_TYPE.test(taskType);
}

/** @param {unknown} value */
function isAgentToolName(value) {
  return value === "Agent" || value === "Task";
}

/** @param {unknown} value */
function isExplicitBackgroundLaunchAcknowledgement(value) {
  const content = typeof value === "string" ? value.trim() : "";
  return /^Async agent launched successfully\. The agent is working in the background\.?$/iu.test(content);
}

/** @param {Record<string, any>} raw */
function rawEventKey(raw) {
  const uuid = nonEmptyString(raw?.uuid);
  if (uuid) return `${raw.type ?? "?"}:${raw.subtype ?? ""}:${uuid}`;
  try {
    return JSON.stringify([
      raw?.type,
      raw?.subtype,
      raw?.task_id,
      raw?.tool_use_id,
      raw?.parent_tool_use_id,
      raw?.message,
      raw?.status,
    ]);
  } catch {
    return undefined;
  }
}

/** @param {string} nativeId */
function orphanId(nativeId) {
  return `claude-task:${nativeId}`;
}

/**
 * Correlate Claude's live native-agent stream into provider-neutral
 * `subagent_activity` events.
 *
 * `observe()` returns `consumed: true` for every event owned by a native
 * subagent. Provider bridges must not additionally forward or interpret those
 * records as parent events. Non-agent background tasks are consumed without
 * creating activity.
 */
export function createClaudeSubagentActivityNormalizer() {
  /** @type {Map<string, any>} */
  const byParentToolUseId = new Map();
  /** @type {Map<string, any>} */
  const byNativeId = new Map();
  /** @type {Set<any>} */
  const active = new Set();
  /** @type {Set<any>} */
  const ambiguousCohorts = new Set();
  const ignoredNativeIds = new Set();
  const seenRawEvents = new Set();
  const usedNames = new Set();
  let callIndex = 0;
  let fallbackMessageIndex = 0;

  /** @param {any} entry */
  function subagentFor(entry) {
    return {
      id: entry.id,
      name: entry.name,
      callIndex: entry.callIndex,
      ...(entry.nativeId === undefined || entry.ambiguousNativeIdentity ? {} : { nativeId: entry.nativeId }),
      ...(entry.label === undefined ? {} : { label: entry.label }),
    };
  }

  /** @param {any} entry @param {Record<string, unknown>} event */
  function wrap(entry, event) {
    return { type: "subagent_activity", subagent: subagentFor(entry), ...event };
  }

  /** @param {any} entry */
  function startedEvent(entry) {
    return wrap(entry, {
      phase: "agent_started",
      id: `agent:${entry.id}`,
      name: `Agent(${entry.name})`,
      arguments: {
        name: entry.name,
        ...(entry.label === undefined ? {} : { description: entry.label }),
        ...(entry.prompt === undefined ? {} : { prompt: entry.prompt }),
      },
    });
  }

  /** @param {any} entry */
  function noteName(entry) {
    if (entry.name !== "subagent" && entry.name !== entry.nativeId) usedNames.add(entry.name);
  }

  /** @param {any} entry */
  function authoredName(entry) {
    return entry.name === "subagent" || entry.name === entry.nativeId
      ? undefined
      : entry.name;
  }

  /** @param {any[]} entries */
  function ambiguousCohortFor(entries) {
    const existing = [...new Set(entries.map((entry) => entry.ambiguousCohort).filter(Boolean))];
    const cohort = existing[0] ?? { entries: new Set(), outcomes: new Map() };
    ambiguousCohorts.add(cohort);
    for (const duplicateCohort of existing.slice(1)) {
      for (const member of duplicateCohort.entries) {
        cohort.entries.add(member);
        member.ambiguousCohort = cohort;
      }
      for (const [member, outcome] of duplicateCohort.outcomes) {
        cohort.outcomes.set(member, outcome);
      }
      ambiguousCohorts.delete(duplicateCohort);
    }
    for (const entry of entries) {
      cohort.entries.add(entry);
      entry.ambiguousCohort = cohort;
      entry.ambiguousNativeIdentity = true;
    }
    return cohort;
  }

  /**
   * Claude can announce a native task before it includes the parent tool-use id
   * that is the public delegation identity. Match the two one-sided records by
   * their authored metadata, then by arrival order when Claude omitted it. The
   * latter is deliberately limited to entries missing the opposite identity;
   * a resolved task is never eligible for a second parent.
   *
   * @param {{parentToolUseId?: string, nativeId?: string, name?: string, label?: string, prompt?: string}} input
   */
  function pendingCorrelation(input) {
    const candidates = [...active].filter((entry) => {
      if (entry.terminal) return false;
      if (input.parentToolUseId !== undefined && input.nativeId === undefined) {
        return entry.parentToolUseId === undefined && entry.nativeId !== undefined;
      }
      if (input.nativeId !== undefined && input.parentToolUseId === undefined) {
        return entry.nativeId === undefined && entry.parentToolUseId !== undefined;
      }
      return false;
    });
    if (candidates.length === 0) return undefined;

    const scored = candidates.map((entry) => {
      let score = 0;
      const entryName = authoredName(entry);
      if (input.name !== undefined && entryName !== undefined) {
        if (input.name !== entryName) return { entry, score: -1 };
        score += 8;
      }
      if (input.label !== undefined && entry.label !== undefined) {
        if (input.label !== entry.label) return { entry, score: -1 };
        score += 4;
      }
      if (input.prompt !== undefined && entry.prompt !== undefined) {
        if (input.prompt !== entry.prompt) return { entry, score: -1 };
        score += 2;
      }
      return { entry, score };
    }).filter(({ score }) => score >= 0);
    scored.sort((left, right) => right.score - left.score
      || left.entry.callIndex - right.entry.callIndex);
    const bestScore = scored[0]?.score;
    const tied = bestScore === undefined
      ? []
      : scored.filter(({ score }) => score === bestScore).map(({ entry }) => entry);
    if (tied.length > 1) ambiguousCohortFor(tied);
    return scored[0]?.entry;
  }

  /** @param {any} entry @param {any} duplicate */
  function mergeEntries(entry, duplicate) {
    if (entry === duplicate) return entry;
    if (entry.ambiguousCohort || duplicate.ambiguousCohort) {
      const cohort = ambiguousCohortFor([entry, duplicate]);
      const duplicateOutcome = cohort.outcomes.get(duplicate);
      if (duplicateOutcome !== undefined && !cohort.outcomes.has(entry)) {
        cohort.outcomes.set(entry, duplicateOutcome);
      }
      cohort.outcomes.delete(duplicate);
      cohort.entries.delete(duplicate);
      cohort.entries.add(entry);
    }
    active.delete(duplicate);
    for (const [toolId, tool] of duplicate.openTools) {
      if (!entry.openTools.has(toolId)) entry.openTools.set(toolId, tool);
    }
    for (const toolId of duplicate.settledToolIds) entry.settledToolIds.add(toolId);
    entry.toolCount += duplicate.toolCount;
    entry.backgroundRequested ||= duplicate.backgroundRequested;
    entry.label ??= duplicate.label;
    entry.prompt ??= duplicate.prompt;
    if (authoredName(entry) === undefined && authoredName(duplicate) !== undefined) {
      entry.name = duplicate.name;
    }
    if (duplicate.parentToolUseId !== undefined) {
      entry.parentToolUseId ??= duplicate.parentToolUseId;
      byParentToolUseId.set(duplicate.parentToolUseId, entry);
    }
    if (duplicate.nativeId !== undefined) {
      entry.nativeId ??= duplicate.nativeId;
      byNativeId.set(duplicate.nativeId, entry);
    }
    return entry;
  }

  /** @param {any} parentEntry @param {any} nativeEntry */
  function correctAmbiguousPair(parentEntry, nativeEntry) {
    const cohort = parentEntry.ambiguousCohort;
    const previousParentNativeId = parentEntry.nativeId;
    const requestedNativeId = nativeEntry.nativeId;
    const previousParentOutcome = cohort.outcomes.get(parentEntry);
    const requestedNativeOutcome = cohort.outcomes.get(nativeEntry);
    cohort.outcomes.delete(parentEntry);
    cohort.outcomes.delete(nativeEntry);

    parentEntry.nativeId = requestedNativeId;
    nativeEntry.nativeId = previousParentNativeId;
    if (requestedNativeId !== undefined) byNativeId.set(requestedNativeId, parentEntry);
    if (previousParentNativeId !== undefined) byNativeId.set(previousParentNativeId, nativeEntry);
    if (requestedNativeOutcome !== undefined) cohort.outcomes.set(parentEntry, requestedNativeOutcome);
    if (previousParentOutcome !== undefined) cohort.outcomes.set(nativeEntry, previousParentOutcome);
    return parentEntry;
  }

  /**
   * @param {{parentToolUseId?: string, nativeId?: string, name?: string, label?: string, prompt?: string, backgroundRequested?: boolean}} input
   */
  function entryFor(input) {
    const parentEntry = input.parentToolUseId === undefined
      ? undefined
      : byParentToolUseId.get(input.parentToolUseId);
    const nativeEntry = input.nativeId === undefined
      ? undefined
      : byNativeId.get(input.nativeId);
    let entry = parentEntry ?? nativeEntry;
    if (parentEntry && nativeEntry && parentEntry !== nativeEntry) {
      if (parentEntry.ambiguousCohort
        && parentEntry.ambiguousCohort === nativeEntry.ambiguousCohort) {
        // A later notification carrying both ids is authoritative. Correct the
        // provisional pair without merging away the other canonical group.
        entry = correctAmbiguousPair(parentEntry, nativeEntry);
      } else {
        // Prefer the parent-keyed entry: its id is already the public canonical
        // id, while native-only entries have deliberately emitted no lifecycle.
        entry = mergeEntries(parentEntry, nativeEntry);
      }
    }
    if (!entry) entry = pendingCorrelation(input);
    if (!entry) {
      const id = input.parentToolUseId ?? orphanId(input.nativeId ?? `unknown-${callIndex}`);
      entry = {
        id,
        parentToolUseId: input.parentToolUseId,
        nativeId: input.nativeId,
        name: input.name ?? input.nativeId ?? "subagent",
        label: input.label,
        prompt: input.prompt,
        backgroundRequested: input.backgroundRequested === true,
        callIndex: callIndex++,
        started: false,
        terminal: false,
        toolCount: 0,
        openTools: new Map(),
        settledToolIds: new Set(),
      };
      active.add(entry);
    }

    if (input.parentToolUseId !== undefined) {
      entry.parentToolUseId ??= input.parentToolUseId;
      // Native-only task_started records remain silent until this correlation,
      // so changing the provisional orphan id here cannot invalidate an event
      // already sent to consumers.
      if (!entry.started) entry.id = entry.parentToolUseId;
      byParentToolUseId.set(input.parentToolUseId, entry);
    }
    if (input.nativeId !== undefined) {
      entry.nativeId ??= input.nativeId;
      byNativeId.set(input.nativeId, entry);
    }
    if (input.name !== undefined && (entry.name === "subagent" || entry.name === entry.nativeId)) {
      entry.name = input.name;
    }
    entry.label ??= input.label;
    entry.prompt ??= input.prompt;
    entry.backgroundRequested ||= input.backgroundRequested === true;
    noteName(entry);
    return entry;
  }

  /** @param {any} entry */
  function ensureStarted(entry) {
    if (entry.started || entry.terminal) return [];
    entry.started = true;
    return [startedEvent(entry)];
  }

  /** @param {any} entry @param {string} reason */
  function drainTools(entry, reason) {
    const events = [];
    for (const [toolId, tool] of entry.openTools) {
      if (entry.settledToolIds.has(toolId)) continue;
      entry.settledToolIds.add(toolId);
      events.push(wrap(entry, {
        phase: "completed",
        id: `agent:${entry.id}:${toolId}`,
        name: `${entry.name}▸${tool.name}`,
        isError: true,
        content: reason,
      }));
    }
    entry.openTools.clear();
    return events;
  }

  /**
   * @param {any} entry
   * @param {{status?: string, summary?: string, usage?: Record<string, unknown>, reason?: string}} outcome
   */
  function finish(entry, outcome) {
    if (entry.terminal) return [];
    const status = outcome.status ?? "ended";
    const reason = outcome.reason ?? "subagent ended before this tool returned";
    const events = [
      ...ensureStarted(entry),
      ...drainTools(entry, reason),
    ];
    entry.terminal = true;
    active.delete(entry);
    const usage = outcome.usage && typeof outcome.usage === "object" ? outcome.usage : {};
    const reportedToolUses = Number(usage.tool_uses);
    const toolUses = Number.isFinite(reportedToolUses) ? reportedToolUses : entry.toolCount;
    events.push(wrap(entry, {
      phase: "agent_completed",
      id: `agent:${entry.id}`,
      name: `Agent(${entry.name})`,
      isError: status !== "completed",
      ...(Number.isFinite(Number(usage.duration_ms)) ? { executionMs: Number(usage.duration_ms) } : {}),
      content: boundedText(outcome.summary) ?? `${status} · ${toolUses} tool call${toolUses === 1 ? "" : "s"}`,
      ...(Number.isFinite(Number(usage.total_tokens)) ? { totalTokens: Number(usage.total_tokens) } : {}),
    }));
    return events;
  }

  /**
   * Multiple metadata-identical native starts cannot be safely attributed when
   * their child frames omit task_description. Keep each canonical parent group
   * open until the whole tied cohort settles, then close every parent exactly
   * once with an aggregate outcome instead of attaching the wrong native
   * terminal to whichever child frame happened to arrive first.
   *
   * @param {any} cohort
   * @param {string} [fallbackReason]
   */
  function settleAmbiguousCohort(cohort, fallbackReason) {
    const nativeEntries = [...cohort.entries].filter((entry) => entry.nativeId !== undefined);
    if (fallbackReason !== undefined) {
      for (const entry of nativeEntries) {
        if (!cohort.outcomes.has(entry)) {
          cohort.outcomes.set(entry, {
            status: "stopped",
            summary: fallbackReason,
            reason: fallbackReason,
          });
        }
      }
    }
    if (nativeEntries.some((entry) => !cohort.outcomes.has(entry))) return [];

    const outcomes = nativeEntries.map((entry) => cohort.outcomes.get(entry));
    const statuses = outcomes.map((outcome) => outcome?.status ?? "ended");
    const allCompleted = statuses.every((status) => status === "completed");
    const status = allCompleted ? "completed" : statuses.find((value) => value !== "completed") ?? "ended";
    const count = nativeEntries.length;
    const summary = allCompleted
      ? `${count} concurrent subagent${count === 1 ? "" : "s"} completed`
      : fallbackReason ?? `concurrent subagents settled: ${[...new Set(statuses)].join(", ")}`;
    const events = [];
    for (const entry of cohort.entries) {
      if (entry.parentToolUseId !== undefined) {
        events.push(...finish(entry, { status, summary, reason: fallbackReason }));
      } else {
        // The native-only placeholder never published a lifecycle. Discard it
        // rather than inventing an orphan group alongside the canonical ones.
        entry.terminal = true;
        active.delete(entry);
      }
    }
    ambiguousCohorts.delete(cohort);
    return events;
  }

  /** @param {Record<string, any>} raw @param {any} entry */
  function childMessageEvents(raw, entry) {
    const events = [...ensureStarted(entry)];
    const blocks = Array.isArray(raw?.message?.content) ? raw.message.content : [];
    const messageKey = nonEmptyString(raw.uuid) ?? `event-${fallbackMessageIndex++}`;

    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
      const block = blocks[blockIndex];
      if (block?.type === "tool_use" && nonEmptyString(block.id)) {
        const toolId = nonEmptyString(block.id);
        if (entry.openTools.has(toolId) || entry.settledToolIds.has(toolId)) continue;
        const name = nonEmptyString(block.name) ?? "?";
        entry.openTools.set(toolId, { name });
        entry.toolCount += 1;
        events.push(wrap(entry, {
          phase: "started",
          id: `agent:${entry.id}:${toolId}`,
          name: `${entry.name}▸${name}`,
          arguments: block.input,
        }));
        continue;
      }

      if (block?.type === "tool_result" && nonEmptyString(block.tool_use_id)) {
        const toolId = nonEmptyString(block.tool_use_id);
        if (entry.settledToolIds.has(toolId)) continue;
        const openTool = entry.openTools.get(toolId);
        entry.openTools.delete(toolId);
        entry.settledToolIds.add(toolId);
        events.push(wrap(entry, {
          phase: "completed",
          id: `agent:${entry.id}:${toolId}`,
          name: `${entry.name}▸${openTool?.name ?? "?"}`,
          isError: block.is_error === true,
          ...(wireContent(block.content) === undefined ? {} : { content: wireContent(block.content) }),
        }));
        continue;
      }

      const kind = block?.type === "thinking" || block?.type === "redacted_thinking"
        ? "thinking"
        : block?.type === "text"
          ? "text"
          : undefined;
      if (kind === undefined) continue;
      const content = kind === "thinking"
        ? boundedText(block.thinking ?? block.text)
        : boundedText(block.text);
      if (!content) continue;
      events.push(wrap(entry, {
        phase: "message",
        id: `agent:${entry.id}:message:${messageKey}:${blockIndex}`,
        name: `${entry.name}▸${kind}`,
        kind,
        role: raw.type === "user" ? "user" : "assistant",
        content,
      }));
    }
    return events;
  }

  /** @param {Record<string, any>} raw */
  function observe(raw) {
    if (!raw || typeof raw !== "object") return { consumed: false, events: [] };

    // Partial child deltas are intentionally not projected. Their finalized
    // assistant message follows with the same content, and emitting both would
    // violate the exactly-once activity contract.
    if (raw.type === "stream_event" && nonEmptyString(raw.parent_tool_use_id)) {
      return { consumed: true, events: [] };
    }

    // Foreground Task/Agent calls have no task_started/task_notification
    // bookends in Claude 2.1.220. Seed their identity from the parent's tool_use
    // so otherwise-metadata-free child frames still get the authored name and
    // label. Keep the parent event on the normal stream.
    if (raw.type === "assistant" && !nonEmptyString(raw.parent_tool_use_id)) {
      for (const block of Array.isArray(raw?.message?.content) ? raw.message.content : []) {
        if (block?.type !== "tool_use" || !isAgentToolName(block.name) || !nonEmptyString(block.id)) continue;
        const input = block.input && typeof block.input === "object" ? block.input : {};
        entryFor({
          parentToolUseId: nonEmptyString(block.id),
          name: nonEmptyString(input.subagent_type ?? input.name),
          label: nonEmptyString(input.description),
          prompt: boundedText(input.prompt),
          backgroundRequested: input.run_in_background === true,
        });
      }
      return { consumed: false, events: [] };
    }

    // A synchronous native child settles through the parent's Task tool_result,
    // not task_notification. Background launches also produce a parent result,
    // but it is launch metadata rather than completion. Consume a pure launch
    // acknowledgement so ordinary tool-call consumers cannot close the group;
    // the task notification (or terminal drain) owns that lifecycle transition.
    if (raw.type === "user" && !nonEmptyString(raw.parent_tool_use_id)) {
      const events = [];
      const blocks = Array.isArray(raw?.message?.content) ? raw.message.content : [];
      const forwardedBlocks = [];
      let launchAcknowledgements = 0;
      for (const block of blocks) {
        if (block?.type !== "tool_result" || !nonEmptyString(block.tool_use_id)) {
          forwardedBlocks.push(block);
          continue;
        }
        const entry = byParentToolUseId.get(nonEmptyString(block.tool_use_id));
        const launchOnly = entry !== undefined && (entry.backgroundRequested
          || isExplicitBackgroundLaunchAcknowledgement(block.content));
        if (launchOnly && block.is_error !== true) {
          launchAcknowledgements += 1;
          continue;
        }
        forwardedBlocks.push(block);
        if (!entry || entry.terminal) continue;
        const isError = block.is_error === true;
        events.push(...finish(entry, {
          status: isError ? "failed" : "completed",
          summary: wireContent(block.content),
          reason: isError
            ? "subagent tool failed before returning"
            : "subagent ended before this tool returned",
        }));
      }
      if (launchAcknowledgements === 0) return { consumed: false, events };
      if (forwardedBlocks.length === 0) return { consumed: true, events };
      return {
        consumed: false,
        events,
        forwarded: {
          ...raw,
          message: { ...raw.message, content: forwardedBlocks },
        },
      };
    }

    if ((raw.type === "assistant" || raw.type === "user") && nonEmptyString(raw.parent_tool_use_id)) {
      const key = rawEventKey(raw);
      if (key !== undefined && seenRawEvents.has(key)) return { consumed: true, events: [] };
      if (key !== undefined) seenRawEvents.add(key);
      const entry = entryFor({
        parentToolUseId: nonEmptyString(raw.parent_tool_use_id),
        name: nonEmptyString(raw.subagent_type),
        label: nonEmptyString(raw.task_description),
      });
      if (entry.terminal) return { consumed: true, events: [] };
      return { consumed: true, events: childMessageEvents(raw, entry) };
    }

    if (raw.type === "tool_progress" && nonEmptyString(raw.parent_tool_use_id)) {
      // The finalized tool_use/tool_result blocks carry the durable activity.
      return { consumed: true, events: [] };
    }

    if (raw.type !== "system") return { consumed: false, events: [] };

    if (raw.subtype === "background_tasks_changed") {
      for (const task of Array.isArray(raw.tasks) ? raw.tasks : []) {
        const nativeId = nonEmptyString(task?.task_id);
        if (nativeId && !isAgentTask(task)) ignoredNativeIds.add(nativeId);
      }
      return { consumed: true, events: [] };
    }

    const nativeId = nonEmptyString(raw.task_id);
    if (!nativeId) return { consumed: false, events: [] };

    if (raw.subtype === "task_started") {
      const key = rawEventKey(raw);
      if (key !== undefined && seenRawEvents.has(key)) return { consumed: true, events: [] };
      if (key !== undefined) seenRawEvents.add(key);
      if (!isAgentTask(raw)) {
        ignoredNativeIds.add(nativeId);
        return { consumed: true, events: [] };
      }
      ignoredNativeIds.delete(nativeId);
      const entry = entryFor({
        nativeId,
        parentToolUseId: nonEmptyString(raw.tool_use_id),
        name: nonEmptyString(raw.subagent_type),
        label: nonEmptyString(raw.description),
        prompt: boundedText(raw.prompt),
      });
      // A native id is diagnostic metadata, not the public delegation key.
      // Wait for a parent frame (or a terminal orphan fallback) instead of
      // publishing a second, provisional group that cannot later be renamed.
      return {
        consumed: true,
        events: entry.parentToolUseId === undefined ? [] : ensureStarted(entry),
      };
    }

    if (ignoredNativeIds.has(nativeId)) return { consumed: true, events: [] };

    if (raw.subtype === "task_progress") {
      let entry = byNativeId.get(nativeId);
      if (!entry && nonEmptyString(raw.subagent_type)) {
        entry = entryFor({
          nativeId,
          parentToolUseId: nonEmptyString(raw.tool_use_id),
          name: nonEmptyString(raw.subagent_type),
          label: nonEmptyString(raw.description),
        });
      }
      if (!entry) return { consumed: false, events: [] };
      return {
        consumed: true,
        events: entry.parentToolUseId === undefined ? [] : ensureStarted(entry),
      };
    }

    if (raw.subtype === "task_updated") {
      const entry = byNativeId.get(nativeId);
      if (!entry) return { consumed: false, events: [] };
      entry.label ??= nonEmptyString(raw.patch?.description);
      return { consumed: true, events: [] };
    }

    if (raw.subtype !== "task_notification") return { consumed: false, events: [] };
    if (!byNativeId.has(nativeId)
      && !nonEmptyString(raw.subagent_type)
      && raw.output_file === "") {
      // Current background Bash notifications omit task_type but carry an empty
      // output_file. Native agents carry a transcript path even though this
      // bridge never reads it.
      ignoredNativeIds.add(nativeId);
      return { consumed: true, events: [] };
    }
    if (raw.skip_transcript === true && !byNativeId.has(nativeId)) {
      ignoredNativeIds.add(nativeId);
      return { consumed: true, events: [] };
    }
    const key = rawEventKey(raw);
    if (key !== undefined && seenRawEvents.has(key)) return { consumed: true, events: [] };
    if (key !== undefined) seenRawEvents.add(key);
    const entry = entryFor({
      nativeId,
      parentToolUseId: nonEmptyString(raw.tool_use_id),
      name: nonEmptyString(raw.subagent_type),
      label: nonEmptyString(raw.description),
    });
    const outcome = {
      status: nonEmptyString(raw.status),
      summary: nonEmptyString(raw.summary),
      usage: raw.usage,
    };
    if (entry.ambiguousCohort) {
      entry.ambiguousCohort.outcomes.set(entry, outcome);
      return {
        consumed: true,
        events: settleAmbiguousCohort(entry.ambiguousCohort),
      };
    }
    return {
      consumed: true,
      events: finish(entry, outcome),
    };
  }

  return {
    observe,
    /** Close every still-open child and its tools exactly once. */
    drain(reason = "subagent stream closed before completion") {
      const events = [];
      for (const cohort of [...ambiguousCohorts]) {
        events.push(...settleAmbiguousCohort(cohort, reason));
      }
      for (const entry of [...active]) {
        events.push(...finish(entry, { status: "stopped", reason, summary: reason }));
      }
      return events;
    },
    subagentInvoked: () => callIndex > 0,
    nativeSubagentsUsed: () => [...usedNames],
  };
}
