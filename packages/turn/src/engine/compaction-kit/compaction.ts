// Adapted from @earendil-works/pi-agent-core 0.99.2 (MIT).
// Copyright (c) 2025 Mario Zechner. See harness/THIRD_PARTY_NOTICES.md.
import { contentText, retryAssistantCall, uuidv7, } from "@earendil-works/pi-ai";
import { createBranchSummaryMessage, createCompactionSummaryMessage } from "./messages.js";
import { buildContextEntries, sessionEntryToContextMessages } from "./context.js";
import { CompactionError, err, ok } from "./result.js";
import { historicalTuples, missingHistoricalTuples, planSummaryBudget, protectedHistoricalInput, type PreservationDiagnostics } from "./historical-preservation.js";
import { addUsage, sumKnownSummaryUsage } from "./usage.js";
import { createFileOps, extractFileOpsFromMessage, serializeSummaryConversation, } from "./utils.js";
function safeJsonStringify(value: any) {
    try {
        return JSON.stringify(value) ?? "undefined";
    }
    catch {
        return "[unserializable]";
    }
}
function extractFileOperations(messages: any, entries: any, prevCompactionIndex: any) {
    const fileOps = createFileOps();
    if (prevCompactionIndex >= 0) {
        const prevCompaction = entries[prevCompactionIndex];
        if (typeof prevCompaction.details === "object" &&
            prevCompaction.details !== null &&
            !Array.isArray(prevCompaction.details)) {
            if (Array.isArray(prevCompaction.details.readFiles)) {
                for (const path of prevCompaction.details.readFiles) {
                    if (typeof path === "string")
                        fileOps.read.add(path);
                }
            }
            if (Array.isArray(prevCompaction.details.modifiedFiles)) {
                for (const path of prevCompaction.details.modifiedFiles) {
                    if (typeof path === "string")
                        fileOps.edited.add(path);
                }
            }
        }
    }
    for (const msg of messages) {
        extractFileOpsFromMessage(msg, fileOps);
    }
    return fileOps;
}
function getMessageFromEntry(entry: any) {
    if (entry.type === "message") {
        return entry.message;
    }
    if (entry.type === "branch_summary") {
        return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
    }
    if (entry.type === "compaction") {
        return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
    }
    return undefined;
}
function getMessageFromEntryForCompaction(entry: any) {
    if (entry.type === "compaction") {
        return undefined;
    }
    return getMessageFromEntry(entry);
}
function createSummaryRequestOptions(options: any, context: any) {
    return {
        ...options,
        signal: context.abortSignal,
        telemetryContext: context.telemetryContext,
        cacheRetention: "none",
        sessionId: options.sessionId ?? uuidv7(),
    };
}
async function completeSimpleWithRetries(models: any, model: any, aiContext: any, options: any, retry: any, callbacks: any, context: any) {
    // Summaries are standalone requests, so isolate routing and avoid cache writes that cannot be reused.
    const requestOptions = createSummaryRequestOptions(options, context);
    return retryAssistantCall(() => models.completeSimple(model, aiContext, requestOptions), retry, requestOptions.signal, callbacks);
}

