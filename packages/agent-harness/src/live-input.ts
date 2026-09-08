import {
  AGENT_LIVE_INPUT_MAX_CHARACTERS,
  AGENT_LIVE_INPUT_MAX_MESSAGES,
  type AgentLiveInputOffer,
  type AgentLiveInputRequest,
  type AgentLiveInputSettlement,
} from "@mono-agent/agent-contracts";
import type { RuntimeLiveInputMessage } from "@mono-agent/runtime-adapter";

export interface AppliedLiveInput {
  readonly id: string;
  readonly text: string;
  readonly receivedAt: string;
  /** Host-owned wake identity. Its text must not become canonical user history. */
  readonly deliveryKey?: string;
}

export interface LiveInputMailbox extends AsyncIterable<RuntimeLiveInputMessage> {
  offer(request: AgentLiveInputRequest): AgentLiveInputOffer;
  markUnsupported(): void;
  close(reason?: "closed" | "failed"): void;
  cancel(): void;
  applied(): readonly AppliedLiveInput[];
}

interface LiveInputEntry {
  readonly request: AgentLiveInputRequest;
  readonly settled: Promise<AgentLiveInputSettlement>;
  readonly resolve: (settlement: AgentLiveInputSettlement) => void;
  readonly logicalOwner: object;
  lease: number;
  phase: "queued" | "leased" | "native_accepted" | "applied" | "uncertain" | "requeue" | "discarded";
}

interface MailboxConsumer {
  cursor: number;
  closed: boolean;
  waiting: ((result: IteratorResult<RuntimeLiveInputMessage>) => void) | undefined;
}

type MailboxState = "open" | "unsupported" | "closed" | "failed" | "cancelled";

