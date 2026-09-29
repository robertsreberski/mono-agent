import {
  processJobAgentFamily,
  type ProcessJobAgentFamily,
  type ProcessJobParentAction,
  type ProcessJobParentCall,
  type ProcessJobPartValue,
} from "../process-job-presentation";
import type { ProcessJobProjection } from "../types";
import {
  pendingPeerQuestion,
  processJobDisplayTitle,
  processJobIsCurrent,
  processJobIsIssue,
  processJobIsTerminal,
  processJobPurposeInGroup,
  type ProcessJobStackCounts,
} from "./process-job-display";

/**
 * Pure grouping rules for the jobs shelf.
 *
 * Every detached child becomes ONE shelf item: all Agent/AgentManage turns of a
 * subagent instance, or all PeerAgent jobs of a peer, keyed by family and id.
 * Command jobs stay single items. The group's timeline interleaves the
 * parent's calls (read from the loaded transcript) with the child's turns.
 * Everything is derived from live projections plus transcript calls, so the
 * shelf's counts, order and rows agree at any instant.
 */

type InternalJob = Extract<ProcessJobProjection, { kind: "internal" }>;

/** One shelf row's job: its transcript part and its live projection. */
export interface ProcessJobShelfEntry {
  readonly part: ProcessJobPartValue;
  readonly job: ProcessJobProjection;
}

/** How a parent call reads on its row: an AgentManage message that answers the child's question is a reply. */
export type ProcessJobParentCallLabel = ProcessJobParentAction | "reply";

export type ProcessJobTimelineStep =
  | {
      readonly kind: "call";
      readonly key: string;
      readonly call: ProcessJobParentCall;
      readonly label: ProcessJobParentCallLabel;
      /** A steer or stop the parent sent while a turn above it ran. */
      readonly nested: boolean;
    }
  | { readonly kind: "turn"; readonly key: string; readonly entry: ProcessJobShelfEntry }
  /** The question a turn ended with: a subagent's AskParent or a peer's form. */
  | { readonly kind: "question"; readonly key: string; readonly job: InternalJob };

export interface ProcessJobGroupItem {
  readonly kind: "group";
  /** `family:id`; the shelf prefixes the thread. Never depends on which turns are loaded. */
  readonly key: string;
  readonly family: ProcessJobAgentFamily;
  readonly instanceId: string;
  /** Turns in admission order. */
  readonly turns: readonly ProcessJobShelfEntry[];
  readonly steps: readonly ProcessJobTimelineStep[];
  /** The last admitted turn: its outcome alone decides whether the group is an issue. */
  readonly newest: ProcessJobProjection;
  /** The parent closed the instance after its newest turn. */
  readonly closed: boolean;
  /** The parent's newest brief or message, on one line: the task when a job's own label is generic. */
  readonly task?: string;
}

export interface ProcessJobSingleItem {
  readonly kind: "job";
  readonly key: string;
  readonly entry: ProcessJobShelfEntry;
}

export type ProcessJobShelfItem = ProcessJobSingleItem | ProcessJobGroupItem;

const familyOf = (job: ProcessJobProjection): ProcessJobAgentFamily | undefined =>
  job.kind === "internal" ? processJobAgentFamily(job.tool) : undefined;

const time = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const questionOf = (job: ProcessJobProjection): InternalJob | undefined =>
  job.kind === "internal" && (job.subagentQuestion !== undefined || job.peerQuestion !== undefined) ? job : undefined;

/**
 * The shelf's items, in admission order. A group sits where its NEWEST turn
 * would have sat as a row, so absorbing earlier turns never reorders anything
 * else. A reused subagent id (closed, then created again) stays one group: its
 * timeline shows the close and the new brief, and its key never depends on
 * which turns happen to be loaded.
 */
export function processJobShelfItems(
  entries: readonly ProcessJobShelfEntry[],
  calls: readonly ProcessJobParentCall[],
): ProcessJobShelfItem[] {
  interface Building { readonly family: ProcessJobAgentFamily; readonly instanceId: string; readonly turns: ProcessJobShelfEntry[] }
  const groups = new Map<string, Building>();
  const sequence: (ProcessJobSingleItem | { readonly kind: "slot"; readonly key: string })[] = [];
  const slots = new Map<string, number>();

  for (const entry of entries) {
    const family = familyOf(entry.job);
    if (family === undefined || entry.job.kind !== "internal") {
      sequence.push({ kind: "job", key: entry.job.jobId, entry });
      continue;
    }
    const key = `${family}:${entry.job.instanceId}`;
    const group = groups.get(key) ?? { family, instanceId: entry.job.instanceId, turns: [] };
    group.turns.push(entry);
    groups.set(key, group);
    const previous = slots.get(key);
    if (previous !== undefined) sequence[previous] = { kind: "slot", key: "" };
    slots.set(key, sequence.length);
    sequence.push({ kind: "slot", key });
  }

  const items: ProcessJobShelfItem[] = [];
  for (const step of sequence) {
    if (step.kind === "job") {
      items.push(step);
      continue;
    }
    const group = groups.get(step.key);
    if (group === undefined) continue;
    items.push(buildGroup(step.key, group.family, group.instanceId, group.turns, calls));
  }
  return items;
}

