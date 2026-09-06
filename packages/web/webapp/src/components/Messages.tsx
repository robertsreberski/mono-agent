import {
  ActionBarPrimitive,
  MessagePrimitive,
  type DataMessagePartProps,
  type EmptyMessagePartProps,
  type ToolCallMessagePartProps,
  useAuiState,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import {
  type ComponentProps,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import { useConsoleStore } from "../console-store";
import { currentDataMode, useDataMode } from "../data-mode";
import { useDocumentVisible } from "../document-visibility";
import type {
  AskAnswer,
  AskSnapshot,
  MonitorProjection,
  ToolCallArtifact,
} from "../types";
import { UserMessageAttachments } from "./Attachments";
import {
  ACTIVITY_DATA_PARTS,
  ACTIVITY_GROUP_BY,
  ActivityGroup,
  type ActivityTiming,
  Reasoning,
} from "./assistant-ui/Reasoning";
import {
  ActivityPayload,
  ActivityRow,
  ActivityStep,
  type ActivityStatus,
  clusterSummary,
  failedLabel,
  toolVerb,
  truncationProps,
} from "./ActivityRow";
import { finiteDuration, formatToolDuration } from "./duration";
import { Icon } from "./Icon";
import { MessageGallery } from "./ImageGallery";
import { toolHistoryFailure } from "./tool-history";
import { ProcessJobPart } from "./ProcessJob";
import { useToolCallRepair } from "./tool-call-repair";
import { SubagentPart, toolArgumentPreview } from "./Subagent";
import { QuoteBlock } from "./assistant-ui/Quote";
import { cronRunAnchor } from "./CronChannelHeader";
import { McpAppPart, ReplyAttachmentPart, ReplyFailurePart } from "./ReplyParts";

export const copyTextWithFallback = async (text: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // LAN HTTP and denied clipboard permissions can still use the selection fallback.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = typeof document.execCommand === "function" && document.execCommand("copy");
  } finally {
    textarea.remove();
    active?.focus();
  }
  if (!copied) throw new Error("This browser did not allow clipboard access.");
};

export const copyableMessageText = (
  content: readonly { readonly type: string; readonly text?: string }[],
): string =>
  content
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n\n");

function MessageCopyButton({ label }: { readonly label: string }) {
  const text = useAuiState((state) => copyableMessageText(state.message.content));
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [state]);

  return (
    <button
      type="button"
      className={`message-action${state === "copied" ? " is-success" : state === "error" ? " is-error" : ""}`}
      aria-label={state === "copied" ? "Copied" : label}
      disabled={!text}
      onClick={() => {
        void copyTextWithFallback(text).then(
          () => setState("copied"),
          (error: unknown) => {
            setState("error");
            window.dispatchEvent(new CustomEvent("mono-agent:notice", {
              detail: {
                message: error instanceof Error ? error.message : "Copy failed.",
              },
            }));
          },
        );
      }}
    >
      <Icon name={state === "copied" ? "check" : "copy"} size={14} />
      <span>{state === "copied" ? "Copied" : state === "error" ? "Copy failed" : "Copy"}</span>
    </button>
  );
}

function MessageActions({
  label,
  persistentWhenLast = false,
}: {
  readonly label: string;
  readonly persistentWhenLast?: boolean;
}) {
  const isLast = useAuiState((state) => state.message.isLast);
  return (
    <ActionBarPrimitive.Root
      className={`message-actions${persistentWhenLast && isLast ? " is-persistent" : ""}`}
      autohide="never"
    >
      <MessageCopyButton label={label} />
    </ActionBarPrimitive.Root>
  );
}

type MarkdownComponents = NonNullable<ComponentProps<typeof MarkdownTextPrimitive>["components"]>;

// The wrapper owns the horizontal scroll and the rounded border that
// `border-collapse: collapse` defeats on the table itself, so the table keeps
// `display: table` and real column widths.
function MarkdownTable({ node: _node, ...props }: ComponentProps<"table"> & { readonly node?: unknown }) {
  return (
    <div className="markdown-table" tabIndex={0}>
      <table {...props} />
    </div>
  );
}

// GFM autolinks make every bare URL clickable, and the console is installable as
// a standalone PWA with no back affordance, so external targets open elsewhere.
function MarkdownLink({ node: _node, href, ...props }: ComponentProps<"a"> & { readonly node?: unknown }) {
  const external = href !== undefined && /^https?:/i.test(href);
  return <a {...props} href={href} {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})} />;
}

// Both stay module-level so streaming re-renders reuse the same identities: the
// primitive memoizes its component map on `components`, and react-markdown
// rebuilds its processor from `remarkPlugins`.
const MARKDOWN_REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_COMPONENTS: MarkdownComponents = { a: MarkdownLink, table: MarkdownTable };

function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      className="markdown"
      data-aui-quote-selectable
      components={MARKDOWN_COMPONENTS}
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      defer
      smooth
    />
  );
}

function LiveInputStatus() {
  const status = useAuiState((state) => state.message.metadata.custom?.liveInputStatus);
  if (status !== "pending" && status !== "applied" && status !== "queued" && status !== "cancelled") {
    return null;
  }
  const label = status === "pending"
    ? "Steering current run…"
    : status === "applied"
      ? "Applied to current run"
      : status === "queued"
        ? "Queued as next turn"
        : "Cancelled";
  return <span className={`live-input-status is-${status}`} role="status">{label}</span>;
}

function RunningText({ status }: EmptyMessagePartProps) {
  const role = useAuiState((state) => state.message.role);
  if (role !== "assistant" || status.type !== "running") return null;
  return (
    <span className="thinking-indicator" aria-label="Agent is thinking">
      <i />
      <i />
      <i />
    </span>
  );
}

type AskUserAnsweredSummary =
  | { readonly kind: "single"; readonly text: string }
  | { readonly kind: "multiple"; readonly lines: readonly string[] };

