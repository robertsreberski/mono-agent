import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureStatus } from "./VoiceComposer";

afterEach(cleanup);

describe("capture row presentation", () => {
  it("keeps Recording as an assistive status, with Stop leading and Discard trailing", () => {
    const stop = vi.fn(); const discard = vi.fn();
    const view = render(<CaptureStatus phase="recording" seconds={61} levels={[0.5, 1]} onStop={stop} onCancel={discard} />);
    expect(screen.getByRole("status")).toHaveTextContent(/^Recording$/);
    expect(screen.getByRole("status")).toHaveClass("sr-only");
    expect(screen.getByRole("timer")).toHaveAttribute("aria-live", "off");
    expect(screen.getByRole("timer")).toHaveTextContent("1:01");
    const row = view.container.firstElementChild!;
    expect(row.firstElementChild).toBe(screen.getByRole("button", { name: "Stop recording" }));
    expect(row.lastElementChild).toContainElement(screen.getByRole("button", { name: "Cancel recording" }));
    expect(row.querySelector(".voice-recording-dot")?.nextElementSibling).toBe(screen.getByRole("timer"));
    const bars = row.querySelectorAll<HTMLElement>(".capture-meter i");
    expect(bars).toHaveLength(48);
    expect(bars[0]!.style.height).toBe("11.5px");
    expect(bars[1]!.style.height).toBe("11.5px");
    expect(bars[2]!.style.height).toBe("20px");
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel recording" }));
    expect(stop).toHaveBeenCalledOnce(); expect(discard).toHaveBeenCalledOnce();
  });

  it("uses the meter slot for permission, without Stop or a timer, keeping Discard", () => {
    const view = render(<CaptureStatus phase="permission" seconds={0} />);
    expect(screen.getByRole("status")).toHaveTextContent("Allow microphone access…");
    expect(screen.getByText("Allow microphone…").closest(".voice-note-body")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Stop recording" })).toBeNull();
    expect(screen.queryByRole("timer")).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel recording" })).toBeVisible();
    expect(view.container.querySelector(".voice-face-slot")?.textContent).toBe("");
  });

  it("shows the attaching spinner in the face slot and a neutral meter", () => {
    const view = render(<CaptureStatus phase="attaching" seconds={7} levels={Array(24).fill(1)} />);
    expect(screen.getByRole("status")).toHaveTextContent("Attaching recording…");
    expect(view.container.querySelector(".voice-face-slot .voice-action-face .voice-spinner")).not.toBeNull();
    expect([...view.container.querySelectorAll<HTMLElement>(".capture-meter i")].every(bar => bar.style.height === "3px")).toBe(true);
    expect(screen.queryByRole("button", { name: "Stop recording" })).toBeNull();
    expect(view.container.querySelector(".voice-recording-dot")).toBeNull();
  });
});
