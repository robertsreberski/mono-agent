import { type ReactNode, useId, useRef, useState } from "react";

import type { ProcessJobParentCall } from "../process-job-presentation";
import type { ProcessJobProjection } from "../types";
import { formatUsd } from "../usage";
import { TruncationNotice } from "./ActivityRow";
import { ActivityElapsed } from "./assistant-ui/ActivityElapsed";
import { Icon, type IconName } from "./Icon";
import { ProcessJobCard, processJobTiming } from "./ProcessJob";
import { ProcessJobCallOutcomes, ProcessJobGlyph } from "./ProcessJobGlyph";
import { useProcessJobNow } from "./process-job-clock";
import {
  peerQuestionExpiryLabel,
  pendingPeerQuestion,
  processJobCallOutcomes,
  processJobDisplayState,
  processJobIsTerminal,
  processJobPreview,
} from "./process-job-display";
import {
  processJobGroupPurpose,
  processJobItemLead,
  type ProcessJobGroupItem,
  type ProcessJobParentCallLabel,
  type ProcessJobTimelineStep,
} from "./process-job-groups";
import { peerQuestionStateLabel } from "./peer-question-form";
import { useToolCallRepair } from "./tool-call-repair";

/** More turns than this fold the older ones behind one row. */
const FOLD_AFTER_TURNS = 3;
/** Turns that stay visible under a fold. */
const KEEP_TURNS = 2;

const clockTime = (iso: string | undefined): string | undefined => {
  if (iso === undefined) return undefined;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : undefined;
};

const oneLine = (text: string): string => text.replace(/\s+/gu, " ").trim();

const CALL_ICON: Readonly<Record<ProcessJobParentCallLabel, IconName>> = {
  brief: "send", message: "send", reply: "send", steer: "send", answer: "send", decline: "close", stop: "stop", close: "close",
};

const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  applied: "applied",
  pending: "pending",
  not_applied: "not applied",
  unsupported: "unsupported",
  stopped: "stopped",
  stop_requested: "stop requested",
  already_idle: "already idle",
};

/** The parent call's own result in words, when the row has no turn to show it. */
const callStatus = (call: ProcessJobParentCall): { readonly words: string; readonly tone: "neutral" | "success" | "danger" | "muted" } | undefined => {
  if (call.status === "failed") return { words: "failed", tone: "danger" };
  if (call.action === "steer") {
    if (call.status === "running") return { words: "sending", tone: "muted" };
    return call.outcome === undefined ? undefined
      : { words: OUTCOME_WORDS[call.outcome] ?? call.outcome.replaceAll("_", " "), tone: call.outcome === "applied" ? "success" : "muted" };
  }
  if (call.action === "stop") {
    if (call.status === "running") return { words: "stopping", tone: "muted" };
    return { words: call.outcome === undefined ? "stop sent" : OUTCOME_WORDS[call.outcome] ?? call.outcome.replaceAll("_", " "), tone: "neutral" };
  }
  if (call.action === "close") return { words: call.status === "running" ? "closing" : "instance closed", tone: "neutral" };
  if (call.launchedJobId !== undefined) return call.closes === true ? { words: "then close", tone: "muted" } : undefined;
  // No detached turn follows: a foreground call answered inside the conversation.
  if (call.status === "running") return { words: "running in the conversation", tone: "muted" };
  if (call.action === "decline") return { words: "declined", tone: "neutral" };
  return { words: "answered in the conversation", tone: "muted" };
};

/**
 * One call from the parent, read like a transcript tool row: the tool's name,
 * what the call was, and what it said. A call with text opens to the whole of
 * it; a preview the server cut short offers the transcript's own repair.
 */
