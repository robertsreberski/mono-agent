import { assertAgentContinuationOriginContext } from "@mono-agent/agent-contracts";
import type { RuntimeEventLike } from "@mono-agent/observability";

import { loadContextFromFiles, loadSkillIndexFromDirectory } from "../context/index.js";
import type {
  BuiltAgentContext,
  ContextBlockInput,
  HistoryMessage,
  SkillIndexEntry,
  SkillIndexSummary,
} from "../context/index.js";
import type { AgentHarnessOptions, AgentHarnessRequest } from "../types.js";
import type { SkillsCache } from "../skills/index.js";
import { AgentHarnessError } from "./error.js";
import { representedCancellationToolRecordIds } from "./cancelled-turn.js";
import { sessionContextBlock } from "./session-context.js";
import { errorMessageText } from "./value-utils.js";
import { buildToolHistoryProjection } from "../tool-history-projection.js";

export async function prepareHarnessContext(
  options: AgentHarnessOptions,
  skillsCache: SkillsCache,
  request: AgentHarnessRequest,
  contextOptions: {
    readonly historyMode: "messages" | "omitted";
    readonly turnId: string;
  },
  emit?: (event: RuntimeEventLike) => void,
): Promise<{
  readonly context: BuiltAgentContext;
  readonly memory: ContextBlockInput | undefined;
  readonly skillDisclosureEntries: readonly SkillIndexSummary[];
  readonly history: readonly HistoryMessage[];
  readonly historyOmitted: boolean;
  readonly historyAsMessages: boolean;
  readonly toolHistoryProjection: string | undefined;
}> {
    const history = contextOptions.historyMode === "omitted"
      ? []
      : await loadHarnessHistory(options, request.conversationId, request.continuation);
    // Recall rides on the current user message on every turn. It remains outside
    // stable system instructions and never enters canonical history replay.
    const memory = request.continuation === undefined
      ? await loadHarnessMemory(options, request.conversationId, request.userMessage, contextOptions.turnId, emit)
      : undefined;
    const selectedSkills = await loadHarnessSkills(options, skillsCache);
    const baseContext = await loadContextFromFiles({
      identityPath: options.identityPath,
      userMessage: request.userMessage,
      session: sessionContextBlock(request, {
        hostManagedMemory: options.memory !== undefined,
        backgroundProcessJobs: options.backgroundProcessJobsAvailable?.({
          request,
          runId: contextOptions.turnId,
        }) === true,
        monitors: options.monitorsAvailable?.({
          request,
          runId: contextOptions.turnId,
        }) === true,
      }),
      ...(options.soulPath === undefined ? {} : { soulPath: options.soulPath }),
      ...(history.length === 0 ? {} : { history }),
      ...(options.skillsRoot !== undefined
        ? { skillsRoot: options.skillsRoot }
        : selectedSkills.index.length > 0
          ? { skills: selectedSkills.index }
          : {}),
      ...(options.skillDisclosure === undefined ? {} : { skillDisclosure: options.skillDisclosure }),
      // "omitted" is the confirmed-warm case: the provider owns the live
      // transcript, where an earlier ReadSkill result may remain after compaction.
      warmSession: contextOptions.historyMode === "omitted",
      ...(selectedSkills.instructions.length === 0 ? {} : { skillInstructions: selectedSkills.instructions }),
    });
    // Durable tool records are a separate store, not HistoryMessage entries.
    // A cold reseed gets a bounded neutral text projection; a confirmed warm
    // provider session gets none because it already owns the live transcript.
    let toolProjection: ReturnType<typeof buildToolHistoryProjection> = undefined;
    if (contextOptions.historyMode !== "omitted" && options.toolHistory !== undefined) {
      try {
        toolProjection = buildToolHistoryProjection(
          options.toolHistory.reader,
          options.toolHistory.logicalConversationId(request.conversationId),
          request.conversationId,
          contextOptions.turnId,
          representedCancellationToolRecordIds(history),
        );
      } catch (error) {
        const errorCode = toolHistoryProjectionErrorCode(error);
        emit?.({
          type: "runtime_warning",
          warning_kind: "tool_history_projection_degraded",
          error_code: errorCode,
          message: `Tool history projection failed (${errorCode}); continuing without automatic tool history.`,
        });
      }
    }
    const context = toolProjection === undefined
      ? baseContext
      : projectToolHistoryBeforeCurrentTurn(baseContext, toolProjection.text, toolProjection.recordCount);
    // Progressive skill disclosure (index mode, opt-in): the index is in the
    // prompt but the bodies are not — so expose a `ReadSkill` tool whose enum is
    // the discovered skill names, letting the agent pull a full body on demand.
    // 'full' mode (the default) keeps today's behavior (selectedSkills bodies
    // inlined up front) and does NOT add ReadSkill. Names load only when a
    // skillsRoot is set.
    const skillDisclosureEntries = await loadSkillDisclosureEntries(options);
    return {
      context,
      memory,
      skillDisclosureEntries,
      history,
      historyOmitted: contextOptions.historyMode === "omitted",
      historyAsMessages: contextOptions.historyMode === "messages",
      toolHistoryProjection: contextOptions.historyMode === "messages" ? toolProjection?.text : undefined,
    };
}

function toolHistoryProjectionErrorCode(error: unknown): string {
    const candidate = typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
    return typeof candidate === "string" && /^history_[a-z0-9_]+$/u.test(candidate)
      ? candidate
      : "history_projection_unavailable";
}

