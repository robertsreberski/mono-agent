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
  processJobBucketIsCurrent,
  processJobDisplayTitle,
  processJobIsCurrent,
  processJobIsIssue,
  processJobIsTerminal,
  processJobPurposeInGroup,
  type ProcessJobBucket,
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
  /**
   * The host confirmed the instance closed, and nothing since reopened it:
   * a requested, failed or unconfirmed close never counts.
   */
  readonly closed: boolean;
  /** The parent's newest brief or message, on one line: the task when a job's own label is generic. */
  readonly task?: string;
  /** One peer serves several threads here, so rows name the thread they belong to. */
  readonly showThreads: boolean;
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
  const byId = new Map(turns.map((turn) => [turn.job.jobId, turn]));
  // A call belongs to the group it ADDRESSED. Only a launch that named no id
  // (a generated instance id) is joined through its receipt's job, and a
  // receipt never pulls a call into another child's group.
  const calls = allCalls.filter((call) => call.family === family && (call.instanceId !== undefined
    ? call.instanceId === instanceId
    : call.launchedJobId !== undefined && byId.has(call.launchedJobId)));
  // A launch pairs with its turn only inside that turn's own group and tool.
  const launchOf = (call: ProcessJobParentCall): ProcessJobShelfEntry | undefined => {
    const turn = call.launchedJobId === undefined ? undefined : byId.get(call.launchedJobId);
    return turn !== undefined && turn.job.tool === call.tool ? turn : undefined;
  };
  const launched = new Set(calls.flatMap((call) => launchOf(call)?.job.jobId ?? []));
  // A turn whose launching call is not loaded (paged out, an ambiguous or
  // conflicting claim) goes before the first call made after it was admitted.
  const unpaired = turns.filter((turn) => !launched.has(turn.job.jobId))
    .sort((left, right) => time(left.job.timestamps.admittedAt) - time(right.job.timestamps.admittedAt));

  const steps: ProcessJobTimelineStep[] = [];
  const placed = new Set<string>();
  let asked = false;
  let turnAbove = false;
  let closed = false;
  const pushTurn = (turn: ProcessJobShelfEntry) => {
    // Every turn appears once, whatever claims it.
    if (placed.has(turn.job.jobId)) return;
    placed.add(turn.job.jobId);
    steps.push({ kind: "turn", key: turn.job.jobId, entry: turn });
    const question = questionOf(turn.job);
    if (question !== undefined) steps.push({ kind: "question", key: `question:${turn.job.jobId}`, job: question });
    asked = turn.job.kind === "internal" && turn.job.subagentQuestion !== undefined;
    turnAbove = true;
    // A turn after a close means the instance lives again.
    closed = false;
  };
  let next = 0;
  for (const call of calls) {
    while (next < unpaired.length && time(unpaired[next]!.job.timestamps.admittedAt) < time(call.at)) pushTurn(unpaired[next++]!);
    const reply = call.action === "message" && asked;
    const nested = (call.action === "steer" || call.action === "stop") && turnAbove;
    steps.push({ kind: "call", key: `call:${call.messageId}:${call.toolCallId}`, call, label: reply ? "reply" : call.action, nested });
    if (call.action === "message" || call.action === "brief") asked = false;
    if (call.action === "close" || call.action === "brief" || call.action === "message" || call.action === "answer" || call.action === "decline") turnAbove = false;
    // A foreground turn that answered also proves the instance lives again.
    if (call.answered === true) closed = false;
    const turn = launchOf(call);
    if (turn !== undefined) pushTurn(turn);
    if (call.closed === true) closed = true;
  }
  while (next < unpaired.length) pushTurn(unpaired[next++]!);

  const newest = turns.at(-1)!.job;
  const task = [...calls].reverse().find((call) => (call.action === "brief" || call.action === "message") && call.text !== undefined)?.text;
  const threads = new Set([
    ...calls.flatMap((call) => call.thread ?? []),
    ...turns.flatMap((turn) => turn.job.kind === "internal" && turn.job.peerQuestion !== undefined ? [turn.job.peerQuestion.thread] : []),
  ]);
  return { kind: "group", key, family, instanceId, turns, steps, newest, closed: family === "agent" && closed,
    ...(task === undefined ? {} : { task: task.replace(/\s+/gu, " ").trim() }),
    showThreads: family === "peer" && threads.size > 1 };
}