export function createLiveInputMailbox(runId: string, onClose?: () => void): LiveInputMailbox {
  const entries: LiveInputEntry[] = [];
  const entriesById = new Map<string, LiveInputEntry>();
  const consumers = new Set<MailboxConsumer>();
  let state: MailboxState = "open";

  const settle = (entry: LiveInputEntry, result: AgentLiveInputSettlement): "recorded" | "ignored" => {
    if (isTerminal(entry.phase)) return "ignored";
    entry.phase = result.status === "requeue" ? "requeue" : result.status;
    entry.resolve(result);
    return "recorded";
  };

  const runtimeMessage = (entry: LiveInputEntry, lease: number): RuntimeLiveInputMessage => ({
    body: entry.request.text,
    id: entry.request.id,
    receivedAt: entry.request.receivedAt,
    logicalOwner: entry.logicalOwner,
    accepted: () => {
      if (entry.lease !== lease || entry.phase !== "leased") return "ignored";
      entry.phase = "native_accepted";
      return "recorded";
    },
    acknowledge: () => {
      if (entry.lease !== lease || (entry.phase !== "leased" && entry.phase !== "native_accepted")) {
        return "ignored";
      }
      return settle(entry, { status: "applied", runId });
    },
    uncertain: () => {
      if (entry.lease !== lease || (entry.phase !== "leased" && entry.phase !== "native_accepted")) {
        return "ignored";
      }
      return settle(entry, { status: "uncertain", reason: "delivery_uncertain" });
    },
    // A rejection belongs to one provider attempt. The entry stays available
    // to a later iterator so router failover/resume replay cannot lose it.
    reject: () => {
      if (entry.lease !== lease || (entry.phase !== "leased" && entry.phase !== "native_accepted")) {
        return "ignored";
      }
      entry.phase = "queued";
      return "recorded";
    },
  });

  const nextFor = (consumer: MailboxConsumer): IteratorResult<RuntimeLiveInputMessage> | undefined => {
    if (consumer.closed) return { done: true, value: undefined };
    while (consumer.cursor < entries.length) {
      const entry = entries[consumer.cursor];
      consumer.cursor += 1;
      if (entry === undefined || entry.phase !== "queued") continue;
      entry.phase = "leased";
      entry.lease += 1;
      return { done: false, value: runtimeMessage(entry, entry.lease) };
    }
    return state === "open" ? undefined : { done: true, value: undefined };
  };

  const wakeConsumers = (): void => {
    for (const consumer of consumers) {
      const waiting = consumer.waiting;
      if (waiting === undefined) continue;
      const result = nextFor(consumer);
      if (result === undefined) continue;
      consumer.waiting = undefined;
      waiting(result);
    }
  };

  const finish = (nextState: Exclude<MailboxState, "open">): void => {
    if (state !== "open") return;
    state = nextState;
    for (const entry of entries) {
      if (isTerminal(entry.phase)) continue;
      if (entry.phase === "leased" || entry.phase === "native_accepted") {
        settle(entry, { status: "uncertain", reason: "delivery_uncertain" });
        continue;
      }
      if (nextState === "cancelled") {
        settle(entry, { status: "discarded", reason: "cancelled" });
      } else {
        settle(entry, {
          status: "requeue",
          reason: nextState === "unsupported" ? "unsupported" : nextState === "failed" ? "failed" : "closed",
        });
      }
    }
    wakeConsumers();
    try {
      onClose?.();
    } catch {
      // Terminal ownership notification is best-effort and cannot block cleanup.
    }
  };

  return {
    offer(request): AgentLiveInputOffer {
      const existing = entriesById.get(request.id);
      if (existing !== undefined) {
        return existing.request.targetRunId === request.targetRunId
          ? { status: "accepted", settled: existing.settled }
          : { status: "unavailable", reason: "invalid" };
      }
      if (state !== "open") {
        return {
          status: "unavailable",
          reason: state === "unsupported" ? "unsupported" : "inactive",
        };
      }
      if (request.targetRunId !== undefined && request.targetRunId !== runId) {
        return { status: "unavailable", reason: "inactive" };
      }
      if (
        request.id.trim().length === 0
        || request.text.trim().length === 0
        || request.receivedAt.trim().length === 0
        || Number.isNaN(Date.parse(request.receivedAt))
      ) {
        return { status: "unavailable", reason: "invalid" };
      }
      if (request.text.length > AGENT_LIVE_INPUT_MAX_CHARACTERS) {
        return { status: "unavailable", reason: "too_large" };
      }
      if (entries.length >= AGENT_LIVE_INPUT_MAX_MESSAGES) {
        return { status: "unavailable", reason: "full" };
      }
      let resolve!: (settlement: AgentLiveInputSettlement) => void;
      const settled = new Promise<AgentLiveInputSettlement>((resolvePromise) => {
        resolve = resolvePromise;
      });
      const entry: LiveInputEntry = {
        request,
        settled,
        resolve,
        logicalOwner: {},
        lease: 0,
        phase: "queued",
      };
      entries.push(entry);
      entriesById.set(request.id, entry);
      wakeConsumers();
      return { status: "accepted", settled };
    },
    markUnsupported(): void {
      finish("unsupported");
    },
    close(reason = "closed"): void {
      finish(reason);
    },
    cancel(): void {
      finish("cancelled");
    },
    applied(): readonly AppliedLiveInput[] {
      return entries
        .filter((entry) => entry.phase === "applied")
        .map((entry) => ({
          id: entry.request.id,
          text: entry.request.text,
          receivedAt: entry.request.receivedAt,
          ...(entry.request.deliveryKey === undefined ? {} : { deliveryKey: entry.request.deliveryKey }),
        }));
    },
    [Symbol.asyncIterator](): AsyncIterator<RuntimeLiveInputMessage> {
      const consumer: MailboxConsumer = { cursor: 0, closed: false, waiting: undefined };
      consumers.add(consumer);
      return {
        next(): Promise<IteratorResult<RuntimeLiveInputMessage>> {
          const immediate = nextFor(consumer);
          if (immediate !== undefined) return Promise.resolve(immediate);
          return new Promise<IteratorResult<RuntimeLiveInputMessage>>((resolve) => {
            consumer.waiting = resolve;
          });
        },
        return(): Promise<IteratorResult<RuntimeLiveInputMessage>> {
          consumer.closed = true;
          consumers.delete(consumer);
          const waiting = consumer.waiting;
          consumer.waiting = undefined;
          waiting?.({ done: true, value: undefined });
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

function isTerminal(phase: LiveInputEntry["phase"]): boolean {
  return phase === "applied" || phase === "uncertain" || phase === "requeue" || phase === "discarded";
}