function resolveWebAskAnswer(
  snapshot: AskSnapshot,
  answer: AskAnswer,
): {
  readonly header: string;
  readonly labels: readonly string[];
  readonly customReply?: string;
} | undefined {
  const question = snapshot.questions.find((candidate) => candidate.id === answer.questionId);
  if (question === undefined) return undefined;
  const customReply = answer.customReply?.trim();
  return {
    header: question.header,
    labels: answer.selectedOptionIds.flatMap((optionId) => {
      const option = question.options.find((candidate) => candidate.id === optionId);
      return option === undefined ? [] : [option.label];
    }),
    ...(customReply === undefined || customReply.length === 0 ? {} : { customReply }),
  };
}

function webAskAnsweredSummary(snapshot: AskSnapshot): AskUserAnsweredSummary | undefined {
  if (snapshot.answers.length === 1) {
    const resolved = resolveWebAskAnswer(snapshot, snapshot.answers[0]!);
    if (resolved === undefined) return undefined;
    if (resolved.labels.length > 0) {
      return { kind: "single", text: resolved.labels.join(", ") };
    }
    return resolved.customReply === undefined
      ? undefined
      : { kind: "single", text: `Answer: ${resolved.customReply}` };
  }

  const lines = snapshot.answers.flatMap((answer) => {
    const resolved = resolveWebAskAnswer(snapshot, answer);
    if (resolved === undefined || resolved.header.trim().length === 0) return [];
    if (resolved.labels.length > 0) {
      return [`${resolved.header}: ${resolved.labels.join(", ")}`];
    }
    return resolved.customReply === undefined ? [] : [`${resolved.header}: ${resolved.customReply}`];
  });
  return lines.length === 0 ? undefined : { kind: "multiple", lines };
}

interface AskCardRequest {
  readonly toolCallId: string;
  readonly expectedInteractionId?: string;
  readonly running: boolean;
}

interface VersionedAskCardRequest extends AskCardRequest {
  readonly version: number;
}

interface AskCardState {
  readonly snapshot?: AskSnapshot;
  readonly unavailable: boolean;
}

interface AskReconciliationValue {
  readonly states: Readonly<Record<string, AskCardState>>;
  readonly register: (request: AskCardRequest) => () => void;
  readonly replace: (toolCallId: string, snapshot: AskSnapshot) => void;
}

const AskReconciliationContext = createContext<AskReconciliationValue | null>(null);
const ASK_POLL_MIN_MS = 250;
const ASK_POLL_MAX_MS = 2_000;
/** Half the rate on a metered link; a question that waits 4 s is still answered. */
const LEAN_ASK_POLL_MIN_MS = 500;
const LEAN_ASK_POLL_MAX_MS = 4_000;

const waitForAskPollDelay = async (delayMs: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let timer = 0;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = (): void => settle();
    timer = window.setTimeout(settle, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) settle();
  });
};

const expiredSnapshot = (snapshot: AskSnapshot): AskSnapshot =>
  snapshot.status === "pending" && snapshot.expiresAt !== null && Date.parse(snapshot.expiresAt) <= Date.now()
    ? { ...snapshot, status: "expired" }
    : snapshot;

