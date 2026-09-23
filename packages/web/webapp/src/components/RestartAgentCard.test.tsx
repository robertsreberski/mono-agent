import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../api";
import type { RestartOperation, RestartProposalPart } from "../types";
import { RestartAgentCard } from "./RestartAgentCard";

const startAt = "2026-09-23T10:00:00.000Z";
const deadline = "2026-09-23T10:02:00.000Z";
const operation = (stage: RestartOperation["stage"], outcome?: RestartOperation["outcome"], reason?: string): RestartOperation => ({
  id: "web-op", sourceId: "agent-one", stage, requestedAt: startAt, deadline,
  ...(outcome === undefined ? {} : { outcome }), ...(reason === undefined ? {} : { reason }),
});
const proposal = (state: NonNullable<RestartProposalPart["restartable"]>["state"], operationId?: string) => ({
  threadId: "thread-one", messageId: "message-one", partId: "part-one",
  restartable: { state, ...(operationId === undefined ? {} : { operationId }),
    ...(state === "available" || state === "used" ? {} : { reason: `${state} reason` }) },
});
const base = { sourceId: "agent-one", agentLabel: "Agent One" } as const;

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("RestartAgentCard", () => {
  it("shows one simple action, an inline advisory warning, and cancel without posting", () => {
    const post = vi.spyOn(api, "restartFromProposal");
    render(<RestartAgentCard {...base} reason="A short reason" proposal={proposal("available")} approximateRunningCount={3} />);
    expect(screen.getByText("A short reason")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Restart Agent One" }));
    expect(screen.getByText("About 3 running conversations will be interrupted (approximate).")).toBeVisible();
    expect(screen.getByText(/may interrupt active conversations/u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(post).not.toHaveBeenCalled();
  });

  it("confirms once, shows server-owned progress, polls to success and stops on terminal", async () => {
    vi.useFakeTimers();
    const post = vi.spyOn(api, "restartFromProposal").mockResolvedValue(operation("requesting"));
    const status = vi.spyOn(api, "restartStatus").mockResolvedValueOnce(operation("restarting"))
      .mockResolvedValue(operation("back_online", "success"));
    render(<RestartAgentCard {...base} proposal={proposal("available")} />);
    fireEvent.click(screen.getByRole("button", { name: "Restart Agent One" }));
    const confirm = screen.getByRole("button", { name: "Confirm restart" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await act(async () => { await Promise.resolve(); });
    expect(post).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("list", { name: "Restart progress" })).toBeVisible();
    await act(async () => { await Promise.resolve(); });
    expect(status).toHaveBeenCalledWith("agent-one", "web-op", expect.any(AbortSignal));
    expect(screen.getByText("Restarting").getAttribute("aria-current")).toBe("step");
    await act(async () => { vi.advanceTimersByTime(2_000); await Promise.resolve(); });
    expect(screen.getByText("Restarted — agent is back online.")).toBeVisible();
    const count = status.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(4_000); await Promise.resolve(); });
    expect(status).toHaveBeenCalledTimes(count);
  });

  it.each([
    ["failure" as const, "Restart failed: Supervisor refused."],
    ["not_confirmed" as const, "Restart not confirmed — check the agent. No ready process appeared."],
  ])("renders %s only from the operation DTO", (outcome, text) => {
    render(<RestartAgentCard {...base} initialOperation={operation("back_online", outcome,
      outcome === "failure" ? "Supervisor refused." : "No ready process appeared.")} />);
    expect(screen.getByText(text)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Confirm restart/u })).toBeNull();
  });

  it.each(["stale", "offline", "unsupported", "in_progress"] as const)("disables %s cards with the server reason", (state) => {
    render(<RestartAgentCard {...base} proposal={proposal(state)} />);
    expect(screen.getByRole("button", { name: "Restart Agent One" })).toBeDisabled();
    expect(screen.getByText(`${state} reason`)).toBeVisible();
  });

  it("fails closed on a malformed used card without a pollable web id", () => {
    render(<RestartAgentCard {...base} proposal={proposal("used")} />);
    expect(screen.getByRole("button", { name: "Restart Agent One" })).toBeDisabled();
    expect(screen.getByText("Restart status is unavailable.")).toBeVisible();
  });

  it("rehydrates a used card from the linked WEB id and polls after remount", async () => {
    vi.useFakeTimers();
    const status = vi.spyOn(api, "restartStatus").mockResolvedValueOnce(operation("restarting"))
      .mockResolvedValue(operation("back_online", "success"));
    const { unmount } = render(<RestartAgentCard {...base} proposal={proposal("used", "web-op")} />);
    await act(async () => { await Promise.resolve(); });
    expect(status).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => { vi.advanceTimersByTime(4_000); await Promise.resolve(); });
    expect(status).toHaveBeenCalledTimes(1);
    render(<RestartAgentCard {...base} proposal={proposal("used", "web-op")} />);
    await act(async () => { await Promise.resolve(); });
    expect(status).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Restarted — agent is back online.")).toBeVisible();
  });

  it("shows a definitive refusal as failure but an ambiguous request as not confirmed", async () => {
    const post = vi.spyOn(api, "requestAgentRestart").mockRejectedValueOnce(new ApiError("Restart=no", 409, "restart_unsupported"))
      .mockRejectedValueOnce(new TypeError("Lost connection"));
    const first = render(<RestartAgentCard {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "Restart Agent One" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm restart" }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("Restart failed: Restart=no")).toBeVisible();
    first.unmount();
    render(<RestartAgentCard {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "Restart Agent One" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm restart" }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("Restart not confirmed — check the agent. Lost connection")).toBeVisible();
    expect(post).toHaveBeenCalledTimes(2);
  });
});
