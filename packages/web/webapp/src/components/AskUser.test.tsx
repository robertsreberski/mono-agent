import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import type { AskSnapshot } from "../types";
import { AskReconciliationProvider, ToolFallback } from "./Messages";

vi.mock("../console-store", () => ({
  useConsoleStore: () => ({
    selectedThread: { id: "thread-1" },
    selectedAgent: { status: "online" },
    connection: "live",
  }),
}));

const snapshot: AskSnapshot = {
  interactionId: "ask-test",
  message: "Morning briefing and reply draft",
  questions: [
    {
      id: "q0",
      header: "Delivery",
      question: "What should I do with the draft?",
      options: [
        { id: "q0o0", label: "Send", description: "Send it now." },
        { id: "q0o1", label: "Skip", description: "Leave it unsent." },
        { id: "q0o2", label: "Revise", description: "Keep editing it." },
      ],
      multiSelect: false,
    },
    {
      id: "q1",
      header: "Follow-up",
      question: "Which follow-ups should be included?",
      options: [
        { id: "q1o0", label: "Owner", description: "Name the owner." },
        { id: "q1o1", label: "Deadline", description: "Include the deadline." },
      ],
      multiSelect: true,
    },
  ],
  answers: [],
  activeQuestionIndex: 0,
  status: "pending",
  createdAt: "2026-07-21T09:00:00.000Z",
  expiresAt: "2099-07-21T09:10:00.000Z",
};

const toolArgs = JSON.parse(JSON.stringify({
  message: snapshot.message,
  questions: snapshot.questions,
})) as ToolCallMessagePartProps["args"];

function askUserTool() {
  return (
    <AskReconciliationProvider>
      <ToolFallback
        type="tool-call"
        toolName="AskUser"
        toolCallId="tool-1"
        args={toolArgs}
        argsText={JSON.stringify(toolArgs)}
        result={undefined}
        isError={false}
        status={{ type: "running" }}
        addResult={vi.fn()}
        resume={vi.fn()}
        respondToApproval={vi.fn()}
      />
    </AskReconciliationProvider>
  );
}

