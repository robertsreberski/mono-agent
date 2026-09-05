import type { ChannelAskSnapshot, ChannelInteractionSink } from "@mono-agent/agent-contracts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadInteractionSettings, startInteractionBridge, type InteractionBridgeHandle } from "../interaction-bridge.js";

const handles: InteractionBridgeHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => await handle.stop()));
});

function questions() {
  return [
    {
      header: "Delivery",
      question: "What should I do with the draft?",
      options: [
        { label: "Send", description: "Send the draft now." },
        { label: "Skip", description: "Leave it unsent." },
        { label: "Revise", description: "Keep working on the wording." },
      ],
    },
    {
      header: "Follow-up",
      question: "Which follow-ups should be included?",
      options: [
        { label: "Owner", description: "Identify the responsible owner." },
        { label: "Deadline", description: "Include the expected deadline." },
      ],
      multiSelect: true,
    },
  ];
}

async function createHarness(timeoutMs: number | null = 5_000): Promise<{
  handle: InteractionBridgeHandle;
  presented: ChannelAskSnapshot[];
  updated: ChannelAskSnapshot[];
}> {
  const presented: ChannelAskSnapshot[] = [];
  const updated: ChannelAskSnapshot[] = [];
  const handle = await startInteractionBridge({ askTimeoutMs: timeoutMs });
  handles.push(handle);
  const sink: ChannelInteractionSink = {
    presentAsk: async (_conversationId, snapshot) => { presented.push(snapshot); },
    updateAsk: async (_conversationId, snapshot) => { updated.push(snapshot); },
    postStatus: async () => undefined,
  };
  handle.registerSink("web", sink);
  return { handle, presented, updated };
}