function ProcessJobParentCallRow({ call, label, at }: {
  readonly call: ProcessJobParentCall;
  readonly label: ProcessJobParentCallLabel;
  readonly at?: string;
}) {
  const [open, setOpen] = useState(false);
  const repair = useToolCallRepair();
  const bodyId = useId();
  const status = callStatus(call);
  const time = clockTime(at);
  const text = call.text;
  const content: ReactNode = <>
    <span className="sr-only">From the parent agent:</span>
    <span className="process-job-call-icon" aria-hidden="true"><Icon name={CALL_ICON[label]} size={11} /></span>
    <strong className="process-job-call-tool">{call.tool}</strong>
    <span className="process-job-call-word">{label}</span>
    {text === undefined ? null : <span className="process-job-call-text">{oneLine(text)}</span>}
    {status === undefined ? null : <span className={`process-job-call-status is-${status.tone}`}>{status.words}</span>}
    <span className="process-job-call-spacer" aria-hidden="true" />
    {time === undefined ? null : <time className="process-job-call-time" dateTime={at}>{time}</time>}
    {text === undefined ? null : <Icon className="process-job-call-chevron" name="chevron-down" size={12} />}
  </>;
  return (
    <div className={`process-job-call is-${call.action}${open ? " is-open" : ""}`}>
      {text === undefined
        ? <div className="process-job-call-head">{content}</div>
        : (
          <button type="button" className="process-job-call-head" aria-expanded={open} aria-controls={bodyId}
            onClick={() => setOpen(!open)}>
            {content}
          </button>
        )}
      {text === undefined ? null : (
        <div id={bodyId} className="process-job-call-body" hidden={!open}>
          <p className="process-job-call-full" tabIndex={0}>{text}</p>
          {call.argsTruncated === true ? (
            <TruncationNotice
              {...(call.argsBytes === undefined ? {} : { characters: call.argsBytes })}
              {...(repair === undefined ? {} : { onLoadFull: async () => repair(call.toolCallId) })}
              loadLabel="Load full message"
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

/** The question a turn ended with: a subagent asking its parent, or a peer's form awaiting the agent. */
function ProcessJobAsk({ job, instanceId }: {
  readonly job: Extract<ProcessJobProjection, { kind: "internal" }>;
  readonly instanceId: string;
}) {
  const now = useProcessJobNow();
  if (job.peerQuestion !== undefined) {
    const pending = pendingPeerQuestion(job, now);
    const question = job.peerQuestion;
    return (
      <div className={`process-job-ask${pending ? " is-pending" : " is-settled"}`} role="note" aria-label={`${instanceId} asks the agent`}>
        <span className="process-job-ask-glyph" aria-hidden="true">
          <ProcessJobGlyph small tone={pending ? "question" : "neutral"} mark="question" />
        </span>
        <span className="process-job-ask-body">
          <span className="process-job-ask-label">{instanceId} asks</span>
          <span className="process-job-ask-text">{question.message}</span>
          <span className="process-job-ask-state">
            {pending ? peerQuestionExpiryLabel(question.expiresAt, now) : peerQuestionStateLabel(question.state)}
          </span>
        </span>
      </div>
    );
  }
  const question = job.subagentQuestion;
  if (question === undefined) return null;
  return (
    <div className="process-job-ask is-subagent" role="note" aria-label={`${instanceId} asked the parent agent`}>
      <span className="process-job-ask-glyph" aria-hidden="true"><ProcessJobGlyph small tone="question" mark="question" /></span>
      <span className="process-job-ask-body">
        <span className="process-job-ask-label">{instanceId} asked</span>
        <span className="process-job-ask-text">{question.question}</span>
        {question.options !== undefined && question.options.length > 0 ? (
          <span className="process-job-ask-options">
            Options: {question.options.map((option, index) => <span key={`${option}-${String(index)}`} className="peer-question-chip">{option}</span>)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

const token = (key: string, content: ReactNode, className?: string) => (
  <span key={key} className="process-job-token">
    <span className="process-job-dot" aria-hidden="true">·</span>
    {className === undefined ? content : <span className={className}>{content}</span>}
  </span>
);

/**
 * One detached child as one shelf row: a subagent instance (every Agent and
 * AgentManage turn) or a peer (every PeerAgent job). Closed, it reads like a
 * job row headed by the child's id and newest task, with the status of the
 * turn that speaks for it. Open, a rail lists the parent's calls as tool rows
 * and the child's turns as the ordinary job rows, in the order they happened.
 *
 * Each turn keeps its own thread- and job-keyed card, so its poll, disclosure
 * and reading position survive the group settling, folding or moving to
 * History.
 */
export function ProcessJobGroup({ group, threadId, shown, onProjectionChange, onOpen }: {
  readonly group: ProcessJobGroupItem;
  readonly threadId: string;
  /** The shelf is open and this row is not behind History. */
  readonly shown: boolean;
  readonly onProjectionChange?: (projection: ProcessJobProjection) => void;
  readonly onOpen?: (element: HTMLElement) => void;
}) {
  const now = useProcessJobNow();
  const ids = useId();
  const groupRef = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  const lead = processJobItemLead(group, now);
  const display = processJobDisplayState(lead, now);
  const terminal = processJobIsTerminal(lead);
  const timing = processJobTiming(lead);
  const showTime = timing !== undefined
    && (!terminal || (lead.timestamps.startedAt !== null && timing.finishedAt !== undefined));
  const preview = processJobPreview(lead, now);
  const outcomes = terminal ? [] : processJobCallOutcomes(lead);
  const purpose = processJobGroupPurpose(group, lead);
  const turns = group.turns.length;
  const turnWords = `${String(turns)} ${turns === 1 ? "turn" : "turns"}`;
  const kindWord = group.family === "peer" ? "peer agent" : "agent";
  const cost = group.turns.reduce((sum, turn) => {
    const value = turn.job.kind === "internal" ? turn.job.subagentProgress?.costUsd : undefined;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? sum + value : sum;
  }, 0);
  const profile = lead.kind === "internal" ? lead.subagentProgress?.profile : undefined;
  const showProfile = profile !== undefined && profile !== "Subagent" && !group.instanceId.includes(profile.toLowerCase());
  const titleId = `${ids}-title`;
  const metaId = `${ids}-meta`;

  // Long-lived children fold their older turns behind one row, so the newest
  // exchange stays in view inside the shelf's height cap.
  const turnSteps = group.steps.flatMap((step, index) => step.kind === "turn" ? [index] : []);
  const foldable = !unfolded && turnSteps.length > FOLD_AFTER_TURNS;
  let foldAt = 0;
  if (foldable) {
    const keepFrom = turnSteps[turnSteps.length - KEEP_TURNS]!;
    // Start at the call that launched the first kept turn, when it sits right above it.
    const above = group.steps[keepFrom - 1];
    foldAt = above?.kind === "call" && above.call.launchedJobId !== undefined ? keepFrom - 1 : keepFrom;
  }
  const folded = group.steps.slice(0, foldAt);
  const foldedTurns = folded.filter((step) => step.kind === "turn");
  const foldedCalls = folded.filter((step) => step.kind === "call").length;
  const foldedFailed = foldedTurns.filter((step) => step.kind === "turn" && processJobDisplayState(step.entry.job, now).tone === "danger").length;

  const step = (item: ProcessJobTimelineStep, index: number) => {
    const hidden = index < foldAt;
    if (item.kind === "turn") {
      return (
        <li key={`${threadId}:${item.entry.job.jobId}`} className="process-job-step is-turn" hidden={hidden}>
          <ProcessJobCard
            part={item.entry.part}
            shown={shown && open && !hidden}
            {...(onProjectionChange === undefined ? {} : { onProjectionChange })}
            {...(onOpen === undefined ? {} : { onOpen })}
          />
        </li>
      );
    }
    if (item.kind === "question") {
      return (
        <li key={item.key} className="process-job-step is-ask" hidden={hidden}>
          <ProcessJobAsk job={item.job} instanceId={group.instanceId} />
        </li>
      );
    }
    const launchedTurn = item.call.launchedJobId === undefined ? undefined
      : group.turns.find((turn) => turn.job.jobId === item.call.launchedJobId);
    return (
      <li key={item.key} className={`process-job-step is-call${item.nested ? " is-nested" : ""}`} hidden={hidden}>
        <ProcessJobParentCallRow call={item.call} label={item.label}
          {...(launchedTurn === undefined ? {} : { at: launchedTurn.job.timestamps.admittedAt })} />
      </li>
    );
  };

  return (
    <details
      ref={groupRef}
      className="process-job-group"
      data-family={group.family}
      data-state={lead.state}
      open={open}
      aria-label={`${group.instanceId} ${kindWord}, ${turnWords}: ${purpose}`}
    >
      {/* The tone rides on the summary, not the group, so it colours only
          this header's state word and never a turn row's inside the timeline. */}
      <summary
        data-tone={display.tone}
        aria-labelledby={titleId}
        aria-describedby={metaId}
        onClick={(event) => {
          event.preventDefault();
          const next = !open;
          setOpen(next);
          if (next && groupRef.current !== null) onOpen?.(groupRef.current);
        }}
      >
        <ProcessJobGlyph tone={display.tone} mark={display.mark} />
        <span id={titleId} className="process-job-group-title" title={lead.summary}>
          <span className="process-job-group-name">{group.instanceId}</span>
          <span className="process-job-group-purpose">{purpose}</span>
        </span>
        <Icon className="process-job-chevron" name="chevron-down" size={14} />
        <span id={metaId} className="process-job-meta">
          <span className="process-job-state">{display.word}</span>
          {display.pending === undefined ? null : token("pending", display.pending, "process-job-pending")}
          {showTime ? token("time", <ActivityElapsed timing={timing!} live={!terminal} />, "process-job-time") : null}
          {token("turns", <><Icon className="process-job-kind-icon" name="agent" size={12} />{group.family === "peer" ? `PeerAgent · ${turnWords}` : turnWords}</>, "process-job-tool process-job-group-turns")}
          {group.closed ? token("closed", "closed", "process-job-group-closed") : null}
          {display.alerts.map((alert) => token(`alert-${alert}`, alert, "process-job-alert"))}
          {open ? <>
            {showProfile ? token("profile", profile) : null}
            {cost > 0 ? token("cost", `${formatUsd(cost)} ${terminal ? "total" : "so far"}`) : null}
            {token("since", `since ${clockTime(group.turns[0]?.job.timestamps.admittedAt) ?? ""}`)}
          </> : <>
            {display.notes.map((note) => token(`note-${note}`, note, "process-job-note"))}
            {outcomes.length > 0 ? token("calls", <ProcessJobCallOutcomes outcomes={outcomes} />) : null}
            {preview === undefined ? null : (
              <span className="process-job-preview">
                <span className="process-job-dot" aria-hidden="true">·</span>
                {preview.label.length > 0 ? <span className="process-job-preview-label">{preview.label}</span> : null}
                <span className={`process-job-preview-text${preview.mono ? " is-mono" : ""}`}>{preview.text}</span>
              </span>
            )}
          </>}
        </span>
      </summary>
      <ol className="process-job-timeline" aria-label={`${group.instanceId} timeline`}>
        {foldAt > 0 ? (
          <li key="fold" className="process-job-step is-fold">
            <button type="button" className="process-job-fold" onClick={() => setUnfolded(true)}>
              <span className="process-job-fold-icon" aria-hidden="true"><Icon name="more" size={12} /></span>
              <span>{`Show ${String(foldedTurns.length)} earlier ${foldedTurns.length === 1 ? "turn" : "turns"}`}</span>
              <span className="process-job-fold-note">
                {`${String(foldedCalls)} from the parent · ${foldedFailed > 0 ? `${String(foldedFailed)} failed` : "none failed"}`}
              </span>
            </button>
          </li>
        ) : null}
        {group.steps.map(step)}
      </ol>
    </details>
  );
}