function buildGroup(
  key: string,
  family: ProcessJobAgentFamily,
  instanceId: string,
  turns: readonly ProcessJobShelfEntry[],
  allCalls: readonly ProcessJobParentCall[],
): ProcessJobGroupItem {
  const turnIds = new Set(turns.map((turn) => turn.job.jobId));
  const calls = allCalls.filter((call) => call.family === family
    && (call.instanceId === instanceId || (call.launchedJobId !== undefined && turnIds.has(call.launchedJobId))));
  const launched = new Set(calls.flatMap((call) => call.launchedJobId !== undefined && turnIds.has(call.launchedJobId) ? [call.launchedJobId] : []));
  const byId = new Map(turns.map((turn) => [turn.job.jobId, turn]));
  // A turn whose launching call is not loaded (paged out, or an ambiguous
  // receipt) goes before the first call made after it was admitted.
  const unpaired = turns.filter((turn) => !launched.has(turn.job.jobId))
    .sort((left, right) => time(left.job.timestamps.admittedAt) - time(right.job.timestamps.admittedAt));

  const steps: ProcessJobTimelineStep[] = [];
  let asked = false;
  let turnAbove = false;
  const pushTurn = (turn: ProcessJobShelfEntry) => {
    steps.push({ kind: "turn", key: turn.job.jobId, entry: turn });
    const question = questionOf(turn.job);
    if (question !== undefined) steps.push({ kind: "question", key: `question:${turn.job.jobId}`, job: question });
    asked = turn.job.kind === "internal" && turn.job.subagentQuestion !== undefined;
    turnAbove = true;
  };
  let next = 0;
  for (const call of calls) {
    while (next < unpaired.length && time(unpaired[next]!.job.timestamps.admittedAt) < time(call.at)) pushTurn(unpaired[next++]!);
    const reply = call.action === "message" && asked;
    const nested = (call.action === "steer" || call.action === "stop") && turnAbove;
    steps.push({ kind: "call", key: `call:${call.messageId}:${call.toolCallId}`, call, label: reply ? "reply" : call.action, nested });
    if (call.action === "message" || call.action === "brief") asked = false;
    if (call.action === "close" || call.action === "brief" || call.action === "message" || call.action === "answer" || call.action === "decline") turnAbove = false;
    const turn = call.launchedJobId === undefined ? undefined : byId.get(call.launchedJobId);
    if (turn !== undefined) pushTurn(turn);
  }
  while (next < unpaired.length) pushTurn(unpaired[next++]!);

  const newest = turns.at(-1)!.job;
  const newestIndex = steps.findIndex((step) => step.kind === "turn" && step.entry.job.jobId === newest.jobId);
  const closedAfter = steps.slice(newestIndex + 1).some((step) => step.kind === "call" && step.call.action === "close");
  const newestLaunch = calls.find((call) => call.launchedJobId === newest.jobId);
  const closed = family === "agent"
    && (closedAfter || (newestLaunch?.closes === true && newest.state === "succeeded"));
  const task = [...calls].reverse().find((call) => (call.action === "brief" || call.action === "message") && call.text !== undefined)?.text;
  return { kind: "group", key, family, instanceId, turns, steps, newest, closed,
    ...(task === undefined ? {} : { task: task.replace(/\s+/gu, " ").trim() }) };
}

/** The host's own label for a PeerAgent job, which names only the peer and thread. */
const GENERIC_PEER_LABEL = /^Peer \S+ thread \S+( question continuation)?$/u;

/**
 * The purpose a group's row shows beside its id: the speaking turn's own label,
 * unless that label is the host's generic one (`Persistent subagent <id>`,
 * `Peer <peer> thread <thread>`), in which case the parent's newest brief or
 * message says what the child is doing.
 */
export const processJobGroupPurpose = (group: ProcessJobGroupItem, lead: ProcessJobProjection): string => {
  const label = processJobDisplayTitle(lead);
  const generic = group.family === "peer"
    ? GENERIC_PEER_LABEL.test(label)
    : label === `Persistent subagent ${group.instanceId}`;
  return generic && group.task !== undefined ? group.task : processJobPurposeInGroup(lead, group.instanceId);
};

/** Every job an item holds. */
export const processJobItemJobs = (item: ProcessJobShelfItem): readonly ProcessJobProjection[] =>
  item.kind === "job" ? [item.entry.job] : item.turns.map((turn) => turn.job);

/**
 * The job that speaks for an item: a pending peer question first, then work
 * still in progress, else the newest turn. For a subagent (one turn at a time)
 * this is simply its newest turn.
 */
export const processJobItemLead = (item: ProcessJobShelfItem, now: number): ProcessJobProjection => {
  if (item.kind === "job") return item.entry.job;
  const jobs = [...processJobItemJobs(item)].reverse();
  return jobs.find((job) => pendingPeerQuestion(job, now))
    ?? jobs.find((job) => !processJobIsTerminal(job))
    ?? item.newest;
};

/** Current work: any job of the item is still active or still asking. */
export const processJobItemIsCurrent = (item: ProcessJobShelfItem, now: number): boolean =>
  processJobItemJobs(item).some((job) => processJobIsCurrent(job, now));

/**
 * Only the newest turn's outcome makes a group an issue: a later turn that
 * succeeded, or still runs, answers an earlier failure, which keeps its own
 * red glyph inside the timeline.
 */
export const processJobItemIsIssue = (item: ProcessJobShelfItem): boolean =>
  processJobIsIssue(item.kind === "job" ? item.entry.job : item.newest);

/**
 * The shelf's counts, one per ITEM: an agent group counts once, however many
 * turns it holds. Chips, legend, History and the polite announcement all read
 * these, so every number counts rows the operator can see.
 */
export const processJobItemCounts = (items: readonly ProcessJobShelfItem[], now: number): ProcessJobStackCounts => ({
  active: items.filter((item) => processJobItemJobs(item).some((job) => !processJobIsTerminal(job))).length,
  finished: items.filter((item) => !processJobItemIsCurrent(item, now)).length,
  issues: items.filter(processJobItemIsIssue).length,
  questions: items.filter((item) => processJobItemJobs(item).some((job) => pendingPeerQuestion(job, now))).length,
});