/** Calculate total context tokens from provider usage. */
export function calculateContextTokens(usage: any) {
    return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function getAssistantUsage(msg: any) {
    if (msg.role === "assistant" && "usage" in msg) {
        const assistantMsg = msg;
        if (assistantMsg.stopReason !== "aborted" &&
            assistantMsg.stopReason !== "error" &&
            assistantMsg.usage &&
            calculateContextTokens(assistantMsg.usage) > 0) {
            return assistantMsg.usage;
        }
    }
    return undefined;
}
/** Return usage from the last valid assistant message in session entries. */
export function getLastAssistantUsage(entries: any) {
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type === "message") {
            const usage = getAssistantUsage(entry.message);
            if (usage)
                return usage;
        }
    }
    return undefined;
}
function getLastAssistantUsageInfo(messages: any) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const usage = getAssistantUsage(messages[i]);
        if (usage)
            return { usage, index: i };
    }
    return undefined;
}
/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(messages: any): { tokens: any; usageTokens: any; trailingTokens: number; lastUsageIndex: number | null };
export function estimateContextTokens(messages: any): { tokens: any; usageTokens: any; trailingTokens: number; lastUsageIndex: number | null } {
    const usageInfo = getLastAssistantUsageInfo(messages);
    if (!usageInfo) {
        let estimated = 0;
        for (const message of messages) {
            estimated += estimateTokens(message);
        }
        return {
            tokens: estimated,
            usageTokens: 0,
            trailingTokens: estimated,
            lastUsageIndex: null,
        };
    }
    const usageTokens = calculateContextTokens(usageInfo.usage);
    let trailingTokens = 0;
    for (let i = usageInfo.index + 1; i < messages.length; i++) {
        trailingTokens += estimateTokens(messages[i]);
    }
    return {
        tokens: usageTokens + trailingTokens,
        usageTokens,
        trailingTokens,
        lastUsageIndex: usageInfo.index,
    };
}
/** Return whether context usage exceeds the configured compaction threshold. */
export function shouldCompact(contextTokens: any, contextWindow: any, settings: any) {
    if (!settings.enabled)
        return false;
    return contextTokens > contextWindow - settings.reserveTokens;
}
const ESTIMATED_IMAGE_CHARS = 4800;
function estimateTextAndImageContentChars(content: any) {
    if (typeof content === "string") {
        return content.length;
    }
    let chars = 0;
    for (const block of content) {
        if (block.type === "text" && block.text) {
            chars += block.text.length;
        }
        else if (block.type === "image") {
            chars += ESTIMATED_IMAGE_CHARS;
        }
    }
    return chars;
}
/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: any) {
    let chars = 0;
    switch (message.role) {
        case "user": {
            chars = estimateTextAndImageContentChars(message.content);
            return Math.ceil(chars / 4);
        }
        case "assistant": {
            const assistant = message;
            for (const block of assistant.content) {
                if (block.type === "text") {
                    chars += block.text.length;
                }
                else if (block.type === "thinking") {
                    chars += block.thinking.length;
                }
                else if (block.type === "toolCall") {
                    chars += block.name.length + safeJsonStringify(block.arguments).length;
                }
            }
            return Math.ceil(chars / 4);
        }
        case "custom":
        case "toolResult": {
            chars = estimateTextAndImageContentChars(message.content);
            return Math.ceil(chars / 4);
        }
        case "bashExecution": {
            chars = message.command.length + message.output.length;
            return Math.ceil(chars / 4);
        }
        case "branchSummary":
        case "compactionSummary": {
            chars = message.summary.length;
            return Math.ceil(chars / 4);
        }
    }
    return 0;
}
function findValidCutPoints(entries: any, startIndex: any, endIndex: any) {
    const cutPoints = [];
    for (let i = startIndex; i < endIndex; i++) {
        const entry = entries[i];
        switch (entry.type) {
            case "message": {
                const role = entry.message.role;
                switch (role) {
                    case "bashExecution":
                    case "custom":
                    case "branchSummary":
                    case "compactionSummary":
                    case "user":
                    case "assistant":
                        cutPoints.push(i);
                        break;
                    case "toolResult":
                        break;
                }
                break;
            }
            case "compaction":
            case "branch_summary":
            case "custom":
                break;
        }
        if (entry.type === "branch_summary")
            cutPoints.push(i);
    }
    return cutPoints;
}
/** Find the user-visible message that starts the turn containing an entry. */
function findTurnStartIndex(entries: any, entryIndex: any, startIndex: any) {
    for (let i = entryIndex; i >= startIndex; i--) {
        const entry = entries[i];
        if (entry.type === "branch_summary") {
            return i;
        }
        if (entry.type === "message") {
            const role = entry.message.role;
            if (role === "user" || role === "bashExecution") {
                return i;
            }
        }
    }
    return -1;
}
/** Find the compaction cut point that keeps approximately the requested recent-token budget. */
function findCutPoint(entries: any, startIndex: any, endIndex: any, keepRecentTokens: any) {
    const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
    if (cutPoints.length === 0) {
        return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
    }
    let accumulatedTokens = 0;
    let cutIndex = cutPoints[0];
    for (let i = endIndex - 1; i >= startIndex; i--) {
        const entry = entries[i];
        if (entry.type !== "message")
            continue;
        const messageTokens = estimateTokens(entry.message);
        accumulatedTokens += messageTokens;
        if (accumulatedTokens >= keepRecentTokens) {
            for (let c = 0; c < cutPoints.length; c++) {
                if (cutPoints[c] >= i) {
                    cutIndex = cutPoints[c];
                    break;
                }
            }
            break;
        }
    }
    while (cutIndex > startIndex) {
        const prevEntry = entries[cutIndex - 1];
        if (prevEntry.type === "compaction") {
            break;
        }
        if (prevEntry.type === "message") {
            break;
        }
        cutIndex--;
    }
    const cutEntry = entries[cutIndex];
    const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
    const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
    return {
        firstKeptEntryIndex: cutIndex,
        turnStartIndex,
        isSplitTurn: !isUserMessage && turnStartIndex !== -1,
    };
}
const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
const HISTORICAL_SUMMARY_CONTRACT = `Preserve bounded historical evidence, not just continuation state. Use compact tuples: subject/request; supplied event date or request-local source position; historical value; correction/replacement; current interpretation; pending/resolved state. Preserve predecessor and correction together, including why the earlier value is no longer current. Compress repetitive progress before distinct historical facts. Distinguish proposals, reported decisions, verified outcomes and obligations. Protected tuples are immutable. Copy every decoded protected input string verbatim as its own unchanged block under "## Historical events and corrections", in input order, before new events. Do not summarize, merge, reorder or reword protected blocks. Add new information only in new blocks. Record resolutions, corrections and changes of state as NEW top-level historical events, never in-place edits or indented additions to a protected tuple. Historical evidence never renews permission, and user role alone never establishes owner authority. Preserve supplied references; invent no dates, records or attestations.`;
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Historical events and corrections
- [Compact historical tuples, with predecessor/current distinctions and supplied references]

