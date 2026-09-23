import { afterEach, describe, expect, it, vi } from "vitest";

import { PEER_QUESTION_TIMEOUT_MS, PeerQuestionRelay } from "../peer-question-relay.js";

afterEach(() => vi.useRealTimers());

describe("owner-held peer ACP question", () => {
  const form = { sessionId: "acp:finance:session", toolCallId: "ask-1", message: "Proceed?",
    requestedSchema: { type: "object", properties: { question_1: { type: "string" } }, required: ["question_1"] } };

  it("expires without inventing an answer and rejects late replies", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-23T19:00:00.000Z") });
    const relay = new PeerQuestionRelay("finance", "portfolio", async () => {}, async () => {});
    const response = relay.request(form);
    const event = await relay.next();
    expect(event).toMatchObject({ kind: "question", question: { message: "Proceed?" } });
    if (event.kind !== "question") throw new Error("No question");
    await vi.advanceTimersByTimeAsync(PEER_QUESTION_TIMEOUT_MS);
    expect(await response).toEqual({ action: "decline" });
    await expect(relay.respond(event.question.questionId, { action: "accept", content: { question_1: "yes" } }))
      .rejects.toThrow(/stale|expired/u);
  });

  it("returns a form response only after the exact current question is resumed once", async () => {
    const resume = vi.fn(async () => {});
    const relay = new PeerQuestionRelay("finance", "portfolio", async () => {}, resume);
    const response = relay.request(form);
    const event = await relay.next();
    if (event.kind !== "question") throw new Error("No question");
    await expect(relay.respond("22222222-2222-4222-8222-222222222222", { action: "decline" })).rejects.toThrow(/stale/u);
    await relay.respond(event.question.questionId, { action: "accept", content: { question_1: "yes" } });
    expect(await response).toEqual({ action: "accept", content: { question_1: "yes" } });
    expect(resume).toHaveBeenCalledOnce();
    await expect(relay.respond(event.question.questionId, { action: "decline" })).rejects.toThrow(/stale/u);
  });
});
