import { randomUUID } from "node:crypto";

import type { CreateElicitationResponse } from "@agentclientprotocol/sdk";

import type { PeerAcpQuestion } from "./peer-acp-client.js";

export const PEER_QUESTION_TIMEOUT_MS = 30 * 60_000;

/** Bounded untrusted question; the ACP form remains authoritative for validation. */
export interface PeerQuestion {
  readonly questionId: string;
  readonly message: string;
  readonly requestedSchema: Readonly<Record<string, unknown>>;
  readonly expiresAt: string;
  readonly peer: string;
  readonly thread: string;
}

export type PeerTurnEvent = { readonly kind: "question"; readonly question: PeerQuestion }
  | { readonly kind: "complete"; readonly answer: string }
  | { readonly kind: "failed"; readonly message: string };

/** One owner-controlled, in-memory ACP response gate; a restart cannot resurrect it. */
export class PeerQuestionRelay {
  private readonly events: PeerTurnEvent[] = [];
  private waiter?: ((event: PeerTurnEvent) => void) | undefined;
  private pending?: { readonly question: PeerQuestion; readonly resolve: (response: CreateElicitationResponse) => void;
    readonly timer: ReturnType<typeof setTimeout> } | undefined;
  private ended = false;

  constructor(private readonly peer: string, private readonly thread: string,
    private readonly publish: (question: PeerQuestion) => Promise<void>,
    private readonly resume: (question: PeerQuestion, response: CreateElicitationResponse) => Promise<void>,
    private readonly retire?: (question: PeerQuestion, state: "expired" | "interrupted") => Promise<void>) {}

  get question(): PeerQuestion | undefined { return this.pending?.question; }

  async request(form: PeerAcpQuestion): Promise<CreateElicitationResponse> {
    if (this.pending !== undefined || this.ended) throw new Error("Peer question relay already has a pending or settled interaction.");
    const now = Date.now();
    const suppliedDeadline = form.expiresAt === undefined ? NaN : Date.parse(form.expiresAt);
    const deadline = Math.min(now + PEER_QUESTION_TIMEOUT_MS,
      Number.isFinite(suppliedDeadline) ? suppliedDeadline : now + PEER_QUESTION_TIMEOUT_MS);
    const question: PeerQuestion = { questionId: randomUUID(), peer: this.peer, thread: this.thread,
      message: form.message, requestedSchema: form.requestedSchema,
      expiresAt: new Date(Math.max(now + 1, deadline)).toISOString() };
    // If publication fails, do not create an answerable question or release the ACP form.
    await this.publish(question);
    const answer = new Promise<CreateElicitationResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        void this.retire?.(question, "expired").catch(() => undefined);
        resolve({ action: "decline" });
      }, Math.max(1, Date.parse(question.expiresAt) - Date.now()));
      timer.unref?.();
      this.pending = { question, resolve, timer };
    });
    this.offer({ kind: "question", question });
    return await answer;
  }

  async respond(questionId: string, response: CreateElicitationResponse): Promise<void> {
    const current = this.pending;
    if (current === undefined || current.question.questionId !== questionId || this.ended) {
      throw new Error("Peer question is stale, already answered, or belongs to another thread.");
    }
    if (Date.parse(current.question.expiresAt) <= Date.now()) {
      this.settlePending({ action: "decline" });
      throw new Error("Peer question expired; a late answer cannot resume it.");
    }
    await this.resume(current.question, response);
    this.settlePending(response);
  }

  decline(): void {
    if (this.pending) void this.retire?.(this.pending.question, "interrupted").catch(() => undefined);
    this.settlePending({ action: "decline" });
  }

  finish(answer: string): void { this.ended = true; this.settlePending({ action: "decline" }); this.offer({ kind: "complete", answer }); }
  fail(message: string): void { this.ended = true; this.decline(); this.offer({ kind: "failed", message }); }

  async next(): Promise<PeerTurnEvent> {
    const next = this.events.shift();
    if (next !== undefined) return next;
    return await new Promise<PeerTurnEvent>((resolve) => { this.waiter = resolve; });
  }

  private settlePending(response: CreateElicitationResponse): void {
    const pending = this.pending;
    if (pending === undefined) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  private offer(event: PeerTurnEvent): void {
    const waiter = this.waiter;
    if (waiter === undefined) this.events.push(event);
    else { this.waiter = undefined; waiter(event); }
  }
}