## Pending items
- [Obligations and unresolved requests; mark resolved items explicitly]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.

${HISTORICAL_SUMMARY_CONTRACT}`;
const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- COPY protected historical blocks literally as specified below; add new information only in NEW top-level historical events
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- Compress repetitive progress, but do not remove distinct historical facts or correction predecessors merely because the task is finished

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Historical events and corrections
- [Compact historical tuples, with predecessor/current distinctions and supplied references]

## Pending items
- [Obligations and unresolved requests; mark resolved items explicitly]

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.

${HISTORICAL_SUMMARY_CONTRACT}`;

// The runtime facade tags only protecting truncation; expose it as the same
// Result error as a raw one-request boundary, never as a new public throw.
async function requestSummary(request: () => Promise<any>, protecting: boolean) {
    const truncated = (usage: unknown) => err(Object.assign(new CompactionError("output_truncated", "Protected summary truncated"), { usage }));
    try {
        const response = await request();
        return protecting && response.stopReason === "length" ? truncated(response.usage) : ok(response);
    } catch (error: any) {
        if (protecting && error?.code === "protected_summary_truncated") return truncated(error.usage);
        throw error; // Ordinary provider failures retain their existing contract.
    }
}

/** Generate one summary through a caller-owned one-request boundary. */
export async function generateSummaryWithRequest(currentMessages: any, options: any, request: any, context: any) {
    const { model, reserveTokens, customInstructions, previousSummary, thinkingLevel } = options;
    const maxTokens = Math.min(options.textTargetTokens ?? Math.floor(0.8 * reserveTokens), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
    let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
    if (customInstructions) {
        basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
    }
    const { text: conversationText, metadata } = serializeSummaryConversation(currentMessages);
    let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
    if (previousSummary) {
        promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
    }
    const tuples = options.protectHistory === false ? [] : historicalTuples(previousSummary);
    promptText += protectedHistoricalInput(tuples) + metadata + basePrompt;
    const summarizationMessages = [
        {
            role: "user",
            content: [{ type: "text", text: promptText }],
            timestamp: Date.now(),
        },
    ];
    const completionOptions = model.reasoning && thinkingLevel && thinkingLevel !== "off"
        ? { maxTokens, reasoning: thinkingLevel }
        : { maxTokens };
    const requested = await requestSummary(() => request({ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, createSummaryRequestOptions(completionOptions, context), context), tuples.length > 0);
    if (!requested.ok) return requested;
    const response = requested.value;
    if (response.stopReason === "aborted") {
        return err(new CompactionError("aborted", response.errorMessage || "Summarization aborted"));
    }
    if (response.stopReason === "error") {
        return err(new CompactionError("summarization_failed", `Summarization failed: ${response.errorMessage || "Unknown error"}`));
    }
    const textContent = contentText(response.content);
    return ok({ text: textContent, usage: response.usage });
}
/** Prepare session entries for compaction, or return undefined when compaction is not applicable. */
export function prepareCompaction(pathEntries: any, settings: any, { nonRetainablePrefixLength = 0, retainedPredecessor }: { nonRetainablePrefixLength?: number; retainedPredecessor?: { text: string } } = {}): { ok: boolean; value?: any; error?: any; } {
    if (!Number.isSafeInteger(nonRetainablePrefixLength) || nonRetainablePrefixLength < 0
        || nonRetainablePrefixLength > pathEntries.length) return err(new CompactionError("invalid_cut", "Invalid non-retainable compaction prefix"));
    if (pathEntries.length === 0 || pathEntries[pathEntries.length - 1].type === "compaction" && nonRetainablePrefixLength === 0) {
        return ok(undefined);
    }
    let prevCompactionIndex = -1;
    for (let i = pathEntries.length - 1; i >= 0; i--) {
        if (pathEntries[i].type === "compaction") {
            prevCompactionIndex = i;
            break;
        }
    }
    let previousSummary = retainedPredecessor?.text;
    let compactableEntries = pathEntries;
    if (prevCompactionIndex >= 0) {
        const prevCompaction = pathEntries[prevCompactionIndex];
        previousSummary = prevCompaction.summary;
        const virtualRetainedEntries = prevCompaction.retainedTail.map((message: any, index: number) => ({
            type: "message",
            id: `${prevCompaction.id}:retained:${index}`,
            parentId: index === 0 ? prevCompaction.id : `${prevCompaction.id}:retained:${index - 1}`,
            seq: prevCompaction.seq,
            timestamp: message.timestamp,
            message,
        }));
        if (prevCompactionIndex < nonRetainablePrefixLength) return err(new CompactionError("invalid_cut", "Checkpoint overlaps non-retainable prefix"));
        compactableEntries = [...pathEntries.slice(0, nonRetainablePrefixLength), ...virtualRetainedEntries, ...pathEntries.slice(prevCompactionIndex + 1)];
    }
    const boundaryEnd = compactableEntries.length;
    const tokensBefore = estimateContextTokens(buildContextEntries(pathEntries).flatMap(sessionEntryToContextMessages)).tokens;
    // Inherited envelopes are immutable predecessor evidence, not a retainable
    // current tail. Clamp BEFORE producer preparation/dispatch, including the
    // split-turn start; a small current delta must not retain the inherited prefix.
    const cutPoint = nonRetainablePrefixLength === boundaryEnd
        ? { firstKeptEntryIndex: boundaryEnd, turnStartIndex: -1, isSplitTurn: false }
        : findCutPoint(compactableEntries, nonRetainablePrefixLength, boundaryEnd, settings.keepRecentTokens);
    const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
    const messagesToSummarize = [];
    for (let i = 0; i < historyEnd; i++) {
        const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
        if (msg)
            messagesToSummarize.push(msg);
    }
    const turnPrefixMessages = [];
    if (cutPoint.isSplitTurn) {
        for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
            const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
            if (msg)
                turnPrefixMessages.push(msg);
        }
    }
    const retainedTail = [];
    for (let i = cutPoint.firstKeptEntryIndex; i < boundaryEnd; i++) {
        const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
        if (msg)
            retainedTail.push(msg);
    }
    const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
    if (cutPoint.isSplitTurn) {
        for (const msg of turnPrefixMessages) {
            extractFileOpsFromMessage(msg, fileOps);
        }
    }
    return ok({
        messagesToSummarize,
        turnPrefixMessages,
        retainedTail,
        isSplitTurn: cutPoint.isSplitTurn,
        tokensBefore,
        previousSummary,
        fileOps,
        settings,
    });
}
const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

## Historical events and corrections
- [Compact historical tuples, including predecessor/current distinctions]

## Pending items
- [Pending/resolved obligations and requests]

Be concise. Preserve historical evidence as well as context for the kept suffix.

${HISTORICAL_SUMMARY_CONTRACT}`;
export { serializeConversation } from "./utils.js";
/** Generate compaction summary data from prepared session history. */
export function compact(preparation: any, models: any, model: any, customInstructions: any, thinkingLevel: any, retry: any, callbacks: any, context: any): Promise<{
  ok: false;
  error: CompactionError;
  value?: never;
} | {
  ok: true;
  value: {
    summary: string;
    tokensBefore: any;
    usage: any;
    retainedTail: any;
    details: {
      readFiles: any[];
      modifiedFiles: any[];
    };
  };
  error?: never;
}> {
    return compactWithRequest(preparation, { model, customInstructions, thinkingLevel }, (aiContext: any, options: any, requestContext: any) => completeSimpleWithRetries(models, model, aiContext, options, retry, callbacks, requestContext), context);
}
/** Generate compaction data through a caller-owned boundary for each provider request. */
export async function compactWithRequest(preparation: any, options: any, request: any, context: any): Promise<{
  ok: false;
  error: CompactionError;
  value?: never;
} | {
  ok: true;
  value: {
    summary: string;
    tokensBefore: any;
    usage: any;
    retainedTail: any;
    details: {
      readFiles: any[];
      modifiedFiles: any[];
    };
  };
  error?: never;
}> {
    const { model, customInstructions, thinkingLevel } = options;
    const { messagesToSummarize, turnPrefixMessages, retainedTail, tokensBefore, previousSummary, settings } = preparation;
    const plan = planSummaryBudget(preparation, estimateTokens);
    const { budget, split, generateHistory, tuples, protectedText, readFiles, modifiedFiles, metadata, separator,
      historyText: reusedHistory } = plan;
    let protecting = plan.protecting;
    let targets = plan.targets;
    const diagnostics: PreservationDiagnostics = preparation.preservation ?? {};
    Object.assign(diagnostics, { protectedBytes: Buffer.byteLength(tuples.join("\n")), protectedEstimateTokens: tuples.length ? budget.estimate(protectedText) : 0,
      protectedTupleCount: tuples.length, protectionActive: protecting, missingTupleCount: 0, refusalReason: null, bypassReason: null,
      protectionUnavailable: plan.parsed.protectionUnavailable, protectionUnavailableReason: plan.parsed.protectionUnavailableReason,
      finalSummaryBytes: null, finalSummaryEstimateTokens: null, hostCarriedBytes: 0, omittedProtectedTupleCount: 0 });
    const bypass = (reason: string) => {
      diagnostics.bypassReason = reason;
      protecting = false;
      diagnostics.protectionActive = false;
      targets = { history: generateHistory ? plan.originalHistory : 0, prefix: plan.originalPrefix };
    };
    const refuse = (reason: string) => {
      diagnostics.refusalReason = reason;
      return err(new CompactionError("summary_refused", `Compaction refused: ${reason}. Raise summaryMaxTokens, compact manually, or start a new session.`));
    };
    const validate = (text: string, complete = false) => {
      if (protecting && diagnostics.bypassReason) bypass(diagnostics.bypassReason);
      if (complete) {
        diagnostics.finalSummaryBytes = Buffer.byteLength(text);
        diagnostics.finalSummaryEstimateTokens = budget.estimate(text);
      }
      if (!protecting) return null;
      diagnostics.missingTupleCount = missingHistoricalTuples(tuples, text);
      return diagnostics.missingTupleCount ? "protected_tuples_missing" : !budget.fits(text) ? "summary_budget_exceeded" : null;
    };
    let historyText = reusedHistory;
    const modelLimit = model.maxTokens > 0 ? model.maxTokens : Infinity;
    if (tuples.length > 0 && (!plan.protectedFits || (generateHistory && Math.min(targets.history, modelLimit) < Math.ceil(protectedText.length / 4)))) bypass("protected_history_unfits");
    // Emergency/inherited cuts reserve at least half the actual history request
    // cap for the other template sections; the ordinary 256-unit floor is not
    // sufficient when immutable history nearly fills a model's output ceiling.
    if (protecting && preparation.preservationFallback && generateHistory
      && Math.ceil(protectedText.length / 4) > Math.floor(Math.min(targets.history, modelLimit) * 0.5)) bypass("protected_template_unfits");
    let recoveredTruncation = false;
    const generate = async (protectedCall: () => ReturnType<typeof generateSummaryWithRequest>, legacyCall: () => ReturnType<typeof generateSummaryWithRequest>) => {
      const result = await protectedCall();
      if (result.ok || result.error.code !== "output_truncated") return result;
      if (!preparation.preservationFallback) return refuse("output_truncated");
      bypass("output_truncated");
      recoveredTruncation = true;
      // Retry only the truncated part, at most once across this cut. Bypass
      // marks later requests unprotected, so legacy truncation cannot loop.
      const legacy = await legacyCall();
      if (legacy.ok) legacy.value.usage = sumKnownSummaryUsage("usage" in result.error ? result.error.usage : undefined, legacy.value.usage);
      return legacy;
    };
    let summaryUsage;
    if (generateHistory) {
      const history = () => generateSummaryWithRequest(messagesToSummarize, { model, reserveTokens: settings.reserveTokens, textTargetTokens: targets.history, protectHistory: protecting, customInstructions, previousSummary, thinkingLevel }, request, context);
      const historyResult = await generate(history, history);
      if (!historyResult.ok) return err(historyResult.error);
      historyText = historyResult.value.text;
      summaryUsage = historyResult.value.usage;
    }
    let summary = historyText;
    if (split) {
      // Validate history before buying a second request. No repair or retry.
      const reason = validate(`${historyText}${separator}${metadata}`);
      const splitReason = reason ?? (protecting && !budget.fits(`${historyText}${separator}${metadata}`, budget.minimum) ? "summary_budget_exceeded" : null);
      if (splitReason) {
        if (!preparation.preservationFallback) return refuse(splitReason);
        bypass(splitReason); // Reuse the already generated history; never buy a replacement.
      }
      const prefixTarget = protecting ? Math.min(targets.prefix, budget.limit - budget.estimate(`${historyText}${separator}${metadata}`)) : targets.prefix;
      const turnPrefixResult = await generate(
        () => generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, thinkingLevel, request, context, prefixTarget, protecting),
        () => generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, thinkingLevel, request, context, targets.prefix, false));
      if (!turnPrefixResult.ok) return err(turnPrefixResult.error);
      summary = `${historyText}${separator}${turnPrefixResult.value.text}`;
      summaryUsage = recoveredTruncation && generateHistory ? sumKnownSummaryUsage(summaryUsage, turnPrefixResult.value.usage)
        : summaryUsage ? addUsage(summaryUsage, turnPrefixResult.value.usage) : turnPrefixResult.value.usage;
    }
    summary += metadata;
    const reason = validate(summary, true);
    if (reason) {
      if (!preparation.preservationFallback) return refuse(reason);
      bypass(reason); // Legacy composition accepts the same provider output.
    }
    return ok({ summary, tokensBefore, usage: summaryUsage, retainedTail, details: { readFiles, modifiedFiles } });
}

async function generateTurnPrefixSummary(messages: any, model: any, reserveTokens: any, thinkingLevel: any, request: any, context: any, textTargetTokens?: number, protecting = false) {
    const maxTokens = Math.min(textTargetTokens ?? Math.floor(0.5 * reserveTokens), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
    const { text: conversationText, metadata } = serializeSummaryConversation(messages);
    const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${metadata}${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
    const summarizationMessages = [
        {
            role: "user",
            content: [{ type: "text", text: promptText }],
            timestamp: Date.now(),
        },
    ];
    const completionOptions = model.reasoning && thinkingLevel && thinkingLevel !== "off"
        ? { maxTokens, reasoning: thinkingLevel }
        : { maxTokens };
    const requested = await requestSummary(() => request({ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages }, createSummaryRequestOptions(completionOptions, context), context), protecting);
    if (!requested.ok) return requested;
    const response = requested.value;
    if (response.stopReason === "aborted") {
        return err(new CompactionError("aborted", response.errorMessage || "Turn prefix summarization aborted"));
    }
    if (response.stopReason === "error") {
        return err(new CompactionError("summarization_failed", `Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`));
    }
    return ok({
        text: contentText(response.content),
        usage: response.usage,
    });
}
