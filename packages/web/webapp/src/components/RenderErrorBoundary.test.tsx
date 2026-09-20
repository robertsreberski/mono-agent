import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  ConversationErrorFallback,
  reportRenderError,
  RenderErrorBoundary,
  RootErrorFallback,
} from "./RenderErrorBoundary";

function ControlledChild({ fail }: { readonly fail: boolean }) {
  if (fail) throw new Error("deliberate render failure");
  return <p>Recovered content</p>;
}

describe("RenderErrorBoundary", () => {
  it("reports one caught StrictMode error and recovers after an explicit reset", () => {
    let fail = true;
    const reporter = vi.fn();
    const tree = () => (
      <StrictMode>
        <RenderErrorBoundary
          scope="conversation"
          reporter={reporter}
          fallback={({ reset }) => (
            <button type="button" onClick={reset}>Reload conversation</button>
          )}
        >
          <ControlledChild fail={fail} />
        </RenderErrorBoundary>
      </StrictMode>
    );
    const view = render(tree());

    expect(screen.getByRole("button", { name: "Reload conversation" })).toBeVisible();
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "conversation",
        error: expect.objectContaining({ message: "deliberate render failure" }),
        componentStack: expect.any(String),
      }),
    );

    fail = false;
    view.rerender(tree());
    fireEvent.click(screen.getByRole("button", { name: "Reload conversation" }));
    expect(screen.getByText("Recovered content")).toBeVisible();
    expect(reporter).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("clears a caught error when the reset key changes", () => {
    let fail = true;
    const reporter = vi.fn();
    const tree = (resetKey: string) => (
      <StrictMode>
        <RenderErrorBoundary
          scope="conversation"
          resetKey={resetKey}
          reporter={reporter}
          fallback={() => <p>Conversation failed</p>}
        >
          <ControlledChild fail={fail} />
        </RenderErrorBoundary>
      </StrictMode>
    );
    const view = render(tree("alpha:first"));
    expect(screen.getByText("Conversation failed")).toBeVisible();
    expect(reporter).toHaveBeenCalledTimes(1);

    fail = false;
    view.rerender(tree("alpha:second"));
    expect(screen.getByText("Recovered content")).toBeVisible();
    expect(reporter).toHaveBeenCalledTimes(1);
  });

  it("does not clear an error first caught during a reset-key transition", () => {
    const reporter = vi.fn();
    const tree = (resetKey: string, fail: boolean) => (
      <StrictMode>
        <RenderErrorBoundary
          scope="conversation"
          resetKey={resetKey}
          reporter={reporter}
          fallback={() => <p>Conversation failed</p>}
        >
          <ControlledChild fail={fail} />
        </RenderErrorBoundary>
      </StrictMode>
    );
    const view = render(tree("alpha:first", false));

    view.rerender(tree("beta:first", true));

    expect(screen.getByText("Conversation failed")).toBeVisible();
    expect(reporter).toHaveBeenCalledTimes(1);

    view.rerender(tree("alpha:second", false));
    expect(screen.getByText("Recovered content")).toBeVisible();
    expect(reporter).toHaveBeenCalledTimes(1);
  });

  it("keeps a persistent error contained when reset retries it", () => {
    const reporter = vi.fn();
    render(
      <RenderErrorBoundary
        scope="conversation"
        reporter={reporter}
        fallback={({ reset }) => (
          <button type="button" onClick={reset}>Retry persistent failure</button>
        )}
      >
        <ControlledChild fail />
      </RenderErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry persistent failure" }));
    expect(screen.getByRole("button", { name: "Retry persistent failure" })).toBeVisible();
    expect(reporter).toHaveBeenCalledTimes(2);
  });
});

describe("RootErrorFallback", () => {
  it("renders the real root recovery surface and invokes its injected reload", () => {
    const reload = vi.fn();
    render(<RootErrorFallback reload={reload} />);

    expect(screen.getByRole("alert")).toHaveTextContent("The mono-agent console could not be displayed.");
    fireEvent.click(screen.getByRole("button", { name: "Reload console" }));
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe("ConversationErrorFallback", () => {
  it("discloses the actual exception and copies the local report, retaining recovery and alert semantics", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const reporter = vi.fn();
    render(<RenderErrorBoundary scope="conversation" reporter={reporter} fallback={(props) => <ConversationErrorFallback {...props} />}>
      <ControlledChild fail />
    </RenderErrorBoundary>);
    expect(screen.getByRole("alert")).toHaveTextContent("Conversation unavailable");
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Reload conversation" })).toBeVisible();
    const disclosure = screen.getByText("Technical details");
    expect(disclosure.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(disclosure);
    expect(screen.getByText("Error: deliberate render failure")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Copy technical details" }));
    await screen.findByText("Copied technical details");
    expect(JSON.parse(writeText.mock.calls[0]![0])).toEqual(reporter.mock.calls[0]![0]);
    writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Copy technical details" }));
    await screen.findByText("Could not copy. Select the details to copy them manually.");
  });

  it("reports only the serialized snapshot to the browser console", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(<RenderErrorBoundary scope="conversation" fallback={(props) => <ConversationErrorFallback {...props} />}>
        <ControlledChild fail />
      </RenderErrorBoundary>);
      await waitFor(() => expect(log.mock.calls.some(([label]) => label === "[mono-agent] conversation render failed")).toBe(true));
      const call = log.mock.calls.find(([label]) => label === "[mono-agent] conversation render failed")!;
      expect(call).toHaveLength(2);
      expect(call[1]).not.toBeInstanceOf(Error);
      expect(call[1]).toMatchObject({ error: { name: "Error", message: "deliberate render failure" } });
      expect(reportRenderError).toBeTypeOf("function");
    } finally { log.mockRestore(); }
  });
});