async function createAsk(handle: InteractionBridgeHandle, body: Record<string, unknown>): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await fetch(`${handle.url}/v1/asks`, {
    method: "POST",
    headers: { authorization: `Bearer ${handle.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** Poll until the probe yields a value, so expiry is observed rather than timed. */
async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  description: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function pollAsk(handle: InteractionBridgeHandle, interactionId: string): Promise<ChannelAskSnapshot> {
  const response = await fetch(`${handle.url}/v1/asks/${encodeURIComponent(interactionId)}`, {
    headers: { authorization: `Bearer ${handle.token}` },
  });
  expect(response.status).toBe(200);
  return await response.json() as ChannelAskSnapshot;
}

describe("structured AskUser interaction bridge", () => {
  it("loads null or the none env sentinel as an explicit no-expiry setting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-interaction-settings-"));
    try {
      const configPath = join(dir, "mono-agent.config.json");
      await writeFile(configPath, JSON.stringify({ interaction: { askUser: { timeoutMs: null } } }));
      await expect(loadInteractionSettings({ env: {}, configPath })).resolves.toMatchObject({
        configured: true,
        askTimeoutMs: null,
      });
      await expect(loadInteractionSettings({
        env: { MONO_AGENT_ASK_USER_TIMEOUT_MS: "none" },
        configPath,
      })).resolves.toMatchObject({ askTimeoutMs: null });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("presents 1-5 structured questions and atomically accepts all remaining web answers", async () => {
    const { handle, presented, updated } = await createHarness();
    const created = await createAsk(handle, {
      conversationId: "web:thread-1",
      producerConversationId: "producer:daily#2026-07-21",
      runId: "run-1",
      message: "Morning briefing and reply draft",
      questions: questions(),
    });
    expect(created.status).toBe(201);
    const interactionId = created.body.interactionId as string;
    expect(presented).toHaveLength(1);
    expect(presented[0]).toMatchObject({
      interactionId,
      message: "Morning briefing and reply draft",
      activeQuestionIndex: 0,
      status: "pending",
    });
    expect(presented[0]?.questions).toHaveLength(2);
    expect(presented[0]?.questions[0]?.options).toHaveLength(3);

    const snapshot = handle.getPendingAsk("web:thread-1");
    const first = snapshot!.questions[0]!;
    const second = snapshot!.questions[1]!;
    const submitted = await handle.submitAskAnswers({
      conversationId: "web:thread-1",
      interactionId,
      answers: [
        { questionId: first.id, selectedOptionIds: [first.options[0]!.id] },
        {
          questionId: second.id,
          selectedOptionIds: [second.options[0]!.id, second.options[1]!.id],
          customReply: "Also mention risk",
        },
      ],
    });
    expect(submitted.accepted).toBe(true);
    expect(submitted.snapshot?.status).toBe("answered");
    expect(handle.getPendingAsk("web:thread-1")).toBeUndefined();
    expect(updated.at(-1)?.status).toBe("answered");
    expect((await pollAsk(handle, interactionId)).answers).toHaveLength(2);
    // The asking tool consumed the terminal active entry above. Exact-id
    // history remains available for a second destination such as the console.
    expect(handle.getAsk(interactionId)).toMatchObject({ status: "answered" });

    const consumed = await fetch(`${handle.url}/v1/asks/${encodeURIComponent(interactionId)}`, {
      headers: { authorization: `Bearer ${handle.token}` },
    });
    expect(consumed.status).toBe(404);

    const history = handle.enrichAssistantHistory({
      runId: "run-1",
      conversationId: "producer:daily#2026-07-21",
      assistantText: "Done.",
    });
    expect(history).toContain("Tool: AskUser");
    expect(history).toContain("Send");
    expect(history).toContain("Also mention risk");
  });

  it("advances native channels one question at a time and rejects non-contiguous answers", async () => {
    const { handle, updated } = await createHarness();
    const created = await createAsk(handle, {
      conversationId: "web:thread-2",
      producerConversationId: "web:thread-2",
      questions: questions(),
    });
    const interactionId = created.body.interactionId as string;
    const initial = handle.getPendingAsk("web:thread-2")!;
    const invalid = await handle.submitAskAnswers({
      conversationId: "web:thread-2",
      interactionId,
      answers: [{ questionId: initial.questions[1]!.id, selectedOptionIds: [initial.questions[1]!.options[0]!.id] }],
    });
    expect(invalid).toMatchObject({ accepted: false, code: "invalid_answer" });

    const first = await handle.submitAskAnswers({
      conversationId: "web:thread-2",
      interactionId,
      answers: [{ questionId: initial.questions[0]!.id, selectedOptionIds: [initial.questions[0]!.options[1]!.id] }],
    });
    expect(first.snapshot).toMatchObject({ status: "pending", activeQuestionIndex: 1 });
    expect(updated.at(-1)?.activeQuestionIndex).toBe(1);

    const secondQuestion = first.snapshot!.questions[1]!;
    const second = await handle.submitAskAnswers({
      conversationId: "web:thread-2",
      interactionId,
      answers: [{ questionId: secondQuestion.id, selectedOptionIds: [], customReply: "No follow-up" }],
    });
    expect(second.snapshot?.status).toBe("answered");
  });

  it("rejects the removed free-text contract and all out-of-bound structured shapes", async () => {
    const { handle, presented } = await createHarness();
    const legacy = await createAsk(handle, { conversationId: "web:legacy", question: "Proceed?" });
    expect(legacy.status).toBe(400);

    const invalidShapes = [
      [],
      Array.from({ length: 6 }, () => questions()[0]),
      [{ ...questions()[0], header: "thirteen chars" }],
      [{ ...questions()[0], options: [{ label: "Only", description: "One option" }] }],
      [{ ...questions()[0], options: questions()[0]!.options.map((option) => ({ ...option, description: "" })) }],
    ];
    for (const [index, invalidQuestions] of invalidShapes.entries()) {
      const response = await createAsk(handle, {
        conversationId: `web:invalid-${String(index)}`,
        questions: invalidQuestions,
      });
      expect(response.status).toBe(400);
    }
    expect(presented).toHaveLength(0);
  });

  it("validates selections atomically and rejects stale interaction ids", async () => {
    const { handle } = await createHarness();
    const created = await createAsk(handle, {
      conversationId: "web:thread-3",
      questions: [questions()[0]],
    });
    const snapshot = handle.getPendingAsk("web:thread-3")!;
    const question = snapshot.questions[0]!;
    expect(await handle.submitAskAnswers({
      conversationId: "web:thread-3",
      interactionId: "ask-stale",
      answers: [{ questionId: question.id, selectedOptionIds: [question.options[0]!.id] }],
    })).toMatchObject({ accepted: false, code: "stale" });
    expect(await handle.submitAskAnswers({
      conversationId: "web:thread-3",
      interactionId: created.body.interactionId as string,
      answers: [{ questionId: question.id, selectedOptionIds: [question.options[0]!.id, question.options[1]!.id] }],
    })).toMatchObject({ accepted: false, code: "invalid_answer" });
    expect(handle.getPendingAsk("web:thread-3")?.answers).toEqual([]);
  });

  it("expires pending interactions and returns partial answers to the waiting tool", async () => {
    // Deliberately real timers: createAsk/pollAsk make real HTTP requests, and undici schedules
    // its own timers for them. Faking timers here left those unfired, so the request could hang
    // until Vitest's 5s wall-clock timeout — it passed locally and timed out on CI. The expiry
    // window is 25ms, so waiting it out for real is both cheaper and honest.
    const { handle, updated } = await createHarness(25);
    const created = await createAsk(handle, { conversationId: "web:timeout", questions: questions() });
    const interactionId = created.body.interactionId as string;
    const snapshot = handle.getPendingAsk("web:timeout")!;
    await handle.submitAskAnswers({
      conversationId: "web:timeout",
      interactionId,
      answers: [{ questionId: snapshot.questions[0]!.id, selectedOptionIds: [snapshot.questions[0]!.options[0]!.id] }],
    });

    const terminal = await waitFor(
      async () => {
        const polled = await pollAsk(handle, interactionId);
        return polled.status === "expired" ? polled : undefined;
      },
      "pending interaction never expired",
    );
    expect(terminal.answers).toHaveLength(1);
    expect(updated.at(-1)?.status).toBe("expired");
  });

  it("keeps an explicitly unbounded interaction pending without synthesizing an expiry date", async () => {
    const { handle, presented } = await createHarness(null);
    const created = await createAsk(handle, {
      conversationId: "web:no-expiry",
      questions: [questions()[0]],
      timeoutMs: 20,
    });
    const interactionId = created.body.interactionId as string;
    expect(created).toMatchObject({ status: 201, body: { timeoutMs: null } });
    expect(presented[0]).toMatchObject({ interactionId, status: "pending", expiresAt: null });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(handle.getPendingAsk("web:no-expiry")).toMatchObject({ interactionId, status: "pending", expiresAt: null });
    handle.cancelAsks("web:no-expiry");
  });

  it("retains cancellation for exact-id reconciliation after the active entry is deleted", async () => {
    const { handle } = await createHarness();
    const created = await createAsk(handle, { conversationId: "web:cancelled", questions: [questions()[0]] });
    const interactionId = created.body.interactionId as string;
    const cancelled = await fetch(`${handle.url}/v1/asks/${encodeURIComponent(interactionId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${handle.token}` },
    });
    expect(cancelled.status).toBe(204);
    expect(handle.getAsk(interactionId)).toMatchObject({ interactionId, status: "cancelled" });
  });

  it("evicts exact-id terminal history after the bounded retention window", async () => {
    let now = new Date("2026-08-14T10:00:00.000Z");
    const handle = await startInteractionBridge({
      askTimeoutMs: 5_000,
      now: () => now,
    });
    handles.push(handle);
    handle.registerSink("web", {
      presentAsk: async () => undefined,
      updateAsk: async () => undefined,
      postStatus: async () => undefined,
    });
    const created = await createAsk(handle, { conversationId: "web:retention", questions: [questions()[0]] });
    const interactionId = created.body.interactionId as string;
    const snapshot = handle.getPendingAsk("web:retention")!;
    await handle.submitAskAnswers({
      conversationId: "web:retention",
      interactionId,
      answers: [{ questionId: snapshot.questions[0]!.id, selectedOptionIds: [snapshot.questions[0]!.options[0]!.id] }],
    });
    await pollAsk(handle, interactionId);
    expect(handle.getAsk(interactionId)?.status).toBe("answered");

    now = new Date("2026-08-15T10:00:00.001Z");
    expect(handle.getAsk(interactionId)).toBeUndefined();
  });
});