/** The host's own label for a PeerAgent job, which names only the peer and thread. */
const GENERIC_PEER_LABEL = /^Peer \S+ thread \S+( question continuation)?$/u;

/**
 * The newest task, shown beside the group's id: the NEWEST turn's own label,
 * whichever turn speaks for the status (an older pending question keeps the
 * glyph and state word, never the title). When that label is the host's
 * generic one (`Persistent subagent <id>`, `Peer <peer> thread <thread>`),
 * the parent's newest brief or message says what the child is doing.
 */
export const processJobGroupPurpose = (group: ProcessJobGroupItem): string => {
  const label = processJobDisplayTitle(group.newest);
  const generic = group.family === "peer"
    ? GENERIC_PEER_LABEL.test(label)
    : label === `Persistent subagent ${group.instanceId}`;
  return generic && group.task !== undefined ? group.task : processJobPurposeInGroup(group.newest, group.instanceId);
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

/** The job whose outcome is the item's once nothing in it is current: a group's newest turn. */
const outcomeOf = (item: ProcessJobShelfItem): ProcessJobProjection => item.kind === "job" ? item.entry.job : item.newest;

/**
 * Only the newest turn's outcome makes a group an issue: a later turn that
 * succeeded, or still runs, answers an earlier failure, which keeps its own
 * red glyph inside the timeline.
 */
export const processJobItemIsIssue = (item: ProcessJobShelfItem): boolean => processJobIsIssue(outcomeOf(item));

/**
 * The ONE bucket an item counts in, first match wins: a peer question awaiting
 * the agent (even on a failed or cancelled job), then work in progress, then
 * the settled outcome — an issue (see `processJobIsIssue`: a success whose wake
 * failed is one too), a clean cancellation, or done. A group's outcome is its
 * newest turn's. Current rows are exactly the question and active buckets.
 */
export const processJobItemBucket = (item: ProcessJobShelfItem, now: number): ProcessJobBucket => {
  const jobs = processJobItemJobs(item);
  if (jobs.some((job) => pendingPeerQuestion(job, now))) return "question";
  if (jobs.some((job) => !processJobIsTerminal(job))) return "active";
  if (processJobItemIsIssue(item)) return "issue";
  return outcomeOf(item).state === "cancelled" ? "cancelled" : "done";
};

/** The shelf's rows split once: the partition every count and list reads. */
export interface ProcessJobShelfPartition {
  /** Rows per bucket; they sum to the number of rows. */
  readonly counts: ProcessJobStackCounts;
  /** Question and active rows, in shelf order: above History. */
  readonly current: readonly ProcessJobShelfItem[];
  /** Issue, cancelled and done rows, in shelf order: behind History. */
  readonly finished: readonly ProcessJobShelfItem[];
  /** The active rows alone: the bar's in-progress mark reads only these. */
  readonly active: readonly ProcessJobShelfItem[];
}

/**
 * The shelf's one partition, per ITEM: an agent group counts once, however
 * many turns it holds, and every row counts in exactly one bucket. The chips,
 * the open header, History and the polite announcement all read it, so every
 * number counts rows the operator can see and no two numbers overlap.
 */
export function processJobShelfPartition(items: readonly ProcessJobShelfItem[], now: number): ProcessJobShelfPartition {
  const counts: Record<ProcessJobBucket, number> = { question: 0, active: 0, issue: 0, cancelled: 0, done: 0 };
  const current: ProcessJobShelfItem[] = [];
  const finished: ProcessJobShelfItem[] = [];
  const active: ProcessJobShelfItem[] = [];
  for (const item of items) {
    const bucket = processJobItemBucket(item, now);
    counts[bucket] += 1;
    (processJobBucketIsCurrent(bucket) ? current : finished).push(item);
    if (bucket === "active") active.push(item);
  }
  return { counts, current, finished, active };
}

/** Rows per bucket: see `processJobShelfPartition`. */
export const processJobItemCounts = (items: readonly ProcessJobShelfItem[], now: number): ProcessJobStackCounts =>
  processJobShelfPartition(items, now).counts;
