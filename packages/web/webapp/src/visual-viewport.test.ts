import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installVisualViewport } from "./visual-viewport";

class Viewport extends EventTarget {
  height = 1133;
  offsetTop = 0;
  scale = 1;
}
class TouchMedia extends EventTarget {
  matches = true;
}

describe("keyboard visual viewport", () => {
  let viewport: Viewport;
  let touch: TouchMedia;
  let dispose: (() => void) | undefined;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  const root = document.documentElement;
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  };
  const active = () => root.classList.contains("keyboard-viewport");
  const resize = (height: number, offsetTop = 0, scale = 1) => {
    Object.assign(viewport, { height, offsetTop, scale });
    viewport.dispatchEvent(new Event("resize"));
    flush();
  };

  beforeEach(() => {
    viewport = new Viewport();
    touch = new TouchMedia();
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("matchMedia", vi.fn(() => touch));
    vi.spyOn(root, "clientHeight", "get").mockReturnValue(1133);
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => frames.delete(id)));
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("coalesces open/close events and uses the layout height even if innerHeight already shrank", () => {
    vi.stubGlobal("innerHeight", 786);
    dispose = installVisualViewport();
    flush();
    expect(active()).toBe(false);
    viewport.height = 786;
    viewport.offsetTop = 340;
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(1);
    flush();
    expect(active()).toBe(true);
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("786px");
    expect(root.style.getPropertyValue("--app-viewport-top")).toBe("340px");
    resize(1133);
    expect(active()).toBe(false);
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("");
    expect(root.style.getPropertyValue("--app-viewport-top")).toBe("");
  });

  it("requires more than 80px reduction, but tracks offset-only pans", () => {
    dispose = installVisualViewport();
    resize(1053);
    expect(active()).toBe(false);
    resize(1052);
    expect(active()).toBe(true);
    resize(1133, 1);
    expect(active()).toBe(true);
    viewport.offsetTop = 24;
    viewport.dispatchEvent(new Event("scroll"));
    flush();
    expect(root.style.getPropertyValue("--app-viewport-top")).toBe("24px");
    resize(1133);
    expect(active()).toBe(false);
  });

  it("leaves pinch zoom and fine-pointer desktops browser-owned", () => {
    dispose = installVisualViewport();
    resize(786, 340, 2);
    expect(active()).toBe(false);
    resize(1133, 0, 1.01);
    expect(active()).toBe(false);
    resize(786);
    expect(active()).toBe(true);
    resize(786, 340, 1.001);
    expect(active()).toBe(false);
    touch.matches = false;
    resize(786, 340);
    expect(active()).toBe(false);
    touch.matches = true;
    touch.dispatchEvent(new Event("change"));
    flush();
    expect(active()).toBe(true);
  });

  it("does not subtract keyboard height twice on a phone with a resized layout viewport", () => {
    vi.spyOn(root, "clientHeight", "get").mockReturnValue(500);
    dispose = installVisualViewport();
    resize(500);
    expect(active()).toBe(false);
    resize(500, 10);
    expect(active()).toBe(true);
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("500px");
    resize(844);
    expect(active()).toBe(false);
  });

  it("stays active on a panned tablet when layout and visual heights both shrink", () => {
    vi.spyOn(root, "clientHeight", "get").mockReturnValue(786);
    dispose = installVisualViewport();
    resize(786, 340);
    expect(active()).toBe(true);
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("786px");
    expect(root.style.getPropertyValue("--app-viewport-top")).toBe("340px");
  });

  it("cancels pending work, removes all listeners and clears styles on cleanup", () => {
    const removeViewport = vi.spyOn(viewport, "removeEventListener");
    const removeWindow = vi.spyOn(window, "removeEventListener");
    const removeTouch = vi.spyOn(touch, "removeEventListener");
    dispose = installVisualViewport();
    resize(786, 340);
    viewport.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(1);
    dispose();
    expect(frames.size).toBe(0);
    expect(active()).toBe(false);
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("");
    expect(root.style.getPropertyValue("--app-viewport-top")).toBe("");
    expect(removeViewport.mock.calls.map(([name]) => name)).toEqual(["resize", "scroll"]);
    expect(removeWindow.mock.calls.map(([name]) => name)).toEqual(["resize", "scroll"]);
    expect(removeTouch).toHaveBeenCalledWith("change", expect.any(Function));
    viewport.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("scroll"));
    touch.dispatchEvent(new Event("change"));
    expect(frames.size).toBe(0);
  });

  it("does nothing without the API", () => {
    vi.stubGlobal("visualViewport", undefined);
    dispose = installVisualViewport();
    expect(window.matchMedia).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(active()).toBe(false);
  });
});
