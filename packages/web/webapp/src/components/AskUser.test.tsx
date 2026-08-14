import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import type { AskSnapshot } from "../types";
import { ToolFallback } from "./Messages";

vi.mock("../console-store", () => ({
  useConsoleStore: () => ({ selectedThread: { id: "thread-1" } }),
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
  expiresAt: "2026-07-21T09:10:00.000Z",
};

const toolArgs = JSON.parse(JSON.stringify({
  message: snapshot.message,
  questions: snapshot.questions,
})) as ToolCallMessagePartProps["args"];

function askUserTool() {
  return <ToolFallback
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
  />;
}

async function renderAnsweredSnapshot(answered: AskSnapshot) {
  vi.spyOn(api, "pendingAsk").mockResolvedValue(answered);
  const rendered = render(askUserTool());
  await screen.findByText("Answers submitted.");
  return rendered;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AskUser web form", () => {
  it("renders all questions together and submits option plus custom answers atomically", async () => {
    const answered: AskSnapshot = {
      ...snapshot,
      answers: [
        { questionId: "q0", selectedOptionIds: ["q0o0"] },
        { questionId: "q1", selectedOptionIds: ["q1o1"], customReply: "Also mention risk" },
      ],
      status: "answered",
    };
    vi.spyOn(api, "pendingAsk").mockResolvedValueOnce(snapshot).mockResolvedValue(answered);
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
});