async function renderAnsweredSnapshot(answered: AskSnapshot) {
  vi.spyOn(api, "pendingAsk").mockResolvedValue(answered);
  const rendered = render(askUserTool());
  await screen.findByText("Answers submitted.");
  return rendered;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AskUser web form", () => {
  it("does not locally expire a pending snapshot whose expiry is explicitly null", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2200-01-01T00:00:00.000Z"));
    const noExpiry = { ...snapshot, expiresAt: null };
    vi.spyOn(api, "pendingAsk").mockResolvedValue(noExpiry);
    vi.spyOn(api, "ask").mockResolvedValue(noExpiry);
    render(askUserTool());
    expect(await screen.findByRole("button", { name: "Submit answers" })).toBeVisible();
    expect(screen.queryByText("This question expired.")).not.toBeInTheDocument();
  });

  it("renders all questions together and submits option plus custom answers atomically", async () => {
    const answered: AskSnapshot = {
      ...snapshot,
      answers: [
        { questionId: "q0", selectedOptionIds: ["q0o0"] },
        { questionId: "q1", selectedOptionIds: ["q1o1"], customReply: "Also mention risk" },
      ],
      status: "answered",
    };
    vi.spyOn(api, "pendingAsk").mockResolvedValue(snapshot);
    vi.spyOn(api, "ask").mockResolvedValue(snapshot);
    const submitAsk = vi.spyOn(api, "submitAsk").mockResolvedValue({
      accepted: true,
      snapshot: answered,
    });

    render(askUserTool());

    expect(await screen.findByText("What should I do with the draft?")).toBeVisible();
    expect(screen.getByText("Which follow-ups should be included?")).toBeVisible();
    expect(screen.getByText("Morning briefing and reply draft")).toBeVisible();

    fireEvent.click(screen.getByRole("radio", { name: /Send/u }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Deadline/u }));
    fireEvent.change(screen.getAllByRole("textbox")[1]!, { target: { value: "Also mention risk" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));

    await waitFor(() => expect(submitAsk).toHaveBeenCalledWith("thread-1", "ask-test", [
      { questionId: "q0", selectedOptionIds: ["q0o0"] },
      { questionId: "q1", selectedOptionIds: ["q1o1"], customReply: "Also mention risk" },
    ]));
    // Re-query inside waitFor rather than asserting on the handle findByText returns. The
    // completion notice re-renders right after it first appears, so under load the captured node
    // was already detached by the time the assertion ran — "element is not in the document" for an
    // element that is on screen.
    await waitFor(() => expect(screen.getByText("Answers submitted.")).toBeVisible());
    expect(screen.getByText("Delivery: Send")).toBeVisible();
    expect(screen.getByText("Follow-up: Deadline")).toBeVisible();
    expect(screen.queryByText("Also mention risk")).not.toBeInTheDocument();
  });

  it("keeps a submitted answer terminal when an older exact poll resolves pending", async () => {
    const answered: AskSnapshot = {
      ...snapshot,
      answers: [
        { questionId: "q0", selectedOptionIds: ["q0o0"] },
        { questionId: "q1", selectedOptionIds: ["q1o1"] },
      ],
      status: "answered",
    };
    let releaseStalePoll!: (value: AskSnapshot | undefined) => void;
    const stalePoll = new Promise<AskSnapshot | undefined>((resolve) => {
      releaseStalePoll = resolve;
    });
    vi.spyOn(api, "pendingAsk").mockResolvedValue(snapshot);
    vi.spyOn(api, "ask").mockReturnValue(stalePoll);
    vi.spyOn(api, "submitAsk").mockResolvedValue({ accepted: true, snapshot: answered });

    const { container } = render(askUserTool());
    expect(await screen.findByText("What should I do with the draft?")).toBeVisible();
    await waitFor(() => expect(api.ask).toHaveBeenCalledWith(
      "thread-1",
      snapshot.interactionId,
      expect.any(AbortSignal),
    ));

    fireEvent.click(screen.getByRole("radio", { name: /Send/u }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Deadline/u }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answers" }));
    await screen.findByText("Answers submitted.");

    await act(async () => {
      releaseStalePoll(snapshot);
      await stalePoll;
    });

    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Answers submitted.");
    expect(screen.getByText("Delivery: Send")).toBeVisible();
    expect(screen.getByText("Follow-up: Deadline")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Submit answers" })).not.toBeInTheDocument();
  });

  it("renders one resolved answer compactly for a two-question AskUser", async () => {
    const answered: AskSnapshot = {
      ...snapshot,
      answers: [{
        questionId: "q0",
        selectedOptionIds: ["q0o0", "stale-option", "q0o2"],
      }],
      status: "answered",
    };

    const { container } = await renderAnsweredSnapshot(answered);

    expect(screen.getByRole("status")).toHaveTextContent("Answers submitted.");
    expect(container.querySelector(".ask-user-summary-line")?.textContent).toBe("Send, Revise");
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders one custom-only answer with its operator-private text", async () => {
    const answered: AskSnapshot = {
      ...snapshot,
      answers: [{
        questionId: "q1",
        selectedOptionIds: ["stale-option"],
        customReply: "Name the owner before sending",
      }],
      status: "answered",
    };

    const { container } = await renderAnsweredSnapshot(answered);

    expect(container.querySelector(".ask-user-summary-line")?.textContent).toBe(
      "Answer: Name the owner before sending",
    );
  });

  it("attributes multiple answers in answer order and keeps custom text operator-private", async () => {
    const answered: AskSnapshot = {
      ...snapshot,
      answers: [
        {
          questionId: "q1",
          selectedOptionIds: ["q1o1", "stale-option", "q1o0"],
          customReply: "labels take precedence",
        },
        {
          questionId: "stale-question",
          selectedOptionIds: ["q0o0"],
          customReply: "omit unknown question",
        },
        {
          questionId: "q0",
          selectedOptionIds: ["stale-option"],
          customReply: "Rewrite the opening",
        },
      ],
      status: "answered",
    };

    const { container } = await renderAnsweredSnapshot(answered);
    const lines = [...container.querySelectorAll(".ask-user-summary-line")]
      .map((element) => element.textContent);

    expect(lines).toEqual([
      "Follow-up: Deadline, Owner",
      "Delivery: Rewrite the opening",
    ]);
    expect(screen.queryByText("labels take precedence")).not.toBeInTheDocument();
    expect(screen.queryByText("omit unknown question")).not.toBeInTheDocument();
  });

  it.each([
    {
      name: "an unknown question with custom text",
      answers: [{
        questionId: "stale-question",
        selectedOptionIds: ["q0o0"],
        customReply: "do not attribute this",
      }],
    },
    {
      name: "known-question unknown options without custom text",
      answers: [{ questionId: "q0", selectedOptionIds: ["stale-option"] }],
    },
    {
      name: "multiple entries with no resolvable output",
      answers: [
        {
          questionId: "stale-question",
          selectedOptionIds: ["q0o0"],
          customReply: "do not attribute this",
        },
        { questionId: "q0", selectedOptionIds: ["stale-option"] },
      ],
    },
  ] satisfies ReadonlyArray<{
    readonly name: string;
    readonly answers: AskSnapshot["answers"];
  }>)("keeps bare completion text for $name", async ({ answers }) => {
    const { container } = await renderAnsweredSnapshot({
      ...snapshot,
      answers,
      status: "answered",
    });

    expect(screen.getByRole("status")).toHaveTextContent(/^Answers submitted\.$/u);
    expect(container.querySelector(".ask-user-summary-line")).toBeNull();
  });

  it("keeps answered AskUser rerender idempotence without duplicating the completion summary", async () => {
    const answered: AskSnapshot = {
      ...snapshot,
      answers: [{ questionId: "q0", selectedOptionIds: ["q0o0"] }],
      status: "answered",
    };
    vi.spyOn(api, "pendingAsk").mockResolvedValue(answered);
    const { container, rerender } = render(askUserTool());
    await screen.findByText("Answers submitted.");

    rerender(askUserTool());

    expect(container.querySelectorAll(".ask-user-card")).toHaveLength(1);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelectorAll(".ask-user-summary-line")).toHaveLength(1);
    expect(container.querySelector(".ask-user-summary-line")?.textContent).toBe("Send");
  });

  it("re-reads a completed card by its exact interaction id and converges after another destination answers", async () => {
    vi.spyOn(api, "pendingAsk");
    vi.spyOn(api, "ask")
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValue({ ...snapshot, status: "answered" });

    render(
      <AskReconciliationProvider>
        <ToolFallback
          type="tool-call"
          toolName="AskUser"
          toolCallId="tool-old"
          args={{}}
          argsText="{}"
          result={{ structuredContent: { interactionId: snapshot.interactionId } }}
          isError={false}
          status={{ type: "complete" }}
          addResult={vi.fn()}
          resume={vi.fn()}
          respondToApproval={vi.fn()}
        />
      </AskReconciliationProvider>,
    );

    expect(await screen.findByText("Answers submitted.", {}, { timeout: 3_000 })).toBeVisible();
    expect(api.ask).toHaveBeenCalledTimes(2);
    expect(api.pendingAsk).not.toHaveBeenCalled();
  });

  // Production shape check. AskUser's tool result reaching the console is the model-facing
  // SENTENCE ("The user answered:\n- ..."), never an object — the machine-readable
  // {interactionId, answered} lives in the MCP structuredContent, which now rides beside
  // it in the tool-call artifact envelope. Before that payload was carried, an answered
  // card had no interactionId and no durable status, so the coordinator marked it
  // unresolved-and-not-running and it rendered "Question unavailable" the instant the
  // answer landed. Note the other tests in this file pass `result` as an object, which is
  // why they never caught this.
  it("renders an answered card from structuredResult when the tool result is a plain string", async () => {
    vi.spyOn(api, "ask");
    vi.spyOn(api, "pendingAsk");

    render(
      <AskReconciliationProvider>
        <ToolFallback
          type="tool-call"
          toolName="AskUser"
          toolCallId="tool-answered"
          args={{ message: "Morning briefing and reply draft" }}
          argsText="{}"
          result={"The user answered:\n- Delivery: Send"}
          artifact={{
            structuredResult: {
              ok: true,
              answered: true,
              interactionId: "ask-answered",
              answers: [{ questionId: "q0", selectedOptionIds: ["q0o0"] }],
            },
          }}
          isError={false}
          status={{ type: "complete" }}
          addResult={vi.fn()}
          resume={vi.fn()}
          respondToApproval={vi.fn()}
        />
      </AskReconciliationProvider>,
    );

    expect(await screen.findByText(/Answers submitted/u)).toBeVisible();
    expect(screen.queryByText(/Question unavailable/u)).not.toBeInTheDocument();
    // The durable status is authoritative, so the card never has to ask the agent.
    expect(api.pendingAsk).not.toHaveBeenCalled();
  });

  it("reports an expired ask from structuredResult rather than calling it unavailable", async () => {
    vi.spyOn(api, "ask");

    render(
      <AskReconciliationProvider>
        <ToolFallback
          type="tool-call"
          toolName="AskUser"
          toolCallId="tool-expired"
          args={{}}
          argsText="{}"
          result={"The user did not answer within the wait window."}
          artifact={{
            structuredResult: {
              ok: true,
              answered: false,
              reason: "timeout",
              interactionId: "ask-expired",
            },
          }}
          isError={false}
          status={{ type: "complete" }}
          addResult={vi.fn()}
          resume={vi.fn()}
          respondToApproval={vi.fn()}
        />
      </AskReconciliationProvider>,
    );

    expect(await screen.findByText(/Question expired/u)).toBeVisible();
    expect(screen.queryByText(/Question unavailable/u)).not.toBeInTheDocument();
  });

  it("never lets an old card adopt a different interaction and becomes non-actionable after eviction", async () => {
    vi.spyOn(api, "pendingAsk");
    vi.spyOn(api, "ask").mockResolvedValue({ ...snapshot, interactionId: "ask-newer" });

    render(
      <AskReconciliationProvider>
        <ToolFallback
          type="tool-call"
          toolName="AskUser"
          toolCallId="tool-old"
          args={{}}
          argsText="{}"
          result={{ structuredContent: { interactionId: "ask-old" } }}
          isError={false}
          status={{ type: "complete" }}
          addResult={vi.fn()}
          resume={vi.fn()}
          respondToApproval={vi.fn()}
        />
      </AskReconciliationProvider>,
    );

    expect(await screen.findByText(/Question unavailable/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Submit/u })).not.toBeInTheDocument();
    expect(api.pendingAsk).not.toHaveBeenCalled();
  });

  it("derives expiry from expiresAt and does not render an actionable form", async () => {
    vi.spyOn(api, "ask").mockResolvedValue({
      ...snapshot,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    render(
      <AskReconciliationProvider>
        <ToolFallback
          type="tool-call"
          toolName="AskUser"
          toolCallId="tool-expired"
          args={{}}
          argsText="{}"
          result={{ interactionId: snapshot.interactionId }}
          isError={false}
          status={{ type: "complete" }}
          addResult={vi.fn()}
          resume={vi.fn()}
          respondToApproval={vi.fn()}
        />
      </AskReconciliationProvider>,
    );

    expect(await screen.findByText("Question expired.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Submit/u })).not.toBeInTheDocument();
  });

  it("keeps the canonical terminal tool outcome visible after agent history eviction", async () => {
    vi.spyOn(api, "ask").mockResolvedValue(undefined);

    render(
      <AskReconciliationProvider>
        <ToolFallback
          type="tool-call"
          toolName="AskUser"
          toolCallId="tool-restarted"
          args={{}}
          argsText="{}"
          result={{
            structuredContent: {
              interactionId: snapshot.interactionId,
              answered: true,
              answers: [{ questionId: "q0", selectedOptionIds: ["q0o0"] }],
            },
          }}
          isError={false}
          status={{ type: "complete" }}
          addResult={vi.fn()}
          resume={vi.fn()}
          respondToApproval={vi.fn()}
        />
      </AskReconciliationProvider>,
    );

    expect(await screen.findByRole("status")).toHaveTextContent("Answers submitted.");
    await waitFor(() => expect(api.ask).toHaveBeenCalledWith("thread-1", "ask-test", expect.any(AbortSignal)));
    expect(screen.queryByRole("button", { name: /Submit/u })).not.toBeInTheDocument();
  });

  it("removes every abort listener after normal poll delays and provider teardown", async () => {
    vi.useFakeTimers();
    vi.spyOn(api, "ask").mockResolvedValue(snapshot);
    const addEventListener = vi.spyOn(AbortSignal.prototype, "addEventListener");
    const removeEventListener = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    const rendered = render(
      <AskReconciliationProvider>
        <ToolFallback
          type="tool-call"
          toolName="AskUser"
          toolCallId="tool-listener-cleanup"
          args={{}}
          argsText="{}"
          result={{ structuredContent: { interactionId: snapshot.interactionId } }}
          isError={false}
          status={{ type: "complete" }}
          addResult={vi.fn()}
          resume={vi.fn()}
          respondToApproval={vi.fn()}
        />
      </AskReconciliationProvider>,
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const pollListeners = () => addEventListener.mock.calls
      .filter(([type, , options]) => type === "abort"
        && typeof options === "object"
        && options !== null
        && "once" in options
        && options.once === true)
      .map(([, listener]) => listener);
    const removedListeners = () => removeEventListener.mock.calls
      .filter(([type]) => type === "abort")
      .map(([, listener]) => listener);
    const outstandingListeners = () => pollListeners()
      .filter((listener) => !removedListeners().includes(listener));
    const beforeTimer = outstandingListeners();
    const callsBeforeTimer = vi.mocked(api.ask).mock.calls.length;
    expect(beforeTimer).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(api.ask).toHaveBeenCalledTimes(callsBeforeTimer + 1);
    expect(removedListeners()).toContain(beforeTimer[0]);
    expect(outstandingListeners()).toHaveLength(1);

    rendered.unmount();
    expect(outstandingListeners()).toEqual([]);
  });
});