function projectToolHistoryBeforeCurrentTurn(
  context: BuiltAgentContext,
  projection: string,
  projectedRecordCount: number,
): BuiltAgentContext {
    const sections = [...context.sections];
    const historyIndex = sections.findIndex((section) => section.id === "history");
    const content = `### Managed Tool Lifecycles (untrusted)\n\n${projection}`;
    if (historyIndex >= 0) {
      const history = sections[historyIndex]!;
      sections[historyIndex] = { ...history, content: `${history.content}\n\n${content}` };
    } else {
      const userIndex = sections.findIndex((section) => section.id === "user-message");
      sections.splice(userIndex < 0 ? sections.length : userIndex, 0, {
        id: "history",
        title: "Conversation History",
        content,
      });
    }
    return {
      ...context,
      sections,
      prompt: sections.map((section) => `## ${section.title}\n\n${section.content}`).join("\n\n"),
      metadata: {
        ...context.metadata,
        historyCount: context.metadata.historyCount + projectedRecordCount,
        sources: context.metadata.sources.includes("session-tool-history")
          ? context.metadata.sources
          : [...context.metadata.sources, "session-tool-history"],
      },
    };
}

/**
 * Discovers the skills the ReadSkill tool may load for progressive disclosure.
 * Full disclosure and absent roots deliberately expose no tool.
 *
 * Descriptions ride along with the names because these entries are also what a
 * subagent inherits (see the subagent run in agent-app): a child needs to render
 * its own index, and a bare name list cannot say what any skill is for. Only
 * name and description cross over — `mainFile` is an absolute host path and is
 * dropped here so it never reaches run options or a prompt built from them.
 */
async function loadSkillDisclosureEntries(options: AgentHarnessOptions): Promise<readonly SkillIndexSummary[]> {
    if ((options.skillDisclosure ?? "full") !== "index" || options.skillsRoot === undefined) {
      return [];
    }
    const entries = await loadSkillIndexFromDirectory(options.skillsRoot);
    return entries.map((entry) => ({ name: entry.name, description: entry.description }));
}

export async function loadHarnessHistory(
  options: AgentHarnessOptions,
  conversationId: string,
  continuation?: AgentHarnessRequest["continuation"],
): Promise<readonly HistoryMessage[]> {
    if (continuation?.originContext !== undefined) {
      const snapshot = continuation.originContext;
      assertAgentContinuationOriginContext(snapshot);
      if (snapshot.conversationId !== conversationId
        || snapshot.originRunId !== continuation.originRunId
        || snapshot.historyBoundary !== continuation.historyBoundary) {
        throw new AgentHarnessError(
          "origin_context_binding_mismatch",
          "The pinned continuation origin context does not match this synthesis turn.",
          { continuationId: continuation.continuationId },
        );
      }
      return snapshot.messages.map((message) => ({ ...message }));
    }
    const history = await options.historyStore?.load(conversationId) ?? [];
    if (continuation === undefined) {
      return history;
    }
    const boundary = continuation.historyBoundary;
    if (boundary === undefined) {
      return history;
    }
    let boundaryIndex = -1;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index]?.runId === boundary) {
        boundaryIndex = index;
        break;
      }
    }
    if (boundaryIndex < 0) {
      throw new AgentHarnessError(
        "history_boundary_not_found",
        "The continuation history boundary is no longer available.",
        { continuationId: continuation.continuationId, historyBoundary: boundary },
      );
    }
    return history.slice(0, boundaryIndex + 1);
}

async function loadHarnessMemory(
  options: AgentHarnessOptions,
  conversationId: string,
  query: string,
  turnId: string,
  emit?: (event: RuntimeEventLike) => void,
): Promise<ContextBlockInput | undefined> {
    let block;
    try {
      block = await options.memory?.load(conversationId, query, { turnId });
    } catch (error) {
      // A slow or failing memory backend (e.g. embeddings timeout / circuit
      // breaker open) must never block or fail the turn — degrade to empty
      // memory and surface a warning so the turn proceeds.
      emit?.({
        type: "runtime_warning",
        warning_kind: "memory_degraded",
        message: `Memory recall failed; continuing without memory. ${errorMessageText(error)}`,
      });
      return undefined;
    }
    if (block === undefined) {
      return undefined;
    }
    // Memory leaves the system-prompt trace once it moves onto the user message, so
    // emit a lightweight diagnostic (source + byte size, not the content) to keep
    // the fact that recall fired — and how much it surfaced — visible in run traces.
    emit?.({
      type: "memory_recalled",
      ...(block.source === undefined ? {} : { source: block.source }),
      bytes: Buffer.byteLength(block.content, "utf8"),
    });
    return {
      kind: "markdown",
      content: block.content,
      source: block.source,
    };
}

async function loadHarnessSkills(
  options: AgentHarnessOptions,
  skillsCache: SkillsCache,
): Promise<{
  readonly index: readonly SkillIndexEntry[];
  readonly instructions: readonly ContextBlockInput[];
}> {
    if (options.selectedSkills === undefined || options.selectedSkills.length === 0) {
      return { index: [], instructions: [] };
    }
    if (options.skillsRoot === undefined) {
      throw new AgentHarnessError("invalid_skill_selection", "selectedSkills requires skillsRoot.");
    }
    return await skillsCache.loadSelectedSkillsCached({
      skillsRoot: options.skillsRoot,
      names: options.selectedSkills,
      ...(options.skillMaxBytes === undefined ? {} : { maxBytes: options.skillMaxBytes }),
    });
}