const askInteractionId = (value: unknown, depth = 0): string | undefined => {
  if (depth > 6 || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.interactionId === "string" && record.interactionId.trim().length > 0) {
    return record.interactionId;
  }
  for (const key of ["structuredContent", "data", "result", "value"]) {
    const nested = askInteractionId(record[key], depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
};

type TerminalAskStatus = Exclude<AskSnapshot["status"], "pending">;

/**
 * AskUser's canonical tool result durably records its terminal outcome. Keep
 * that result as the refresh/restart fallback after the agent's bounded
 * interaction history has expired, while the coordinator still re-reads the
 * exact interaction whenever the agent can answer authoritatively.
 */
const persistedAskStatus = (value: unknown, depth = 0): TerminalAskStatus | undefined => {
  if (depth > 6 || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.interactionId === "string" && record.interactionId.trim().length > 0) {
    if (record.answered === true) return "answered";
    if (record.answered === false && record.reason === "timeout") return "expired";
    if (record.answered === false && record.reason === "cancelled") return "cancelled";
  }
  for (const key of ["structuredContent", "data", "result", "value"]) {
    const nested = persistedAskStatus(record[key], depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
};

/**
 * One coordinator owns AskUser polling for the selected thread. Exact by-id
 * snapshots keep old cards from adopting a later run's conversation-scoped ask.
 */
export function AskReconciliationProvider({ children }: { readonly children: ReactNode }) {
  const { selectedThread, selectedAgent, connection, transcriptMovedAt } = useConsoleStore();
  const visible = useDocumentVisible();
  // Read when a round runs, never depended on. It is a stable callback in the
  // store, but a loop that restarts because a reader's identity changed would
  // reset its own backoff -- and the loop already treats everything it consults
  // between rounds this way.
  //
  // Optional on purpose: knowing when the stream last spoke is a courtesy the
  // loop can run without, and a transcript rendered by something that does not
  // offer it must lose one optimisation, not its poll.
  const transcriptMovedAtRef = useRef<((threadId: string) => number) | undefined>(transcriptMovedAt);
  transcriptMovedAtRef.current = transcriptMovedAt;
  const threadId = selectedThread?.id;
  const requestsRef = useRef(new Map<string, VersionedAskCardRequest>());
  const nextRequestVersionRef = useRef(0);
  const [requestRevision, setRequestRevision] = useState(0);
  const [states, setStates] = useState<Record<string, AskCardState>>({});
  const statesRef = useRef(states);

  useEffect(() => {
    statesRef.current = states;
  }, [states]);

  const versionRequest = useCallback((request: AskCardRequest): VersionedAskCardRequest => {
    nextRequestVersionRef.current += 1;
    return { ...request, version: nextRequestVersionRef.current };
  }, []);

  const register = useCallback((request: AskCardRequest) => {
    const current = requestsRef.current.get(request.toolCallId);
    if (current === undefined
      || current.expectedInteractionId !== request.expectedInteractionId
      || current.running !== request.running) {
      requestsRef.current.set(request.toolCallId, versionRequest(request));
      setRequestRevision((value) => value + 1);
    }
    return () => {
      requestsRef.current.delete(request.toolCallId);
      setRequestRevision((value) => value + 1);
    };
  }, [versionRequest]);

  const replace = useCallback((toolCallId: string, snapshot: AskSnapshot) => {
    const normalized = expiredSnapshot(snapshot);
    const replacement = { snapshot: normalized, unavailable: false };
    const request = requestsRef.current.get(toolCallId);
    if (request !== undefined) {
      requestsRef.current.set(toolCallId, versionRequest({
        ...request,
        expectedInteractionId: normalized.interactionId,
      }));
    }
    statesRef.current = { ...statesRef.current, [toolCallId]: replacement };
    setStates((current) => ({
      ...current,
      [toolCallId]: replacement,
    }));
  }, [versionRequest]);

  useEffect(() => {
    setStates({});
  }, [threadId]);

  useEffect(() => {
    if (threadId === undefined) return;
    const controller = new AbortController();

    // Each awaited request may write only while its exact card version still
    // owns the slot. Submission replacement advances that version synchronously.
    const isCurrent = (request: VersionedAskCardRequest): boolean =>
      requestsRef.current.get(request.toolCallId)?.version === request.version;
    const update = (request: VersionedAskCardRequest, state: AskCardState): boolean => {
      if (controller.signal.aborted || !isCurrent(request)) return false;
      setStates((current) => {
        if (!isCurrent(request)) return current;
        return { ...current, [request.toolCallId]: state };
      });
      return true;
    };
    const markUnavailable = (requests: readonly VersionedAskCardRequest[]): boolean => {
      let stale = false;
      for (const request of requests) {
        if (!update(request, { unavailable: true })) stale = true;
      }
      return stale;
    };

    const poll = async (): Promise<void> => {
      const lean = currentDataMode() === "lean";
      const minDelayMs = lean ? LEAN_ASK_POLL_MIN_MS : ASK_POLL_MIN_MS;
      const maxDelayMs = lean ? LEAN_ASK_POLL_MAX_MS : ASK_POLL_MAX_MS;
      let delayMs = minDelayMs;
      /** Rounds that actually asked; the first one always does. */
      let asked = 0;
      /** Whether the round before this one gave way, so this one cannot. */
      let gaveWay = false;
      while (!controller.signal.aborted) {
        const requests = [...requestsRef.current.values()];
        if (requests.length === 0) return;
        if (connection !== "live" || selectedAgent?.status === "offline") {
          markUnavailable(requests);
          return;
        }
        // The stream moved this conversation's transcript inside the interval
        // this round waited out, so the agent side has only just spoken. One
        // round gives way to it -- and only one, so a stream that never stops
        // cannot starve the poll. The wait is repeated, not doubled: nothing was
        // asked, so nothing has earned a longer backoff.
        const movedAt = transcriptMovedAtRef.current?.(threadId) ?? 0;
        if (asked > 0 && !gaveWay && Date.now() - movedAt < delayMs) {
          gaveWay = true;
          await waitForAskPollDelay(delayMs, controller.signal);
          continue;
        }
        gaveWay = false;
        asked += 1;

        let pollAgain = false;
        const exact = requests.filter((request) => request.expectedInteractionId !== undefined);
        for (const request of exact) {
          if (!isCurrent(request)) {
            pollAgain = true;
            continue;
          }
          const expected = request.expectedInteractionId!;
          const cached = statesRef.current[request.toolCallId]?.snapshot;
          if (cached?.interactionId === expected && cached.status !== "pending") continue;
          try {
            const snapshot = await api.ask(threadId, expected, controller.signal);
            if (controller.signal.aborted) return;
            if (snapshot === undefined || snapshot.interactionId !== expected) {
              if (!update(request, { unavailable: true })) pollAgain = true;
              continue;
            }
            const normalized = expiredSnapshot(snapshot);
            if (!update(request, { snapshot: normalized, unavailable: false })
              || normalized.status === "pending") pollAgain = true;
          } catch {
            if (controller.signal.aborted) return;
            update(request, { unavailable: true });
            pollAgain = true;
          }
        }

        const unresolved = requests.filter((request) => request.expectedInteractionId === undefined);
        const inactive = unresolved.filter((request) => !request.running);
        if (markUnavailable(inactive)) pollAgain = true;
        const active = unresolved.filter((request) => request.running);
        if (active.length > 0) {
          // The hub permits one pending ask per conversation. Assign it once to
          // the newest unresolved running card, then lock that card to its id.
          const request = active.at(-1)!;
          if (!isCurrent(request)) {
            pollAgain = true;
            continue;
          }
          try {
            const snapshot = await api.pendingAsk(threadId, controller.signal);
            if (controller.signal.aborted) return;
            if (!isCurrent(request)) {
              pollAgain = true;
            } else if (snapshot !== undefined) {
              const existingOwner = [...requestsRef.current.values()].find((candidate) =>
                candidate.toolCallId !== request.toolCallId
                && candidate.expectedInteractionId === snapshot.interactionId);
              if (existingOwner === undefined) {
                const assigned = versionRequest({
                  ...request,
                  expectedInteractionId: snapshot.interactionId,
                });
                requestsRef.current.set(request.toolCallId, assigned);
                const normalized = expiredSnapshot(snapshot);
                if (!update(assigned, { snapshot: normalized, unavailable: false })
                  || normalized.status === "pending") pollAgain = true;
              } else {
                if (!update(request, { unavailable: true })) pollAgain = true;
              }
            } else {
              update(request, { unavailable: false });
              pollAgain = true;
            }
          } catch {
            if (controller.signal.aborted) return;
            update(request, { unavailable: true });
            pollAgain = true;
          }
        }

        if (!pollAgain || controller.signal.aborted) return;
        await waitForAskPollDelay(delayMs, controller.signal);
        delayMs = Math.min(maxDelayMs, delayMs * 2);
      }
    };

    // A hidden tab asks for nothing -- and, just as importantly, concludes
    // nothing: marking these cards unavailable here would tell the operator a
    // question had expired when all that happened is that they switched apps.
    // `visible` is a dependency, so coming back restarts the loop from its
    // shortest delay, which is what a resume should cost.
    if (visible) void poll();
    return () => controller.abort();
    // `states` is deliberately not a dependency: one loop owns its backoff and
    // consults terminal state only as an optimization, never as authority.
  }, [connection, requestRevision, selectedAgent?.status, threadId, versionRequest, visible]);

  const value = useMemo<AskReconciliationValue>(
    () => ({ states, register, replace }),
    [register, replace, states],
  );
  return (
    <AskReconciliationContext.Provider value={value}>
      {children}
    </AskReconciliationContext.Provider>
  );
}

function AskUserTool({
  args,
  result,
  structuredResult,
  status,
  toolCallId,
}: Pick<ToolCallMessagePartProps, "args" | "status" | "toolCallId">
  & { readonly result?: unknown; readonly structuredResult?: unknown }) {
  const threadId = useConsoleStore().selectedThread?.id;
  const coordinator = useContext(AskReconciliationContext);
  const registerAsk = coordinator?.register;
  const replaceAsk = coordinator?.replace;
  // The structured payload is authoritative: AskUser's text result is a human sentence
  // that carries neither `interactionId` nor `answered`. `result` stays as the fallback
  // for tool calls recorded before structuredResult was persisted.
  const expectedInteractionId = useMemo(
    () => askInteractionId(structuredResult) ?? askInteractionId(result),
    [result, structuredResult],
  );
  const durableTerminalStatus = useMemo(
    () => persistedAskStatus(structuredResult) ?? persistedAskStatus(result),
    [result, structuredResult],
  );
  const lean = useDataMode() === "lean";
  const cardState = coordinator?.states[toolCallId];
  const snapshot = cardState?.snapshot;
  const [selected, setSelected] = useState<Record<string, readonly string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const input = typeof args === "object" && args !== null ? args as Record<string, unknown> : {};

  // On a lean link a card whose tool result already records the outcome is not
  // worth a request: the result IS the answer, durably. What it costs is the
  // per-question summary, which only the live snapshot carries -- so this is a
  // lean-mode trade and nothing more.
  const settledWithoutAsking = lean
    && durableTerminalStatus !== undefined
    && status.type !== "running";

  useEffect(() => {
    if (settledWithoutAsking) return undefined;
    return registerAsk?.({
      toolCallId,
      ...(expectedInteractionId === undefined ? {} : { expectedInteractionId }),
      running: status.type === "running",
    });
  }, [expectedInteractionId, registerAsk, settledWithoutAsking, status.type, toolCallId]);

  const remaining = snapshot?.questions.slice(snapshot.activeQuestionIndex) ?? [];
  const complete = remaining.length > 0 && remaining.every((question) => {
    const count = (selected[question.id]?.length ?? 0) + ((custom[question.id]?.trim().length ?? 0) > 0 ? 1 : 0);
    return question.multiSelect ? count > 0 : count === 1;
  });
  const submit = async () => {
    if (!threadId || !snapshot || !complete) return;
    setSubmitting(true);
    setError(undefined);
    const answers: AskAnswer[] = remaining.map((question) => ({
      questionId: question.id,
      selectedOptionIds: selected[question.id] ?? [],
      ...(custom[question.id]?.trim() ? { customReply: custom[question.id]!.trim() } : {}),
    }));
    try {
      const response = await api.submitAsk(threadId, snapshot.interactionId, answers);
      if (!response.accepted) throw new Error(response.code === "invalid_answer" ? "Please complete every question." : "This question is no longer active.");
      if (response.snapshot !== undefined) replaceAsk?.(toolCallId, response.snapshot);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not submit the answer.");
    } finally {
      setSubmitting(false);
    }
  };

  const terminalStatus = snapshot?.status !== undefined && snapshot.status !== "pending"
    ? snapshot.status
    : snapshot === undefined
      ? durableTerminalStatus
      : undefined;
  const answeredSummary = snapshot?.status === "answered" ? webAskAnsweredSummary(snapshot) : undefined;
  return (
    <section className="ask-user-card" aria-label="Question from the agent">
      <div className="ask-user-heading">
        <span className={`tool-status${status.type === "running" ? " is-running" : ""}`} />
        <strong>Input needed</strong>
      </div>
      {(snapshot?.message ?? (typeof input.message === "string" ? input.message : undefined)) && (
        <div className="ask-user-context">{snapshot?.message ?? String(input.message)}</div>
      )}
      {snapshot === undefined ? terminalStatus !== undefined ? (
        <p className="ask-user-complete" role="status">{terminalStatus === "answered" ? "Answers submitted." : `Question ${terminalStatus}.`}</p>
      ) : cardState?.unavailable === true ? (
        <p className="ask-user-complete">Question unavailable. It may have expired, been evicted, or the agent may be offline.</p>
      ) : (
        <p className="ask-user-loading">Preparing the questions…</p>
      ) : terminalStatus !== undefined ? (
        <div className="ask-user-complete" role="status">
          <p>{terminalStatus === "answered" ? "Answers submitted." : `Question ${terminalStatus}.`}</p>
          {answeredSummary?.kind === "single" ? (
            <p className="ask-user-summary-line">{answeredSummary.text}</p>
          ) : answeredSummary?.kind === "multiple" ? (
            <ul className="ask-user-summary">
              {answeredSummary.lines.map((line, index) => (
                <li key={`${String(index)}:${line}`} className="ask-user-summary-line">{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          {snapshot.questions.map((question, questionIndex) => {
            const prior = snapshot.answers.find((answer) => answer.questionId === question.id);
            const isPrior = questionIndex < snapshot.activeQuestionIndex && prior !== undefined;
            const selectedIds = isPrior ? prior.selectedOptionIds : selected[question.id] ?? [];
            const customReply = isPrior ? prior.customReply ?? "" : custom[question.id] ?? "";
            return (
              <fieldset key={question.id} disabled={isPrior || submitting}>
                <legend><span>{question.header}</span>{question.question}</legend>
                <div className="ask-user-options">
                  {question.options.map((option) => {
                    const checked = selectedIds.includes(option.id);
                    return (
                      <label key={option.id} className={`ask-user-option${checked ? " is-selected" : ""}`}>
                        <input
                          type={question.multiSelect ? "checkbox" : "radio"}
                          name={question.id}
                          checked={checked}
                          onChange={() => {
                            setSelected((current) => ({
                              ...current,
                              [question.id]: question.multiSelect
                                ? checked
                                  ? (current[question.id] ?? []).filter((id) => id !== option.id)
                                  : [...(current[question.id] ?? []), option.id]
                                : [option.id],
                            }));
                            if (!question.multiSelect) setCustom((current) => ({ ...current, [question.id]: "" }));
                          }}
                        />
                        <span><strong>{option.label}</strong><small>{option.description}</small></span>
                      </label>
                    );
                  })}
                </div>
                <label className="ask-user-other">
                  <span>Custom reply</span>
                  <textarea
                    rows={2}
                    value={customReply}
                    placeholder="Type another answer…"
                    onChange={(event) => {
                      const value = event.target.value;
                      setCustom((current) => ({ ...current, [question.id]: value }));
                      if (!question.multiSelect && value.trim()) setSelected((current) => ({ ...current, [question.id]: [] }));
                    }}
                  />
                </label>
              </fieldset>
            );
          })}
          {error && <p className="ask-user-error" role="alert">{error}</p>}
          <button type="submit" className="ask-user-submit" disabled={!complete || submitting}>
            {submitting ? "Submitting…" : snapshot.questions.length === 1 ? "Submit answer" : "Submit answers"}
          </button>
        </form>
      )}
    </section>
  );
}

export function ToolFallback({
  toolName,
  args,
  result,
  isError,
  status,
  toolCallId,
  artifact,
}: ToolCallMessagePartProps) {
  // Read before the AskUser branch: hooks cannot sit behind an early return.
  const repairToolCall = useToolCallRepair();
  const envelope = toolCallArtifact(artifact);
  if (toolName === "AskUser") {
    return (
      <AskUserTool
        args={args}
        result={result}
        structuredResult={envelope?.structuredResult}
        status={status}
        toolCallId={toolCallId}
      />
    );
  }
  const isRunning = status.type === "running";
  const history = sessionToolHistory(envelope?.history);
  const historyFailure = toolHistoryFailure(history);
  // Durable tool history knows *how* a call failed — "timeout" beats "failed" —
  // so its canonical terminal state names the tag when there is one. A settled
  // call says nothing at all: the row's absence of a tag is the success signal.
  const failure = isError
    ? typeof history?.terminalState === "string" ? history.terminalState : "failed"
    : undefined;
  const elapsed = finiteDuration(envelope?.executionMs);
  // A lone call is the same row a cluster is, only without the count: the
  // Activity log stays one column of identical rows however the work grouped.
  return (
    <ActivityRow
      status={isRunning ? "running" : isError ? "failed" : "complete"}
      label={toolVerb(toolName)}
      summary={toolArgumentPreview(args)}
      failed={failure}
      duration={elapsed === undefined ? undefined : formatToolDuration(elapsed)}
    >
      <ActivityPayload
        args={args}
        result={result}
        resultIsError={isError}
        error={historyFailure}
        indented
        {...truncationProps(envelope, toolCallId, repairToolCall)}
      />
    </ActivityRow>
  );
}

/** Unwrap the per-tool-call metadata envelope assistant-ui carries in `artifact`. */
function toolCallArtifact(value: unknown): ToolCallArtifact | undefined {
  return value === null || typeof value !== "object" || Array.isArray(value)
    ? undefined
    : value as ToolCallArtifact;
}

function sessionToolHistory(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const history = value as Record<string, unknown>;
  return (history.persistence === "persisted" || history.persistence === "failed") && history.untrusted === true
    ? history
    : undefined;
}


type CompactionDisplayStatus = "running" | "succeeded" | "skipped" | "failed" | "interrupted";

const finiteCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const compactTokenCount = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return String(Math.round(tokens));
};

const compactionPayload = (value: unknown): Record<string, unknown> => {
  let current = value;
  let best: Record<string, unknown> = {};
  const seen = new Set<object>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || seen.has(current)) break;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record.status === "string") best = record;
    current = record.data;
  }
  return best;
};

function ContextCompactionPart({ data, status: messageStatus }: DataMessagePartProps) {
  const payload = compactionPayload(data);
  const reported = ["running", "succeeded", "skipped", "failed"].includes(String(payload.status))
    ? payload.status as Exclude<CompactionDisplayStatus, "interrupted">
    : "failed";
  const status: CompactionDisplayStatus = reported === "running" && messageStatus.type !== "running"
    ? "interrupted"
    : reported;
  const label = {
    running: "Compacting context…",
    succeeded: "Context compacted",
    skipped: "Context compaction skipped",
    failed: "Context compaction failed",
    interrupted: "Context compaction interrupted",
  }[status];
  const trigger = typeof payload.trigger === "string" ? payload.trigger : undefined;
  const triggerLabel = trigger === "overflow"
    ? "after overflow"
    : trigger === "proactive"
      ? "proactive"
      : trigger === "manual"
        ? "manual"
        : undefined;
  const before = finiteCount(payload.tokensBefore);
  const after = finiteCount(payload.tokensAfter);
  const approximate = payload.tokenCountsExact !== true;
  const formatMeasuredCount = (tokens: number) => `${approximate ? "~" : ""}${compactTokenCount(tokens)}`;
  const counts = before !== undefined && after !== undefined
    ? `${formatMeasuredCount(before)} → ${formatMeasuredCount(after)} tokens`
    : before !== undefined
      ? `${formatMeasuredCount(before)} tokens before`
      : after !== undefined
        ? `${formatMeasuredCount(after)} tokens after`
        : undefined;

  return (
    <div
      className={`context-compaction-row is-${status}`}
      role="status"
      aria-label={[label.replace("…", ""), triggerLabel, counts].filter(Boolean).join(", ")}
    >
      <span className="context-compaction-status" aria-hidden="true" />
      <span className="context-compaction-label">{label}</span>
      {triggerLabel !== undefined && <span className="context-compaction-trigger">{triggerLabel}</span>}
      {counts !== undefined && <span className="context-compaction-counts">{counts}</span>}
    </div>
  );
}

export function CronRunPart({ data }: DataMessagePartProps) {
  const payload = data as Record<string, unknown>;
  const runId = typeof payload.runId === "string" ? payload.runId : undefined;
  const [copied, setCopied] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const { loadCronRunActivity } = useConsoleStore();
  if (runId === undefined) return null;
  const sequence = typeof payload.sequence === "number" ? payload.sequence : undefined;
  const status = typeof payload.status === "string" ? payload.status : "unknown";
  const stateLabel = status === "succeeded"
    ? payload.silent === true ? "completed silently" : "completed"
    : status.replaceAll("_", " ");
  const trigger = payload.trigger === "manual" ? "manual" : "scheduled";
  const artifactRunId = typeof payload.artifactRunId === "string" ? payload.artifactRunId : undefined;
  const conversationId = typeof payload.conversationId === "string" ? payload.conversationId : undefined;
  const orderedAt = typeof payload.orderedAt === "string" ? payload.orderedAt : undefined;
  const eventCount = Number.isSafeInteger(payload.eventCount) ? Number(payload.eventCount) : 0;
  const activityLoaded = payload.activityLoaded === true;
  const activityStale = payload.activityStale === true;
  const eventsTruncated = payload.eventsTruncated === true;
  const fieldsTruncated = Array.isArray(payload.fieldsTruncated)
    ? payload.fieldsTruncated.filter((field): field is string => typeof field === "string")
    : [];
  return (
    <div
      id={cronRunAnchor(runId)}
      className={`cron-run-row is-${status}`}
      role="group"
      aria-label={`Cron run ${runId}, ${trigger}, ${stateLabel}`}
    >
      <a className="cron-run-link" href={`#${cronRunAnchor(runId)}`} title={runId}>
        Run{sequence === undefined ? "" : ` ${String(sequence)}`}
      </a>
      <span className="cron-run-state">{trigger} · {stateLabel}</span>
      {orderedAt !== undefined && <time dateTime={orderedAt}>{new Date(orderedAt).toLocaleString()}</time>}
      {artifactRunId !== undefined && (
        <span className="cron-artifact-link" title={artifactRunId}>Artifact <code>{artifactRunId}</code></span>
      )}
      {conversationId !== undefined && (
        <button
          type="button"
          className="cron-session-button"
          title={conversationId}
          aria-label={copied ? "Originating session copied" : `Copy originating session ${conversationId}`}
          onClick={() => {
            void copyTextWithFallback(conversationId).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2_000);
            });
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={12} />
          {copied ? "Session copied" : "Originating session"}
        </button>
      )}
      {eventCount > 0 && (!activityLoaded || activityStale) && (
        <button
          type="button"
          className="cron-activity-button"
          disabled={activityLoading}
          onClick={() => {
            setActivityLoading(true);
            void loadCronRunActivity(runId).finally(() => setActivityLoading(false));
          }}
        >
          {activityLoading ? "Loading activity…" : activityStale ? "Refresh activity" : "Load activity"}
        </button>
      )}
      {eventsTruncated && (
        <span className="cron-activity-truncated" role="status">
          Activity is truncated; retained and wire-bounded events are shown.
        </span>
      )}
      {fieldsTruncated.length > 0 && (
        <span className="cron-activity-truncated" role="status">
          Run {fieldsTruncated.join(", ")} {fieldsTruncated.length === 1 ? "is" : "are"} truncated in this view.
        </span>
      )}
    </div>
  );
}

/**
 * Prose the agent wrote between its tool calls. It reads as narration of the
 * work, so it renders as a plain row in the activity log — in its original
 * place among the tool rows — rather than as a second answer above the answer.
 */
function NotePart({ data }: DataMessagePartProps) {
  const text = (data as { readonly text?: unknown } | null)?.text;
  if (typeof text !== "string" || text.trim().length === 0) return null;
  return <p className="activity-note">{text.trim()}</p>;
}

const monitorStateLabel = (state: string): string => state.replaceAll("_", " ");

const monitorActivityStatus = (monitors: readonly MonitorProjection[]): ActivityStatus => {
  if (monitors.some((monitor) => monitor.state === "starting" || monitor.state === "running")) return "running";
  return monitors.some((monitor) => monitor.lastError !== null) ? "failed" : "complete";
};

/** One compact row for every Monitor wake applied to this assistant run. */
function MonitorActivityPart({ data }: DataMessagePartProps) {
  const payload = asRecord(data);
  const entries = Array.isArray(payload.monitors)
    ? payload.monitors.flatMap((raw) => {
        const entry = asRecord(raw);
        const projection = asRecord(entry.projection) as unknown as MonitorProjection;
        const deliveryKeys = Array.isArray(entry.deliveryKeys)
          ? entry.deliveryKeys.filter((key): key is string => typeof key === "string")
          : [];
        return projection.schema === "mono-agent.monitor-projection.v1"
          ? [{ projection, updateCount: deliveryKeys.length }]
          : [];
      })
    : [];
  const legacyUpdateCount = typeof payload.legacyUpdateCount === "number"
    && Number.isSafeInteger(payload.legacyUpdateCount)
    && payload.legacyUpdateCount > 0
    ? payload.legacyUpdateCount
    : 0;
  const updateCount = entries.reduce((total, entry) => total + entry.updateCount, 0) + legacyUpdateCount;
  if (updateCount === 0) return null;
  const projections = entries.map((entry) => entry.projection);
  const summary = projections.length === 1
    ? projections[0]?.description || monitorStateLabel(projections[0]?.state ?? "updated")
    : projections.length > 1 ? `${String(projections.length)} monitors` : "Historical monitor activity";
  return (
    <ActivityRow
      status={monitorActivityStatus(projections)}
      label={updateCount === 1 ? "Monitor update" : `Monitor updates ×${String(updateCount)}`}
      summary={summary}
    >
      {entries.length === 0 ? (
        <p className="monitor-activity-legacy">Details were not retained for these earlier Monitor updates.</p>
      ) : (
        <div className="activity-steps">
          {entries.map(({ projection, updateCount: count }) => (
            <ActivityStep
              key={projection.monitorId}
              toolName={projection.description || "Monitor"}
              summary={`${String(count)} ${count === 1 ? "update" : "updates"} · ${monitorStateLabel(projection.state)}`}
              failed={projection.lastError === null ? undefined : monitorStateLabel(projection.lastError.code)}
            >
              <dl className="monitor-activity-facts">
                <div><dt>State</dt><dd>{monitorStateLabel(projection.state)}</dd></div>
                <div><dt>Observed</dt><dd>{projection.counters.linesObserved}</dd></div>
                <div><dt>Delivered</dt><dd>{projection.counters.linesDelivered}</dd></div>
                <div><dt>Dropped</dt><dd>{projection.counters.droppedLines}</dd></div>
              </dl>
            </ActivityStep>
          ))}
        </div>
      )}
    </ActivityRow>
  );
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

/**
 * A run of identical tool calls reads as one row. The header answers what ran,
 * how many times, against what, and whether anything failed; the calls stay
 * individually expandable underneath so nothing is actually hidden.
 */
function ToolClusterPart({ data }: DataMessagePartProps) {
  const repairToolCall = useToolCallRepair();
  const payload = asRecord(data);
  const calls = Array.isArray(payload.calls) ? payload.calls : [];
  const failed = typeof payload.failedCount === "number" ? payload.failedCount : 0;
  const totalMs = finiteDuration(payload.totalMs);
  const status: ActivityStatus = payload.status === "running"
    ? "running"
    : payload.status === "failed" ? "failed" : "complete";
  const previews = calls.flatMap((raw) => {
    const preview = toolArgumentPreview(asRecord(raw).args);
    return preview === undefined ? [] : [preview];
  });
  return (
    <ActivityRow
      status={status}
      label={`${toolVerb(typeof payload.toolName === "string" ? payload.toolName : "Tool")} \u00d7${String(calls.length)}`}
      summary={clusterSummary(previews)}
      failed={failedLabel(failed, true)}
      duration={totalMs === undefined ? undefined : formatToolDuration(totalMs)}
    >
      <div className="activity-steps">
        {calls.map((raw, index) => {
          const call = asRecord(raw);
          const artifact = toolCallArtifact(call.artifact);
          const historyFailure = toolHistoryFailure(sessionToolHistory(artifact?.history));
          const duration = finiteDuration(artifact?.executionMs);
          const isError = call.isError === true;
          return (
            <ActivityStep
              key={typeof call.toolCallId === "string" ? call.toolCallId : index}
              toolName={String(call.toolName ?? payload.toolName ?? "Tool")}
              summary={toolArgumentPreview(call.args)}
              failed={failedLabel(isError ? 1 : 0, false)}
              duration={duration === undefined ? undefined : formatToolDuration(duration)}
            >
              <ActivityPayload
                args={call.args}
                result={call.result}
                resultIsError={isError}
                error={historyFailure}
                {...(typeof call.toolCallId === "string"
                  ? truncationProps(artifact, call.toolCallId, repairToolCall)
                  : {})}
              />
            </ActivityStep>
          );
        })}
      </div>
    </ActivityRow>
  );
}

// Runtime/provider telemetry remains attached to the message so the context
// display can summarize it. Compaction alone is promoted into Activity; other
// transport diagnostics remain out of the transcript UI.
function ErrorPart({ data }: DataMessagePartProps) {
  const payload = data as { code?: unknown; message?: unknown };
  return (
    <div className="message-error" role="alert">
      <strong>{payload.code ? String(payload.code) : "Agent error"}</strong>
      <span>{String(payload.message ?? "The agent run failed.")}</span>
    </div>
  );
}

const parts = {
  Text: MarkdownText,
  Quote: QuoteBlock,
  Empty: RunningText,
  data: {
    by_name: {
      "context-compaction": ContextCompactionPart,
      "cron-run": CronRunPart,
      subagent: SubagentPart,
      note: NotePart,
      "tool-cluster": ToolClusterPart,
      error: ErrorPart,
      "reply-attachment": ReplyAttachmentPart,
      "mcp-app": McpAppPart,
      "reply-failure": ReplyFailurePart,
      "process-job": ProcessJobPart,
      "monitor-activity": MonitorActivityPart,
    },
  },
} as const;

const dataPartName = (part: Record<string, unknown>): string | undefined => {
  if (part.type === "data" && typeof part.name === "string") return part.name;
  return typeof part.type === "string" && part.type.startsWith("data-")
    ? part.type.slice("data-".length)
    : undefined;
};

/** A running job row already carries its own pulsing progress affordance. */
const lastPartConveysProgress = (content: readonly unknown[]): boolean => {
  const last = content.at(-1);
  if (last === null || typeof last !== "object" || Array.isArray(last)) return false;
  const part = last as Record<string, unknown>;
  if (dataPartName(part) !== "process-job") return false;
  const job = asRecord(asRecord(part.data).job);
  return job.state === "queued" || job.state === "starting" || job.state === "running";
};

/** The parts an Activity band is made of: the same set `ACTIVITY_GROUP_BY` coalesces. */
const isActivityContentPart = (raw: unknown): boolean => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const part = raw as Record<string, unknown>;
  if (part.type === "reasoning" || part.type === "tool-call") return true;
  const name = dataPartName(part);
  return name !== undefined && ACTIVITY_DATA_PARTS.has(name);
};

/**
 * How much work a band holds, for its collapsed header. Every clustered call
 * counts on its own so the figure matches what expanding reveals.
 */
const activityStepCount = (content: readonly unknown[]): number => {
  let stepCount = 0;
  for (const raw of content) {
    if (!isActivityContentPart(raw)) continue;
    const part = raw as Record<string, unknown>;
    const cluster = dataPartName(part) === "tool-cluster" ? asRecord(part.data) : undefined;
    stepCount += cluster !== undefined && Array.isArray(cluster.calls) ? cluster.calls.length : 1;
  }
  return stepCount;
};

/** Index of the last part that belongs to an Activity band, or -1. */
const lastActivityIndex = (content: readonly unknown[]): number => {
  for (let index = content.length - 1; index >= 0; index -= 1) {
    if (isActivityContentPart(content[index])) return index;
  }
  return -1;
};

/**
 * The turn's wall-clock window from the two server stamps the message carries:
 * `createdAt` is when the turn started and `custom.finishedAt` when it settled.
 * A window, not a sum: thinking, tool calls, waits and parallel calls all fall
 * inside it exactly once.
 */
const activityTiming = (startedAt: number, finishedAt: unknown): ActivityTiming | undefined => {
  if (!Number.isFinite(startedAt)) return undefined;
  const finished = typeof finishedAt === "string" ? Date.parse(finishedAt) : Number.NaN;
  return Number.isFinite(finished) ? { startedAt, finishedAt: finished } : { startedAt };
};

function AssistantParts() {
  const isMessageRunning = useAuiState(
    (state) => state.message.status?.type === "running",
  );
  const content = useAuiState((state) => state.message.content);
  const startedAt = useAuiState((state) => state.message.createdAt.getTime());
  const finishedAt = useAuiState((state) => state.message.metadata.custom?.finishedAt);
  const timing = useMemo(() => activityTiming(startedAt, finishedAt), [startedAt, finishedAt]);
  // Grouping coalesces ADJACENT parts, so prose between two runs of work
  // splits a streaming turn into several Activity bands. Each counts its own
  // steps; the clock belongs to the band holding the turn's last activity —
  // the one the turn is still working in — because earlier bands are finished
  // and the window is the turn's, not theirs. A settled turn folds to a single
  // band, which then owns it.
  const openBandIndex = lastActivityIndex(content);
  return (
    <MessagePrimitive.GroupedParts
      groupBy={ACTIVITY_GROUP_BY}
      indicator={lastPartConveysProgress(content) ? "never" : "no-text"}
    >
      {({ part, children }) => {
        switch (part.type) {
          case "group-activity": {
            const band = part.indices.map((index) => content[index]);
            return (
              <ActivityGroup
                streaming={isMessageRunning}
                stepCount={activityStepCount(band)}
                timing={part.indices.includes(openBandIndex) ? timing : undefined}
              >
                {children}
              </ActivityGroup>
            );
          }
          case "group-reply-images":
            // Leaf parts render through a Fragment with no wrapper of their own,
            // so the tiles land as direct children of this row.
            return <div className="image-row">{children}</div>;
          case "text":
            return part.text.length > 0
              ? <MarkdownText />
              : part.status.type === "running"
                ? <RunningText status={part.status} />
                : null;
          case "reasoning":
            return <Reasoning {...part} />;
          case "tool-call":
            return part.toolUI ?? <ToolFallback {...part} />;
          case "data":
            if (part.name === "telemetry") return null;
            if (part.name === "context-compaction") return <ContextCompactionPart {...part} />;
            if (part.name === "cron-run") return <CronRunPart {...part} />;
            if (part.name === "subagent") return <SubagentPart {...part} />;
            if (part.name === "note") return <NotePart {...part} />;
            if (part.name === "tool-cluster") return <ToolClusterPart {...part} />;
            if (part.name === "error") return <ErrorPart {...part} />;
            if (part.name === "reply-attachment") return <ReplyAttachmentPart {...part} />;
            if (part.name === "mcp-app") return <McpAppPart {...part} />;
            if (part.name === "reply-failure") return <ReplyFailurePart {...part} />;
            if (part.name === "process-job") return <ProcessJobPart {...part} />;
            if (part.name === "monitor-activity") return <MonitorActivityPart {...part} />;
            return part.dataRendererUI;
          case "indicator":
            return <RunningText status={{ type: "running" }} />;
          default:
            return null;
        }
      }}
    </MessagePrimitive.GroupedParts>
  );
}

export function UserMessage() {
  return (
    <MessagePrimitive.Root className="message message-user">
      <MessageGallery>
        <div className="message-user-content">
          <UserMessageAttachments />
          <MessagePrimitive.Parts components={parts} />
        </div>
      </MessageGallery>
      <LiveInputStatus />
      <MessageActions label="Copy message" />
    </MessagePrimitive.Root>
  );
}

export function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="message message-assistant">
      <MessageGallery>
        <div className="assistant-content">
          <AssistantParts />
          <MessagePrimitive.Error>
            <div className="message-error" role="alert">The response ended with an error.</div>
          </MessagePrimitive.Error>
          <MessageActions label="Copy response" persistentWhenLast />
        </div>
      </MessageGallery>
    </MessagePrimitive.Root>
  );
}

export function SystemMessage() {
  return (
    <MessagePrimitive.Root className="message message-system">
      <MessagePrimitive.Parts components={parts} />
    </MessagePrimitive.Root>
  );
}
