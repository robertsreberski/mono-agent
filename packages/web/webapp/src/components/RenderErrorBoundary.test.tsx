import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
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
      "conversation",
      expect.objectContaining({ message: "deliberate render failure" }),
      expect.objectContaining({ componentStack: expect.any(String) }),
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
